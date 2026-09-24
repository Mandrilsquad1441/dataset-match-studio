import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ExcelJS from "exceljs";

const SEED = 2026092301;
const output = fileURLToPath(new URL("../../fixtures/stress/case1/", import.meta.url));
const HEADERS = [
  "source_key", "company_name", "registration_id", "legal_name", "trade_name", "parent_name",
  "company_type", "industry", "segment", "status", "country", "region", "city", "postal_code",
  "street", "building", "suite", "branch_code", "website", "email", "phone", "tax_id", "vat_status",
  "currency", "language", "time_zone", "founded", "employee_band", "revenue_band", "credit_grade",
  "payment_terms", "customer_since", "last_verified", "updated_at", "crm_system", "account_status",
  "account_owner", "billing_country", "shipping_country", "risk_rating", "compliance_status",
  "contract_type", "renewal_month", "support_tier", "sales_region", "customer_tier",
  "preferred_channel", "import_batch", "legacy_account_id", "notes",
];
type Row = Record<string, string>;
type Relation = "match" | "no-match" | "ambiguous";
type Truth = { incomingKey: string; expectedRelation: Relation; acceptableReferenceKeys: string[]; scenario: string; entityKey: string | null };
const stems = ["Aster", "Brinwell", "Caldora", "Dovelin", "Elmridge", "Fallow", "Glenwick", "Harven", "Iverna", "Junera", "Kestrel", "Larkmere", "Merriton", "Northfen", "Orivel", "Perevin", "Quenby", "Riverton", "Solmere", "Ternwell", "Umber", "Vellora", "Wynford", "Xandora", "Yarrow", "Zelwick", "Ashmere", "Briarfen", "Corvell", "Dalestra", "Everfen", "Flinora", "Greenmere", "Holloway", "Ismere", "Jorven", "Kelstrad", "Lunera", "Morwick", "Novera"];
const activities = ["Analytics", "Instruments", "Logistics", "Textiles", "Materials", "Systems", "Foods", "Packaging", "Advisory", "Controls", "Components", "Design", "Networks", "Automation", "Trading", "Mobility", "Diagnostics", "Robotics", "Lighting", "Research", "Equipment", "Distribution", "Optics", "Services", "Manufacturing"];
const locales = [
  { country: "CH", city: "Zürich", region: "Zürich", suffix: "AG", currency: "CHF", language: "de", zone: "Europe/Zurich", street: "Lindenweg", post: "8001" },
  { country: "DE", city: "München", region: "Bayern", suffix: "GmbH", currency: "EUR", language: "de", zone: "Europe/Berlin", street: "Industriestraße", post: "80331" },
  { country: "FR", city: "Lyon", region: "Rhône", suffix: "SAS", currency: "EUR", language: "fr", zone: "Europe/Paris", street: "Rue des Ateliers", post: "69002" },
  { country: "JP", city: "Tōkyō", region: "Kantō", suffix: "KK", currency: "JPY", language: "ja", zone: "Asia/Tokyo", street: "Test Industrial Ave", post: "100-0001" },
  { country: "US", city: "Portland", region: "Oregon", suffix: "LLC", currency: "USD", language: "en", zone: "America/Los_Angeles", street: "Example Park", post: "97201" },
  { country: "GB", city: "Bristol", region: "England", suffix: "Ltd", currency: "GBP", language: "en", zone: "Europe/London", street: "Foundry Way", post: "BS1 1AA" },
  { country: "BR", city: "São Paulo", region: "São Paulo", suffix: "Ltda", currency: "BRL", language: "pt", zone: "America/Sao_Paulo", street: "Rua das Oficinas", post: "01000-000" },
  { country: "AE", city: "Dubai", region: "Dubai", suffix: "FZCO", currency: "AED", language: "ar", zone: "Asia/Dubai", street: "Example Trade Park", post: "00000" },
  { country: "IN", city: "Pune", region: "Maharashtra", suffix: "Pvt Ltd", currency: "INR", language: "en", zone: "Asia/Kolkata", street: "Sample Tech Road", post: "411001" },
  { country: "SE", city: "Göteborg", region: "Västra Götaland", suffix: "AB", currency: "SEK", language: "sv", zone: "Europe/Stockholm", street: "Verkstadsgatan", post: "411 01" },
  { country: "MX", city: "Mérida", region: "Yucatán", suffix: "SA", currency: "MXN", language: "es", zone: "America/Merida", street: "Calle del Taller", post: "97000" },
  { country: "SG", city: "Singapore", region: "Central", suffix: "Pte Ltd", currency: "SGD", language: "en", zone: "Asia/Singapore", street: "Example Works Lane", post: "018989" },
];
function rng(seed: number) { let value = seed >>> 0; return () => { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; return (value >>> 0) / 0x1_0000_0000; }; }
function shuffle<T>(values: T[], seed: number): T[] { const result = [...values]; const random = rng(seed); for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; } return result; }
const pad = (value: number, width = 6) => String(value).padStart(width, "0");
const refKey = (index: number) => "REF-" + pad(index + 1);
const entityKey = (index: number) => "ENTITY-" + pad(index + 1);
function transliterate(value: string): string { return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/ß/g, "ss").replace(/[øØ]/g, "o").replace(/[łŁ]/g, "l").replace(/[æÆ]/g, "ae").replace(/[đĐ]/g, "d"); }
function source(index: number): Row {
  const identity = (index * 1543) % 12000;
  const stem = stems[identity % stems.length];
  const activity = activities[Math.floor(identity / stems.length) % activities.length];
  const locale = locales[Math.floor(identity / (stems.length * activities.length)) % locales.length];
  const name = `${stem} ${activity} ${locale.city} ${locale.suffix}`;
  const key = pad(index + 1);
  return {
    source_key: refKey(index), company_name: name, registration_id: `${locale.country}-SYN-${key}`,
    legal_name: name, trade_name: `${stem} ${activity}`, parent_name: `${stem} Group`,
    company_type: locale.suffix, industry: activity, segment: ["SMB", "Enterprise", "Midmarket"][index % 3],
    status: index % 17 === 0 ? "Dormant" : "Active", country: locale.country, region: locale.region,
    city: locale.city, postal_code: locale.post, street: locale.street, building: String(index % 199 + 1),
    suite: "B" + String(index % 23 + 1), branch_code: locale.country + "-" + pad(index % 997, 3),
    website: `https://c${key}.example`, email: `crm@c${key}.example`, phone: "TEST-" + key,
    tax_id: "TEST-TAX-" + key, vat_status: index % 6 ? "Registered" : "Exempt", currency: locale.currency,
    language: locale.language, time_zone: locale.zone, founded: String(1970 + index % 52),
    employee_band: ["1-10", "11-50", "51-250", "251-1000", "1000+"][index % 5],
    revenue_band: ["<1m", "1-5m", "5-25m", "25-100m", "100m+"][index % 5],
    credit_grade: ["A1", "A2", "B1", "B2"][index % 4], payment_terms: ["NET30", "NET45", "NET60"][index % 3],
    customer_since: `${2010 + index % 14}-${pad(index % 12 + 1, 2)}-15`,
    last_verified: `2025-${pad(index % 12 + 1, 2)}-20`, updated_at: `2026-${pad(index % 8 + 1, 2)}-03`,
    crm_system: "Atlas CRM", account_status: index % 11 ? "Current" : "On hold", account_owner: "Team " + (index % 9 + 1),
    billing_country: locale.country, shipping_country: locales[(index + 3) % locales.length].country,
    risk_rating: ["Low", "Medium", "High"][index % 3], compliance_status: index % 9 ? "Cleared" : "Review",
    contract_type: ["Annual", "Rolling", "Project"][index % 3], renewal_month: `2027-${pad(index % 12 + 1, 2)}`,
    support_tier: ["Standard", "Priority", "Dedicated"][index % 3], sales_region: ["EMEA", "APAC", "AMER"][index % 3],
    customer_tier: ["Core", "Growth", "Strategic"][index % 3], preferred_channel: index % 2 ? "Email" : "Portal",
    import_batch: "REF-2026", legacy_account_id: "LEG-" + key, notes: index % 13 ? "Synthetic account" : "Synthetic; multiline\nCRM note",
  };
}

