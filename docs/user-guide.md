# Install and use Match Studio

## 1. Run the local app

Install [Node.js 22 or later](https://nodejs.org/), clone the repository, then run:

```sh
npm ci
npm run dev
```

Open the `localhost` URL Vite prints in your browser. No Docker, Supabase account, OpenRouter key, or model call is required for the basic local workflow.

On Windows PowerShell, copy the optional environment template only when you are ready to configure an integration:

```powershell
Copy-Item .env.example .env.local
```

On macOS or Linux:

```sh
cp .env.example .env.local
```

## 2. Match two datasets

1. Choose **Dataset 1** as the reference set: the records you want other data compared against.
2. Choose **Dataset 2** as the incoming set: the rows for which you want likely matches.
3. Select the record-name column for each dataset. Select the same kind of stable identifier in both datasets if one is available, such as a SKU, account number, or registry ID. Leave it unset in both if there is no shared identifier.
4. Choose **Local field comparison** and start the run. The app normalizes values, searches likely candidates, compares identity evidence, and streams progress in the workspace.
5. Review the results. Select a score or row to see the supporting and conflicting fields, coverage, candidate alternatives, and score margin. Export the decisions when ready.

Local field comparison is deterministic for the same imported data, field mapping, and code version. It does not prove that an unreturned candidate does not exist; check whether the search was limited before treating a No match result as final.

## 3. File and link formats

File upload accepts **CSV, TSV, delimited TXT, XLSX, JSON, JSONL/NDJSON, and XML**. You can instead paste spreadsheet cells or structured text into either dataset, or fetch a public HTTPS URL that returns data and allows browser CORS access.

Each local dataset can contain up to 10,000 rows and 20 MB. Files need unique column names. Flatten nested JSON/XML first only if your preferred field is hard to identify; nested paths are imported as dotted field names automatically.

These formats need a conversion or extraction step: old Excel `.xls`/`.xlsb`, macro-enabled `.xlsm`, `.xlm`, ODS, Parquet, Feather/Arrow, SQL/database files, YAML, PDF, and image files. `.xlm` is not XML; export its table data to CSV or XLSX. See the complete [format and limit notes](matching-architecture.md#input-formats-and-limits).

## 4. Enable Jev with your own OpenRouter key

Jev is the recommended semantic decision model in this project. Local rules still provide the no-key baseline. To enable model requests:

1. Create an API key in your own [OpenRouter account](https://openrouter.ai/keys).
2. Put it in the ignored `.env.local` file and explicitly enable billable model calls:

   ```dotenv
   OPENROUTER_API_KEY=your_own_key_here
   ALLOW_PAID_MODEL_CALLS=true
   JEV_MODEL=typesafe/jev-1.13
   ```

3. Restart `npm run dev` so Vite loads the new server-side environment.
4. Select **Jev 1.13** from the matching-engine selector. Check any price shown in the app; if it is unknown, look up the current [OpenRouter model price](https://openrouter.ai/typesafe/jev-1.13) and set provider-side limits before starting.

The app sends the selected Dataset 2 row and its bounded candidate records to OpenRouter for inference. A regular Jev run covers every Dataset 2 row with retrieved candidates, so a large run may make many billable requests. Begin with a small dataset or the comparison page's capped sample. Never put the key in a `VITE_*` variable, paste it into a source file, or commit `.env.local`. Provider usage can cost money; if the provider price is not returned, treat it as unknown and check the provider dashboard.

Model comparison is separate from the matching workflow. Open **Compare models**, select Jev and up to two other listed models, and run a shared sample of 5, 10, 25, or 50 Dataset 2 rows. The other models shown by the live catalogue support the structured-output format this app requires. The same row sample, candidate search, field score, and prompt version are used for every selected model to make comparisons more useful.

### Add an answer key for accuracy metrics

Without labels, the page can compare decisions, speed, usage, and failures, but it cannot calculate accuracy, precision, or recall. Create a CSV with one labeled Dataset 2 row per entry. Row numbers below are one-based:

```csv
dataset2_row,expected,dataset1_row
1,match,12
2,no-match,
3,review,
```

`match` must identify the correct Dataset 1 row. `no-match` must not include a target. `review` means the correct answer is ambiguous or cannot be established from the available data. You can also supply record keys if the imported datasets have unique IDs. The answer key stays in the browser; it is not sent to model providers.

Compare accuracy, precision, and recall only when label coverage is sufficient for your use case. Small or unbalanced samples are useful for spotting differences, not for proving production quality. Compare the human answer key with the per-record output and inspect false matches especially carefully.

## 5. Understand the result numbers

| Item | Read it as |
| --- | --- |
| **Evidence score / 100** | Weighted field agreement for this candidate. It is not the chance the match is correct. |
| **Coverage** | Share of the configured weighted evidence that was present and comparable. Low coverage means the score rests on fewer observed fields. |
| **Conflicts** | Identifying attributes that disagree. A conflict can block an automatic match even if names are similar. |
| **Margin** | Score difference between this candidate and the next candidate. A small margin means the choice is less distinct. |
| **Model confidence** | The model's self-reported judgment. It is uncalibrated and should not be read as measured accuracy. |
| **p50 / p95 latency** | Median and slower-end successful, uncached per-row model time; for Local, this is local computation time. |
| **Reported cost** | Cost returned by the provider for requests in that run. Unknown means the provider did not return a value. |

The app's lanes are **Match**, **Review**, **Low confidence**, and **No match**. Inspect Review and Low confidence results before applying any downstream change. In hosted mode, automatic linking is disabled by default and uncertain/escalated rows stay in the human review queue.

## 6. Optional tests and hosted services

Run the local evaluation, test suite, and production bundle build with:

```sh
npm run evaluate
npm run test
npm run build
```

These commands do not need provider keys. `npm run evaluate` uses a small synthetic fixture and is not a real-world model benchmark. Local database tests need Docker Desktop and the Supabase CLI:

```sh
npx supabase start
npx supabase db reset
npm run db:test
```

Supabase Auth, Cloudflare Worker/R2, and Trigger.dev are only needed for sign-in, saved hosted workspaces, file storage, and durable background matching. Their setup can add service costs. Follow [the separate self-hosting guide](self-hosting.md), use accounts and secrets you control, and leave the integrations disabled if a browser-local run is all you need.

## Troubleshooting

- **Only Local appears / Jev cannot be selected:** confirm the OpenRouter key is present in `.env.local`, `ALLOW_PAID_MODEL_CALLS=true`, and restart Vite.
- **A file is rejected:** check the extension, file size, unique headers, and row/field/cell limits. Convert unsupported formats first.
- **Few or no candidates appear:** verify the selected name and shared-ID columns. A missing candidate can reflect retrieval limits or poor source fields.
- **The score is high but the row needs review:** review the coverage, field conflict list, candidate margin, and duplicate group. A score is evidence agreement, not calibrated confidence.
- **Model request fails:** inspect the exact model/provider, OpenRouter account balance/limits, and structured-output support. The app does not silently fall back to another model.
