/**
 * B1 Tool selection. 24 golden prompts; each model sees the planner system prompt
 * (apps/agent/agent/instructions.md) and the same 20 tool JSON schemas the agent exposes
 * (core Zod -> z.toJSONSchema, plus run_mission). Single step: we score the FIRST tool call.
 */
import "./lib/env.ts";
import { call, pool, unavailable, usageReport } from "./lib/llm.ts";
import { candidates, short } from "./lib/models.ts";
import { readRepoFile, writeResult } from "./lib/io.ts";
import { percentile, mean, wilson, r2 } from "./lib/stats.ts";
import { openAITools, validateArgs } from "./lib/tools.ts";

type ArgCheck = string | number | boolean | RegExp | string[];
interface Golden {
  id: string;
  category: "inventory" | "pricing" | "transfer" | "supplier_lookup" | "discovery" | "mission" | "spec" | "quotes" | "approval" | "negotiation" | "record";
  prompt: string;
  expect: string[]; // acceptable first tools, primary first
  args?: Record<string, ArgCheck>;
}

export const GOLDEN: Golden[] = [
  { id: "inv-01", category: "inventory", prompt: "What's running low across our sites right now?", expect: ["low_stock_items"] },
  { id: "inv-02", category: "inventory", prompt: "Which materials are at or below their reorder point? Worst first please.", expect: ["low_stock_items"] },
  { id: "inv-03", category: "inventory", prompt: "How many days of cover do we have for MAT-SUC-INJ at SITE-GHE?", expect: ["cover_projection"], args: { material_id: "MAT-SUC-INJ", site_id: "SITE-GHE" } },
  { id: "inv-04", category: "inventory", prompt: "When does SITE-KOP run out of MAT-PS80-SR if consumption holds?", expect: ["cover_projection"], args: { material_id: "MAT-PS80-SR", site_id: "SITE-KOP" } },
  { id: "inv-05", category: "inventory", prompt: "What's our total released inventory value, split by region?", expect: ["inventory_value_summary"], args: { group_by: "region" } },
  { id: "inv-06", category: "inventory", prompt: "Break down inventory value by material class.", expect: ["inventory_value_summary"], args: { group_by: "material_class" } },
  { id: "prc-01", category: "pricing", prompt: "Price our expiring MAT-MAN-PAR at SITE-COR. Sell it or move it?", expect: ["price_inventory"], args: { material_id: "MAT-MAN-PAR", site_id: "SITE-COR" } },
  { id: "prc-02", category: "pricing", prompt: "What is the trehalose stock MAT-TRE-HP at SITE-TUA worth, and should we hold it?", expect: ["price_inventory"], args: { material_id: "MAT-TRE-HP", site_id: "SITE-TUA" } },
  { id: "trf-01", category: "transfer", prompt: "Can any sister site send MAT-PS80-SR to SITE-RAL? Propose a transfer.", expect: ["propose_transfer"], args: { material_id: "MAT-PS80-SR", to_site_id: "SITE-RAL" } },
  { id: "trf-02", category: "transfer", prompt: "Propose moving surplus MAT-MAN-PAR from SITE-COR to SITE-RAL.", expect: ["propose_transfer"], args: { material_id: "MAT-MAN-PAR", from_site_id: "SITE-COR", to_site_id: "SITE-RAL" } },
  { id: "sup-01", category: "supplier_lookup", prompt: "Who are our approved suppliers for MAT-HPMC?", expect: ["find_suppliers"], args: { material_id: "MAT-HPMC" } },
  { id: "sup-02", category: "supplier_lookup", prompt: "List approved suppliers for MAT-SUC-INJ that hold a CEP.", expect: ["find_suppliers"], args: { material_id: "MAT-SUC-INJ", require_cep: true } },
  { id: "sup-03", category: "supplier_lookup", prompt: "What's the material ID for our inhalation-grade lactose?", expect: ["lookup_parts"], args: { query: /lactose/i } },
  { id: "sup-04", category: "supplier_lookup", prompt: "Do we use L-histidine monohydrochloride anywhere? Look it up.", expect: ["lookup_parts"], args: { query: /histidine/i } },
  { id: "dsc-01", category: "discovery", prompt: "Search the web for new GMP manufacturers of MAT-TRE-HP we don't already use.", expect: ["discover_suppliers"], args: { material_id: "MAT-TRE-HP" } },
  { id: "dsc-02", category: "discovery", prompt: "Find additional public suppliers of inhalation magnesium stearate (MAT-MGST-INH) online, with sources.", expect: ["discover_suppliers"], args: { material_id: "MAT-MGST-INH" } },
  { id: "reg-01", category: "discovery", prompt: "Are there any FDA shortage or recall signals for mannitol?", expect: ["check_regulatory"], args: { substance: /mannitol/i } },
  { id: "spc-01", category: "spec", prompt: "Is MAT-HIS-HCL an acceptable substitute for MAT-HIS? Check the spec.", expect: ["match_spec"], args: { material_id: "MAT-HIS", candidate_ids: ["MAT-HIS-HCL"] } },
  { id: "quo-01", category: "quotes", prompt: "Compare the quotes we have on RFQ-099 on a landed basis.", expect: ["compare_quotes"], args: { rfq_id: "RFQ-099" } },
  { id: "msn-01", category: "mission", prompt: "Ghent is down to about three weeks of injectable sucrose (MAT-SUC-INJ at SITE-GHE). Handle it.", expect: ["run_mission"], args: { material_id: "MAT-SUC-INJ", site_id: "SITE-GHE" } },
  { id: "msn-02", category: "mission", prompt: "Prevent a stockout of MAT-PS80-SR at SITE-KOP.", expect: ["run_mission"], args: { material_id: "MAT-PS80-SR", site_id: "SITE-KOP" } },
  { id: "apr-01", category: "approval", prompt: "APPROVE RFQ-099", expect: ["apply_approval"], args: { rfq_id: "RFQ-099", decision: /approve/i } },
  { id: "rfq-01", category: "quotes", prompt: "Draft an RFQ for 200 kg of MAT-TRE-HP delivered to SITE-KOP, needed by 2026-12-01.", expect: ["draft_rfq"], args: { material_id: "MAT-TRE-HP", site_id: "SITE-KOP", qty: 200, need_by: "2026-12-01" } },
  { id: "neg-01", category: "negotiation", prompt: "Message supplier SUP-019 on RFQ-099 and ask for a better unit price.", expect: ["message_supplier"], args: { rfq_id: "RFQ-099", supplier_id: "SUP-019" } },
];

