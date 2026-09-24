import { normalizeText } from "./normalize";
import { assessRecordPair, recordBlockingKeys, recordText, RECORD_SCORE_VERSION, textEvidenceSimilarity, type PairAssessment, type PairFieldMapping, type RecordAssessment } from "./record-scoring";

export interface LocalDataset { name: string; rows: Record<string, unknown>[]; nameField: string; idField?: string }
export interface LocalDecision {
  rowIndex: number; name: string; targetIndex: number | null; targetName: string | null;
  lane: "strong" | "review" | "low" | "no-match"; explanation: string; confidence: null; assessment: RecordAssessment;
}
export interface ScoredCandidate { targetIndex: number; targetName: string; assessment: PairAssessment }
export interface CandidateAssessmentSet { candidates: ScoredCandidate[]; candidateCount: number; searchLimited: boolean; exactNameCount: number; exactIdCount: number; sourceNameCount?: number; sourceIdCount?: number }
interface IndexedRow { name: string; normalizedName: string; id: string; tokens: Set<string>; blockingKeys: string[] }

const MAX_RETRIEVED = 128;
const MAX_ASSESSED = 24;
const STOP_WORDS = new Set(["a", "an", "and", "at", "for", "in", "of", "on", "the", "to", "with"]);
function indexRows(dataset: LocalDataset, compareIds: boolean): IndexedRow[] {
  return dataset.rows.map((row, index) => {
    const name = recordText(row[dataset.nameField]); const normalizedName = normalizeText(name);
    return { name: name || `Row ${index + 1}`, normalizedName, id: compareIds && dataset.idField ? recordText(row[dataset.idField]).normalize("NFC") : "", tokens: new Set(normalizedName.split(" ").filter((token) => token && !STOP_WORDS.has(token)).slice(0, 32)), blockingKeys: recordBlockingKeys(row) };
  });
}
function addPosting(index: Map<string, number[]>, key: string, rowIndex: number): void {
  if (!key) return;
  const posting = index.get(key); if (posting) posting.push(rowIndex); else index.set(key, [rowIndex]);
}
function grams(value: string): string[] {
  const compact = value.replaceAll(" ", "").slice(0, 72); const result = new Set<string>();
  for (let index = 2; index < compact.length; index += 1) result.add(compact.slice(index - 2, index + 1));
  return [...result].slice(0, 32);
}
function rawAgreement(assessment: PairAssessment): number {
  const weight = assessment.components.reduce((sum, component) => sum + component.weight, 0);
  return weight ? assessment.components.reduce((sum, component) => sum + component.contribution, 0) / weight : 0;
}

/** Recompute the margin for any selected candidate, including model-selected alternatives. */
export function assessmentForCandidate(set: CandidateAssessmentSet, targetIndex: number | null): RecordAssessment {
  const selected = targetIndex === null ? undefined : set.candidates.find((candidate) => candidate.targetIndex === targetIndex);
  const other = set.candidates.filter((candidate) => candidate.targetIndex !== selected?.targetIndex);
  return {
    ...(selected?.assessment ?? { score: 0, scoreVersion: RECORD_SCORE_VERSION, components: [], coverage: 0, conflicts: [] }),
    assessedTargetIndex: selected?.targetIndex ?? null, assessedTargetName: selected?.targetName ?? null,
    candidateCount: set.candidateCount, margin: selected && other.length ? selected.assessment.score - other[0].assessment.score : null, searchLimited: set.searchLimited,
    alternatives: other.slice(0, 5).map((candidate) => ({ targetIndex: candidate.targetIndex, targetName: candidate.targetName, score: candidate.assessment.score, coverage: candidate.assessment.coverage, conflicts: candidate.assessment.conflicts })),
  };
}

