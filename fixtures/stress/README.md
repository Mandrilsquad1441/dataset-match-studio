# Complex matching cases

Two reproducible synthetic cases for testing imports, matching, progress, results and CSV export in Matching Studio. They contain no real customer data.

| Case | Dataset 1 | Dataset 2 | Shape | Purpose |
| --- | --- | --- | --- | --- |
| Company merger | 6,000 records, CSV | 8,000 records, XLSX | 50 columns per dataset | Names, identifiers, branches, duplicates and conflicting evidence |
| Industrial catalog | 10,000 records, XML | 10,000 records, JSONL | 40 columns per dataset | Similar product names, specifications, units, variants and replacements |

Open **Sample datasets** on either **Match datasets** or **Compare models** and load a case. Both sources, the recommended column mappings and the independent answer key are prepared together. The files download only when selected; loading does not start a matching run or call a model.

Each case folder contains a generator manifest with its exact column mappings and a separate ground-truth file. For manual imports, use only the two dataset files as sources and add ground truth under **Answer key** in **Compare models**. Answer-key labels stay separate from matching inputs.

## Dataset files

- Company merger: [Dataset 1 — CSV](case1/dataset1-crm-reference.csv) · [Dataset 2 — XLSX](case1/dataset2-crm-incoming.xlsx)
- Industrial catalog: [Dataset 1 — XML](case2/reference.xml) · [Dataset 2 — JSONL](case2/incoming.jsonl)

Both cases were run against the earlier name/ID-only matcher. Read the [browser test report](results/browser-report.md) for those historical results, screenshots, the column-suggestion fix and the export limitation. That version produced 2,000 false green matches on the industrial case; this is not a measurement of the current matcher.

## What makes the cases difficult

- Source rows and columns are reordered.
- Genuine matches can have different names or identifiers.
- Different entities can have identical names.
- Missing and duplicate IDs prevent simple one-to-one matching.
- Product dimensions, package quantities and variants provide evidence beyond names.
- Many rows share common words, stressing the local candidate-search limits.
- Some rows genuinely require review or have no counterpart.

## Test procedure

1. Choose a case under **Sample datasets**, or upload Dataset 1 and Dataset 2 using the normal file controls.
2. The sample loader applies the recommended mappings. For manual imports, select the name and shared-ID mappings from the manifest.
3. Inspect a preview and confirm the imported row and column counts.
4. Start matching and inspect progress, animation and activity.
5. Confirm the result counts sum to the full incoming dataset.
6. Filter results, inspect explanations and export the CSV.
7. Compare every exported row with the independent ground truth and the evaluation harness.

The saved reports describe the earlier name/ID-only matcher. The new `record-evidence-v1` matcher also scores identity attributes and blocks automatic matches on conflicts. Its accuracy has not yet been remeasured; rerun these same cases and answer keys to compare versions. See [the scoring architecture](../../docs/matching-architecture.md). Accepting a file is not evidence of accurate entity matching.

## Reproduce

```powershell
npx tsx scripts/stress/case1.ts
npx tsx scripts/stress/case2.ts
npx tsx scripts/stress/evaluate.ts
```

See each manifest for generated file sizes, column mappings, scenario counts and ground-truth structure. Browser evidence and measured outcomes are saved under `results/`.
