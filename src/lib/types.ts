export type RecordType = "site" | "project";
export type RelationshipOutcome = "equivalent" | "related" | "different" | "insufficient_evidence" | "unmatched";
export type RunStatus = "uploading" | "queued" | "profiling" | "mapping" | "retrieving" | "deciding" | "escalating" | "review" | "completed" | "failed" | "deleting";

export type FieldValue = string | number | boolean | null | FieldValue[] | { [key: string]: FieldValue };

export interface RecordSnapshot {
  id: string;
  recordType: RecordType;
  displayName: string;
  identifiers: Record<string, string>;
  aliases: string[];
  fields: Record<string, FieldValue>;
}

export interface CandidateResult {
  id: string;
  internal: RecordSnapshot;
  vendor: RecordSnapshot;
  probabilities: Record<RelationshipOutcome, number>;
  outcome: RelationshipOutcome;
  confidence: number;
  hardContradictions: string[];
  evidence: string[];
  needsReview: boolean;
  modelVersion: string;
}

export interface MappingField {
  source: string;
  target: string | null;
  confidence: number;
}

export interface RunEvent {
  sequence: number;
  type: string;
  message: string;
  createdAt: string;
  payload?: Record<string, unknown>;
}

export interface ImportSummary {
  id: string;
  referenceDatasetId?: string | null;
  dataset1Name?: string;
  dataset2Name?: string;
  dataset1Rows?: number | null;
  dataset2Rows?: number | null;
  vendor: string;
  fileName: string;
  sourceVersion: string | null;
  mappingVersion: number;
  recordType: RecordType;
  status: RunStatus;
  rows: number;
  candidateCount: number;
  decisionCount: number;
  matched: number;
  related: number;
  escalatedCount: number;
  review: number;
  unmatched: number;
  createdAt: string;
}
