/**
 * Live smoke: discover_suppliers (You.com), check_regulatory (openFDA) and a 2-turn message_supplier
 * exchange on the hero RFQ (Crusoe persona). In-memory store only; nothing is persisted.
 * Usage: pnpm --filter @supply-agent/core smoke:live   (reads ../../.env)
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { modelFor } from "../crusoe.ts";
import { HERO } from "../seed/index.ts";
import { createStore } from "../store.ts";
import { runTool, toolsByName, type ToolCtx } from "../tools/index.ts";

const envFile = join(import.meta.dirname, "../../../../.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const store = createStore();
const ctx: ToolCtx = { organizationId: "org_corvane", role: "planner", filters: {}, store };
const run = (name: string, args: unknown) => runTool(toolsByName[name]!, ctx, args);
const t0 = () => Date.now();

let s = t0();
const disc = await run("discover_suppliers", { material_id: HERO.material_id, max_results: 6 });
console.log(`\n[discover_suppliers] ${disc.ingestion_status} in ${t0() - s} ms; queries=${JSON.stringify(disc.queries)}`);
for (const c of (disc.candidates as Array<{ name: string; kind: string; href: string; label: string; page?: { read: boolean; signals: string[] } }>) ?? [])
  console.log(`  - ${c.name} [${c.kind}, ${c.label}] ${c.href}${c.page ? ` page_read=${c.page.read} signals=${c.page.signals.join("/")}` : ""}`);

s = t0();
const reg = await run("check_regulatory", { substance: "polysorbate 80" });
console.log(`\n[check_regulatory] ${reg.ingestion_status} in ${t0() - s} ms`);
console.log(`  shortages=${JSON.stringify((reg.shortages as { total: number; status_counts: unknown }).total)} ${JSON.stringify((reg.shortages as { status_counts: unknown }).status_counts)}`);
console.log(`  enforcement=${(reg.enforcement as { total: number }).total} ${JSON.stringify((reg.enforcement as { classification_counts: unknown }).classification_counts)}`);
console.log(`  summary: ${reg.summary}`);
console.log(`  cite: ${reg.citations[0]?.href}`);

const rfq = (await run("draft_rfq", { ...HERO, qty: 300, need_by: "2026-11-28" })).rfq as { external_id: string };
const incumbent = store.materialSuppliers({ material_id: HERO.material_id }).find((l) => l.qualification_state === "released_for_use")!.supplier_id;
console.log(`\n[message_supplier] persona model ${modelFor("persona")} on ${rfq.external_id} with ${incumbent} (${store.supplier(incumbent)?.name})`);
for (const msg of [
  `${rfq.external_id}: please quote 300 kg injectable low-endotoxin sucrose delivered to Ghent, need by 2026-11-28.`,
  "Thanks. 70 days does not work for us. Can you expedite, and can you sharpen the unit price to win the order?",
]) {
  s = t0();
  const out = await run("message_supplier", { rfq_id: rfq.external_id, supplier_id: incumbent, message: msg });
  console.log(`  turn ${out.turn} (${out.persona_mode}, ${out.latency_ms ?? t0() - s} ms) clamped=${JSON.stringify(out.clamped_fields)}`);
  console.log(`    reply: ${out.reply}`);
  console.log(`    offer: ${JSON.stringify(out.offer)}`);
}
const acc = await run("accept_offer", { rfq_id: rfq.external_id, supplier_id: incumbent });
const q = acc.quote as { external_id: string; unit_price: number; currency: string; lead_time_days: number };
console.log(`\n[accept_offer] ${q.external_id}: ${q.unit_price} ${q.currency}, ${q.lead_time_days} d (from the last stored offer)`);
