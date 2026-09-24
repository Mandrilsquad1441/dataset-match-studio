import { accessToken, supabaseReady } from "./supabase";

// Production serves the SPA and API from the same Worker. Ignore a local
// .env.local API URL in production builds so colleagues never call localhost.
const hostedServicesEnabled = import.meta.env.VITE_ENABLE_HOSTED_SERVICES === "true";
const apiBase = hostedServicesEnabled ? import.meta.env.PROD ? "" : (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "" : "";
export const liveMode = hostedServicesEnabled && supabaseReady && (Boolean(apiBase) || import.meta.env.PROD);

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) { super(message); this.name = "ApiError"; }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!liveMode) throw new Error("Enable hosted services and connect Supabase Auth and the Match Studio API to use live data.");
  const token = await accessToken();
  if (!token) throw new Error("Sign in to access this workspace.");
  const headers = new Headers(init.headers);
  headers.set("Authorization", "Bearer " + token);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(apiBase + path, { ...init, headers });
  if (!response.ok) {
    let message = await response.text();
    try {
      const body = JSON.parse(message) as { error?: unknown; message?: unknown };
      if (typeof body.error === "string") message = body.error;
      else if (typeof body.message === "string") message = body.message;
    } catch { /* Some upstream failures return plain text. */ }
    throw new ApiError(message || "Request failed with status " + response.status, response.status);
  }
  return response.json() as Promise<T>;
}

export function apiUrl(path: string): string {
  return apiBase + path;
}
