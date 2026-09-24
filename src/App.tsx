import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownUp, ArrowRight, BadgeCheck, Bell, BookOpenCheck, Boxes, Check, CheckCircle2,
  ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Clock3, CloudUpload, Command,
  Database, FileSpreadsheet, FileText, Filter, FlaskConical, GitCompareArrows, GitMerge, Globe2,
  Hash, Layers3, ListChecks, LockKeyhole, MoreHorizontal, PanelLeftClose, Plus, Search,
  Settings2, ShieldCheck, Sparkles, Trash2, Upload, X, XCircle, Zap,
} from "lucide-react";
import MatchWorkspace from "./components/MatchWorkspace";
import ModelComparisonPage from "./components/ModelComparisonPage";
import { MatchingSessionProvider } from "./lib/matching-session";
import "./styles/shell.css";
import { ApiError, apiFetch, liveMode } from "./lib/api";
import { internalRecords, sampleReviewPair, vendorRows } from "./lib/fixtures";
import { normalizeText } from "./lib/normalize";

import { supabase, supabaseReady } from "./lib/supabase";
import type { ImportSummary, RecordType } from "./lib/types";
import { passesModelVersionApprovalGate } from "./lib/model-evaluation";

type Page = "overview" | "imports" | "matching" | "compare-models" | "review" | "records" | "settings" | "evaluations";

type ReviewAction = "accepted" | "rejected" | "related" | "insufficient_evidence";

const statusStyles: Record<string, string> = {
  review: "status-review", completed: "status-completed", queued: "status-queued", running: "status-running",
  failed: "status-failed", deleting: "status-running", accepted: "status-completed",
};

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en", { notation: value > 9999 ? "compact" : "standard" }).format(value);
}

function timeAgo(value: string): string {
  const minutes = Math.max(1, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 60) return minutes + "m ago";
  if (minutes < 1440) return Math.floor(minutes / 60) + "h ago";
  return Math.floor(minutes / 1440) + "d ago";
}

function IconMark() {
  return <div className="brand-mark" aria-hidden="true"><GitMerge size={21} strokeWidth={2} /></div>;
}

function SectionTitle({ eyebrow, title, subtitle, action }: { eyebrow?: string; title: string; subtitle?: string; action?: React.ReactNode }) {
  return <div className="section-title">
    <div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>
    {action && <div className="section-title-action">{action}</div>}
  </div>;
}

function Badge({ children, variant = "" }: { children: React.ReactNode; variant?: string }) {
  return <span className={"badge " + variant}>{children}</span>;
}

function AuthModal({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signup, setSignup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!supabase) return;
    setBusy(true);
    setMessage("");
    const result = signup
      ? await supabase.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } })
      : await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (result.error) setMessage(result.error.message);
    else if (signup) setMessage("Check your email to confirm your account, then sign in.");
    else onClose();
  }
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <div className="modal auth-modal">
      <button className="icon-button modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
      <div className="modal-icon"><LockKeyhole size={20} /></div>
      <div className="eyebrow">WORKSPACE ACCESS</div>
      <h2>{signup ? "Create your account" : "Sign in to Match Studio"}</h2>
      <p>Secure access to your datasets, matches and review history.</p>
      {!supabaseReady ? <div className="callout warning"><CircleHelp size={17} /> Add the Supabase public URL and anon key to <code>.env.local</code> to enable sign in.</div> :
        <form className="auth-form" onSubmit={submit}>
          <label>Email address<input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required autoComplete="email" placeholder="you@company.com" /></label>
          <label>Password<input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required minLength={8} autoComplete={signup ? "new-password" : "current-password"} placeholder="At least 8 characters" /></label>
          {message && <div className="form-message">{message}</div>}
          <button className="button primary full" disabled={busy}>{busy ? "Working…" : signup ? "Create account" : "Sign in"}<ArrowRight size={16} /></button>
      <button type="button" className="text-button" onClick={() => { setSignup(!signup); setMessage(""); }}>{signup ? "Already have an account? Sign in" : "New to Match Studio? Create an account"}</button>
        </form>}
    </div>
  </div>;
}

function ImportTable({ items, onOpenReview, onDeleteRun, deletingRunId }: { items: ImportSummary[]; onOpenReview: () => void; onDeleteRun?: (item: ImportSummary) => void; deletingRunId?: string | null }) {
  return <div className="table-card">
    <table className="data-table">
      <thead><tr><th>DATASET 1</th><th>DATASET 2</th><th>RECORDS</th><th>MATCHED</th><th>REVIEW</th><th>STATUS</th>{onDeleteRun && <th aria-label="Actions" />}</tr></thead>
      <tbody>{items.map((item) => <tr key={item.id} onClick={item.review ? onOpenReview : undefined} className={item.review ? "row-clickable" : ""}>
        <td><div className="run-file"><span className="file-chip"><Database size={15} /></span><span><strong>{item.dataset1Name ?? "Dataset 1"}</strong><small>{item.referenceDatasetId ? "Saved reference dataset" : "Reference records"} · {timeAgo(item.createdAt)}</small></span></div></td>
        <td>{item.dataset2Name ?? item.fileName}</td><td title="Dataset 1 / Dataset 2 records">{item.dataset1Rows !== null && item.dataset1Rows !== undefined ? formatNumber(item.dataset1Rows) + " / " : ""}{formatNumber(item.dataset2Rows ?? item.rows)}</td><td><span className="count-match">{formatNumber(item.matched)}</span></td><td>{item.review ? <button className="history-review-link" onClick={(event) => { event.stopPropagation(); onOpenReview(); }} aria-label={"Review " + item.review + " records"}>{formatNumber(item.review)}</button> : <span className="muted-number">—</span>}</td>
        <td><Badge variant={statusStyles[item.status] || "status-queued"}><span className="status-dot" />{item.status === "review" ? "Needs review" : item.status}</Badge></td>
        {onDeleteRun && <td className="history-run-actions">{item.referenceDatasetId && ["completed", "review", "failed", "deleting"].includes(item.status) && <button className="icon-button history-delete-button" type="button" title={item.status === "deleting" ? "Retry deletion" : "Delete comparison"} aria-label={(item.status === "deleting" ? "Retry deletion of " : "Delete ") + (item.dataset1Name ?? "Dataset 1") + " / " + (item.dataset2Name ?? item.fileName)} disabled={Boolean(deletingRunId)} onClick={(event) => { event.stopPropagation(); onDeleteRun(item); }}>{deletingRunId === item.id ? <span className="history-delete-spinner" aria-hidden="true" /> : <Trash2 size={15} />}</button>}</td>}
      </tr>)}</tbody>
    </table>
  </div>;
}

