import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import Papa from "papaparse";
import { parseDatasetFile } from "../../src/lib/dataset-input";
import { prepareLocalComparison, type LocalDecision } from "../../src/lib/dataset-comparison";

const workspace = process.cwd();
const stressRoot = resolve(workspace, "fixtures/stress");
const outputRoot = join(stressRoot, "results");
const lanes = ["strong", "review", "low", "no-match"] as const;
const labels = { strong: "Match", review: "Review", low: "Low confidence", "no-match": "No match" };
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const rounded = (value: number) => Math.round(value * 1000) / 1000;
const portable = (path: string) => relative(workspace, path).replaceAll("\\", "/");
const ratio = (numerator: number, denominator: number) => ({ numerator, denominator, fraction: denominator ? numerator / denominator : null });
const formatPercent = (value: { fraction: number | null }) => value.fraction === null ? "n/a" : (value.fraction * 100).toFixed(2) + "%";

type Mapping = { nameField: string; idField?: string; keyField: string };
type Source = Mapping & { path: string; worksheet?: string; expectedRows?: number; expectedColumns?: number; expectedSha?: string };
type Manifest = { caseId: string; path: string; dataset1: Source; dataset2: Source; truthPath: string; raw: Record<string, any> };
type Truth = { incomingKey: string; expectedRelation: "match" | "no-match" | "ambiguous"; acceptableReferenceKeys: string[]; scenario: string; [key: string]: unknown };
type Actual = LocalDecision & { incomingKey: string; incomingIdentifier: string; targetKey: string | null; targetIdentifier: string | null };
type Scored = { actual: Actual; truth: Truth; acceptableTarget: boolean; strictCorrectStrong: boolean; correctSuggestion: boolean; issues: string[] };

const args = process.argv.slice(2);
const selectedCases: string[] = [];
const explicitManifests: string[] = [];
const browserPaths = new Map<string, string>();
let compareBrowserOnly = false;
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--case") selectedCases.push(args[++index] ?? "");
  else if (arg === "--manifest") explicitManifests.push(args[++index] ?? "");
  else if (arg === "--compare-browser-only") compareBrowserOnly = true;
  else if (arg === "--browser-csv") {
    const value = args[++index] ?? "";
    const separator = value.indexOf("=");
    if (separator < 1) throw new Error("Use --browser-csv case1=path/to/browser-export.csv");
    browserPaths.set(value.slice(0, separator), resolve(workspace, value.slice(separator + 1)));
  } else throw new Error(`Unknown option: ${arg}`);
}

function resolveFixturePath(base: string, file: string): string {
  if (!file) throw new Error("Manifest is missing a fixture filename.");
  return isAbsolute(file) ? file : resolve(base, file);
}

async function loadManifest(path: string): Promise<Manifest> {
  const raw = JSON.parse(await readFile(path, "utf8"));
  const base = dirname(path);
  const source = (key: "dataset1" | "dataset2"): Source => {
    const file = raw.files?.[key] ?? raw[key];
    const mapping = { ...file, ...(raw.mappings?.[key] ?? {}), ...(raw.recommendedMapping?.[key] ?? {}) };
    return {
      path: resolveFixturePath(base, file.file ?? file.path),
      nameField: mapping.nameField,
      idField: mapping.idField || undefined,
      keyField: mapping.recordKeyField ?? mapping.keyField ?? "row_id",
      worksheet: file.worksheet,
      expectedRows: file.rows ?? file.count,
      expectedColumns: file.columns,
      expectedSha: file.sha256,
    };
  };
  return {
    path, raw, caseId: raw.caseId ?? basename(base), dataset1: source("dataset1"), dataset2: source("dataset2"),
    truthPath: resolveFixturePath(base, raw.files?.groundTruth?.file ?? raw.truthFile ?? raw.groundTruth?.file ?? "truth.json"),
  };
}

