import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Check, CheckCircle2, ChevronDown, CircleDashed, CircleHelp, Download, Loader2, LockKeyhole, MinusCircle, Plus, RotateCcw, Table2, X } from "lucide-react";
import MatchFlow from "./MatchFlow";
import MatchingModelPicker from "./MatchingModelPicker";
import RecordInspector, { EvidenceScore, type InspectableDecision } from "./RecordInspector";
import SourceCard, { type SelectedDataset } from "./DatasetSourceCard";
import { useMatchingSession } from "../lib/matching-session";
import { DEFAULT_MODEL_CHOICES, evaluateMatchingModel, getMatchingModels, preferredMatchingModel } from "../lib/matching-models";
import "./match-workspace.css";
import SampleDatasetPicker from "./SampleDatasetPicker";
import { assessRecordPair } from "../lib/record-scoring";
import { automaticMatchAllowed, prepareLocalComparison, type LocalDecision } from "../lib/dataset-comparison";
import { ApiError, apiFetch, apiUrl } from "../lib/api";
import { accessToken } from "../lib/supabase";
import type { ImportSummary, RunEvent } from "../lib/types";

type Lane = LocalDecision["lane"];
type Decision = InspectableDecision & { targetRecordId?: string | null; sourceFields?: Record<string, unknown>; matchedFields?: Record<string, unknown> | null; error?: string };
type FlowRow = { id: string; sourceRowNumber: number; displayName: string; outcome: string | null; confidence: number | null; requiresReview: boolean; internalRecordId: string | null; internalDisplayName: string | null; sourceFields?: Record<string, unknown>; matchedFields?: Record<string, unknown> | null; explanation?: string | null; modelVersion?: string | null };
type RunFlow = { status: string; rowCount: number; processedRowCount: number; sourceRows: FlowRow[]; internalRecords: { id: string; displayName: string }[] };
type ResultPage = { rows: FlowRow[]; total: number; expectedTotal: number; status: string; nextOffset: number | null };
const count = (n: number) => n.toLocaleString();
const laneLabels: Record<Lane, string> = { strong: "Match", review: "Review", low: "Low confidence", "no-match": "No match" };

function OutcomeIcon({ lane }: { lane: Lane }) {
  const Icon = lane === "strong" ? CheckCircle2 : lane === "review" ? CircleHelp : lane === "low" ? CircleDashed : MinusCircle;
  return <Icon className={"outcome-icon " + lane} size={14} strokeWidth={1.8} aria-hidden="true" />;
}

function LiveRun({ runId, onFlow, onMessage, onDone }: { runId: string; onFlow: (flow: RunFlow) => void; onMessage: (message: string) => void; onDone: (status: string) => void }) {
  const callbacks = useRef({ onFlow, onMessage, onDone }); callbacks.current = { onFlow, onMessage, onDone };
  useEffect(() => {
    const controller = new AbortController(); let sequence = 0; let stopped = false; let fetching = false;
    const finish = (status: string) => { if (stopped) return; stopped = true; window.clearInterval(interval); controller.abort(); callbacks.current.onDone(status); };
    const refresh = async () => {
      if (fetching || stopped) return; fetching = true;
      try { const flow = await apiFetch<RunFlow>("/api/runs/" + runId + "/flow", { signal: controller.signal }); if (!stopped) { callbacks.current.onFlow(flow); if (["completed", "review", "failed"].includes(flow.status)) finish(flow.status); } }
      catch (error) {
        if (!controller.signal.aborted && error instanceof ApiError && [401, 403, 404].includes(error.status)) {
          callbacks.current.onMessage(error.status === 404 ? "This run is no longer available." : "Access to this run changed. Sign in again to continue."); finish("failed");
        } else if (!controller.signal.aborted) callbacks.current.onMessage("Reconnecting to saved progress…");
      }
      finally { fetching = false; }
    };
    const interval = window.setInterval(() => void refresh(), 1800); void refresh();
    void (async () => {
      while (!controller.signal.aborted && !stopped) {
        try {
          const token = await accessToken(); if (!token) { callbacks.current.onMessage("Your session expired. Sign in to reconnect."); finish("failed"); break; }
          const response = await fetch(apiUrl("/api/runs/" + runId + "/events?after=" + sequence), { headers: { Authorization: "Bearer " + token }, signal: controller.signal });
          if ([401, 403, 404].includes(response.status)) { callbacks.current.onMessage(response.status === 404 ? "This run is no longer available." : "Access to this run changed. Sign in again to continue."); finish("failed"); break; }
          if (!response.ok || !response.body) throw new Error("Connection interrupted. Reconnecting to your saved progress…");
          const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
          while (!controller.signal.aborted && !stopped) {
            const chunk = await reader.read(); if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
            const frames = buffer.split("\n\n"); buffer = frames.pop() ?? "";
            for (const frame of frames) {
              const line = frame.split("\n").find((item) => item.startsWith("data:")); if (!line) continue;
              const event = JSON.parse(line.slice(5)) as RunEvent; if (event.sequence <= sequence) continue; sequence = event.sequence;
              callbacks.current.onMessage(event.message);
              if (["run_complete", "review_queue_ready", "import_failed"].includes(event.type)) { finish(event.type === "import_failed" ? "failed" : "completed"); break; }
            }
          }
          await reader.cancel();
        } catch (error) { if (!controller.signal.aborted) callbacks.current.onMessage(error instanceof Error ? error.message : "Reconnecting to your saved progress…"); }
        if (!stopped && !controller.signal.aborted) await new Promise((resolve) => window.setTimeout(resolve, 2500));
      }
    })();
    return () => { stopped = true; controller.abort(); window.clearInterval(interval); };
  }, [runId]);
  return null;
}

