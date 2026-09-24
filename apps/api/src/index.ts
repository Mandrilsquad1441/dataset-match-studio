import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { evaluateLabeledModelPairs, passesModelVersionApprovalGate } from "../../../src/lib/model-evaluation";
import { datasetFieldMap, datasetMatchSchema, datasetReferenceRecords, DatasetRequestError, readDatasetMatchBody } from "./dataset-matches";
import { handleMatchingRequest } from "./matching-models";

type AuthContext = { db: SupabaseClient; user: User; tenantId: string; role: string };
type ApiVariables = { auth: AuthContext };

const app = new Hono<{ Bindings: Env; Variables: ApiVariables }>();

app.use("*", async (context, next) => {
  const origin = context.req.header("Origin");
  if (origin && origin !== context.env.APP_ORIGIN) {
    return context.json({ error: "Origin is not allowed." }, 403);
  }
  return next();
});

app.use("/api/*", (context, next) => cors({
  origin: context.env.APP_ORIGIN,
  allowHeaders: ["Authorization", "Content-Type", "X-Requested-With"],
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  maxAge: 86400,
})(context, next));

app.use("/api/*", async (context, next) => {
  if (context.req.path === "/api/health") return next();
  if (context.env.ALLOW_HOSTED_SERVICES !== "true") {
    return context.json({ error: "Hosted services are disabled. Set ALLOW_HOSTED_SERVICES=true after configuring your own services." }, 503);
  }
  return next();
});

app.use("/internal/*", async (context, next) => {
  if (context.env.ALLOW_HOSTED_SERVICES !== "true") return context.json({ error: "Hosted services are disabled." }, 503);
  return next();
});

app.onError((error, context) => {
  console.error(JSON.stringify({ level: "error", message: error.message, path: context.req.path }));
  return context.json({ error: "The request could not be completed.", detail: error.message }, 500);
});

app.get("/api/health", (context) => context.json({
  service: "match-studio-api",
  status: "ok",
  hostedServicesEnabled: context.env.ALLOW_HOSTED_SERVICES === "true",
}));

app.use("/api/*", async (context, next) => {
  if (context.req.path === "/api/health") return next();
  const token = context.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return context.json({ error: "Sign in to access this workspace." }, 401);
  const db = createClient(context.env.SUPABASE_URL, context.env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: "Bearer " + token } },
  });
  const { data: userData, error: userError } = await db.auth.getUser(token);
  if (userError || !userData.user) return context.json({ error: "Session is invalid or expired." }, 401);
  const { data: membership, error: membershipError } = await db
    .from("tenant_memberships")
    .select("tenant_id,role")
    .eq("user_id", userData.user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (membershipError || !membership) return context.json({ error: "No workspace is available for this account." }, 403);
  context.set("auth", { db, user: userData.user, tenantId: membership.tenant_id, role: membership.role });
  return next();
});

app.get("/api/matching/models", (context) => handleMatchingRequest(context.req.raw, context.env, { tenantId: context.get("auth").tenantId }));
app.post("/api/matching/evaluate", (context) => handleMatchingRequest(context.req.raw, context.env, { tenantId: context.get("auth").tenantId }));

app.get("/api/vendors", async (context) => {
  const { db, tenantId } = context.get("auth");
  const { data, error } = await db.from("vendors").select("id,name,active,created_at").eq("tenant_id", tenantId).order("name");
  if (error) return context.json({ error: error.message }, 400);
  return context.json({ vendors: data ?? [] });
});

