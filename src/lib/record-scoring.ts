import { normalizeText } from "./normalize";

export const RECORD_SCORE_VERSION = "record-evidence-v1";

export interface FieldEvidence {
  field: string;
  targetField: string | null;
  label: string;
  kind: "name" | "identifier" | "attribute";
  status: "agree" | "similar" | "conflict" | "missing";
  sourceValue: string | null;
  targetValue: string | null;
  weight: number;
  contribution: number;
  explanation: string;
}

export interface PairAssessment {
  /** Deterministic evidence points, never a probability of correctness. */
  score: number;
  scoreVersion: string;
  components: FieldEvidence[];
  /** Percentage of available weighted evidence that can be compared, from 0 to 100. */
  coverage: number;
  /** Source field keys with blocking identity contradictions. */
  conflicts: string[];
}

export interface CandidateAlternative {
  targetIndex: number;
  targetName: string;
  score: number;
  coverage: number;
  conflicts: string[];
}

export interface RecordAssessment extends PairAssessment {
  /** Candidate whose fields produced this score; it may have been rejected as a match. */
  assessedTargetIndex?: number | null;
  assessedTargetName?: string | null;
  candidateCount: number;
  margin: number | null;
  searchLimited: boolean;
  alternatives: CandidateAlternative[];
}

export interface PairFieldMapping {
  sourceNameField: string;
  targetNameField: string;
  sourceIdField?: string;
  targetIdField?: string;
}

type Measurement = "length" | "mass" | "pressure" | "voltage" | "current" | "power" | "frequency" | "flow";
type Rule = { key: string; label: string; weight: number; hard: boolean; kind?: "identifier"; numeric?: boolean; measure?: Measurement };
type Feature = { field: string; text: string; normalized: string; rule: Rule; number: number | null; unit: string | null };
type Prepared = Map<string, Feature>;
const preparedCache = new WeakMap<Record<string, unknown>, Prepared>();
const rules = new Map<string, Rule>();
const aliasRules = new Map<string, Rule>();

