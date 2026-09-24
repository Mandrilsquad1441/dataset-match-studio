import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));
import app from "../src/index";

const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const importId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let importRow: Record<string, unknown>;
let counts: Record<string, number>;
let page: Record<string, unknown>[];
let env: Env;

beforeEach(() => {
  importRow = { id: importId, status: "completed", row_count: 1 };
  counts = { rowCount: 1, processedRowCount: 1 };
  page = [{ id: "row-one", source_row_number: 1, display_name: "Alpine", outcome: "equivalent", confidence: 0.99, processing_status: "matched" }];
  mocks.createClient.mockReturnValue({
    auth: { getUser: async () => ({ data: { user: { id: "owner" } }, error: null }) },
    from(table: string) {
      const query = {
        select() { return query; }, eq() { return query; }, order() { return query; }, limit() { return query; }, update() { return query; }, insert() { return query; },
        maybeSingle: async () => ({ data: table === "tenant_memberships" ? { tenant_id: tenantId, role: "owner" } : importRow, error: null }),
        single: async () => ({ data: null, error: { message: "Transient summary lookup failure" } }),
        then(resolve: (value: unknown) => unknown) { return Promise.resolve({ data: null, error: null }).then(resolve); },
      };
      return query;
    },
    rpc: async (name: string) => ({ data: name === "create_dataset_match" ? { referenceDatasetId: "reference-id", createdAt: "2026-09-23T12:00:00Z" } : name === "get_run_result_counts" ? counts : page, error: null }),
  });
  env = {
    APP_ORIGIN: "https://app.example.test", SUPABASE_URL: "https://db.example.test", SUPABASE_ANON_KEY: "test-anon",
    TRIGGER_SECRET_KEY: "test-trigger", MATCH_FILES: { put: vi.fn().mockResolvedValue({}), delete: vi.fn().mockResolvedValue(undefined) },
  } as unknown as Env;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "run-test" }), { status: 200, headers: { "content-type": "application/json" } })));
});

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
const authorization = { Authorization: "Bearer test-user" };

describe("dataset route guarantees", () => {
  it("keeps protected source files inaccessible when the internal secret is not configured", async () => {
    const response = await app.request(`/internal/uploads/${importId}?tenantId=${tenantId}`, {}, env);
    expect(response.status).toBe(401);
  });

  it("always returns a correctly labeled summary after successful creation, even when the summary lookup fails", async () => {
    const response = await app.request("/api/dataset-matches", {
      method: "POST", headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ dataset1: { name: "Customer ledger", nameField: "name", rows: [{ name: "Alpine" }] }, dataset2: { name: "CRM extract", nameField: "label", rows: [{ label: "Alpine" }, { label: "Delta" }] } }),
    }, env);
    expect(response.status).toBe(202);
    const result = await response.json() as { importId: string; summary: Record<string, unknown> };
    expect(result.summary).toMatchObject({ id: result.importId, status: "queued", dataset1Name: "Customer ledger", dataset2Name: "CRM extract", dataset1Rows: 1, dataset2Rows: 2, rows: 2, vendor: "CRM extract", fileName: "CRM extract", referenceDatasetId: "reference-id", createdAt: "2026-09-23T12:00:00Z" });
  });

  it("blocks a completed export when an expected row has no saved outcome", async () => {
    importRow.row_count = 2;
    counts = { rowCount: 2, processedRowCount: 1 };
    const response = await app.request(`/api/runs/${importId}/results`, { headers: authorization }, env);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ total: 2, expectedTotal: 2, processedRowCount: 1 });
  });

  it("does not treat an empty page as the end while stored results remain", async () => {
    page = [];
    const response = await app.request(`/api/runs/${importId}/results`, { headers: authorization }, env);
    expect(response.status).toBe(409);
  });

  it("provides a continuation offset for complete results that span pages", async () => {
    importRow.row_count = 3;
    counts = { rowCount: 3, processedRowCount: 3 };
    page.push({ ...page[0], id: "row-two", source_row_number: 2 });
    const response = await app.request(`/api/runs/${importId}/results?offset=0&limit=2`, { headers: authorization }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: 3, expectedTotal: 3, complete: true, status: "completed", nextOffset: 2 });
  });
});
