import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, CircleHelp, Minus, ShieldCheck, X } from "lucide-react";
import type { RecordAssessment } from "../lib/record-scoring";
import "./record-inspector.css";

export type InspectableDecision = {
  rowIndex: number;
  name: string;
  targetName: string | null;
  targetIndex: number | null;
  lane: "strong" | "review" | "low" | "no-match";
  explanation: string;
  confidence: number | null;
  assessment?: RecordAssessment;
  modelId?: string;
  resolvedModel?: string;
  provider?: string | null;
  latencyMs?: number;
  costUsd?: number | null;
  cached?: boolean;
  fingerprint?: string;
};

const labels = { strong: "Match", review: "Review", low: "Low confidence", "no-match": "No match" };
const number = (value: number) => new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(value);

export function EvidenceScore({ assessment, onClick, name }: { assessment?: RecordAssessment; onClick: () => void; name: string }) {
  return <button className={"evidence-score " + (assessment?.conflicts.length ? "has-conflict" : "")} onClick={onClick} aria-label={"Inspect score and evidence for " + name} title="Deterministic evidence score, out of 100">
    <span>{assessment ? number(assessment.score) : "—"}<small>/100</small></span>
    <i aria-hidden="true"><b style={{ width: (assessment?.score ?? 0) + "%" }} /></i>
  </button>;
}

