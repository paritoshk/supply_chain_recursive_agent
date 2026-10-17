/**
 * Day-by-day production-line feasibility for one material at one site. Pure.
 *
 * Model: released stock (FEFO by expiry) is drawn by scheduled batches on their start day. Inbound supply
 * (transfer, purchase) becomes usable on its release day = arrival day + QC/receipt release days.
 * Quarantined stock never counts. A batch is feasible when released stock at its start covers its need;
 * an infeasible batch draws nothing (it cannot start), so it is reported as at risk.
 */
import { addDays, diffDays, round } from "./dates.ts";

export interface FeasibilityBatch {
  batch_no: string;
  work_order_id: string;
  line_id: string;
  line_name: string;
  product_id: string;
  start_date: string;
  material_needed: number;
}

export interface FeasibilityReceipt {
  kind: "transfer" | "purchase";
  qty: number;
  arrives_in_days: number;
  release_days: number;
  ref?: string | null;
}

export interface FeasibilityLot {
  external_id: string;
  qty: number;
  expiry_date: string;
}

export interface BatchFeasibilityRow extends FeasibilityBatch {
  available_at_start: number;
  feasible: boolean;
  shortfall: number;
}

export interface FeasibilityResult {
  rows: BatchFeasibilityRow[];
  receipts: Array<FeasibilityReceipt & { arrival_date: string; release_day: number; release_date: string }>;
  batches_total: number;
  batches_at_risk: number;
  all_feasible: boolean;
  first_infeasible_batch: BatchFeasibilityRow | null;
  /** Released stock at the end of each day (day 0 = today). */
  stock_by_day: Array<{ day: number; date: string; released: number }>;
  expired_qty: number;
}

const EPS = 1e-9;

export function simulateBatchFeasibility(input: {
  today: string;
  horizon_days: number;
  released_lots: FeasibilityLot[];
  batches: FeasibilityBatch[];
  receipts?: FeasibilityReceipt[];
}): FeasibilityResult {
  const { today, horizon_days } = input;
  // stock pool: FEFO list of {qty, expiry}
  const pool = input.released_lots
    .filter((l) => l.qty > 0 && l.expiry_date > today)
    .map((l) => ({ qty: l.qty, expiry: l.expiry_date }))
    .sort((a, b) => a.expiry.localeCompare(b.expiry));
  const receipts = (input.receipts ?? [])
    .filter((r) => r.qty > 0)
    .map((r) => {
      const arrival = Math.max(0, Math.round(r.arrives_in_days));
      const release = arrival + Math.max(0, Math.round(r.release_days));
      return { ...r, arrival_date: addDays(today, arrival), release_day: release, release_date: addDays(today, release) };
    });
  const byDay = new Map<number, FeasibilityBatch[]>();
  for (const b of input.batches) {
    const d = diffDays(today, b.start_date);
    if (d < 0 || d >= horizon_days) continue;
    byDay.set(d, [...(byDay.get(d) ?? []), b]);
  }

  const total = () => pool.reduce((s, l) => s + l.qty, 0);
  const rows: BatchFeasibilityRow[] = [];
  const stock: FeasibilityResult["stock_by_day"] = [];
  let expired = 0;
  for (let d = 0; d < horizon_days; d++) {
    const date = addDays(today, d);
    // expire
    for (const l of pool) {
      if (l.expiry <= date && l.qty > 0) {
        expired += l.qty;
        l.qty = 0;
      }
    }
    // releases (released stock from inbound has the material's full remaining shelf life; treat as non-expiring in horizon)
    for (const r of receipts) if (r.release_day === d) pool.push({ qty: r.qty, expiry: "9999-12-31" });
    pool.sort((a, b) => a.expiry.localeCompare(b.expiry));
    // batches
    for (const b of (byDay.get(d) ?? []).sort((x, y) => x.line_id.localeCompare(y.line_id))) {
      const available = total();
      const feasible = available + EPS >= b.material_needed;
      if (feasible) {
        let need = b.material_needed;
        for (const l of pool) {
          if (need <= 0) break;
          const take = Math.min(l.qty, need);
          l.qty -= take;
          need -= take;
        }
      }
      rows.push({
        ...b,
        available_at_start: round(available, 4),
        feasible,
        shortfall: feasible ? 0 : round(b.material_needed - available, 4),
      });
    }
    stock.push({ day: d, date, released: round(total(), 4) });
  }
  const atRisk = rows.filter((r) => !r.feasible);
  return {
    rows,
    receipts,
    batches_total: rows.length,
    batches_at_risk: atRisk.length,
    all_feasible: atRisk.length === 0,
    first_infeasible_batch: atRisk[0] ?? null,
    stock_by_day: stock,
    expired_qty: round(expired, 4),
  };
}
