/**
 * Deterministic synthetic dataset for Corvane Biologics (fictional). Same seed -> same data.
 *
 * Scenarios baked in (also the demo acceptance tests):
 *  1. Hero: Ghent injectable sucrose: 120 kg released + 30 kg quarantined, 5 kg/day, 42 d lead, 14 d safety.
 *  2. Guardrail: licensed saponin adjuvant short at Ghent; only a development analogue exists as an alternative.
 *  3. Transfer: near-expiry surplus parenteral mannitol at Cork while Raleigh is below its reorder point.
 *  4. Polysorbate 80 (super-refined) suppliers with differing CEP/DMF flags.
 *  5. A development-stage (technically_suitable only) source for an inhaled API.
 */
import { addDays, round } from "../logic/dates.ts";
import type {
  AgentRun,
  BillOfMaterials,
  Consumption,
  Finding,
  Lot,
  Material,
  MaterialSupplier,
  Message,
  Mission,
  Product,
  PurchaseOrder,
  Quote,
  RFQ,
  Site,
  Supplier,
} from "../types.ts";
import {
  ADJUVANT_RFQ_REASON,
  CLASS_RULES,
  MATERIALS,
  PRODUCTS,
  SEED,
  SEED_TODAY,
  SITE_CODE,
  SITES,
  SUPPLIERS,
  quoteCurrency,
  supplierId,
  type CatalogMaterial,
  type SiteId,
  type SupKey,
} from "./catalog.ts";
import { Rng } from "./prng.ts";
import { DEFAULT_FX_TO_USD } from "../logic/quotes.ts";
import type { Incoterm } from "../types.ts";

export interface SeedData {
  today: string;
  sites: Site[];
  products: Product[];
  boms: BillOfMaterials[];
  materials: Material[];
  suppliers: Supplier[];
  material_suppliers: MaterialSupplier[];
  lots: Lot[];
  consumption: Consumption[];
  rfqs: RFQ[];
  quotes: Quote[];
  purchase_orders: PurchaseOrder[];
  missions: Mission[];
  agent_runs: AgentRun[];
  messages: Message[];
  findings: Finding[];
}

/** Planning overrides for scenario material/site pairs. */
interface Scenario {
  daily: number;
  lead: number;
  safety: number;
  lots: Array<{ qty: number; status: Lot["status"]; expiresInDays: number }>;
}

const key = (m: string, s: string) => `${m}|${s}`;

export const HERO = { material_id: "MAT-SUC-INJ", site_id: "SITE-GHE" } as const;

const SCENARIOS: Record<string, Scenario> = {
  // 1. hero
  [key("MAT-SUC-INJ", "SITE-GHE")]: {
    daily: 5,
    lead: 42,
    safety: 14,
    lots: [
      { qty: 80, status: "released", expiresInDays: 610 },
      { qty: 40, status: "released", expiresInDays: 820 },
      { qty: 30, status: "quarantined", expiresInDays: 1060 },
    ],
  },
  // 2. adjuvant shortage at Ghent: 180 g released, 6 g/day -> 30 d cover vs 210 d lead
  [key("MAT-SAP-QS", "SITE-GHE")]: {
    daily: 6,
    lead: 210,
    safety: 60,
    lots: [{ qty: 180, status: "released", expiresInDays: 300 }],
  },
  [key("MAT-SAP-QS", "SITE-LYO")]: {
    daily: 2,
    lead: 210,
    safety: 60,
    lots: [
      { qty: 420, status: "released", expiresInDays: 420 },
      { qty: 120, status: "quarantined", expiresInDays: 600 },
    ],
  },
  // 3. transfer: Cork holds near-expiry parenteral mannitol from a cancelled campaign
  [key("MAT-MAN-PAR", "SITE-COR")]: {
    daily: 2,
    lead: 35,
    safety: 14,
    lots: [
      { qty: 1000, status: "released", expiresInDays: 120 },
      { qty: 600, status: "released", expiresInDays: 120 },
    ],
  },
  // ...while Raleigh is short: 90 kg released, 8 kg/day, ROP 392 kg
  [key("MAT-MAN-PAR", "SITE-RAL")]: {
    daily: 8,
    lead: 35,
    safety: 14,
    lots: [
      { qty: 60, status: "released", expiresInDays: 700 },
      { qty: 30, status: "released", expiresInDays: 760 },
      { qty: 50, status: "quarantined", expiresInDays: 1000 },
    ],
  },
};

