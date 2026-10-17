/**
 * Deterministic production lines and a 60-day batch schedule for the synthetic Corvane Biologics sites.
 *
 * Kept separate from generateSeed() (and free of the seed RNG) so the core seed and its content hash
 * do not change. The schedule is a pure function of the seed's consumption, BOMs and products:
 *  - each line runs one product every `cadence_days`, starting `offset_days` after today;
 *  - a line consumes the product BOM materials that the site consumes (optionally narrowed by `only`);
 *  - per-batch quantity = site daily_rate x line share x cadence, so scheduled consumption over time
 *    matches the site's daily_rate (the share splits a material across lines by `weights`, default 1).
 *
 * Hero (MAT-SUC-INJ @ SITE-GHE, 5 kg/day): the antigen train uses 2 kg/day (14 kg per weekly batch)
 * and the formulation suite 3 kg/day (21 kg per weekly batch).
 */
import { addDays, round } from "../logic/dates.ts";
import type { BatchWorkOrder, CleanroomGrade, LineType, ProductionLine, Unit } from "../types.ts";
import type { SeedData } from "./generate.ts";

export const SCHEDULE_DAYS = 60;

export interface CatalogLine {
  id: string;
  site: string;
  name: string;
  product: string;
  type: LineType;
  batch_size: number;
  unit: Unit;
  grade: CleanroomGrade;
  cadence_days: number;
  offset_days: number;
  /** Restrict to these BOM materials (default: every BOM material the site consumes). */
  only?: string[];
  /** Relative share of a material when several lines at the site consume it (default 1). */
  weights?: Record<string, number>;
}

/** Days a batch occupies the line, for WorkOrder.due_date. */
const CYCLE_DAYS: Record<LineType, number> = {
  upstream_bioreactor: 14,
  downstream_purification: 3,
  formulation: 2,
  aseptic_fill: 1,
  lyophilization: 4,
  tableting: 1,
  inhaler_fill: 1,
};

export const PRODUCTION_LINES: CatalogLine[] = [
  // Ghent: VX-201 antigen + adjuvanted formulation (hero sucrose, saponin adjuvant)
  {
    id: "LINE-GHE-ANT1", site: "SITE-GHE", name: "Ghent antigen purification train 1", product: "VX-201", type: "downstream_purification",
    batch_size: 200, unit: "L", grade: "C", cadence_days: 7, offset_days: 1,
    only: ["MAT-SUC-INJ", "MAT-NACL", "MAT-NAP-DI", "MAT-NAP-MONO", "MAT-KCL", "MAT-TRIS", "MAT-MIX-500", "MAT-FIL-02"],
    weights: { "MAT-SUC-INJ": 2 },
  },
  {
    id: "LINE-GHE-FRM1", site: "SITE-GHE", name: "Ghent adjuvanted formulation suite", product: "VX-201", type: "formulation",
    batch_size: 500, unit: "L", grade: "B", cadence_days: 7, offset_days: 3,
    only: ["MAT-SUC-INJ", "MAT-SAP-QS", "MAT-MPL", "MAT-DOPC", "MAT-CHOL", "MAT-PS80-SR", "MAT-FIL-02"],
    weights: { "MAT-SUC-INJ": 3 },
  },
  // Raleigh: fill/finish for VX-201 and lyophilised MB-114 (parenteral mannitol)
  { id: "LINE-RAL-AF1", site: "SITE-RAL", name: "Raleigh aseptic filling line 1", product: "VX-201", type: "aseptic_fill", batch_size: 60_000, unit: "ea", grade: "A", cadence_days: 4, offset_days: 1 },
  { id: "LINE-RAL-LY1", site: "SITE-RAL", name: "Raleigh lyophilisation line 1", product: "MB-114", type: "lyophilization", batch_size: 20_000, unit: "ea", grade: "A", cadence_days: 5, offset_days: 3 },
  // Lyon: fill/finish
  { id: "LINE-LYO-AF1", site: "SITE-LYO", name: "Lyon aseptic filling line 1", product: "VX-201", type: "aseptic_fill", batch_size: 60_000, unit: "ea", grade: "A", cadence_days: 3, offset_days: 0 },
  { id: "LINE-LYO-LY1", site: "SITE-LYO", name: "Lyon lyophilisation line 1", product: "MB-114", type: "lyophilization", batch_size: 20_000, unit: "ea", grade: "A", cadence_days: 5, offset_days: 2 },
  // King of Prussia / Tuas: MB-114 drug substance
  {
    id: "LINE-KOP-USP1", site: "SITE-KOP", name: "King of Prussia 2000 L bioreactor train", product: "MB-114", type: "upstream_bioreactor",
    batch_size: 2000, unit: "L", grade: "C", cadence_days: 14, offset_days: 2,
    only: ["MAT-MED-CD", "MAT-FEED", "MAT-P188", "MAT-SUB-2000", "MAT-FIL-02"],
  },
  {
    id: "LINE-KOP-DSP1", site: "SITE-KOP", name: "King of Prussia purification train", product: "MB-114", type: "downstream_purification",
    batch_size: 1500, unit: "L", grade: "C", cadence_days: 7, offset_days: 5,
    only: ["MAT-PROA", "MAT-AEX", "MAT-VF", "MAT-FIL-02", "MAT-HIS", "MAT-HIS-HCL", "MAT-TRE-HP", "MAT-PS80-SR", "MAT-PS20", "MAT-ARG", "MAT-GLY", "MAT-NACL", "MAT-SUC-INJ"],
  },
  {
    id: "LINE-TUA-USP1", site: "SITE-TUA", name: "Tuas 2000 L bioreactor train", product: "MB-114", type: "upstream_bioreactor",
    batch_size: 2000, unit: "L", grade: "C", cadence_days: 14, offset_days: 6,
    only: ["MAT-MED-CD", "MAT-FEED", "MAT-P188", "MAT-SUB-2000", "MAT-FIL-02"],
  },
  {
    id: "LINE-TUA-DSP1", site: "SITE-TUA", name: "Tuas purification train", product: "MB-114", type: "downstream_purification",
    batch_size: 1500, unit: "L", grade: "C", cadence_days: 7, offset_days: 2,
    only: ["MAT-PROA", "MAT-VF", "MAT-FIL-02", "MAT-HIS", "MAT-TRE-HP", "MAT-PS80-SR", "MAT-PS20", "MAT-ARG", "MAT-NACL"],
  },
  // Cambridge: RX-310 dry-powder inhaler
  { id: "LINE-CAM-INH1", site: "SITE-CAM", name: "Cambridge DPI blister filling line", product: "RX-310", type: "inhaler_fill", batch_size: 250_000, unit: "ea", grade: "D", cadence_days: 2, offset_days: 0 },
  // Cork: AB-120 tablets
  { id: "LINE-COR-TAB1", site: "SITE-COR", name: "Cork tablet compression line 1", product: "AB-120", type: "tableting", batch_size: 600, unit: "kg", grade: "n/a", cadence_days: 2, offset_days: 1 },
];

