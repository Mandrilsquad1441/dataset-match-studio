import type { RelationshipOutcome } from "./types";

export type ModelPairLabel = {
  modelVersion: string;
  predictedOutcome: Exclude<RelationshipOutcome, "unmatched">;
  actualOutcome: Exclude<RelationshipOutcome, "unmatched">;
  candidateRetrieved: boolean;
  costUsd: number;
};

export type ModelVersionEvaluation = {
  modelVersion: string;
  labeledPairs: number;
  exactAccuracy: number;
  equivalentPrecision: number;
  equivalentRecall: number;
  candidateRecall: number;
  falseEquivalentPredictions: number;
  actualEquivalent: number;
  predictedEquivalent: number;
  costUsd: number;
};

export function passesModelVersionApprovalGate(evaluation: ModelVersionEvaluation): boolean {
  return evaluation.labeledPairs >= 20
    && evaluation.actualEquivalent >= 5
    && evaluation.predictedEquivalent >= 5
    && evaluation.candidateRecall >= 0.995
    && evaluation.equivalentPrecision >= 0.995
    && evaluation.falseEquivalentPredictions === 0;
}

export function evaluateLabeledModelPairs(labels: ModelPairLabel[]): ModelVersionEvaluation[] {
  const grouped = new Map<string, ModelPairLabel[]>();
  for (const label of labels) grouped.set(label.modelVersion, [...(grouped.get(label.modelVersion) ?? []), label]);
  return [...grouped].map(([modelVersion, rows]) => {
    const actualEquivalent = rows.filter((row) => row.actualOutcome === "equivalent").length;
    const predictedEquivalent = rows.filter((row) => row.predictedOutcome === "equivalent").length;
    const trueEquivalent = rows.filter((row) => row.actualOutcome === "equivalent" && row.predictedOutcome === "equivalent").length;
    const falseEquivalentPredictions = rows.filter((row) => row.actualOutcome !== "equivalent" && row.predictedOutcome === "equivalent").length;
    const positiveLabels = rows.filter((row) => row.actualOutcome === "equivalent" || row.actualOutcome === "related");
    return {
      modelVersion,
      labeledPairs: rows.length,
      exactAccuracy: rows.length ? rows.filter((row) => row.actualOutcome === row.predictedOutcome).length / rows.length : 0,
      equivalentPrecision: predictedEquivalent ? trueEquivalent / predictedEquivalent : 0,
      equivalentRecall: actualEquivalent ? trueEquivalent / actualEquivalent : 0,
      candidateRecall: positiveLabels.length ? positiveLabels.filter((row) => row.candidateRetrieved).length / positiveLabels.length : 0,
      falseEquivalentPredictions,
      actualEquivalent,
      predictedEquivalent,
      costUsd: rows.reduce((sum, row) => sum + row.costUsd, 0),
    };
  }).sort((left, right) => left.modelVersion.localeCompare(right.modelVersion));
}
