import Papa from "papaparse";
import { SaxesParser } from "saxes";
import type { Cell, CellValue } from "exceljs";

export const MAX_DATASET_BYTES = 20 * 1024 * 1024;
export const MAX_DATASET_ROWS = 10_000;
export const MAX_DATASET_FIELDS = 250;
export const MAX_DATASET_FIELD_CHARS = 240;
export const MAX_DATASET_CELL_CHARS = 20_000;
export const DATASET_ACCEPT = ".csv,.tsv,.txt,.json,.jsonl,.ndjson,.xml,.xlsx";

export type DatasetFormat = "csv" | "tsv" | "txt" | "json" | "jsonl" | "xml" | "xlsx";
export interface DatasetInput {
  name: string;
  headers: string[];
  rows: Record<string, string>[];
  format: DatasetFormat;
  worksheet?: string;
  worksheets?: string[];
}
export interface DatasetFileOptions { worksheet?: string }

const maxDepth = 32;
const maxWorkbookBytes = 100 * 1024 * 1024;
const wrapperKeys = ["records", "data", "results", "items", "rows"];
const unsupportedAdvice: Record<string, string> = {
  xls: "Legacy Excel (.xls) files need to be saved as .xlsx or exported as CSV first.",
  xlsb: "Binary Excel (.xlsb) files need to be saved as .xlsx or exported as CSV first.",
  xlsm: "Macro-enabled Excel (.xlsm) files need to be saved as .xlsx or exported as CSV first.",
  xlm: ".xlm is not XML. Export spreadsheet data as .xlsx or CSV, or use .xml for XML records.",
  ods: "OpenDocument spreadsheets (.ods) need to be exported as .xlsx or CSV first.",
  parquet: "Parquet files need to be exported as CSV, JSON or JSONL first.",
  arrow: "Arrow files need to be exported as CSV, JSON or JSONL first.",
  feather: "Feather files need to be exported as CSV, JSON or JSONL first.",
  sqlite: "Export the database table or query results as CSV or JSON first.",
  sqlite3: "Export the database table or query results as CSV or JSON first.",
  db: "Export the database table or query results as CSV or JSON first.",
  sql: "Run the query in your database tool and export its results as CSV or JSON first.",
  pdf: "Extract the table from the PDF and export it as CSV or .xlsx first.",
  doc: "Export the document's table as CSV or .xlsx first.",
  docx: "Export the document's table as CSV or .xlsx first.",
  yaml: "Convert YAML records to JSON or CSV first.",
  yml: "Convert YAML records to JSON or CSV first.",
  zip: "Unzip the archive, then choose a CSV, TSV, JSON, JSONL, XML or .xlsx file.",
};

function checkSize(size: number) {
  if (size > MAX_DATASET_BYTES) throw new Error("Each dataset can be up to 20 MB. Split larger datasets before importing.");
}