export default function MatchWorkspace({ live, visible = true, onStarted, onCompareModels, newComparisonRequest = 0 }: { live: boolean; visible?: boolean; onStarted: (summary: ImportSummary) => void; onCompareModels: () => void; newComparisonRequest?: number }) {
  const { first, second, setFirst, setSecond, modelChoices, setModelChoices, catalogueError, setCatalogueError, catalogueVersion, setCatalogueVersion, selectedModel, setSelectedModel, setSuggestedModel, benchmarkBusy, firstBusy, setFirstBusy, secondBusy, setSecondBusy, sourceVersion, setSourceVersion, setMatchingBusy, activeSample, loadingSampleId, sampleError, loadSample } = useMatchingSession();
  const [state, setState] = useState<"idle" | "running" | "settling" | "done" | "failed">("idle");
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [processed, setProcessed] = useState(0);
  const [messages, setMessages] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [runWasLive, setRunWasLive] = useState(false);
  const [resultsLoading, setResultsLoading] = useState(false);
  const [resultFilter, setResultFilter] = useState<Lane | "all">("all");
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [resultPage, setResultPage] = useState(0);
  const [resultQuery, setResultQuery] = useState("");
  const [resultSort, setResultSort] = useState<"row" | "score-desc" | "score-asc">("row");


  const [runDurationMs, setRunDurationMs] = useState<number | null>(null);
  const [modelCost, setModelCost] = useState<number | null>(null);
  const [savedRunConfigured, setSavedRunConfigured] = useState(false);
  const modelAbort = useRef<AbortController | null>(null);
  const closeInspector = useCallback(() => setExpandedRow(null), []);
  const [replaying, setReplaying] = useState(false);
  const [replayCount, setReplayCount] = useState(0);

  const consumedComparisonRequest = useRef(newComparisonRequest);
  const workspaceTop = useRef<HTMLDivElement>(null);
  const journeyHeading = useRef<HTMLHeadingElement>(null);
  const previousStage = useRef(0);
  const timer = useRef<number | null>(null);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; modelAbort.current?.abort(); if (timer.current !== null) window.clearTimeout(timer.current); }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    void getMatchingModels(live, controller.signal).then((catalogue) => {
      setModelChoices(catalogue.models);
      setSavedRunConfigured(Boolean(catalogue.savedRunConfigured));
      setSuggestedModel(preferredMatchingModel(catalogue.models, { live, savedRunConfigured: Boolean(catalogue.savedRunConfigured) }));
      setCatalogueError(catalogue.catalogueError ?? "");
    }).catch((cause) => { if (!controller.signal.aborted) setCatalogueError(cause instanceof Error ? cause.message : "Model catalogue is unavailable."); });
    return () => controller.abort();
  }, [live, catalogueVersion]);
  const running = state === "running";
  const processing = running || state === "settling";
  useEffect(() => { setMatchingBusy(processing || resultsLoading); return () => setMatchingBusy(false); }, [processing, resultsLoading, setMatchingBusy]);
  useEffect(() => { if (!visible && state === "settling") setState("done"); if (!visible) { setReplaying(false); setExpandedRow(null); } }, [visible, state]);
  const previousInputs = useRef({ first, second, selectedModel });
  useEffect(() => {
    const previous = previousInputs.current;
    if (previous.first !== first || previous.second !== second || previous.selectedModel !== selectedModel) {
      previousInputs.current = { first, second, selectedModel };
      if (!processing) reset();

    }
  }, [first, second, selectedModel]);
  const updateFirst = (value: SelectedDataset | null) => { setFirst(value); reset(); };
  const updateSecond = (value: SelectedDataset | null) => { setSecond(value); reset(); };
  function cancelCurrent() { modelAbort.current?.abort(); modelAbort.current = null; if (timer.current !== null) window.clearTimeout(timer.current); timer.current = null; }
  function reset() { cancelCurrent(); setState("idle"); setDecisions([]); setProcessed(0); setMessages([]); setError(""); setRunId(null); setResultFilter("all"); setExpandedRow(null); setReplaying(false); setResultPage(0); setResultQuery(""); setRunDurationMs(null); setModelCost(null); }
  function newComparison() { setFirst(null); setSecond(null); setSourceVersion((value) => value + 1); reset(); workspaceTop.current?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); }
  useEffect(() => {
    if (consumedComparisonRequest.current === newComparisonRequest) return;
    if (processing || resultsLoading || benchmarkBusy || firstBusy || secondBusy) return;
    consumedComparisonRequest.current = newComparisonRequest;
    newComparison();
  }, [newComparisonRequest, processing, resultsLoading, benchmarkBusy, firstBusy, secondBusy]);
  function message(text: string) { setMessages((previous) => previous.at(-1) === text ? previous : [...previous, text].slice(-30)); }
  async function start() {
    if (!first || !second || processing || firstBusy || secondBusy || benchmarkBusy) return;
    cancelCurrent();
    workspaceTop.current?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    setError(""); setDecisions([]); setProcessed(0); setMessages([]); setRunId(null); setState("running"); setRunWasLive(false); setRunDurationMs(null); setModelCost(null); setResultPage(0);
    message("Reading " + count(first.rows.length) + " records in Dataset 1 and " + count(second.rows.length) + " in Dataset 2.");
    if (Boolean(first.idField) !== Boolean(second.idField)) { setError("Choose a shared identifier in both datasets, or set both to None."); setState("idle"); return; }
    for (const [index, dataset] of [first, second].entries()) {
      const empty = dataset.rows.findIndex((row) => !String(row[dataset.nameField] ?? "").trim());
      if (empty >= 0) { setError("Dataset " + (index + 1) + ", row " + (empty + 1) + " has no record name. Choose another name column or fill the missing value."); setState("idle"); return; }
    }
    if (selectedModel !== "local" && selectedModel !== "saved-jev") {
      const controller = new AbortController(); modelAbort.current = controller;
      const started = performance.now(); let completed = 0; let cost = 0; let costKnown = true; let failures = 0;
      let providerTag: string | undefined;
      try {
        const source = (dataset: SelectedDataset) => ({ name: dataset.name, rows: dataset.rows, nameField: dataset.nameField, idField: dataset.idField });
        for (let offset = 0; offset < second.rows.length; offset += 10) {
          if (controller.signal.aborted) break;
          message("Evaluating records " + count(offset + 1) + "–" + count(Math.min(offset + 10, second.rows.length)) + " with " + (modelChoices.find((model) => model.id === selectedModel)?.name ?? selectedModel) + "…");
          const result = await evaluateMatchingModel({ dataset1: source(first), dataset2: source(second), rowIndices: Array.from({ length: Math.min(10, second.rows.length - offset) }, (_, index) => offset + index), modelId: selectedModel, providerTag, useCache: true }, live, controller.signal);
          providerTag = result.settings.providerTag ?? undefined;
          if (!active.current || controller.signal.aborted) return;
          const next: Decision[] = result.rows.map((row) => ({ ...row, confidence: row.modelConfidence, resolvedModel: row.resolvedModel ?? undefined, costUsd: row.usage.costUsd }));
          completed += next.length; failures += result.errorRows;
          if (result.usage.costUsd === null) costKnown = false; else cost += result.usage.costUsd;
          setDecisions((previous) => [...previous, ...next]); setProcessed(completed); setModelCost(costKnown ? cost : null);
          if (failures) { setError(count(failures) + " records could not be evaluated. Inspect their errors before relying on the results."); break; }
        }
        if (!active.current || controller.signal.aborted) return;
        setRunDurationMs(performance.now() - started); setState("settling");
        message((failures ? "Stopped after provider errors · " : "Complete · ") + count(completed) + " records evaluated");
      } catch (cause) {
        if (!active.current || controller.signal.aborted) return;
        setRunDurationMs(performance.now() - started); setError(cause instanceof Error ? cause.message : "Could not evaluate this model."); setState(completed ? "done" : "idle");
      } finally { if (modelAbort.current === controller) modelAbort.current = null; }
      return;
    }
    // Legacy saved-run loading is retained for existing workspace results.
    if (live && selectedModel === "saved-jev") {
      setRunWasLive(true);
      try {
        message("Saving both datasets and preparing the comparison…");
        const source = (dataset: SelectedDataset) => ({ name: dataset.name, rows: dataset.rows, nameField: dataset.nameField, idField: dataset.idField });
        const body = JSON.stringify({ dataset1: source(first), dataset2: source(second) });
        if (new Blob([body]).size > 20 * 1024 * 1024) throw new Error("The two datasets together exceed the 20 MB matching limit. Split them into smaller comparisons.");
        const result = await apiFetch<{ importId: string; summary: ImportSummary }>("/api/dataset-matches", { method: "POST", body });
        if (!active.current) return; setRunId(result.importId); onStarted(result.summary); message("Your comparison is queued. Waiting for the matching service…");
      } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not start this comparison."); setState("idle"); }
      return;
    }
    try {
      let computeMs = performance.now();
      const comparison = prepareLocalComparison(first, second);
      computeMs = performance.now() - computeMs;
      message("Scoring names, identifiers and shared identity fields.");
      let cursor = 0; const batch = Math.max(1, Math.ceil(comparison.total / 120));
      const tick = () => {
        if (!active.current) return;
        const next: Decision[] = [];
        const batchStarted = performance.now();
        for (let n = 0; n < batch && cursor < comparison.total; n++) next.push(comparison.compareRow(cursor++));
        computeMs += performance.now() - batchStarted;
        setDecisions((previous) => [...previous, ...next]); setProcessed(cursor);
        if (next.length) { const last = next.at(-1)!; message(last.name + " · " + laneLabels[last.lane]); }
        if (cursor < comparison.total) timer.current = window.setTimeout(tick, 24);
        else { timer.current = null; setRunDurationMs(computeMs); setState("settling"); message("Complete · " + count(comparison.total) + " records compared"); }
      };
      timer.current = window.setTimeout(tick, 450);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not compare these datasets."); setState("idle"); }
  }
  function resultRows(rows: FlowRow[]): Decision[] {
    return rows.filter((row) => row.outcome).map((row) => {
      const confidence = row.confidence ?? 0;
      const lane: Lane = row.outcome === "unmatched" || row.outcome === "insufficient_evidence" || confidence < .65 ? "low"
        : row.outcome === "different" && confidence >= .9 ? "no-match"
        : row.outcome !== "equivalent" || row.requiresReview || confidence < .9 ? "review" : "strong";
      const pair = first && second ? assessRecordPair(row.sourceFields ?? second.rows[row.sourceRowNumber - 1] ?? {}, row.matchedFields ?? {}, { sourceNameField: second.nameField, targetNameField: first.nameField, sourceIdField: second.idField, targetIdField: first.idField }) : null;
      const assessment = pair ? { ...pair, candidateCount: row.internalRecordId ? 1 : 0, margin: null, searchLimited: true, alternatives: [] } : undefined;
      const needsEvidenceReview = lane === "strong" && (!assessment || !automaticMatchAllowed(assessment));
      return { rowIndex: row.sourceRowNumber - 1, name: row.displayName, targetIndex: null, targetRecordId: row.internalRecordId, targetName: row.internalDisplayName, sourceFields: row.sourceFields, matchedFields: row.matchedFields, confidence: row.confidence, lane: needsEvidenceReview ? "review" : lane, assessment, modelId: "saved-jev", resolvedModel: row.modelVersion ?? undefined, explanation: (row.explanation || (row.outcome === "unmatched" ? "No candidate found; a match could not be established" : row.outcome!.replaceAll("_", " "))) + (needsEvidenceReview ? " The current evidence rule requires review." : "") + " Alternative candidates and score margins are unavailable for this saved run." };
    });
  }
  function acceptFlow(flow: RunFlow) {
    setProcessed(flow.processedRowCount);
    setDecisions(resultRows(flow.sourceRows));
  }
  async function finishLive(status: string) {
    if (status === "failed") { setState("failed"); setError("Matching was interrupted. Check the latest activity, then retry or edit your sources."); return; }
    if (!runId || resultsLoading) return;
    setResultsLoading(true); setError(""); message("Collecting all matching results…");
    try {
      const firstPage = await apiFetch<ResultPage>("/api/runs/" + runId + "/results?offset=0&limit=500");
      const rows = [...firstPage.rows];
      for (let offset = firstPage.nextOffset; offset !== null;) {
        const page = await apiFetch<ResultPage>("/api/runs/" + runId + "/results?offset=" + offset + "&limit=500");
        rows.push(...page.rows);
        if (page.nextOffset !== null && page.nextOffset <= offset) throw new Error("The saved results could not be paged correctly.");
        offset = page.nextOffset;
        if (!active.current) return;
      }
      if (!["completed", "review"].includes(firstPage.status) || rows.length !== firstPage.total || rows.length !== firstPage.expectedTotal || rows.some((row) => !row.outcome) || new Set(rows.map((row) => row.sourceRowNumber)).size !== rows.length) throw new Error("Some matching results are still missing. Reload the saved results in a moment.");
      if (!active.current) return;
      setDecisions(resultRows(rows)); setProcessed(rows.length); setState("settling"); message("Complete · " + count(rows.length) + " results saved");
    } catch (cause) { if (active.current) { setState("failed"); setError(cause instanceof Error ? cause.message : "Could not load all saved results."); } }
    finally { if (active.current) setResultsLoading(false); }
  }
  function download() {
    const quote = (value: unknown) => {
      const text = String(value ?? "");
      const safe = /^[=+@-]/.test(text.trimStart()) || /^[\t\r\n]/.test(text) ? "'" + text : text;
      return '"' + safe.replaceAll('"', '""') + '"';
    };
    const csv = [["Dataset 2 row", "Dataset 2 record", "Dataset 2 identifier", "Dataset 1 row or record ID", "Dataset 1 record", "Dataset 1 identifier", "Outcome", "Assessed candidate row", "Assessed candidate name", "Evidence score", "Score version", "Field coverage percent", "Conflicts", "Candidate margin", "Candidates considered", "Search limited", "Model confidence (uncalibrated)", "Model", "Resolved model", "Latency ms", "Reported cost USD", "Cached", "Explanation", "Field evidence JSON"], ...decisions.map((row) => [row.rowIndex + 1, row.name, second?.idField ? (row.sourceFields ?? second.rows[row.rowIndex])?.[second.idField] : "", row.targetRecordId ?? (row.targetIndex === null ? "" : row.targetIndex + 1), row.targetName ?? "", first?.idField ? (row.matchedFields ?? (row.targetIndex === null ? undefined : first.rows[row.targetIndex]))?.[first.idField] : "", laneLabels[row.lane], row.assessment?.assessedTargetIndex == null ? "" : row.assessment.assessedTargetIndex + 1, row.assessment?.assessedTargetName ?? "", row.assessment?.score ?? "", row.assessment?.scoreVersion ?? "", row.assessment?.coverage ?? "", row.assessment?.conflicts.join("; ") ?? "", row.assessment?.margin ?? "", row.assessment?.candidateCount ?? "", row.assessment?.searchLimited ?? "", row.confidence ?? "", row.modelId ?? "local", row.resolvedModel ?? "", row.latencyMs ?? "", row.costUsd ?? "", row.cached ?? false, row.explanation, JSON.stringify(row.assessment?.components ?? [])])].map((row) => row.map(quote).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = "matching-results.csv"; a.hidden = true;
    document.body.appendChild(a); a.click(); a.remove();
    // Give embedded browsers time to begin reading the blob before releasing it.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  const total = second?.rows.length ?? 0;
  const bins = (["strong", "review", "low", "no-match"] as const).map((lane) => ({ lane, total: decisions.filter((row) => row.lane === lane).length }));
  const filtered = decisions.filter((row) => (resultFilter === "all" || row.lane === resultFilter) && (!resultQuery || [row.name, row.targetName ?? "", String(row.rowIndex + 1)].some((value) => value.toLowerCase().includes(resultQuery.toLowerCase())))).sort((a, b) => resultSort === "row" ? a.rowIndex - b.rowIndex : (resultSort === "score-desc" ? -1 : 1) * ((a.assessment?.score ?? -1) - (b.assessment?.score ?? -1)) || a.rowIndex - b.rowIndex);
  const pageSize = 50;
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(resultPage, pages - 1);
  const inspected = decisions.find((row) => row.rowIndex === expandedRow);
  const scored = decisions.filter((row) => row.assessment);
  const averageScore = scored.length ? scored.reduce((sum, row) => sum + row.assessment!.score, 0) / scored.length : null;
  const conflictRows = decisions.filter((row) => row.assessment?.conflicts.length).length;
  const matchingChoices = live ? [...modelChoices, { ...(modelChoices.find((model) => model.kind === "jev") ?? DEFAULT_MODEL_CHOICES[1]), id: "saved-jev", name: "Jev · saved workspace run", configured: savedRunConfigured }] : modelChoices;
  const stage = state === "idle" ? 0 : state === "done" ? 2 : 1;
  useEffect(() => {
    if (visible && previousStage.current !== stage) journeyHeading.current?.focus({ preventScroll: true });
    previousStage.current = stage;
  }, [stage, visible]);
  const ready = Boolean(first && second && !firstBusy && !secondBusy);
  const replayRows = decisions.slice(-32);
  useEffect(() => {
    if (!replaying) return;
    const id = window.setTimeout(() => {
      if (replayCount >= replayRows.length) setReplaying(false);
      else setReplayCount((value) => value + 1);
    }, replayCount >= replayRows.length ? 1400 : 460);
    return () => window.clearTimeout(id);
  }, [replaying, replayCount, replayRows.length]);
  const flow = visible && first && second ? <MatchFlow dataset1={{ name: first.name, count: first.rows.length }} dataset2={{ name: second.name, count: second.rows.length }} records={replaying ? replayRows.slice(0, replayCount) : decisions} processed={replaying ? (replayRows[replayCount - 1]?.rowIndex ?? -1) + 1 : processed} running={running || replaying} complete={(state === "done" || state === "settling") && !replaying} onSettled={() => { if (state === "settling") setState("done"); }} /> : null;
  return <div className={"match-workspace journey journey-" + state} ref={workspaceTop}>
    <div className="journey-topline">
      <ol className="journey-steps" aria-label="Matching steps">{["Sources", "Match", "Results"].map((label, index) => <li key={label} className={index === stage ? "current" : index < stage ? "finished" : ""} aria-current={index === stage ? "step" : undefined}><span>{index < stage ? <Check size={11} /> : index + 1}</span>{label}</li>)}</ol>

      {state === "done" && <button className="text-link" onClick={newComparison} disabled={benchmarkBusy || firstBusy || secondBusy}><Plus size={14} />Match new datasets</button>}
    </div>
    <header className="journey-heading"><div><h1 ref={journeyHeading} tabIndex={-1}>{state === "done" ? "Your results" : state === "failed" ? "Matching paused" : state === "settling" ? "Matching complete" : running ? "Matching datasets" : "Match datasets"}</h1>
      {!processing && <p>{state === "done" ? count(processed) + " records compared" : state === "failed" ? "Your sources are still here." : "Add two datasets to find matching records."}{activeSample && <span className="journey-example">Synthetic sample</span>}</p>}</div>
      {state === "done" && <button className="button primary" onClick={download}><Download size={15} />Export CSV</button>}
    </header>
    {benchmarkBusy && <p className="comparison-matching-notice" role="status"><Loader2 size={15} className="spin" aria-hidden="true" />Model comparison is running.<button className="text-link" onClick={onCompareModels}>View progress <ArrowRight size={13} /></button></p>}
    <div hidden={state !== "idle"}>
      <SampleDatasetPicker disabled={processing || resultsLoading || benchmarkBusy || firstBusy || secondBusy} loadingId={loadingSampleId} selectedId={activeSample?.id} onSelect={(id) => void loadSample(id)} error={sampleError} />
      <div className="source-pair" key={sourceVersion}><SourceCard number={1} value={first} onChange={updateFirst} onBusyChange={setFirstBusy} disabled={state !== "idle" || benchmarkBusy || firstBusy || secondBusy} /><SourceCard number={2} value={second} onChange={updateSecond} onBusyChange={setSecondBusy} disabled={state !== "idle" || benchmarkBusy || firstBusy || secondBusy} /></div>
      <div className="matching-engine"><MatchingModelPicker label="Matching engine" value={selectedModel} models={matchingChoices} disabled={benchmarkBusy || firstBusy || secondBusy} onChange={setSelectedModel} /><div className="engine-description">{selectedModel === "local" ? <><b>Repeatable, field by field</b><span>Names, shared IDs and identity attributes.</span></> : selectedModel === "saved-jev" ? <><b>Jev · saved workspace run</b><span>Jev evaluates candidates; independent field evidence guards each match.</span></> : modelChoices.find((model) => model.id === selectedModel)?.kind === "jev" ? <><b>Recommended · Jev + field evidence</b><span>Jev makes the relationship judgment; deterministic checks block unsupported matches.</span></> : <><b>Model judgment + deterministic evidence</b><span>Record decisions include a field-by-field evidence score.</span></>}</div></div>      {catalogueError && <details className="engine-catalogue-note"><summary>Model catalogue status</summary><p>{catalogueError}</p><button className="text-link" onClick={() => { setCatalogueError(""); setCatalogueVersion((value) => value + 1); }}>Retry catalogue</button></details>}
      <div className="journey-next"><div className={"source-readiness " + (ready ? "ready" : "")}><span>{ready ? <Check size={13} /> : firstBusy || secondBusy ? <Loader2 size={13} className="spin" /> : <Plus size={13} />}</span>{firstBusy || secondBusy ? "Reading your data" : ready ? count(total) + " records to compare against Dataset 1" : !first && !second ? "Add both datasets to continue" : !first ? "Add Dataset 1 to continue" : "Add Dataset 2 to continue"}</div><button className="button primary" disabled={!ready || benchmarkBusy || !matchingChoices.some((model) => model.id === selectedModel && model.configured)} onClick={() => void start()}>Match datasets <ArrowRight size={15} /></button></div>
      <div className="journey-source-footer"><details className="source-format-help"><summary>Formats & limits <ChevronDown size={13} /></summary><div><p><b>Files</b> CSV, TSV, TXT, XLSX, JSON, JSONL / NDJSON, XML.</p><p><b>Paste or link</b> Spreadsheet cells, structured text, or a public HTTPS data link. Links must allow browser access.</p><p><b>Limits</b> 10,000 rows and 20 MB per source; 20 MB combined for cloud matching.</p><p><b>Other formats</b> Export XLS, ODS, Parquet or database tables as CSV. Extract tables from PDFs first.</p></div></details><span className="journey-privacy"><LockKeyhole size={12} aria-hidden="true" />{selectedModel === "local" ? "Local · stays in this browser" : selectedModel === "saved-jev" ? "Records sent to the selected provider; usage may be billed. Results saved to this workspace." : "Selected records sent to the chosen provider; usage may be billed."}</span></div>
    </div>
    {error && <p role="alert" className="source-error">{error}</p>}
    {(processing || state === "failed") && <section className="process-panel" aria-label="Matching progress">
      <div className="process-topline"><span className="process-phase"><i className={running ? "phase-active" : ""} />{state === "settling" ? "Complete" : resultsLoading ? "Finishing" : state === "failed" ? "Interrupted" : runId && !processed ? "Queued" : processed ? "Comparing records" : "Preparing"}</span><span className="process-count"><strong>{count(processed)}</strong><span> / {count(total)}</span></span></div>
      <div className="process-meter" role="progressbar" aria-label="Records compared" aria-valuemin={0} aria-valuemax={total} aria-valuenow={processed}><i style={{ width: (total ? Math.min(100, processed / total * 100) : 0) + "%" }} /></div>
      {flow}
      <div className="process-legend">{bins.map(({ lane }) => <span key={lane} className={lane}><OutcomeIcon lane={lane} />{laneLabels[lane]}</span>)}</div>
      <div className="process-stream"><div className="stream-history" aria-hidden="true">{messages.slice(-2, -1).map((text) => <p key={text}>{text}</p>)}</div><div className="stream-now" role="status" aria-live="polite"><span className={running ? "stream-live-dot" : ""}>{state === "settling" ? <Check size={13} /> : !running ? <X size={13} /> : null}</span><span key={messages.at(-1)}>{messages.at(-1)}</span></div><details className="process-activity"><summary>Activity <ChevronDown size={12} /></summary><ol>{messages.map((text, index) => <li key={index}>{text}</li>)}</ol></details></div>
      <div className="process-note">{total > 12 ? "Squares show a sample of results" : ""}{state === "failed" && <button className="text-link" disabled={resultsLoading} onClick={reset}><RotateCcw size={12} />Edit sources</button>}</div>
      {running && modelAbort.current && <button className="text-link" onClick={() => { cancelCurrent(); setState(decisions.length ? "done" : "idle"); message("Matching stopped"); setError("Stopped at " + count(processed) + " of " + count(total) + " records. An in-flight provider request may still incur cost."); }}>Stop matching</button>}
      {state === "failed" && runId && <button className="button quiet small" disabled={resultsLoading} onClick={() => void finishLive("completed")}>Reload results</button>}
      {runId && running && !resultsLoading && <LiveRun runId={runId} onFlow={acceptFlow} onMessage={message} onDone={(status) => void finishLive(status)} />}
    </section>}
    {state === "done" && decisions.length > 0 && <>
      <div className="results-completion"><span><i><Check size={14} /></i>{processed === total ? "Matching complete" : count(processed) + " of " + count(total) + " records evaluated"}</span><button className="text-link" disabled={replaying} onClick={() => { setReplayCount(0); setReplaying(true); }}><RotateCcw size={12} />{replaying ? "Replaying saved results" : "Replay"}</button></div>
      <div className="result-metrics"><div><span>Average evidence</span><strong>{averageScore === null ? "—" : averageScore.toFixed(1)}<small>/100</small></strong></div><div><span>With conflicts</span><strong>{count(conflictRows)}</strong></div><div><span>{selectedModel === "local" ? "Compute time" : "Elapsed time"}</span><strong>{runDurationMs === null ? "—" : (runDurationMs / 1000).toFixed(2)}<small>s</small></strong></div><div><span>Needs review</span><strong>{count(decisions.filter((row) => row.lane === "review" || row.lane === "low").length)}</strong></div></div>
      <p className="results-score-note">Select a record to inspect its score and field evidence.{modelCost !== null ? " · Reported cost $" + modelCost.toFixed(4) : ""}</p>
      {replaying && <div className="result-replay" aria-label="Replay of saved results">{flow}</div>}
      <section className="results-panel" aria-label="Matching results">
        <div className="result-filters" aria-label="Filter results"><button className={resultFilter === "all" ? "active" : ""} aria-pressed={resultFilter === "all"} onClick={() => { setResultFilter("all"); setExpandedRow(null); }}>All <b>{count(decisions.length)}</b></button>{bins.map(({ lane, total: amount }) => <button key={lane} className={(resultFilter === lane ? "active " : "") + lane} aria-pressed={resultFilter === lane} onClick={() => { setResultFilter(lane); setExpandedRow(null); }}><OutcomeIcon lane={lane} />{laneLabels[lane]}<b>{count(amount)}</b></button>)}</div>
        <div className="result-tools"><input aria-label="Search matching results" placeholder="Find a record or row…" value={resultQuery} onChange={(event) => { setResultQuery(event.target.value); setResultPage(0); }} /><label>Sort<select aria-label="Sort matching results" value={resultSort} onChange={(event) => { setResultSort(event.target.value as typeof resultSort); setResultPage(0); }}><option value="row">Source order</option><option value="score-desc">Highest score</option><option value="score-asc">Lowest score</option></select></label></div>
        <div className="journey-results-scroll scored-results"><table><thead><tr><th><span className="result-source source-two"><Table2 size={13} aria-hidden="true" />Dataset 2</span></th><th><span className="result-source source-one"><Table2 size={13} aria-hidden="true" />Dataset 1</span></th><th>Score</th><th>Result</th></tr></thead><tbody>{filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map((row) => <tr key={row.rowIndex}><td><button className="result-record-name" onClick={() => setExpandedRow(row.rowIndex)}>{row.name}</button><span className="result-row-number">Row {row.rowIndex + 1}{row.assessment?.conflicts.length ? " · " + row.assessment.conflicts.length + " conflicts" : ""}</span></td><td>{row.targetName ?? <span className="result-empty">—</span>}</td><td><EvidenceScore assessment={row.assessment} name={row.name} onClick={() => setExpandedRow(row.rowIndex)} /></td><td><button className={"result-explanation-toggle " + row.lane} aria-label={"Inspect " + row.name + ": " + laneLabels[row.lane]} onClick={() => setExpandedRow(row.rowIndex)}><OutcomeIcon lane={row.lane} />{laneLabels[row.lane]}<ArrowRight size={12} /></button></td></tr>)}</tbody></table>{!filtered.length && <div className="results-empty">No records in this group.</div>}</div>
        <div className="results-pagination"><span>{filtered.length ? count(currentPage * pageSize + 1) + "–" + count(Math.min((currentPage + 1) * pageSize, filtered.length)) : "0"} of {count(filtered.length)}</span><div><button disabled={currentPage === 0} onClick={() => setResultPage(currentPage - 1)} aria-label="Previous results page">←</button><span>{currentPage + 1} / {pages}</span><button disabled={currentPage >= pages - 1} onClick={() => setResultPage(currentPage + 1)} aria-label="Next results page">→</button></div></div>
        <div className="results-bottom"><span>{runWasLive ? "Records were sent to the selected provider. Results saved to this workspace." : "Export includes all records, scores and field evidence"}</span><button className="text-link" onClick={reset} disabled={benchmarkBusy}>Edit sources</button></div>
      </section>
    </>}
    {inspected && <RecordInspector row={inspected} sourceFields={inspected.sourceFields ?? second?.rows[inspected.rowIndex]} targetFields={inspected.matchedFields ?? ((inspected.targetIndex ?? inspected.assessment?.assessedTargetIndex) == null ? null : first?.rows[(inspected.targetIndex ?? inspected.assessment?.assessedTargetIndex)!])} onClose={closeInspector} />}
  </div>;
}
