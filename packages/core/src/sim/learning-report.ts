/** Learning experiment: does the agent improve as deliveries come in? Synthetic data only. */
import { round } from "../logic/dates.ts";
import { CORVANE_PROFILE, LEAN_GENERICS_PROFILE, type ClientProfile } from "../logic/risk.ts";
import { runSimulation, type SimPolicy, type SimResult, type SupplierTruth } from "./simulate.ts";

const POLICIES: SimPolicy[] = ["baseline", "agent", "agent_risk", "agent_learning"];

export interface LearningRow {
  policy: SimPolicy;
  stockout_days: number;
  stockout_events: number;
  second_half_stockout_days: number;
  stockout_cost_usd: number;
  expedite_spend_usd: number;
  expedites: number;
  late_deliveries: number;
  overstated_order_share_second_half: number;
  belief_error_pp: number;
  qa_review_flags: number;
  stockout_days_by_period: number[];
}

export interface LearningScenario {
  truth: SupplierTruth;
  profile: string;
  rows: LearningRow[];
}

export interface LearningReport {
  label: string;
  days: number;
  seeds: number[];
  scenarios: LearningScenario[];
  example: { seed: number; flags: string[]; prior_error_pp: number | null; belief_error_pp: number | null };
  assumptions: Record<string, string>;
}

const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / Math.max(1, xs.length);

function row(policy: SimPolicy, rs: SimResult[]): LearningRow {
  const f = (g: (r: SimResult) => number, dp = 1) => round(mean(rs.map(g)), dp);
  const periods = rs[0]!.reliability.stockout_days_by_period.map((_, k) => f((r) => r.reliability.stockout_days_by_period[k]!));
  return {
    policy,
    stockout_days: f((r) => r.metrics.stockout_days),
    stockout_events: f((r) => r.metrics.stockout_events),
    second_half_stockout_days: f((r) => r.reliability.stockout_days_by_period.slice(Math.floor(periods.length / 2)).reduce((a, b) => a + b, 0)),
    stockout_cost_usd: f((r) => r.metrics.stockout_cost_usd, 0),
    expedite_spend_usd: f((r) => r.metrics.expedite_spend_usd, 0),
    expedites: f((r) => r.metrics.expedites),
    late_deliveries: f((r) => r.metrics.late_deliveries),
    overstated_order_share_second_half: f((r) => r.reliability.overstated_order_share.second_half ?? 0, 3),
    belief_error_pp: f((r) => r.reliability.belief_error_pp ?? 0),
    qa_review_flags: f((r) => r.reliability.qa_review_flags.length),
    stockout_days_by_period: periods,
  };
}

function scenario(truth: SupplierTruth, profile: ClientProfile, seeds: number[], days: number): LearningScenario {
  return {
    truth,
    profile: profile.id,
    rows: POLICIES.map((policy) => row(policy, seeds.map((seed) => runSimulation({ policy, seed, days, supplierTruth: truth, profile })))),
  };
}

export function buildLearningReport(seeds: number[], days = 360, exampleSeed = 1729): LearningReport {
  const ex = runSimulation({ policy: "agent_learning", seed: exampleSeed, days, supplierTruth: "drifted" });
  return {
    label: "SYNTHETIC SIMULATION: fictional company (Corvane Biologics), synthetic suppliers whose hidden reliability can differ from what they state.",
    days,
    seeds,
    scenarios: [
      scenario("drifted", CORVANE_PROFILE, seeds, days),
      scenario("as_stated", CORVANE_PROFILE, seeds, days),
      scenario("drifted", LEAN_GENERICS_PROFILE, seeds, days),
    ],
    example: { seed: exampleSeed, flags: ex.reliability.qa_review_flags, prior_error_pp: ex.reliability.prior_error_pp, belief_error_pp: ex.reliability.belief_error_pp },
    assumptions: {
      supplier_truth_drifted:
        "Per supplier, seeded: 25% overstate reliability (true on-time 25-45 pp below stated, 15-35 d mean lateness, +2-6% QC rejects), 15% are slightly better than stated, the rest are as stated (within 3 pp). Suppliers give 7 days' notice of a slip.",
      supplier_truth_as_stated: "Control: every delivery lands on its promised date (announced delay events still apply).",
      qc_rejection: "A rejected lot is replaced and arrives half a lead time later.",
      learning: "Beta beliefs per supplier, pooled across materials; stated metrics are a 6-delivery prior; 180-day half-life.",
      decisions: "agent_risk and agent_learning rank approved suppliers by risk-adjusted expected cost (400 Monte Carlo samples) and pad the reorder point by the believed lateness. agent_risk never updates its beliefs.",
      stockout_cost: "Client profile: Corvane USD 25,000 per stockout day + 40x the day's consumption value, risk aversion 0.7; lean generics USD 1,500 + 3x, risk aversion 0.1.",
      demand_and_delays: "Same demand stream, delay events and hidden outcomes for every policy (common random numbers).",
    },
  };
}