app.post("/api/dataset-matches", async (context) => {
  const auth = context.get("auth");
  let body: unknown;
  try { body = await readDatasetMatchBody(context.req.raw); }
  catch (error) {
    if (error instanceof DatasetRequestError) return context.json({ error: error.message }, error.status);
    throw error;
  }
  const parsed = datasetMatchSchema.safeParse(body);
  if (!parsed.success) return context.json({ error: parsed.error.issues[0]?.message ?? "Provide two valid datasets." }, 400);
  if (!context.env.TRIGGER_SECRET_KEY) return context.json({ error: "Matching is not connected yet. The workspace administrator needs to finish the processing service setup." }, 503);
  const { dataset1, dataset2 } = parsed.data;
  const importId = crypto.randomUUID();
  const prefix = auth.tenantId + "/" + importId + "/";
  const referenceKey = prefix + "dataset-1.json";
  const sourceKey = prefix + "dataset-2.json";
  const sourceJson = JSON.stringify(dataset2.rows);
  const sourceBytes = new TextEncoder().encode(sourceJson).byteLength;
  let created = false;
  let referenceDatasetId: string | null = null;
  let createdAt = new Date().toISOString();
  try {
    await context.env.MATCH_FILES.put(referenceKey, JSON.stringify(dataset1.rows), {
      httpMetadata: { contentType: "application/json" }, customMetadata: { tenantId: auth.tenantId, importId, dataset: "1" },
    });
    await context.env.MATCH_FILES.put(sourceKey, sourceJson, {
      httpMetadata: { contentType: "application/json" }, customMetadata: { tenantId: auth.tenantId, importId, dataset: "2" },
    });
    const metadata = (source: typeof dataset1) => ({ name: source.name, name_field: source.nameField, id_field: source.idField ?? null, row_count: source.rows.length });
    const { data: createdMetadata, error } = await auth.db.rpc("create_dataset_match", {
      p_tenant_id: auth.tenantId,
      p_import_id: importId,
      p_dataset1: metadata(dataset1),
      p_dataset2: metadata(dataset2),
      p_records: datasetReferenceRecords(dataset1),
      p_field_map: datasetFieldMap(dataset2),
      p_source_bytes: sourceBytes,
    });
    if (error) return context.json({ error: "The datasets could not be saved. " + error.message }, 400);
    created = true;
    referenceDatasetId = typeof createdMetadata?.referenceDatasetId === "string" ? createdMetadata.referenceDatasetId : null;
    if (typeof createdMetadata?.createdAt === "string") createdAt = createdMetadata.createdAt;
  } finally {
    if (!created) await context.env.MATCH_FILES.delete([referenceKey, sourceKey]);
  }
  let triggerRunId: string | null = null;
  try {
    const response = await fetch((context.env.TRIGGER_API_URL ?? "https://api.trigger.dev") + "/api/v1/tasks/" + (context.env.TRIGGER_TASK_ID ?? "process-vendor-import") + "/trigger", {
      method: "POST",
      headers: { Authorization: "Bearer " + context.env.TRIGGER_SECRET_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ payload: { importId, tenantId: auth.tenantId }, options: { idempotencyKey: "vendor-import-" + importId } }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error("Processing service did not accept the comparison.");
    const result = await response.json() as { id?: string };
    triggerRunId = result.id ?? null;
    await auth.db.from("vendor_imports").update({ trigger_run_id: triggerRunId }).eq("tenant_id", auth.tenantId).eq("id", importId);
  } catch {
    await auth.db.from("vendor_imports").update({ status: "failed", error_message: "Processing service did not accept the comparison." }).eq("tenant_id", auth.tenantId).eq("id", importId);
    await auth.db.from("run_events").insert({ tenant_id: auth.tenantId, import_id: importId, event_type: "import_failed", message: "The datasets were saved, but matching could not start. Please try again." });
    return context.json({ importId, status: "failed", error: "The datasets were saved, but matching could not start. Please try again." }, 502);
  }
  const { data: summaryRow, error: summaryError } = await auth.db.from("vendor_imports").select(importSummarySelect)
    .eq("tenant_id", auth.tenantId).eq("id", importId).single();
  const summary = summaryError || !summaryRow ? mapImport({
    id: importId, file_name: dataset2.name, reference_dataset_id: referenceDatasetId,
    dataset1: { name: dataset1.name, row_count: dataset1.rows.length },
    dataset2: { name: dataset2.name, row_count: dataset2.rows.length },
    record_type: "site", status: "queued", row_count: dataset2.rows.length, created_at: createdAt,
  }) : mapImport(summaryRow as unknown as Record<string, unknown>);
  return context.json({ importId, triggerRunId, status: summary.status, summary }, 202);
});

const mappingSchema = z.object({
  vendorName: z.string().trim().min(1).max(160),
  recordType: z.enum(["site", "project"]),
  fieldMap: z.record(z.string(), z.string()).refine((fields) => Boolean(fields.display_name), "Map a source column to Record name."),
  locationMeaningful: z.boolean().default(false),
  profile: z.record(z.string(), z.unknown()).optional(),
});

app.post("/api/schema-mappings", async (context) => {
  const auth = context.get("auth");
  const parsed = mappingSchema.safeParse(await context.req.json());
  if (!parsed.success) return context.json({ error: parsed.error.issues[0]?.message ?? "Invalid mapping." }, 400);
  const { data: vendor, error: vendorError } = await auth.db
    .from("vendors")
    .upsert({ tenant_id: auth.tenantId, name: parsed.data.vendorName }, { onConflict: "tenant_id,name" })
    .select("id,name")
    .single();
  if (vendorError || !vendor) return context.json({ error: vendorError?.message ?? "Could not save vendor." }, 400);
  const { data: previous, error: previousError } = await auth.db.from("schema_mappings")
    .select("version").eq("tenant_id", auth.tenantId).eq("vendor_id", vendor.id).eq("record_type", parsed.data.recordType)
    .order("version", { ascending: false }).limit(1).maybeSingle();
  if (previousError) return context.json({ error: previousError.message }, 400);
  const version = (previous?.version ?? 0) + 1;
  const { data: mapping, error } = await auth.db.from("schema_mappings").insert({
    tenant_id: auth.tenantId,
    vendor_id: vendor.id,
    record_type: parsed.data.recordType,
    version,
    field_map: parsed.data.fieldMap,
    location_meaningful: parsed.data.locationMeaningful,
    profile: parsed.data.profile ?? {},
    approved_by: auth.user.id,
    approved_at: new Date().toISOString(),
  }).select("id,version").single();
  if (error || !mapping) return context.json({ error: error?.message ?? "Could not save mapping." }, 400);
  return context.json({ vendorId: vendor.id, mappingId: mapping.id, version: mapping.version }, 201);
});

const uploadSchema = z.object({
  vendorId: z.string().uuid(),
  mappingId: z.string().uuid(),
  fileName: z.string().trim().min(1).max(240),
  contentType: z.string().trim().min(1).max(160),
  fileSize: z.number().int().nonnegative().max(10_737_418_240),
  recordType: z.enum(["site", "project"]),
  sourceVersion: z.string().trim().max(160).optional(),
});

app.post("/api/imports/uploads", async (context) => {
  const auth = context.get("auth");
  const parsed = uploadSchema.safeParse(await context.req.json());
  if (!parsed.success) return context.json({ error: parsed.error.issues[0]?.message ?? "Invalid upload." }, 400);
  const { data: mapping, error: mappingError } = await auth.db.from("schema_mappings")
    .select("id,vendor_id,record_type,version").eq("tenant_id", auth.tenantId).eq("id", parsed.data.mappingId).single();
  if (mappingError || !mapping || mapping.vendor_id !== parsed.data.vendorId || mapping.record_type !== parsed.data.recordType) {
    return context.json({ error: "The approved mapping does not match this vendor and record type." }, 400);
  }
  const fileName = parsed.data.fileName.replace(/[\\/\u0000-\u001f]/g, "_");
  const { data: created, error } = await auth.db.from("vendor_imports").insert({
    tenant_id: auth.tenantId,
    vendor_id: parsed.data.vendorId,
    mapping_id: parsed.data.mappingId,
    record_type: parsed.data.recordType,
    file_name: fileName,
    content_type: parsed.data.contentType,
    file_size: parsed.data.fileSize,
    file_key: "pending",
    source_version: parsed.data.sourceVersion ?? null,
    mapping_version: mapping.version,
    created_by: auth.user.id,
  }).select("id").single();
  if (error || !created) return context.json({ error: error?.message ?? "Could not create import." }, 400);
  const safeName = fileName.normalize("NFKC").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-150);
  const objectKey = auth.tenantId + "/" + created.id + "/" + safeName;
  const { data: importRow, error: updateError } = await auth.db.from("vendor_imports").update({ file_key: objectKey })
    .eq("tenant_id", auth.tenantId).eq("id", created.id).select("id").single();
  if (updateError || !importRow) return context.json({ error: updateError?.message ?? "Could not allocate the import." }, 400);
  return context.json({ importId: created.id, objectKey, status: "created" }, 201);
});

app.post("/api/imports/:importId/multipart/start", async (context) => {
  const auth = context.get("auth");
  const { data: record, error } = await auth.db.from("vendor_imports")
    .select("id,file_key,file_name,content_type,status").eq("tenant_id", auth.tenantId).eq("id", context.req.param("importId")).single();
  if (error || !record) return context.json({ error: "Import not found." }, 404);
  if (record.status !== "uploading") return context.json({ error: "This import is no longer accepting file data." }, 409);
  const upload = await context.env.MATCH_FILES.createMultipartUpload(record.file_key, {
    httpMetadata: { contentType: record.content_type },
    customMetadata: { importId: record.id, tenantId: auth.tenantId },
  });
  const { error: updateError } = await auth.db.from("vendor_imports").update({ multipart_upload_id: upload.uploadId })
    .eq("tenant_id", auth.tenantId).eq("id", record.id);
  if (updateError) {
    await upload.abort();
    return context.json({ error: updateError.message }, 400);
  }
  return context.json({ uploadId: upload.uploadId, objectKey: record.file_key });
});

app.put("/api/imports/:importId/parts/:partNumber", async (context) => {
  const auth = context.get("auth");
  const partNumber = Number(context.req.param("partNumber"));
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000 || !context.req.raw.body) return context.json({ error: "Invalid upload part." }, 400);
  const { data: record, error } = await auth.db.from("vendor_imports")
    .select("file_key,multipart_upload_id,status").eq("tenant_id", auth.tenantId).eq("id", context.req.param("importId")).single();
  if (error || !record?.multipart_upload_id || record.status !== "uploading") return context.json({ error: "Upload session not found." }, 404);
  const upload = context.env.MATCH_FILES.resumeMultipartUpload(record.file_key, record.multipart_upload_id);
  const part = await upload.uploadPart(partNumber, context.req.raw.body);
  return context.json({ partNumber: part.partNumber, etag: part.etag });
});

