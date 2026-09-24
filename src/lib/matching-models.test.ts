import { describe, expect, it } from "vitest";
import { preferredMatchingModel, sortedModels, type ModelChoice } from "./matching-models";

const choices: ModelChoice[] = [
  { id: "local", name: "Local rules", kind: "local", contextLength: null, inputCostPerMillion: 0, outputCostPerMillion: 0, supportsSeed: false, supportsTemperature: false, configured: true },
  { id: "typesafe/jev-1.13", name: "Jev 1.13", kind: "jev", contextLength: null, inputCostPerMillion: null, outputCostPerMillion: null, supportsSeed: false, supportsTemperature: false, configured: true },
  { id: "cheap/model", name: "Cheap model", kind: "llm", contextLength: null, inputCostPerMillion: 0.1, outputCostPerMillion: 0.2, supportsSeed: true, supportsTemperature: true, configured: true },
];

describe("preferred matching engine", () => {
  it("uses the durable Jev run when its live path is configured", () => {
    expect(preferredMatchingModel(choices, { live: true, savedRunConfigured: true })).toBe("saved-jev");
  });

  it("defaults to the configured pinned Jev model when only direct inference is available", () => {
    expect(preferredMatchingModel(choices, { live: true, savedRunConfigured: false })).toBe("typesafe/jev-1.13");
  });

  it("keeps local matching available when Jev is not configured", () => {
    expect(preferredMatchingModel(choices.map((choice) => ({ ...choice, configured: choice.kind !== "jev" })), { live: false, savedRunConfigured: false })).toBe("local");
  });

  it("lists Jev before local and optional models", () => {
    expect(sortedModels(choices).map((choice) => choice.id)).toEqual(["typesafe/jev-1.13", "local", "cheap/model"]);
  });
});