async function parseSource(source: Source) {
  const readStart = performance.now();
  const bytes = await readFile(source.path);
  const readMs = performance.now() - readStart;
  const file = new File([bytes], basename(source.path));
  const parseStart = performance.now();
  const data = await parseDatasetFile(file, { worksheet: source.worksheet });
  const parseMs = performance.now() - parseStart;
  if (source.expectedRows !== undefined && data.rows.length !== source.expectedRows) throw new Error(`${source.path}: parsed ${data.rows.length} rows, manifest declares ${source.expectedRows}.`);
  if (source.expectedColumns !== undefined && data.headers.length !== source.expectedColumns) throw new Error(`${source.path}: parsed ${data.headers.length} columns, manifest declares ${source.expectedColumns}.`);
  const actualSha = sha(bytes);
  if (source.expectedSha && source.expectedSha !== actualSha) throw new Error(`${source.path}: SHA-256 does not match the manifest.`);
  for (const column of [source.nameField, source.idField, source.keyField].filter(Boolean) as string[]) {
    if (!data.headers.includes(column)) throw new Error(`${source.path}: missing mapped field ${column}; got ${data.headers.join(", ")}`);
  }
  const keys = data.rows.map((row) => row[source.keyField]);
  if (keys.some((key) => !key) || new Set(keys).size !== keys.length) throw new Error(`${source.path}: evaluator requires unique nonempty source keys.`);
  return { data, bytes: bytes.byteLength, sha256: actualSha, readMs: rounded(readMs), parseMs: rounded(parseMs) };
}

function spreadsheetText(value: unknown) {
  const text = String(value ?? "");
  return /^[=+@-]/.test(text.trimStart()) || /^[\t\r\n]/.test(text) ? "'" + text : text;
}
function expectedBrowserRow(actual: Actual): Record<string, string> {
  return {
    "Dataset 2 row": spreadsheetText(actual.rowIndex + 1),
    "Dataset 2 record": spreadsheetText(actual.name),
    "Dataset 2 identifier": spreadsheetText(actual.incomingIdentifier),
    "Dataset 1 row or record ID": spreadsheetText(actual.targetIndex === null ? "" : actual.targetIndex + 1),
    "Dataset 1 record": spreadsheetText(actual.targetName ?? ""),
    "Dataset 1 identifier": spreadsheetText(actual.targetIdentifier ?? ""),
    "Outcome": labels[actual.lane],
    "Confidence": "",
    "Explanation": spreadsheetText(actual.explanation),
  };
}

