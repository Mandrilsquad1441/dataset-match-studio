import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Check, Minus, X } from "lucide-react";
import "./ModelComparisonProgress.css";

type Outcome = "strong" | "review" | "low" | "no-match";

export interface ModelComparisonProgressModel {
  id: string;
  name: string;
  status: "running" | "complete" | "failed" | "cancelled";
  completedRecords: number;
  durationMs: number | null;
  counts?: { strong: number; review: number; low: number; "no-match": number };
  errorCount?: number;
}

export interface ModelComparisonProgressProps {
  models: ModelComparisonProgressModel[];
  sampleSize: number;
  elapsedMs: number;
  busy: boolean;
}

const palette = [
  { color: "#47789d", wash: "#eff5fa", line: "#d7e4ef" },
  { color: "#78669a", wash: "#f5f1fa", line: "#e4daef" },
  { color: "#347e80", wash: "#eef7f6", line: "#d4e9e6" },
];
const outcomes: Outcome[] = ["strong", "review", "low", "no-match"];
const outcomeLabels = { strong: "Match", review: "Review", low: "Low", "no-match": "No match" };
const count = (value: number) => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
const duration = (value: number | null) => value === null || !Number.isFinite(value) ? null : value < 1000 ? `${Math.max(0, Math.round(value))} ms` : value < 60000 ? `${(value / 1000).toFixed(1)} s` : `${Math.floor(value / 60000)}m ${Math.floor(value % 60000 / 1000)}s`;

/** Aggregate outcome sample, never a claim about record order or partial progress. */
function outcomeSample(model: ModelComparisonProgressModel): Outcome[] {
  if (model.status !== "complete" || !model.counts) return [];
  const values = outcomes.map((lane) => count(model.counts![lane]));
  const total = values.reduce((sum, value) => sum + value, 0);
  const size = Math.min(12, total, count(model.completedRecords));
  if (!size || !total) return [];
  const shares = values.map((value) => value / total * size);
  const allocations = shares.map(Math.floor);
  const remainders = shares.map((share, index) => ({ index, remainder: share - allocations[index] })).sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  let left = size - allocations.reduce((sum, value) => sum + value, 0);
  for (const { index } of remainders) if (left > 0 && allocations[index] < values[index]) { allocations[index]++; left--; }
  return outcomes.flatMap((lane, index) => Array.from({ length: allocations[index] }, () => lane));
}

function summary(model: ModelComparisonProgressModel) {
  if (model.status === "running") return "Waiting for this model's complete response. The moving squares indicate a pending request, not completed records.";
  if (model.status === "failed") return "Request failed. No successful response was received.";
  if (model.status === "cancelled") return "Request stopped before a complete response was received.";
  const result = model.counts ? outcomes.map((lane) => `${count(model.counts![lane])} ${outcomeLabels[lane].toLowerCase()}`).join(", ") : "Outcome counts unavailable";
  return `${count(model.completedRecords)} completed records. ${result}.${model.errorCount ? ` ${count(model.errorCount)} record errors.` : ""} Squares are a small sample of the returned outcomes.`;
}

export default function ModelComparisonProgress({ models, sampleSize, elapsedMs, busy }: ModelComparisonProgressProps) {
  const root = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(true);
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    let intersecting = false;
    const update = () => setPaused(document.hidden || !intersecting);
    const observer = new IntersectionObserver(([entry]) => { intersecting = entry.isIntersecting; update(); });
    observer.observe(node);
    document.addEventListener("visibilitychange", update);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", update); };
  }, []);

  const hasOutcomes = models.some((model) => model.status === "complete" && outcomeSample(model).length > 0);
  const elapsed = duration(elapsedMs);
  return <div ref={root} className={"model-comparison-progress" + (paused ? " is-paused" : "") + (!busy ? " is-compact" : "")} aria-label="Model response progress">
    <div className="mcp-lanes" role="list">
      {models.map((model, index) => {
        const theme = palette[index % palette.length];
        const errors = count(model.errorCount ?? 0);
        const completed = count(model.completedRecords);
        const partial = model.status === "complete" && (errors > 0 || completed < count(sampleSize));
        const status = partial ? "partial" : model.status;
        const label = status === "running" ? "Awaiting response" : status === "partial" ? "Partial response" : status === "complete" ? "Complete" : status === "failed" ? "Request failed" : "Stopped";
        const nodes = outcomeSample(model);
        const time = duration(model.durationMs);
        return <div key={model.id} className={"mcp-lane is-" + status} role="listitem" style={{ "--mcp-accent": theme.color, "--mcp-wash": theme.wash, "--mcp-line": theme.line } as CSSProperties}>
          <div className="mcp-model"><span className="mcp-model-mark" aria-hidden="true" /><strong title={model.name}>{model.name}</strong></div>
          <div className="mcp-visual" role="img" aria-label={summary(model)}>
            <div className="mcp-source" aria-hidden="true">{Array.from({ length: Math.min(6, count(sampleSize)) }, (_, square) => <i key={square} />)}</div>
            <div className="mcp-route" aria-hidden="true"><span className="mcp-route-line" />{model.status === "running" && busy && <><span className="mcp-courier" /><span className="mcp-courier mcp-courier-second" /></>}</div>
            <div className="mcp-destination" aria-hidden="true">
              {nodes.length ? <div className="mcp-outcomes">{nodes.map((lane, square) => <i key={square} className={"mcp-outcome " + lane} style={{ "--mcp-arrival": `${square * 27}ms` } as CSSProperties} />)}</div> : model.status === "failed" ? <X className="mcp-empty-mark" size={14} /> : model.status === "cancelled" ? <Minus className="mcp-empty-mark" size={14} /> : model.status === "complete" ? <span className="mcp-empty-response">—</span> : <span className="mcp-open-result" />}
            </div>
          </div>
          <div className="mcp-details">
            <span className="mcp-state" role="status">{status === "complete" ? <Check size={12} aria-hidden="true" /> : status === "failed" ? <X size={12} aria-hidden="true" /> : status === "cancelled" ? <Minus size={12} aria-hidden="true" /> : <i aria-hidden="true" />}{label}</span>
            {model.status !== "running" && <span className="mcp-response-meta"><span>{model.status === "complete" ? `${completed.toLocaleString()}${partial ? ` / ${count(sampleSize).toLocaleString()}` : ""} records${errors ? ` · ${errors.toLocaleString()} failed` : ""}` : completed ? `${completed.toLocaleString()} records returned` : "No response"}</span>{time && <span className="mcp-duration">{time}</span>}</span>}
          </div>
        </div>;
      })}
    </div>
    <div className="mcp-footnote">
      {hasOutcomes ? <div className="mcp-legend" aria-label="Outcome colors">{outcomes.map((lane) => <span key={lane}><i className={lane} aria-hidden="true" />{outcomeLabels[lane]}</span>)}</div> : <span />}
      {busy && elapsed && <span className="mcp-elapsed">{elapsed} elapsed</span>}
    </div>
  </div>;
}