const partsSchema = z.object({ parts: z.array(z.object({ partNumber: z.number().int().min(1).max(10000), etag: z.string().min(1) })).min(1).max(10000) });
app.post("/api/imports/:importId/complete", async (context) => {
  const auth = context.get("auth");
  const parsed = partsSchema.safeParse(await context.req.json());
  if (!parsed.success) return context.json({ error: "Upload parts are incomplete." }, 400);
  const { data: record, error } = await auth.db.from("vendor_imports")
    .select("id,file_key,multipart_upload_id,status").eq("tenant_id", auth.tenantId).eq("id", context.req.param("importId")).single();
  if (error || !record?.multipart_upload_id || record.status !== "uploading") return context.json({ error: "Upload session not found." }, 404);
  const ordered = [...parsed.data.parts].sort((a, b) => a.partNumber - b.partNumber);
  if (ordered.some((part, index) => part.partNumber !== index + 1)) return context.json({ error: "Upload parts must be complete and sequential." }, 400);
  const multipart = context.env.MATCH_FILES.resumeMultipartUpload(record.file_key, record.multipart_upload_id);
  await multipart.complete(ordered.map((part) => ({ partNumber: part.partNumber, etag: part.etag })));
  const { error: updateError } = await auth.db.from("vendor_imports")
    .update({ status: "queued", multipart_upload_id: null, started_at: new Date().toISOString() })
    .eq("tenant_id", auth.tenantId).eq("id", record.id);
  if (updateError) return context.json({ error: updateError.message }, 400);
  const triggerResponse = await fetch((context.env.TRIGGER_API_URL ?? "https://api.trigger.dev") + "/api/v1/tasks/" + (context.env.TRIGGER_TASK_ID ?? "process-vendor-import") + "/trigger", {
    method: "POST",
    headers: { Authorization: "Bearer " + context.env.TRIGGER_SECRET_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ payload: { importId: record.id, tenantId: auth.tenantId }, options: { idempotencyKey: "vendor-import-" + record.id } }),
  });
  if (!triggerResponse.ok) {
    const message = await triggerResponse.text();
    await auth.db.from("vendor_imports").update({ status: "failed", error_message: "Trigger.dev rejected the job: " + message.slice(0, 300) })
      .eq("tenant_id", auth.tenantId).eq("id", record.id);
    return context.json({ error: "The file is stored, but Trigger.dev did not accept the processing job." }, 502);
  }
  const triggered = await triggerResponse.json() as { id?: string };
  await auth.db.from("vendor_imports").update({ trigger_run_id: triggered.id ?? null }).eq("tenant_id", auth.tenantId).eq("id", record.id);
  return context.json({ importId: record.id, triggerRunId: triggered.id ?? null, status: "queued" }, 202);
});

const importSummarySelect = "id,file_name,source_version,mapping_version,record_type,status,row_count,candidate_count,decision_count,matched_count,related_count,escalated_count,review_count,unmatched_count,created_at,reference_dataset_id,source_dataset_id,vendors(name),dataset1:matching_datasets!vendor_imports_reference_dataset_fk(name,row_count),dataset2:matching_datasets!vendor_imports_source_dataset_fk(name,row_count)";

function mapImport(row: Record<string, unknown>): ImportSummaryDto {
  const vendor = row.vendors as { name?: string } | null;
  const dataset1 = row.dataset1 as { name: string; row_count: number } | null;
  const dataset2 = row.dataset2 as { name: string; row_count: number } | null;
  return {
    id: String(row.id),
    vendor: dataset2?.name ?? vendor?.name ?? "Dataset 2",
    fileName: dataset2?.name ?? String(row.file_name),
    referenceDatasetId: row.reference_dataset_id ? String(row.reference_dataset_id) : null,
    dataset1Name: dataset1?.name ?? "Dataset 1",
    dataset2Name: dataset2?.name ?? String(row.file_name),
    dataset1Rows: dataset1?.row_count ?? null,
    dataset2Rows: dataset2?.row_count ?? Number(row.row_count ?? 0),
    sourceVersion: row.source_version ? String(row.source_version) : null,
    mappingVersion: Number(row.mapping_version ?? 1),
    recordType: row.record_type as "site" | "project",
    status: row.status as ImportSummaryDto["status"],
    rows: Number(row.row_count ?? 0),
    candidateCount: Number(row.candidate_count ?? 0),
    decisionCount: Number(row.decision_count ?? 0),
    matched: Number(row.matched_count ?? 0),
    related: Number(row.related_count ?? 0),
    escalatedCount: Number(row.escalated_count ?? 0),
    review: Number(row.review_count ?? 0),
    unmatched: Number(row.unmatched_count ?? 0),
    createdAt: String(row.created_at),
  };
}

