import { z } from "zod";

export const MAX_DATASET_MATCH_BYTES = 20 * 1024 * 1024;
export const MAX_DATASET_ROWS = 10_000;
const cellSchema = z.union([z.string().max(20_000), z.number().finite(), z.boolean(), z.null()]);
const columnSchema = z.string().min(1).max(240).refine((value) => !["__proto__", "constructor", "prototype"].includes(value), "Unsupported column name.");
const rowSchema = z.record(columnSchema, cellSchema).refine((row) => Object.keys(row).length <= 250, "Use at most 250 columns per dataset.");

export const datasetSourceSchema = z.object({
  name: z.string().trim().min(1).max(240),
  rows: z.array(rowSchema).min(1, "Add at least one row to each dataset.").max(MAX_DATASET_ROWS),
  nameField: columnSchema,
  idField: columnSchema.optional(),
}).superRefine((source, context) => {
  const columns = new Set(source.rows.flatMap((row) => Object.keys(row)));
  if (columns.size > 250) context.addIssue({ code: "custom", path: ["rows"], message: "Use at most 250 columns per dataset." });
  if (!columns.has(source.nameField)) context.addIssue({ code: "custom", path: ["nameField"], message: "Choose a record name column from this dataset." });
  if (source.idField && !columns.has(source.idField)) context.addIssue({ code: "custom", path: ["idField"], message: "Choose an ID column from this dataset." });
  const emptyNameIndex = source.rows.findIndex((row) => !String(row[source.nameField] ?? "").trim());
  if (emptyNameIndex >= 0) context.addIssue({ code: "custom", path: ["rows", emptyNameIndex], message: `Row ${emptyNameIndex + 1} has an empty record name. Choose another name column or fill the missing value.` });
});

export const datasetMatchSchema = z.object({ dataset1: datasetSourceSchema, dataset2: datasetSourceSchema }).refine(
  (value) => Boolean(value.dataset1.idField) === Boolean(value.dataset2.idField),
  "Choose a shared identifier in both datasets, or leave both unselected.",
);
export type DatasetSource = z.infer<typeof datasetSourceSchema>;

export class DatasetRequestError extends Error {
  constructor(message: string, public readonly status: 400 | 413 = 400) { super(message); }
}

/** Bound the actual stream, including requests without a Content-Length header. */
export async function readDatasetMatchBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (declared > MAX_DATASET_MATCH_BYTES) throw new DatasetRequestError("Both datasets together must be smaller than 20 MB.", 413);
  if (!request.body) throw new DatasetRequestError("Provide both datasets.");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_DATASET_MATCH_BYTES) {
        await reader.cancel();
        throw new DatasetRequestError("Both datasets together must be smaller than 20 MB.", 413);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    try { return JSON.parse(text) as unknown; }
    catch { throw new DatasetRequestError("The dataset request must contain valid JSON."); }
  } finally { reader.releaseLock(); }
}

export function datasetFieldMap(source: DatasetSource): Record<string, string> {
  const fields = Object.fromEntries([...new Set(source.rows.flatMap((row) => Object.keys(row)))].map((key) => ["data." + key, key]));
  fields.display_name = source.nameField;
  if (source.idField) fields["identifiers.shared"] = source.idField;
  return fields;
}

export function datasetReferenceRecords(source: DatasetSource) {
  return source.rows.map((raw, index) => {
    const sharedId = source.idField ? String(raw[source.idField] ?? "").normalize("NFC").trim() : "";
    return {
    display_name: String(raw[source.nameField]).trim(),
    normalized_identifiers: sharedId ? { shared: sharedId } : {},
    raw_values: raw,
    normalized_data: { ...raw, display_name: String(raw[source.nameField]).trim(), record_type: "site" },
    provenance: { source_row_number: index + 1, source_record_id: source.idField ? String(raw[source.idField] ?? "") : null },
    };
  });
}
