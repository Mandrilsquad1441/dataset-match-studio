// Wrangler generates binding types from wrangler.jsonc. Secret names are declared here
// because secret values must stay out of the committed Wrangler config.
interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  TRIGGER_SECRET_KEY: string;
  INTERNAL_JOB_SECRET: string;
  OPENROUTER_API_KEY: string;
  ALLOW_HOSTED_SERVICES: string;
  ALLOW_PAID_MODEL_CALLS: string;
  TRIGGER_TASK_ID?: string;
  TRIGGER_API_URL?: string;
  JEV_INPUT_COST_PER_MILLION?: string;
  JEV_MODEL_VERSION_APPROVED?: string;
}