function define(key: string, label: string, weight: number, aliases: string, extra: Partial<Rule> = {}) {
  const rule: Rule = { key, label, weight, hard: true, ...extra };
  rules.set(key, rule);
  for (const alias of [key, ...aliases.split("|")]) aliasRules.set(alias, rule);
}
define("manufacturer", "Manufacturer", 10, "maker|mfr|manufacturer_name|brand|brand_name", { hard: false });
define("model", "Model / series", 18, "series|model_number|model_no|model_code|model_name");
define("part_number", "Manufacturer part number", 28, "mfr_part|mpn|part_no|part_num|manufacturer_part_number|manufacturer_part|article_number", { kind: "identifier" });
define("gtin", "GTIN / barcode", 32, "ean|upc|barcode|ean13|gtin14", { kind: "identifier" });
define("sku", "SKU", 24, "product_code|catalog_code|catalog_number|catalogue_number", { kind: "identifier" });
define("kind", "Item / kit", 20, "is_kit|kit_flag|is_bundle|bundle_flag|item_kind|product_kind");
define("category", "Category", 6, "product_category|family|product_family", { hard: false });
define("record_type", "Record type", 12, "entity_type|object_type");
define("material", "Material", 12, "material_type|material_grade|substrate");
define("finish", "Finish", 7, "surface_finish|coating|surface_treatment");
define("length", "Length", 16, "length_mm|length_cm|length_m|length_in|length_inches|len", { measure: "length" });
define("width", "Width", 14, "width_mm|width_cm|width_m|width_in|width_inches", { measure: "length" });
define("height", "Height", 14, "height_mm|height_cm|height_m|height_in|height_inches", { measure: "length" });
define("diameter", "Diameter", 16, "diameter_mm|diameter_cm|diameter_in|dia|bore|bore_mm", { measure: "length" });
define("thickness", "Thickness", 14, "thickness_mm|thickness_cm|thickness_in|depth|depth_mm", { measure: "length" });
define("mass", "Mass", 6, "weight|weight_g|weight_kg|mass_g|mass_kg", { measure: "mass" });
define("size", "Size", 14, "nominal_size|nominal_diameter|dn|size_code");
define("thread", "Thread", 14, "thread_size|thread_spec|thread_type");
define("voltage", "Voltage", 20, "volts|voltage_v|rated_voltage|input_voltage|supply_voltage", { measure: "voltage" });
define("current", "Current", 12, "amps|amperes|current_a|rated_current", { measure: "current" });
define("power", "Power", 12, "watts|power_w|rated_power|power_kw", { measure: "power" });
define("frequency", "Frequency", 10, "hz|frequency_hz|rated_frequency", { measure: "frequency" });
define("phase", "Phase", 14, "phases|phase_count", { numeric: true });
define("pressure", "Pressure", 16, "pressure_bar|rated_pressure|max_pressure|pressure_kpa|pressure_mpa|pressure_psi", { measure: "pressure" });
define("seal", "Seal material", 10, "seal_material|gasket_material|sealing_material");
define("capacity", "Capacity / flow", 10, "flow|flow_rate|flow_capacity|rated_capacity", { measure: "flow" });
define("pack_qty", "Pack quantity", 20, "pack_quantity|package_qty|package_quantity|pack_size|units_per_pack|quantity_per_pack|inner_qty", { numeric: true });
define("order_unit", "Order unit", 8, "order_uom|sales_unit|selling_unit|unit_of_sale");
define("revision", "Revision", 18, "rev|product_revision|hardware_revision");
define("email", "Email", 24, "email_address|contact_email", { kind: "identifier" });
define("tax_id", "Tax / registration ID", 28, "vat_id|vat_number|tax_number|registration_number|company_number|registry_id", { kind: "identifier" });
define("serial_number", "Serial number", 28, "serial_no|serial", { kind: "identifier" });
define("postcode", "Postal code", 12, "postal_code|zip|zip_code");
define("address", "Street address", 12, "street_address|address_line_1|street", { hard: false });
define("city", "City", 6, "town|locality", { hard: false });
define("country", "Country", 4, "country_code", { hard: false });

const ignored = /^(?:row_?id|source_?id|(?:source|incoming|reference|record|row|entity|internal|external)_(?:id|key|row.*|index)|record_?id|id|uuid|index|row_number|line_number|.*_timestamp|.*_at|created.*|updated.*|ingest.*|import.*|source_file.*|file_?name|file_?path|batch.*|tenant.*|workspace.*|trace.*|request.*|run_?id|currency.*|price.*|.*_price|cost.*|stock.*|inventory.*|lead_days|lead_time|status|lifecycle|replaces|supersedes|note|notes|comment|comments|description|cert|certification|region|url|uri|website|confidence|score|score_version|model_version|expected_relation|ground_truth|.*_unit|.*_uom|uom|dim_unit|cap_unit|press_unit|unit)$/;
const unitRules: Record<Measurement, { fields: string[]; factors: Record<string, number>; canonical: string; implicit?: string }> = {
  length: { fields: ["dim_unit", "dimension_unit", "length_unit"], factors: { mm: 1, millimeter: 1, millimeters: 1, cm: 10, centimeter: 10, m: 1000, meter: 1000, in: 25.4, inch: 25.4, inches: 25.4, ft: 304.8, feet: 304.8 }, canonical: "mm" },
  mass: { fields: ["mass_unit", "weight_unit"], factors: { g: 1, gram: 1, grams: 1, kg: 1000, kilogram: 1000, kilograms: 1000, lb: 453.59237, lbs: 453.59237, oz: 28.349523125 }, canonical: "g" },
  pressure: { fields: ["press_unit", "pressure_unit"], factors: { bar: 1, kpa: .01, pa: .00001, mpa: 10, psi: .0689475729 }, canonical: "bar" },
  voltage: { fields: ["voltage_unit"], factors: { v: 1, volt: 1, volts: 1, kv: 1000, mv: .001 }, canonical: "V", implicit: "v" },
  current: { fields: ["current_unit"], factors: { a: 1, amp: 1, amps: 1, ma: .001 }, canonical: "A", implicit: "a" },
  power: { fields: ["power_unit"], factors: { w: 1, watt: 1, watts: 1, kw: 1000 }, canonical: "W", implicit: "w" },
  frequency: { fields: ["frequency_unit"], factors: { hz: 1, khz: 1000, mhz: 1_000_000 }, canonical: "Hz", implicit: "hz" },
  flow: { fields: ["cap_unit", "capacity_unit", "flow_unit"], factors: { "l min": 1, lpm: 1, "l s": 60, "m3 h": 1000 / 60, gpm: 3.785411784 }, canonical: "L/min" },
};

