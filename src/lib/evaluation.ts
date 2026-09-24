import { candidateSet, findHardContradictions } from "./matching";
import { internalRecords, vendorRows } from "./fixtures";

export interface FixtureLabel {
  vendor: string;
  observationId: string;
  internalRecordId?: string;
  outcome: "equivalent" | "related" | "insufficient_evidence" | "unmatched";
}

export const fixtureLabels: FixtureLabel[] = [
  { vendor: "Northstar Data Co.", observationId: "row-a1", internalRecordId: "REC-1042", outcome: "equivalent" },
  { vendor: "Northstar Data Co.", observationId: "row-a2", outcome: "insufficient_evidence" },
  { vendor: "Cedarline Partners", observationId: "row-a3", internalRecordId: "REC-2090", outcome: "equivalent" },
  { vendor: "Cedarline Partners", observationId: "row-a4", internalRecordId: "REC-2107", outcome: "related" },
  { vendor: "Vantage Registry", observationId: "row-a5", outcome: "unmatched" },
  { vendor: "Vantage Registry", observationId: "row-a6", internalRecordId: "REC-3112", outcome: "equivalent" },
];

export interface FixtureEvaluation {
  precision: number;
  recall: number;
  candidateRecall: number;
  reviewRate: number;
  retrieved: number;
  positiveLabels: number;
  total: number;
  byVendor: Array<{ vendor: string; precision: number; recall: number; reviewRate: number; latencyMs: number; costUsd: number }>;
}

export function evaluateFixtures(): FixtureEvaluation {
  const start = performance.now();
  let truePositive = 0;
  let predictedPositive = 0;
  let actualPositive = 0;
  let retrieved = 0;
  let reviewCount = 0;
  const vendorCounts = new Map<string, { tp: number; predicted: number; actual: number; review: number; rows: number }>();
  const labels = fixtureLabels.map((label) => {
    const observation = vendorRows.find((row) => row.id === label.observationId)!;
    const candidates = candidateSet(internalRecords, observation);
    const targetRetrieved = !label.internalRecordId || candidates.some((candidate) => candidate.record.id === label.internalRecordId);
    if (label.internalRecordId && targetRetrieved) retrieved += 1;
    const top = candidates[0];
    const conflicts = top ? findHardContradictions(top.record, observation) : [];
    const exact = top && Object.entries(observation.identifiers).some(([key, value]) => value && top.record.identifiers[key] === value);
    const predictedOutcome = !candidates.length ? "unmatched"
      : conflicts.length ? "insufficient_evidence"
        : exact ? "equivalent"
          : top!.retrievalScore >= 0.18 ? "related" : "insufficient_evidence";
    const predictedMatch = predictedOutcome === "equivalent" || predictedOutcome === "related";
    const actualMatch = label.outcome === "equivalent" || label.outcome === "related";
    const hit = predictedMatch && actualMatch && (!label.internalRecordId || top?.record.id === label.internalRecordId);
    if (predictedMatch) predictedPositive += 1;
    if (actualMatch) actualPositive += 1;
    if (hit) truePositive += 1;
    if (predictedOutcome === "insufficient_evidence" || (predictedMatch && candidates.length > 1 && candidates[0].retrievalScore - candidates[1].retrievalScore < 0.08)) reviewCount += 1;
    const aggregate = vendorCounts.get(label.vendor) ?? { tp: 0, predicted: 0, actual: 0, review: 0, rows: 0 };
    aggregate.tp += hit ? 1 : 0;
    aggregate.predicted += predictedMatch ? 1 : 0;
    aggregate.actual += actualMatch ? 1 : 0;
    aggregate.review += predictedOutcome === "insufficient_evidence" ? 1 : 0;
    aggregate.rows += 1;
    vendorCounts.set(label.vendor, aggregate);
    return { label, predictedOutcome };
  });
  const latencyMs = Math.max(0, performance.now() - start);
  return {
    precision: predictedPositive ? truePositive / predictedPositive : 1,
    recall: actualPositive ? truePositive / actualPositive : 1,
    candidateRecall: actualPositive ? retrieved / actualPositive : 1,
    reviewRate: labels.length ? reviewCount / labels.length : 0,
    retrieved,
    positiveLabels: actualPositive,
    total: labels.length,
    byVendor: [...vendorCounts.entries()].map(([vendor, value]) => ({
      vendor,
      precision: value.predicted ? value.tp / value.predicted : 1,
      recall: value.actual ? value.tp / value.actual : 1,
      reviewRate: value.rows ? value.review / value.rows : 0,
      latencyMs: Number((latencyMs / labels.length).toFixed(2)),
      costUsd: 0,
    })),
  };
}