type ImportSummaryDto = {
  id: string;
  vendor: string;
  fileName: string;
  sourceVersion: string | null;
  mappingVersion: number;
  recordType: "site" | "project";
  status: "uploading" | "queued" | "profiling" | "mapping" | "retrieving" | "deciding" | "escalating" | "review" | "completed" | "failed";
  rows: number;
  candidateCount: number;
  decisionCount: number;
  matched: number;
  related: number;
  escalatedCount: number;
  review: number;
  unmatched: number;
  createdAt: string;
  referenceDatasetId: string | null;
  dataset1Name: string;
  dataset2Name: string;
  dataset1Rows: number | null;
  dataset2Rows: number;
};

app.get("/api/dashboard", async (context) => {
  const { db, tenantId, role } = context.get("auth");
  const { data: rows, error } = await db.from("vendor_imports")
    .select(importSummarySelect)
    .eq("tenant_id", tenantId).order("created_at", { ascending: false }).limit(25);
  if (error) return context.json({ error: error.message }, 400);
  const { count: recordCount } = await db.from("internal_records").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId);
  const [{ count: siteCount }, { count: projectCount }, { count: relationshipCount }] = await Promise.all([
    db.from("internal_records").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("record_type", "site"),
    db.from("internal_records").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("record_type", "project"),
    db.from("record_relationships").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId),
  ]);
  const { count: reviewCount } = await db.from("review_queue").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("status", "pending");
  const { count: observationCount } = await db.from("vendor_observations").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId);
  const { count: confirmedLinks } = await db.from("match_overrides").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("outcome", "equivalent");
  const { count: vendorCount } = await db.from("vendors").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("active", true);
  const [equivalent, related, review, unmatched] = await Promise.all([
    "equivalent", "related", "insufficient_evidence", "unmatched",
  ].map(async (outcome) => db.from("matching_decisions").select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId).eq("outcome", outcome)));
  return context.json({
    imports: (rows ?? []).map((row) => mapImport(row as Record<string, unknown>)),
    internalRecords: recordCount ?? 0,
    sites: siteCount ?? 0,
    projects: projectCount ?? 0,
    relationships: relationshipCount ?? 0,
    vendorObservations: observationCount ?? 0,
    confirmedLinks: confirmedLinks ?? 0,
    activeVendors: vendorCount ?? 0,
    pendingReviews: reviewCount ?? 0,
    canDeleteRuns: role === "owner" || role === "admin",
    outcomes: {
      equivalent: equivalent.count ?? 0,
      related: related.count ?? 0,
      review: review.count ?? 0,
      unmatched: unmatched.count ?? 0,
    },
  });
});

app.get("/api/matching-policy", async (context) => {
  const { db, tenantId } = context.get("auth");
  const [{ data: policy, error }, { data: approvals, error: approvalsError }] = await Promise.all([
    db.from("matching_policies").select("minimum_equivalent_probability,minimum_winner_margin,candidate_limit,candidate_minimum_score,auto_link_enabled").eq("tenant_id", tenantId).maybeSingle(),
    db.from("jev_model_approvals").select("resolved_model_version").eq("tenant_id", tenantId).eq("approved", true),
  ]);
  if (error || approvalsError) return context.json({ error: error?.message ?? approvalsError?.message ?? "Could not load policy." }, 400);
  return context.json({
    minimumEquivalentProbability: Number(policy?.minimum_equivalent_probability ?? 0.985),
    minimumWinnerMargin: Number(policy?.minimum_winner_margin ?? 0.12),
    candidateLimit: Number(policy?.candidate_limit ?? 20),
    candidateMinimumScore: Number(policy?.candidate_minimum_score ?? 0.12),
    autoLinkEnabled: Boolean(policy?.auto_link_enabled ?? false),
    approvedVersions: (approvals ?? []).map((row) => row.resolved_model_version),
  });
});

const matchingPolicyPatch = z.object({
  minimumEquivalentProbability: z.number().min(0).max(1).optional(),
  minimumWinnerMargin: z.number().min(0).max(1).optional(),
  candidateLimit: z.number().int().min(1).max(100).optional(),
  candidateMinimumScore: z.number().min(0).max(1).optional(),
  autoLinkEnabled: z.boolean().optional(),
}).strict();
app.patch("/api/matching-policy", async (context) => {
  const { db, tenantId, role } = context.get("auth");
  if (role !== "owner" && role !== "admin") return context.json({ error: "Only workspace owners and admins can change matching policy." }, 403);
  const parsed = matchingPolicyPatch.safeParse(await context.req.json());
  if (!parsed.success || !Object.keys(parsed.data ?? {}).length) return context.json({ error: parsed.success ? "Provide at least one policy setting." : parsed.error.issues[0]?.message ?? "Invalid policy." }, 400);
  const values = {
    tenant_id: tenantId,
    ...(parsed.data.minimumEquivalentProbability !== undefined ? { minimum_equivalent_probability: parsed.data.minimumEquivalentProbability } : {}),
    ...(parsed.data.minimumWinnerMargin !== undefined ? { minimum_winner_margin: parsed.data.minimumWinnerMargin } : {}),
    ...(parsed.data.candidateLimit !== undefined ? { candidate_limit: parsed.data.candidateLimit } : {}),
    ...(parsed.data.candidateMinimumScore !== undefined ? { candidate_minimum_score: parsed.data.candidateMinimumScore } : {}),
    ...(parsed.data.autoLinkEnabled !== undefined ? { auto_link_enabled: parsed.data.autoLinkEnabled } : {}),
    updated_at: new Date().toISOString(),
  };
  const { error } = await db.from("matching_policies").upsert(values, { onConflict: "tenant_id" });
  if (error) return context.json({ error: error.message }, 400);
  return context.json({ status: "saved" });
});

