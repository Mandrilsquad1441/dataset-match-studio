import type { RecordSnapshot } from "./types";

export function normalizeText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLocaleLowerCase("und")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function fingerprint(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function flattenFields(value: unknown, prefix = ""): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return prefix ? { [prefix]: value } : {};
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, unknown>>((result, [key, child]) => {
    const path = prefix ? prefix + "." + key : key;
    if (child && typeof child === "object" && !Array.isArray(child)) {
      Object.assign(result, flattenFields(child, path));
    } else {
      result[path] = child;
    }
    return result;
  }, {});
}

export function getTextFields(record: RecordSnapshot): string[] {
  return [record.displayName, ...record.aliases, ...Object.values(record.identifiers), ...Object.values(record.fields).map(String)]
    .map(normalizeText)
    .filter(Boolean);
}