const references = Array.from({ length: 6000 }, (_, index) => source(index));
const accentPrefixes = ["Société Élan", "Müller & Söhne", "São Bento", "Łódź", "Tōyō", "Göteborg", "Århus", "İzmir", "Montréal", "Zürich", "Nørdlys", "Kraków"];
for (let index = 3000; index < 3650; index++) {
  references[index].company_name = `${accentPrefixes[index % accentPrefixes.length]} ${references[index].company_name}`;
  references[index].legal_name = references[index].company_name;
}
for (let index = 4150; index < 4600; index++) {
  const row = references[index];
  row.company_name = `${row.trade_name} ${index % 2 ? "East" : "West"} Branch ${row.city}`;
  row.legal_name = row.company_name;
  row.notes = "Regional service account";
}
// Distinct entities intentionally share a registration number in this bad legacy source.
for (let index = 5300; index < 5700; index++) {
  const pairStart = index - (index - 5300) % 2;
  const pair = Math.floor((index - 5300) / 2);
  const family = `${stems[pair % stems.length]} ${activities[Math.floor(pair / stems.length)]}`;
  references[index].registration_id = `DUP-SYN-${pad(pair + 1)}`;
  references[index].parent_name = family + " Holdings";
  references[index].trade_name = family;
  references[index].company_name = `${family} ${index === pairStart ? "North" : "South"} Service Centre`;
  references[index].legal_name = references[index].company_name;
  references[index].website = `https://group${pad(pair)}.example`;
}

