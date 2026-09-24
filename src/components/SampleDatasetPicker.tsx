import { useId } from "react";
import { ArrowRight, Check, ChevronDown, Layers3, Loader2 } from "lucide-react";
import { SAMPLE_DATASETS } from "../lib/sample-datasets";
import "./SampleDatasetPicker.css";

export interface SampleDatasetPickerProps {
  disabled?: boolean;
  loadingId?: string | null;
  selectedId?: string;
  onSelect: (id: string) => void;
  error?: string;
}

export default function SampleDatasetPicker({ disabled = false, loadingId = null, selectedId, onSelect, error }: SampleDatasetPickerProps) {
  const errorId = useId();
  const loading = SAMPLE_DATASETS.find((sample) => sample.id === loadingId);
  return <div className="sample-picker" aria-busy={Boolean(loadingId)}>
    <details className="sample-picker-disclosure">
      <summary aria-describedby={error ? errorId : undefined}><Layers3 size={15} strokeWidth={1.7} aria-hidden="true" /><span>Sample datasets</span><ChevronDown className="sample-picker-chevron" size={14} aria-hidden="true" /></summary>
      <div className="sample-picker-content">
        <div className="sample-picker-list">
          {SAMPLE_DATASETS.map((sample) => {
            const isLoading = loadingId === sample.id;
            const selected = selectedId === sample.id;
            return <button key={sample.id} type="button" className={"sample-picker-option" + (selected ? " is-selected" : "") + (isLoading ? " is-loading" : "")} disabled={disabled || Boolean(loadingId)} onClick={() => onSelect(sample.id)} aria-label={`${selected ? "Reload" : "Load"} ${sample.title} sample datasets`}>
              <span className="sample-picker-copy">
                <span className="sample-picker-title"><strong>{sample.title}</strong>{selected && !isLoading && <span className="sample-picker-selected"><Check size={11} aria-hidden="true" />Loaded</span>}</span>
                <span className="sample-picker-metadata"><span className="sample-picker-source source-one">Dataset 1 <b>{sample.referenceRows.toLocaleString()}</b></span><span className="sample-picker-source source-two">Dataset 2 <b>{sample.incomingRows.toLocaleString()}</b></span><span>{sample.columns} columns</span><span>{sample.formats.join(" / ")}</span></span>
                <span className="sample-picker-description">{sample.description}</span>
              </span>
              <span className="sample-picker-action" aria-hidden="true">{isLoading ? <><Loader2 className="sample-picker-spinner" size={15} />Loading</> : <><span>{selected ? "Reload" : "Load"}</span><ArrowRight size={14} /></>}</span>
            </button>;
          })}
        </div>
        <p className="sample-picker-note">Synthetic data · Answer key included</p>
      </div>
    </details>
    {loadingId && <span className="sample-picker-status" role="status">Loading {loading?.title ?? "sample datasets"}…</span>}
    {error && <p id={errorId} className="sample-picker-error" role="alert">{error}</p>}
  </div>;
}