type ModelEvaluationLabel = {
  modelVersion: string;
  predictedOutcome: "equivalent" | "related" | "different" | "insufficient_evidence";
  actualOutcome: "equivalent" | "related" | "different" | "insufficient_evidence";
  candidateRetrieved: boolean;
  costUsd: number;
};

async function collectModelEvaluations(db: SupabaseClient, tenantId: string): Promise<{ evaluations: Array<Record<string, unknown>>; error?: string }> {
  const { data: overrides, error } = await db.from("match_overrides")
    .select("vendor_id,vendor_record_key,internal_record_id,outcome")
    .eq("tenant_id", tenantId).eq("source", "human").not("internal_record_id", "is", null).order("updated_at", { ascending: false }).limit(500);
  if (error) return { evaluations: [], error: error.message };
  const labels = overrides ?? [];
  if (!labels.length) return { evaluations: [], error: undefined };
  const vendorIds = [...new Set(labels.map((row) => row.vendor_id))];
  const recordKeys = [...new Set(labels.map((row) => row.vendor_record_key))];
  const internalIds = [...new Set(labels.map((row) => row.internal_record_id).filter((id): id is string => Boolean(id)))];
  const { data: observations, error: observationsError } = await db.from("vendor_observations")
    .select("id,vendor_id,vendor_record_key,created_at").eq("tenant_id", tenantId)
    .in("vendor_id", vendorIds).in("vendor_record_key", recordKeys).order("created_at", { ascending: false }).limit(5000);
  if (observationsError) return { evaluations: [], error: observationsError.message };
  const observationRows = observations ?? [];
  if (!observationRows.length) return { evaluations: [], error: undefined };
  const observationIds = observationRows.map((row) => row.id);
  const [{ data: decisions, error: decisionsError }, { data: candidates, error: candidatesError }] = await Promise.all([
    db.from("matching_decisions").select("observation_id,internal_record_id,probabilities,model_version,cost_usd")
      .eq("tenant_id", tenantId).in("observation_id", observationIds).order("created_at", { ascending: false }).limit(10000),
    db.from("match_candidates").select("observation_id,internal_record_id")
      .eq("tenant_id", tenantId).in("observation_id", observationIds).in("internal_record_id", internalIds).limit(10000),
  ]);
  if (decisionsError || candidatesError) return { evaluations: [], error: decisionsError?.message ?? candidatesError?.message };
  const decisionRows = decisions ?? [];
  const candidateSet = new Set((candidates ?? []).map((row) => row.observation_id + ":" + row.internal_record_id));
  const observationGroups = new Map<string, typeof observationRows>();
  for (const row of observationRows) {
    const key = row.vendor_id + ":" + row.vendor_record_key;
    observationGroups.set(key, [...(observationGroups.get(key) ?? []), row]);
  }
  const outcomeNames = ["equivalent", "related", "different", "insufficient_evidence"] as const;
  const labelByVersion = new Map<string, ModelEvaluationLabel>();
  for (const override of labels) {
    if (!override.internal_record_id) continue;
    const key = override.vendor_id + ":" + override.vendor_record_key;
    const groupedObservations = observationGroups.get(key) ?? [];
    for (const observation of groupedObservations) {
      const decision = decisionRows.find((row) => row.observation_id === observation.id && row.internal_record_id === override.internal_record_id);
      const modelVersion = decision?.model_version;
      const probabilities = decision?.probabilities as Record<string, unknown> | null;
      if (!modelVersion || modelVersion === "human-override" || modelVersion.startsWith("test-adapter") || !probabilities) continue;
      const values = outcomeNames.map((outcome) => Number(probabilities[outcome] ?? 0));
      const total = values.reduce((sum, value) => sum + value, 0);
      if (!total) continue;
      const predictedOutcome = outcomeNames[values.indexOf(Math.max(...values))];
      const actualOutcome = override.outcome as ModelEvaluationLabel["actualOutcome"];
      if (!outcomeNames.includes(actualOutcome)) continue;
      const labelKey = modelVersion + ":" + key + ":" + override.internal_record_id;
      if (labelByVersion.has(labelKey)) continue;
      labelByVersion.set(labelKey, {
        modelVersion,
        predictedOutcome,
        actualOutcome,
        candidateRetrieved: candidateSet.has(observation.id + ":" + override.internal_record_id),
        costUsd: Number(decision.cost_usd ?? 0),
      });
    }
  }
  return { evaluations: evaluateLabeledModelPairs([...labelByVersion.values()]) };
}

app.get("/api/model-evaluations", async (context) => {
  const { db, tenantId } = context.get("auth");
  const result = await collectModelEvaluations(db, tenantId);
  if (result.error) return context.json({ error: result.error }, 400);
  return context.json({ evaluations: result.evaluations, maxLabeledPairs: 500 });
});

app.post("/api/model-approvals", async (context) => {
  const { db, tenantId, role } = context.get("auth");
  if (role !== "owner" && role !== "admin") return context.json({ error: "Only workspace owners and admins can approve model versions." }, 403);
  const parsed = z.object({ modelVersion: z.string().trim().min(1).max(200), approved: z.boolean() }).safeParse(await context.req.json());
  if (!parsed.success) return context.json({ error: "Provide a model version and approval state." }, 400);
  let evaluationSummary: Record<string, unknown> = {};
  if (parsed.data.approved) {
    const result = await collectModelEvaluations(db, tenantId);
    if (result.error) return context.json({ error: result.error }, 400);
    const evaluation = result.evaluations.find((item) => item.modelVersion === parsed.data.modelVersion);
    const passes = evaluation && passesModelVersionApprovalGate(evaluation as unknown as Parameters<typeof passesModelVersionApprovalGate>[0]);
    if (!passes) return context.json({ error: "This version needs at least 20 labeled pairs, five actual and predicted equivalent examples, at least 99.5% candidate recall and equivalent precision, and zero false equivalent predictions." }, 422);
    evaluationSummary = evaluation;
  }
  const { error } = await db.from("jev_model_approvals").upsert({
    tenant_id: tenantId,
    resolved_model_version: parsed.data.modelVersion,
    approved: parsed.data.approved,
    evaluated_at: parsed.data.approved ? new Date().toISOString() : null,
    evaluation_summary: evaluationSummary,
  }, { onConflict: "tenant_id,resolved_model_version" });
  if (error) return context.json({ error: error.message }, 400);
  return context.json({ modelVersion: parsed.data.modelVersion, approved: parsed.data.approved });
});

