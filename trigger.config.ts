import { defineConfig } from "@trigger.dev/sdk";
import { syncEnvVars } from "@trigger.dev/build/extensions/core";

const triggerProject = process.env.TRIGGER_PROJECT_REF;
if (!triggerProject) throw new Error("Set TRIGGER_PROJECT_REF in your local Trigger.dev environment before deploying the task.");

const requiredProductionSecret = (name: string) => {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Missing ${name} for the production Trigger deployment.`);
  return value;
};

export default defineConfig({
  project: triggerProject,
  runtime: "node-24",
  dirs: ["./trigger/tasks"],
  maxDuration: 3600,
  build: {
    extensions: [syncEnvVars(async ({ environment }) => {
      if (environment !== "prod" && environment !== "production") return [];
      const liveMode = process.env.MODEL_ADAPTER_MODE === "live";
      const allowPaidCalls = liveMode && process.env.ALLOW_PAID_MODEL_CALLS === "true";
      const variables = [
        { name: "SUPABASE_URL", value: requiredProductionSecret("SUPABASE_URL"), isSecret: true },
        { name: "SUPABASE_SERVICE_ROLE_KEY", value: requiredProductionSecret("SUPABASE_SERVICE_ROLE_KEY"), isSecret: true },
        { name: "INTERNAL_JOB_SECRET", value: requiredProductionSecret("INTERNAL_JOB_SECRET"), isSecret: true },
        { name: "API_BASE_URL", value: requiredProductionSecret("API_BASE_URL") },
        { name: "JEV_MODEL", value: process.env.JEV_MODEL || "typesafe/jev-1.13" },
        { name: "ASTRA_MODEL", value: process.env.ASTRA_MODEL || "openai/gpt-6-astra" },
        { name: "EMBEDDING_MODEL", value: process.env.EMBEDDING_MODEL || "openai/text-embedding-3-small" },
        { name: "MODEL_ADAPTER_MODE", value: allowPaidCalls ? "live" : "test" },
        { name: "ALLOW_PAID_MODEL_CALLS", value: allowPaidCalls ? "true" : "false" },
        { name: "JEV_INPUT_COST_PER_MILLION", value: process.env.JEV_INPUT_COST_PER_MILLION || "0.042" },
      ];
      if (allowPaidCalls) variables.push({ name: "OPENROUTER_API_KEY", value: requiredProductionSecret("OPENROUTER_API_KEY"), isSecret: true });
      return variables;
    })],
  },
  retries: {
    enabledInDev: true,
    default: { maxAttempts: 5, minTimeoutInMs: 1000, maxTimeoutInMs: 60000, factor: 2 },
  },
});
