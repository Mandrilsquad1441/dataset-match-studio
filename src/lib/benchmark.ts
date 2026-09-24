import Papa from "papaparse";
import type { LocalDataset } from "./dataset-comparison";

export type BenchmarkRelation = "match" | "no-match" | "review";
export interface BenchmarkLabel { rowIndex: number; relation: BenchmarkRelation; targetIndices: number[]; scenario?: string }
export interface BenchmarkAnswerKey { name: string; sha256: string; labels: BenchmarkLabel[] }
export interface ScorableDecision { rowIndex: number; relation: BenchmarkRelation; targetIndex: number | null; latencyMs: number | null; cached: boolean; error?: string | null }

/** A reproducible sample; every selected model receives these same source row indices. */
export function benchmarkSample(total: number, size: number, eligible?: readonly number[], seed = 20260923): number[] {
  const pool = eligible ? [...new Set(eligible)].filter((index) => Number.isInteger(index) && index >= 0 && index < total).sort((a, b) => a - b) : Array.from({ length: total }, (_, index) => index);
  let state = seed >>> 0;
  for (let index = pool.length - 1; index > 0; index--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const other = state % (index + 1);
    [pool[index], pool[other]] = [pool[other], pool[index]];
  }
  return pool.slice(0, Math.max(0, Math.min(50, size))).sort((a, b) => a - b);
}

const key = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const present = (value: unknown) => value !== undefined && value !== null && String(value).trim() !== "";
function rowLookup(dataset: LocalDataset): Map<string, Set<number>> {
  const index = new Map<string, Set<number>>();
  const fields = Object.keys(dataset.rows[0] ?? {}).filter((field) => /^(sourcekey|rowid|recordid|referenceid|incomingid|id|key|recordkey|referencekey)$/.test(key(field)) || field === dataset.idField);
  dataset.rows.forEach((row, rowIndex) => {
    for (const field of fields) if (present(row[field])) {
      const value = String(row[field]).trim();
      const matches = index.get(value) ?? new Set<number>();
      matches.add(rowIndex); index.set(value, matches);
    }
  });
  return index;
}
function parseIndex(value: unknown, total: number, oneBased: boolean, context: string): number {
  const raw = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  const index = raw - (oneBased ? 1 : 0);
  if (!Number.isInteger(index) || index < 0 || index >= total) throw new Error(`${context} is outside the imported dataset. ${oneBased ? "Row numbers begin at 1." : "Row indices begin at 0."}`);
  return index;
}
function resolveKey(value: unknown, lookup: Map<string, Set<number>>, context: string): number {
  const matches = lookup.get(String(value).trim());
  if (!matches?.size) throw new Error(`${context}: record key “${String(value).slice(0, 60)}” was not found. Use source_key, row_id, id, or an explicit row index.`);
  if (matches.size !== 1) throw new Error(`${context}: the record key is duplicated. Use an explicit row index.`);
  return [...matches][0];
}
function list(value: unknown): unknown[] {
  if (!present(value)) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim().startsWith("[")) {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error("Expected a list of reference records.");
    return parsed;
  }
  return typeof value === "string" ? value.split("|").map((part) => part.trim()).filter(Boolean) : [value];
}