type ReviewPair = {
  reviewId: string | null;
  vendorName: string;
  sourceLine: string;
  internal: (typeof internalRecords)[number];
  vendor: (typeof vendorRows)[number];
  probabilities: { equivalent: number; related: number; different: number; insufficient_evidence: number };
  conflicts: string[];
  modelVersion: string;
  confidence: number;
};

const demoReview: ReviewPair = {
  reviewId: null,
  vendorName: "Northstar Data Co.",
  sourceLine: "Row 2 · site_register_q3.csv",
  internal: sampleReviewPair.internal,
  vendor: sampleReviewPair.vendor,
  probabilities: sampleReviewPair.probabilities,
  conflicts: ["identifier.registry"],
  modelVersion: "test-adapter-0.1",
  confidence: sampleReviewPair.score,
};

function ReviewCard({ pair, position, total, action, setAction, live, onPrevious, onNext }: { pair: ReviewPair; position: number; total: number; action: ReviewAction | null; setAction: (value: ReviewAction) => void; live: boolean; onPrevious: () => void; onNext: () => void }) {
  const probabilities = pair.probabilities;
  return <div className="review-workspace">
    <div className="review-toolbar"><div className="review-position"><span className="review-index">{String(position).padStart(2, "0")}</span><span>of {total} pending</span><span className="toolbar-divider" /><span className="review-vendor">Dataset 1 / Dataset 2</span></div><div className="toolbar-actions"><button className="button quiet small"><Filter size={14} /> Filter</button><button className="icon-button" onClick={onPrevious} disabled={position <= 1} aria-label="Previous review"><ChevronLeft size={16} /></button><button className="icon-button" onClick={onNext} disabled={position >= total} aria-label="Next review"><ChevronRight size={16} /></button></div></div>
    <div className="compare-header"><div><div className="eyebrow">RECORD COMPARISON</div><h2>{pair.conflicts.length ? "Conflicting evidence needs review" : "Compare supporting fields"}</h2><p>{pair.conflicts.length ? "The candidate has a conflicting identifier. Resolve this pair with the source fields in view." : "Review the persisted model decision against the preserved source row."}</p></div><Badge variant="status-review"><span className="status-dot" /> Human review</Badge></div>
    <div className="compare-grid">
      <RecordPanel side="internal" record={pair.internal} label="DATASET 1" icon={<Database size={15} />} conflicts={pair.conflicts} sourceLine={pair.internal.id} />
      <div className="compare-gutter"><div className="compare-symbol"><GitCompareArrows size={18} /></div><div className="gutter-line" /><div className="confidence-orb"><span>{Math.round(pair.confidence * 100)}</span><small>Jev</small></div><div className="gutter-line" /><div className="compare-symbol soft"><ArrowRight size={16} /></div></div>
      <RecordPanel side="vendor" record={pair.vendor} label="DATASET 2" icon={<Boxes size={15} />} conflicts={pair.conflicts} sourceLine={pair.sourceLine} />
    </div>
    <div className="evidence-card">
      <div className="evidence-head"><div><Sparkles size={16} /><strong>Decision evidence</strong></div><span>{pair.modelVersion} · relationship-v1</span></div>
      <div className="probability-list">
        {Object.entries(probabilities).map(([label, value]) => <div className="probability-row" key={label}>
          <span>{label === "insufficient_evidence" ? "Insufficient evidence" : label}</span><div className="probability-track"><i style={{ width: Math.max(3, value * 100) + "%" }} className={label === "equivalent" ? "bar-orange" : label === "related" ? "bar-blue" : "bar-neutral"} /></div><b>{Math.round(value * 100)}%</b>
        </div>)}
      </div>
      {pair.conflicts.length > 0 && <div className="evidence-callout conflict"><span className="evidence-icon"><XCircle size={15} /></span><p><strong>Conflicting evidence</strong><br />{pair.conflicts.join(", ")} differs between the records. Similar names alone do not establish a match.</p></div>}
    </div>
    <div className="review-actionbar">
      <div className="action-explainer"><ShieldCheck size={16} /><span>Actions are audited and can be reversed.</span></div>
      {action && <div className="preview-action-state"><CheckCircle2 size={15} />{live ? "Decision saved" : "Preview decision selected"}</div>}
      <div className="decision-buttons">
        <button className="button outline" onClick={() => setAction("rejected")}><X size={15} />Different</button>
        <button className="button outline" onClick={() => setAction("related")}><GitMerge size={15} />Related</button>
        <button className="button primary" onClick={() => setAction("accepted")}><Check size={15} />Same record</button>
      </div>
    </div>
  </div>;
}

function RecordPanel({ side, record, label, icon, conflicts, sourceLine }: { side: "internal" | "vendor"; record: (typeof internalRecords)[number]; label: string; icon: React.ReactNode; conflicts: string[]; sourceLine: string }) {
  const isVendor = side === "vendor";
  const fields = [
    { key: "record_type", name: "Record type", value: record.recordType },
    ...Object.entries(record.identifiers).map(([key, value]) => ({ key: "identifier." + key, name: key.replaceAll("_", " ") + " ID", value })),
    { key: "aliases", name: "Alternate names", value: record.aliases.join(", ") || "—" },
    ...Object.entries(record.fields)
      .filter(([key]) => key !== "display_name" && key !== "record_type")
      .slice(0, 6)
      .map(([key, value]) => ({ key, name: key.replaceAll("_", " "), value: typeof value === "object" ? JSON.stringify(value) : value })),
  ];
  return <div className={"record-panel " + side}>
    <div className="record-panel-head"><div className="record-label">{icon}<span>{label}</span></div>{isVendor && <span className="source-pill">{sourceLine}</span>}</div>
    <div className="record-name"><div className={"record-avatar " + (isVendor ? "avatar-vendor" : "")}>{isVendor ? "2" : "1"}</div><div><h3>{record.displayName}</h3><span>{isVendor ? "Dataset 2 record" : "Dataset 1 reference record"}</span></div><button className="icon-button panel-more"><MoreHorizontal size={17} /></button></div>
    <div className="record-fields">
      {fields.map((field) => <div className={"field-row single-field " + (conflicts.includes(field.key) ? "field-conflict" : "")} key={field.key}><span>{field.name}</span><strong>{String(field.value ?? "—")}</strong>{conflicts.includes(field.key) && <XCircle size={13} />}</div>)}
    </div>
    <div className="panel-source"><span className="source-led" />{isVendor ? "Dataset 2 source values" : "Dataset 1 source values"}</div>
  </div>;
}