async function compareBrowser(caseId: string, actualRows: Actual[]) {
  const path = browserPaths.get(caseId) ?? join(outputRoot, `${caseId}-browser.csv`);
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "not_available", path: portable(path) }; throw error; }
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^\uFEFF/, ""), { header: true, skipEmptyLines: true, dynamicTyping: false });
  if (parsed.errors.length) throw new Error(`Browser export ${path} cannot be parsed: ${parsed.errors[0].message}`);
  const headers = Object.keys(expectedBrowserRow(actualRows[0]));
  const missingHeaders = headers.filter((header) => !(parsed.meta.fields ?? []).includes(header));
  const duplicates: number[] = [];
  const byIndex = new Map<number, Record<string, string>>();
  for (const row of parsed.data) {
    const index = Number(row["Dataset 2 row"]) - 1;
    if (byIndex.has(index)) duplicates.push(index + 1);
    byIndex.set(index, row);
  }
  const mismatches: unknown[] = [];
  let mismatchedRows = 0;
  let missingRows = 0;
  for (const actual of actualRows) {
    const browser = byIndex.get(actual.rowIndex);
    if (!browser) { missingRows++; if (mismatches.length < 30) mismatches.push({ row: actual.rowIndex + 1, issue: "missing_browser_row" }); continue; }
    const expected = expectedBrowserRow(actual);
    const different = Object.entries(expected).flatMap(([field, value]) => browser[field] === value ? [] : [{ field, expected: value, actual: browser[field] ?? null }]);
    if (different.length) { mismatchedRows++; if (mismatches.length < 30) mismatches.push({ row: actual.rowIndex + 1, incomingKey: actual.incomingKey, differences: different }); }
  }
  const unexpectedRows = [...byIndex.keys()].filter((index) => !Number.isInteger(index) || index < 0 || index >= actualRows.length).length;
  const result = {
    status: parsed.data.length === actualRows.length && !missingHeaders.length && !duplicates.length && !mismatchedRows && !missingRows && !unexpectedRows ? "identical" : "mismatch",
    path: portable(path), sha256: sha(text), expectedRows: actualRows.length, browserRows: parsed.data.length,
    mismatchedRows, missingRows, unexpectedRows, duplicateRowNumbers: duplicates, missingHeaders, samples: mismatches,
    comparison: "Every exported row, target row/name, source name, selected identifiers, outcome, blank local confidence and explanation.",
  };
  await writeFile(join(outputRoot, `${caseId}-browser-comparison.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ caseId, browserComparison: result.status, expectedRows: result.expectedRows, browserRows: result.browserRows, mismatchedRows, missingRows }));
  return result;
}

function metrics(rows: Scored[]) {
  const laneCounts = Object.fromEntries(lanes.map((lane) => [lane, rows.filter((row) => row.actual.lane === lane).length]));
  const matches = rows.filter((row) => row.truth.expectedRelation === "match");
  const strong = rows.filter((row) => row.actual.lane === "strong");
  const correctStrong = strong.filter((row) => row.strictCorrectStrong).length;
  const noMatches = rows.filter((row) => row.actual.lane === "no-match");
  return {
    rows: rows.length, laneCounts,
    truthCounts: Object.fromEntries(["match", "no-match", "ambiguous"].map((relation) => [relation, rows.filter((row) => row.truth.expectedRelation === relation).length])),
    strictStrongPrecision: ratio(correctStrong, strong.length),
    correctStrongRecall: ratio(correctStrong, matches.length),
    correctSuggestedTargetRecall: ratio(matches.filter((row) => row.correctSuggestion).length, matches.length),
    strongAcceptableTargetRate: ratio(strong.filter((row) => row.acceptableTarget).length, strong.length),
    noMatchLanePrecision: ratio(noMatches.filter((row) => row.truth.expectedRelation === "no-match").length, noMatches.length),
    noMatchLaneRecall: ratio(noMatches.filter((row) => row.truth.expectedRelation === "no-match").length, rows.filter((row) => row.truth.expectedRelation === "no-match").length),
    falseStrongCount: strong.length - correctStrong,
    wrongStrongTargetCount: strong.filter((row) => !row.acceptableTarget).length,
    ambiguousStrongCount: strong.filter((row) => row.truth.expectedRelation === "ambiguous").length,
    knownMatchesDeclaredNoMatch: matches.filter((row) => row.actual.lane === "no-match").length,
    knownMatchesWithoutCorrectSuggestion: matches.filter((row) => !row.correctSuggestion).length,
    ambiguousDeclaredNoMatch: noMatches.filter((row) => row.truth.expectedRelation === "ambiguous").length,
    rowsWithoutSuggestedTarget: rows.filter((row) => row.actual.targetKey === null).length,
  };
}

function normalizeTruth(raw: Record<string, any>): Truth[] {
  const rows = raw.records ?? raw.rows;
  if (!Array.isArray(rows)) throw new Error("Ground truth must contain rows or records.");
  return rows.map((row) => ({
    ...row,
    incomingKey: String(row.incomingKey ?? row.incomingRowId),
    acceptableReferenceKeys: (row.acceptableReferenceKeys ?? row.acceptableReferenceIds ?? []).map(String),
    scenario: String(row.scenario ?? "unspecified"),
  }));
}

function memorySnapshot() {
  const value = process.memoryUsage();
  return { heapUsedMiB: rounded(value.heapUsed / 1024 ** 2), rssMiB: rounded(value.rss / 1024 ** 2) };
}

async function evaluate(manifest: Manifest) {
  console.log(JSON.stringify({ caseId: manifest.caseId, phase: "parsing_sources" }));
  const memory: Record<string, unknown> = { start: memorySnapshot() };
  // Ground truth is intentionally loaded only after the real parser and
  // matching engine have produced every decision.
  const first = await parseSource(manifest.dataset1);
  const second = await parseSource(manifest.dataset2);
  memory.afterParsing = memorySnapshot();
  const indexStart = performance.now();
  const comparison = prepareLocalComparison({ ...first.data, ...manifest.dataset1 }, { ...second.data, ...manifest.dataset2 });
  const indexMs = performance.now() - indexStart;
  memory.afterIndex = memorySnapshot();
  const compareStart = performance.now();
  const decisions: LocalDecision[] = [];
  for (let index = 0; index < comparison.total; index++) decisions.push(comparison.compareRow(index));
  const comparisonMs = performance.now() - compareStart;
  memory.afterComparison = memorySnapshot();
  const actual: Actual[] = decisions.map((decision) => ({
    ...decision,
    incomingKey: second.data.rows[decision.rowIndex][manifest.dataset2.keyField],
    incomingIdentifier: manifest.dataset2.idField ? second.data.rows[decision.rowIndex][manifest.dataset2.idField] : "",
    targetKey: decision.targetIndex === null ? null : first.data.rows[decision.targetIndex][manifest.dataset1.keyField],
    targetIdentifier: decision.targetIndex === null || !manifest.dataset1.idField ? null : first.data.rows[decision.targetIndex][manifest.dataset1.idField],
  }));
  const actualPath = join(outputRoot, `${manifest.caseId}.actual.json`);
  await writeFile(actualPath, JSON.stringify({ caseId: manifest.caseId, rows: actual }, null, 2));
  const browserRows = actual.map(expectedBrowserRow);
  const columns = Object.keys(browserRows[0]);
  // Values already receive spreadsheet formula protection in expectedBrowserRow.
  await writeFile(join(outputRoot, `${manifest.caseId}.actual.csv`), "\uFEFF" + [columns, ...browserRows.map((row) => columns.map((column) => row[column]))].map((row) => row.map((value) => '"' + value.replaceAll('"', '""') + '"').join(",")).join("\r\n"));

  const truthBytes = await readFile(manifest.truthPath);
  const declaredTruthSha = manifest.raw.files?.groundTruth?.sha256;
  if (declaredTruthSha && declaredTruthSha !== sha(truthBytes)) throw new Error(`${manifest.truthPath}: SHA-256 does not match the manifest.`);
  const truth = normalizeTruth(JSON.parse(truthBytes.toString("utf8")));
  const byKey = new Map(truth.map((row) => [row.incomingKey, row]));
  const referenceKeys = new Set(first.data.rows.map((row) => row[manifest.dataset1.keyField]));
  if (truth.length !== actual.length || byKey.size !== truth.length) throw new Error("Ground truth must contain exactly one entry for every incoming row.");
  for (const item of truth) {
    if (!["match", "no-match", "ambiguous"].includes(item.expectedRelation)) throw new Error(`Unknown truth relation for ${item.incomingKey}`);
    if (item.expectedRelation === "match" && !item.acceptableReferenceKeys.length) throw new Error(`Positive truth row ${item.incomingKey} has no acceptable reference.`);
    if (item.acceptableReferenceKeys.some((key) => !referenceKeys.has(key))) throw new Error(`Truth row ${item.incomingKey} references a missing target key.`);
  }
  const scored: Scored[] = actual.map((decision) => {
    const expected = byKey.get(decision.incomingKey);
    if (!expected) throw new Error(`Missing truth for ${decision.incomingKey}`);
    if (expected.incomingRowIndex !== undefined && expected.incomingRowIndex !== decision.rowIndex) throw new Error(`Truth row index disagrees with parsed row for ${decision.incomingKey}`);
    const acceptableTarget = decision.targetKey !== null && expected.acceptableReferenceKeys.includes(decision.targetKey);
    const strictCorrectStrong = decision.lane === "strong" && expected.expectedRelation === "match" && acceptableTarget;
    const correctSuggestion = expected.expectedRelation === "match" && acceptableTarget && decision.lane !== "no-match";
    const issues: string[] = [];
    if (decision.lane === "strong" && !strictCorrectStrong) issues.push(expected.expectedRelation === "ambiguous" ? "ambiguous_auto_match" : "false_auto_match");
    if (expected.expectedRelation === "match" && decision.lane === "no-match") issues.push("known_match_declared_no_match");
    if (expected.expectedRelation === "match" && !correctSuggestion) issues.push("correct_target_not_suggested");
    if (expected.expectedRelation === "ambiguous" && decision.lane === "no-match") issues.push("ambiguity_declared_no_match");
    return { actual: decision, truth: expected, acceptableTarget, strictCorrectStrong, correctSuggestion, issues };
  });
  const grouped = new Map<string, Scored[]>();
  for (const row of scored) { const group = grouped.get(row.truth.scenario) ?? []; group.push(row); grouped.set(row.truth.scenario, group); }
  const byScenario = Object.fromEntries([...grouped].sort(([left], [right]) => left.localeCompare(right)).map(([scenario, rows]) => [scenario, metrics(rows)]));
  const failures = scored.filter((row) => row.issues.length).map((row) => ({
    incomingKey: row.actual.incomingKey, sourceRowNumber: row.actual.rowIndex + 1, scenario: row.truth.scenario,
    expectedRelation: row.truth.expectedRelation, acceptableReferenceKeys: row.truth.acceptableReferenceKeys,
    actual: row.actual, issues: row.issues,
  }));
  await writeFile(join(outputRoot, `${manifest.caseId}.failures.json`), JSON.stringify({ caseId: manifest.caseId, count: failures.length, rows: failures }, null, 2));
  const failuresByScenario = Object.fromEntries([...grouped.keys()].sort().map((scenario) => [scenario, failures.filter((row) => row.scenario === scenario).slice(0, 3)]));
  const payload = JSON.stringify({ dataset1: { name: first.data.name, rows: first.data.rows, nameField: manifest.dataset1.nameField, idField: manifest.dataset1.idField }, dataset2: { name: second.data.name, rows: second.data.rows, nameField: manifest.dataset2.nameField, idField: manifest.dataset2.idField } });
  const sourceSummary = (value: Awaited<ReturnType<typeof parseSource>>, source: Source) => ({ path: portable(source.path), bytes: value.bytes, sha256: value.sha256, format: value.data.format, worksheet: value.data.worksheet, rows: value.data.rows.length, columns: value.data.headers.length, nameField: source.nameField, idField: source.idField ?? null, recordKeyField: source.keyField });
  const result = {
    caseId: manifest.caseId, completedAt: new Date().toISOString(), manifest: portable(manifest.path),
    dataset1: sourceSummary(first, manifest.dataset1), dataset2: sourceSummary(second, manifest.dataset2),
    normalizedCloudPayloadBytes: Buffer.byteLength(payload, "utf8"), fitsCloudPayloadLimit: Buffer.byteLength(payload, "utf8") <= 20 * 1024 * 1024,
    groundTruth: { path: portable(manifest.truthPath), sha256: sha(truthBytes), rows: truth.length, loadedOnlyAfterDecisions: true },
    timingsMs: { dataset1DiskRead: first.readMs, dataset2DiskRead: second.readMs, dataset1Parse: first.parseMs, dataset2Parse: second.parseMs, indexBuild: rounded(indexMs), compareAllRows: rounded(comparisonMs), parseIndexCompareTotal: rounded(first.parseMs + second.parseMs + indexMs + comparisonMs) },
    metrics: metrics(scored), byScenario, failureSamplesByScenario: failuresByScenario,
    sampledProcessMemory: memory,
    browserExport: await compareBrowser(manifest.caseId, actual),
  };
  await writeFile(join(outputRoot, `${manifest.caseId}.metrics.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ caseId: result.caseId, phase: "complete", rows: result.metrics.rows, lanes: result.metrics.laneCounts, strongPrecision: result.metrics.strictStrongPrecision, strongRecall: result.metrics.correctStrongRecall, suggestedRecall: result.metrics.correctSuggestedTargetRecall, knownMatchesDeclaredNoMatch: result.metrics.knownMatchesDeclaredNoMatch, timingsMs: result.timingsMs }));
  return result;
}

