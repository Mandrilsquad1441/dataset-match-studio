import { evaluateFixtures } from "../src/lib/evaluation";

const result = evaluateFixtures();
const pct = (value: number) => (value * 100).toFixed(1) + "%";

console.log("Matching Studio fixture evaluation (test adapter; no provider calls)");
console.log("Precision " + pct(result.precision) + " · Recall " + pct(result.recall)
  + " · Candidate recall " + pct(result.candidateRecall) + " (" + result.retrieved + "/" + result.positiveLabels + " labeled matches found)"
  + " · Review rate " + pct(result.reviewRate));
console.log("Estimated model cost $0.000000 · Local candidate evaluation latency (not model latency)");
console.table(result.byVendor.map((item) => ({
  vendor: item.vendor,
  precision: pct(item.precision),
  recall: pct(item.recall),
  reviewRate: pct(item.reviewRate),
  latencyMs: item.latencyMs,
  costUsd: item.costUsd.toFixed(6),
})));