type DashboardStats = {
  internalRecords: number;
  sites: number;
  projects: number;
  relationships: number;
  vendorObservations: number;
  confirmedLinks: number;
  activeVendors: number;
  pendingReviews: number;
  outcomes: { equivalent: number; related: number; review: number; unmatched: number };
  candidateRecall: number | null;
};

function Overview({ imports, stats, onNavigate, onNewImport }: { imports: ImportSummary[]; stats: DashboardStats; onNavigate: (page: Page) => void; onNewImport: () => void }) {
  const latest = imports[0];
  return <div className="page-stack">
    <div className="welcome-row"><div><div className="eyebrow">MATCH STUDIO</div><h1>Workspace overview</h1><p>Bring source records together and review the decisions that need attention.</p></div><button className="button primary" onClick={onNewImport}><Plus size={16} />New comparison</button></div>
    <section className="overview-focus-card"><div className="overview-focus-copy"><span className="overview-kicker"><span /> RECORD MATCHING</span><h2>See how your records connect.</h2><p>Follow each source row from import through its saved matching decision.</p><button className="button primary" onClick={() => onNavigate("matching")}>Open matching analysis <ArrowRight size={15} /></button></div><div className="overview-focus-visual" aria-hidden="true"><span className="overview-orbit orbit-one" /><span className="overview-orbit orbit-two" /><i className="overview-square square-one" /><i className="overview-square square-two" /><i className="overview-square square-three" /><i className="overview-square square-four" /><i className="overview-square square-five" /><span className="overview-core"><GitMerge size={23} /></span></div></section>
    <div className="overview-stat-strip"><div><span>Canonical records</span><b>{formatNumber(stats.internalRecords)}</b></div><div><span>Compared records</span><b>{formatNumber(stats.vendorObservations)}</b></div><button onClick={() => onNavigate("review")}><span>Needs your review</span><b>{formatNumber(stats.pendingReviews)} <ArrowRight size={15} /></b></button></div>
    <section className="overview-runs-card"><div className="panel-heading"><div><div className="eyebrow">RECENT ACTIVITY</div><h2>Comparison runs</h2><p>Recent dataset pairs and their current status.</p></div><button className="text-link" onClick={() => onNavigate("imports")}>All comparisons <ArrowRight size={14} /></button></div><ImportTable items={imports.slice(0, 3)} onOpenReview={() => onNavigate("review")} />{latest && <button className="overview-latest-run" onClick={() => onNavigate("matching")}><span><span className="run-indicator" />Latest run <b>{latest.dataset1Name ?? "Dataset 1"} / {latest.dataset2Name ?? latest.fileName}</b></span><span>Match datasets <ArrowRight size={14} /></span></button>}</section>
  </div>;
}

function ImportsPage({ imports, onNewImport, onOpenReview, live, canDeleteRuns, onDeleteRun, deletingRunId }: { imports: ImportSummary[]; onNewImport: () => void; onOpenReview: () => void; live: boolean; canDeleteRuns: boolean; onDeleteRun: (item: ImportSummary) => void; deletingRunId: string | null }) {
  const [filter, setFilter] = useState<"all" | "active" | "completed">("all");
  const activeRuns = imports.filter((item) => ["uploading", "queued", "profiling", "mapping", "retrieving", "deciding", "escalating", "deleting"].includes(item.status));
  const completedRuns = imports.filter((item) => item.status === "completed" || item.status === "review");
  const visibleImports = filter === "active" ? activeRuns : filter === "completed" ? completedRuns : imports;
  return <div className="page-stack history-page"><SectionTitle title="History" subtitle="Saved comparisons and their results." action={imports.length ? <button className="button primary" onClick={onNewImport}><Plus size={16} />New comparison</button> : undefined} />
    {imports.length ? <>
      <div className="list-toolbar"><div className="segmented"><button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>All <span>{formatNumber(imports.length)}</span></button><button className={filter === "active" ? "active" : ""} onClick={() => setFilter("active")}>In progress <span>{formatNumber(activeRuns.length)}</span></button><button className={filter === "completed" ? "active" : ""} onClick={() => setFilter("completed")}>Completed <span>{formatNumber(completedRuns.length)}</span></button></div></div>
      {visibleImports.length ? <ImportTable items={visibleImports} onOpenReview={onOpenReview} onDeleteRun={canDeleteRuns ? onDeleteRun : undefined} deletingRunId={deletingRunId} /> : <div className="history-empty-filter">No comparisons in this view.</div>}
      <p className="history-storage-note"><LockKeyhole size={14} />Cloud comparisons retain source rows until deleted.{canDeleteRuns && " Deleting a comparison permanently removes its source files and results."}</p>
    </> : <div className="history-empty"><div className="history-empty-icon"><GitCompareArrows size={25} strokeWidth={1.4} /></div><h2>Saved comparisons appear here</h2><p>{live ? "Start with two datasets. Your comparison and results will be saved to this workspace." : "Sign in to save cloud comparisons. Local comparisons stay in your browser."}</p><button className="button primary" onClick={onNewImport}>New comparison <ArrowRight size={15} /></button></div>}
  </div>;
}

type ApiReview = {
  id: string;
  vendorName: string;
  decision: {
    outcome?: string;
    probabilities?: Record<string, number>;
    confidence?: number;
    model_version?: string;
    conflicting_evidence?: unknown;
  } | null;
  observation: {
    id: string;
    record_type: "site" | "project";
    source_record_id?: string | null;
    vendor_record_key: string;
    raw_row?: Record<string, unknown>;
    normalized_data?: Record<string, unknown>;
    normalized_identifiers?: Record<string, string>;
    aliases?: string[];
  } | null;
  internal: {
    id: string;
    record_type: "site" | "project";
    display_name: string;
    normalized_identifiers?: Record<string, string>;
    aliases?: string[];
    normalized_data?: Record<string, unknown>;
    raw_values?: Record<string, unknown>;
  } | null;
};

function toFieldValues(value: Record<string, unknown> | undefined): Record<string, (typeof sampleReviewPair.internal.fields)[string]> {
  const convert = (item: unknown): (typeof sampleReviewPair.internal.fields)[string] => {
    if (item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean") return item;
    if (Array.isArray(item)) return item.map(convert);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([key, child]) => [key, convert(child)]));
    return String(item);
  };
  return Object.fromEntries(Object.entries(value ?? {}).map(([key, item]) => [key, convert(item)]));
}