await mkdir(outputRoot, { recursive: true });
const paths = explicitManifests.length ? explicitManifests.map((path) => resolve(workspace, path)) : (await readdir(stressRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^case\d+$/i.test(entry.name) && (!selectedCases.length || selectedCases.includes(entry.name))).map((entry) => join(stressRoot, entry.name, "manifest.json")).sort();
if (!paths.length) throw new Error("No stress manifests found. Wait for fixture generation, or pass --manifest path.");

const results: Awaited<ReturnType<typeof evaluate>>[] = [];
for (const path of paths) {
  const manifest = await loadManifest(path);
  if (selectedCases.length && !selectedCases.includes(manifest.caseId)) continue;
  if (compareBrowserOnly) {
    const actual = JSON.parse(await readFile(join(outputRoot, `${manifest.caseId}.actual.json`), "utf8"));
    const browser = await compareBrowser(manifest.caseId, actual.rows);
    const metricPath = join(outputRoot, `${manifest.caseId}.metrics.json`);
    const metric = JSON.parse(await readFile(metricPath, "utf8")); metric.browserExport = browser;
    await writeFile(metricPath, JSON.stringify(metric, null, 2));
    results.push(metric);
  } else results.push(await evaluate(manifest));
}

const provenance = {
  node: process.version, platform: platform(), osRelease: release(), architecture: process.arch,
  cpu: cpus()[0]?.model ?? "unknown", logicalCores: cpus().length,
  totalMemoryGiB: rounded(totalmem() / 1024 ** 3), freeMemoryGiBAtReport: rounded(freemem() / 1024 ** 3),
  parserSha256: sha(await readFile(resolve(workspace, "src/lib/dataset-input.ts"))),
  comparatorSha256: sha(await readFile(resolve(workspace, "src/lib/dataset-comparison.ts"))),
};
const limitations = [
  "Synthetic hard-case ground truth tests the scenarios generated here; these results are not a production accuracy estimate.",
  "The actual application parser and local comparator run unchanged in Node. Node timings exclude browser rendering, UI animation delays, user interaction and downloading files.",
  "Timings show the latest recorded run per case, not a statistical benchmark. Concurrent browser/agent work, garbage collection and warm module caches can affect timings. Memory values are snapshots, not measured peaks.",
  "Local confidence is null. Strong/No match are rule-based UI lanes, not calibrated model probabilities. No AI API, cloud task or production database was exercised.",
  "The local comparator uses the selected record name and optional shared identifier. Other imported columns are retained for the dataset but do not participate in these local decisions.",
  "Strict auto-match precision counts only truth=match rows whose selected reference key is acceptable. Ambiguous truth never counts as safe automatic matching, even if an acceptable candidate is selected.",
  "Correct suggested-target recall includes strong, review and low-confidence lanes only when the chosen reference key is acceptable. A review result with no selected target does not count as retrieved.",
  "Browser export comparison, when available, validates every exported row; it does not measure browser parse time or prove a specific frame rate.",
];
await writeFile(join(outputRoot, "summary.json"), JSON.stringify({ evaluatedAt: new Date().toISOString(), provenance, limitations, cases: results }, null, 2));
const markdown = [
  "# Dataset stress evaluation", "", `Generated ${new Date().toISOString()}. Actual app parser + unchanged local matching engine.`, "",
  "| Case | Reference / incoming rows | Strong / review / low / no match | Strict strong precision | Correct strong recall | Correct target suggestion recall | Known matches called no match |",
  "|---|---:|---|---:|---:|---:|---:|",
  ...results.map((result) => `| ${result.caseId} | ${result.dataset1.rows} / ${result.dataset2.rows} | ${lanes.map((lane) => result.metrics.laneCounts[lane]).join(" / ")} | ${formatPercent(result.metrics.strictStrongPrecision)} | ${formatPercent(result.metrics.correctStrongRecall)} | ${formatPercent(result.metrics.correctSuggestedTargetRecall)} | ${result.metrics.knownMatchesDeclaredNoMatch} |`),
  "", "## Decision errors", "",
  "| Case | False strong matches | Ambiguous rows made strong | True matches without correct suggested target | No match precision | No match recall |",
  "|---|---:|---:|---:|---:|---:|",
  ...results.map((result) => `| ${result.caseId} | ${result.metrics.falseStrongCount} | ${result.metrics.ambiguousStrongCount} | ${result.metrics.knownMatchesWithoutCorrectSuggestion} | ${formatPercent(result.metrics.noMatchLanePrecision)} | ${formatPercent(result.metrics.noMatchLaneRecall)} |`),
  "", "## Timings", "", "Milliseconds from one Node run; browser animation/rendering is excluded.", "",
  "| Case | Parse Dataset 1 | Parse Dataset 2 | Build index | Compare all rows | Browser CSV |", "|---|---:|---:|---:|---:|---|",
  ...results.map((result) => `| ${result.caseId} | ${result.timingsMs.dataset1Parse} | ${result.timingsMs.dataset2Parse} | ${result.timingsMs.indexBuild} | ${result.timingsMs.compareAllRows} | ${result.browserExport.status} |`),
  "", "## Scope and definitions", "", ...limitations.map((item) => "- " + item), "",
  "## Files", "", ...results.flatMap((result) => [`- ${result.caseId}.metrics.json: exact metrics, per-scenario results, source checksums and timing.`, `- ${result.caseId}.actual.json / .actual.csv: every actual output row.`, `- ${result.caseId}.failures.json: every failure with ground truth and the selected target.`, `- ${result.caseId}-browser-comparison.json: whole-export comparison when supplied.`]), "",
  "## Runtime", "", "```json", JSON.stringify(provenance, null, 2), "```", "",
].join("\n");
await writeFile(join(outputRoot, "summary.md"), markdown);
console.log(JSON.stringify({ summary: portable(join(outputRoot, "summary.md")), cases: results.map((result) => result.caseId) }));
