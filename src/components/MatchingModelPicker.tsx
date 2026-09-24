import { useId, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { formatModelPrice, isFreeModel, isLowCostModel, sortedModels, type ModelChoice } from "../lib/matching-models";
import "./MatchingModelPicker.css";

export interface MatchingModelPickerProps {
  label: string;
  value: string;
  onChange: (id: string) => void;
  models: ModelChoice[];
  disabled?: boolean;
  excludedIds?: string[];
  optional?: boolean;
}

type CostFilter = "free" | "low" | "all";
const costFilters: { value: CostFilter; label: string; title: string }[] = [
  { value: "free", label: "Free", title: "Models with zero listed input and output token prices" },
  { value: "low", label: "Low cost", title: "Models with known prices up to $0.50 input and $2 output per million tokens" },
  { value: "all", label: "All", title: "Every compatible model in the catalogue" },
];

export default function MatchingModelPicker({ label, value, onChange, models, disabled = false, excludedIds = [], optional = false }: MatchingModelPickerProps) {
  const id = useId();
  const [filter, setFilter] = useState<CostFilter>("low");
  const [search, setSearch] = useState("");
  const ordered = useMemo(() => sortedModels(models), [models]);
  const selected = ordered.find((model) => model.id === value);
  const query = search.trim().toLocaleLowerCase();
  const visible = ordered.filter((model) =>
    (filter === "all" || (filter === "free" ? isFreeModel(model) : isLowCostModel(model)))
    && (!query || `${model.name} ${model.id}`.toLocaleLowerCase().includes(query)));
  const selectedOutsideFilter = value !== "" && !visible.some((model) => model.id === value);
  const unavailable = (model: ModelChoice) => !model.configured || excludedIds.includes(model.id);
  const optionLabel = (model: ModelChoice) => {
    const price = model.kind === "local" ? "no API cost" : `input ${formatModelPrice(model.inputCostPerMillion)} / output ${formatModelPrice(model.outputCostPerMillion)}`;
    const reason = excludedIds.includes(model.id) ? " · already selected" : !model.configured ? " · not configured" : "";
    return `${model.name}${model.kind === "jev" ? " · recommended" : ""}${model.id === value ? "" : " · " + price}${reason}`;
  };
  const renderOption = (model: ModelChoice) => <option key={model.id} value={model.id} disabled={unavailable(model)}>{optionLabel(model)}</option>;

  return <div className="matching-model-picker">
    <label className="matching-model-picker-label" htmlFor={`${id}-model`}>{label}</label>
    <details className="matching-model-browse">
      <summary aria-disabled={disabled} onClick={(event) => { if (disabled) event.preventDefault(); }}>Browse models</summary>
      <div className="matching-model-browse-controls">
      <div className="matching-model-cost-filter" role="group" aria-label={`${label} price filter`}>
        {costFilters.map((choice) => <button key={choice.value} type="button" title={choice.title} aria-pressed={filter === choice.value} disabled={disabled} onClick={() => setFilter(choice.value)}>{choice.label}</button>)}
      </div>
    <div className="matching-model-search">
      <Search size={14} aria-hidden="true" />
      <input id={`${id}-search`} type="search" aria-label={`Search ${label.toLowerCase()} models`} placeholder="Search models or providers" value={search} disabled={disabled} onChange={(event) => setSearch(event.target.value)} />
      <span aria-live="polite" aria-atomic="true">{visible.length}</span>
    </div>
    <span className="matching-model-filter-note">{filter === "low" ? "Known prices up to $0.50 input / $2 output per 1M tokens. Unknown prices are excluded." : filter === "free" ? "Zero listed input and output token prices." : "All compatible models, ordered by price."}</span>
      </div>
    </details>
    <select id={`${id}-model`} title={selected?.name} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} aria-describedby={`${id}-price`}>
      {optional && <option value="">Add a model</option>}
      {!optional && !value && <option value="" disabled>Choose a model</option>}
      {selectedOutsideFilter && <optgroup label="Current selection">{selected ? renderOption(selected) : <option value={value} disabled>{value} · unavailable</option>}</optgroup>}
      {visible.length ? <optgroup label={filter === "all" ? "All compatible models" : filter === "free" ? "Free models" : "Low cost models"}>{visible.map(renderOption)}</optgroup> : <option disabled value="__no_matching_models__">No models match this filter</option>}
    </select>
    <div className="matching-model-price" id={`${id}-price`}>
      {selected ? selected.kind === "local" ? <span>Runs locally · no API cost</span> : <>
        <span title="Catalogue starting prices per million tokens; the selected provider's rate may vary.">From <b>{formatModelPrice(selected.inputCostPerMillion)}</b> input · <b>{formatModelPrice(selected.outputCostPerMillion)}</b> output / 1M</span>
        {isFreeModel(selected) && <span className="matching-model-price-note">Free models have rate limits and may be temporarily unavailable.</span>}
        {selected.kind === "jev" && (selected.inputCostPerMillion === null || selected.outputCostPerMillion === null) && <span className="matching-model-price-note">Price unavailable. Treat it as billable; check the provider before enabling it.</span>}
      </> : <span>{value ? "This model is no longer in the catalogue." : "Choose a model to see its token prices."}</span>}
    </div>
  </div>;
}