export function recordText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value).trim() : "";
}
function keyName(value: string): string { return normalizeText(value.replace(/([a-z])([A-Z])/g, "$1_$2")).replaceAll(" ", "_"); }
function missing(value: string): boolean { return !value || /^(?:n\/?a|null|undefined|unknown|not available|-)$/i.test(value); }
function normalizedValue(value: string, rule: Rule): string {
  let normalized = normalizeText(value);
  if (rule.key === "manufacturer") normalized = normalized.replace(/\b(?:incorporated|inc|limited|ltd|llc|gmbh|ag|intl|international|industries|co|company)\b/g, " ").replace(/\s+/g, " ").trim();
  if (rule.key === "kind") {
    if (/\b(?:kit|bundle|set)\b/.test(normalized) || /^(?:true|yes|1)$/.test(normalized)) return "kit";
    if (/^(?:false|no|0|item|single|individual)$/.test(normalized)) return "item";
  }
  if (rule.key === "revision") normalized = normalized.replace(/^(?:rev|revision)\s*/, "");
  if (rule.key === "material" || rule.key === "seal") normalized = normalized.replace(/\b(?:stainless steel|stainless|acier inoxydable|edelstahl|ss|aisi)\s*(316l?|304l?)\b/g, "ss$1");
  if (rule.key === "order_unit") normalized = normalized.replace(/^(?:ea|each|piece|pieces|pc|pcs)$/, "item").replace(/^(?:pk|package|pkg)$/, "pack");
  if (rule.kind === "identifier" && rule.key !== "email") return value.normalize("NFC");
  return normalized;
}

function prepare(row: Record<string, unknown>): Prepared {
  const cached = preparedCache.get(row);
  if (cached) return cached;
  const raw = new Map(Object.entries(row).map(([field, value]) => [keyName(field), { field, text: recordText(value) }]));
  const result: Prepared = new Map();
  for (const [key, value] of raw) {
    if (ignored.test(key) && !aliasRules.has(key)) continue;
    const rule = aliasRules.get(key) ?? { key, label: value.field.replaceAll("_", " "), weight: 2, hard: false };
    const feature: Feature = { ...value, rule, normalized: missing(value.text) ? "" : normalizedValue(value.text, rule), number: null, unit: null };
    if (!missing(value.text) && (rule.measure || rule.numeric)) {
      const numberText = value.text.replace(/(?<=\d),(?=\d{3}(?:\D|$))/g, "");
      const parsed = numberText.match(/^([-+]?\d+(?:[.,]\d+)?(?:e[-+]?\d+)?)\s*(.*?)$/i);
      if (parsed) {
        feature.number = Number(parsed[1].replace(",", "."));
        if (rule.measure) {
          const units = unitRules[rule.measure];
          const suffix = key.split("_").at(-1)!;
          const hintedUnit = Object.hasOwn(units.factors, suffix) ? suffix : "";
          const explicitUnit = raw.get(key + "_unit")?.text || units.fields.map((field) => raw.get(field)?.text).find(Boolean);
          const unit = normalizeText(parsed[2] || explicitUnit || hintedUnit || units.implicit || "");
          if (Object.hasOwn(units.factors, unit)) { feature.number *= units.factors[unit]; feature.unit = units.canonical; }
          else feature.unit = unit || null;
        }
      }
    }
    // Prefer populated aliases without counting the same concept multiple times.
    if (!result.has(rule.key) || !result.get(rule.key)!.normalized) result.set(rule.key, feature);
  }
  preparedCache.set(row, result);
  return result;
}

