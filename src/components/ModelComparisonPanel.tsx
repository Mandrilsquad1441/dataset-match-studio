import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, ChevronDown, ChevronLeft, ChevronRight, FlaskConical, Loader2, Play, Upload, X } from "lucide-react";
import type { LocalDataset } from "../lib/dataset-comparison";
import type { ModelEvaluationRow } from "../lib/model-comparison";
import { DEFAULT_MODEL_CHOICES, evaluateMatchingModel, getMatchingModels, type EvaluationResponse, type ModelChoice } from "../lib/matching-models";
import MatchingModelPicker from "./MatchingModelPicker";
import ModelComparisonProgress from "./ModelComparisonProgress";
import { benchmarkMetrics, benchmarkSample, isCorrectDecision, readBenchmarkAnswerKey, type BenchmarkAnswerKey, type BenchmarkRelation, type ScorableDecision } from "../lib/benchmark";
import "./ModelComparisonPanel.css";

export interface ModelComparisonPanelProps {
  dataset1: LocalDataset;
  dataset2: LocalDataset;
  live: boolean;
  disabled?: boolean;
  modelChoices?: ModelChoice[];
  onBusyChange?: (busy: boolean) => void;
  onUseModel?: (modelId: string) => void;
  standalone?: boolean;
  initialAnswerKey?: BenchmarkAnswerKey | null;
}
interface ModelRun { modelId: string; name: string; status: "running" | "complete" | "failed" | "cancelled"; response?: EvaluationResponse; wallMs: number | null; error?: string }
interface BenchmarkRun {
  id: string; startedAt: string; completedAt: string | null; wallMs: number | null;
  useCache: boolean;
  sample: number[]; sampleFrom: "all records" | "labeled records"; population: number;
  answerKey: BenchmarkAnswerKey | null; models: ModelRun[];
  datasets: { name: string; rows: number; nameField: string; idField?: string }[];
}
const relation = (row: ModelEvaluationRow): BenchmarkRelation => row.lane === "strong" ? "match" : row.lane === "no-match" ? "no-match" : "review";
const relationName = (value: BenchmarkRelation) => value === "match" ? "Match" : value === "no-match" ? "No match" : "Review";
const measuredLatency = (row: ModelEvaluationRow): number | null => row.modelId === "local" ? row.latencyMs : row.modelOutcome !== null && row.resolvedModel ? row.inferenceLatencyMs : null;
const scorable = (row: ModelEvaluationRow): ScorableDecision => ({ rowIndex: row.rowIndex, relation: relation(row), targetIndex: row.targetIndex, latencyMs: measuredLatency(row), cached: row.cached, error: row.error });
const percent = (value: number | null) => value === null ? "—" : (value * 100).toFixed(1) + "%";
const duration = (value: number | null) => value === null ? "—" : value < 1000 ? value < 10 ? value.toFixed(2) + " ms" : Math.round(value).toLocaleString() + " ms" : (value / 1000).toFixed(2) + " s";
const cost = (value: number | null | undefined) => value === undefined || value === null ? "Unknown" : value === 0 ? "$0" : "$" + value.toFixed(value < 0.01 ? 6 : 4);
function downloadJson(name: string, payload: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.hidden = true; document.body.append(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export default function ModelComparisonPanel({ dataset1, dataset2, live, disabled = false, modelChoices, onBusyChange, onUseModel, standalone = false, initialAnswerKey = null }: ModelComparisonPanelProps) {
  const [open, setOpen] = useState(false);
  const expanded = standalone || open;
  const [choices, setChoices] = useState<ModelChoice[]>(modelChoices ?? DEFAULT_MODEL_CHOICES);
  const [catalogueError, setCatalogueError] = useState("");
  const [catalogueBusy, setCatalogueBusy] = useState(false);
  const [selected, setSelected] = useState(["local", "", ""]);
  const [sampleSize, setSampleSize] = useState(10);
  const [useCache, setUseCache] = useState(false);
  const [answerKey, setAnswerKey] = useState<BenchmarkAnswerKey | null>(initialAnswerKey);
  const [keyBusy, setKeyBusy] = useState(false);
  const [error, setError] = useState("");
  const [run, setRun] = useState<BenchmarkRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [activity, setActivity] = useState<{ message: string; elapsedMs: number }[]>([]);
  const [onlyDisagreements, setOnlyDisagreements] = useState(false);
  const [page, setPage] = useState(0);
  const [inspectRow, setInspectRow] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);
  const runStarted = useRef(0);
  const keyVersion = useRef(0);
  const progressRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  useEffect(() => { alive.current = true; return () => { alive.current = false; abort.current?.abort(); keyVersion.current++; }; }, []);
  useEffect(() => { busyCallback.current?.(busy); }, [busy]);
  useEffect(() => () => busyCallback.current?.(false), []);
  useEffect(() => {
    abort.current?.abort(); keyVersion.current++;
    setRun(null); setAnswerKey(initialAnswerKey); setBusy(false); setKeyBusy(false); setError(""); setInspectRow(null); setPage(0); setActivity([]);
  }, [dataset1, dataset2, live, initialAnswerKey]);
  useEffect(() => { if (modelChoices) { setChoices(modelChoices); setCatalogueBusy(false); setCatalogueError(""); } }, [modelChoices]);
  useEffect(() => {
    if (!expanded || modelChoices) return;
    const controller = new AbortController(); setCatalogueBusy(true);
    void getMatchingModels(live, controller.signal).then((catalogue) => {
      if (!controller.signal.aborted) { setChoices(catalogue.models); setCatalogueError(catalogue.catalogueError ?? ""); }
    }).catch((cause) => { if (!controller.signal.aborted) setCatalogueError(cause instanceof Error ? cause.message : "Could not load models."); }).finally(() => { if (!controller.signal.aborted) setCatalogueBusy(false); });
    return () => controller.abort();
  }, [expanded, live, modelChoices]);
  useEffect(() => {
    if (!busy) return;
    const started = performance.now(); setElapsedMs(0);
    progressRef.current?.scrollIntoView({ block: "nearest", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    const timer = window.setInterval(() => setElapsedMs(performance.now() - started), 500);
    return () => window.clearInterval(timer);
  }, [busy]);

  const selectedModels = selected.filter(Boolean);
  const nextSample = useMemo(() => benchmarkSample(dataset2.rows.length, sampleSize, answerKey?.labels.map((label) => label.rowIndex)), [dataset2.rows.length, sampleSize, answerKey]);
  const labels = new Map((run?.answerKey?.labels ?? []).map((label) => [label.rowIndex, label]));
  const available = selectedModels.length >= 2 && selectedModels.length <= 3 && new Set(selectedModels).size === selectedModels.length && selectedModels.every((id) => choices.some((model) => model.id === id && model.configured));
  const results = run?.models.filter((model) => model.response) ?? [];
  const fingerprints = new Set(results.map((model) => model.response!.candidateFingerprint));
  const comparable = fingerprints.size <= 1 && new Set(results.map((model) => model.response!.datasetFingerprint)).size <= 1;
  const rowModels = (index: number) => (run?.models ?? []).map((model) => ({ model, row: model.response?.rows.find((row) => row.rowIndex === index) }));
  const disagreement = (index: number) => {
    const rows = rowModels(index).flatMap(({ row }) => row && !row.error ? [row] : []);
    return rows.length >= 2 && new Set(rows.map((row) => relation(row) + ":" + row.targetIndex)).size > 1;
  };
  const allRows = run?.sample ?? [];
  const disagreements = allRows.filter(disagreement);
  const visibleRows = onlyDisagreements ? disagreements : allRows;
  const pages = Math.max(1, Math.ceil(visibleRows.length / 10));
  const currentPage = Math.min(page, pages - 1);

  async function loadAnswerKey(file: File) {
    const version = ++keyVersion.current; setKeyBusy(true); setError("");
    try {
      const value = await readBenchmarkAnswerKey(file, dataset1, dataset2);
      if (alive.current && version === keyVersion.current) setAnswerKey(value);
    } catch (cause) { if (alive.current && version === keyVersion.current) setError(cause instanceof Error ? cause.message : "Could not read the answer key."); }
    finally { if (alive.current && version === keyVersion.current) setKeyBusy(false); }
  }
  async function compare() {
    if (!available || busy || disabled || keyBusy || !nextSample.length) return;
    const controller = new AbortController(); abort.current?.abort(); abort.current = controller;
    const id = crypto.randomUUID(); const started = performance.now(); runStarted.current = started;
    const current: BenchmarkRun = {
      id, startedAt: new Date().toISOString(), completedAt: null, wallMs: null, useCache,
      sample: nextSample, sampleFrom: answerKey ? "labeled records" : "all records", population: answerKey?.labels.length ?? dataset2.rows.length,
      answerKey, models: selectedModels.map((modelId) => ({ modelId, name: choices.find((choice) => choice.id === modelId)?.name ?? modelId, status: "running", wallMs: null })),
      datasets: [dataset1, dataset2].map(({ name, rows, nameField, idField }) => ({ name, rows: rows.length, nameField, idField })),
    };
    setRun(current); setBusy(true); setError(""); setInspectRow(null); setPage(0);
    setActivity([{ message: "Comparing the same " + current.sample.length + " records across " + current.models.length + " models.", elapsedMs: 0 }]);
    await Promise.all(current.models.map(async (model) => {
      const modelStarted = performance.now();
      let next: ModelRun;
      try {
        const response = await evaluateMatchingModel({ dataset1, dataset2, rowIndices: current.sample, modelId: model.modelId, seed: 20260923, useCache }, live, controller.signal);
        next = { ...model, status: "complete", response, wallMs: performance.now() - modelStarted };
      } catch (cause) { next = { ...model, status: "failed", wallMs: performance.now() - modelStarted, error: cause instanceof Error ? cause.message : "Evaluation failed." }; }
      if (alive.current && !controller.signal.aborted) {
        setRun((previous) => previous?.id === id ? { ...previous, models: previous.models.map((entry) => entry.modelId === model.modelId ? next : entry) } : previous);
        setActivity((previous) => [...previous, { message: next.response ? model.name + " returned " + (next.response.rows.length - next.response.errorRows) + " decisions" + (next.response.errorRows ? " · " + next.response.errorRows + " records failed" : "") + "." : model.name + " could not complete the request.", elapsedMs: performance.now() - started }]);
      }
    }));
    if (alive.current && !controller.signal.aborted) { setRun((previous) => previous?.id === id ? { ...previous, completedAt: new Date().toISOString(), wallMs: performance.now() - started } : previous); setBusy(false); }
  }
  function stopComparison() {
    abort.current?.abort();
    const wallMs = performance.now() - runStarted.current;
    setRun((previous) => previous ? { ...previous, completedAt: new Date().toISOString(), wallMs, models: previous.models.map((model) => model.status === "running" ? { ...model, status: "cancelled", wallMs, error: "Stopped before a response was received." } : model) } : previous);
    setBusy(false);
    setActivity((previous) => [...previous, { message: "Stopped. Completed responses are kept.", elapsedMs: wallMs }]);
    setError("Comparison stopped. Completed results are kept. In-flight provider requests may still finish and incur cost.");
  }
  function exportReport() {
    if (!run) return;
    downloadJson("matching-model-comparison-" + run.startedAt.slice(0, 10) + ".json", {
      schemaVersion: 1, ...run, comparable, sampleSeed: 20260923,
      methodology: {
        accuracy: "Final pipeline accuracy after shared deterministic evidence safeguards: correct relation and, for matches, an acceptable target. This is not raw LLM accuracy. Missing/error predictions in a returned response count as incorrect labeled rows; a failed or cancelled request with no response is unscored. Raw modelOutcome is retained per record.",
        precision: "Correct target matches / all predicted matches among labeled rows.", recall: "Correct target matches / all expected matches among labeled rows.",
        latency: "p50/p95 of uncached successful per-record local compute or model inference latency; cached, failed and skipped AI rows excluded. Server runtime and client wall duration are separate.",
        population: "Metrics describe this deterministic sample only. Sampling labeled records may not represent the complete dataset.",
        costs: "Provider-reported cost incurred by this request; null means not reported. Original cached usage is retained separately per row.",
      },
      metrics: run.models.map((model) => ({ modelId: model.modelId, status: model.status, ...(model.response ? benchmarkMetrics(run.sample, model.response.rows.map(scorable), run.answerKey?.labels) : { accuracy: null, precision: null, recall: null, failures: null, p50Ms: null, p95Ms: null, note: "No response received; per-record outcomes are unknown." }), runtimeMs: model.response?.runtimeMs ?? null, clientWallMs: model.wallMs, usage: model.response?.usage ?? null })),
    });
  }

  return <section className={"model-benchmark" + (expanded ? " is-open" : "") + (standalone ? " is-standalone" : "")} aria-label="Compare matching models">
    {!standalone && <button type="button" className="benchmark-disclosure" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="benchmark-heading-icon"><FlaskConical size={17} /></span><span><strong>Compare models</strong><small>Same records. Measured speed. Accuracy with an answer key.</small></span><ChevronDown size={17} className="benchmark-chevron" />
    </button>}
    {expanded && <div className="benchmark-body">
      <div className="benchmark-config" hidden={busy}>
        <div className="benchmark-models">{selected.map((value, index) => <MatchingModelPicker key={index} label={"Model " + (index + 1)} value={value} models={choices} optional={index === 2} disabled={busy || disabled || catalogueBusy} excludedIds={selected.filter((_, position) => position !== index)} onChange={(modelId) => setSelected((previous) => previous.map((entry, position) => position === index ? modelId : entry))} />)}</div>
        <div className="benchmark-tools"><label className="benchmark-sample-label">Sample<select aria-label="Comparison sample size" value={sampleSize} disabled={busy || disabled} onChange={(event) => setSampleSize(Number(event.target.value))}>{[5, 10, 25, 50].map((size) => <option key={size} value={size}>{size} records</option>)}</select></label>
          <label className={"benchmark-upload" + (busy || disabled || keyBusy ? " is-disabled" : "")}>{keyBusy ? <Loader2 size={15} className="spin" /> : <Upload size={15} />}<span>{answerKey ? "Replace answer key" : "Add answer key"}</span><input aria-label="Upload comparison answer key" type="file" accept=".csv,.json" disabled={busy || disabled || keyBusy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void loadAnswerKey(file); event.target.value = ""; }} /></label>
          <button className="benchmark-run" type="button" disabled={!available || busy || disabled || keyBusy || !nextSample.length} onClick={() => void compare()}>{busy ? <Loader2 size={15} className="spin" /> : <Play size={14} />} {busy ? "Comparing · " + Math.floor(elapsedMs / 1000) + "s" : "Compare " + nextSample.length + " records"}</button>

        </div>
      </div>
      <div hidden={busy}>
      {answerKey ? <div className="benchmark-key"><span><strong>{answerKey.name}</strong> · {answerKey.labels.length.toLocaleString()} of {dataset2.rows.length.toLocaleString()} records labeled. Next run samples labeled records.</span><button type="button" aria-label="Remove answer key" disabled={busy || disabled} onClick={() => setAnswerKey(null)}><X size={14} /></button></div> : <p className="benchmark-note">Add an answer key to measure accuracy. You can compare speed and cost without labels.</p>}
      {run && run.answerKey?.sha256 !== answerKey?.sha256 && <p className="benchmark-note">The answer-key change applies to the next run. Existing results retain their original labels.</p>}
      <details className="benchmark-options"><summary>Answer-key format &amp; run settings</summary><div><p>CSV: <code>dataset2_row,expected,dataset1_row</code>. Row numbers begin at 1 and exclude the header. Use <code>match</code>, <code>no-match</code>, or <code>review</code>; a match needs its Dataset 1 row. Separate acceptable targets with <code>|</code>.</p><p>JSON accepts an array or <code>records</code>/<code>rows</code> wrapper, including the stress-test truth files. <code>incomingRowIndex</code> and target index fields begin at 0. Source keys are checked against the imported rows.</p><label><input type="checkbox" checked={useCache} disabled={busy || disabled} onChange={(event) => setUseCache(event.target.checked)} />Reuse cached responses when available</label><p>Fresh inference is the default. The same seeded sample and candidate policy are used for every model. Provider charges depend on actual tokens; local rules have no API cost.</p></div></details>
      </div>
      {run && <div className="benchmark-live-run" ref={progressRef}>
        {busy && <div className="benchmark-live-heading"><div><h3>Comparing models</h3><span>{run.sample.length} records · identical sample</span></div><button className="benchmark-stop" type="button" onClick={stopComparison}>Stop</button></div>}
        <ModelComparisonProgress key={run.id} sampleSize={run.sample.length} elapsedMs={busy ? elapsedMs : run.wallMs ?? elapsedMs} busy={busy} models={run.models.map((model) => ({ id: model.modelId, name: model.name, status: model.status, completedRecords: model.response?.rows.filter((row) => !row.error).length ?? 0, durationMs: model.wallMs, errorCount: model.response?.errorRows ?? 0, counts: model.response ? model.response.rows.filter((row) => !row.error).reduce((counts, row) => { counts[row.lane]++; return counts; }, { strong: 0, review: 0, low: 0, "no-match": 0 }) : undefined }))} />
        <div className="benchmark-stream" role="status" aria-live="polite"><span className={busy ? "is-active" : ""} />{activity.at(-1)?.message}</div>
        {activity.length > 1 && <details className="benchmark-activity"><summary>Activity</summary><ol>{activity.map((entry, index) => <li key={index}><time>{(entry.elapsedMs / 1000).toFixed(1)}s</time>{entry.message}</li>)}</ol></details>}
      </div>}
      {catalogueError && <p className="benchmark-notice" role="status">Model catalogue: {catalogueError}</p>}
      {error && <p className="benchmark-error" role="alert">{error}</p>}
      {!available && !catalogueBusy && <p className="benchmark-note">Choose two or three different available models to compare.</p>}
      {run && !busy && <div className="benchmark-results">
        <div className="benchmark-results-heading"><div><h3>{busy ? "Comparing the same sample" : "Comparison results"}</h3><p>{run.sample.length} of {run.population.toLocaleString()} {run.sampleFrom}{run.wallMs !== null ? " · " + duration(run.wallMs) + " total" : ""}{run.answerKey ? " · " + run.sample.filter((index) => labels.has(index)).length + "/" + run.sample.length + " sampled records labeled" : " · No accuracy labels"}</p></div><button className="benchmark-text-button" type="button" disabled={busy} onClick={exportReport}><ArrowDownToLine size={15} />Report JSON</button></div>
        {!comparable && <p className="benchmark-error">Candidate or dataset fingerprints differ between models. These results are not a controlled comparison.</p>}
        <div className="benchmark-table-scroll"><table className="benchmark-metrics"><caption className="benchmark-sr-only">Measured model results for an identical sample</caption><thead><tr><th>Model</th><th>Accuracy</th><th>Precision</th><th>Recall</th><th>p50 / p95</th><th>Duration</th><th>Cost</th><th>Failures</th><th>Cached</th></tr></thead><tbody>{run.models.map((model) => {
          const metrics = benchmarkMetrics(run.sample, model.response?.rows.map(scorable) ?? [], run.answerKey?.labels);
          return <tr key={model.modelId}><th scope="row"><strong>{model.name}</strong><small>{model.status === "running" ? "Waiting for response…" : model.status === "failed" ? "Request failed" : model.status === "cancelled" ? "Stopped · results unknown" : metrics.labeledRows + " labeled · " + metrics.latencyRows + " timed" + (metrics.skippedRows ? " · " + metrics.skippedRows + " skipped" : "")}</small>{onUseModel && model.response && metrics.failures === 0 && <button className="benchmark-use-model" type="button" disabled={busy || disabled} onClick={() => onUseModel(model.modelId)}>Use model</button>}</th>{model.status === "running" ? <td colSpan={8} className="benchmark-pending"><Loader2 size={14} className="spin" /> Running</td> : <><td>{comparable && model.response ? percent(metrics.accuracy) : "—"}</td><td>{comparable && model.response ? percent(metrics.precision) : "—"}</td><td>{comparable && model.response ? percent(metrics.recall) : "—"}</td><td className="benchmark-latency">{duration(metrics.p50Ms)}<small>{duration(metrics.p95Ms)}</small></td><td title={"Client wall time: " + duration(model.wallMs)}>{duration(model.response?.runtimeMs ?? null)}</td><td>{cost(model.response?.usage.costUsd)}</td><td>{model.response ? metrics.failures : "—"}</td><td>{model.response ? metrics.cachedRows : "—"}</td></>}</tr>;
        })}</tbody></table></div>
        <p className="benchmark-note">Accuracy requires the correct relation and target. Precision and recall describe labeled matches. p50/p95 measure local compute or AI inference, excluding cached, failed, and skipped AI calls. Duration includes server preparation; cost is provider-reported, or unknown.</p>
        <p className="benchmark-note">Accuracy measures final decisions after shared record-evidence safeguards. Original model judgments remain visible in each record’s details.</p>
        {run.sampleFrom === "labeled records" && run.population < dataset2.rows.length && <p className="benchmark-note">This sample comes from the labeled subset; it may not represent the complete dataset.</p>}
        {run.models.filter((model) => model.error).map((model) => <p className="benchmark-error" key={model.modelId}><strong>{model.name}:</strong> {model.error}</p>)}
        {!!results.length && <>
          <div className="benchmark-records-heading"><h4>Record decisions</h4><label><input type="checkbox" checked={onlyDisagreements} onChange={(event) => { setOnlyDisagreements(event.target.checked); setPage(0); }} />Disagreements ({disagreements.length})</label></div>
          <div className="benchmark-table-scroll"><table className="benchmark-records"><thead><tr><th>Dataset 2 record</th>{run.models.map((model) => <th key={model.modelId}>{model.name}</th>)}{run.answerKey && <th>Answer key</th>}</tr></thead><tbody>{visibleRows.slice(currentPage * 10, currentPage * 10 + 10).map((index) => <tr key={index} className={inspectRow === index ? "is-inspected" : ""}><th scope="row"><button type="button" onClick={() => setInspectRow(inspectRow === index ? null : index)}><span>Row {index + 1}</span>{String(dataset2.rows[index]?.[dataset2.nameField] ?? "")}</button></th>{rowModels(index).map(({ model, row }) => <td key={model.modelId}>{row ? <button type="button" className={"benchmark-decision " + (row.error ? "failed" : relation(row))} onClick={() => setInspectRow(inspectRow === index ? null : index)}>{row.error ? "Failed" : relationName(relation(row))}{row.targetIndex !== null && !row.error && <small>Dataset 1 · row {row.targetIndex + 1}</small>}{labels.has(index) && <span className="benchmark-correctness" title={isCorrectDecision(scorable(row), labels.get(index)!) ? "Agrees with answer key" : "Does not agree with answer key"}>{isCorrectDecision(scorable(row), labels.get(index)!) ? "✓" : "×"}</span>}</button> : <span className="benchmark-muted">{model.status === "running" ? "Pending" : model.status === "cancelled" ? "Stopped" : "Failed"}</span>}</td>)}{run.answerKey && <td>{labels.has(index) ? <span>{relationName(labels.get(index)!.relation)}{labels.get(index)!.relation === "match" && <small>Dataset 1 · {labels.get(index)!.targetIndices.map((target) => target + 1).join(" / ")}</small>}</span> : "Unlabeled"}</td>}</tr>)}</tbody></table></div>
          {!visibleRows.length && <p className="benchmark-empty">No disagreements among the completed model decisions.</p>}
          {pages > 1 && <div className="benchmark-pagination"><span>{currentPage + 1} of {pages}</span><button type="button" aria-label="Previous comparison records" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={16} /></button><button type="button" aria-label="Next comparison records" disabled={currentPage >= pages - 1} onClick={() => setPage(currentPage + 1)}><ChevronRight size={16} /></button></div>}
          {inspectRow !== null && <div className="benchmark-inspector"><div className="benchmark-inspector-heading"><h4>Dataset 2 · row {inspectRow + 1}</h4><button type="button" aria-label="Close comparison record details" onClick={() => setInspectRow(null)}><X size={16} /></button></div><p>{String(dataset2.rows[inspectRow]?.[dataset2.nameField] ?? "")}</p>{rowModels(inspectRow).map(({ model, row }) => <article key={model.modelId}><h5>{model.name}<span>{row ? row.error ? "Failed" : relationName(relation(row)) : model.status === "running" ? "Pending" : model.status === "cancelled" ? "Stopped" : "Failed"}</span></h5>{row ? <>
            {row.targetName ? <p className="benchmark-target">Dataset 1 · row {(row.targetIndex ?? 0) + 1} · {row.targetName}</p> : row.assessment.assessedTargetIndex != null && <p className="benchmark-target">Assessed candidate · Dataset 1 row {row.assessment.assessedTargetIndex + 1} · {row.assessment.assessedTargetName}</p>}<p>{row.error ?? row.explanation}</p><div className="benchmark-row-meta"><span>Deterministic score {row.assessment.score.toFixed(1)}/100</span>{row.modelOutcome !== null && <span>Original model outcome: {row.modelOutcome.replaceAll("_", " ")}</span>}{row.modelConfidence !== null && <span>Model certainty {percent(row.modelConfidence)} (uncalibrated)</span>}<span>{row.error ? "Failed request · " + duration(row.latencyMs) : row.modelId === "local" ? "Local compute " + duration(row.latencyMs) : measuredLatency(row) === null ? "No inference performed" : (row.cached ? "Cached · original inference " : "Inference ") + duration(row.inferenceLatencyMs)}</span><span>Incurred {cost(row.usage.costUsd)}</span></div>
            <details><summary>Field evidence ({row.assessment.components.length})</summary><div className="benchmark-table-scroll"><table className="benchmark-evidence"><thead><tr><th>Field</th><th>Dataset 2</th><th>Dataset 1</th><th>Evidence</th></tr></thead><tbody>{row.assessment.components.map((field, index) => <tr key={field.field + index}><th scope="row">{field.label}</th><td>{field.sourceValue ?? "—"}</td><td>{field.targetValue ?? "—"}</td><td><strong>{field.status}</strong><small>{field.explanation}</small></td></tr>)}</tbody></table></div></details>
            <p className="benchmark-note">{row.candidateIndices.length} shared candidates · {row.provider ?? "local execution"}{row.resolvedModel ? " · " + row.resolvedModel : ""}{row.cached ? " · Original cost " + cost(row.originalUsage.costUsd) : ""}</p>
          </> : <p>{model.error ?? "Waiting for this model's response."}</p>}</article>)}</div>}
        </>}
      </div>}
    </div>}
  </section>;
}
