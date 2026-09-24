import { useId, useState } from "react";
import { ChevronDown, Clock3, Table2 } from "lucide-react";
import { useMatchingSession } from "../lib/matching-session";
import SourceCard, { type SelectedDataset } from "./DatasetSourceCard";
import ModelComparisonPanel from "./ModelComparisonPanel";
import SampleDatasetPicker from "./SampleDatasetPicker";
import "./match-workspace.css";
import "./ModelComparisonPage.css";

export interface ModelComparisonPageProps { live: boolean; onUseModel: () => void }

function DatasetSummary({ dataset, number }: { dataset: SelectedDataset; number: 1 | 2 }) {
  return <div className="comparison-dataset-summary" data-source={number}>
    <span className="comparison-dataset-icon" aria-hidden="true"><Table2 size={17} strokeWidth={1.7} /></span>
    <div><span className="comparison-dataset-label">Dataset {number}</span><strong title={dataset.name}>{dataset.name}</strong><small>{dataset.rows.length.toLocaleString()} records · {dataset.headers.length.toLocaleString()} columns</small></div>
  </div>;
}

export default function ModelComparisonPage({ live, onUseModel }: ModelComparisonPageProps) {
  const {
    first, second, setFirst, setSecond, modelChoices, setSelectedModel,
    catalogueError, setCatalogueError, setCatalogueVersion,
    matchingBusy, benchmarkBusy, setBenchmarkBusy,
    firstBusy, setFirstBusy, secondBusy, setSecondBusy, sourceVersion,
    activeSample, loadingSampleId, sampleError, loadSample,
  } = useMatchingSession();
  const [editing, setEditing] = useState(false);
  const sourcesId = useId();
  const ready = Boolean(first && second);
  const locked = matchingBusy || benchmarkBusy || firstBusy || secondBusy;

  return <div className="model-comparison-page journey">
    <header className="comparison-page-heading"><h1>Compare models</h1><p>Compare accuracy and speed on the same records.</p></header>
    {matchingBusy && <p className="comparison-matching-notice" role="status"><Clock3 size={15} aria-hidden="true" />Matching is in progress. Model comparison will be available when it finishes.</p>}
    <SampleDatasetPicker disabled={locked} loadingId={loadingSampleId} selectedId={activeSample?.id} onSelect={(id) => void loadSample(id)} error={sampleError} />
    <section className="comparison-datasets" aria-label="Comparison datasets">
      {first && second && <>
        <div className="comparison-dataset-pair"><DatasetSummary dataset={first} number={1} /><DatasetSummary dataset={second} number={2} /></div>
        <button type="button" className="comparison-edit-datasets" aria-expanded={editing} aria-controls={sourcesId} onClick={() => setEditing(!editing)}>{editing ? "Hide dataset settings" : "Edit datasets"}<ChevronDown size={14} className={editing ? "is-open" : ""} /></button>
      </>}
      <div id={sourcesId} className={"comparison-source-inputs" + (ready ? " with-summary" : "")} hidden={ready && !editing}>
        <div className="source-pair" key={sourceVersion}>
          <SourceCard number={1} value={first} onChange={setFirst} onBusyChange={setFirstBusy} disabled={locked} />
          <SourceCard number={2} value={second} onChange={setSecond} onBusyChange={setSecondBusy} disabled={locked} />
        </div>
      </div>
    </section>
    {catalogueError && <div className="benchmark-notice" role="status"><p>{catalogueError}</p><button className="text-link" onClick={() => { setCatalogueError(""); setCatalogueVersion((value) => value + 1); }}>Retry catalogue</button></div>}
    {first && second ? <ModelComparisonPanel
      standalone dataset1={first} dataset2={second} live={live}
      initialAnswerKey={activeSample?.answerKey}
      disabled={matchingBusy || firstBusy || secondBusy} modelChoices={modelChoices}
      onBusyChange={setBenchmarkBusy}
      onUseModel={(modelId) => { setSelectedModel(modelId); onUseModel(); }}
    /> : <p className="comparison-dataset-prompt">Add both datasets to choose models and compare their results.</p>}
  </div>;
}
