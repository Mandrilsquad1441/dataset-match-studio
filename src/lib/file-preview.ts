const maxBufferedJsonPreviewBytes = 20 * 1024 * 1024;

export async function previewJsonFile(file: Blob, limit = 8): Promise<Record<string, unknown>[]> {
  const prefix = await file.slice(0, 64 * 1024).text();
  const trimmed = prefix.trimStart();
  const isRootArray = trimmed.startsWith("[");
  const hasRecordsArray = trimmed.startsWith("{") && /[\"']records[\"']\s*:\s*\[/.test(prefix);
  if (!isRootArray && !hasRecordsArray) {
    if (file.size > maxBufferedJsonPreviewBytes) throw new Error("Large JSON previews need a top-level array or a records array near the start of the file.");
    const value = JSON.parse(await file.text()) as unknown;
    const rows = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as { records?: unknown }).records)
      ? (value as { records: unknown[] }).records : [value];
    return rows.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))).slice(0, limit);
  }

  const { JSONParser } = await import("@streamparser/json");
  const parser = new JSONParser({ paths: [isRootArray ? "$.*" : "$.records.*"], keepStack: false });
  const rows: Record<string, unknown>[] = [];
  parser.onValue = ({ value }) => {
    if (value && typeof value === "object" && !Array.isArray(value) && rows.length < limit) rows.push(value as Record<string, unknown>);
  };
  const reader = file.stream().getReader();
  let done = false;
  try {
    while (rows.length < limit) {
      const next = await reader.read();
      if (next.done) {
        if (!parser.isEnded) parser.end();
        done = true;
        break;
      }
      parser.write(next.value);
    }
  } finally {
    if (!done) await reader.cancel();
  }
  return rows;
}