/** Explicit supplier links for scenario materials (otherwise generated from the pool). */
type LinkSpec = Partial<MaterialSupplier> & { sup: SupKey; qualification_state: MaterialSupplier["qualification_state"] };
const EXPLICIT_LINKS: Record<string, LinkSpec[]> = {
  "MAT-SUC-INJ": [
    { sup: "BRW", qualification_state: "released_for_use", lead_time_days: 42, price_low: 14, price_high: 22, dmf: true, cep: true, otd_pct: 96, lead_time_variance_days: 3, rejection_rate: 0.004, biosecure_review: "cleared" },
    { sup: "HAL", qualification_state: "released_for_use", lead_time_days: 35, price_low: 16, price_high: 26, dmf: false, cep: true, otd_pct: 92, lead_time_variance_days: 5, rejection_rate: 0.008, biosecure_review: "cleared" },
    { sup: "COR", qualification_state: "quality_approved", lead_time_days: 28, price_low: 19, price_high: 30, dmf: false, cep: false, otd_pct: 89, lead_time_variance_days: 6, rejection_rate: 0.01, biosecure_review: "cleared" },
    { sup: "QIN", qualification_state: "quality_approved", lead_time_days: 49, price_low: 9, price_high: 15, dmf: true, cep: false, otd_pct: 84, lead_time_variance_days: 9, rejection_rate: 0.015, biosecure_review: "cleared" },
  ],
  "MAT-PS80-SR": [
    { sup: "RVS", qualification_state: "released_for_use", lead_time_days: 70, price_low: 420, price_high: 760, dmf: true, cep: true, otd_pct: 95, lead_time_variance_days: 4, rejection_rate: 0.005, biosecure_review: "cleared" },
    { sup: "ALT", qualification_state: "quality_approved", lead_time_days: 84, price_low: 380, price_high: 690, dmf: false, cep: true, otd_pct: 90, lead_time_variance_days: 7, rejection_rate: 0.009, biosecure_review: "cleared" },
    { sup: "HAL", qualification_state: "released_for_use", lead_time_days: 63, price_low: 450, price_high: 820, dmf: true, cep: false, otd_pct: 93, lead_time_variance_days: 5, rejection_rate: 0.006, biosecure_review: "cleared" },
    { sup: "COR", qualification_state: "quality_approved", lead_time_days: 56, price_low: 520, price_high: 900, dmf: false, cep: false, otd_pct: 88, lead_time_variance_days: 8, rejection_rate: 0.012, biosecure_review: "cleared" },
  ],
  "MAT-SAP-QS": [
    { sup: "VEL", qualification_state: "released_for_use", lead_time_days: 210, price_low: null, price_high: null, rfq_reason: ADJUVANT_RFQ_REASON, dmf: true, cep: false, otd_pct: 81, lead_time_variance_days: 21, rejection_rate: 0.01, biosecure_review: "cleared" },
  ],
  "MAT-SAP-AN": [
    { sup: "ALT", qualification_state: "technically_suitable", supply_stage: "development", approved_grade: "development / research grade", lead_time_days: null, price_low: null, price_high: null, rfq_reason: "Development-stage analogue: not the licensed material; no commercial price.", dmf: false, cep: false, otd_pct: null, lead_time_variance_days: null, rejection_rate: null, biosecure_review: "not_screened" },
  ],
  "MAT-MPL": [
    { sup: "ORI", qualification_state: "released_for_use", lead_time_days: 180, price_low: null, price_high: null, rfq_reason: ADJUVANT_RFQ_REASON, dmf: true, cep: false, otd_pct: 90, lead_time_variance_days: 12, rejection_rate: 0.008, biosecure_review: "cleared" },
  ],
  "MAT-UMEC": [
    { sup: "DEC", qualification_state: "released_for_use", lead_time_days: 120, price_low: 3200, price_high: 4600, dmf: true, cep: false, otd_pct: 91, lead_time_variance_days: 9, rejection_rate: 0.01, biosecure_review: "cleared" },
    { sup: "MON", qualification_state: "technically_suitable", supply_stage: "development", approved_grade: "DEV / tech pack", lead_time_days: null, price_low: null, price_high: null, rfq_reason: "Development / tech-pack listing: commercial readiness not established.", dmf: false, cep: false, otd_pct: null, lead_time_variance_days: null, rejection_rate: null, biosecure_review: "cleared" },
  ],
  "MAT-VIL": [
    { sup: "MON", qualification_state: "released_for_use", lead_time_days: 112, price_low: 3400, price_high: 4900, dmf: false, cep: false, otd_pct: 93, lead_time_variance_days: 6, rejection_rate: 0.006, biosecure_review: "cleared" },
    { sup: "DEC", qualification_state: "quality_approved", lead_time_days: 140, price_low: 3000, price_high: 4400, dmf: true, cep: false, otd_pct: 88, lead_time_variance_days: 11, rejection_rate: 0.012, biosecure_review: "cleared" },
  ],
  "MAT-FF": [
    { sup: "MON", qualification_state: "released_for_use", lead_time_days: 98, price_low: 3600, price_high: 5000, dmf: true, cep: false, otd_pct: 94, lead_time_variance_days: 5, rejection_rate: 0.005, biosecure_review: "cleared" },
    { sup: "DEC", qualification_state: "quality_approved", lead_time_days: 126, price_low: 3100, price_high: 4500, dmf: true, cep: false, otd_pct: 89, lead_time_variance_days: 10, rejection_rate: 0.011, biosecure_review: "cleared" },
  ],
};

