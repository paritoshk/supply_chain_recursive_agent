/** Writes docs/sim-results.json and docs/sim-results.md (synthetic). Usage: pnpm --filter @supply-agent/core sim [days] */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SEED } from "../seed/catalog.ts";
import { buildSimReport, renderSimMarkdown } from "../sim/index.ts";

const days = Number(process.argv[2]) || 90;
const seeds = Array.from({ length: 10 }, (_, i) => i + 1);
const report = buildSimReport(SEED, seeds, days);
const docs = join(import.meta.dirname, "../../../../docs");
await mkdir(docs, { recursive: true });
await writeFile(join(docs, "sim-results.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(join(docs, "sim-results.md"), renderSimMarkdown(report));
const b = report.primary.baseline.metrics;
const a = report.primary.agent.metrics;
console.log(`SYNTHETIC simulation, ${days} days, seed ${SEED}, ${b.pairs} positions`);
for (const k of ["stockout_events", "stockout_days", "service_level_pct", "expedite_spend_usd", "avg_inventory_value_usd", "human_touches", "human_minutes"] as const) {
  console.log(`  ${k.padEnd(26)} baseline ${String(b[k]).padStart(12)}   agent ${String(a[k]).padStart(12)}`);
}
console.log(`hero: baseline ${report.primary.baseline.hero.stockout_days} stockout days, agent ${report.primary.agent.hero.stockout_days}`);
console.log(`wrote ${join(docs, "sim-results.json")} and sim-results.md`);
