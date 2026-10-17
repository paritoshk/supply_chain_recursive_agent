import { filteredPairs, positionFor } from "@supply-agent/core";
import { withStore } from "./store.ts";

export interface Breach {
  material_id: string;
  site_id: string;
  cover_days: number | null;
  headline: string;
}

/** Deterministic sentinel: action-severity positions without an open mission, worst cover first. */
export async function lowStockScan(): Promise<Breach[]> {
  return withStore((store) => {
    const open = new Set(
      store.missions().filter((m) => !["completed", "failed"].includes(m.status)).map((m) => `${m.material_id}|${m.site_id}`),
    );
    return filteredPairs(store, {})
      .map(({ material_id, site_id }) => positionFor(store, material_id, site_id))
      .filter((p) => p.severity === "action" && !open.has(`${p.material_id}|${p.site_id}`))
      .sort((a, b) => (a.cover_days ?? 0) - (b.cover_days ?? 0))
      .map((p) => ({
        material_id: p.material_id,
        site_id: p.site_id,
        cover_days: p.cover_days,
        headline: `${store.material(p.material_id)?.name} at ${store.site(p.site_id)?.name}: ${p.cover_days} days of cover vs reorder point ${p.reorder_point} ${p.unit}`,
      }));
  });
}
