import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, ChevronDown, ClipboardPaste, FileUp, Link2, Loader2, Table2, Upload, X } from "lucide-react";
import { DATASET_ACCEPT, parseDatasetFile, parseDatasetText, type DatasetInput } from "../lib/dataset-input";
import { inferNameField } from "../lib/dataset-fields";
import { readPublicDatasetUrl } from "../lib/dataset-url";

export type SelectedDataset = DatasetInput & { nameField: string; idField?: string; sourceFile?: File };
const formats = DATASET_ACCEPT;
const count = (n: number) => n.toLocaleString();
export function selectDataset(data: DatasetInput): SelectedDataset {
  const nameField = inferNameField(data.headers);
  return { ...data, nameField, idField: undefined };
}

export default function SourceCard({ number, value, onChange, onBusyChange, disabled }: { number: 1 | 2; value: SelectedDataset | null; onChange: (value: SelectedDataset | null) => void; onBusyChange: (busy: boolean) => void; disabled: boolean }) {
  const [mode, setMode] = useState<"file" | "paste" | "url">("file");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const request = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const reportedBusy = useRef(false);
  const selectedFile = value?.sourceFile ?? file;
  useEffect(() => () => { request.current++; abort.current?.abort(); if (reportedBusy.current) onBusyChange(false); }, [onBusyChange]);
  useEffect(() => { if (busy || reportedBusy.current) onBusyChange(busy); reportedBusy.current = busy; }, [busy, onBusyChange]);
  async function load(work: () => Promise<DatasetInput> | DatasetInput, keepValue = false, sourceFile?: () => File | undefined) {
    const version = ++request.current;
    setBusy(true); setError(""); if (!keepValue) onChange(null);
    try { const parsed = await work(); if (version === request.current) onChange({ ...selectDataset(parsed), sourceFile: sourceFile?.() }); }
    catch (cause) { if (version === request.current) setError(cause instanceof Error ? cause.message : "Could not read this source."); }
    finally { if (version === request.current) setBusy(false); }
  }
  function readFile(next: File, worksheet?: string) { setFile(next); void load(() => parseDatasetFile(next, { worksheet }), Boolean(worksheet), () => next); }
  function readLink() {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setFile(null);
    let linkedFile: File | undefined;
    const timeout = window.setTimeout(() => controller.abort(), 30000);
    void load(async () => {
      const result = await readPublicDatasetUrl(url.trim(), controller.signal);
      linkedFile = result.file ?? undefined;
      if (abort.current === controller && !controller.signal.aborted) setFile(result.file);
      return result.dataset;
    }, false, () => linkedFile).finally(() => {
      window.clearTimeout(timeout);
      if (abort.current === controller) abort.current = null;
    });
  }
  function clear() { request.current++; abort.current?.abort(); setBusy(false); setError(""); setFile(null); onChange(null); }
  return <section className={"source-card " + (value ? "source-ready" : "") + (dragging ? " is-dragging" : "") + (disabled ? " is-locked" : "")} data-source={number} aria-label={"Dataset " + number}>
    <div className="source-card-heading"><div><span className="source-identity" aria-hidden="true"><Table2 size={17} strokeWidth={1.7} /></span><h2>Dataset {number}</h2></div>{value && <button className="icon-button" aria-label={"Remove Dataset " + number} disabled={disabled} onClick={clear}><X size={15} /></button>}</div>
    {value ? <>
      <div className="source-loaded"><span className="source-check"><Check size={17} /></span><div><strong title={value.name}>{value.name}</strong><span>{count(value.rows.length)} records · {value.headers.length} columns</span></div></div>
      {selectedFile && (value.worksheets?.length ?? 0) > 1 && <label className="source-field">Sheet<select disabled={disabled || busy} value={value.worksheet} onChange={(event) => readFile(selectedFile, event.target.value)}>{value.worksheets?.map((sheet) => <option key={sheet}>{sheet}</option>)}</select></label>}
      <div className="source-field-grid"><label className="source-field">Name column<select aria-label={"Dataset " + number + " name column"} value={value.nameField} disabled={disabled || busy} onChange={(event) => onChange({ ...value, nameField: event.target.value })}>{value.headers.map((header) => <option key={header}>{header}</option>)}</select></label>
        <label className="source-field">Shared ID <span>optional</span><select aria-label={"Dataset " + number + " shared ID"} title="The same kind of ID in both datasets, such as email or registration number" value={value.idField ?? ""} disabled={disabled || busy} onChange={(event) => onChange({ ...value, idField: event.target.value || undefined })}><option value="">None</option>{value.headers.map((header) => <option key={header}>{header}</option>)}</select></label></div>
      <details className="source-preview"><summary>Preview data <ChevronDown size={13} /></summary><div className="source-preview-scroll"><table><thead><tr>{value.headers.slice(0, 8).map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{value.rows.slice(0, 4).map((row, i) => <tr key={i}>{value.headers.slice(0, 8).map((header) => <td key={header}>{String(row[header] ?? "")}</td>)}</tr>)}</tbody></table></div><small>First {Math.min(4, value.rows.length)} records{value.headers.length > 8 ? " · first 8 columns shown" : ""}. All columns are included.</small></details>
    </> : <>
      <div className="source-tabs" role="group" aria-label={"Dataset " + number + " source method"}>{(["file", "paste", "url"] as const).map((item) => <button key={item} aria-pressed={mode === item} disabled={disabled || busy} onClick={() => { setMode(item); setError(""); }} className={mode === item ? "active" : ""}>{item === "file" ? <Upload size={14} aria-hidden="true" /> : item === "paste" ? <ClipboardPaste size={14} aria-hidden="true" /> : <Link2 size={14} aria-hidden="true" />}{item === "file" ? "Upload" : item === "paste" ? "Paste" : "Link"}</button>)}</div>
      {mode === "file" && <label className={"source-dropzone " + (disabled || busy ? "is-disabled" : "")} onDragOver={(event) => { event.preventDefault(); if (!disabled && !busy) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); if (!disabled && !busy && event.dataTransfer.files[0]) readFile(event.dataTransfer.files[0]); }}><input type="file" aria-label={"Choose file for Dataset " + number} accept={formats} disabled={disabled || busy} onChange={(event) => { if (event.target.files?.[0]) readFile(event.target.files[0]); event.target.value = ""; }} /><span className="source-upload-icon" aria-hidden="true"><FileUp size={25} strokeWidth={1.5} /></span><strong>Drop a file or <u>browse</u></strong><span>CSV, Excel, JSON, XML and more</span></label>}
      {mode === "paste" && <div className="source-paste"><textarea aria-label={"Paste Dataset " + number} placeholder={'Paste spreadsheet cells, CSV, JSON or XML…\n\nname,email\nAcme,hello@acme.com'} value={text} onChange={(event) => setText(event.target.value)} disabled={disabled || busy} spellCheck={false} /><button className="button quiet small" disabled={disabled || busy || !text.trim()} onClick={() => void load(() => parseDatasetText(text, "Pasted dataset " + number))}>Read data <ArrowRight size={13} /></button></div>}
      {mode === "url" && <div className="source-url"><Link2 size={22} strokeWidth={1.3} /><label className="source-field">Public data link<input type="url" aria-label={"Dataset " + number + " URL"} placeholder="https://example.com/data.xml" value={url} disabled={disabled || busy} onChange={(event) => setUrl(event.target.value)} /></label><p>Direct files and public API responses. The source must allow browser access.</p><button className="button quiet small" disabled={disabled || busy || !url.trim()} onClick={readLink}>Read link <ArrowRight size={13} /></button></div>}
    </>}
    {busy && <p className="source-reading" role="status"><Loader2 size={14} className="spin" />Reading your source…</p>}{error && <p className="source-error" role="alert">{error}</p>}
  </section>;
}