app.get("/api/records", async (context) => {
  const { db, tenantId } = context.get("auth");
  const q = context.req.query("q");
  let query = db.from("internal_records").select("id,record_type,display_name,normalized_identifiers,aliases,normalized_data,updated_at")
    .eq("tenant_id", tenantId).order("updated_at", { ascending: false }).limit(100);
  if (q) query = query.ilike("search_text", "%" + q.replace(/[%_]/g, "") + "%");
  const { data, error } = await query;
  if (error) return context.json({ error: error.message }, 400);
  return context.json({ records: data ?? [] });
});

const recordSchema = z.object({
  recordType: z.enum(["site", "project"]),
  displayName: z.string().trim().min(1).max(240),
  identifiers: z.record(z.string(), z.string()).default({}),
  aliases: z.array(z.string().trim().min(1).max(160)).default([]),
  fields: z.record(z.string(), z.unknown()).default({}),
});
app.post("/api/records", async (context) => {
  const { db, tenantId } = context.get("auth");
  const parsed = recordSchema.safeParse(await context.req.json());
  if (!parsed.success) return context.json({ error: parsed.error.issues[0]?.message ?? "Invalid record." }, 400);
  const normalizedIdentifiers = Object.fromEntries(Object.entries(parsed.data.identifiers).map(([key, value]) => [key, normalizeIdentifier(value)]));
  const { data, error } = await db.from("internal_records").insert({
    tenant_id: tenantId,
    record_type: parsed.data.recordType,
    display_name: parsed.data.displayName,
    normalized_identifiers: normalizedIdentifiers,
    aliases: parsed.data.aliases,
    raw_values: parsed.data.fields,
    normalized_data: { ...parsed.data.fields, display_name: parsed.data.displayName },
    provenance: { source: "manual", user_id: context.get("auth").user.id },
  }).select("id,record_type,display_name,normalized_identifiers,aliases").single();
  if (error || !data) return context.json({ error: error?.message ?? "Could not create record." }, 400);
  return context.json({ record: data }, 201);
});

function normalizeIdentifier(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("und").replace(/\s+/g, "");
}

app.get("/api/reviews", async (context) => {
  const { db, tenantId } = context.get("auth");
  const { data: queue, error } = await db.from("review_queue")
    .select("id,import_id,observation_id,decision_id,created_at,matching_decisions(id,internal_record_id,outcome,probabilities,confidence,model_version,evidence_refs,conflicting_evidence,explanation),vendor_observations(id,vendor_id,vendor_record_key,record_type,source_record_id,raw_row,normalized_data,normalized_identifiers,aliases)")
    .eq("tenant_id", tenantId).eq("status", "pending").order("created_at").limit(50);
  if (error) return context.json({ error: error.message }, 400);
  const reviewRows = queue ?? [];
  const internalIds = [...new Set(reviewRows.map((row) => {
    const decision = Array.isArray(row.matching_decisions) ? row.matching_decisions[0] : row.matching_decisions;
    return (decision as { internal_record_id?: string } | null)?.internal_record_id;
  }).filter((id): id is string => Boolean(id)))];
  const { data: records } = internalIds.length
    ? await db.from("internal_records").select("id,record_type,display_name,normalized_identifiers,aliases,raw_values,normalized_data").eq("tenant_id", tenantId).in("id", internalIds)
    : { data: [] as Record<string, unknown>[] };
  const recordById = new Map((records ?? []).map((row) => [row.id, row]));
  return context.json({ reviews: await Promise.all(reviewRows.map(async (row) => {
    const decision = (Array.isArray(row.matching_decisions) ? row.matching_decisions[0] : row.matching_decisions) as Record<string, unknown> | null;
    const observation = (Array.isArray(row.vendor_observations) ? row.vendor_observations[0] : row.vendor_observations) as Record<string, unknown> | null;
    const internalRecordId = typeof decision?.internal_record_id === "string" ? decision.internal_record_id : null;
    const internal = internalRecordId ? recordById.get(internalRecordId) ?? null : null;
    const vendor = observation?.vendor_id ? await db.from("vendors").select("name").eq("tenant_id", tenantId).eq("id", observation.vendor_id).maybeSingle() : { data: null };
    return { ...row, decision, observation, internal, vendorName: vendor.data?.name ?? "Vendor" };
  })) });
});

const reviewOutcome = z.object({
  outcome: z.enum(["accepted", "rejected", "related", "insufficient_evidence"]),
  rationale: z.string().max(1000).optional(),
});
app.post("/api/reviews/:reviewId/outcome", async (context) => {
  const { db, role } = context.get("auth");
  if (!["owner", "admin", "reviewer"].includes(role)) return context.json({ error: "This workspace role cannot resolve review items." }, 403);
  const parsed = reviewOutcome.safeParse(await context.req.json());
  if (!parsed.success) return context.json({ error: "Choose an allowed review outcome." }, 400);
  const outcomeMap = { accepted: "equivalent", rejected: "different", related: "related", insufficient_evidence: "insufficient_evidence" } as const;
  const outcome = outcomeMap[parsed.data.outcome];
  const { data, error } = await db.rpc("resolve_review_outcome", {
    p_review_id: context.req.param("reviewId"),
    p_outcome: outcome,
    p_rationale: parsed.data.rationale ?? null,
  });
  if (error) return context.json({ error: error.message }, error.code === "P0002" ? 404 : 400);
  return context.json(data);
});