function checkArg(v: unknown, want: ArgCheck): boolean {
  if (want instanceof RegExp) return typeof v === "string" && want.test(v);
  if (Array.isArray(want)) return Array.isArray(v) && want.every((w) => v.map(String).includes(w));
  if (typeof want === "string") return typeof v === "string" && v.trim().toLowerCase() === want.toLowerCase();
  return v === want;
}

const SYSTEM = `${readRepoFile("apps/agent/agent/instructions.md")}\n\nToday is 2026-10-17. You can call any of the provided tools directly.`;
const TOOLS = openAITools();

async function runOne(model: string, g: Golden) {
  const res = await call({
    model,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: g.prompt },
    ],
    tools: TOOLS,
    tool_choice: "auto",
    temperature: 0,
    max_tokens: 4096,
  });
  if (!res.ok) return { id: g.id, model, error: res.error, tool: null, correct_tool: false, args_valid: false, args_correct: false, latency_ms: null, tokens_in: 0, tokens_out: 0 };
  const tc = res.r.tool_calls[0];
  const tool = tc?.function.name ?? null;
  let args: Record<string, unknown> | null = null;
  try {
    args = tc ? (JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>) : null;
  } catch {
    args = null;
  }
  const correct = tool != null && g.expect.includes(tool);
  const valid = tool != null && args != null && validateArgs(tool, args).ok;
  const argFails = correct && g.args ? Object.entries(g.args).filter(([k, w]) => !checkArg(args?.[k], w)).map(([k]) => k) : [];
  return {
    id: g.id,
    model,
    tool,
    args,
    content: tool ? null : (res.r.content ?? "").slice(0, 200),
    correct_tool: correct,
    args_valid: valid,
    args_correct: correct && valid && argFails.length === 0,
    arg_failures: argFails,
    arg_error: tool && args ? (validateArgs(tool, args).error ?? null) : tc ? "unparseable JSON" : null,
    latency_ms: res.r.latency_ms,
    tokens_in: res.r.tokens_in,
    tokens_out: res.r.tokens_out,
    attempts: res.r.attempts,
  };
}