const incoming: Row[] = [];
const truths: Truth[] = [];
function add(row: Row, relation: Relation, accepted: number[], scenario: string, identity: number | null) {
  row.source_key = "IN-" + pad(incoming.length + 1);
  row.crm_system = "Cedar CRM";
  row.import_batch = "IN-2026";
  row.updated_at = "2026-09-18";
  incoming.push(row);
  truths.push({ incomingKey: row.source_key, expectedRelation: relation, acceptableReferenceKeys: accepted.map(refKey), scenario, entityKey: identity === null ? null : entityKey(identity) });
}
for (let index = 0; index < references.length; index++) {
  const original = references[index];
  const row = { ...original };
  let scenario: string;
  if (index < 2100) {
    scenario = "exact_company_with_operational_drift";
    row.account_owner = "Team " + ((index + 2) % 9 + 1); row.support_tier = index % 2 ? "Standard" : "Priority";
  } else if (index < 3000) {
    scenario = "renamed_business_same_entity";
    row.company_name = `Novara ${original.industry} ${original.city} ${stems[index % stems.length]}`;
    row.legal_name = row.company_name; row.trade_name = "Novara " + original.industry; row.notes = "Name updated after rebrand";
  } else if (index < 3650) {
    scenario = "accent_transliteration_unicode";
    row.company_name = index % 5 === 0 ? original.company_name.normalize("NFD") : transliterate(original.company_name).toUpperCase();
    if (index % 7 === 0) row.company_name = row.company_name.replaceAll(" ", "\u00a0");
    row.legal_name = row.company_name;
  } else if (index < 4150) {
    scenario = "punctuation_spacing_legal_suffix";
    row.company_name = original.company_name.replaceAll(" ", index % 2 ? " — " : "  ").toUpperCase();
    if (index % 3 === 0) row.company_name = row.company_name.replace(/AG$/, "A.G.").replace(/LLC$/, "L.L.C.");
  } else if (index < 4600) {
    scenario = "branch_distinction";
    row.company_name = `${original.trade_name} / ${index % 2 ? "EAST" : "WEST"} office`;
    row.suite = original.suite.toLowerCase();
  } else if (index < 5300) {
    scenario = "missing_registration_id";
    row.registration_id = "";
    row.company_name = index % 4 === 0 ? `${original.trade_name} (${original.city})` : transliterate(original.company_name);
    if (index % 6 === 0) { row.tax_id = ""; row.email = ""; }
  } else if (index < 5700) {
    const pairStart = index - (index - 5300) % 2;
    if ((index - 5300) % 4 >= 2) {
      scenario = "duplicate_registration_ambiguous_branch";
      row.company_name = original.trade_name; row.legal_name = original.trade_name;
      for (const field of ["city", "region", "street", "postal_code", "building", "suite", "branch_code", "email", "phone", "tax_id", "legacy_account_id", "country", "billing_country", "shipping_country", "language", "time_zone"]) row[field] = "";
      row.notes = "Legacy branch unspecified";
      add(row, "ambiguous", [pairStart, pairStart + 1], scenario, null);
      continue;
    }
    scenario = "duplicate_registration_resolvable_branch";
    row.company_name = original.company_name.replace("Service Centre", "Svc. Center");
  } else {
    scenario = "conflicting_registration_clerical_error";
    row.registration_id = references[(index + 97) % 2100].registration_id;
    row.notes = "Migrated legacy account";
  }
  add(row, "match", [index], scenario, index);
}
// New legal subsidiaries resemble existing companies but are distinct entities.
for (let index = 0; index < 400; index++) {
  const parent = references[(index * 11 + 41) % 3000];
  const row = source(6000 + index);
  row.company_name = `${parent.trade_name} ${index % 2 ? "Digital" : "Components"} ${row.city}`;
  row.parent_name = parent.legal_name; row.legal_name = row.company_name;
  row.registration_id = "NEW-SUB-" + pad(index); row.tax_id = "NEW-TAX-" + pad(index);
  add(row, "no-match", [], "similar_distinct_subsidiary", 6000 + index);
}
// Coincidental same trading name, with different legal identity and corroborating fields.
for (let index = 0; index < 400; index++) {
  const reference = references[(index * 7 + 19) % 2100];
  const row = source(6400 + index);
  row.company_name = reference.company_name; row.legal_name = `${row.trade_name} Independent ${row.company_type}`;
  row.registration_id = "FF-SYN-" + pad(index); row.tax_id = "FF-TAX-" + pad(index);
  row.parent_name = "Independent Group"; row.notes = "Unrelated trading name";
  add(row, "no-match", [], "unique_same_name_false_friend", 6400 + index);
}
for (let index = 0; index < 1000; index++) {
  const row = source(6800 + index);
  row.company_name = `Vespera ${stems[index % stems.length]} ${activities[Math.floor(index / stems.length)]} ${row.city}`;
  row.legal_name = row.company_name; row.trade_name = "Vespera " + activities[Math.floor(index / stems.length)];
  row.registration_id = "NEW-SYN-" + pad(index); row.notes = "New customer intake";
  add(row, "no-match", [], "genuinely_new_unmatched_company", 6800 + index);
}
// Aggregated account records do not identify which pre-merger legal customer is represented.
for (let index = 0; index < 200; index++) {
  const a = index * 2 + 500;
  const b = a + 1;
  const row = { ...references[a] };
  row.company_name = `${references[a].trade_name} / ${references[b].trade_name}`;
  row.legal_name = row.company_name; row.trade_name = "Combined account"; row.parent_name = "Consolidated Group";
  for (const field of ["registration_id", "tax_id", "email", "website", "phone", "street", "building", "suite", "branch_code", "legacy_account_id", "city", "region", "postal_code", "country", "billing_country", "shipping_country"]) row[field] = "";
  row.notes = "Combined historical account";
  add(row, "ambiguous", [a, b], "merger_aggregate_unresolved_identity", null);
}