export default function RecordInspector({ row, sourceFields, targetFields, onClose }: { row: InspectableDecision; sourceFields?: Record<string, unknown>; targetFields?: Record<string, unknown> | null; onClose: () => void }) {
  const panel = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [fieldFilter, setFieldFilter] = useState<"all" | "conflict">("all");
  const assessment = row.assessment;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    close.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;
      const focusable = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, select, textarea, summary, [tabindex="0"]') ?? []).filter((element) => element.getClientRects().length > 0);
      const first = focusable[0]; const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); document.body.style.overflow = overflow; previous?.focus(); };
  }, [onClose]);
  const fields = [...new Set([...Object.keys(sourceFields ?? {}), ...Object.keys(targetFields ?? {})])].sort();
  const display = (value: unknown) => value === null || value === undefined || value === "" ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return <div className="record-inspector-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="record-inspector" role="dialog" aria-modal="true" aria-labelledby="record-inspector-title" ref={panel}>
      <header className="inspector-header"><div><span>Record {row.rowIndex + 1}</span><h2 id="record-inspector-title">Match evidence</h2></div><button className="icon-button" ref={close} onClick={onClose} aria-label="Close record inspection"><X size={20} /></button></header>
      <div className="inspector-body">
        <div className="inspector-pair"><div><small>Dataset 2</small><strong>{row.name}</strong></div><span aria-hidden="true">↔</span><div><small>{row.targetName ? "Dataset 1" : assessment?.assessedTargetName ? "Dataset 1 · assessed candidate" : "Dataset 1"}</small><strong>{row.targetName ?? assessment?.assessedTargetName ?? (assessment?.candidateCount ? "No candidate selected" : "No candidate found")}</strong></div></div>
        <div className={"inspector-score-card " + row.lane}><div><span>Evidence score</span><strong>{assessment ? number(assessment.score) : "—"}<small> / 100</small></strong></div><span className={"inspector-outcome " + row.lane}>{labels[row.lane]}</span></div>
        <p className="inspector-reason">{row.explanation}</p>
        <div className="inspector-facts"><div><span>Field coverage</span><b>{assessment ? number(assessment.coverage) + "%" : "—"}</b></div><div><span>Identity conflicts</span><b className={assessment?.conflicts.length ? "conflict-value" : ""}>{assessment?.conflicts.length ?? "—"}</b></div><div><span>Lead over next</span><b>{assessment?.margin == null ? "—" : number(assessment.margin) + " pts"}</b></div></div>
        {assessment && <>
          <div className="inspector-section-heading"><h3>Field evidence</h3>{assessment.conflicts.length > 0 && <button className={fieldFilter === "conflict" ? "active" : ""} onClick={() => setFieldFilter(fieldFilter === "all" ? "conflict" : "all")}>{fieldFilter === "all" ? "Show conflicts" : "Show all"}</button>}</div>
          <div className="inspector-fields">{assessment.components.filter((field) => fieldFilter === "all" || assessment.conflicts.includes(field.field)).map((field, index) => <div className={"inspector-field " + field.status} key={field.field + index}>
            <div className="inspector-field-label"><span>{field.status === "agree" ? <Check size={13} /> : field.status === "conflict" ? <X size={13} /> : field.status === "missing" ? <Minus size={13} /> : <CircleHelp size={13} />}{field.label}</span><small title={field.explanation}>{field.status === "agree" ? "Agrees" : field.status === "similar" ? "Similar" : field.status === "missing" ? "Missing" : "Conflicts"}</small></div>
            <div className="inspector-field-values"><span>{field.sourceValue || "—"}</span><span>{field.targetValue || "—"}</span></div>
            <small className="inspector-field-points">{number(field.contribution)} / {number(field.weight)} evidence points</small>
          </div>)}</div>
          <details className="inspector-method"><summary><ShieldCheck size={14} />How this score is calculated<ChevronDown size={13} /></summary><p>Agreement points ÷ available field weights × 100, rounded to a whole point. Missing values add no agreement. Name-only evidence is capped at 65; identity conflicts cap the score at 49, or 25 when the selected shared ID differs.</p><p>This is not a probability of being correct. Automatic matches require at least 85 points, 75% coverage, identifying evidence, no blocking conflicts, and an 8-point lead when another candidate exists.</p><p>{assessment.scoreVersion} · {assessment.candidateCount} candidates considered{assessment.searchLimited ? " · candidate search was limited" : ""}. {assessment.candidateCount === 0 ? "Zero means no supporting candidate was found, not certainty that no match exists." : "The lead is the score difference from the next candidate, where available."}</p></details>
          {assessment.alternatives.length > 0 && <><h3 className="inspector-section-title">Other candidates</h3><div className="inspector-alternatives">{assessment.alternatives.filter((item) => item.targetIndex !== row.targetIndex).slice(0, 4).map((item) => <div key={item.targetIndex}><span><strong>{item.targetName}</strong><small>Dataset 1 · row {item.targetIndex + 1}{item.conflicts.length ? " · " + item.conflicts.length + " conflicts" : ""}</small></span><b>{number(item.score)}<small>/100</small></b></div>)}</div></>}
        </>}
        {row.modelId && row.modelId !== "local" && <details className="inspector-method"><summary>Model & run details<ChevronDown size={13} /></summary><dl className="inspector-provenance"><dt>Model</dt><dd>{row.resolvedModel ?? row.modelId}</dd><dt>Provider</dt><dd>{row.provider ?? "Not returned"}</dd><dt>Model confidence</dt><dd>{row.confidence == null ? "Not provided" : number(row.confidence * 100) + "% · uncalibrated"}</dd><dt>Response time</dt><dd>{row.latencyMs == null ? "Not available" : number(row.latencyMs) + " ms"}{row.cached ? " · saved response" : ""}</dd><dt>Reported cost</dt><dd>{row.costUsd == null ? "Not returned" : "$" + row.costUsd.toFixed(6)}</dd>{row.fingerprint && <><dt>Run fingerprint</dt><dd className="inspector-hash">{row.fingerprint}</dd></>}</dl></details>}
        <details className="inspector-method inspector-raw"><summary>All imported fields <small>{fields.length}</small><ChevronDown size={13} /></summary><div className="inspector-raw-scroll"><table><thead><tr><th>Field</th><th>Dataset 2</th><th>Dataset 1</th></tr></thead><tbody>{fields.map((field) => <tr key={field}><th>{field}</th><td>{display(sourceFields?.[field])}</td><td>{display(targetFields?.[field])}</td></tr>)}</tbody></table></div></details>
      </div>
    </section>
  </div>;
}
