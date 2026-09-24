import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { MAX_DATASET_BYTES, MAX_DATASET_CELL_CHARS, MAX_DATASET_FIELD_CHARS, MAX_DATASET_ROWS, parseDatasetFile, parseDatasetText } from "./dataset-input";

describe("dataset text imports", () => {
  it("preserves quoted separators, newlines, leading zero identifiers and empty final cells", () => {
    const parsed = parseDatasetText('id,name,notes\r\n001,"Acme, Inc.","line one\nline two"\r\n002,Other,');
    expect(parsed.format).toBe("csv");
    expect(parsed.rows).toEqual([
      { id: "001", name: "Acme, Inc.", notes: "line one\nline two" },
      { id: "002", name: "Other", notes: "" },
    ]);
  });

  it("detects copied spreadsheet tables and preserves a final empty TSV cell", () => {
    const parsed = parseDatasetText("id\tname\tnote\n003\tCafé AG\t");
    expect(parsed.format).toBe("tsv");
    expect(parsed.rows).toEqual([{ id: "003", name: "Café AG", note: "" }]);
  });

  it("detects semicolon and pipe delimited exports", () => {
    expect(parseDatasetText("id;name\n1;One").rows[0]).toEqual({ id: "1", name: "One" });
    expect(parseDatasetText("id|name\n1|One").rows[0]).toEqual({ id: "1", name: "One" });
  });

  it.each(["records", "data", "results", "items"])("extracts JSON %s arrays and flattens nested fields", (wrapper) => {
    const parsed = parseDatasetText(JSON.stringify({ [wrapper]: [{ id: "0007", address: { city: "Bern" }, aliases: ["A", "B"] }] }));
    expect(parsed.rows[0]).toEqual({ id: "0007", "address.city": "Bern", aliases: "A | B" });
  });

  it("accepts a single JSON record and unions fields from every row", () => {
    expect(parseDatasetText('{"name":"One","active":false}').rows[0]).toEqual({ name: "One", active: "false" });
    expect(parseDatasetText('[{"name":"One"},{"id":2,"name":"Two"}]').headers).toEqual(["name", "id"]);
    expect(parseDatasetText('{"data":{"items":[{"name":"One"}]}}').rows[0]).toEqual({ name: "One" });
  });

  it("detects JSONL and reports the malformed physical line", () => {
    expect(parseDatasetText('{"id":"1"}\n\n{"id":"2"}\n').format).toBe("jsonl");
    expect(() => parseDatasetText('{"id":"1"}\n\n{"id":}\n', "data", "jsonl")).toThrow("Line 3");
  });

  it("rejects blank, duplicate, malformed and inconsistent delimited data", () => {
    expect(() => parseDatasetText("  \n")).toThrow("Add some records");
    expect(() => parseDatasetText("name,name\na,b")).toThrow("Duplicate");
    expect(() => parseDatasetText("Name, name \na,b")).toThrow("Duplicate");
    expect(() => parseDatasetText("name,\na,b")).toThrow("no name");
    expect(() => parseDatasetText('name,id\n"broken,1')).toThrow(/quoted/i);
    expect(() => parseDatasetText("name,id\na,1,extra")).toThrow("Row 2");
    expect(() => parseDatasetText("name,id")).toThrow("No records");
  });

  it("rejects invalid JSON shapes, ambiguity, collisions and imprecise numeric IDs", () => {
    expect(() => parseDatasetText("[]")).toThrow("No records");
    expect(() => parseDatasetText("[{}]")).toThrow("no fields");
    expect(() => parseDatasetText("[1,2]")).toThrow("not a JSON object");
    expect(() => parseDatasetText('{"records":[{"x":1}],"items":[{"x":2}]}')).toThrow("several record arrays");
    expect(() => parseDatasetText('{"a.b":1,"a":{"b":2}}')).toThrow("same name");
    expect(() => parseDatasetText('{"id":9007199254740993}')).toThrow("too large to preserve exactly");
  });

  it("does not mutate object prototypes when dataset headers use reserved names", () => {
    const parsed = parseDatasetText('[{"__proto__":{"polluted":"x"},"constructor":"Acme"}]');
    expect(parsed.rows[0]["__proto__.polluted"]).toBe("x");
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("enforces record limits without silently truncating input", () => {
    const rows = Array.from({ length: MAX_DATASET_ROWS + 1 }, (_, i) => `${i}`);
    expect(() => parseDatasetText(["id", ...rows].join("\n"))).toThrow("10,000");
    expect(() => parseDatasetText(JSON.stringify(rows.map((id) => ({ id }))))).toThrow("10,000");
  });

  it("enforces cloud-compatible column names and cell sizes across formats", () => {
    const longField = "a".repeat(MAX_DATASET_FIELD_CHARS + 1);
    const allowedCell = "a".repeat(MAX_DATASET_CELL_CHARS);
    expect(parseDatasetText("name\n" + allowedCell).rows[0].name).toHaveLength(MAX_DATASET_CELL_CHARS);
    expect(() => parseDatasetText(longField + "\nAcme")).toThrow("240 characters");
    expect(() => parseDatasetText(JSON.stringify({ [longField]: "Acme" }))).toThrow("240 characters");
    expect(() => parseDatasetText("name\n" + allowedCell + "a")).toThrow("20,000 characters");
    expect(() => parseDatasetText(JSON.stringify({ name: allowedCell + "a" }))).toThrow("20,000 characters");
    expect(() => parseDatasetText("<record><name>" + allowedCell + "a</name></record>")).toThrow("20,000 characters");
  });

  it("bounds source display names without changing dataset field values", () => {
    const name = "a".repeat(300);
    expect(parseDatasetText("name\nAcme", " " + name + " ").name).toBe(name.slice(0, MAX_DATASET_FIELD_CHARS));
  });
});

describe("XML records", () => {
  it("reads repeated records, nested fields, attributes, CDATA and standard entities", () => {
    const parsed = parseDatasetText(`<?xml version="1.0"?><response><records>
      <record id="001"><name>Acme &amp; Co</name><address><city>Bern</city></address><note><![CDATA[A < B]]></note></record>
      <record id="002"><name>Beta</name><address><city>Basel</city></address></record>
    </records></response>`);
    expect(parsed.format).toBe("xml");
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toEqual({ "@id": "001", name: "Acme & Co", "address.city": "Bern", note: "A < B" });
  });

  it("reads single records and retains repeated fields as one record", () => {
    const parsed = parseDatasetText('<records><record><name>Acme</name><alias>A</alias><alias>B</alias></record></records>');
    expect(parsed.rows).toEqual([{ name: "Acme", alias: "A | B" }]);
    expect(parseDatasetText('<record><name>Acme</name></record>').rows).toEqual([{ name: "Acme" }]);
  });

  it("retains namespace prefixes but omits namespace declarations as data", () => {
    const parsed = parseDatasetText('<d:records xmlns:d="urn:data"><d:record id="1"><d:name>A</d:name></d:record><d:record id="2"><d:name>B</d:name></d:record></d:records>');
    expect(parsed.headers).toEqual(["@id", "d:name"]);
    expect(parsed.rows).toHaveLength(2);
  });

  it("rejects DTDs, entity declarations, unknown entities and malformed XML", () => {
    expect(() => parseDatasetText('<!DOCTYPE records SYSTEM "file:///secret"><records/>')).toThrow("DOCTYPE");
    expect(() => parseDatasetText('<!DOCTYPE x [<!ENTITY a "bad">]><x>&a;</x>')).toThrow("entity declarations");
    expect(() => parseDatasetText('<records><record>&private;</record></records>')).toThrow("Invalid XML");
    expect(() => parseDatasetText('<records><record></records>')).toThrow("Invalid XML");
    expect(() => parseDatasetText('<records/>')).toThrow("no values");
  });
});

describe("dataset files", () => {
  it("decodes UTF-8 and UTF-16 BOM exports, and detects TXT content", async () => {
    expect((await parseDatasetFile(new File(['{"id":"001"}\n{"id":"002"}'], "records.ndjson"))).rows).toHaveLength(2);
    expect((await parseDatasetFile(new File(["id\tname\n1\tOne"], "records.txt"))).format).toBe("txt");
    const text = "id\tname\n1\tCafé";
    const utf16 = new Uint8Array(2 + text.length * 2);
    utf16[0] = 255; utf16[1] = 254;
    new Uint16Array(utf16.buffer, 2).set([...text].map((char) => char.charCodeAt(0)));
    expect((await parseDatasetFile(new File([utf16], "records.tsv"))).rows[0].name).toBe("Café");
  });

  it.each(["xls", "xlsb", "xlsm", "xlm", "ods", "parquet", "sqlite", "pdf"])("gives an honest export step for .%s", async (extension) => {
    await expect(parseDatasetFile(new File(["not a supported file"], `records.${extension}`))).rejects.toThrow(/export|saved as/i);
  });

  it("checks file size before reading and rejects non-UTF text", async () => {
    const file = { name: "big.csv", size: MAX_DATASET_BYTES + 1, arrayBuffer: () => { throw new Error("must not read"); } } as unknown as File;
    await expect(parseDatasetFile(file)).rejects.toThrow("20 MB");
    await expect(parseDatasetFile(new File([new Uint8Array([0xff, 0xff])], "records.csv"))).rejects.toThrow("encoding");
  });

  it("reads XLSX worksheets, preserving rich text, dates, formatted IDs and cached formula results", async () => {
    const workbook = new ExcelJS.Workbook();
    const first = workbook.addWorksheet("Customers");
    first.addRow(["id", "name", "date", "count"]);
    first.addRow([7, { richText: [{ text: "Acme " }, { text: "AG" }] }, new Date("2026-01-02T00:00:00Z"), { formula: "1+1", result: 2 }]);
    first.getCell("A2").numFmt = "00000";
    const second = workbook.addWorksheet("Other");
    second.addRows([["id", "name"], ["008", "Beta"]]);
    const file = new File([new Uint8Array(await workbook.xlsx.writeBuffer())], "customers.xlsx");
    const parsed = await parseDatasetFile(file);
    expect(parsed.rows[0]).toEqual({ id: "00007", name: "Acme AG", date: "2026-01-02T00:00:00.000Z", count: "2" });
    expect(parsed.worksheets).toEqual(["Customers", "Other"]);
    expect(parsed.worksheet).toBe("Customers");
    expect((await parseDatasetFile(file, { worksheet: "Other" })).rows[0]).toEqual({ id: "008", name: "Beta" });
  });

  it("rejects spreadsheets with duplicate headers or formulas without saved results", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Records");
    sheet.addRows([["name", "name"], ["A", "B"]]);
    await expect(parseDatasetFile(new File([new Uint8Array(await workbook.xlsx.writeBuffer())], "duplicate.xlsx"))).rejects.toThrow("Duplicate");
    sheet.getCell("B1").value = "result";
    sheet.getCell("B2").value = { formula: "1+1" };
    await expect(parseDatasetFile(new File([new Uint8Array(await workbook.xlsx.writeBuffer())], "formula.xlsx"))).rejects.toThrow("saved result");
  });
});
