import { normalizeText, flattenFields } from "./normalize";
import type { CandidateResult, RecordSnapshot, RelationshipOutcome } from "./types";

const outcomes: RelationshipOutcome[] = ["equivalent", "related", "different", "insufficient_evidence"];

function comparableIdentifier(key: string, value: string): string {
  return key === "shared" ? value.normalize("NFC").trim() : normalizeText(value);
}

function tokenSimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const a = new Set(left.split(" "));
  const b = new Set(right.split(" "));
  const overlap = [...a].filter((token) => b.has(token)).length;
  return overlap / (a.size + b.size - overlap);
}

export function findHardContradictions(internal: RecordSnapshot, vendor: RecordSnapshot): string[] {
  const conflicts: string[] = [];
  for (const [key, value] of Object.entries(vendor.identifiers)) {
    const other = internal.identifiers[key];
    if (value && other && comparableIdentifier(key, value) !== comparableIdentifier(key, other)) conflicts.push("identifier." + key);
  }
  return conflicts;
}

export function rankCandidate(internal: RecordSnapshot, vendor: RecordSnapshot): number {
  if (internal.recordType !== vendor.recordType) return 0;
  const conflicts = findHardContradictions(internal, vendor);
  const sharedIds = Object.entries(vendor.identifiers).filter(([key, value]) =>
    value && internal.identifiers[key] && comparableIdentifier(key, value) === comparableIdentifier(key, internal.identifiers[key])
  ).length;
  if (sharedIds) return 1 + Math.min(sharedIds * 0.01, 0.05);
  const left = normalizeText(internal.displayName);
  const right = normalizeText(vendor.displayName);
  let nameScore = tokenSimilarity(left, right);
  const aliasScores = internal.aliases.concat(vendor.aliases).map((alias) => Math.max(
    tokenSimilarity(normalizeText(alias), right),
    tokenSimilarity(left, normalizeText(alias)),
  ));
  nameScore = Math.max(nameScore, ...aliasScores, 0);
  const sharedText = Object.entries(vendor.fields).filter(([key, value]) => {
    const internalValue = internal.fields[key];
    return value !== null && internalValue !== undefined && normalizeText(value) === normalizeText(internalValue);
  }).length;
  const contradictionPenalty = conflicts.length ? 0.2 : 0;
  return Math.max(0, Math.min(0.99, nameScore * 0.72 + Math.min(sharedText * 0.045, 0.18) - contradictionPenalty));
}

export function candidateSet(
  internalRecords: RecordSnapshot[],
  vendor: RecordSnapshot,
  limit = 20,
  minimumScore = 0.12,
): Array<{ record: RecordSnapshot; retrievalScore: number }> {
  return internalRecords
    .filter((record) => record.recordType === vendor.recordType)
    .map((record) => ({ record, retrievalScore: rankCandidate(record, vendor) }))
    .filter((entry) => entry.retrievalScore >= minimumScore)
    .sort((a, b) => b.retrievalScore - a.retrievalScore)
    .slice(0, limit);
}

export function makeDecision(
  internal: RecordSnapshot,
  vendor: RecordSnapshot,
  probabilities: Record<RelationshipOutcome, number>,
  modelVersion: string,
  threshold = 0.985,
): CandidateResult {
  const winner = outcomes.reduce((best, outcome) => probabilities[outcome] > probabilities[best] ? outcome : best, outcomes[0]);
  const sorted = outcomes.map((outcome) => probabilities[outcome]).sort((a, b) => b - a);
  const conflicts = findHardContradictions(internal, vendor);
  const evidence = Object.keys(flattenFields({ internal: internal.fields, vendor: vendor.fields }));
  const confident = probabilities[winner] >= threshold && sorted[0] - sorted[1] >= 0.12;
  return {
    id: vendor.id + ":" + internal.id,
    internal,
    vendor,
    probabilities,
    outcome: winner,
    confidence: probabilities[winner],
    hardContradictions: conflicts,
    evidence,
    needsReview: !confident || conflicts.length > 0 || winner === "insufficient_evidence",
    modelVersion,
  };
}

export function canAutoLink(result: CandidateResult, approvedVersions: string[]): boolean {
  return result.outcome === "equivalent"
    && result.confidence >= 0.985
    && !result.needsReview
    && result.hardContradictions.length === 0
    && approvedVersions.includes(result.modelVersion);
}