const models = candidates();
const jobs = models.flatMap((m) => GOLDEN.map((g) => ({ m, g })));
const t0 = Date.now();
const rows = await pool(jobs, 4, async ({ m, g }) => {
  const r = await runOne(m, g);
  process.stdout.write(`${r.correct_tool ? "." : "x"}`);
  return r;
});
console.log();

const per_model = models.map((m) => {
  const rs = rows.filter((r) => r.model === m);
  const answered = rs.filter((r) => !r.error);
  const lat = answered.map((r) => r.latency_ms as number);
  const withTool = answered.filter((r) => r.tool);
  const correct = answered.filter((r) => r.correct_tool);
  return {
    model: m,
    label: short(m),
    available: answered.length > 0 && !unavailable(m),
    n: rs.length,
    errors: rs.length - answered.length,
    tool_accuracy: wilson(correct.length, answered.length),
    arg_validity: wilson(withTool.filter((r) => r.args_valid).length, withTool.length),
    arg_correctness: wilson(correct.filter((r) => r.args_correct).length, correct.length),
    latency_ms: { p50: percentile(lat, 50), p95: percentile(lat, 95), mean: lat.length ? Math.round(mean(lat)!) : null },
    tokens: { in_mean: answered.length ? Math.round(mean(answered.map((r) => r.tokens_in))!) : null, out_mean: answered.length ? Math.round(mean(answered.map((r) => r.tokens_out))!) : null },
    gate_b1_90pct: answered.length > 0 ? correct.length / answered.length >= 0.9 : null,
    misses: answered.filter((r) => !r.correct_tool).map((r) => ({ id: r.id, got: r.tool, content: r.content ?? null })),
  };
});

for (const p of per_model) console.log(`${p.label.padEnd(22)} acc ${p.tool_accuracy.k}/${p.tool_accuracy.n}  argValid ${p.arg_validity.k}/${p.arg_validity.n}  argOK ${p.arg_correctness.k}/${p.arg_correctness.n}  p50 ${p.latency_ms.p50}ms p95 ${p.latency_ms.p95}ms err ${p.errors}`);

writeResult("b1-tool-selection", {
  method: {
    prompts: GOLDEN.length,
    tools_exposed: TOOLS.map((t) => t.function.name),
    system_prompt: "apps/agent/agent/instructions.md + date line",
    temperature: 0,
    max_tokens: 4096,
    thinking: "model default (as deployed)",
    scoring: "first tool call name in the accepted set; args_valid = Zod parse of the real tool schema; args_correct = expected key values match",
    gate: "B1 >= 90% exact tool match",
  },
  golden: GOLDEN.map((g) => ({ ...g, args: g.args ? Object.fromEntries(Object.entries(g.args).map(([k, v]) => [k, v instanceof RegExp ? String(v) : v])) : undefined })),
  per_model,
  rows,
  wall_s: r2((Date.now() - t0) / 1000),
  usage: usageReport(),
});