function validateHeaders(headers: string[]): string[] {
  if (!headers.length) throw new Error("No fields found. Include a header row or named fields.");
  if (headers.length > MAX_DATASET_FIELDS) throw new Error(`A dataset can have up to ${MAX_DATASET_FIELDS} fields. Remove unneeded columns first.`);
  const seen = new Set<string>();
  return headers.map((value, index) => {
    const header = value.trim();
    if (!header) throw new Error(`Column ${index + 1} has no name. Add a unique header to every column.`);
    if (header.length > MAX_DATASET_FIELD_CHARS) throw new Error(`Column ${index + 1} has a name longer than ${MAX_DATASET_FIELD_CHARS} characters. Shorten that header before importing.`);
    const key = header.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate field name “${header}”. Give every column a unique name.`);
    seen.add(key);
    return header;
  });
}

function scalarText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
    throw new Error("A number is too large to preserve exactly. Export long identifiers as text strings.");
  }
  return String(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function flattenRecord(record: Record<string, unknown>): Record<string, string> {
  const output: Record<string, string> = Object.create(null);
  const add = (key: string, value: string) => {
    if (Object.hasOwn(output, key)) throw new Error(`Fields resolve to the same name “${key}”. Rename one of those fields.`);
    output[key] = value;
    if (Object.keys(output).length > MAX_DATASET_FIELDS) throw new Error(`A record has more than ${MAX_DATASET_FIELDS} fields after expanding nested data.`);
  };
  const visit = (value: unknown, path: string, depth: number) => {
    if (depth > maxDepth) throw new Error(`Nested data can be at most ${maxDepth} levels deep.`);
    if (Array.isArray(value)) {
      if (value.every((item) => !isObject(item) && !Array.isArray(item))) add(path, value.map(scalarText).join(" | "));
      else value.forEach((item, index) => visit(item, `${path}.${index}`, depth + 1));
    } else if (isObject(value)) {
      for (const [rawKey, child] of Object.entries(value)) {
        const key = rawKey.trim();
        if (!key) throw new Error("A field has no name. Add a unique name to every field.");
        visit(child, path ? `${path}.${key}` : key, depth + 1);
      }
    } else add(path, scalarText(value));
  };
  visit(record, "", 0);
  return output;
}

function finish(rows: Record<string, string>[], name: string, format: DatasetFormat, explicitHeaders?: string[]): DatasetInput {
  if (!rows.length) throw new Error("No records found. Add at least one data row after the headers.");
  if (rows.length > MAX_DATASET_ROWS) throw new Error(`Each dataset can have up to ${MAX_DATASET_ROWS.toLocaleString("en")} records. Split this dataset into smaller files.`);
  const headers = validateHeaders(explicitHeaders ?? [...new Set(rows.flatMap((row) => Object.keys(row)))]);
  rows.forEach((row, index) => {
    for (const [field, value] of Object.entries(row)) {
      if (value.length > MAX_DATASET_CELL_CHARS) throw new Error(`Record ${index + 1}, field “${field}” exceeds ${MAX_DATASET_CELL_CHARS.toLocaleString("en")} characters. Shorten the value before importing.`);
    }
  });
  if (!rows.some((row) => Object.values(row).some((value) => value.trim() !== ""))) throw new Error("The dataset contains no values to match.");
  return { name: (name.trim() || "Untitled dataset").slice(0, MAX_DATASET_FIELD_CHARS), headers, rows, format };
}

function parseDelimited(text: string, name: string, format?: "csv" | "tsv" | "txt"): DatasetInput {
  const parsed = Papa.parse<string[]>(text, {
    header: false,
    delimiter: format === "tsv" ? "\t" : undefined,
    delimitersToGuess: [",", "\t", ";", "|"],
    dynamicTyping: false,
    skipEmptyLines: "greedy",
    preview: MAX_DATASET_ROWS + 2,
  });
  const error = parsed.errors.find((item) => item.code !== "UndetectableDelimiter");
  if (error) throw new Error(`Could not read delimited data: ${error.message}`);
  const [rawHeaders = [], ...data] = parsed.data;
  const headers = validateHeaders(rawHeaders);
  const rows = data.map((cells, index) => {
    if (cells.length !== headers.length) throw new Error(`Row ${index + 2} has ${cells.length} values; the header has ${headers.length}. Check delimiters and quoted fields.`);
    return Object.fromEntries(headers.map((header, column) => [header, cells[column]]));
  });
  return finish(rows, name, format ?? (parsed.meta.delimiter === "\t" ? "tsv" : "csv"), headers);
}

function jsonRows(value: unknown, depth = 0): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isObject(value)) throw new Error("JSON must contain an object, an array of objects, or a records/data/results/items array.");
  if (depth > maxDepth) throw new Error("The JSON wrapper is too deeply nested.");
  const arrays = wrapperKeys.filter((key) => Array.isArray(value[key]));
  if (arrays.length > 1) throw new Error("This JSON contains several record arrays. Keep the one dataset you want to import.");
  if (arrays.length === 1) return value[arrays[0]] as unknown[];
  const nested = wrapperKeys.filter((key) => isObject(value[key]) && wrapperKeys.some((nestedKey) => Array.isArray((value[key] as Record<string, unknown>)[nestedKey])));
  if (nested.length === 1) return jsonRows(value[nested[0]], depth + 1);
  return [value];
}

function fromJsonValues(values: unknown[], name: string, format: "json" | "jsonl"): DatasetInput {
  if (values.length > MAX_DATASET_ROWS) throw new Error(`Each dataset can have up to ${MAX_DATASET_ROWS.toLocaleString("en")} records. Split this dataset into smaller files.`);
  const rows = values.map((value, index) => {
    if (!isObject(value)) throw new Error(`Record ${index + 1} is not a JSON object. Each record needs named fields.`);
    const row = flattenRecord(value);
    if (!Object.keys(row).length) throw new Error(`Record ${index + 1} has no fields.`);
    return row;
  });
  return finish(rows, name, format);
}

function parseJsonLines(text: string, name: string): DatasetInput {
  const values: unknown[] = [];
  text.split(/\r\n|\n|\r/).forEach((line, index) => {
    if (!line.trim()) return;
    if (values.length >= MAX_DATASET_ROWS) throw new Error(`Each dataset can have up to ${MAX_DATASET_ROWS.toLocaleString("en")} records.`);
    try { values.push(JSON.parse(line)); }
    catch { throw new Error(`Line ${index + 1} is not valid JSON. JSONL needs one complete JSON object per line.`); }
  });
  return fromJsonValues(values, name, "jsonl");
}

interface XmlNode { name: string; attributes: Record<string, string>; children: XmlNode[]; text: string }

function xmlValue(node: XmlNode): unknown {
  if (!node.children.length && !Object.keys(node.attributes).length) return node.text.trim();
  const output: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(node.attributes)) output[`@${key}`] = value;
  const groups = new Map<string, XmlNode[]>();
  for (const child of node.children) {
    const group = groups.get(child.name);
    if (group) group.push(child);
    else groups.set(child.name, [child]);
  }
  for (const [key, children] of groups) output[key] = children.length === 1 ? xmlValue(children[0]) : children.map(xmlValue);
  if (node.text.trim()) output["#text"] = node.text.trim();
  return output;
}

function xmlRecords(root: XmlNode): XmlNode[] {
  const localName = root.name.split(":").at(-1)!.toLowerCase();
  if (["record", "row", "item", "entry", "entity", "product", "contact", "company", "customer"].includes(localName)) return [root];
  const groups = new Map<string, XmlNode[]>();
  for (const child of root.children) {
    const group = groups.get(child.name);
    if (group) group.push(child);
    else groups.set(child.name, [child]);
  }
  const repeated = [...groups.values()].filter((group) => group.length > 1);
  if (repeated.length === 1) return repeated[0];
  if (repeated.length > 1) throw new Error("XML contains several repeated record groups. Export one record list per dataset.");
  const containers = [...wrapperKeys, "dataset", "root", "response", "catalog", "feed"];
  if (root.children.length === 1 && containers.includes(localName)) {
    const child = root.children[0];
    if (child.children.length) return xmlRecords(child);
    return [child];
  }
  return [root];
}

function parseXml(text: string, name: string): DatasetInput {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) throw new Error("XML with DOCTYPE or entity declarations is not supported. Export plain XML records.");
  const parser = new SaxesParser({ xmlns: false });
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  let nodeCount = 0;
  parser.on("doctype", () => { throw new Error("XML DOCTYPE declarations are not supported."); });
  parser.on("opentag", (tag) => {
    if (stack.length >= maxDepth) throw new Error(`XML can be at most ${maxDepth} levels deep.`);
    if (++nodeCount > 500_000) throw new Error("This XML contains too many elements. Split it into smaller datasets.");
    const node: XmlNode = { name: tag.name, attributes: Object.fromEntries(Object.entries(tag.attributes).filter(([key]) => key !== "xmlns" && !key.startsWith("xmlns:"))), children: [], text: "" };
    if (stack.length) stack[stack.length - 1].children.push(node);
    else root = node;
    stack.push(node);
  });
  parser.on("text", (value) => { if (stack.length) stack[stack.length - 1].text += value; });
  parser.on("cdata", (value) => { if (stack.length) stack[stack.length - 1].text += value; });
  parser.on("closetag", () => { stack.pop(); });
  parser.on("error", (error) => { throw new Error(`Invalid XML: ${error.message}`); });
  parser.write(text).close();
  if (!root) throw new Error("No XML records found.");
  const nodes = xmlRecords(root);
  if (nodes.length > MAX_DATASET_ROWS) throw new Error(`Each dataset can have up to ${MAX_DATASET_ROWS.toLocaleString("en")} records.`);
  const rows = nodes.map((node) => {
    const value = xmlValue(node);
    return flattenRecord(isObject(value) ? value : { value });
  });
  return finish(rows, name, "xml");
}

export function parseDatasetText(text: string, name = "Pasted data", format?: Exclude<DatasetFormat, "xlsx">): DatasetInput {
  checkSize(new TextEncoder().encode(text).byteLength);
  const cleaned = text.replace(/^\uFEFF/, "");
  const detected = cleaned.trimStart();
  if (!cleaned.trim()) throw new Error("Add some records first. Paste a table, CSV, JSON, JSONL or XML.");
  if (cleaned.includes("\0")) throw new Error("This looks like binary or unsupported text data. Export it as UTF-8 text or .xlsx.");
  if (format === "xml" || (!format && detected.startsWith("<"))) return parseXml(cleaned.trim(), name);
  if (format === "jsonl") return parseJsonLines(cleaned, name);
  if (format === "json" || (!format && /^[\[{]/.test(detected))) {
    let value: unknown;
    try { value = JSON.parse(cleaned); }
    catch {
      if (!format && detected.startsWith("{") && cleaned.split(/\r\n|\n|\r/).filter((line) => line.trim()).length > 1) return parseJsonLines(cleaned, name);
      throw new Error("This is not valid JSON. Check commas, quotes and brackets, or use JSONL for one object per line.");
    }
    return fromJsonValues(jsonRows(value), name, "json");
  }
  return parseDelimited(cleaned, name, format);
}

// Check ZIP metadata before ExcelJS expands an XLSX workbook in browser memory.
function checkWorkbookArchive(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  let end = -1;
  for (let offset = buffer.byteLength - 22; offset >= Math.max(0, buffer.byteLength - 65557); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) { end = offset; break; }
  }
  if (end < 0) throw new Error("This is not a readable .xlsx workbook. Save it again as .xlsx or export CSV.");
  const entries = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  if (entries === 0xffff || offset === 0xffffffff) throw new Error("This workbook uses ZIP64. Export the required worksheet as CSV.");
  let expanded = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > buffer.byteLength || view.getUint32(offset, true) !== 0x02014b50) throw new Error("The workbook archive is damaged. Save it again as .xlsx.");
    if (view.getUint16(offset + 8, true) & 1) throw new Error("Password-protected workbooks are not supported. Export an unprotected CSV or .xlsx file.");
    expanded += view.getUint32(offset + 24, true);
    if (expanded > maxWorkbookBytes) throw new Error("This workbook expands beyond 100 MB. Export only the required worksheet as CSV.");
    offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
}

function cellText(cell: Cell): string {
  const convert = (value: CellValue): string => {
    if (value instanceof Date) return value.toISOString();
    if (value && typeof value === "object") {
      if ("error" in value) throw new Error(`Cell ${cell.address} contains ${value.error}. Correct spreadsheet errors before importing.`);
      if ("richText" in value) return value.richText.map((part) => part.text).join("");
      if ("text" in value) return value.text;
      if ("formula" in value || "sharedFormula" in value) {
        if (value.result === undefined) throw new Error(`Cell ${cell.address} has a formula without a saved result. Recalculate and save the workbook, or export CSV.`);
        return convert(value.result);
      }
    }
    if (typeof value === "number" && /^0+$/.test(cell.numFmt)) return scalarText(value).padStart(cell.numFmt.length, "0");
    return scalarText(value);
  };
  return convert(cell.value);
}

async function parseWorkbook(file: File, options: DatasetFileOptions): Promise<DatasetInput> {
  const buffer = await file.arrayBuffer();
  checkWorkbookArchive(buffer);
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(buffer); }
  catch { throw new Error("Could not read this .xlsx workbook. Check that it is unprotected, or export the worksheet as CSV."); }
  const worksheets = workbook.worksheets.map((sheet) => sheet.name);
  const sheet = options.worksheet ? workbook.worksheets.find((item) => item.name === options.worksheet) : workbook.worksheets.find((item) => item.actualRowCount > 1) ?? workbook.worksheets[0];
  if (!sheet) throw new Error(options.worksheet ? `Worksheet “${options.worksheet}” was not found.` : "This workbook has no worksheets.");
  if (sheet.actualRowCount > MAX_DATASET_ROWS + 1) throw new Error(`Each dataset can have up to ${MAX_DATASET_ROWS.toLocaleString("en")} records. Split this worksheet before importing.`);
  if (sheet.actualColumnCount > MAX_DATASET_FIELDS) throw new Error(`A worksheet can have up to ${MAX_DATASET_FIELDS} fields. Remove unneeded columns first.`);
  let headers: string[] = [];
  const rows: Record<string, string>[] = [];
  sheet.eachRow((row) => {
    if (!headers.length) {
      headers = validateHeaders(Array.from({ length: row.cellCount }, (_, index) => cellText(row.getCell(index + 1))));
      return;
    }
    for (let index = headers.length + 1; index <= row.cellCount; index += 1) {
      if (cellText(row.getCell(index)).trim()) throw new Error(`Row ${row.number} has data in a column without a header.`);
    }
    const cells = headers.map((_, index) => cellText(row.getCell(index + 1)));
    if (cells.every((value) => !value.trim())) return;
    rows.push(Object.fromEntries(headers.map((header, index) => [header, cells[index]])));
  });
  return { ...finish(rows, file.name, "xlsx", headers), worksheet: sheet.name, worksheets };
}

export async function parseDatasetFile(file: File, options: DatasetFileOptions = {}): Promise<DatasetInput> {
  checkSize(file.size);
  const extension = file.name.toLowerCase().split(".").at(-1) ?? "";
  if (unsupportedAdvice[extension]) throw new Error(unsupportedAdvice[extension]);
  if (extension === "xlsx") return parseWorkbook(file, options);
  const formats: Record<string, Exclude<DatasetFormat, "xlsx"> | undefined> = { csv: "csv", tsv: "tsv", txt: undefined, json: "json", jsonl: "jsonl", ndjson: "jsonl", xml: "xml" };
  if (!Object.hasOwn(formats, extension)) throw new Error("Choose CSV, TSV, TXT, JSON, JSONL, NDJSON, XML or .xlsx. Export other formats to one of these first.");
  const bytes = await file.arrayBuffer();
  const prefix = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
  const encoding = prefix[0] === 0xff && prefix[1] === 0xfe ? "utf-16le" : prefix[0] === 0xfe && prefix[1] === 0xff ? "utf-16be" : "utf-8";
  let text: string;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { throw new Error("This file uses an unsupported text encoding. Save it as UTF-8 and try again."); }
  const parsed = parseDatasetText(text, file.name, formats[extension]);
  return extension === "txt" && ["csv", "tsv"].includes(parsed.format) ? { ...parsed, format: "txt" } : parsed;
}