/** A shared evidence guard, independent of a model's claimed confidence or chosen label. */
export function automaticMatchAllowed(assessment: RecordAssessment, candidates?: CandidateAssessmentSet): boolean {
  const agreements = assessment.components.filter((component) => component.status === "agree");
  const identifierAgrees = agreements.some((component) => component.kind === "identifier");
  const nameAgrees = agreements.some((component) => component.kind === "name");
  const corroborating = agreements.filter((component) => component.kind === "attribute" && component.weight >= 6).length;
  const incompleteExactGroup = candidates && (candidates.exactNameCount > MAX_ASSESSED || candidates.exactIdCount > MAX_ASSESSED);
  const uniqueSelectedIdentifier = candidates?.exactIdCount === 1 && candidates.sourceIdCount === 1;
  const repeatedSourceNeedsReview = candidates && (candidates.sourceNameCount ?? 0) > 1 && !uniqueSelectedIdentifier && corroborating < 2;
  // A unique, explicitly selected shared identifier is a complete identity key.
  // Do not downgrade it solely because optional fields are missing or the name changed.
  const uniqueIdentifierMatch = uniqueSelectedIdentifier && identifierAgrees;
  const corroboratedMatch = assessment.score >= 85 && assessment.coverage >= 75
    && (assessment.margin === null || assessment.margin >= 8)
    && (identifierAgrees || (nameAgrees && corroborating >= 2));
  return !incompleteExactGroup && !repeatedSourceNeedsReview && !assessment.conflicts.length
    && (uniqueIdentifierMatch || corroboratedMatch);
}

