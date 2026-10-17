/** Folds every result file into docs/evals/results/summary.json (read by RESULTS.md tables and the PDF eval sheets). */
import "./lib/env.ts";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { RESULTS_DIR, readResult, writeResult } from "./lib/io.ts";
import { DOER, JUDGE, LIGHTNING, PERSONA, PRICES, short } from "./lib/models.ts";
import { r4 } from "./lib/stats.ts";

type W = { p: number; lo: number; hi: number; k: number; n: number };
type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const b1 = readResult<Any>("b1-tool-selection");
const b3 = readResult<Any>("b3-guardrails");
const b4 = readResult<Any>("b4-spec-matching");
const b5 = readResult<Any>("b5-discovery");
const b5b = readResult<Any>("b5b-negotiation");
const b6 = readResult<Any>("b6-missions");

const models = [DOER, JUDGE, PERSONA, LIGHTNING, ...(process.env.INKLING_MODEL ? [process.env.INKLING_MODEL] : [])];
const pick = (res: Any | null, m: string) => (res?.per_model as Any[] | undefined)?.find((p) => p.model === m) ?? null;

const per_model = models.map((m) => {
  const a = pick(b1, m), g = pick(b3, m), s = pick(b4, m);
  const callCost = a && PRICES[m] ? r4(((a.tokens.in_mean ?? 0) * PRICES[m]!.in + (a.tokens.out_mean ?? 0) * PRICES[m]!.out) / 1e6) : null;
  return {
    model: m,
    label: short(m),
    b1: a ? { accuracy: a.tool_accuracy as W, arg_validity: a.arg_validity as W, p50_ms: a.latency_ms.p50, p95_ms: a.latency_ms.p95, tokens_in: a.tokens.in_mean, tokens_out: a.tokens.out_mean, errors: a.errors, usd_per_call: callCost, gate: a.gate_b1_90pct } : null,
    b3: g ? { violations: g.violation_rate as W, caveat_missing: g.caveat_missing, errors: g.errors, gate: g.gate_b3_zero } : null,
    b4: s ? { accuracy: s.accuracy, precision: s.precision, recall: s.recall, f1: s.f1, false_equivalence_rate: s.false_equivalence_rate, gate: s.gate_b4 } : null,
  };
});

const spendFile = join(RESULTS_DIR, "spend-log.jsonl");
const spend = existsSync(spendFile)
  ? readFileSync(spendFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { benchmark: string; cost_usd: number })
  : [];
const spendBy: Record<string, number> = {};
for (const s of spend) spendBy[s.benchmark] = r4((spendBy[s.benchmark] ?? 0) + s.cost_usd);

writeResult("summary", {
  per_model,
  deterministic_spec: b4 ? { accuracy: b4.deterministic.accuracy, precision: b4.deterministic.precision, recall: b4.deterministic.recall, f1: b4.deterministic.f1, false_equivalence_rate: b4.deterministic.false_equivalence_rate } : null,
  discovery: b5?.summary ?? null,
  negotiation: b5b?.by_config ?? null,
  missions: b6 ? { ...b6.summary, local: (b6.local_missions ?? []).map((m: Any) => ({ id: m.id, material_id: m.material_id, site_id: m.site_id, wall_s: m.wall_s, attempts: m.attempts, checks_passed: m.checks_passed, status: m.status })), streams: (b6.streams ?? []).map((s: Any) => ({ id: s.id, available: s.available, http_status: s.http_status, reason: s.reason ?? null })) } : null,
  spend: { by_benchmark: spendBy, total_usd: r4(Object.values(spendBy).reduce((a, b) => a + b, 0)), note: "Crusoe list prices x metered tokens; persona calls inside message_supplier are not metered (Nano, est. < $0.01 total). You.com calls not priced." },
  generated_from: ["b1-tool-selection", "b3-guardrails", "b4-spec-matching", "b5-discovery", "b5b-negotiation", "b6-missions"].filter((n) => readResult(n)),
});