function reviewPairFromApi(row: ApiReview): ReviewPair | null {
  if (!row.observation) return null;
  const type = row.observation.record_type;
  const vendor: ReviewPair["vendor"] = {
    id: row.observation.id,
    recordType: type,
    displayName: String(row.observation.normalized_data?.display_name ?? "Dataset 2 record"),
    identifiers: row.observation.normalized_identifiers ?? {},
    aliases: row.observation.aliases ?? [],
    fields: toFieldValues(row.observation.normalized_data),
  };
  const internalRow = row.internal;
  const internal: ReviewPair["internal"] = internalRow ? {
    id: internalRow.id,
    recordType: internalRow.record_type,
    displayName: internalRow.display_name,
    identifiers: internalRow.normalized_identifiers ?? {},
    aliases: internalRow.aliases ?? [],
    fields: toFieldValues(internalRow.normalized_data ?? internalRow.raw_values),
  } : {
    id: "No retrieved candidate",
    recordType: type,
    displayName: "No candidate retrieved",
    identifiers: {},
    aliases: [],
    fields: {},
  };
  const rawProbabilities = row.decision?.probabilities ?? {};
  const probabilities = {
    equivalent: Number(rawProbabilities.equivalent ?? 0),
    related: Number(rawProbabilities.related ?? 0),
    different: Number(rawProbabilities.different ?? 0),
    insufficient_evidence: Number(rawProbabilities.insufficient_evidence ?? 0),
  };
  const conflictValue = row.decision?.conflicting_evidence;
  const conflicts = Array.isArray(conflictValue) ? conflictValue.map(String) : [];
  return {
    reviewId: row.id,
    vendorName: row.vendorName,
    sourceLine: row.observation.source_record_id ?? row.observation.vendor_record_key.slice(0, 10),
    internal,
    vendor,
    probabilities,
    conflicts,
    modelVersion: row.decision?.model_version ?? "unknown",
    confidence: Number(row.decision?.confidence ?? 0),
  };
}

