/**
 * B5b Negotiation win rate. For the three demo materials, runs the real message_supplier / accept_offer
 * tools against every approved supplier with four buyer policies (three scripted, one LLM negotiator on
 * the doer model using apps/agent/.../negotiator/instructions.md) and three persona settings
 * (offline scripted, live Nano, live Lightning). Scoring is core negotiationOutcome(): landed USD/unit vs
 * list, lead time vs need-by, policy violations (must be 0: offers are clamped in code), win =
 * landed <= midpoint(list, floor) AND arrives by need-by AND 0 violations.
 */
import "./lib/env.ts";
import { createStore, negotiationOutcome, runTool, toolsByName, type Store } from "@supply-agent/core";
import { ctxFor, tool } from "./lib/fixtures.ts";
import { call, pace, pool, usageReport } from "./lib/llm.ts";
import { DOER, LIGHTNING, PERSONA, short } from "./lib/models.ts";
import { readRepoFile, writeResult } from "./lib/io.ts";
import { mean, percentile, r2, wilson } from "./lib/stats.ts";
import { openAITools } from "./lib/tools.ts";

const DEMO = [
  { material_id: "MAT-SUC-INJ", site_id: "SITE-GHE", label: "Sucrose, injectable @ Ghent (hero)" },
  { material_id: "MAT-PS80-SR", site_id: "SITE-KOP", label: "Polysorbate 80 SR @ King of Prussia" },
  { material_id: "MAT-MAN-PAR", site_id: "SITE-RAL", label: "Mannitol, parenteral @ Raleigh" },
];
type Policy = "accept_first" | "anchor_target" | "expedite_if_late" | "llm_negotiator";
type PersonaMode = "scripted" | "live_nano" | "live_lightning";
const PERSONAS: Array<{ mode: PersonaMode; model: string | null; policies: Policy[] }> = [
  { mode: "scripted", model: null, policies: ["accept_first", "anchor_target", "expedite_if_late", "llm_negotiator"] },
  { mode: "live_nano", model: PERSONA, policies: ["accept_first", "anchor_target", "expedite_if_late", "llm_negotiator"] },
  { mode: "live_lightning", model: LIGHTNING, policies: ["anchor_target"] },
];

async function setup(store: Store, d: (typeof DEMO)[number]) {
  const cover = await tool(store, "cover_projection", { material_id: d.material_id, site_id: d.site_id });
  const p = cover.position as { daily_rate: number; lead_time_days: number | null; released_qty: number; reorder_point: number | null };
  const qty = Math.ceil(Math.max(p.daily_rate * 60, (p.reorder_point ?? 0) - p.released_qty + p.daily_rate * (p.lead_time_days ?? 42)));
  const need_by = (cover.stockout_date as string | null) ?? "2026-12-01";
  const sup = await tool(store, "find_suppliers", { material_id: d.material_id });
  const approved = (sup.approved as Array<{ supplier_id: string; supplier_name: string; price_low: number | null }>) ?? [];
  const rfq = (await tool(store, "draft_rfq", { material_id: d.material_id, site_id: d.site_id, qty, need_by, supplier_ids: approved.map((a) => a.supplier_id) })).rfq as { external_id: string };
  return { qty, need_by, approved, rfq_id: rfq.external_id };
}

let personaModel: string | null = null;
async function msg(store: Store, rfq_id: string, supplier_id: string, message: string) {
  if (personaModel) await pace(personaModel);
  return runTool(toolsByName.message_supplier!, ctxFor(store), { rfq_id, supplier_id, message });
}
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

