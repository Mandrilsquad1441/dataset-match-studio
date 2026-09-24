import { afterEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import { MAX_DATASET_BYTES, parseDatasetFile } from "./dataset-input";
import { readPublicDatasetUrl } from "./dataset-url";

const signal = () => new AbortController().signal;

afterEach(() => { vi.unstubAllGlobals(); });

function respond(body: BodyInit, headers: Record<string, string> = {}) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(body, { headers }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("public dataset links", () => {
  it("loads actual CSV data without credentials, referrers or redirects", async () => {
    const fetchMock = respond("id,name\n001,Acme", { "content-type": "text/csv" });
    const controller = new AbortController();
    const result = await readPublicDatasetUrl("https://data.example.com./export#section", controller.signal);
    expect(result.dataset.rows).toEqual([{ id: "001", name: "Acme" }]);
    expect(result.file).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("https://data.example.com/export", {
      signal: controller.signal, credentials: "omit", referrerPolicy: "no-referrer", redirect: "error",
    });
  });

  it.each([
    "http://example.com/data.csv", "https://user:password@example.com/data.csv",
    "https://localhost/data.csv", "https://localhost./data.csv", "https://project.localhost/data.csv",
    "https://computer.local/data.csv", "https://printer.internal/data.csv", "https://intranet/data.csv",
    "https://printer.home.arpa/data.csv", "https://computer.localdomain/data.csv",
    "https://0.0.0.0/data.csv", "https://127.1/data.csv", "https://2130706433/data.csv",
    "https://10.0.0.1/data.csv", "https://192.168.0.2/data.csv", "https://8.8.8.8/data.csv",
    "https://[::1]/data.csv", "https://[fe80::1]/data.csv", "https://[2606:4700:4700::1111]/data.csv",
  ])("rejects unsupported or local addresses before fetching: %s", async (url) => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(readPublicDatasetUrl(url, signal())).rejects.toThrow(/public HTTPS/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["application/x-ndjson", "application/jsonl", "text/x-jsonlines"])("recognizes %s before ordinary JSON", async (type) => {
    respond('{"id":"001"}\n{"id":"002"}\n', { "content-type": type });
    const result = await readPublicDatasetUrl("https://example.com/records.json", signal());
    expect(result.dataset.format).toBe("jsonl");
    expect(result.dataset.rows).toEqual([{ id: "001" }, { id: "002" }]);
  });

  it("detects structured data from a public response without a filename or MIME hint", async () => {
    respond('<records><record id="001"><name>Acme</name></record></records>');
    const result = await readPublicDatasetUrl("https://example.com/export", signal());
    expect(result.dataset.rows).toEqual([{ "@id": "001", name: "Acme" }]);
    expect(result.dataset.format).toBe("xml");
  });

  it("retains a linked workbook so every worksheet remains selectable without another request", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("First").addRows([["name"], ["Acme"]]);
    workbook.addWorksheet("Second").addRows([["name"], ["Beta"]]);
    const fetchMock = respond(new Uint8Array(await workbook.xlsx.writeBuffer()), { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const result = await readPublicDatasetUrl("https://example.com/workbook", signal());
    expect(result.dataset.worksheets).toEqual(["First", "Second"]);
    expect(result.file).toBeInstanceOf(File);
    expect((await parseDatasetFile(result.file!, { worksheet: "Second" })).rows).toEqual([{ name: "Beta" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("enforces the advertised size before reading the body", async () => {
    let read = false;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull() { read = true; }, cancel }, { highWaterMark: 0 });
    respond(body, { "content-length": String(MAX_DATASET_BYTES + 1) });
    await expect(readPublicDatasetUrl("https://example.com/data.csv", signal())).rejects.toThrow("20 MB");
    expect(read).toBe(false);
    expect(cancel).toHaveBeenCalled();
  });

  it("enforces the actual streamed byte limit even without Content-Length", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(MAX_DATASET_BYTES)); controller.enqueue(new Uint8Array(1)); },
      cancel,
    });
    respond(body);
    await expect(readPublicDatasetUrl("https://example.com/data.csv", signal())).rejects.toThrow("20 MB");
    expect(cancel).toHaveBeenCalled();
  });

  it("gives a direct-link/CORS explanation for network or blocked redirect failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(readPublicDatasetUrl("https://example.com/share", signal())).rejects.toThrow(/CORS.*does not redirect/);
  });

  it("reports cancelled reads without exposing a raw browser error", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    controller.abort();
    await expect(readPublicDatasetUrl("https://example.com/data.csv", controller.signal)).rejects.toThrow("cancelled or timed out");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["text/html", "application/xhtml+xml", "text/plain"])("rejects webpage responses even if served as %s", async (type) => {
    respond("<!doctype html><html><body>Sign in</body></html>", { "content-type": type });
    await expect(readPublicDatasetUrl("https://example.com/data.csv", signal())).rejects.toThrow("webpage");
  });

  it("cancels failed HTTP responses and explains the direct data link requirement", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 403 })));
    await expect(readPublicDatasetUrl("https://example.com/data.csv", signal())).rejects.toThrow("returned 403");
    expect(cancel).toHaveBeenCalled();
  });
});
