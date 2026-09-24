# Self-hosting

Start with the browser-only path in the [README](../README.md). It needs no cloud account or key. This guide is only for operators who want authentication, saved workspace data, background jobs, or external models.

## Local authenticated development

1. Install Node.js 22+, Docker Desktop, and the Supabase CLI. Then run:

   ```sh
   npm ci
   npx supabase start
   npx supabase db reset
   ```

2. Copy `.env.example` to `.env.local`. Local-only mode is the default. To use Supabase Auth and the hosted API, explicitly set `VITE_ENABLE_HOSTED_SERVICES=true`. Then use the local Supabase URL and anon key from `npx supabase status` for `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, and the local API port in `VITE_API_BASE_URL`.

3. Copy `.dev.vars.example` to ignored `.dev.vars`. Leave `ALLOW_HOSTED_SERVICES=false` for browser-only local work. To use local Worker routes, explicitly set it to `true` and add your own `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `INTERNAL_JOB_SECRET`, and `TRIGGER_SECRET_KEY` if you use Trigger.dev. Keep service-role and provider keys out of browser variables.

4. Run the Worker, Vite, and Trigger.dev in separate terminals:

   ```sh
   npm run api:dev
   npm run dev
   npm run trigger:dev
   ```

   Add the local browser URL to Supabase Auth's redirect allowlist. The local model adapter defaults to deterministic test mode. Trigger.dev may charge for job usage according to the account plan even when no external model is called.

## Optional external model calls

For local model comparisons, set your own `OPENROUTER_API_KEY` and `ALLOW_PAID_MODEL_CALLS=true` in ignored `.env.local`, then restart Vite. Without both values, the catalogue remains local and the API rejects external model requests. Only choose a provider model after reviewing the current price and setting a provider-side spending limit.

For a durable live task, also set `MODEL_ADAPTER_MODE=live` and `ALLOW_PAID_MODEL_CALLS=true` in the Trigger environment, and add your own provider key there. Live mode without both the flag and key fails closed. Never set a provider key with a `VITE_` prefix.

## Optional hosted deployment

Hosted deployment is operator-managed; the repository does not ship a shared account, production secrets, or a public deployment.

1. Create your own Supabase project, Cloudflare Worker/R2 bucket, and Trigger.dev project. Their usage limits and billing differ; check each account before enabling production traffic.
2. Set your own `TRIGGER_PROJECT_REF`, production `API_BASE_URL`, and server-only Supabase credentials. Create a 32-byte random `INTERNAL_JOB_SECRET` and use the same value in the Worker and Trigger environment.
3. Create your R2 bucket using the name in `wrangler.jsonc`, or change that binding to a bucket you control. The default bucket name is only a template.
4. Link the Supabase project and apply migrations:

   ```sh
   npx supabase link --project-ref YOUR_PROJECT_REF
   npx supabase db push
   ```

5. Configure the Supabase Auth Site URL and redirect allowlist with your Worker origin. Build the client with `VITE_ENABLE_HOSTED_SERVICES=true` and your own `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, then deploy the Worker:

   ```sh
   npm run build
   npm run deploy:worker -- --var APP_ORIGIN:https://YOUR_WORKER.workers.dev --var ALLOW_HOSTED_SERVICES:true
   ```

   `workers_dev` is enabled in Wrangler config. The Worker uses the free `workers.dev` address unless you add a domain yourself. The config defaults hosted routes off; the command opts them in for this deployment. Set Worker secrets with Wrangler's secret commands; do not commit them.

6. Deploy the Trigger task only if you want durable saved runs. Set your project reference and required Supabase, API base URL, and internal secret in your private environment, then run `npm run trigger:deploy`. Its default adapter is deterministic test mode. Enable live external models only through the explicit flag described above.

Static local comparison does not require this deployment. Public workers.dev access is public unless you add your own access control. Add authentication, usage limits, and budget controls before sharing a live model-enabled instance broadly.
