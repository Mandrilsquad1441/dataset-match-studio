import { describe, expect, it } from "vitest";
import { candidateSet, canAutoLink, findHardContradictions, makeDecision } from "./matching";
import { internalRecords, vendorRows } from "./fixtures";

const probabilities = { equivalent: 0.995, related: 0.002, different: 0.002, insufficient_evidence: 0.001, unmatched: 0 };

describe("record candidate and decision policy", () => {
  it("keeps candidates within the same configurable record type", () => {
    const candidates = candidateSet(internalRecords, vendorRows[2]);
    expect(candidates.some((candidate) => candidate.record.id === "REC-2090")).toBe(true);
    expect(candidates.every((candidate) => candidate.record.recordType === "project")).toBe(true);
  });

  it("detects a conflicting identifier even when names are close", () => {
    const candidate = internalRecords.find((record) => record.id === "REC-1042")!;
    expect(findHardContradictions(candidate, vendorRows[1])).toContain("identifier.registry");
    const decision = makeDecision(candidate, vendorRows[1], probabilities, "jev-resolved-v1");
    expect(decision.needsReview).toBe(true);
    expect(canAutoLink(decision, ["jev-resolved-v1"])).toBe(false);
  });

  it("requires the exact evaluated Jev version before auto-linking", () => {
    const decision = makeDecision(internalRecords[0], vendorRows[0], probabilities, "jev-2026-09-23");
    expect(decision.outcome).toBe("equivalent");
    expect(canAutoLink(decision, [])).toBe(false);
    expect(canAutoLink(decision, ["jev-2026-09-22"])).toBe(false);
    expect(canAutoLink(decision, ["jev-2026-09-23"])).toBe(true);
  });

  it("keeps explicitly shared identifiers case and punctuation sensitive", () => {
    const record = { ...internalRecords[0], identifiers: { shared: "AB-12" } };
    for (const different of ["ab-12", "AB12", "AB.12", "ＡB-12"]) {
      const observed = { ...record, id: "source", identifiers: { shared: different } };
      expect(findHardContradictions(record, observed)).toContain("identifier.shared");
      expect(candidateSet([record], observed)[0].retrievalScore).toBeLessThan(1);
    }
    const compatible = { ...record, identifiers: { shared: "  AB-12  " } };
    expect(findHardContradictions(record, compatible)).toEqual([]);
    expect(candidateSet([record], compatible)[0].retrievalScore).toBeGreaterThan(1);
  });
});