/** CSV uses dataset2_row / dataset1_row (1-based); explicit *RowIndex fields are 0-based. */
export async function readBenchmarkAnswerKey(file: File, dataset1: LocalDataset, dataset2: LocalDataset): Promise<BenchmarkAnswerKey> {
  if (file.size > 20 * 1024 * 1024) throw new Error("Answer keys can be up to 20 MB.");
  const text = (await file.text()).replace(/^\uFEFF/, "");
  let rows: unknown[];
  if (/^\s*[\[{]/.test(text)) {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) rows = parsed;
    else if (parsed && typeof parsed === "object") {
      const object = parsed as Record<string, unknown>;
      const values = [object.records, object.rows, object.labels, object.data].filter(Array.isArray);
      if (values.length !== 1) throw new Error("The answer key must contain one records, rows, labels, or data array.");
      rows = values[0];
    } else throw new Error("The answer key must contain an array of labels.");
  } else {
    const parsed = Papa.parse<Record<string, unknown>>(text, { header: true, skipEmptyLines: "greedy" });
    if (parsed.errors.length) throw new Error("Could not read the answer key: " + parsed.errors[0].message);
    const fields = (parsed.meta.fields ?? []).map(key);
    if (new Set(fields).size !== fields.length) throw new Error("The answer key has duplicate column names.");
    rows = parsed.data;
  }
  if (!rows.length || rows.length > dataset2.rows.length) throw new Error("Provide between 1 and " + dataset2.rows.length.toLocaleString() + " labels, one per Dataset 2 record.");
  const sourceLookup = rowLookup(dataset2);
  const targetLookup = rowLookup(dataset1);
  const seen = new Set<number>();
  const labels = rows.map((raw, position): BenchmarkLabel => {
    const context = `Answer key entry ${position + 1}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(context + " must be an object.");
    const record = new Map(Object.entries(raw).map(([field, value]) => [key(field), value]));
    const get = (...fields: string[]) => fields.map((field) => record.get(field)).find(present);
    const sourceIndex = get("incomingrowindex", "dataset2rowindex", "rowindex");
    const sourceNumber = get("dataset2row", "incomingrow", "sourcerow");
    const sourceKey = get("incomingkey", "incomingrowid", "sourcekey", "dataset2key");
    const rowIndex = present(sourceIndex) ? parseIndex(sourceIndex, dataset2.rows.length, false, context) : present(sourceNumber) ? parseIndex(sourceNumber, dataset2.rows.length, true, context) : present(sourceKey) ? resolveKey(sourceKey, sourceLookup, context) : (() => { throw new Error(context + " needs dataset2_row or incomingRowIndex."); })();
    if (present(sourceKey) && resolveKey(sourceKey, sourceLookup, context) !== rowIndex) throw new Error(context + " has a row index and key that identify different records.");
    if (seen.has(rowIndex)) throw new Error(context + " repeats Dataset 2 row " + (rowIndex + 1) + ".");
    seen.add(rowIndex);
    const relationText = String(get("expectedrelation", "expectedoutcome", "expected", "relation", "outcome") ?? "").toLowerCase().trim().replace(/[\s_]/g, "-");
    const relation: BenchmarkRelation = ["match", "equivalent", "same", "strong"].includes(relationText) ? "match" : ["no-match", "nonmatch", "unmatched", "different", "no-match-found"].includes(relationText) ? "no-match" : ["review", "ambiguous", "uncertain", "related", "low"].includes(relationText) ? "review" : (() => { throw new Error(context + " needs an expected value of match, no-match, or review."); })();
    const targets = [
      ...list(get("acceptablereferenceindices", "targetindices", "dataset1rowindex", "targetrowindex", "targetindex")).map((value) => parseIndex(value, dataset1.rows.length, false, context)),
      ...list(get("dataset1row", "targetrow", "referencerow")).map((value) => parseIndex(value, dataset1.rows.length, true, context)),
      ...list(get("acceptablereferencekeys", "acceptablereferenceids", "expectedreferencekey", "targetkey", "referencekey", "dataset1key")).map((value) => resolveKey(value, targetLookup, context)),
    ];
    if (relation === "match" && !targets.length) throw new Error(context + " is a match but has no Dataset 1 target.");
    if (relation === "no-match" && targets.length) throw new Error(context + " is no-match but includes a Dataset 1 target.");
    return { rowIndex, relation, targetIndices: [...new Set(targets)], ...(present(get("scenario")) ? { scenario: String(get("scenario")) } : {}) };
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return { name: file.name, sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""), labels };
}

export function isCorrectDecision(decision: ScorableDecision | undefined, label: BenchmarkLabel): boolean {
  return Boolean(decision && !decision.error && decision.relation === label.relation && (label.relation !== "match" || (decision.targetIndex !== null && label.targetIndices.includes(decision.targetIndex))));
}
function percentile(values: number[], ratio: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(ratio * sorted.length) - 1)];
}
export function benchmarkMetrics(rowIndices: readonly number[], decisions: readonly ScorableDecision[], labels: readonly BenchmarkLabel[] = []) {
  const byRow = new Map(decisions.map((decision) => [decision.rowIndex, decision]));
  const sample = new Set(rowIndices);
  const labeled = labels.filter((label) => sample.has(label.rowIndex));
  const predictedMatches = labeled.filter((label) => { const decision = byRow.get(label.rowIndex); return decision && !decision.error && decision.relation === "match"; }).length;
  const actualMatches = labeled.filter((label) => label.relation === "match").length;
  const correctMatches = labeled.filter((label) => label.relation === "match" && isCorrectDecision(byRow.get(label.rowIndex), label)).length;
  const measured = decisions.filter((decision) => sample.has(decision.rowIndex) && !decision.cached && !decision.error && decision.latencyMs !== null && Number.isFinite(decision.latencyMs)).map((decision) => decision.latencyMs!);
  return {
    sampleSize: rowIndices.length, labeledRows: labeled.length, labelCoverage: rowIndices.length ? labeled.length / rowIndices.length : 0,
    correctRows: labeled.filter((label) => isCorrectDecision(byRow.get(label.rowIndex), label)).length,
    accuracy: labeled.length ? labeled.filter((label) => isCorrectDecision(byRow.get(label.rowIndex), label)).length / labeled.length : null,
    precision: predictedMatches ? correctMatches / predictedMatches : null, recall: actualMatches ? correctMatches / actualMatches : null,
    predictedMatches, actualMatches, correctMatches,
    failures: rowIndices.filter((index) => !byRow.has(index) || Boolean(byRow.get(index)?.error)).length,
    cachedRows: decisions.filter((decision) => sample.has(decision.rowIndex) && decision.cached).length,
    skippedRows: decisions.filter((decision) => sample.has(decision.rowIndex) && !decision.error && !decision.cached && decision.latencyMs === null).length,
    latencyRows: measured.length, p50Ms: percentile(measured, 0.5), p95Ms: percentile(measured, 0.95),
  };
}