function csv(rows: Row[], headers: string[]): string { const quote = (value: string) => /[",\r\n]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value; return "\uFEFF" + [headers.join(","), ...rows.map((row) => headers.map((header) => quote(row[header] ?? "")).join(","))].join("\r\n") + "\r\n"; }
function stableZipDates(buffer: Buffer): Buffer {
  const bytes = Buffer.from(buffer);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("XLSX ZIP directory not found.");
  let offset = bytes.readUInt32LE(end + 16);
  const count = bytes.readUInt16LE(end + 10);
  const dosDate = (46 << 9) | (1 << 5) | 1;
  for (let index = 0; index < count; index++) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("Unexpected ZIP central directory.");
    bytes.writeUInt16LE(0, offset + 12); bytes.writeUInt16LE(dosDate, offset + 14);
    const local = bytes.readUInt32LE(offset + 42);
    bytes.writeUInt16LE(0, local + 10); bytes.writeUInt16LE(dosDate, local + 12);
    offset += 46 + bytes.readUInt16LE(offset + 28) + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return bytes;
}
function sha256(bytes: Buffer) { return createHash("sha256").update(bytes).digest("hex"); }

async function main() {
  if (HEADERS.length !== 50 || references.length !== 6000 || incoming.length !== 8000) throw new Error("Unexpected fixture dimensions.");
  const dataset1 = shuffle(references, SEED);
  const dataset2 = shuffle(incoming, SEED + 1);
  const incomingHeaders = shuffle(HEADERS, SEED + 2);
  const truthMap = new Map(truths.map((truth) => [truth.incomingKey, truth]));
  const orderedTruth = dataset2.map((row, incomingRowIndex) => ({ ...truthMap.get(row.source_key)!, incomingRowIndex }));
  const mapping = { nameField: "company_name", idField: "registration_id", recordKeyField: "source_key" };
  const firstName = "dataset1-crm-reference.csv";
  const secondName = "dataset2-crm-incoming.xlsx";
  const normalizedPayloadBytes = Buffer.byteLength(JSON.stringify({ dataset1: { name: firstName, rows: dataset1, nameField: mapping.nameField, idField: mapping.idField }, dataset2: { name: secondName, rows: dataset2.map((row) => Object.fromEntries(incomingHeaders.map((header) => [header, row[header]]))), nameField: mapping.nameField, idField: mapping.idField } }));
  if (normalizedPayloadBytes >= 20 * 1024 * 1024) throw new Error(`Normalized JSON exceeds 20 MiB: ${normalizedPayloadBytes}`);
  const csvBytes = Buffer.from(csv(dataset1, HEADERS), "utf8");
  const book = new ExcelJS.Workbook();
  book.creator = "Jev synthetic stress fixture generator"; book.created = new Date("2026-01-01T00:00:00Z"); book.modified = book.created;
  const sheet = book.addWorksheet("CRM Import");
  sheet.columns = incomingHeaders.map((header) => ({ header, key: header, width: header === "company_name" || header === "legal_name" ? 48 : 22, style: { numFmt: "@" } }));
  sheet.addRows(dataset2);
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  const noteSheet = book.addWorksheet("Import notes");
  noteSheet.getColumn(1).width = 100;
  noteSheet.addRows([["Synthetic CRM data; no real customer records."], ["Use CRM Import. Record name: company_name. Optional shared ID: registration_id."], ["The separate ground-truth JSON must not be imported into the matching app."]]);
  const xlsxBytes = stableZipDates(Buffer.from(await book.xlsx.writeBuffer()));
  if (csvBytes.length >= 20 * 1024 * 1024 || xlsxBytes.length >= 20 * 1024 * 1024) throw new Error("Input file exceeds 20 MiB.");
  const truthBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, caseId: "case1", synthetic: true, records: orderedTruth }, null, 2) + "\n");
  const scenarios = Object.fromEntries([...new Set(truths.map((truth) => truth.scenario))].map((scenario) => [scenario, truths.filter((truth) => truth.scenario === scenario).length]));
  const expectedRelations = Object.fromEntries((["match", "no-match", "ambiguous"] as const).map((relation) => [relation, truths.filter((truth) => truth.expectedRelation === relation).length]));
  const manifest = {
    schemaVersion: 1, caseId: "case1", title: "Multinational CRM merger", synthetic: true, seed: SEED,
    generator: "scripts/stress/case1.ts", regenerate: "npx tsx scripts/stress/case1.ts", generatedAt: "2026-01-01T00:00:00.000Z",
    files: {
      dataset1: { file: firstName, format: "csv", rows: dataset1.length, columns: HEADERS.length, bytes: csvBytes.length, sha256: sha256(csvBytes) },
      dataset2: { file: secondName, format: "xlsx", worksheet: "CRM Import", rows: dataset2.length, columns: incomingHeaders.length, bytes: xlsxBytes.length, sha256: sha256(xlsxBytes) },
      groundTruth: { file: "ground-truth.json", records: orderedTruth.length, bytes: truthBytes.length, sha256: sha256(truthBytes), importIntoApp: false },
    },
    mappings: { dataset1: mapping, dataset2: mapping }, headers: { dataset1: HEADERS, dataset2: incomingHeaders },
    normalizedPayloadBytes, normalizedPayloadMiB: Number((normalizedPayloadBytes / 1024 / 1024).toFixed(3)), scenarios, expectedRelations,
    design: [
      "Dataset 1 is the 6,000-row reference list; Dataset 2 is the 8,000-row incoming CRM extract.",
      "Select company_name as Record name in both. registration_id is the optional same-scheme shared identifier; it intentionally contains missing, duplicated and erroneous values.",
      "source_key is each source's durable row key, not a cross-dataset identity field. It must not be selected as a shared identifier.",
      "All domains use reserved .example. Phone and tax fields are explicitly synthetic. There are no real personal records.",
      "Ground truth follows generated legal/entity identity, not the current matching implementation. Wrong-ID same entities remain matches; same-name independent entities remain no-match.",
      "Ambiguous records are lossy branch projections or combined pre-merger accounts. They should remain under review, with all acceptable reference keys recorded in ground truth.",
      "Rows and incoming columns are deterministically shuffled. XLSX contains an additional notes sheet; import CRM Import only.",
      "Ground truth incomingRowIndex is zero-based and refers to the final shuffled incoming data order, excluding the header row.",
      "Input files contain no ground-truth relation, scenario or entityKey columns. Ground truth is a separate evaluation artifact.",
      "Workbook metadata and ZIP timestamps are fixed for reproducibility. Fifty meaningful CRM fields are present in each source.",
    ],
  };
  await mkdir(output, { recursive: true });
  await Promise.all([
    writeFile(path.join(output, firstName), csvBytes), writeFile(path.join(output, secondName), xlsxBytes),
    writeFile(path.join(output, "ground-truth.json"), truthBytes), writeFile(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n"),
  ]);
  console.log(JSON.stringify({ output, files: manifest.files, normalizedPayloadBytes, normalizedPayloadMiB: manifest.normalizedPayloadMiB, expectedRelations, scenarios }, null, 2));
}
await main();
