/** Writes docs/learning-results.json and docs/learning-results.md (synthetic). Usage: pnpm --filter @supply-agent/core sim:learning [days] */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildLearningReport, renderLearningMarkdown } from "../sim/index.ts";

const days = Number(process.argv[2]) || 360;
const seeds = Array.from({ length: 10 }, (_, i) => i + 1);
const report = buildLearningReport(seeds, days);
const docs = join(import.meta.dirname, "../../../../docs");
await mkdir(docs, { recursive: true });
await writeFile(join(docs, "learning-results.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(join(docs, "learning-results.md"), renderLearningMarkdown(report));
for (const s of report.scenarios) {
  console.log(`SYNTHETIC ${s.truth} / ${s.profile}, ${days} days, mean of ${seeds.length} seeds`);
  for (const r of s.rows) console.log(`  ${r.policy.padEnd(16)} stockout days ${String(r.stockout_days).padStart(7)}  cost $${(r.stockout_cost_usd / 1e6).toFixed(1)}M  expedite $${(r.expedite_spend_usd / 1e6).toFixed(2)}M  belief err ${r.belief_error_pp} pp  flags ${r.qa_review_flags}`);
}
console.log(`wrote ${join(docs, "learning-results.json")} and learning-results.md`);