function ReviewPage({ live, onCountChange }: { live: boolean; onCountChange: (count: number) => void }) {
  const [action, setAction] = useState<ReviewAction | null>(null);
  const [reviews, setReviews] = useState<ApiReview[]>([]);
  const [index, setIndex] = useState(0);
  const [error, setError] = useState("");
  const [resolvedMessage, setResolvedMessage] = useState("");
  useEffect(() => {
    if (!live) return;
    let active = true;
    void apiFetch<{ reviews: ApiReview[] }>("/api/reviews").then((data) => {
      if (!active) return;
      setReviews(data.reviews);
      setIndex(0);
      onCountChange(data.reviews.length);
    }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Could not load reviews."); });
    return () => { active = false; };
  }, [live]);
  const pair = live ? (reviews[index] ? reviewPairFromApi(reviews[index]) : null) : demoReview;
  const total = live ? reviews.length : 1;
  async function submitDecision(value: ReviewAction) {
    setAction(value);
    setError("");
    setResolvedMessage("");
    if (!live) return;
    const review = reviews[index];
    if (!review) return;
    try {
      await apiFetch("/api/reviews/" + review.id + "/outcome", {
        method: "POST",
        body: JSON.stringify({ outcome: value, rationale: "Resolved in Match Studio review queue." }),
      });
      const next = reviews.filter((item) => item.id !== review.id);
      setReviews(next);
      setIndex(0);
      setAction(null);
      setResolvedMessage("Human decision saved and reused on future imports.");
      onCountChange(next.length);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the review decision.");
    }
  }
  return <div className="page-stack"><SectionTitle eyebrow="OPERATOR QUEUE" title="Review queue" subtitle="Resolve ambiguous pairs, inspect conflicts, and leave a durable decision trail." action={<div className="queue-counter"><span>{formatNumber(total)}</span> pending</div>} />
    <div className="review-filters"><div className="segmented"><button className="active">All <span>{formatNumber(total)}</span></button><button>Escalated</button><button>Ambiguous</button><button>Conflicts</button></div><button className="button quiet small"><ArrowDownUp size={14} />Oldest first</button></div>
    {pair ? <>
      <ReviewCard pair={pair} position={index + 1} total={total} action={action} setAction={(value) => void submitDecision(value)} live={live} onPrevious={() => { setIndex((current) => Math.max(0, current - 1)); setAction(null); }} onNext={() => { setIndex((current) => Math.min(total - 1, current + 1)); setAction(null); }} />
      <div className="review-next"><span><span className="status-dot" />{action ? "Preview decision selected" : "Decision required"} · <b>inspect the cited fields before resolving</b></span><button className="button quiet small" onClick={() => void submitDecision("insufficient_evidence")}>Insufficient evidence</button></div>
    </> : <div className="empty-queue"><div><CheckCircle2 size={22} /></div><h3>{live ? "Your queue is clear" : "No sample review selected"}</h3><p>{live ? "There are no pending review items in this workspace." : "Sample data includes one conflict for previewing the review flow."}</p></div>}
    {resolvedMessage && <div className="callout success"><CheckCircle2 size={16} />{resolvedMessage}</div>}
    {error && <div className="form-message error">{error}</div>}
  </div>;
}

type UiRecord = { id: string; recordType: RecordType; displayName: string; identifiers: Record<string, string>; aliases: string[]; fields: Record<string, unknown>; updatedAt: string | null };
type ApiRecord = { id: string; record_type: RecordType; display_name: string; normalized_identifiers?: Record<string, string>; aliases?: string[]; normalized_data?: Record<string, unknown>; raw_values?: Record<string, unknown>; updated_at?: string };

function fromApiRecord(record: ApiRecord): UiRecord {
  return { id: record.id, recordType: record.record_type, displayName: record.display_name, identifiers: record.normalized_identifiers ?? {}, aliases: record.aliases ?? [], fields: record.normalized_data ?? record.raw_values ?? {}, updatedAt: record.updated_at ?? null };
}

function RecordsPage({ live, stats, onRecordCreated }: { live: boolean; stats: DashboardStats; onRecordCreated: (recordType: RecordType) => void }) {
  const [search, setSearch] = useState("");
  const [records, setRecords] = useState<UiRecord[]>(() => live ? [] : internalRecords.map((record) => ({ ...record, fields: record.fields, updatedAt: null })));
  const [typeFilter, setTypeFilter] = useState<RecordType | "all">("all");
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!live) return;
    let active = true;
    setLoading(true);
    const query = search.trim() ? "?q=" + encodeURIComponent(search.trim()) : "";
    void apiFetch<{ records: ApiRecord[] }>("/api/records" + query).then((result) => {
      if (active) setRecords(result.records.map(fromApiRecord));
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : "Could not load records.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [live, search]);
  const normalizedSearch = normalizeText(search);
  const visible = records.filter((record) => (typeFilter === "all" || record.recordType === typeFilter)
    && (live || !normalizedSearch || normalizeText([record.displayName, record.id, ...Object.values(record.identifiers), ...record.aliases].join(" ")).includes(normalizedSearch)));
  async function createRecord(value: { recordType: RecordType; displayName: string; identifier: string; aliases: string }) {
    const identifiers: Record<string, string> = value.identifier ? { registry: value.identifier } : {};
    const aliasValues = value.aliases.split(",").map((item) => item.trim()).filter(Boolean);
    const payload = { recordType: value.recordType, displayName: value.displayName, identifiers, aliases: aliasValues, fields: {} };
    if (live) {
      const result = await apiFetch<{ record: ApiRecord }>("/api/records", { method: "POST", body: JSON.stringify(payload) });
      setRecords((current) => [fromApiRecord(result.record), ...current]);
    } else {
      setRecords((current) => [{ id: "SAMPLE-" + (Date.now() % 100000), recordType: value.recordType, displayName: value.displayName, identifiers, aliases: aliasValues, fields: {}, updatedAt: null }, ...current]);
    }
    onRecordCreated(value.recordType);
    setShowCreate(false);
  }
  return <div className="page-stack"><SectionTitle eyebrow="REFERENCE DATA" title="Records" subtitle="Reference records are stored separately from compared source rows." action={<button className="button primary" onClick={() => setShowCreate(true)}><Plus size={16} />Add record</button>} />
    {live && <div className="record-stat-strip"><div><Database size={17} /><span>Sites <b>{formatNumber(stats.sites)}</b></span></div><div><Layers3 size={17} /><span>Projects <b>{formatNumber(stats.projects)}</b></span></div><div><GitMerge size={17} /><span>Relationships <b>{formatNumber(stats.relationships)}</b></span></div><div><Globe2 size={17} /><span>Record types <b>2 configured</b></span></div></div>}
    <div className="records-list-card"><div className="records-toolbar"><div className="search-field"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search records or identifiers…" /></div><div className="segmented"><button className={typeFilter === "all" ? "active" : ""} onClick={() => setTypeFilter("all")}>All records</button><button className={typeFilter === "site" ? "active" : ""} onClick={() => setTypeFilter("site")}>Sites</button><button className={typeFilter === "project" ? "active" : ""} onClick={() => setTypeFilter("project")}>Projects</button></div></div>
      {error && <div className="form-message error">{error}</div>}
      <table className="data-table records-table"><thead><tr><th>RECORD</th><th>TYPE</th><th>IDENTIFIERS</th><th>DETAILS</th><th>LAST UPDATED</th><th></th></tr></thead><tbody>{visible.map((record) => <tr key={record.id}><td><div className="run-file"><span className={"record-type-icon " + record.recordType}>{record.recordType === "site" ? "S" : "P"}</span><span><strong>{record.displayName}</strong><small>{record.id} · {record.aliases.join(", ") || "No aliases"}</small></span></div></td><td><span className="type-label">{record.recordType}</span></td><td><div className="identifier-tags">{Object.entries(record.identifiers).map(([key, value]) => <span key={key}><small>{key}</small>{value}</span>)}</div></td><td>{Object.entries(record.fields).filter(([key]) => key !== "display_name" && key !== "record_type").slice(0, 2).map(([key, value]) => <span className="record-detail" key={key}>{key.replaceAll("_", " ")}: {String(value)}</span>)}</td><td>{record.updatedAt ? new Date(record.updatedAt).toLocaleDateString() : "Sample data"}</td><td><button className="row-more" aria-label="Record actions"><MoreHorizontal size={17} /></button></td></tr>)}</tbody></table>
      {loading && <div className="empty-events">Loading records…</div>}
      {!loading && visible.length === 0 && <div className="empty-events">No records match this search.</div>}
      <div className="table-pagination"><span>Showing <b>{visible.length}</b> records{live ? " · API returns up to 100 per search" : " · sample workspace"}</span><div><button disabled><ChevronLeft size={15} /></button><button className="current-page">1</button><button disabled><ChevronRight size={15} /></button></div></div>
    </div>
    <div className="relationship-note"><GitMerge size={16} /><div><strong>Relationships are configurable</strong><span>Sites and projects are separate record types. Their relationship types and cardinality rules are defined by your workspace data model.</span></div><button><Settings2 size={15} />Configure</button></div>
    {showCreate && <RecordCreateModal live={live} onClose={() => setShowCreate(false)} onSave={createRecord} />}
  </div>;
}

function RecordCreateModal({ live, onClose, onSave }: { live: boolean; onClose: () => void; onSave: (value: { recordType: RecordType; displayName: string; identifier: string; aliases: string }) => Promise<void> }) {
  const [recordType, setRecordType] = useState<RecordType>("site");
  const [displayName, setDisplayName] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [aliases, setAliases] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { await onSave({ recordType, displayName, identifier, aliases }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save this record."); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className="modal auth-modal" onSubmit={(event) => void submit(event)}><button type="button" className="icon-button modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button><div className="eyebrow">CANONICAL RECORD</div><h2>Add a record</h2><p>{live ? "Create a tenant-owned site or project record." : "Add a temporary record to this sample session."}</p><div className="field-grid"><label>Record type<select value={recordType} onChange={(event) => setRecordType(event.target.value as RecordType)}><option value="site">Site</option><option value="project">Project</option></select></label><label>Record name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required maxLength={240} /></label><label>Registry identifier<input value={identifier} onChange={(event) => setIdentifier(event.target.value)} /></label><label>Aliases<input value={aliases} onChange={(event) => setAliases(event.target.value)} placeholder="Comma-separated" /></label></div>{error && <div className="form-message error">{error}</div>}<div className="modal-footer"><button type="button" className="button quiet" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy}>{busy ? "Saving…" : "Save record"}</button></div></form></div>;
}

type TenantEvaluation = {
  modelVersion: string;
  labeledPairs: number;
  exactAccuracy: number;
  equivalentPrecision: number;
  equivalentRecall: number;
  candidateRecall: number;
  falseEquivalentPredictions: number;
  actualEquivalent: number;
  predictedEquivalent: number;
  costUsd: number;
};
type TenantPolicy = { minimumEquivalentProbability: number; minimumWinnerMargin: number; candidateLimit: number; candidateMinimumScore: number; autoLinkEnabled: boolean; approvedVersions: string[] };

function policyVersionPasses(evaluation: TenantEvaluation): boolean {
  return passesModelVersionApprovalGate(evaluation);
}

function ModelPolicyPage({ live, mode }: { live: boolean; mode: "settings" | "evaluations" }) {
  const [policy, setPolicy] = useState<TenantPolicy>({ minimumEquivalentProbability: 0.985, minimumWinnerMargin: 0.12, candidateLimit: 20, candidateMinimumScore: 0.12, autoLinkEnabled: false, approvedVersions: [] });
  const [evaluations, setEvaluations] = useState<TenantEvaluation[]>([]);
  const [form, setForm] = useState({ minimumEquivalentProbability: "0.985", minimumWinnerMargin: "0.12", candidateLimit: "20", candidateMinimumScore: "0.12", autoLinkEnabled: false });
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function reload() {
    if (!live) return;
    setLoading(true); setError("");
    try {
      const [nextPolicy, evaluationResult] = await Promise.all([
        apiFetch<TenantPolicy>("/api/matching-policy"),
        apiFetch<{ evaluations: TenantEvaluation[] }>("/api/model-evaluations"),
      ]);
      setPolicy(nextPolicy);
      setForm({
        minimumEquivalentProbability: String(nextPolicy.minimumEquivalentProbability),
        minimumWinnerMargin: String(nextPolicy.minimumWinnerMargin),
        candidateLimit: String(nextPolicy.candidateLimit),
        candidateMinimumScore: String(nextPolicy.candidateMinimumScore),
        autoLinkEnabled: nextPolicy.autoLinkEnabled,
      });
      setEvaluations(evaluationResult.evaluations);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load matching settings."); }
    finally { setLoading(false); }
  }
  useEffect(() => { void reload(); }, [live]);
  async function savePolicy(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      await apiFetch("/api/matching-policy", { method: "PATCH", body: JSON.stringify({
        minimumEquivalentProbability: Number(form.minimumEquivalentProbability),
        minimumWinnerMargin: Number(form.minimumWinnerMargin),
        candidateLimit: Number(form.candidateLimit),
        candidateMinimumScore: Number(form.candidateMinimumScore),
        autoLinkEnabled: form.autoLinkEnabled,
      }) });
      setMessage("Matching policy saved.");
      await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save matching policy."); }
    finally { setBusy(false); }
  }
  async function setApproval(modelVersion: string, approved: boolean) {
    setBusy(true); setError(""); setMessage("");
    try {
      await apiFetch("/api/model-approvals", { method: "POST", body: JSON.stringify({ modelVersion, approved }) });
      setMessage(approved ? modelVersion + " approved for automatic-link evaluation." : modelVersion + " approval revoked.");
      await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update model approval."); }
    finally { setBusy(false); }
  }
  const title = mode === "settings" ? "Matching settings" : "Model approvals";
  return <div className="page-stack"><SectionTitle eyebrow={mode === "settings" ? "WORKSPACE POLICY" : "LABELED EVIDENCE"} title={title} subtitle={mode === "settings" ? "Tune candidate retrieval and control when a resolved model can link records automatically." : "Compare saved Jev decisions with durable human labels before approving an exact version."} />
    {!live && <div className="callout warning"><CircleHelp size={17} /><span>Sample mode has no tenant labels or saved policy. Sign in to configure thresholds and evaluate model versions.</span></div>}
    {live && loading && <div className="empty-events">Loading tenant policy and labeled evaluations…</div>}
    {live && mode === "settings" && <form className="table-card policy-settings-card" onSubmit={(event) => void savePolicy(event)}>
      <div className="card-heading"><div><h3>Candidate and decision thresholds</h3><p>Automatic links remain paused until a version passes the labeled evaluation gate.</p></div><Badge variant={policy.autoLinkEnabled ? "badge-green" : "status-review"}>{policy.autoLinkEnabled ? "Auto-linking enabled" : "Auto-linking paused"}</Badge></div>
      <div className="policy-form-grid">
        <label>Minimum equivalent probability<input type="number" min="0" max="1" step="0.001" value={form.minimumEquivalentProbability} onChange={(event) => setForm((current) => ({ ...current, minimumEquivalentProbability: event.target.value }))} /></label>
        <label>Minimum winner margin<input type="number" min="0" max="1" step="0.01" value={form.minimumWinnerMargin} onChange={(event) => setForm((current) => ({ ...current, minimumWinnerMargin: event.target.value }))} /></label>
        <label>Candidate limit<input type="number" min="1" max="100" step="1" value={form.candidateLimit} onChange={(event) => setForm((current) => ({ ...current, candidateLimit: event.target.value }))} /></label>
        <label>Minimum retrieval score<input type="number" min="0" max="1" step="0.01" value={form.candidateMinimumScore} onChange={(event) => setForm((current) => ({ ...current, candidateMinimumScore: event.target.value }))} /></label>
      </div>
      <label className="policy-toggle"><input type="checkbox" checked={form.autoLinkEnabled} onChange={(event) => setForm((current) => ({ ...current, autoLinkEnabled: event.target.checked }))} /><span><b>Allow automatic links for approved Jev versions</b><small>Each automatic link still needs a single top candidate, a clear probability lead, and no hard identifier conflict.</small></span></label>
      <div className="modal-footer"><span className="muted-number">Workspace owner or admin access required.</span><button className="button primary" disabled={busy || loading}>{busy ? "Saving…" : "Save policy"}</button></div>
    </form>}
    {live && mode === "evaluations" && <div className="evaluation-gate"><ShieldCheck size={17} /><span><b>Approval gate</b> · At least 20 labeled pairs per version, five actual and predicted equivalent examples, 99.5% candidate recall and equivalent precision, and zero false equivalent predictions.</span></div>}
    {live && (mode === "evaluations" || mode === "settings") && <div className="evaluation-list"><div className="card-heading"><div><h3>Resolved model versions</h3><p>Metrics use the latest saved human label per compared record and model version.</p></div><button className="button quiet small" onClick={() => void reload()} disabled={loading}><ArrowDownUp size={14} />Refresh</button></div>
      {evaluations.length ? evaluations.map((evaluation) => {
        const approved = policy.approvedVersions.includes(evaluation.modelVersion);
        const passes = policyVersionPasses(evaluation);
        return <div className="evaluation-row" key={evaluation.modelVersion}><div className="evaluation-model"><strong>{evaluation.modelVersion}</strong><span>{formatNumber(evaluation.labeledPairs)} labeled pairs · cost ${evaluation.costUsd.toFixed(6)}</span></div><div className="evaluation-metrics"><span><b>{(evaluation.exactAccuracy * 100).toFixed(1)}%</b><small>exact accuracy</small></span><span><b>{(evaluation.equivalentPrecision * 100).toFixed(1)}%</b><small>equivalent precision</small></span><span><b>{(evaluation.candidateRecall * 100).toFixed(1)}%</b><small>candidate recall</small></span><span><b>{evaluation.falseEquivalentPredictions}</b><small>false equivalents</small></span></div><div className="evaluation-actions">{approved ? <Badge variant="badge-green">Approved</Badge> : <Badge variant={passes ? "status-completed" : "status-review"}>{passes ? "Gate passed" : "More labels needed"}</Badge>}<button className={approved ? "button quiet small" : "button primary small"} disabled={busy || (!approved && !passes)} onClick={() => void setApproval(evaluation.modelVersion, !approved)}>{approved ? "Revoke" : "Approve"}</button></div></div>;
      }) : <div className="empty-events">No labeled model decisions yet. Resolve reviews to create tenant evaluation examples.</div>}
    </div>}
    {message && <div className="callout success"><CheckCircle2 size={16} />{message}</div>}{error && <div className="form-message error">{error}</div>}
  </div>;
}

function emptyDashboardStats(): DashboardStats {
  return {
    internalRecords: 0, sites: 0, projects: 0, relationships: 0,
    vendorObservations: 0, confirmedLinks: 0, activeVendors: 0, pendingReviews: 0,
    outcomes: { equivalent: 0, related: 0, review: 0, unmatched: 0 }, candidateRecall: null,
  };
}

function App() {
  const [page, setPage] = useState<Page>("matching");
  const [imports, setImports] = useState<ImportSummary[]>([]);
  const [canDeleteRuns, setCanDeleteRuns] = useState(false);
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null);
  const [dashboardRevision, setDashboardRevision] = useState(0);
  const [showAuth, setShowAuth] = useState(false);
  const [identity, setIdentity] = useState<{ userId: string | null; generation: number }>({ userId: null, generation: 0 });
  const identityRef = useRef(identity);
  const connected = identity.userId !== null;
  const cloudConnected = liveMode && connected;
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  const [sidebarOpen, setSidebarOpen] = useState(() => !window.matchMedia("(max-width: 760px)").matches);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [newComparisonRequest, setNewComparisonRequest] = useState(0);
  const [stats, setStats] = useState<DashboardStats>(emptyDashboardStats);
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);

  function navigate(nextPage: Page) {
    setPage(nextPage);
    window.scrollTo({ top: 0, behavior: "instant" });
    if (mobile) { setSidebarOpen(false); sidebarToggleRef.current?.focus(); }
  }

  function requestNewComparison() {
    setNewComparisonRequest((request) => request + 1);
    navigate("matching");
  }

  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const update = () => { setMobile(query.matches); if (query.matches) setSidebarOpen(false); };
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!mobile || !sidebarOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    sidebarRef.current?.querySelector<HTMLButtonElement>('button[aria-current="page"]')?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setSidebarOpen(false); sidebarToggleRef.current?.focus(); }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener("keydown", closeOnEscape); };
  }, [mobile, sidebarOpen]);

  useEffect(() => {
    if (!supabase) return;
    let mounted = true;
    let sessionEventReceived = false;
    const applyIdentity = (userId: string | null) => {
      if (!mounted || userId === identityRef.current.userId) return;
      const next = { userId, generation: identityRef.current.generation + 1 };
      identityRef.current = next;
      setIdentity(next);
      setImports([]);
      setCanDeleteRuns(false);
      setStats(emptyDashboardStats());
      setPage("matching");
      setShowAuth(false);
      setAdvancedOpen(false);
      if (window.matchMedia("(max-width: 760px)").matches) setSidebarOpen(false);
    };
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      sessionEventReceived = true;
      applyIdentity(session?.user.id ?? null);
    });
    void supabase.auth.getSession().then(({ data: sessionData }) => {
      if (!sessionEventReceived) applyIdentity(sessionData.session?.user.id ?? null);
    }).catch(() => undefined);
    return () => { mounted = false; data.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!liveMode || !identity.userId) return;
    const controller = new AbortController();
    void apiFetch<{
      imports: ImportSummary[];
      internalRecords: number;
      sites: number;
      projects: number;
      relationships: number;
      vendorObservations: number;
      confirmedLinks: number;
      activeVendors: number;
      pendingReviews: number;
      outcomes: DashboardStats["outcomes"];
      canDeleteRuns: boolean;
    }>("/api/dashboard", { signal: controller.signal }).then((data) => {
      if (controller.signal.aborted || identityRef.current !== identity) return;
      setImports(data.imports ?? []);
      setCanDeleteRuns(data.canDeleteRuns === true);
      setStats({
        internalRecords: data.internalRecords,
        sites: data.sites,
        projects: data.projects,
        relationships: data.relationships,
        vendorObservations: data.vendorObservations,
        confirmedLinks: data.confirmedLinks,
        activeVendors: data.activeVendors,
        pendingReviews: data.pendingReviews,
        outcomes: data.outcomes,
        candidateRecall: null,
      });
    }).catch(() => undefined);
    return () => controller.abort();
  }, [identity, dashboardRevision]);

  async function deleteRun(item: ImportSummary) {
    if (!cloudConnected || !canDeleteRuns || deletingRunId) return;
    const dataset1 = item.dataset1Name ?? "Dataset 1";
    const dataset2 = item.dataset2Name ?? item.fileName;
    const confirmed = window.confirm(`Permanently delete “${dataset1} / ${dataset2}”? This removes both source files, the comparison results, and its review history.`);
    if (!confirmed) return;
    setDeletingRunId(item.id);
    try {
      await apiFetch<{ deleted: boolean }>("/api/runs/" + encodeURIComponent(item.id), { method: "DELETE" });
      if (identityRef.current === identity) {
        setImports((previous) => previous.filter((run) => run.id !== item.id));
        setDashboardRevision((revision) => revision + 1);
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 502) {
        setImports((previous) => previous.map((run) => run.id === item.id ? { ...run, status: "deleting" } : run));
      }
      window.alert(error instanceof Error ? error.message : "Could not delete this comparison.");
    } finally {
      setDeletingRunId(null);
    }
  }

  const nav = [
    { id: "matching" as Page, title: "Match datasets", icon: <GitCompareArrows size={18} /> },
    { id: "compare-models" as Page, title: "Compare models", icon: <FlaskConical size={18} /> },
    { id: "imports" as Page, title: "History", icon: <Clock3 size={18} /> },
    { id: "settings" as Page, title: "Settings", icon: <Settings2 size={18} /> },
  ];
  const advancedNav = [
    { id: "review" as Page, title: "Review queue", icon: <ListChecks size={16} />, count: cloudConnected ? stats.pendingReviews : 0 },
    { id: "records" as Page, title: "Reference records", icon: <Database size={16} />, count: 0 },
    { id: "evaluations" as Page, title: "Model approvals", icon: <BookOpenCheck size={16} />, count: 0 },
  ];
  const pageTitles: Record<Page, string> = {
    overview: "Overview", imports: "History", matching: "Match datasets", "compare-models": "Compare models", review: "Review queue",
    records: "Reference records", settings: "Settings", evaluations: "Model approvals",
  };

  return <div className={"app-shell refined-shell " + (sidebarOpen ? "" : "sidebar-collapsed")}>
    {mobile && sidebarOpen && <button className="shell-nav-backdrop" tabIndex={-1} aria-label="Close navigation" onClick={() => { setSidebarOpen(false); sidebarToggleRef.current?.focus(); }} />}
    <aside className="sidebar" id="workspace-navigation" ref={sidebarRef} aria-label="Workspace navigation" inert={mobile && !sidebarOpen}>
      <div className="brand-row" aria-label="Match Studio"><IconMark /><span className="brand-name">Match<span>Studio</span></span></div>
      <nav aria-label="Main navigation">{nav.map((item) => <button className={"nav-item " + (page === item.id ? "selected" : "")} key={item.id} aria-label={item.title} title={!sidebarOpen ? item.title : undefined} aria-current={page === item.id ? "page" : undefined} onClick={() => navigate(item.id)}><span className="nav-icon">{item.icon}</span><span className="nav-text">{item.title}</span></button>)}</nav>
      <div className="shell-tools">
        <button className={"nav-item shell-tools-toggle " + (advancedNav.some((item) => item.id === page) ? "tools-active" : "")} aria-label="More tools" aria-expanded={advancedOpen} aria-controls="advanced-navigation" title={!sidebarOpen ? "More tools" : undefined} onClick={() => { setAdvancedOpen((open) => !open); if (!sidebarOpen) setSidebarOpen(true); }}><span className="nav-icon"><MoreHorizontal size={17} /></span><span className="nav-text">More tools</span><ChevronDown className="shell-tools-chevron" size={13} /></button>
        {advancedOpen && <nav className="shell-tools-menu" id="advanced-navigation" aria-label="Advanced tools">{advancedNav.map((item) => <button key={item.id} className={"nav-item " + (page === item.id ? "selected" : "")} aria-label={item.title} title={!sidebarOpen ? item.title : undefined} aria-current={page === item.id ? "page" : undefined} onClick={() => navigate(item.id)}><span className="nav-icon">{item.icon}</span><span className="nav-text">{item.title}</span>{item.count > 0 && <span className="nav-count">{item.count}</span>}</button>)}</nav>}
      </div>
    </aside>
    <main className="main-area">
      <header className="topbar"><div className="breadcrumbs"><button className="icon-button" ref={sidebarToggleRef} aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"} aria-expanded={sidebarOpen} aria-controls="workspace-navigation" onClick={() => setSidebarOpen(!sidebarOpen)}><PanelLeftClose size={17} style={{ transform: sidebarOpen ? undefined : "rotate(180deg)" }} /></button><strong>{pageTitles[page]}</strong></div><div className="topbar-actions"><span className={"shell-mode " + (cloudConnected ? "is-cloud" : "")} title={cloudConnected ? "Signed in. Saved workspace runs are stored privately; interactive comparisons can be exported." : "Local rules run in this browser. External models send selected records to their provider and may incur charges."}><i />{cloudConnected ? "Cloud" : "Local"}</span>{connected ? <button className="shell-account-button" onClick={() => void supabase?.auth.signOut()}>Sign out</button> : <button className="shell-account-button" onClick={() => setShowAuth(true)}>Sign in</button>}</div></header>
      <div className="content-wrap" inert={mobile && sidebarOpen} key={(identity.userId ?? "local") + ":" + identity.generation}>
        <MatchingSessionProvider>
        {!cloudConnected && ["review", "records"].includes(page) && <div className="shell-example-note"><CircleHelp size={15} /><span>Example data for exploring this tool. Your local comparison is on Match datasets.</span></div>}
        {page === "overview" && <Overview imports={imports} stats={stats} onNavigate={navigate} onNewImport={requestNewComparison} />}
        {page === "imports" && <ImportsPage imports={imports} live={cloudConnected} canDeleteRuns={cloudConnected && canDeleteRuns} deletingRunId={deletingRunId} onDeleteRun={(run) => void deleteRun(run)} onNewImport={requestNewComparison} onOpenReview={() => { setAdvancedOpen(true); navigate("review"); }} />}
        <div hidden={page !== "matching"}><MatchWorkspace onCompareModels={() => navigate("compare-models")} live={cloudConnected} visible={page === "matching"} newComparisonRequest={newComparisonRequest} onStarted={(run) => { if (identityRef.current === identity) setImports((previous) => [run, ...previous.filter((item) => item.id !== run.id)]); }} /></div>
        <div hidden={page !== "compare-models"}><ModelComparisonPage live={cloudConnected} onUseModel={() => navigate("matching")} /></div>
        {page === "review" && <ReviewPage live={cloudConnected} onCountChange={(count) => { if (identityRef.current === identity) setStats((current) => ({ ...current, pendingReviews: count })); }} />}
        {page === "records" && <RecordsPage live={cloudConnected} stats={stats} onRecordCreated={(recordType) => { if (identityRef.current === identity) setStats((current) => ({ ...current, internalRecords: current.internalRecords + 1, sites: current.sites + (recordType === "site" ? 1 : 0), projects: current.projects + (recordType === "project" ? 1 : 0) })); }} />}
        {page === "settings" && <ModelPolicyPage live={liveMode && connected} mode="settings" />}
        {page === "evaluations" && <ModelPolicyPage live={liveMode && connected} mode="evaluations" />}
        </MatchingSessionProvider>
      </div>
    </main>
    {showAuth && <AuthModal onClose={() => setShowAuth(false)} />}
  </div>;
}

export default App;
