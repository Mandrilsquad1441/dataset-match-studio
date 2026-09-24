import { DATASET_ACCEPT, MAX_DATASET_BYTES, parseDatasetFile, type DatasetInput } from "./dataset-input";

const fileExtensions = new Set(DATASET_ACCEPT.split(",").map((extension) => extension.slice(1)));
const publicLinkHelp = "This link could not be read. Use a public direct HTTPS link that allows browser access (CORS) and does not redirect. You can also paste the data or export a file.";

function publicUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("Enter a complete HTTPS link to a data file or API response."); }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Use a public HTTPS link without a username or password.");
  }
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  const labels = host.split(".");
  const localSuffixes = ["localhost", "local", "localdomain", "internal", "lan", "home", "home.arpa", "test", "invalid"];
  const local = localSuffixes.some((suffix) => host === suffix || host.endsWith("." + suffix));
  // Browsers normalize alternate IPv4 spellings before exposing hostname.
  // Restrict this feature to public-looking DNS names, rather than IP links.
  const validDns = host.length <= 253 && labels.length >= 2 && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
  const ipAddress = host.includes(":") || host.includes("[") || /^[\d.]+$/.test(host);
  if (!validDns || local || ipAddress) {
    throw new Error("Use a public HTTPS hostname. Local hosts and IP address links are not supported.");
  }
  url.hostname = host;
  url.hash = "";
  return url;
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Reading the link was cancelled or timed out. Try again, paste the data, or upload a file.");
}

function sourceName(url: URL, contentType: string): string {
  let name = url.pathname.split("/").pop() || "Linked data";
  try { name = decodeURIComponent(name); } catch { /* Keep the original filename when its URL escape is malformed. */ }
  const extension = name.toLowerCase().split(".").at(-1) ?? "";
  // NDJSON has to be identified before JSON, including APIs whose path ends in .json.
  if (/(?:ndjson|jsonl|jsonlines|json-lines)/.test(contentType)) return /\.(?:jsonl|ndjson)$/i.test(name) ? name : name + ".jsonl";
  if (fileExtensions.has(extension)) return name;
  if (/spreadsheetml\.sheet/.test(contentType)) return name + ".xlsx";
  if (/xml/.test(contentType)) return name + ".xml";
  if (/json/.test(contentType)) return name + ".json";
  if (/csv/.test(contentType)) return name + ".csv";
  if (/tab-separated/.test(contentType)) return name + ".tsv";
  // TXT uses the same content detection as pasted data and keeps BOM-aware decoding.
  return name + ".txt";
}

/** Read a single public response in the browser; never send cookies or follow redirects. */
export async function readPublicDatasetUrl(value: string, signal: AbortSignal): Promise<{ dataset: DatasetInput; file: File | null }> {
  const url = publicUrl(value);
  checkAbort(signal);
  let response: Response;
  try {
    response = await fetch(url.href, { signal, credentials: "omit", referrerPolicy: "no-referrer", redirect: "error" });
  } catch {
    checkAbort(signal);
    throw new Error(publicLinkHelp);
  }
  checkAbort(signal);
  if (!response.ok || !response.body || response.redirected) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(response.redirected ? publicLinkHelp : `The source returned ${response.status}. Use a public direct data link, rather than a sharing or sign-in page.`);
  }
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  if (/text\/html|application\/xhtml\+xml/.test(type)) {
    await response.body.cancel().catch(() => undefined);
    throw new Error("This is a webpage. Use its CSV, JSON or XML export link, or copy the table into Paste.");
  }
  if (Number(response.headers.get("content-length")) > MAX_DATASET_BYTES) {
    await response.body.cancel().catch(() => undefined);
    throw new Error("Use a data source smaller than 20 MB.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      checkAbort(signal);
      const { done, value: chunk } = await reader.read();
      checkAbort(signal);
      if (done) break;
      size += chunk.byteLength;
      if (size > MAX_DATASET_BYTES) throw new Error("Use a data source smaller than 20 MB.");
      chunks.push(new Uint8Array(chunk));
    }
  } catch (error) {
    checkAbort(signal);
    if (error instanceof Error && error.message.includes("20 MB")) throw error;
    throw new Error("The connection ended before the data was read. Try the direct link again, paste the data, or upload a file.");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const file = new File(chunks, sourceName(url, type), { type });
  const beginning = await file.slice(0, 512).text();
  if (/^\s*(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(beginning)) {
    throw new Error("This link returned a webpage. Use a direct data export link or paste the table instead.");
  }
  checkAbort(signal);
  const dataset = await parseDatasetFile(file);
  checkAbort(signal);
  // Keep XLSX bytes so the user can choose another worksheet without fetching again.
  return { dataset, file: dataset.format === "xlsx" ? file : null };
}
