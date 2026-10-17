import type { LotStatus, Severity } from "../types.ts";
import { diffDays } from "./dates.ts";

/**
 * Days of cover from usable stock. Only RELEASED quantity counts: quarantined or rejected stock
 * is not usable. Returns null when there is no consumption (cover is unbounded).
 */
export function coverDays(releasedQty: number, dailyRate: number): number | null {
  if (!(dailyRate > 0)) return null;
  return Math.max(0, releasedQty) / dailyRate;
}

/** Safety stock = daily demand x safety days. */
export function safetyStock(dailyRate: number, safetyDays: number): number {
  return Math.max(0, dailyRate) * Math.max(0, safetyDays);
}

/** Reorder point = daily demand x (lead time + safety days). Null when the lead time is unknown. */
export function reorderPoint(dailyRate: number, leadDays: number | null, safetyDays: number): number | null {
  if (leadDays == null) return null;
  return Math.max(0, dailyRate) * (Math.max(0, leadDays) + Math.max(0, safetyDays));
}

/** Quantity above the reorder point. */
export function surplus(qty: number, rop: number | null): number {
  if (rop == null) return 0;
  return Math.max(0, qty - rop);
}

export interface LotLike {
  external_id: string;
  qty: number;
  status: LotStatus;
  expiry_date: string;
}

export interface LotExpiryRisk {
  external_id: string;
  qty: number;
  expiry_date: string;
  days_to_expiry: number;
  at_risk_qty: number;
}

export interface ExpiryRiskResult {
  /** Released quantity expected to expire before it is consumed (FEFO). */
  at_risk_qty: number;
  earliest_expiry: string | null;
  lots: LotExpiryRisk[];
}

/**
 * First-expiry-first-out simulation over released lots: how much stock expires before it can be
 * consumed at `dailyRate`. Lots past expiry are fully at risk. `horizonDays` limits the check to
 * lots expiring within that many days (default: all lots).
 */
export function expiryRisk(
  lots: LotLike[],
  dailyRate: number,
  today: string,
  horizonDays = Number.POSITIVE_INFINITY,
): ExpiryRiskResult {
  const released = lots
    .filter((l) => l.status === "released" && l.qty > 0)
    .sort((a, b) => a.expiry_date.localeCompare(b.expiry_date) || a.external_id.localeCompare(b.external_id));

  let t = 0; // day at which the next lot starts being consumed
  let total = 0;
  const out: LotExpiryRisk[] = [];
  for (const lot of released) {
    const dte = diffDays(today, lot.expiry_date);
    const window = Math.max(0, dte - t);
    const usable = dailyRate > 0 ? Math.min(lot.qty, window * dailyRate) : 0;
    const atRisk = dte <= horizonDays ? lot.qty - usable : 0;
    if (dailyRate > 0) t += usable / dailyRate;
    total += atRisk;
    out.push({ external_id: lot.external_id, qty: lot.qty, expiry_date: lot.expiry_date, days_to_expiry: dte, at_risk_qty: atRisk });
  }
  return { at_risk_qty: total, earliest_expiry: released[0]?.expiry_date ?? null, lots: out };
}

export interface SeverityInput {
  coverDays: number | null;
  leadTimeDays: number | null;
  safetyDays: number;
  releasedQty?: number;
  reorderPoint?: number | null;
}

/**
 * - action: cover runs out before a new order could land (cover < lead time), or below safety
 *           days when the lead time is unknown.
 * - watch:  at or below the reorder point (cover < lead + safety).
 * - info:   healthy.
 */
export function severityFor(input: SeverityInput): Severity {
  const { coverDays: cover, leadTimeDays: lead, safetyDays } = input;
  if (cover == null) return "info";
  if (lead == null) return cover < safetyDays ? "action" : "info";
  if (cover < lead) return "action";
  const belowRop =
    input.releasedQty != null && input.reorderPoint != null
      ? input.releasedQty <= input.reorderPoint
      : cover <= lead + safetyDays;
  return belowRop ? "watch" : "info";
}

/** Linear burn-down of released stock (no inbound), for charts. */
export function projectCover(releasedQty: number, dailyRate: number, horizonDays: number): Array<{ day: number; released_qty: number }> {
  const pts: Array<{ day: number; released_qty: number }> = [];
  for (let d = 0; d <= horizonDays; d++) pts.push({ day: d, released_qty: Math.max(0, releasedQty - dailyRate * d) });
  return pts;
}
