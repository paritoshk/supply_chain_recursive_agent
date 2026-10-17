/**
 * Probabilistic, client-conditioned evaluation of supply options.
 *
 * There are no fixed weights. For each option the outcome is simulated from the supplier's reliability
 * belief (learning.ts): on time or late, how late, whether the lot passes incoming QC. Each sample's
 * cost is purchase cost plus the stockout days it causes, priced with the client's own stockout cost.
 * Options are ranked by risk-adjusted cost, blending the expected cost with the mean of the worst 10%
 * by the client's risk aversion.
 *
 * The same two suppliers rank differently for a tight deadline vs a loose one, and for a client
 * whose stockouts stop a biologics line vs one that can absorb a short gap. Seeded and deterministic.
 */
import { round } from "./dates.ts";
import type { ReliabilityBelief } from "./learning.ts";

export interface ClientProfile {
  id: string;
  name: string;
  /** Cost of one stockout day as a multiple of the value of one day's consumption. */
  stockout_cost_multiple: number;
  /** Fixed cost per stockout day (USD): batch disruption, line idle time. */
  stockout_cost_floor_usd: number;
  /** 0 optimises the average outcome; 1 optimises the worst 10% of outcomes. */
  risk_aversion: number;
  /** An option below this probability of release in time needs a bridge or human sign-off. */
  min_p_in_time: number;
  /** Incoming QC release after arrival, in days. */
  qc_release_days: number;
  /** Delay when a lot fails incoming QC and is replaced, as a fraction of the lead time. */
  qc_reject_delay_fraction: number;
}

/** The fictional demo client: a biologics maker whose stockouts stop fill lines. */
export const CORVANE_PROFILE: ClientProfile = {
  id: "corvane",
  name: "Corvane Biologics (fictional)",
  stockout_cost_multiple: 40,
  stockout_cost_floor_usd: 25_000,
  risk_aversion: 0.7,
  min_p_in_time: 0.9,
  qc_release_days: 7,
  qc_reject_delay_fraction: 0.5,
};

/** A contrasting example client: low-margin generics with slack in the schedule. */
export const LEAN_GENERICS_PROFILE: ClientProfile = {
  id: "lean-generics",
  name: "Example lean generics client (fictional)",
  stockout_cost_multiple: 3,
  stockout_cost_floor_usd: 1_500,
  risk_aversion: 0.1,
  min_p_in_time: 0.7,
  qc_release_days: 5,
  qc_reject_delay_fraction: 0.5,
};

export const CLIENT_PROFILES: Record<string, ClientProfile> = {
  [CORVANE_PROFILE.id]: CORVANE_PROFILE,
  [LEAN_GENERICS_PROFILE.id]: LEAN_GENERICS_PROFILE,
};

export interface SupplyOption {
  /** Unique per variant, e.g. "SUP-BRW" or "SUP-BRW:expedited". */
  id: string;
  supplier_id: string;
  /** Landed USD per unit including any expedite premium. Null when unpriced (quote-only). */
  unit_cost_usd: number | null;
  qty: number;
  /** Quoted lead time in days. */
  lead_days: number;
}

export interface NeedContext {
  /** Days until stock runs out without this supply. */
  days_available: number;
  /** Value of one day's consumption at standard cost (USD). */
  daily_value_usd: number;
  /** Overrides the client's QC release days (the simulator counts arrival as usable). */
  qc_release_days?: number;
}

export interface OptionRisk {
  option_id: string;
  supplier_id: string;
  /** P(released for use by the time stock runs out). */
  p_in_time: number;
  p_qc_pass: number;
  expected_release_days: number;
  expected_stockout_days: number;
  purchase_usd: number | null;
  expected_cost_usd: number | null;
  /** Mean cost of the worst 10% of samples. */
  cvar90_cost_usd: number | null;
  risk_adjusted_cost_usd: number | null;
  /** Expected stockout cost alone (risk-adjusted), comparable across priced and unpriced options. */
  risk_adjusted_stockout_usd: number;
  meets_min_p: boolean;
  stockout_cost_per_day_usd: number;
  samples: number;
}