async function scriptedPolicy(policy: Policy, store: Store, s: { rfq_id: string; qty: number; need_by: string }, sup: { supplier_id: string; price_low: number | null }) {
  const opening = `${s.rfq_id}: please quote ${s.qty} units delivered by ${s.need_by}. What is your best landed price and lead time?`;
  let r = await msg(store, s.rfq_id, sup.supplier_id, opening);
  const target = sup.price_low;
  if (policy === "anchor_target" && r.ingestion_status === "ok") {
    for (let i = 0; i < 2; i++) r = await msg(store, s.rfq_id, sup.supplier_id, `Thanks. Our target is ${target ?? "a lower"} per unit for this volume. Can you move closer to ${target ?? "that"}?`);
  }
  if (policy === "expedite_if_late" && r.ingestion_status === "ok") {
    const lead = (r.offer as { lead_time_days: number } | undefined)?.lead_time_days ?? 0;
    if (daysBetween(store.today(), s.need_by) < lead) r = await msg(store, s.rfq_id, sup.supplier_id, `We need delivery by ${s.need_by}. Can you expedite? We can accept a modest premium.`);
    r = await msg(store, s.rfq_id, sup.supplier_id, `Please sharpen the price toward ${target ?? "your best"} per unit and we will award quickly.`);
  }
  return runTool(toolsByName.accept_offer!, ctxFor(store), { rfq_id: s.rfq_id, supplier_id: sup.supplier_id });
}

const NEGOTIATOR = readRepoFile("apps/agent/agent/subagents/sourcing/subagents/negotiator/instructions.md");
const NEG_TOOLS = openAITools(["message_supplier", "accept_offer"]);
async function llmPolicy(store: Store, s: { rfq_id: string; qty: number; need_by: string }, sup: { supplier_id: string; price_low: number | null }) {
  const msgs: Array<Record<string, unknown>> = [
    { role: "system", content: `${NEGOTIATOR}\n\nToday is ${store.today()}.` },
    { role: "user", content: `RFQ ${s.rfq_id}, supplier ${sup.supplier_id}, need quantity ${s.qty}, need-by ${s.need_by}, target price ${sup.price_low ?? "n/a"} USD per unit.` },
  ];
  const calls: string[] = [];
  let finalText: string | null = null;
  for (let step = 0; step < 8; step++) {
    const res = await call({ model: DOER, messages: msgs as never, tools: NEG_TOOLS, tool_choice: "auto", temperature: 0, max_tokens: 4096 });
    if (!res.ok) { calls.push(`error: ${res.error.slice(0, 80)}`); break; }
    if (!res.r.tool_calls.length) { finalText = res.r.content; break; }
    msgs.push({ role: "assistant", content: res.r.content ?? null, tool_calls: res.r.tool_calls });
    for (const tc of res.r.tool_calls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* empty */ }
      calls.push(tc.function.name);
      let out: unknown;
      try {
        out = tc.function.name === "message_supplier" ? await msg(store, String(args.rfq_id ?? s.rfq_id), String(args.supplier_id ?? sup.supplier_id), String(args.message ?? "")) : await runTool(toolsByName[tc.function.name]!, ctxFor(store), args);
      } catch (err) {
        out = { ingestion_status: "not_ingested", error: (err as Error).message.slice(0, 200) };
      }
      msgs.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: JSON.stringify(out) });
    }
  }
  return { calls, finalText };
}

const t0 = Date.now();
const threads: Array<Record<string, unknown>> = [];
for (const persona of PERSONAS) {
  process.env.PERSONA_MODE = persona.mode === "scripted" ? "scripted" : "live";
  if (persona.model) process.env.MODEL_PERSONA = persona.model;
  personaModel = persona.model;
  for (const policy of persona.policies) {
    for (const d of DEMO) {
      const store = createStore();
      const s = await setup(store, d);
      const rows = await pool(s.approved, 4, async (sup) => {
        let accepted = false, llm: { calls: string[]; finalText: string | null } | null = null, error: string | null = null;
        try {
          if (policy === "llm_negotiator") {
            llm = await llmPolicy(store, s, sup);
            accepted = llm.calls.includes("accept_offer");
          } else {
            accepted = (await scriptedPolicy(policy, store, s, sup)).ingestion_status === "ok";
          }
        } catch (err) {
          error = (err as Error).message.slice(0, 200);
        }
        const thread = store.negotiation(s.rfq_id, sup.supplier_id);
        if (!thread) return { persona: persona.mode, policy, material_id: d.material_id, supplier_id: sup.supplier_id, error: error ?? "no thread", accepted: false };
        const o = negotiationOutcome(thread.profile, thread.turns);
        const supplierTurns = thread.turns.filter((t) => t.from === "supplier");
        return {
          persona: persona.mode,
          persona_model: persona.model,
          policy,
          material_id: d.material_id,
          supplier_id: sup.supplier_id,
          supplier_name: store.supplier(sup.supplier_id)?.name,
          personality: thread.profile.personality,
          need_by: s.need_by,
          qty: s.qty,
          accepted,
          error,
          ...o,
          clamp_events: supplierTurns.filter((t) => (t.clamped ?? []).some((c) => !c.startsWith("valid_until"))).length,
          clamped_fields: supplierTurns.flatMap((t) => t.clamped ?? []),
          persona_latency_ms: supplierTurns.map((t) => t.latency_ms).filter((x): x is number => x != null),
          llm_calls: llm?.calls ?? null,
          llm_final: llm?.finalText?.slice(0, 200) ?? null,
        };
      });
      threads.push(...rows);
      process.stdout.write(`[${persona.mode}/${policy}/${d.material_id}] `);
    }
  }
}
console.log();

