import companyReferenceUrl from "../../fixtures/stress/case1/dataset1-crm-reference.csv?url";
import companyIncomingUrl from "../../fixtures/stress/case1/dataset2-crm-incoming.xlsx?url";
import companyAnswerKeyUrl from "../../fixtures/stress/case1/ground-truth.json?url";
import industrialReferenceUrl from "../../fixtures/stress/case2/reference.xml?url";
import industrialIncomingUrl from "../../fixtures/stress/case2/incoming.jsonl?url";
import industrialAnswerKeyUrl from "../../fixtures/stress/case2/truth.json?url";
import type { SelectedDataset } from "../components/DatasetSourceCard";
import { MAX_DATASET_BYTES, parseDatasetFile } from "./dataset-input";
import { readBenchmarkAnswerKey, type BenchmarkAnswerKey } from "./benchmark";

export interface SampleDatasetMetadata {
  id: string;
  title: string;
  description: string;
  referenceRows: number;
  incomingRows: number;
  columns: number;
  formats: readonly [string, string];
}

export const SAMPLE_DATASETS: readonly SampleDatasetMetadata[] = [
  {
    id: "case1", title: "Company merger",
    description: "Synthetic companies with renamed businesses, multilingual names, conflicting IDs and similar subsidiaries.",
    referenceRows: 6000, incomingRows: 8000, columns: 50, formats: ["CSV", "XLSX"],
  },
  {
    id: "case2", title: "Industrial catalog",
    description: "Synthetic parts with unit conversions, near-identical specifications, revisions, packaging differences and missing details.",
    referenceRows: 10000, incomingRows: 10000, columns: 40, formats: ["XML", "JSONL"],
  },
];

interface SampleFile { url: string; name: string; type: string }
interface SampleSource extends SampleFile { nameField: string; idField?: string; worksheet?: string }
interface SampleAssets { first: SampleSource; second: SampleSource; answerKey: SampleFile }

// Mappings follow each fixture's manifest. Durable row keys belong only to the answer key.
const assets: Record<string, SampleAssets> = {
  case1: {
    first: { url: companyReferenceUrl, name: "dataset1-crm-reference.csv", type: "text/csv", nameField: "company_name", idField: "registration_id" },
    second: { url: companyIncomingUrl, name: "dataset2-crm-incoming.xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", nameField: "company_name", idField: "registration_id", worksheet: "CRM Import" },
    answerKey: { url: companyAnswerKeyUrl, name: "ground-truth.json", type: "application/json" },
  },
  case2: {
    // Manufacturer part numbers are intentionally missing, duplicated or stale. The
    // manifest recommends names without a shared ID; technical fields remain available.
    first: { url: industrialReferenceUrl, name: "reference.xml", type: "application/xml", nameField: "item_name" },
    second: { url: industrialIncomingUrl, name: "incoming.jsonl", type: "application/x-ndjson", nameField: "item_name" },
    answerKey: { url: industrialAnswerKeyUrl, name: "truth.json", type: "application/json" },
  },
};

async function fetchSampleFile(asset: SampleFile, signal: AbortSignal): Promise<File> {
  signal.throwIfAborted();
  const response = await fetch(asset.url, { signal, credentials: "same-origin" });
  if (!response.ok) throw new Error(`Could not load ${asset.name} (HTTP ${response.status}).`);
  if (!response.body) throw new Error(`The sample file ${asset.name} is empty.`);
  if (Number(response.headers.get("content-length")) > MAX_DATASET_BYTES) {
    await response.body.cancel();
    throw new Error(`The sample file ${asset.name} exceeds the 20 MB import limit.`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_DATASET_BYTES) {
        await reader.cancel();
        throw new Error(`The sample file ${asset.name} exceeds the 20 MB import limit.`);
      }
      chunks.push(new Uint8Array(part.value));
    }
  } finally { reader.releaseLock(); }
  signal.throwIfAborted();
  return new File(chunks, asset.name, { type: asset.type, lastModified: 0 });
}

async function parseSampleSource(file: File, source: SampleSource, signal: AbortSignal): Promise<SelectedDataset> {
  signal.throwIfAborted();
  const dataset = await parseDatasetFile(file, { worksheet: source.worksheet });
  signal.throwIfAborted();
  if (!dataset.headers.includes(source.nameField) || (source.idField && !dataset.headers.includes(source.idField))) {
    throw new Error(`The column mapping for ${file.name} no longer matches the sample file.`);
  }
  return { ...dataset, nameField: source.nameField, ...(source.idField ? { idField: source.idField } : {}), sourceFile: file };
}

/** Load a complete pair atomically; answer-key labels never become dataset fields. */
export async function loadSampleDataset(id: string, signal?: AbortSignal): Promise<{
  id: string;
  first: SelectedDataset;
  second: SelectedDataset;
  answerKey: BenchmarkAnswerKey;
}> {
  const metadata = SAMPLE_DATASETS.find((sample) => sample.id === id);
  if (!metadata) throw new Error("Choose an available sample dataset.");
  const sample = assets[id];
  const controller = new AbortController();
  const deadline = AbortSignal.timeout(60_000);
  const activeSignal = AbortSignal.any([controller.signal, deadline, ...(signal ? [signal] : [])]);
  activeSignal.throwIfAborted();
  try {
    const [firstFile, secondFile, answerKeyFile] = await Promise.all([
      fetchSampleFile(sample.first, activeSignal),
      fetchSampleFile(sample.second, activeSignal),
      fetchSampleFile(sample.answerKey, activeSignal),
    ]);
    activeSignal.throwIfAborted();
    const [first, second] = await Promise.all([
      parseSampleSource(firstFile, sample.first, activeSignal),
      parseSampleSource(secondFile, sample.second, activeSignal),
    ]);
    if (first.rows.length !== metadata.referenceRows || second.rows.length !== metadata.incomingRows || first.headers.length !== metadata.columns || second.headers.length !== metadata.columns) {
      throw new Error("The sample dimensions no longer match its description.");
    }
    activeSignal.throwIfAborted();
    const answerKey = await readBenchmarkAnswerKey(answerKeyFile, first, second);
    activeSignal.throwIfAborted();
    return { id, first, second, answerKey };
  } catch (cause) {
    controller.abort();
    if (deadline.aborted && !signal?.aborted) throw new Error("Loading the sample took too long. Try again.");
    throw cause;
  }
}