/** Cheap, bounded lexical score for retrieval ordering; also not a probability. */
export function textEvidenceSimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const a = new Set(left.split(" ").filter(Boolean).slice(0, 32));
  const b = new Set(right.split(" ").filter(Boolean).slice(0, 32));
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  const jaccard = shared / Math.max(1, a.size + b.size - shared);
  const pairs = (value: string) => { const compact = value.replaceAll(" ", "").slice(0, 160); const set = new Set<string>(); for (let index = 1; index < compact.length; index += 1) set.add(compact.slice(index - 1, index + 1)); return set; };
  const aa = pairs(left); const bb = pairs(right); let intersection = 0;
  for (const pair of aa) if (bb.has(pair)) intersection += 1;
  return Math.max(jaccard, .92 * 2 * intersection / Math.max(1, aa.size + bb.size));
}

/** Public blocking hints expose no hidden truth and never include row/ingestion identifiers. */
export function recordBlockingKeys(row: Record<string, unknown>): string[] {
  const features = prepare(row);
  return ["model", "part_number", "gtin", "sku", "email", "tax_id", "serial_number"].flatMap((key) => {
    const feature = features.get(key);
    return feature?.normalized ? [`${key}:${feature.normalized}`] : [];
  });
}

function compareFeature(source: Feature | undefined, target: Feature | undefined, fallback: Rule): { evidence: FieldEvidence; blocking: boolean } {
  const rule = source?.rule ?? target?.rule ?? fallback;
  const field = source?.field ?? rule.key;
  const component: FieldEvidence = { field, targetField: target?.field ?? null, label: rule.label, kind: rule.kind ?? "attribute", status: "missing", sourceValue: source?.text || null, targetValue: target?.text || null, weight: rule.weight, contribution: 0, explanation: "A value is missing from one dataset." };
  if (!source?.normalized || !target?.normalized) return { evidence: component, blocking: false };
  let same = source.normalized === target.normalized;
  let unitEquivalent = false;
  if (rule.numeric || rule.measure) {
    if (source.number !== null && target.number !== null) {
      if (source.unit !== target.unit) { component.explanation = "The measurement units are missing or cannot be reconciled."; return { evidence: component, blocking: false }; }
      same = Math.abs(source.number - target.number) <= Math.max(.000001, Math.abs(target.number) * .000001);
      unitEquivalent = same && source.text !== target.text && Boolean(source.unit);
    } else if (!same) { component.explanation = "A numeric attribute could not be parsed consistently."; return { evidence: component, blocking: false }; }
  }
  if (same) {
    component.status = "agree"; component.contribution = rule.weight;
    component.explanation = unitEquivalent ? `Values agree after conversion to ${source.unit}.` : "Values agree after normalization.";
    return { evidence: component, blocking: false };
  }
  const similarity = rule.kind || rule.numeric || rule.measure ? 0 : textEvidenceSimilarity(source.normalized, target.normalized);
  if (!rule.hard && similarity >= .4) {
    component.status = "similar"; component.contribution = Math.round(rule.weight * similarity * 100) / 100;
    component.explanation = "Text overlaps but is not an exact agreement.";
    return { evidence: component, blocking: false };
  }
  component.status = "conflict";
  component.explanation = rule.hard ? "This identifying attribute differs and blocks an automatic match." : "Values differ; this field does not by itself prove a different identity.";
  return { evidence: component, blocking: rule.hard };
}

