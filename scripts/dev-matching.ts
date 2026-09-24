import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import type { Plugin } from "vite";
import { handleMatchingRequest, type MatchingCache } from "../apps/api/src/matching-models";

/** Local development only. The deployed Worker authenticates these routes separately. */
export function localMatchingService(): Plugin {
  return {
    name: "local-matching-service",
    apply: "serve",
    configureServer(server) {
      const root = server.config.root;
      const cacheDirectory = resolve(root, ".matching-cache");
      const cachePath = (key: string) => resolve(cacheDirectory, createHash("sha256").update(key).digest("hex") + ".json");
      const cache: MatchingCache = {
        async get(key) { try { return await readFile(cachePath(key), "utf8"); } catch { return null; } },
        async put(key, value) {
          await mkdir(cacheDirectory, { recursive: true });
          const destination = cachePath(key); const temporary = destination + "." + crypto.randomUUID() + ".tmp";
          await writeFile(temporary, value, { encoding: "utf8", mode: 0o600 });
          await rename(temporary, destination);
        },
      };
      server.middlewares.use(async (incoming, outgoing, next) => {
        const path = incoming.url?.split("?")[0];
        if (path !== "/api/matching/models" && path !== "/api/matching/evaluate") { next(); return; }
        const reject = (status: number, error: string) => { outgoing.statusCode = status; outgoing.setHeader("Content-Type", "application/json"); outgoing.setHeader("Cache-Control", "no-store"); outgoing.end(JSON.stringify({ error })); };
        const host = incoming.headers.host ?? "";
        const remote = incoming.socket.remoteAddress ?? "";
        const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
        const validHost = /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host);
        const origin = incoming.headers.origin;
        if (!loopback || !validHost || origin && origin !== "http://" + host || incoming.headers["sec-fetch-site"] === "cross-site") { reject(403, "Local matching only accepts requests from this computer and this app."); return; }
        if (incoming.method !== "GET" && incoming.method !== "POST") { reject(405, "Method not allowed."); return; }
        if (incoming.method === "POST" && !incoming.headers["content-type"]?.startsWith("application/json")) { reject(415, "Use a JSON request."); return; }
        const maximum = 20 * 1024 * 1024;
        if (Number(incoming.headers["content-length"]) > maximum) { reject(413, "Both datasets together must be smaller than 20 MB."); return; }
        const controller = new AbortController();
        outgoing.on("close", () => { if (!outgoing.writableEnded) controller.abort(); });
        try {
          // Read server credentials only; never forward them through Vite's public environment.
          let credentials: { key?: string; allowPaidCalls: boolean } | undefined;
          if (process.env.OPENROUTER_API_KEY || process.env.ALLOW_PAID_MODEL_CALLS !== undefined) {
            // Treat process-level configuration as authoritative; never combine a key and opt-in from different sources.
            credentials = { key: process.env.OPENROUTER_API_KEY, allowPaidCalls: process.env.ALLOW_PAID_MODEL_CALLS === "true" };
          } else {
            for (const file of [".dev.vars", ".env.local"]) {
              try {
                const values = parseEnv(await readFile(resolve(root, file), "utf8"));
                if (values.OPENROUTER_API_KEY && values.ALLOW_PAID_MODEL_CALLS === "true") {
                  credentials = { key: values.OPENROUTER_API_KEY, allowPaidCalls: true };
                  break;
                }
              } catch { /* Optional local configuration. */ }
            }
          }
          const chunks: Buffer[] = []; let length = 0;
          for await (const chunk of incoming) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); length += bytes.byteLength;
            if (length > maximum) { reject(413, "Both datasets together must be smaller than 20 MB."); return; }
            chunks.push(bytes);
          }
          const request = new Request("http://" + host + path, { method: incoming.method, headers: { "Content-Type": "application/json" }, body: incoming.method === "POST" ? Buffer.concat(chunks).toString("utf8") : undefined, signal: controller.signal });
          const response = await handleMatchingRequest(request, {
            OPENROUTER_API_KEY: credentials?.allowPaidCalls ? credentials.key : undefined,
            ALLOW_PAID_MODEL_CALLS: credentials?.allowPaidCalls && credentials.key ? "true" : "false",
          }, { tenantId: "local-development", cache });
          if (outgoing.destroyed) return;
          outgoing.statusCode = response.status;
          response.headers.forEach((value, name) => outgoing.setHeader(name, value));
          outgoing.setHeader("Cache-Control", "no-store");
          outgoing.end(await response.text());
        } catch {
          if (!outgoing.destroyed) reject(500, "The local matching service could not complete this request.");
        }
      });
    },
  };
}