function mapSourceResult(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    sourceRowNumber: Number(row.source_row_number),
    recordType: row.record_type,
    vendorRecordKey: row.vendor_record_key,
    displayName: String(row.display_name),
    processingStatus: row.processing_status,
    outcome: row.outcome ?? null,
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    requiresReview: Boolean(row.requires_review),
    internalRecordId: row.internal_record_id ?? null,
    internalDisplayName: row.internal_display_name ?? null,
    internalRecordType: row.internal_record_type ?? null,
    sourceFields: row.source_fields ?? {},
    matchedFields: row.matched_fields ?? null,
    explanation: row.explanation ?? null,
    modelVersion: row.model_version ?? null,
    resolvedModel: row.model_version ?? null,
    probabilities: row.probabilities ?? null,
    conflictingEvidence: row.conflicting_evidence ?? [],
    evidenceRefs: row.evidence_refs ?? [],
    modelSource: row.model_source ?? null,
  };
}

/** Enrich the exact decision already selected by the result RPC; never choose a new winner here. */
async function enrichSourceResults(db: SupabaseClient, tenantId: string, importId: string, rows: Record<string, unknown>[]) {
  const byObservation = new Map<string, Record<string, unknown>>();
  const validRows = rows.filter((row) => z.uuid().safeParse(row.id).success
    && (row.internal_record_id === null || z.uuid().safeParse(row.internal_record_id).success)
    && ["equivalent", "related", "different", "insufficient_evidence", "unmatched"].includes(String(row.outcome)));
  const chunks: Record<string, unknown>[][] = [];
  for (let offset = 0; offset < validRows.length; offset += 40) chunks.push(validRows.slice(offset, offset + 40));
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(3, chunks.length) }, async () => {
    while (cursor < chunks.length) {
      const chunk = chunks[cursor++];
      const conditions = chunk.map((row) => `and(observation_id.eq.${row.id},internal_record_id.${row.internal_record_id === null ? "is.null" : "eq." + row.internal_record_id},outcome.eq.${row.outcome})`).join(",");
      const { data, error } = await db.from("matching_decisions")
        .select("observation_id,internal_record_id,outcome,explanation,model_version,probabilities,conflicting_evidence,evidence_refs,source")
        .eq("tenant_id", tenantId).eq("import_id", importId).or(conditions).limit(40);
      if (error) continue;
      for (const decision of data ?? []) byObservation.set(String(decision.observation_id), { ...decision, model_source: decision.source });
    }
  }));
  return rows.map((row) => ({ ...byObservation.get(String(row.id)), ...row }));
}

app.delete("/api/runs/:importId", async (context) => {
  const { db, tenantId, role } = context.get("auth");
  if (role !== "owner" && role !== "admin") return context.json({ error: "Only workspace owners and admins can delete comparisons." }, 403);
  if (!context.env.MATCH_FILES) return context.json({ error: "Source file storage is unavailable. The comparison was not deleted." }, 503);
  const parsedId = z.uuid().safeParse(context.req.param("importId"));
  if (!parsedId.success) return context.json({ error: "Comparison not found." }, 404);

  const args = { p_tenant_id: tenantId, p_import_id: parsedId.data };
  const { data: objectKeys, error: beginError } = await db.rpc("begin_dataset_match_deletion", args);
  if (beginError) {
    if (beginError.code === "42501") return context.json({ error: "Only workspace owners and admins can delete comparisons." }, 403);
    if (beginError.code === "P0002") return context.json({ error: "Comparison not found." }, 404);
    if (beginError.code === "22023") return context.json({ error: beginError.message }, 400);
    return context.json({ error: beginError.code === "55000" ? beginError.message : "The comparison could not be prepared for deletion." }, beginError.code === "55000" ? 409 : 400);
  }

  try {
    if (Array.isArray(objectKeys) && objectKeys.length) await context.env.MATCH_FILES.delete(objectKeys);
  } catch {
    return context.json({ error: "The comparison is marked for deletion. Retry to finish removing its source files." }, 502);
  }

  const { error: finishError } = await db.rpc("finish_dataset_match_deletion", args);
  if (finishError) return context.json({ error: "Source files were removed, but comparison metadata remains. Retry deletion to finish." }, 502);
  return context.json({ deleted: true });
});

app.get("/api/runs/:importId/results", async (context) => {
  const { db, tenantId } = context.get("auth");
  const importId = context.req.param("importId");
  const offset = Number(context.req.query("offset") ?? 0);
  const limit = Number(context.req.query("limit") ?? 500);
  if (!Number.isInteger(offset) || offset < 0 || offset > 2_147_483_000 || !Number.isInteger(limit) || limit < 1 || limit > 500) {
    return context.json({ error: "Use a nonnegative result offset and a page size from 1 to 500." }, 400);
  }
  const { data: importRow, error: importError } = await db.from("vendor_imports").select("id,status,row_count")
    .eq("tenant_id", tenantId).eq("id", importId).maybeSingle();
  if (importError || !importRow) return context.json({ error: "Run not found." }, 404);
  const [{ data: rows, error }, { data: counts, error: countError }] = await Promise.all([
    db.rpc("get_run_result_page", { p_tenant_id: tenantId, p_import_id: importId, p_offset: offset, p_limit: limit }),
    db.rpc("get_run_result_counts", { p_tenant_id: tenantId, p_import_id: importId }),
  ]);
  if (error || countError) return context.json({ error: error?.message ?? countError?.message ?? "Could not load results." }, 400);
  const values = (rows ?? []) as Record<string, unknown>[];
  const total = Number(counts?.rowCount ?? 0);
  const expectedTotal = Number(importRow.row_count);
  const processedRowCount = Number(counts?.processedRowCount ?? 0);
  const terminal = importRow.status === "completed" || importRow.status === "review";
  const complete = terminal && total === expectedTotal && processedRowCount === expectedTotal;
  if (terminal && !complete) return context.json({ error: "This comparison is missing saved results and cannot be exported yet.", status: importRow.status, total, expectedTotal, processedRowCount }, 409);
  if (offset < total && !values.length) return context.json({ error: "The result page is incomplete. Please try loading the results again." }, 409);
  context.header("Cache-Control", "private, no-store");
  return context.json({
    rows: (await enrichSourceResults(db, tenantId, importId, values)).map(mapSourceResult), total, expectedTotal, processedRowCount, status: importRow.status, complete,
    nextOffset: values.length && offset + values.length < total ? offset + values.length : null,
  });
});