function qtyRound(unit: string, q: number): number {
  if (unit === "ea" || unit === "g") return Math.max(0, Math.round(q));
  if (q < 1) return round(q, 4);
  if (q < 10) return round(q, 2);
  return round(q, 1);
}

const siteCode = (siteId: string) => siteId.replace(/^SITE-/, "");

export interface ProductionData {
  production_lines: ProductionLine[];
  work_orders: BatchWorkOrder[];
}

/** Pure, deterministic: production lines + a SCHEDULE_DAYS batch schedule from the seed's consumption and BOMs. */
export function generateProduction(seed: Pick<SeedData, "today" | "boms" | "consumption" | "materials">, days = SCHEDULE_DAYS): ProductionData {
  const today = seed.today;
  const bomOf = (product: string) => seed.boms.find((b) => b.product_id === product);
  const rate = (m: string, s: string) => seed.consumption.find((c) => c.material_id === m && c.site_id === s)?.daily_rate ?? 0;
  const unitOf = (m: string) => seed.materials.find((x) => x.external_id === m)?.unit ?? "kg";

  // materials each line consumes (BOM ∩ site consumption ∩ only)
  const lineMaterials = new Map<string, string[]>();
  for (const l of PRODUCTION_LINES) {
    const bom = bomOf(l.product)?.line_items.map((li) => li.material_external_id) ?? [];
    lineMaterials.set(
      l.id,
      bom.filter((m) => rate(m, l.site) > 0 && (!l.only || l.only.includes(m))),
    );
  }
  const weight = (l: CatalogLine, m: string) => l.weights?.[m] ?? 1;
  const share = (l: CatalogLine, m: string) => {
    const peers = PRODUCTION_LINES.filter((p) => p.site === l.site && lineMaterials.get(p.id)?.includes(m));
    const total = peers.reduce((s, p) => s + weight(p, m), 0);
    return total > 0 ? weight(l, m) / total : 0;
  };

  const production_lines: ProductionLine[] = PRODUCTION_LINES.map((l) => ({
    external_id: l.id,
    site_id: l.site,
    name: l.name,
    product_id: l.product,
    line_type: l.type,
    batch_size: l.batch_size,
    unit: l.unit,
    cleanroom_grade: l.grade,
  }));

  const raw: Array<Omit<BatchWorkOrder, "external_id"> & { day: number }> = [];
  for (const l of PRODUCTION_LINES) {
    const mats = lineMaterials.get(l.id) ?? [];
    const lineShort = l.id.split("-").at(-1) as string;
    let n = 0;
    for (let day = l.offset_days; day < days; day += l.cadence_days) {
      n += 1;
      const start = addDays(today, day);
      raw.push({
        day,
        product_id: l.product,
        site_id: l.site,
        line_id: l.id,
        qty: l.batch_size,
        status: day < 7 ? "released" : "planned",
        start_date: start,
        due_date: addDays(start, CYCLE_DAYS[l.type]),
        batch_no: `${l.product.replace("-", "")}-${siteCode(l.site)}-${lineShort}-${String(n).padStart(3, "0")}`,
        materials: mats.map((m) => ({
          material_external_id: m,
          qty_per_batch: qtyRound(unitOf(m), rate(m, l.site) * share(l, m) * l.cadence_days),
          unit: unitOf(m),
        })),
      });
    }
  }
  raw.sort((a, b) => a.site_id.localeCompare(b.site_id) || a.day - b.day || a.line_id.localeCompare(b.line_id));
  const seq: Record<string, number> = {};
  const work_orders: BatchWorkOrder[] = raw.map(({ day: _day, ...wo }) => {
    const code = siteCode(wo.site_id);
    seq[code] = (seq[code] ?? 0) + 1;
    return { external_id: `WO-${code}-${String(seq[code]).padStart(4, "0")}`, ...wo };
  });
  return { production_lines, work_orders };
}