export const DEFAULT_SAMPLES = 1000;

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Small seeded sampler (mulberry32) with normal, gamma and beta draws. */
class Sampler {
  private a: number;
  constructor(seed: number) {
    this.a = seed >>> 0;
  }
  u(): number {
    this.a = (this.a + 0x6d2b79f5) >>> 0;
    let t = this.a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  normal(): number {
    return Math.sqrt(-2 * Math.log(Math.max(1e-12, this.u()))) * Math.cos(2 * Math.PI * this.u());
  }
  /** Marsaglia-Tsang. */
  gamma(shape: number): number {
    if (shape < 1) return this.gamma(shape + 1) * this.u() ** (1 / shape);
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number;
      let v: number;
      do {
        x = this.normal();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = this.u();
      if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }
  beta(a: number, b: number): number {
    const x = this.gamma(Math.max(1e-3, a));
    const y = this.gamma(Math.max(1e-3, b));
    return x / (x + y);
  }
}

export const stockoutCostPerDay = (need: Pick<NeedContext, "daily_value_usd">, profile: ClientProfile) =>
  profile.stockout_cost_floor_usd + profile.stockout_cost_multiple * Math.max(0, need.daily_value_usd);

/**
 * Monte Carlo evaluation of one option. Parameter uncertainty is sampled too: each draw first samples
 * an on-time rate and a QC pass rate from the Beta beliefs, so a supplier with little history is
 * genuinely uncertain rather than average.
 */
export function evaluateOption(
  opt: SupplyOption,
  belief: Pick<ReliabilityBelief, "on_time" | "qc_pass" | "late_days_mean">,
  need: NeedContext,
  profile: ClientProfile,
  samples = DEFAULT_SAMPLES,
): OptionRisk {
  const s = new Sampler(fnv1a(`${opt.id}|${opt.lead_days}|${round(need.days_available, 2)}|${profile.id}`));
  const qcDays = need.qc_release_days ?? profile.qc_release_days;
  const perDay = stockoutCostPerDay(need, profile);
  const purchase = opt.unit_cost_usd == null ? null : opt.unit_cost_usd * opt.qty;
  const costs: number[] = [];
  const stockouts: number[] = [];
  let inTime = 0;
  let qcPass = 0;
  let releaseSum = 0;
  for (let k = 0; k < samples; k++) {
    const pOnTime = s.beta(belief.on_time.alpha, belief.on_time.beta);
    const pQc = s.beta(belief.qc_pass.alpha, belief.qc_pass.beta);
    // Lateness when late: gamma with shape 2 around the believed mean (right-skewed).
    const late = s.u() < pOnTime ? 0 : (belief.late_days_mean / 2) * s.gamma(2);
    const passed = s.u() < pQc;
    const release = opt.lead_days + late + qcDays + (passed ? 0 : opt.lead_days * profile.qc_reject_delay_fraction);
    const short = Math.max(0, release - need.days_available);
    if (short === 0) inTime++;
    if (passed) qcPass++;
    releaseSum += release;
    stockouts.push(short);
    costs.push(short * perDay);
  }
  const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
  const tail = (xs: number[]) => {
    const sorted = [...xs].sort((a, b) => b - a);
    return mean(sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.1))));
  };
  const eStock = mean(costs);
  const tStock = tail(costs);
  const raStock = (1 - profile.risk_aversion) * eStock + profile.risk_aversion * tStock;
  const pInTime = inTime / samples;
  return {
    option_id: opt.id,
    supplier_id: opt.supplier_id,
    p_in_time: round(pInTime, 4),
    p_qc_pass: round(qcPass / samples, 4),
    expected_release_days: round(releaseSum / samples, 1),
    expected_stockout_days: round(mean(stockouts), 2),
    purchase_usd: purchase == null ? null : round(purchase, 2),
    expected_cost_usd: purchase == null ? null : round(purchase + eStock, 2),
    cvar90_cost_usd: purchase == null ? null : round(purchase + tStock, 2),
    risk_adjusted_cost_usd: purchase == null ? null : round(purchase + raStock, 2),
    risk_adjusted_stockout_usd: round(raStock, 2),
    meets_min_p: pInTime >= profile.min_p_in_time,
    stockout_cost_per_day_usd: round(perDay, 2),
    samples,
  };
}

/** Priced options by risk-adjusted cost, then unpriced options by risk-adjusted stockout cost. */
export function rankOptions(risks: OptionRisk[]): OptionRisk[] {
  return [...risks].sort((a, b) => {
    if (a.risk_adjusted_cost_usd != null && b.risk_adjusted_cost_usd != null) return a.risk_adjusted_cost_usd - b.risk_adjusted_cost_usd;
    if (a.risk_adjusted_cost_usd != null) return -1;
    if (b.risk_adjusted_cost_usd != null) return 1;
    return a.risk_adjusted_stockout_usd - b.risk_adjusted_stockout_usd;
  });
}
