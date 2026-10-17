import type { QualificationState, SupplyStage } from "../types.ts";

export const QUALIFICATION_ORDER: readonly QualificationState[] = [
  "discovery_candidate",
  "technically_suitable",
  "quality_approved",
  "released_for_use",
] as const;

export const APPROVED_STATES: readonly QualificationState[] = ["quality_approved", "released_for_use"];

export function isApproved(state: QualificationState): boolean {
  return APPROVED_STATES.includes(state);
}

export interface PromotionCheck {
  ok: boolean;
  reason: string;
}

/**
 * A supplier moves forward exactly one qualification state at a time. A cheaper quote never skips a state.
 * Development / tech-pack sources cannot be promoted past technically_suitable.
 * The agent itself never promotes; this check gates the human approval flow.
 */
export function canPromote(
  from: QualificationState,
  to: QualificationState,
  opts: { supply_stage?: SupplyStage } = {},
): PromotionCheck {
  const i = QUALIFICATION_ORDER.indexOf(from);
  const j = QUALIFICATION_ORDER.indexOf(to);
  if (i < 0 || j < 0) return { ok: false, reason: `unknown state ${from} -> ${to}` };
  if (j <= i) return { ok: false, reason: `${to} is not a promotion from ${from}` };
  if (j > i + 1) {
    const skipped = QUALIFICATION_ORDER.slice(i + 1, j).join(", ");
    return { ok: false, reason: `cannot skip qualification state(s): ${skipped}` };
  }
  if (opts.supply_stage === "development" && j > QUALIFICATION_ORDER.indexOf("technically_suitable")) {
    return { ok: false, reason: "development-stage source cannot be promoted to commercial status" };
  }
  return { ok: true, reason: `${from} -> ${to}` };
}