type T = { persona: string; policy: string; win?: boolean; has_offer?: boolean; savings_vs_list_pct?: number | null; captured_pct?: number | null; meets_need_by?: boolean; policy_violations?: string[]; clamp_events?: number; supplier_turns?: number; persona_latency_ms?: number[]; accepted?: boolean; error?: string | null };
const groups = new Map<string, T[]>();
for (const t of threads as T[]) {
  const k = `${t.persona}|${t.policy}`;
  groups.set(k, [...(groups.get(k) ?? []), t]);
}
const by_config = [...groups.entries()].map(([k, ts]) => {
  const [persona = "", policy = ""] = k.split("|");
  const scored = ts.filter((t) => t.has_offer);
  const lat = scored.flatMap((t) => t.persona_latency_ms ?? []);
  return {
    persona,
    policy,
    threads: ts.length,
    with_offer: scored.length,
    accepted: ts.filter((t) => t.accepted).length,
    win_rate: wilson(scored.filter((t) => t.win).length, scored.length),
    meets_need_by_rate: wilson(scored.filter((t) => t.meets_need_by).length, scored.length),
    savings_vs_list_pct_mean: scored.length ? r2(mean(scored.map((t) => t.savings_vs_list_pct ?? 0))!) : null,
    captured_pct_mean: scored.length ? r2(mean(scored.map((t) => t.captured_pct ?? 0))!) : null,
    policy_violations: scored.reduce((s, t) => s + (t.policy_violations?.length ?? 0), 0),
    clamp_events: scored.reduce((s, t) => s + (t.clamp_events ?? 0), 0),
    supplier_turns: scored.reduce((s, t) => s + (t.supplier_turns ?? 0), 0),
    persona_latency_ms: { p50: percentile(lat, 50), p95: percentile(lat, 95) },
    errors: ts.filter((t) => t.error).length,
  };
});
for (const c of by_config) console.log(`${c.persona.padEnd(15)} ${c.policy.padEnd(17)} win ${c.win_rate.k}/${c.win_rate.n} save ${c.savings_vs_list_pct_mean}% capture ${c.captured_pct_mean} needBy ${c.meets_need_by_rate.k}/${c.meets_need_by_rate.n} viol ${c.policy_violations} clamps ${c.clamp_events}/${c.supplier_turns} err ${c.errors}`);

writeResult("b5b-negotiation", {
  method: {
    materials: DEMO,
    suppliers: "every approved supplier (quality_approved / released_for_use) for the material",
    quantity: "max(60 days of consumption, ROP - released + daily x lead), need-by = projected stockout date (cover_projection)",
    policies: {
      accept_first: "open, then accept_offer",
      anchor_target: "open, counter twice at the low end of the supplier's synthetic price band, accept",
      expedite_if_late: "open; if lead time misses need-by ask to expedite; one price counter; accept",
      llm_negotiator: `${short(DOER)} driving message_supplier / accept_offer with the negotiator instructions (max 8 steps)`,
    },
    personas: { scripted: "deterministic offline persona", live_nano: PERSONA, live_lightning: `${LIGHTNING} (anchor_target only)` },
    win: "landed USD/unit <= midpoint of list and floor (landed) AND arrival <= need-by AND 0 policy violations (core negotiationOutcome)",
    caveat: "persona token usage is not metered here (the core persona client does not return usage to the harness); the doer tokens for llm_negotiator are",
  },
  by_config,
  threads,
  wall_s: r2((Date.now() - t0) / 1000),
  usage: usageReport(),
});
