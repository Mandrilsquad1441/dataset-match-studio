import { describe, expect, it } from "vitest";
import { evaluateLabeledModelPairs, passesModelVersionApprovalGate } from "./model-evaluation";

describe("labeled model evaluation", () => {
  it("measures exact outcomes, false equivalent predictions, retrieval recall and cost by version", () => {
    const [result] = evaluateLabeledModelPairs([
      { modelVersion: "jev-a", predictedOutcome: "equivalent", actualOutcome: "equivalent", candidateRetrieved: true, costUsd: 0.01 },
      { modelVersion: "jev-a", predictedOutcome: "equivalent", actualOutcome: "different", candidateRetrieved: true, costUsd: 0.02 },
      { modelVersion: "jev-a", predictedOutcome: "related", actualOutcome: "related", candidateRetrieved: false, costUsd: 0.03 },
    ]);
    expect(result.exactAccuracy).toBeCloseTo(2 / 3);
    expect(result.equivalentPrecision).toBe(0.5);
    expect(result.equivalentRecall).toBe(1);
    expect(result.candidateRecall).toBe(0.5);
    expect(result.falseEquivalentPredictions).toBe(1);
    expect(result.costUsd).toBeCloseTo(0.06);
  });

  it("keeps auto-link approval closed until labeled evidence passes every gate", () => {
    const passing = {
      modelVersion: "jev-approved",
      labeledPairs: 20,
      exactAccuracy: 1,
      equivalentPrecision: 1,
      equivalentRecall: 1,
      candidateRecall: 1,
      falseEquivalentPredictions: 0,
      actualEquivalent: 5,
      predictedEquivalent: 5,
      costUsd: 0.1,
    };
    expect(passesModelVersionApprovalGate(passing)).toBe(true);
    expect(passesModelVersionApprovalGate({ ...passing, candidateRecall: 0.99 })).toBe(false);
    expect(passesModelVersionApprovalGate({ ...passing, falseEquivalentPredictions: 1 })).toBe(false);
    expect(passesModelVersionApprovalGate({ ...passing, labeledPairs: 19 })).toBe(false);
  });
});
