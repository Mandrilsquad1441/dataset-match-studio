import { apiFetch } from "./api";
import type { EvaluationRequest, EvaluationResponse, ModelCatalogue, ModelChoice } from "./model-comparison";

export type { EvaluationRequest, EvaluationResponse, ModelCatalogue, ModelChoice } from "./model-comparison";

export const PREFERRED_MODEL_IDS: readonly string[] = [
  "typesafe/jev-1.13",
  "openai/gpt-6-sol",
  "deepseek/deepseek-v4-flash",
  "google/gemini-3.1-pro-preview",
  "meta/muse-spark-1.3",
  "anthropic/claude-opus-5",
  "openai/gpt-6-astra",
  "anthropic/claude-fable-5.1",
];

export const DEFAULT_MODEL_CHOICES: ModelChoice[] = [
  { id: "local", name: "Local rules", kind: "local", contextLength: null, inputCostPerMillion: 0, outputCostPerMillion: 0, supportsSeed: false, supportsTemperature: false, configured: true },
  { id: "typesafe/jev-1.13", name: "Jev 1.13", kind: "jev", contextLength: null, inputCostPerMillion: null, outputCostPerMillion: null, supportsSeed: false, supportsTemperature: false, configured: false },
];

export const LOW_COST_INPUT_PER_MILLION = 0.5;
export const LOW_COST_OUTPUT_PER_MILLION = 2;

/** Prices are USD per million tokens. Unknown prices never count as free. */
export function formatModelPrice(price: number | null | undefined): string {
  if (price == null || !Number.isFinite(price) || price < 0) return "Unknown";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumSignificantDigits: 6 }).format(price);
}

export function isFreeModel(model: ModelChoice): boolean {
  return model.inputCostPerMillion === 0 && model.outputCostPerMillion === 0;
}

/** Local rules and Jev stay discoverable; Jev's unknown price is shown explicitly. */
export function isLowCostModel(model: ModelChoice): boolean {
  if (model.kind === "local") return true;
  const input = model.inputCostPerMillion;
  const output = model.outputCostPerMillion;
  return input !== null && output !== null && Number.isFinite(input) && Number.isFinite(output)
    && input >= 0 && output >= 0 && input <= LOW_COST_INPUT_PER_MILLION && output <= LOW_COST_OUTPUT_PER_MILLION;
}

/** Stable catalogue ordering: Jev, local rules, then lowest input/output prices. */
export function sortedModels(models: readonly ModelChoice[]): ModelChoice[] {
  const rank = (model: ModelChoice) => model.kind === "jev" ? 0 : model.kind === "local" ? 1 : 2;
  const price = (value: number | null) => value !== null && Number.isFinite(value) && value >= 0 ? value : Number.POSITIVE_INFINITY;
  return [...new Map(models.map((model) => [model.id, model])).values()].sort((a, b) =>
    rank(a) - rank(b)
    || price(a.inputCostPerMillion) - price(b.inputCostPerMillion)
    || price(a.outputCostPerMillion) - price(b.outputCostPerMillion)
    || a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id, "en"));
}

export function preferredMatchingModel(
  models: readonly ModelChoice[],
  options: { live: boolean; savedRunConfigured: boolean },
): string {
  if (options.live && options.savedRunConfigured) return "saved-jev";
  return models.find((model) => model.kind === "jev" && model.configured)?.id ?? "local";
}

async function request<T>(path: string, live: boolean, init: RequestInit): Promise<T> {
  if (live) return apiFetch<T>(path, init);
  const headers = new Headers(init.headers);
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (!response.ok) {
    let message = await response.text();
    try { const body = JSON.parse(message) as { error?: string; message?: string }; message = body.error ?? body.message ?? message; } catch { /* Preserve a text error from the local bridge. */ }
    throw new Error(message.startsWith("<") ? "The model service is not available. Start the local API or connect the deployed API." : message.slice(0, 600) || `Model service returned ${response.status}.`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) throw new Error("The model service is not available in this workspace yet.");
  return response.json() as Promise<T>;
}

export function getMatchingModels(live: boolean, signal?: AbortSignal): Promise<ModelCatalogue> {
  return request<ModelCatalogue>("/api/matching/models", live, { signal });
}

export function evaluateMatchingModel(body: EvaluationRequest, live: boolean, signal?: AbortSignal): Promise<EvaluationResponse> {
  return request<EvaluationResponse>("/api/matching/evaluate", live, { method: "POST", body: JSON.stringify(body), signal });
}
