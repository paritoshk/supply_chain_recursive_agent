/**
 * Supplier reliability that learns from delivery outcomes.
 *
 * A supplier's on-time rate, lateness and incoming-QC pass rate are beliefs, not fixed numbers:
 *  - on time:   Beta(alpha, beta)
 *  - QC pass:   Beta(alpha, beta)
 *  - lateness:  mean days late when late (pseudo-count weighted mean)
 * The metrics on the approved-supplier link (supplier-reported, unaudited) are a weak prior.
 * Every recorded delivery updates the belief, and recent deliveries weigh more (half-life).
 * Outcomes are pooled per supplier across materials: reliability is a property of the supplier's
 * operations, so a late lot of one material is evidence about the next.
 *
 * Guardrail: beliefs only move rankings and risk estimates. They never change qualification state,
 * BIOSECURE blocks, the no-substitution rule or the approval limit. A supplier that keeps missing
 * is flagged for a QA supplier review; a human decides.
 */
import type { MaterialSupplier } from "../types.ts";
import { round } from "./dates.ts";

/** Days late that still count as on time. */
export const ON_TIME_GRACE_DAYS = 2;
/** An outcome this many days old weighs half as much as one recorded today. */
export const OUTCOME_HALF_LIFE_DAYS = 180;
/** Prior strength in pseudo-deliveries. Supplier-reported OTD is weak evidence. */
export const PRIOR_STRENGTH = { on_time: 6, qc: 30, lateness: 3 } as const;

/** One observed delivery, reduced to what the belief needs. `day` is a day number (sim day or epoch day). */
export interface Observation {
  supplier_id: string;
  day: number;
  /** Actual minus promised lead time, floored at 0. */
  late_days: number;
  qc_passed: boolean;
}

export interface BetaBelief {
  alpha: number;
  beta: number;
  mean: number;
  /** Approximate 90% interval (normal approximation, clamped to [0, 1]). */
  lo90: number;
  hi90: number;
}

export interface ReliabilityBelief {
  supplier_id: string;
  on_time: BetaBelief;
  qc_pass: BetaBelief;
  /** Expected days late, given the delivery is late. */
  late_days_mean: number;
  /** Raw count and decay-weighted count of outcomes behind the belief. */
  observations: number;
  evidence_weight: number;
  prior: { on_time: number; qc_pass: number; late_days_mean: number };
  /** Posterior minus prior on-time rate, in percentage points. */
  on_time_shift_pp: number;
  /** Set when the evidence says the supplier performs well below its stated metrics. Advisory only. */
  qa_review: string | null;
}

export type PriorInput = Pick<MaterialSupplier, "supplier_id" | "otd_pct" | "lead_time_variance_days" | "rejection_rate">;

function beta(alpha: number, b: number): BetaBelief {
  const mean = alpha / (alpha + b);
  const sd = Math.sqrt((alpha * b) / ((alpha + b) ** 2 * (alpha + b + 1)));
  return {
    alpha: round(alpha, 3),
    beta: round(b, 3),
    mean: round(mean, 4),
    lo90: round(Math.max(0, mean - 1.645 * sd), 4),
    hi90: round(Math.min(1, mean + 1.645 * sd), 4),
  };
}

/** Prior from supplier-stated metrics. Unknown metrics get a vaguer prior, not a fixed half credit. */
export function reliabilityPrior(link: PriorInput) {
  const onTime = link.otd_pct == null ? 0.8 : Math.min(0.995, Math.max(0.05, link.otd_pct / 100));
  const qc = link.rejection_rate == null ? 0.97 : Math.min(0.999, Math.max(0.5, 1 - link.rejection_rate));
  const late = Math.max(5, 2 * (link.lead_time_variance_days ?? 7));
  return {
    on_time: onTime,
    qc_pass: qc,
    late_days_mean: late,
    on_time_strength: link.otd_pct == null ? 2 : PRIOR_STRENGTH.on_time,
    qc_strength: link.rejection_rate == null ? 10 : PRIOR_STRENGTH.qc,
  };
}

