import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Fully synthetic catalog. No names, rows, or identifiers come from user data.
// Truth is derived from canonical physical specifications, never matching output.
const CASE_ID = "case2";
const ROW_COUNT = 10_000;
const LIMIT = 20 * 1024 * 1024;
const directory = fileURLToPath(new URL("../../fixtures/stress/case2/", import.meta.url));
const headers = ["row_id", "item_name", "maker", "mfr_part", "series", "category", "kind", "material", "finish", "length", "width", "height", "dim_unit", "mass", "mass_unit", "size", "thread", "volts", "amps", "watts", "hz", "phase", "pressure", "press_unit", "seal", "capacity", "cap_unit", "pack_qty", "order_unit", "currency", "price", "country", "region", "cert", "revision", "status", "replaces", "stock", "lead_days", "note"] as const;
type Field = typeof headers[number];
type Row = Record<Field, string>;
type Spec = {
  maker: string; series: string; category: string; kind: string; material: string; finish: string;
  length: number; width: number; height: number; mass: number; size: string; thread: string;
  volts: number | null; amps: number | null; watts: number | null; hz: number | null; phase: number | null;
  pressure: number | null; seal: string; capacity: number | null; capUnit: string; packQty: number; orderUnit: string; revision: string;
};

const families = [
  { name: "Ball valve", code: "BV", category: "valves", short: "Ball vlv", translated: "Kugelhahn", material: "SS316", finish: "passivated", seal: "PTFE", electric: false },
  { name: "Gear motor", code: "GM", category: "motors", short: "Gear mtr", translated: "Getriebemotor", material: "aluminium", finish: "powder coat", seal: "NBR", electric: true },
  { name: "Linear bearing", code: "LB", category: "bearings", short: "Linear brg", translated: "Palier linéaire", material: "bearing steel", finish: "ground", seal: "NBR", electric: false },
  { name: "Cable gland", code: "CG", category: "cable entry", short: "Cable glnd", translated: "Presse-étoupe", material: "polyamide", finish: "natural", seal: "EPDM", electric: false },
  { name: "Pressure sensor", code: "PS", category: "sensors", short: "Press sns", translated: "Drucksensor", material: "SS316", finish: "electropolished", seal: "FKM", electric: true },
  { name: "Filter cartridge", code: "FC", category: "filters", short: "Filter cart", translated: "Cartouche filtrante", material: "polypropylene", finish: "natural", seal: "EPDM", electric: false },
  { name: "Socket bolt", code: "SB", category: "fasteners", short: "Skt bolt", translated: "Vis six pans", material: "steel 10.9", finish: "zinc plated", seal: "", electric: false },
  { name: "Hydraulic hose", code: "HH", category: "hoses", short: "Hyd hose", translated: "Hydraulikschlauch", material: "NBR rubber", finish: "braided", seal: "NBR", electric: false },
  { name: "Power contactor", code: "PC", category: "switchgear", short: "Pwr contactor", translated: "Leistungsschütz", material: "polyamide", finish: "natural", seal: "", electric: true },
  { name: "Shaft coupling", code: "SC", category: "couplings", short: "Shaft cplg", translated: "Accouplement", material: "steel", finish: "phosphated", seal: "", electric: false },
  { name: "Transfer pump", code: "TP", category: "pumps", short: "Transfer pmp", translated: "Förderpumpe", material: "SS316", finish: "brushed", seal: "FKM", electric: true },
  { name: "Flange gasket", code: "FG", category: "seals", short: "Flange gskt", translated: "Joint de bride", material: "FKM", finish: "moulded", seal: "FKM", electric: false },
] as const;
const makers = ["Aster", "Röhn Controls", "Nereid Works", "Mirador", "SoraTech", "Helix & Co", "Kōri Systems", "Atelier Élan"];
const countries = ["CH", "DE", "JP", "NL", "US", "FR", "IT", "SE"];
const shuffleSeeds = { referenceRows: 0x2a17_2026, incomingRows: 0x6b91_2026, incomingColumns: 0x51e3_2026 };
function shuffle<T>(values: T[], seed: number): void {
  let state = seed >>> 0;
  const random = () => {
    state += 0x6d2b79f5;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
  for (let index = values.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [values[index], values[other]] = [values[other], values[index]];
  }
}
const cohorts = [
  ["exact_name", "Exact names and specifications; baseline controls."],
  ["reordered_name", "Same model and specification with reordered name tokens."],
  ["abbreviated_name", "Industrial abbreviations, short manufacturer names and condensed units."],
  ["translated_name", "German/French product vocabulary with preserved technical specifications."],
  ["unit_conversion", "Exact inch/mm, kilogram/gram and kPa/bar conversions; no physical change."],
  ["unicode_punctuation", "Curly punctuation, nonbreaking spaces, accented maker names and fullwidth characters."],
  ["typographical_errors", "Inserted/transposed letters in product vocabulary with preserved model data."],
  ["manufacturer_alias", "Brand/legal-name aliases and additional catalog wording."],
  ["identical_name_variants", "Different reference variants intentionally have the same display name; full spec identifies one."],
  ["missing_identifiers", "Incoming manufacturer part number is missing, while physical fields remain complete."],
  ["duplicate_codes", "Different physical variants intentionally reuse a manufacturer part code."],
  ["kit_vs_item", "A service kit resembles a reference item but is a different orderable product."],
  ["pack_quantity_conflict", "Same apparent item name with a different pack size; orderable SKU is not equivalent."],
  ["electrical_lookalike", "Similar or identical name but incompatible electrical rating."],
  ["superseded_revision", "A new revision supersedes a reference; related does not mean interchangeable."],
  ["novel_unmatched", "New manufacturers/model series and physical specs absent from the reference catalog."],
  ["dimension_lookalike", "Same family/model wording with an incompatible physical dimension."],
  ["ambiguous_missing_variant", "Variant-bearing fields and part code are omitted; either of two variants fits."],
  ["duplicate_reference_listing", "Two reference listings describe the same full physical product; choosing one row is ambiguous."],
  ["mixed_transformations", "Reordering, abbreviations, Unicode, missing code and changed measurement units together."],
] as const;

function makeSpec(index: number): Spec {
  const pair = Math.floor(index / 2);
  const variant = index % 2;
  // Electrical lookalikes remain plausible electrical products, not bolts with voltages.
  const family = index >= 6500 && index < 7000 ? families[[1, 4, 8, 10][pair % 4]] : families[pair % families.length];
  const nominal = 10 + pair % 8 * 5 + variant * 5;
  return {
    maker: makers[pair % makers.length], series: `${family.code}-${1000 + pair}`, category: family.category,
    kind: "item", material: family.material, finish: family.finish,
    length: 25.4 * (2 + pair % 8 + variant), width: 12.7 * (1 + pair % 4), height: 6.35 * (1 + pair % 5),
    mass: (12 + pair % 70 + variant * 4) * 25, size: family.category === "fasteners" ? `M${nominal}` : `DN${nominal}`,
    thread: ["sensors", "valves", "cable entry", "fasteners", "hoses"].includes(family.category) ? `M${nominal}x1.5` : "",
    volts: family.electric ? [24, 48, 230, 400][(pair + variant) % 4] : null,
    amps: family.electric ? [0.02, 2, 8, 16][pair % 4] : null,
    watts: family.electric ? [0.5, 48, 250, 750][pair % 4] : null,
    hz: family.electric ? (pair % 2 ? 60 : 50) : null, phase: family.electric ? (pair % 3 ? 1 : 3) : null,
    pressure: ["sensors", "valves", "hoses", "pumps", "seals"].includes(family.category) ? 4 + pair % 20 * 4 + variant * 4 : null,
    seal: family.seal, capacity: ["filters", "pumps", "hoses"].includes(family.category) ? 10 + pair % 10 * 5 : null,
    capUnit: ["filters", "pumps", "hoses"].includes(family.category) ? "L/min" : "",
    packQty: family.category === "fasteners" ? (variant ? 50 : 25) : 1, orderUnit: "pack", revision: "A",
  };
}

function specKey(spec: Spec): string { return JSON.stringify(spec); }
function specHash(spec: Spec): string { return createHash("sha256").update(specKey(spec)).digest("hex").slice(0, 24); }
function familyFor(spec: Spec) { return families.find((family) => family.category === spec.category)!; }
function number(value: number | null): string { return value === null ? "" : String(Number(value.toFixed(6))); }
function nameFor(spec: Spec): string {
  return `${spec.maker} ${spec.series} ${familyFor(spec).name} ${spec.size}${spec.volts === null ? "" : ` ${spec.volts}V`}`;
}

function displayRow(spec: Spec, index: number, prefix: "R" | "I"): Row {
  const family = familyFor(spec);
  const country = countries[Math.floor(index / 2) % countries.length];
  return {
    row_id: `${prefix}${String(index + 1).padStart(5, "0")}`, item_name: nameFor(spec), maker: spec.maker,
    mfr_part: `${spec.series}-${spec.size}-${spec.volts ?? "M"}-${spec.revision}`, series: spec.series,
    category: spec.category, kind: spec.kind, material: spec.material, finish: spec.finish,
    length: number(spec.length), width: number(spec.width), height: number(spec.height), dim_unit: "mm",
    mass: number(spec.mass), mass_unit: "g", size: spec.size, thread: spec.thread,
    volts: number(spec.volts), amps: number(spec.amps), watts: number(spec.watts), hz: number(spec.hz), phase: number(spec.phase),
    pressure: number(spec.pressure), press_unit: spec.pressure === null ? "" : "bar", seal: spec.seal,
    capacity: number(spec.capacity), cap_unit: spec.capUnit, pack_qty: String(spec.packQty), order_unit: spec.orderUnit,
    currency: ["CHF", "EUR", "USD", "JPY"][index % 4], price: (8 + (index * 37 % 12500) / 100).toFixed(2),
    country, region: ["EU", "APAC", "NA", "EMEA"][index % 4], cert: family.electric ? "CE;RoHS" : "REACH;ISO9001",
    revision: spec.revision, status: "active", replaces: "", stock: String(index * 19 % 420), lead_days: String(2 + index % 28),
    note: index % 3 ? "Industrial duty" : "Dry storage; OEM spec",
  };
}

const referenceSpecs: Spec[] = Array.from({ length: ROW_COUNT }, (_, index) => makeSpec(index));
// These are duplicate listings of the same full product, not merely duplicated labels/codes.
for (let index = 9000; index < ROW_COUNT; index += 2) referenceSpecs[index + 1] = { ...referenceSpecs[index] };
const reference = referenceSpecs.map((spec, index) => displayRow(spec, index, "R"));
for (const [start, end] of [[4000, 4500], [8000, 9000]]) {
  for (let index = start; index < end; index += 1) {
    const spec = referenceSpecs[index];
    reference[index].item_name = `${spec.maker} ${spec.series} ${familyFor(spec).name}`;
  }
}
for (let index = 5000; index < 5500; index += 2) reference[index + 1].mfr_part = reference[index].mfr_part;

const referenceBySpec = new Map<string, string[]>();
for (let index = 0; index < referenceSpecs.length; index += 1) {
  const key = specKey(referenceSpecs[index]);
  referenceBySpec.set(key, [...(referenceBySpec.get(key) ?? []), reference[index].row_id]);
}

type TruthRow = { incomingRowId: string; incomingRowIndex: number; expectedRelation: "match" | "no-match" | "ambiguous"; acceptableReferenceIds: string[]; scenario: string; canonicalSpecHash: string | null; relatedReferenceIds?: string[]; omittedDiscriminants?: string[] };
const incoming: Row[] = [];
const truthRows: TruthRow[] = [];

function convertUnits(row: Row, spec: Spec) {
  row.length = number(spec.length / 25.4); row.width = number(spec.width / 25.4); row.height = number(spec.height / 25.4); row.dim_unit = "in";
  row.mass = number(spec.mass / 1000); row.mass_unit = "kg";
  if (spec.pressure !== null) { row.pressure = number(spec.pressure * 100); row.press_unit = "kPa"; }
}

for (let index = 0; index < ROW_COUNT; index += 1) {
  const cohort = Math.floor(index / 500);
  const within = index % 500;
  const referenceIndex = cohort === 17 ? 8000 + within * 2 : cohort === 18 ? 9000 + within * 2 : cohort === 19 ? 7000 + within : index;
  const original = referenceSpecs[referenceIndex];
  const spec: Spec = { ...original };
  if (cohort === 11) { spec.kind = "service kit"; spec.packQty += 2; }
  if (cohort === 12) spec.packQty = original.packQty === 1 ? 10 : original.packQty * 2;
  if (cohort === 13) { spec.volts = original.volts === null ? 12 : original.volts + 12; spec.amps = original.amps ?? 0.1; spec.watts = original.watts ?? 1.2; }
  if (cohort === 14) spec.revision = "C";
  if (cohort === 15) { spec.maker = "NovaForge"; spec.series = `NX-${90000 + within}`; spec.length += 3.175; }
  if (cohort === 16) spec.length += 1.5;
  const row = displayRow(spec, index, "I");
  row.price = (Number(row.price) * 1.07).toFixed(2);
  row.stock = String(index * 13 % 360); row.lead_days = String(1 + index % 21);
  row.note = "Distributor catalog";
  const family = familyFor(spec);
  if (cohort === 0) row.item_name = reference[referenceIndex].item_name;
  if (cohort === 1) row.item_name = `${spec.size} ${family.name} / ${spec.series} / ${spec.maker}${spec.volts === null ? "" : ` / ${spec.volts} V`}`;
  if (cohort === 2) { row.item_name = `${spec.series} ${family.short} ${spec.size} ${spec.maker.split(" ")[0]}`; row.category = family.short; }
  if (cohort === 3) { row.item_name = `${family.translated} ${spec.series} ${spec.size} — ${spec.maker}`; row.note = "Datenblatt geprüft"; }
  if (cohort === 4) { convertUnits(row, spec); row.item_name = `${spec.maker} ${spec.series} ${family.name} ${row.length}in`; }
  if (cohort === 5) row.item_name = nameFor(spec).replaceAll("-", "–").replaceAll(" ", "\u00a0").replace("V", "Ｖ") + "™";
  if (cohort === 6) row.item_name = nameFor(spec).replace(family.name, family.name[0] + family.name[2] + family.name[1] + family.name.slice(3));
  if (cohort === 7) { row.maker = spec.maker + " Industries GmbH"; row.item_name = `${family.name} ${spec.size}, ${spec.series} by ${row.maker}`; }
  if (cohort === 8) row.item_name = reference[referenceIndex].item_name;
  if (cohort === 9) { row.mfr_part = ""; row.item_name = `${spec.series}: ${family.name}, ${spec.size} (${spec.maker})`; }
  if (cohort === 10) { row.mfr_part = reference[referenceIndex].mfr_part; row.item_name = `${family.short} ${spec.series} ${spec.size} / ${spec.maker}`; }
  if ([11, 12, 13, 14, 16].includes(cohort)) {
    // Deliberately keep the old display name/code: full specification contradicts it.
    row.item_name = reference[referenceIndex].item_name;
    row.mfr_part = reference[referenceIndex].mfr_part;
  }
  if (cohort === 11) row.note = "Kit: body + seal + fasteners";
  if (cohort === 12) row.note = "Pack contents differ; do not split";
  if (cohort === 13) row.note = "Check electrical rating";
  if (cohort === 14) { row.replaces = reference[referenceIndex].mfr_part; row.status = "replacement"; row.note = "Revision C; fit not guaranteed"; }
  if (cohort === 16) row.note = "Dimension revised; fit differs";
  const omittedDiscriminants = ["mfr_part", "length", "mass", "size", "thread", "volts", "pressure", "pack_qty"];
  if (cohort === 17) {
    row.item_name = reference[referenceIndex].item_name;
    for (const field of omittedDiscriminants) row[field as Field] = "";
    row.note = "Variant details not supplied";
  }
  if (cohort === 18) row.item_name = reference[referenceIndex].item_name;
  if (cohort === 19) {
    convertUnits(row, spec); row.mfr_part = ""; row.maker = `${spec.maker} Intl.`;
    row.item_name = `${spec.size}\u2009${family.short} — ${spec.series.replace("-", "‑")} · ${spec.maker}`;
    row.note = "Mixed units; alias; code absent";
  }
  const acceptableReferenceIds = cohort === 17
    ? [reference[referenceIndex].row_id, reference[referenceIndex + 1].row_id]
    : referenceBySpec.get(specKey(spec)) ?? [];
  const expectedRelation = cohort === 17 || acceptableReferenceIds.length > 1 ? "ambiguous" : acceptableReferenceIds.length === 1 ? "match" : "no-match";
  incoming.push(row);
  truthRows.push({ incomingRowId: row.row_id, incomingRowIndex: index, expectedRelation, acceptableReferenceIds, scenario: cohorts[cohort][0], canonicalSpecHash: cohort === 17 ? null : specHash(spec), ...(cohort === 17 ? { omittedDiscriminants } : {}), ...([11, 12, 13, 14, 16].includes(cohort) ? { relatedReferenceIds: [reference[referenceIndex].row_id] } : {}) });
}

// Shuffle only after independent truth has been established. Identity stays in row keys;
// neither source ordering nor column position gives away the expected relationship.
shuffle(reference, shuffleSeeds.referenceRows);
shuffle(incoming, shuffleSeeds.incomingRows);
const incomingHeaders: Field[] = [...headers];
shuffle(incomingHeaders, shuffleSeeds.incomingColumns);
for (let index = 0; index < incoming.length; index += 1) incoming[index] = Object.fromEntries(incomingHeaders.map((field) => [field, incoming[index][field]])) as Row;
const incomingIndexById = new Map(incoming.map((row, index) => [row.row_id, index]));
for (const row of truthRows) row.incomingRowIndex = incomingIndexById.get(row.incomingRowId)!;
truthRows.sort((left, right) => left.incomingRowIndex - right.incomingRowIndex);

function xml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }
const referenceXml = '<?xml version="1.0" encoding="UTF-8"?>\n<records>\n' + reference.map((row) => "<record>" + headers.map((field) => `<${field}>${xml(row[field])}</${field}>`).join("") + "</record>").join("\n") + "\n</records>\n";
const incomingJsonl = incoming.map((row) => JSON.stringify(row)).join("\n") + "\n";
const sizes = {
  referenceFile: Buffer.byteLength(referenceXml), incomingFile: Buffer.byteLength(incomingJsonl),
  referenceNormalized: Buffer.byteLength(JSON.stringify(reference)), incomingNormalized: Buffer.byteLength(JSON.stringify(incoming)),
  normalizedCombined: Buffer.byteLength(JSON.stringify({ dataset1: { name: "Industrial reference.xml", rows: reference, nameField: "item_name" }, dataset2: { name: "Industrial incoming.jsonl", rows: incoming, nameField: "item_name" } })),
};
if (headers.length !== 40 || reference.length !== ROW_COUNT || incoming.length !== ROW_COUNT) throw new Error("Invalid fixture dimensions.");
if (sizes.referenceFile > LIMIT || sizes.incomingFile > LIMIT || sizes.normalizedCombined > LIMIT) throw new Error("Fixture exceeds the app's byte limits: " + JSON.stringify(sizes));
if (truthRows.filter((row) => row.expectedRelation === "match").some((row) => row.acceptableReferenceIds.length !== 1)) throw new Error("Truth contains an invalid unique match.");
const manifest = {
  caseId: CASE_ID, title: "Industrial catalog reconciliation", synthetic: true, generator: "scripts/stress/case2.ts", generatorVersion: 2, shuffleSeeds,
  dataset1: { file: "reference.xml", format: "xml", count: reference.length, columns: headers.length, headers, nameField: "item_name", keyField: "row_id", idField: "mfr_part", bytes: sizes.referenceFile, normalizedBytes: sizes.referenceNormalized },
  dataset2: { file: "incoming.jsonl", format: "jsonl", count: incoming.length, columns: headers.length, headers: incomingHeaders, nameField: "item_name", keyField: "row_id", idField: "mfr_part", bytes: sizes.incomingFile, normalizedBytes: sizes.incomingNormalized },
  recommendedMapping: { dataset1: { nameField: "item_name", idField: null }, dataset2: { nameField: "item_name", idField: null }, reason: "Use names only for the primary stress run. Manufacturer codes are intentionally missing, duplicated or stale; row_id identifies fixture rows and is not a shared business identifier." },
  truthFile: "truth.json", normalizedCombinedBytes: sizes.normalizedCombined,
  expectedCounts: Object.fromEntries(["match", "no-match", "ambiguous"].map((relation) => [relation, truthRows.filter((row) => row.expectedRelation === relation).length])),
  cohorts: cohorts.map(([scenario, description]) => ({ scenario, description, rows: truthRows.filter((row) => row.scenario === scenario).length })),
  truthDefinition: "A match requires equality of the full canonical physical specification, including maker/model, dimensions, materials, electrical ratings, kit/item, packaging and revision. Equivalent measurement units do not change identity. Superseding revisions and kits are related but not equivalent. Missing variant details or duplicate equivalent reference listings are ambiguous.",
  measurements: "Canonical dimensions are mm, mass g and pressure bar. Displayed inch/kg/kPa values are exact conversions of canonical values.",
};
await mkdir(directory, { recursive: true });
await Promise.all([
  writeFile(path.join(directory, "reference.xml"), referenceXml),
  writeFile(path.join(directory, "incoming.jsonl"), incomingJsonl),
  writeFile(path.join(directory, "truth.json"), JSON.stringify({ caseId: CASE_ID, schemaVersion: 1, canonicalSpecFields: Object.keys(referenceSpecs[0]), truthDefinition: manifest.truthDefinition, rows: truthRows }, null, 2) + "\n"),
  writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n"),
]);
console.log(JSON.stringify({ directory, counts: { reference: reference.length, incoming: incoming.length, columns: headers.length }, expected: manifest.expectedCounts, bytes: sizes }, null, 2));