app.get("/api/runs/:importId/flow", async (context) => {
  const { db, tenantId } = context.get("auth");
  const importId = context.req.param("importId");
  const { data: importRow, error: importError } = await db.from("vendor_imports").select("id,reference_dataset_id,row_count,status")
    .eq("tenant_id", tenantId).eq("id", importId).maybeSingle();
  if (importError || !importRow) return context.json({ error: "Run not found." }, 404);

  const referenceQuery = () => {
    const query = db.from("internal_records").select("id,record_type,display_name", { count: "exact" }).eq("tenant_id", tenantId);
    return importRow.reference_dataset_id ? query.eq("dataset_id", importRow.reference_dataset_id) : query.is("dataset_id", null);
  };
  const [{ data: referenceRecords, count: internalRecordCount, error: recordsError }, { data: counts, error: progressError }] = await Promise.all([
    referenceQuery().order("id").limit(120),
    db.rpc("get_run_result_counts", { p_tenant_id: tenantId, p_import_id: importId }),
  ]);
  if (recordsError || progressError) return context.json({ error: recordsError?.message ?? progressError?.message ?? "Could not load run records." }, 400);
  const flowOffset = Math.max(0, Number(counts?.processedRowCount ?? 0) - 120);
  const { data: observations, error: observationsError } = await db.rpc("get_run_result_page", {
    p_tenant_id: tenantId, p_import_id: importId, p_offset: flowOffset, p_limit: 120,
  });
  if (observationsError) return context.json({ error: observationsError.message }, 400);

  const observationRows = (observations ?? []) as Record<string, unknown>[];
  return context.json({
    status: importRow.status,
    complete: (importRow.status === "completed" || importRow.status === "review")
      && Number(counts?.rowCount ?? 0) === Number(importRow.row_count)
      && Number(counts?.processedRowCount ?? 0) === Number(importRow.row_count),
    rowCount: Number(importRow.row_count ?? 0),
    processedRowCount: Number(counts?.processedRowCount ?? 0),
    internalRecordCount: internalRecordCount ?? 0,
    sourceRows: (await enrichSourceResults(db, tenantId, importId, observationRows)).map(mapSourceResult),
    internalRecords: (referenceRecords ?? []).map((record) => ({ id: record.id, recordType: record.record_type, displayName: record.display_name })),
  });
});

app.get("/api/runs/:importId/events", async (context) => {
  const { db, tenantId } = context.get("auth");
  const importId = context.req.param("importId");
  const after = Number(context.req.query("after") ?? 0);
  const { data: importRow, error } = await db.from("vendor_imports").select("status")
    .eq("tenant_id", tenantId).eq("id", importId).maybeSingle();
  if (error || !importRow) return context.json({ error: "Run not found." }, 404);
  context.header("Cache-Control", "no-cache, no-transform");
  context.header("X-Accel-Buffering", "no");
  return streamSSE(context, async (stream) => {
    let cursor = Number.isFinite(after) ? after : 0;
    let status = importRow.status as string;
    const terminal = new Set(["review", "completed", "failed"]);
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const { data: events } = await db.from("run_events").select("sequence,event_type,message,payload,created_at")
        .eq("tenant_id", tenantId).eq("import_id", importId).gt("sequence", cursor).order("sequence").limit(250);
      for (const row of events ?? []) {
        cursor = Number(row.sequence);
        await stream.writeSSE({
          id: String(row.sequence),
          event: row.event_type,
          data: JSON.stringify({ sequence: row.sequence, type: row.event_type, message: row.message, payload: row.payload, createdAt: row.created_at }),
        });
      }
      const { data: latest } = await db.from("vendor_imports").select("status").eq("tenant_id", tenantId).eq("id", importId).maybeSingle();
      status = latest?.status ?? status;
      if (terminal.has(status)) {
        // A completed large run can have more than two pages of activity.
        // Drain the replay so the browser also receives the final outcome.
        while (Date.now() < deadline) {
          const { data: trailing } = await db.from("run_events").select("sequence,event_type,message,payload,created_at")
            .eq("tenant_id", tenantId).eq("import_id", importId).gt("sequence", cursor).order("sequence").limit(250);
          for (const row of trailing ?? []) {
            cursor = Number(row.sequence);
            await stream.writeSSE({
              id: String(row.sequence), event: row.event_type,
              data: JSON.stringify({ sequence: row.sequence, type: row.event_type, message: row.message, payload: row.payload, createdAt: row.created_at }),
            });
          }
          if ((trailing?.length ?? 0) < 250) break;
        }
        break;
      }
      await stream.write(": heartbeat\n\n");
      await stream.sleep(1200);
    }
  });
});

app.get("/internal/uploads/:importId", async (context) => {
  const secret = context.req.header("X-Internal-Job-Secret") ?? "";
  if (!secret || !context.env.INTERNAL_JOB_SECRET || !constantTimeEqual(secret, context.env.INTERNAL_JOB_SECRET)) return context.json({ error: "Unauthorized." }, 401);
  const importId = context.req.param("importId");
  const tenantId = context.req.query("tenantId");
  if (!tenantId) return context.json({ error: "Tenant ID required." }, 400);
  const admin = createClient(context.env.SUPABASE_URL, context.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: record, error } = await admin.from("vendor_imports").select("file_key,file_name,content_type,file_size")
    .eq("tenant_id", tenantId).eq("id", importId).maybeSingle();
  if (error || !record) return context.json({ error: "Source file not found." }, 404);
  const stored = await context.env.MATCH_FILES.get(record.file_key);
  if (!stored?.body) return context.json({ error: "Source file is unavailable." }, 404);
  return new Response(stored.body, { headers: {
    "Content-Type": record.content_type,
    "Content-Length": String(record.file_size),
    "Content-Disposition": "attachment; filename=\"" + record.file_name.replace(/["\r\n]/g, "_") + "\"",
    "Cache-Control": "private, no-store",
  } });
});

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

app.notFound((context) => context.json({ error: "Route not found." }, 404));

export default app;