/**
 * Posterior reliability for a supplier link, given every observation for that supplier.
 * `now` is the day number the belief is evaluated at (for decay). Pure.
 */
export function reliabilityBelief(link: PriorInput, observations: readonly Observation[], now: number): ReliabilityBelief {
  const p = reliabilityPrior(link);
  let a = p.on_time * p.on_time_strength;
  let b = (1 - p.on_time) * p.on_time_strength;
  let qa = p.qc_pass * p.qc_strength;
  let qb = (1 - p.qc_pass) * p.qc_strength;
  let lateW = PRIOR_STRENGTH.lateness;
  let lateSum = p.late_days_mean * PRIOR_STRENGTH.lateness;
  let n = 0;
  let weight = 0;
  for (const o of observations) {
    if (o.supplier_id !== link.supplier_id) continue;
    const w = 0.5 ** (Math.max(0, now - o.day) / OUTCOME_HALF_LIFE_DAYS);
    n++;
    weight += w;
    if (o.late_days <= ON_TIME_GRACE_DAYS) a += w;
    else {
      b += w;
      lateW += w;
      lateSum += w * o.late_days;
    }
    if (o.qc_passed) qa += w;
    else qb += w;
  }
  const onTime = beta(a, b);
  const shift = round((onTime.mean - p.on_time) * 100, 1);
  const qaReview =
    n >= 3 && onTime.hi90 < Math.min(0.75, p.on_time - 0.1)
      ? `On-time rate is ${Math.round(onTime.mean * 100)}% over ${n} recorded deliveries against ${Math.round(p.on_time * 100)}% stated. Recommend a QA supplier review.`
      : null;
  return {
    supplier_id: link.supplier_id,
    on_time: onTime,
    qc_pass: beta(qa, qb),
    late_days_mean: round(lateSum / lateW, 1),
    observations: n,
    evidence_weight: round(weight, 2),
    prior: { on_time: round(p.on_time, 4), qc_pass: round(p.qc_pass, 4), late_days_mean: p.late_days_mean },
    on_time_shift_pp: shift,
    qa_review: qaReview,
  };
}

/** Epoch day number for an ISO date (YYYY-MM-DD...), for decay on real receipts. */
export const epochDay = (iso: string) => Math.floor(Date.parse(iso.slice(0, 10)) / 86_400_000);

// ---------------------------------------------------------------------------
// Learning memory (persisted in the store)
// ---------------------------------------------------------------------------

/** A recorded goods receipt: what the supplier promised vs what happened. */
export interface SupplierOutcome {
  id: string;
  supplier_id: string;
  material_id: string;
  site_id: string;
  po_id: string | null;
  promised_date: string;
  received_date: string;
  late_days: number;
  qc_passed: boolean;
  source: "receipt" | "simulation";
  recorded_at: string;
}

/** A judge finding turned into an instruction for the next mission on the same material. */
export interface Lesson {
  id: string;
  mission_id: string;
  material_id: string;
  supplier_id: string | null;
  /** Failed check id, or "grounding" for a judge grounding flag. */
  check_id: string;
  text: string;
  created_at: string;
}

/** How a negotiation with a supplier ended, for the next negotiator's opening position. */
export interface NegotiationMemory {
  id: string;
  supplier_id: string;
  material_id: string;
  rfq_id: string;
  currency: string;
  /** The supplier's opening (list) offer and the price we settled at: what a buyer actually sees. */
  list_unit_price: number | null;
  accepted_unit_price: number | null;
  savings_vs_list_pct: number | null;
  expedited: boolean;
  lead_time_days: number;
  supplier_turns: number;
  created_at: string;
}

export const outcomesToObservations = (outcomes: readonly SupplierOutcome[]): Observation[] =>
  outcomes.map((o) => ({ supplier_id: o.supplier_id, day: epochDay(o.received_date), late_days: o.late_days, qc_passed: o.qc_passed }));
