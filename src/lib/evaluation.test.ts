import { describe, expect, it } from "vitest";
import { evaluateFixtures, fixtureLabels } from "./evaluation";

describe("labeled fixture evaluation", () => {
  it("measures candidate recall across the three fixture vendors", () => {
    const result = evaluateFixtures();
    expect(result.total).toBe(6);
    expect(result.positiveLabels).toBe(4);
    expect(result.candidateRecall).toBe(1);
    expect(result.byVendor).toHaveLength(3);
    expect(result.byVendor.every((vendor) => vendor.costUsd === 0 && vendor.latencyMs >= 0)).toBe(true);
  });

  it("includes equivalent, related, conflict and unmatched labels", () => {
    expect(fixtureLabels.map((label) => label.outcome)).toEqual(expect.arrayContaining(["equivalent", "related", "insufficient_evidence", "unmatched"]));
  });
});
