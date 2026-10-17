import { coverDays, expiryRisk, reorderPoint, round, safetyStock, severityFor } from "../logic/index.ts";
import type { Store } from "../store.ts";
import type { Filters, Severity } from "../types.ts";

export interface Position {
  material_id: string;
  site_id: string;
  unit: string;
  released_qty: number;
  quarantined_qty: number;
  rejected_qty: number;
  daily_rate: number;
  lead_time_days: number | null;
  safety_days: number;
  cover_days: number | null;
  reorder_point: number | null;
  safety_stock: number;
  severity: Severity;
  unit_cost: number | null;
  last_restock_at: string | null;
  lot_ids: string[];
  released_lot_ids: string[];
  expiry_at_risk_qty: number;
  earliest_expiry: string | null;
}

/** Inventory position for one material at one site. Only released lots count toward cover. */
export function positionFor(store: Store, materialId: string, siteId: string): Position {
  const material = store.material(materialId);
  const c = store.consumptionFor(materialId, siteId);
  const lots = store.lots({ material_id: materialId, site_id: siteId }).filter((l) => l.qty > 0);
  const released = lots.filter((l) => l.status === "released" && l.expiry_date > store.today());
  const sum = (xs: typeof lots) => xs.reduce((s, l) => s + l.qty, 0);
  const releasedQty = sum(released);
  const daily = c?.daily_rate ?? 0;
  const lead = c?.lead_time_days ?? null;
  const safety = c?.safety_days ?? 14;
  const cover = coverDays(releasedQty, daily);
  const rop = reorderPoint(daily, lead, safety);
  const costed = released.filter((l) => l.unit_cost != null);
  const costedQty = sum(costed);
  const risk = expiryRisk(lots, daily, store.today());
  return {
    material_id: materialId,
    site_id: siteId,
    unit: material?.unit ?? "kg",
    released_qty: round(releasedQty, 4),
    quarantined_qty: round(sum(lots.filter((l) => l.status === "quarantined")), 4),
    rejected_qty: round(sum(lots.filter((l) => l.status === "rejected")), 4),
    daily_rate: daily,
    lead_time_days: lead,
    safety_days: safety,
    cover_days: cover == null ? null : round(cover, 1),
    reorder_point: rop == null ? null : round(rop, 4),
    safety_stock: round(safetyStock(daily, safety), 4),
    severity: severityFor({ coverDays: cover, leadTimeDays: lead, safetyDays: safety, releasedQty, reorderPoint: rop }),
    unit_cost: costedQty > 0 ? round(costed.reduce((s, l) => s + l.qty * (l.unit_cost as number), 0) / costedQty, 4) : null,
    last_restock_at: lots.map((l) => l.received_at).sort().at(-1) ?? null,
    lot_ids: lots.map((l) => l.external_id),
    released_lot_ids: released.map((l) => l.external_id),
    expiry_at_risk_qty: round(risk.at_risk_qty, 4),
    earliest_expiry: risk.earliest_expiry,
  };
}

/** (material, site) pairs with consumption, narrowed by dashboard filters. */
export function filteredPairs(store: Store, filters: Filters, extra: { material_id?: string; site_id?: string } = {}) {
  const productMaterials = filters.product_id
    ? new Set(store.boms().find((b) => b.product_id === filters.product_id)?.line_items.map((li) => li.material_external_id) ?? [])
    : null;
  const productSites = filters.product_id ? new Set(store.product(filters.product_id)?.site_ids ?? []) : null;
  return store.consumption().filter((c) => {
    const site = store.site(c.site_id);
    const mat = store.material(c.material_id);
    if (!site || !mat) return false;
    if (extra.material_id && c.material_id !== extra.material_id) return false;
    if (extra.site_id && c.site_id !== extra.site_id) return false;
    if (filters.site_id && c.site_id !== filters.site_id) return false;
    if (filters.region && site.region !== filters.region) return false;
    if (filters.material_class && mat.material_class !== filters.material_class) return false;
    if (productMaterials && !productMaterials.has(c.material_id)) return false;
    if (productSites && !productSites.has(c.site_id)) return false;
    return true;
  });
}