const usd = (v: number) => `$${(v / 1e6).toLocaleString("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 })}M`;
const NAMES: Record<SimPolicy, string> = {
  baseline: "Manual baseline",
  agent: "Agent (rule-based, current)",
  agent_risk: "Agent, risk-scored, no learning",
  agent_learning: "Agent, risk-scored + learning",
};

function table(s: LearningScenario): string {
  const head =
    "| Policy | Stockout pair-days | Stockout events | 2nd-half stockout days | Stockout cost | Expedite spend | Expedites | Orders to overstating suppliers (2nd half) | Belief error (pp) | QA flags |\n|---|---|---|---|---|---|---|---|---|---|";
  const body = s.rows
    .map(
      (r) =>
        `| ${NAMES[r.policy]} | ${r.stockout_days} | ${r.stockout_events} | ${r.second_half_stockout_days} | ${usd(r.stockout_cost_usd)} | ${usd(r.expedite_spend_usd)} | ${r.expedites} | ${Math.round(r.overstated_order_share_second_half * 100)}% | ${r.belief_error_pp} | ${r.qa_review_flags} |`,
    )
    .join("\n");
  return `${head}\n${body}`;
}

export function renderLearningMarkdown(r: LearningReport): string {
  const [drift, control, lean] = r.scenarios as [LearningScenario, LearningScenario, LearningScenario];
  const get = (s: LearningScenario, p: SimPolicy) => s.rows.find((x) => x.policy === p)!;
  const pct = (a: number, b: number) => `${b - a > 0 ? "+" : ""}${Math.round(((b - a) / a) * 100)}%`;
  const L = get(drift, "agent_learning");
  const R = get(drift, "agent_risk");
  const A = get(drift, "agent");
  const curve = (p: SimPolicy) => get(drift, p).stockout_days_by_period.join(" / ");
  return `# Learning results: does the agent get better as deliveries come in?

> **${r.label}**
> Not a forecast of real-world performance. Generated by \`pnpm --filter @supply-agent/core sim:learning\` (packages/core/src/sim/learning-report.ts).

${r.days}-day horizon, mean over ${r.seeds.length} seeds (${r.seeds[0]}..${r.seeds.at(-1)}). Every policy sees the same demand, delay events and hidden delivery outcomes; only the decision policy differs.

## What learns

- **Supplier reliability.** Each delivery updates the supplier's on-time rate, lateness and QC pass rate (Beta beliefs, stated metrics as a weak prior, recent deliveries weigh more). Rankings and reorder points use the updated belief on the next decision.
- **Client-conditioned, probabilistic choice.** Suppliers are ranked by risk-adjusted expected cost: purchase cost plus simulated stockout days priced with the client's own stockout cost, blending the average and the worst 10% by the client's risk aversion. No fixed weights.
- **QA flags, not disqualification.** When a supplier's observed on-time rate falls well below what it states, the agent raises a QA supplier review. Qualification state, the no-substitution rule and the approval limit never change.

## Suppliers that overstate reliability (Corvane profile)

${table(drift)}

Learning vs the same policy without learning: stockout pair-days ${pct(R.stockout_days, L.stockout_days)}, stockout cost ${pct(R.stockout_cost_usd, L.stockout_cost_usd)}, belief error ${R.belief_error_pp} -> ${L.belief_error_pp} pp. Against the current rule-based agent: stockout pair-days ${pct(A.stockout_days, L.stockout_days)}, stockout cost ${pct(A.stockout_cost_usd, L.stockout_cost_usd)}, expedite spend ${pct(A.expedite_spend_usd, L.expedite_spend_usd)}.

Stockout pair-days per 30-day period:

- Rule-based agent: ${curve("agent")}
- Risk-scored, no learning: ${curve("agent_risk")}
- Risk-scored + learning: ${curve("agent_learning")}

## Control: suppliers perform as stated (Corvane profile)

Learning should not help or hurt much when the stated metrics are right.

${table(control)}

## Same world, lean generics client profile

A cheaper stockout and low risk aversion: the same agent buys fewer expedites.

${table(lean)}

## Example QA flags (seed ${r.example.seed}, learning policy)

Belief error ${r.example.prior_error_pp} pp (stated metrics) -> ${r.example.belief_error_pp} pp (learned).

${r.example.flags.slice(0, 6).map((f) => `- ${f}`).join("\n") || "- none"}

## Limits

- The gain depends on suppliers' stated metrics being wrong. In the control world the learning policy matches the non-learning one.
- Belief error is measured against each supplier's hidden on-time rate, which excludes announced delay events. The learner sees those delays as late deliveries, so in the control world its error is above zero even though its decisions match the non-learning policy.
- 40 of 107 positions have a single qualified supplier, so learning can only move their reorder point, not the supplier.
- The risk-scored policies buy more expedites for Corvane because a stockout day is priced at USD 25,000 or more. Under the lean profile they buy fewer.

## Assumptions

${Object.entries(r.assumptions)
  .map(([k, v]) => `- **${k}:** ${v}`)
  .join("\n")}
`;
}
