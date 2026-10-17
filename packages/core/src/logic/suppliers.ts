import type { MaterialSupplier, QualificationState } from "../types.ts";
import { round } from "./dates.ts";

export const SCORE_WEIGHTS = { otd: 35, lead_variance: 15, rejection: 20, qualification: 30 } as const;

const QUAL_CREDIT: Record<QualificationState, number> = {
  released_for_use: 1,
  quality_approved: 0.75,
  technically_suitable: 0.35,
  discovery_candidate: 0.1,
};

export type ScoreInput = Pick<
  MaterialSupplier,
  "otd_pct" | "lead_time_variance_days" | "rejection_rate" | "qualification_state" | "biosecure_review"
> & { supply_stage?: MaterialSupplier["supply_stage"] };

export interface SupplierScore {
  /** 0..100 */
  score: number;
  blocked: boolean;
  components: { otd: number; lead_variance: number; rejection: number; qualification: number };
  reasons: string[];
}

/**
 * Weighted supplier score (0..100). Unknown metrics get half credit, never full.
 * A BIOSECURE-flagged entity is blocked (score 0) regardless of other metrics.
 */
export function supplierScore(ms: ScoreInput): SupplierScore {
  const reasons: string[] = [];
  const otd = ms.otd_pct == null ? 0.5 : Math.min(1, Math.max(0, ms.otd_pct / 100));
  const lv = ms.lead_time_variance_days == null ? 0.5 : 1 - Math.min(Math.max(0, ms.lead_time_variance_days), 20) / 20;
  const rej = ms.rejection_rate == null ? 0.5 : 1 - Math.min(Math.max(0, ms.rejection_rate), 0.05) / 0.05;
  let qual = QUAL_CREDIT[ms.qualification_state];
  if (ms.supply_stage === "development") {
    qual *= 0.5;
    reasons.push("development-stage source");
  }
  if (ms.otd_pct == null) reasons.push("no on-time-delivery history");
  if (ms.rejection_rate == null) reasons.push("no rejection history");

  const components = {
    otd: round(otd * SCORE_WEIGHTS.otd, 1),
    lead_variance: round(lv * SCORE_WEIGHTS.lead_variance, 1),
    rejection: round(rej * SCORE_WEIGHTS.rejection, 1),
    qualification: round(qual * SCORE_WEIGHTS.qualification, 1),
  };
  let score = components.otd + components.lead_variance + components.rejection + components.qualification;

  if (ms.biosecure_review === "not_screened") {
    score -= 5;
    reasons.push("BIOSECURE entity screening not done");
  }
  const blocked = ms.biosecure_review === "flagged";
  if (blocked) reasons.push("BIOSECURE entity-level screen flagged");
  return { score: blocked ? 0 : round(Math.max(0, score), 1), blocked, components, reasons };
}