/** Pure shared retrieval: at most 128 rows retrieved and 24 fully scored per source row. */
export function prepareLocalComparison(dataset1: LocalDataset, dataset2: LocalDataset): { total: number; compareRow: (index: number) => LocalDecision; assessCandidates: (index: number) => CandidateAssessmentSet } {
  const compareIds = Boolean(dataset1.idField && dataset2.idField);
  const targets = indexRows(dataset1, compareIds), sources = indexRows(dataset2, compareIds);
  const byId = new Map<string, number[]>(), byName = new Map<string, number[]>(), byToken = new Map<string, number[]>(), byBlocking = new Map<string, number[]>(), byGram = new Map<string, number[]>();
  const sourceNameFrequency = new Map<string, number>(), sourceIdFrequency = new Map<string, number>();
  const mapping: PairFieldMapping = { sourceNameField: dataset2.nameField, targetNameField: dataset1.nameField, ...(compareIds ? { sourceIdField: dataset2.idField, targetIdField: dataset1.idField } : {}) };
  targets.forEach((row, index) => {
    addPosting(byId, row.id, index); addPosting(byName, row.normalizedName, index);
    for (const token of row.tokens) addPosting(byToken, token, index);
    for (const key of row.blockingKeys) addPosting(byBlocking, key, index);
    for (const gram of grams(row.normalizedName)) addPosting(byGram, gram, index);
  });
  for (const source of sources) {
    if (source.normalizedName) sourceNameFrequency.set(source.normalizedName, (sourceNameFrequency.get(source.normalizedName) ?? 0) + 1);
    if (source.id) sourceIdFrequency.set(source.id, (sourceIdFrequency.get(source.id) ?? 0) + 1);
  }
  function validate(index: number): IndexedRow {
    if (!Number.isInteger(index) || index < 0 || index >= sources.length) throw new RangeError("Dataset 2 row is out of range.");
    return sources[index];
  }
  function assessCandidates(index: number): CandidateAssessmentSet {
    const source = validate(index); const exactNames = byName.get(source.normalizedName) ?? [], exactIds = source.id ? byId.get(source.id) ?? [] : [];
    const indices = new Set<number>(), priority = new Map<number, number>(); let searchLimited = false;
    function append(posting: number[], strength: number, limit = 96) {
      if (posting.length > limit) searchLimited = true;
      for (const candidate of posting.slice(0, limit)) {
        if (!indices.has(candidate) && indices.size >= MAX_RETRIEVED) { searchLimited = true; break; }
        indices.add(candidate); priority.set(candidate, (priority.get(candidate) ?? 0) + strength);
      }
    }
    append(exactIds, 8, MAX_RETRIEVED); append(exactNames, 6, MAX_RETRIEVED);
    for (const key of source.blockingKeys) append(byBlocking.get(key) ?? [], 4);
    const postings = [...source.tokens].map((token) => byToken.get(token)).filter((posting): posting is number[] => Boolean(posting)).sort((left, right) => left.length - right.length);
    if (postings.length > 12) searchLimited = true;
    for (const posting of postings.slice(0, 12)) append(posting, .1);
    if (indices.size < 12 && !exactIds.length && !exactNames.length) {
      const near = grams(source.normalizedName).map((gram) => byGram.get(gram)).filter((posting): posting is number[] => Boolean(posting)).sort((left, right) => left.length - right.length);
      for (const posting of near.slice(0, 8)) append(posting, .02, 24);
      if (near.length > 8) searchLimited = true;
    }
    const ranked = [...indices].map((targetIndex) => ({ targetIndex, retrieval: (priority.get(targetIndex) ?? 0) + textEvidenceSimilarity(source.normalizedName, targets[targetIndex].normalizedName) })).sort((left, right) => right.retrieval - left.retrieval || left.targetIndex - right.targetIndex);
    if (ranked.length > MAX_ASSESSED) searchLimited = true;
    const candidates = ranked.slice(0, MAX_ASSESSED).map(({ targetIndex }) => ({ targetIndex, targetName: targets[targetIndex].name, assessment: assessRecordPair(dataset2.rows[index], dataset1.rows[targetIndex], mapping) }));
    candidates.sort((left, right) => right.assessment.score - left.assessment.score || left.assessment.conflicts.length - right.assessment.conflicts.length || rawAgreement(right.assessment) - rawAgreement(left.assessment) || left.targetIndex - right.targetIndex);
    return { candidates, candidateCount: candidates.length, searchLimited, exactNameCount: exactNames.length, exactIdCount: exactIds.length, sourceNameCount: sourceNameFrequency.get(source.normalizedName) ?? 0, sourceIdCount: sourceIdFrequency.get(source.id) ?? 0 };
  }
  return {
    total: sources.length, assessCandidates,
    compareRow(index) {
      const source = validate(index), set = assessCandidates(index), best = set.candidates[0];
      const assessment = assessmentForCandidate(set, best?.targetIndex ?? null);
      const decision = (lane: LocalDecision["lane"], explanation: string, targetIndex: number | null = null): LocalDecision => ({ rowIndex: index, name: source.name, targetIndex, targetName: targetIndex === null ? null : targets[targetIndex].name, lane, explanation, confidence: null, assessment });
      const limitNote = set.searchLimited ? " Retrieval used a bounded candidate set." : "";
      if (!best) {
        assessment.components = assessRecordPair(dataset2.rows[index], {}, mapping).components;
        return decision("no-match", "No candidate was retrieved. A zero evidence score records the absence of a comparison; it does not prove that no matching record exists." + limitNote);
      }
      if (assessment.conflicts.length) {
        const labels = assessment.components.filter((component) => assessment.conflicts.includes(component.field)).map((component) => component.label);
        return decision("no-match", `The best retrieved candidate conflicts on ${labels.slice(0, 3).join(", ")}. Automatic matching is blocked.${limitNote}`);
      }
      const agreements = assessment.components.filter((component) => component.status === "agree");
      const identifierAgrees = agreements.some((component) => component.kind === "identifier"), nameAgrees = agreements.some((component) => component.kind === "name");
      const corroborating = agreements.filter((component) => component.kind === "attribute" && component.weight >= 6).length;
      const uniqueExactSelectedId = compareIds && set.exactIdCount === 1 && (sourceIdFrequency.get(source.id) ?? 0) === 1;
      const unresolvedRepeatedSource = !uniqueExactSelectedId && (sourceNameFrequency.get(source.normalizedName) ?? 0) > 1 && corroborating < 2;
      if (automaticMatchAllowed(assessment, set) && !unresolvedRepeatedSource) {
        const rationale = uniqueExactSelectedId
          ? "The selected shared identifier matches exactly and is unique in both datasets."
          : `Identifying fields agree with no detected contradictions. Evidence score ${assessment.score}/100${assessment.margin === null ? "" : `, with a ${assessment.margin}-point lead`}.`;
        return decision("strong", rationale + limitNote, best.targetIndex);
      }
      if (assessment.margin === 0 || unresolvedRepeatedSource) return decision("review", "Several records or repeated names have equally strong evidence. Review the field details before choosing a target." + limitNote);
      if (assessment.score >= 55 || nameAgrees || identifierAgrees) return decision("review", `Evidence score ${assessment.score}/100. ${assessment.coverage < 75 ? "Important fields are missing or cannot be compared." : assessment.margin === null || assessment.margin >= 8 ? "The evidence does not meet the automatic-match rule." : "Another candidate has a similar score."}${limitNote}`, best.targetIndex);
      return decision("low", `Evidence score ${assessment.score}/100. The retrieved candidate has limited supporting evidence; review its fields before linking.${limitNote}`, best.targetIndex);
    },
  };
}
