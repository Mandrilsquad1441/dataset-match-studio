import { flattenFields } from "./normalize";

export interface EvidenceReference {
  side: "internal" | "vendor";
  path: string;
}

export function validateEvidenceReferences(
  references: EvidenceReference[],
  state: { internal: unknown; vendor: unknown },
): { valid: EvidenceReference[]; invalid: EvidenceReference[] } {
  const allowed = new Set([
    ...Object.keys(flattenFields(state.internal)).map((path) => "internal." + path),
    ...Object.keys(flattenFields(state.vendor)).map((path) => "vendor." + path),
  ]);
  const valid: EvidenceReference[] = [];
  const invalid: EvidenceReference[] = [];
  for (const reference of references) {
    const candidate = { side: reference.side, path: reference.path };
    (allowed.has(reference.side + "." + reference.path) ? valid : invalid).push(candidate);
  }
  return { valid, invalid };
}
