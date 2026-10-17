import { lowStockScan } from "./sentinel.ts";

/** The proactive message the sentinel sends; the agent receives it as its first turn. */
export async function sentinelPrompt(materialId?: string, siteId?: string): Promise<string | null> {
  const breaches = await lowStockScan();
  const top = materialId && siteId ? breaches.find((b) => b.material_id === materialId && b.site_id === siteId) ?? breaches[0] : breaches[0];
  if (!top) return null;
  return `Sentinel alert: ${top.headline}. Run run_mission for material ${top.material_id} at site ${top.site_id}, then tell the planner the outcome in four lines.`;
}
