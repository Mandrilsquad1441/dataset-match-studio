import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import type { SelectedDataset } from "../components/DatasetSourceCard";
import type { ModelChoice } from "./model-comparison";
import { DEFAULT_MODEL_CHOICES } from "./matching-models";
import { loadSampleDataset } from "./sample-datasets";

type LoadedSample = Awaited<ReturnType<typeof loadSampleDataset>>;

interface MatchingSession {
  first: SelectedDataset | null;
  second: SelectedDataset | null;
  setFirst: Dispatch<SetStateAction<SelectedDataset | null>>;
  setSecond: Dispatch<SetStateAction<SelectedDataset | null>>;
  modelChoices: ModelChoice[];
  setModelChoices: Dispatch<SetStateAction<ModelChoice[]>>;
  catalogueError: string;
  setCatalogueError: Dispatch<SetStateAction<string>>;
  catalogueVersion: number;
  setCatalogueVersion: Dispatch<SetStateAction<number>>;
  selectedModel: string;
  setSelectedModel: Dispatch<SetStateAction<string>>;
  setSuggestedModel: (model: string) => void;
  matchingBusy: boolean;
  setMatchingBusy: Dispatch<SetStateAction<boolean>>;
  benchmarkBusy: boolean;
  setBenchmarkBusy: Dispatch<SetStateAction<boolean>>;
  firstBusy: boolean;
  setFirstBusy: Dispatch<SetStateAction<boolean>>;
  secondBusy: boolean;
  setSecondBusy: Dispatch<SetStateAction<boolean>>;
  sourceVersion: number;
  setSourceVersion: Dispatch<SetStateAction<number>>;
  activeSample: LoadedSample | null;
  loadingSampleId: string | null;
  sampleError: string;
  loadSample: (id: string) => Promise<void>;
}

const Session = createContext<MatchingSession | null>(null);

/** One dataset pair; independent matching and benchmark views retain their own runs. */
export function MatchingSessionProvider({ children }: { children: ReactNode }) {
  const [first, setFirst] = useState<SelectedDataset | null>(null);
  const [second, setSecond] = useState<SelectedDataset | null>(null);
  const [modelChoices, setModelChoices] = useState<ModelChoice[]>(DEFAULT_MODEL_CHOICES);
  const [catalogueError, setCatalogueError] = useState("");
  const [catalogueVersion, setCatalogueVersion] = useState(0);
  const [selectedModel, setSelectedModelValue] = useState("local");
  const explicitModelChoice = useRef(false);
  const setSelectedModel = useCallback<Dispatch<SetStateAction<string>>>((value) => {
    explicitModelChoice.current = true;
    setSelectedModelValue(value);
  }, []);
  const setSuggestedModel = useCallback((model: string) => {
    if (!explicitModelChoice.current) setSelectedModelValue(model);
  }, []);
  const [matchingBusy, setMatchingBusy] = useState(false);
  const [benchmarkBusy, setBenchmarkBusy] = useState(false);
  const [firstBusy, setFirstBusy] = useState(false);
  const [secondBusy, setSecondBusy] = useState(false);
  const [sourceVersion, setSourceVersion] = useState(0);
  const [sample, setSample] = useState<LoadedSample | null>(null);
  const [loadingSampleId, setLoadingSampleId] = useState<string | null>(null);
  const [sampleError, setSampleError] = useState("");
  const sampleRequest = useRef<AbortController | null>(null);
  useEffect(() => () => sampleRequest.current?.abort(), []);
  const activeSample = sample && sample.first === first && sample.second === second ? sample : null;
  useEffect(() => { if (sample && !activeSample) setSample(null); }, [sample, activeSample]);
  const loadSample = useCallback(async (id: string) => {
    if (matchingBusy || benchmarkBusy || firstBusy || secondBusy || sampleRequest.current) return;
    const controller = new AbortController(); sampleRequest.current = controller;
    setLoadingSampleId(id); setSampleError(""); setFirstBusy(true); setSecondBusy(true);
    try {
      const loaded = await loadSampleDataset(id, controller.signal);
      if (controller.signal.aborted) return;
      setFirst(loaded.first); setSecond(loaded.second); setSample(loaded);
      setSourceVersion((version) => version + 1);
    } catch (cause) {
      if (!controller.signal.aborted) setSampleError(cause instanceof Error ? cause.message : "Could not load these sample datasets.");
    } finally {
      if (!controller.signal.aborted) { sampleRequest.current = null; setLoadingSampleId(null); setFirstBusy(false); setSecondBusy(false); }
    }
  }, [matchingBusy, benchmarkBusy, firstBusy, secondBusy]);
  const value = useMemo(() => ({ first, second, setFirst, setSecond, modelChoices, setModelChoices, catalogueError, setCatalogueError, catalogueVersion, setCatalogueVersion, selectedModel, setSelectedModel, setSuggestedModel, matchingBusy, setMatchingBusy, benchmarkBusy, setBenchmarkBusy, firstBusy, setFirstBusy, secondBusy, setSecondBusy, sourceVersion, setSourceVersion, activeSample, loadingSampleId, sampleError, loadSample }), [first, second, modelChoices, catalogueError, catalogueVersion, selectedModel, setSelectedModel, setSuggestedModel, matchingBusy, benchmarkBusy, firstBusy, secondBusy, sourceVersion, activeSample, loadingSampleId, sampleError, loadSample]);
  return <Session.Provider value={value}>{children}</Session.Provider>;
}

export function useMatchingSession() {
  const session = useContext(Session);
  if (!session) throw new Error("Matching views need a dataset session.");
  return session;
}
