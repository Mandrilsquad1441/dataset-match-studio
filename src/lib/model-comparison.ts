import type { LocalDataset, LocalDecision } from "./dataset-comparison";

export const MODEL_COMPARISON_VERSION = "model-comparison-v1";
export const MODEL_PROMPT_VERSION = "field-identity-v1";
export const DEFAULT_MODEL_SEED = 20260923;
export const MAX_MODEL_BATCH_ROWS = 50;
export const MODEL_CANDIDATE_LIMIT = 8;

export interface ModelChoice {
  id: string;
  name: string;
  kind: "local" | "jev" | "llm";
  contextLength: number | null;
  inputCostPerMillion: number | null;
  outputCostPerMillion: number | null;
  supportsSeed: boolean;
  supportsTemperature: boolean;
  configured: boolean;
}
export interface ModelCatalogue {
  models: ModelChoice[];
  configured: boolean;
  savedRunConfigured?: boolean;
  catalogueUpdatedAt: string;
  catalogueError?: string;
  version: string;
  maxBatchRows: number;
  candidateLimit: number;
}
export interface EvaluationRequest {
  dataset1: LocalDataset;
  dataset2: LocalDataset;
  rowIndices: number[];
  modelId: string;
  seed?: number;
  /** false explicitly requests fresh inference; true reuses identical saved responses. */
  useCache?: boolean;
  /** Reuse the route returned by the first batch to pin a model across subsequent batches. */
  providerTag?: string;
}
export type ModelOutcome = "equivalent" | "related" | "different" | "insufficient_evidence" | "unmatched";
export interface ModelUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}
export interface ModelEvaluationRow extends LocalDecision {
  modelId: string;
  resolvedModel: string | null;
  provider: string | null;
  modelOutcome: ModelOutcome | null;
  outcome: ModelOutcome;
  /** Provider confidence is uncalibrated; deterministic assessment.score is separate. */
  modelConfidence: number | null;
  candidateIndices: number[];
  latencyMs: number;
  inferenceLatencyMs: number;
  /** Usage incurred by this request; zero on a cache hit. */
  usage: ModelUsage;
  originalUsage: ModelUsage;
  cached: boolean;
  fingerprint: string;
  error?: string;
}
export interface EvaluationResponse {
  model: ModelChoice;
  rows: ModelEvaluationRow[];
  fingerprint: string;
  datasetFingerprint: string;
  candidateFingerprint: string;
  version: string;
  promptVersion: string;
  scoreVersion: string;
  seed: number;
  settings: { temperature: number | null; seedSent: boolean; providerRouting: string; providerTag: string | null; candidateLimit: number; maxOutputTokens: number | null };
  runtimeMs: number;
  usage: ModelUsage;
  cachedRows: number;
  errorRows: number;
}