export function assessRecordPair(sourceRow: Record<string, unknown>, targetRow: Record<string, unknown>, mapping: PairFieldMapping): PairAssessment {
  const sourceName = recordText(sourceRow[mapping.sourceNameField]);
  const targetName = recordText(targetRow[mapping.targetNameField]);
  const normalizedSourceName = normalizeText(sourceName), normalizedTargetName = normalizeText(targetName);
  const nameSimilarity = textEvidenceSimilarity(normalizedSourceName, normalizedTargetName);
  const components: FieldEvidence[] = [{ field: mapping.sourceNameField, targetField: mapping.targetNameField, label: "Record name", kind: "name", status: !sourceName || !targetName ? "missing" : nameSimilarity === 1 ? "agree" : nameSimilarity > .15 ? "similar" : "conflict", sourceValue: sourceName || null, targetValue: targetName || null, weight: 30, contribution: Math.round(30 * nameSimilarity * 100) / 100, explanation: nameSimilarity === 1 ? "Names agree after normalizing case, accents and punctuation." : "Name similarity contributes retrieval evidence; it is not proof of identity." }];
  const conflicts: string[] = [];
  const excludedSource = new Set([mapping.sourceNameField]);
  const excludedTarget = new Set([mapping.targetNameField]);
  if (mapping.sourceIdField && mapping.targetIdField) {
    const left = recordText(sourceRow[mapping.sourceIdField]).normalize("NFC");
    const right = recordText(targetRow[mapping.targetIdField]).normalize("NFC");
    const agree = left && right && left === right;
    const conflict = left && right && left !== right;
    components.push({ field: mapping.sourceIdField, targetField: mapping.targetIdField, label: "Selected shared identifier", kind: "identifier", status: agree ? "agree" : conflict ? "conflict" : "missing", sourceValue: left || null, targetValue: right || null, weight: 40, contribution: agree ? 40 : 0, explanation: agree ? "The selected shared identifiers agree exactly." : conflict ? "The selected shared identifiers differ and block an automatic match." : "A selected identifier is missing; it cannot establish identity." });
    if (conflict) conflicts.push(mapping.sourceIdField);
    excludedSource.add(mapping.sourceIdField); excludedTarget.add(mapping.targetIdField);
  }
  const source = prepare(sourceRow), target = prepare(targetRow);
  const keys = [...new Set([...source.keys(), ...target.keys()])].sort();
  for (const key of keys) {
    const left = source.get(key), right = target.get(key);
    if ((left && excludedSource.has(left.field)) || (right && excludedTarget.has(right.field))) continue;
    if (!left?.normalized && !right?.normalized) continue;
    const rule = left?.rule ?? right!.rule;
    // An unrelated extra column is not "missing evidence" unless its meaning is known.
    if (!rules.has(key) && (!left || !right)) continue;
    const { evidence, blocking } = compareFeature(left, right, rule);
    components.push(evidence);
    if (blocking) conflicts.push(evidence.field);
  }
  const weight = components.reduce((sum, component) => sum + component.weight, 0);
  const observedWeight = components.filter((component) => component.status !== "missing").reduce((sum, component) => sum + component.weight, 0);
  let score = weight ? Math.round(100 * components.reduce((sum, component) => sum + component.contribution, 0) / weight) : 0;
  // A perfect name-only agreement has limited evidence, even if it is the only candidate.
  if (!components.some((component) => component.kind !== "name" && component.status === "agree")) score = Math.min(score, 65);
  if (conflicts.length) score = Math.min(score, components.some((component) => component.label === "Selected shared identifier" && component.status === "conflict") ? 25 : 49);
  return { score: Math.max(0, Math.min(100, score)), scoreVersion: RECORD_SCORE_VERSION, components, coverage: weight ? Math.round(observedWeight / weight * 1000) / 10 : 0, conflicts: [...new Set(conflicts)] };
}