/** BIOSECURE demo: an entity flagged at legal-entity level (not by country), linked as a non-approved option. */
const FLAGGED_LINKS: Array<{ material: string; sup: SupKey }> = [
  { material: "MAT-6APA", sup: "HAR" },
  { material: "MAT-AMOX", sup: "HAR" },
];

function qtyRound(unit: Material["unit"], q: number): number {
  if (unit === "ea" || unit === "g") return Math.max(0, Math.round(q));
  if (q < 10) return round(q, 2);
  return round(q, 1);
}

function moneyRound(v: number): number {
  return v < 5 ? round(v, 3) : round(v, 2);
}

export function generateSeed(seed = SEED, today = SEED_TODAY): SeedData {
  const rng = new Rng(seed);

  const sites: Site[] = SITES.map((s) => ({ ...s, capacity_status: "operating" }));

  const suppliers: Supplier[] = SUPPLIERS.map((s) => ({
    external_id: supplierId(s.key),
    name: s.name,
    country: s.country,
    manufacturing_country: s.manufacturing_country ?? s.country,
    website: `https://${s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.example`,
    type: s.type,
  }));

  const materials: Material[] = MATERIALS.map((m) => ({
    external_id: m.id,
    name: m.name,
    substance: m.substance,
    material_class: m.cls,
    grade: m.grade,
    compendia: m.compendia,
    salt_form: m.salt ?? null,
    endotoxin_class: m.endo ?? null,
    sourcing_mode: m.mode,
    unit: m.unit,
    shelf_life_days: m.shelf,
    storage: m.storage,
  }));

  const products: Product[] = PRODUCTS.map((p) => ({
    external_id: p.external_id,
    name: p.name,
    modality: p.modality,
    site_ids: p.site_ids,
  }));

  const matById = new Map(MATERIALS.map((m) => [m.id, m]));
  const boms: BillOfMaterials[] = PRODUCTS.map((p) => ({
    external_id: `BOM-${p.external_id}`,
    product_id: p.external_id,
    name: `${p.external_id} commercial batch`,
    line_items: p.bom.map((mid) => {
      const m = matById.get(mid) as CatalogMaterial;
      const perBatch = ((m.daily[0] + m.daily[1]) / 2) * rng.float(3, 8);
      return { material_external_id: mid, qty_per_batch: qtyRound(m.unit, perBatch), unit: m.unit };
    }),
  }));

  // ---- material-supplier links ----
  const material_suppliers: MaterialSupplier[] = [];
  let msSeq = 0;
  const nextMsId = () => `MS-${String(++msSeq).padStart(4, "0")}`;

  for (const m of MATERIALS) {
    const rules = CLASS_RULES[m.cls];
    const basis = `USD/${m.unit}`;
    const explicit = EXPLICIT_LINKS[m.id];
    if (explicit) {
      for (const l of explicit) {
        const { sup, ...rest } = l;
        material_suppliers.push({
          external_id: nextMsId(),
          material_id: m.id,
          supplier_id: supplierId(sup),
          supply_stage: "commercial",
          approved_grade: m.grade,
          moq: qtyRound(m.unit, rng.float(rules.moq[0], rules.moq[1])),
          price_basis: basis,
          rfq_reason: null,
          lead_time_days: null,
          price_low: null,
          price_high: null,
          dmf: false,
          cep: false,
          otd_pct: null,
          lead_time_variance_days: null,
          rejection_rate: null,
          biosecure_review: "cleared",
          ...rest,
        });
      }
      continue;
    }
    if (m.pool.length === 0) continue;
    const nApproved = Math.min(m.pool.length, rng.int(rules.approved[0], rules.approved[1]));
    m.pool.forEach((sup, i) => {
      const approved = i < nApproved;
      const state: MaterialSupplier["qualification_state"] = !approved
        ? "technically_suitable"
        : i === 0 || rng.chance(0.55)
          ? "released_for_use"
          : "quality_approved";
      if (!approved && !rng.chance(0.15)) return; // only some extra pool members become technical candidates
      const lead = rng.int(rules.leadDays[0], rules.leadDays[1]);
      let low: number | null = null;
      let high: number | null = null;
      if (m.band) {
        const span = m.band[1] - m.band[0];
        low = moneyRound(m.band[0] + span * rng.float(0, 0.45));
        high = moneyRound(Math.min(m.band[1], low + span * rng.float(0.25, 0.55)));
      }
      const isEu = ["DE", "FR", "ES", "IT", "BE", "NL", "IE", "PT", "CZ", "SE", "NO", "GB", "CH"].includes(
        SUPPLIERS.find((s) => s.key === sup)?.country ?? "",
      );
      material_suppliers.push({
        external_id: nextMsId(),
        material_id: m.id,
        supplier_id: supplierId(sup),
        qualification_state: state,
        supply_stage: "commercial",
        approved_grade: approved ? m.grade : null,
        lead_time_days: lead,
        moq: qtyRound(m.unit, rng.float(rules.moq[0], rules.moq[1])),
        price_low: low,
        price_high: high,
        price_basis: basis,
        rfq_reason: m.band ? null : ADJUVANT_RFQ_REASON,
        dmf: m.cls === "small_molecule_api" || m.cls === "compendial_excipient" ? rng.chance(0.6) : rng.chance(0.25),
        cep: (m.cls === "small_molecule_api" || m.cls === "compendial_excipient") && isEu ? rng.chance(0.5) : false,
        otd_pct: approved ? round(rng.float(82, 99), 1) : null,
        lead_time_variance_days: approved ? round(rng.float(1, 15), 1) : null,
        rejection_rate: approved ? round(rng.float(0, 0.035), 3) : null,
        biosecure_review: approved ? "cleared" : rng.chance(0.5) ? "cleared" : "not_screened",
      });
    });
  }
  for (const f of FLAGGED_LINKS) {
    const m = matById.get(f.material) as CatalogMaterial;
    material_suppliers.push({
      external_id: nextMsId(),
      material_id: m.id,
      supplier_id: supplierId(f.sup),
      qualification_state: "discovery_candidate",
      supply_stage: "commercial",
      approved_grade: null,
      lead_time_days: rng.int(28, 56),
      moq: qtyRound(m.unit, rng.float(100, 500)),
      price_low: m.band ? moneyRound(m.band[0] * 0.7) : null,
      price_high: m.band ? moneyRound(m.band[0] * 0.95) : null,
      price_basis: `USD/${m.unit}`,
      rfq_reason: null,
      dmf: false,
      cep: false,
      otd_pct: null,
      lead_time_variance_days: null,
      rejection_rate: null,
      biosecure_review: "flagged",
    });
  }

  const linksFor = (mid: string) => material_suppliers.filter((l) => l.material_id === mid);
  const approvedFor = (mid: string) =>
    linksFor(mid).filter((l) => l.qualification_state === "released_for_use" || l.qualification_state === "quality_approved");

  // ---- consumption + lots ----
  const consumption: Consumption[] = [];
  const lots: Lot[] = [];
  const lotSeq: Record<string, number> = {};
  const nextLotId = (site: SiteId) => {
    const code = SITE_CODE[site];
    lotSeq[code] = (lotSeq[code] ?? 0) + 1;
    return `LOT-${code}-${String(lotSeq[code]).padStart(4, "0")}`;
  };

  for (const m of MATERIALS) {
    const rules = CLASS_RULES[m.cls];
    const approved = approvedFor(m.id);
    const primary = approved[0];
    for (const site of m.sites) {
      const sc = SCENARIOS[key(m.id, site)];
      const daily = sc ? sc.daily : qtyRoundRate(rng.float(m.daily[0], m.daily[1]));
      const lead = sc ? sc.lead : (primary?.lead_time_days ?? rng.int(rules.leadDays[0], rules.leadDays[1]));
      const safety = sc ? sc.safety : rules.safetyDays;
      consumption.push({ material_id: m.id, site_id: site, daily_rate: daily, lead_time_days: lead, safety_days: safety });

      const costFor = (supId: string | null): number | null => {
        const l = approved.find((a) => a.supplier_id === supId);
        if (!l || l.price_low == null || l.price_high == null) return null;
        return moneyRound(rng.float(l.price_low, l.price_high));
      };

      if (sc) {
        for (const lot of sc.lots) {
          const supId = primary?.supplier_id ?? null;
          lots.push({
            external_id: nextLotId(site),
            material_id: m.id,
            site_id: site,
            supplier_id: supId,
            qty: lot.qty,
            status: lot.status,
            expiry_date: addDays(today, lot.expiresInDays),
            received_at: addDays(today, lot.expiresInDays - m.shelf),
            unit_cost: costFor(supId),
          });
        }
        continue;
      }

      // Mostly healthy, ~15% at watch level (between lead and lead+safety). No random "action" breaches,
      // so the scenario alerts stand out.
      const coverTarget = rng.chance(0.15) ? rng.float(lead + 1, lead + safety) : rng.float(lead + safety + 10, lead + safety + 150);
      const releasedTotal = daily * coverTarget;
      const nReleased = rng.int(3, 4);
      const weights = Array.from({ length: nReleased }, () => rng.float(0.5, 1.5));
      const wSum = weights.reduce((a, b) => a + b, 0);
      for (const w of weights) {
        const supId = approved.length ? rng.pick(approved).supplier_id : null;
        const ageDays = rng.int(5, Math.min(Math.floor(m.shelf * 0.85), 420));
        lots.push({
          external_id: nextLotId(site),
          material_id: m.id,
          site_id: site,
          supplier_id: supId,
          qty: qtyRound(m.unit, (releasedTotal * w) / wSum),
          status: "released",
          expiry_date: addDays(today, m.shelf - ageDays),
          received_at: addDays(today, -ageDays),
          unit_cost: costFor(supId),
        });
      }
      const extra: Array<Lot["status"]> = [];
      if (rng.chance(0.45)) extra.push("quarantined");
      if (rng.chance(0.08)) extra.push("rejected");
      for (const status of extra) {
        const supId = approved.length ? rng.pick(approved).supplier_id : null;
        const ageDays = rng.int(1, 30);
        lots.push({
          external_id: nextLotId(site),
          material_id: m.id,
          site_id: site,
          supplier_id: supId,
          qty: qtyRound(m.unit, releasedTotal * rng.float(0.08, 0.3)),
          status,
          expiry_date: addDays(today, m.shelf - ageDays),
          received_at: addDays(today, -ageDays),
          unit_cost: costFor(supId),
        });
      }
    }
  }

  // ---- historical RFQs (RFQ-001..RFQ-101) and simulated quotes; the next RFQ is RFQ-102 ----
  const rfqs: RFQ[] = [];
  const quotes: Quote[] = [];
  const scenarioKeys = new Set(Object.keys(SCENARIOS));
  const pairs = consumption.filter((c) => approvedFor(c.material_id).length > 0);
  const ages = Array.from({ length: 101 }, () => rng.int(3, 360)).sort((a, b) => b - a);
  const incoterms: Incoterm[] = ["EXW", "FCA", "CIP", "DAP", "DDP"];
  let qSeq = 0;

  ages.forEach((age, i) => {
    const created = addDays(today, -age);
    let pair = rng.pick(pairs);
    let status: RFQ["status"];
    if (age <= 14) {
      // open RFQs never touch the scenario pairs (the agent opens those live)
      while (scenarioKeys.has(key(pair.material_id, pair.site_id))) pair = rng.pick(pairs);
      status = rng.chance(0.5) ? "quoted" : "sent";
    } else {
      const r = rng.float();
      status = r < 0.55 ? "approved" : r < 0.8 ? "expired" : "rejected";
    }
    const m = matById.get(pair.material_id) as CatalogMaterial;
    const lead = pair.lead_time_days ?? 60;
    const rfqId = `RFQ-${String(i + 1).padStart(3, "0")}`;
    const qty = qtyRound(m.unit, pair.daily_rate * rng.int(30, 90));
    rfqs.push({
      external_id: rfqId,
      material_id: pair.material_id,
      site_id: pair.site_id,
      qty,
      need_by: addDays(created, lead + 7),
      status,
      mission_id: null,
      created_at: `${created}T09:00:00.000Z`,
    });
    if (status === "sent") return;
    const candidates = rng.shuffle(approvedFor(pair.material_id));
    const nQuotes = Math.min(candidates.length, rng.int(2, 3));
    for (const link of candidates.slice(0, nQuotes)) {
      const sup = suppliers.find((s) => s.external_id === link.supplier_id) as Supplier;
      const currency = quoteCurrency(sup.country);
      const fx = DEFAULT_FX_TO_USD[currency];
      const priced = link.price_low != null && link.price_high != null;
      const usd = priced ? rng.float(link.price_low as number, link.price_high as number) : null;
      const unitPrice = usd == null ? null : moneyRound(usd / fx);
      const goodsUsd = (usd ?? 0) * qty;
      quotes.push({
        external_id: `Q-${String(++qSeq).padStart(4, "0")}`,
        rfq_id: rfqId,
        supplier_id: link.supplier_id,
        unit_price: unitPrice,
        currency,
        incoterm: rng.pick(incoterms),
        freight: round((goodsUsd * rng.float(0.01, 0.05) + rng.float(150, 900)) / fx, 2),
        testing_cost: round(rng.float(400, 2500) / fx, 2),
        qty,
        lead_time_days: Math.max(7, (link.lead_time_days ?? lead) + rng.int(-7, 10)),
        valid_until: addDays(created, rng.int(21, 45)),
        simulated: true,
        rfq_reason: priced ? null : (link.rfq_reason ?? ADJUVANT_RFQ_REASON),
        received_at: `${addDays(created, rng.int(1, 6))}T14:00:00.000Z`,
      });
    }
  });

  return {
    today,
    sites,
    products,
    boms,
    materials,
    suppliers,
    material_suppliers,
    lots,
    consumption,
    rfqs,
    quotes,
    purchase_orders: [],
    missions: [],
    agent_runs: [],
    messages: [],
    findings: [],
  };
}

function qtyRoundRate(v: number): number {
  if (v >= 1000) return Math.round(v);
  if (v >= 10) return round(v, 1);
  if (v >= 0.1) return round(v, 2);
  return round(v, 4);
}
