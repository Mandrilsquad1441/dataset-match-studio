import type { RecordSnapshot, ImportSummary } from "./types";

export const internalRecords: RecordSnapshot[] = [
  { id: "REC-1042", recordType: "site", displayName: "Northstar Research", identifiers: { registry: "NS-1042", legacy: "northstar-01" }, aliases: ["North Star Lab"], fields: { country: "CH", status: "active", owner: "A. Keller" } },
  { id: "REC-1051", recordType: "site", displayName: "Northstar Research", identifiers: { registry: "NS-1051", legacy: "northstar-02" }, aliases: ["North Star Annex"], fields: { country: "CH", status: "active", owner: "M. Roth" } },
  { id: "REC-2090", recordType: "project", displayName: "Atlas Phase II", identifiers: { registry: "AT-2090" }, aliases: ["Project Atlas"], fields: { stage: "active", portfolio: "Aster" } },
  { id: "REC-2107", recordType: "project", displayName: "Atlas Expansion", identifiers: { registry: "AT-2107" }, aliases: ["Atlas Phase III"], fields: { stage: "planning", portfolio: "Aster" } },
  { id: "REC-3112", recordType: "site", displayName: "Meridian West", identifiers: { registry: "MD-3112" }, aliases: [], fields: { country: "DE", status: "active", owner: "S. Meyer" } },
];

export const vendorRows: RecordSnapshot[] = [
  { id: "row-a1", recordType: "site", displayName: "Northstar Research Center", identifiers: { registry: "NS-1042" }, aliases: [], fields: { nation: "Switzerland", current_state: "open" } },
  { id: "row-a2", recordType: "site", displayName: "Northstar Research", identifiers: { registry: "NS-9999" }, aliases: [], fields: { nation: "CH", current_state: "open" } },
  { id: "row-a3", recordType: "project", displayName: "Atlas II", identifiers: { registry: "AT-2090" }, aliases: [], fields: { lifecycle: "running", program: "Aster" } },
  { id: "row-a4", recordType: "project", displayName: "Atlas III", identifiers: { registry: "AT-8800" }, aliases: [], fields: { lifecycle: "proposed", program: "Aster" } },
  { id: "row-a5", recordType: "site", displayName: "Brightwell East", identifiers: { registry: "BW-8100" }, aliases: [], fields: { nation: "FR", current_state: "open" } },
  { id: "row-a6", recordType: "site", displayName: "Meridian West", identifiers: { registry: "MD-3112" }, aliases: [], fields: { nation: "Germany", current_state: "open" } },
];

export const sampleImports: ImportSummary[] = [
  { id: "run-482", vendor: "Northstar Data Co.", fileName: "site_register_q3.csv", sourceVersion: "2026-Q3", mappingVersion: 1, recordType: "site", status: "review", rows: 2, candidateCount: 3, decisionCount: 3, matched: 1, related: 0, escalatedCount: 1, review: 1, unmatched: 0, createdAt: "2026-09-23T08:42:00.000Z" },
  { id: "run-481", vendor: "Cedarline Partners", fileName: "project_catalog.json", sourceVersion: "2026-09", mappingVersion: 1, recordType: "project", status: "completed", rows: 2, candidateCount: 2, decisionCount: 2, matched: 1, related: 1, escalatedCount: 0, review: 0, unmatched: 0, createdAt: "2026-09-22T15:16:00.000Z" },
  { id: "run-480", vendor: "Vantage Registry", fileName: "site_aliases.csv", sourceVersion: "release-08", mappingVersion: 1, recordType: "site", status: "completed", rows: 2, candidateCount: 1, decisionCount: 1, matched: 1, related: 0, escalatedCount: 0, review: 0, unmatched: 1, createdAt: "2026-09-20T11:08:00.000Z" },
];

export const sampleReviewPair = {
  internal: internalRecords[1],
  vendor: vendorRows[1],
  probabilities: { equivalent: 0.51, related: 0.37, different: 0.08, insufficient_evidence: 0.04 },
  conflicts: ["registry"],
  score: 0.51,
};
