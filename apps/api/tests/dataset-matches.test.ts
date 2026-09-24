import { describe, expect, it } from "vitest";
import { datasetFieldMap, datasetMatchSchema, datasetReferenceRecords, DatasetRequestError, MAX_DATASET_MATCH_BYTES, readDatasetMatchBody } from "../src/dataset-matches";

const source = { name: "Dataset 1", nameField: "company.name", idField: "id", rows: [{ "company.name": "Alpine Café", id: "123", active: true, amount: 42, note: null }] };

describe("dataset comparison input", () => {
  it("accepts two independent schemas and preserves literal dotted column names", () => {
    const incoming = { name: "Dataset 2", nameField: "label", idField: "key", rows: [{ label: "Alpine Cafe", key: "123" }] };
    const result = datasetMatchSchema.parse({ dataset1: source, dataset2: incoming });
    expect(datasetFieldMap(result.dataset1)).toMatchObject({ display_name: "company.name", "identifiers.shared": "id", "data.company.name": "company.name" });
    expect(datasetReferenceRecords(result.dataset1)[0]).toMatchObject({ display_name: "Alpine Café", raw_values: source.rows[0] });
  });

  it("uses an explicitly selected shared identifier without using it as the row key", () => {
    expect(datasetReferenceRecords(source)[0].normalized_identifiers).toEqual({ shared: "123" });
    expect(datasetReferenceRecords(source)[0].provenance.source_record_id).toBe("123");
    expect(datasetReferenceRecords(source)[0].provenance.source_row_number).toBe(1);
    expect(datasetFieldMap(source)["identifiers.shared"]).toBe("id");
  });

  it("preserves shared ID case, punctuation and compatibility characters", () => {
    const records = datasetReferenceRecords({ ...source, rows: [{ "company.name": "A", id: "  Ａb-C.12  " }] });
    expect(records[0].normalized_identifiers).toEqual({ shared: "Ａb-C.12" });
  });

  it("requires the same shared identifier choice on both sides", () => {
    expect(datasetMatchSchema.safeParse({ dataset1: source, dataset2: { ...source, idField: undefined } }).success).toBe(false);
  });

  it.each([
    { ...source, nameField: "missing" },
    { ...source, idField: "missing" },
    { ...source, rows: [{ "company.name": "   " }] },
    { ...source, rows: [] },
    { ...source, rows: Array.from({ length: 10001 }, () => source.rows[0]) },
    { ...source, rows: [{ "company.name": "A", nested: { value: "not flattened" } }] },
    { ...source, rows: [JSON.parse('{"company.name":"A","__proto__":"unsafe"}')] },
  ])("rejects invalid or oversized dataset structures", (invalid) => {
    expect(datasetMatchSchema.safeParse({ dataset1: invalid, dataset2: source }).success).toBe(false);
  });

  it("rejects more than 250 columns even when they are distributed across rows", () => {
    const rows = Array.from({ length: 251 }, (_, index) => ({ name: "Record", ["extra" + index]: "value" }));
    expect(datasetMatchSchema.safeParse({ dataset1: { name: "Many columns", nameField: "name", rows }, dataset2: source }).success).toBe(false);
  });
});

describe("bounded JSON transport", () => {
  it("reads UTF-8 JSON when multibyte characters span chunks", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ text: "Café" }));
    const body = new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    } });
    const request = new Request("https://example.test/api/dataset-matches", { method: "POST", body, duplex: "half" } as RequestInit);
    expect(await readDatasetMatchBody(request)).toEqual({ text: "Café" });
  });

  it("bounds requests with no Content-Length and cancels the stream", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(MAX_DATASET_MATCH_BYTES / 2 + 1)); },
      cancel() { cancelled = true; },
    });
    const request = new Request("https://example.test/api/dataset-matches", { method: "POST", body, duplex: "half" } as RequestInit);
    await expect(readDatasetMatchBody(request)).rejects.toMatchObject({ status: 413 });
    expect(cancelled).toBe(true);
  });

  it("returns a useful validation error for malformed JSON", async () => {
    await expect(readDatasetMatchBody(new Request("https://example.test", { method: "POST", body: "not json" }))).rejects.toBeInstanceOf(DatasetRequestError);
  });
});
