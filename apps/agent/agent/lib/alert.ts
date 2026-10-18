import { positionFor } from "@supply-agent/core";
import { lowStockScan } from "./sentinel.ts";
import { withStore } from "./store.ts";

const prompt = (headline: string, materialId: string, siteId: string) =>
  `Sentinel alert: ${headline}. Run run_mission for material ${materialId} at site ${siteId}, then tell the planner the outcome in four lines.`;

/**
 * The proactive message the sentinel sends; the agent receives it as its first turn.
 * An explicit material + site (operator or demo button) always produces an alert for that pair;
 * otherwise the worst breach without a mission in flight is chosen.
 */
export async function sentinelPrompt(materialId?: string, siteId?: string): Promise<string | null> {
  if (materialId && siteId) {
    const headline = await withStore((store) => {
      const material = store.material(materialId);
      const site = store.site(siteId);
      if (!material || !site || !store.consumptionFor(materialId, siteId)) return null;
      const p = positionFor(store, materialId, siteId);
      return `${material.name} at ${site.name}: ${p.cover_days} days of cover vs reorder point ${p.reorder_point} ${p.unit}`;
    });
    return headline ? prompt(headline, materialId, siteId) : null;
  }
  const top = (await lowStockScan())[0];
  return top ? prompt(top.headline, top.material_id, top.site_id) : null;
}
