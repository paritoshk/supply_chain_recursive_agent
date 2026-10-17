/** Read-only data tools over the store. Every number comes from logic/, never from a model. */
import { z } from "zod";
import {
  addDays,
  diffDays,
  haversineKm,
  isApproved,
  normalizeQuote,
  priceInventory,
  projectCover,
  round,
  specPrefilter,
  supplierScore,
} from "../logic/index.ts";
import type { Store } from "../store.ts";
import type { Citation, InventoryItem, MaterialSupplier, Part } from "../types.ts";
import { defineTool, type ToolResult } from "./contract.ts";
import { filteredPairs, positionFor, type Position } from "./position.ts";

const SITE_CODE = (siteId: string) => siteId.replace(/^SITE-/, "");

function toInventoryItem(store: Store, p: Position): InventoryItem {
  const m = store.material(p.material_id);
  return {
    external_id: `INV-${SITE_CODE(p.site_id)}-${p.material_id}`,
    sku: p.material_id,
    name: m?.name ?? p.material_id,
    quantity_on_hand: p.released_qty,
    reorder_point: p.reorder_point ?? 0,
    lead_time_days: p.lead_time_days,
    unit: p.unit,
    unit_cost: p.unit_cost,
    warehouse_location: p.site_id,
    last_restock_at: p.last_restock_at,
    attributes: {
      site_id: p.site_id,
      material_class: m?.material_class,
      quarantined_qty: p.quarantined_qty,
      cover_days: p.cover_days,
      safety_stock: p.safety_stock,
      daily_rate: p.daily_rate,
      severity: p.severity,
    },
  };
}

function positionCitation(p: Position, excerpt?: string): Citation {
  return {
    source: "inventory",
    ids: [p.material_id, p.site_id, ...p.lot_ids],
    ...(excerpt ? { excerpt } : {}),
  };
}

function ok(source: string, citations: Citation[], body: Record<string, unknown>): ToolResult {
  return { ingestion_status: "ok", source, citations, ...body };
}

function notFound(source: string, what: string): ToolResult {
  return { ingestion_status: "not_ingested", source, citations: [], error: `${what} not found` };
}

function scoredLink(store: Store, l: MaterialSupplier) {
  const s = store.supplier(l.supplier_id);
  const score = supplierScore(l);
  return {
    material_supplier_id: l.external_id,
    supplier_id: l.supplier_id,
    supplier_name: s?.name ?? l.supplier_id,
    supplier_type: s?.type,
    country: s?.country,
    manufacturing_country: s?.manufacturing_country ?? null,
    qualification_state: l.qualification_state,
    supply_stage: l.supply_stage,
    approved_grade: l.approved_grade,
    lead_time_days: l.lead_time_days,
    price_low: l.price_low,
    price_high: l.price_high,
    price_basis: l.price_basis,
    rfq_reason: l.rfq_reason ?? null,
    dmf: l.dmf,
    cep: l.cep,
    biosecure_review: l.biosecure_review,
    score: score.score,
    blocked: score.blocked,
    score_reasons: score.reasons,
  };
}

// ---------------------------------------------------------------------------

export const lowStockItems = defineTool({
  name: "low_stock_items",
  description:
    "List material/site positions at or below their reorder point (released stock only), worst cover first. Respects dashboard filters.",
  idempotent: true,
  inputSchema: z.object({
    include_watch: z.boolean().default(true),
    limit: z.number().int().positive().max(200).default(25),
  }),
  async run(ctx, args) {
    const positions = filteredPairs(ctx.store, ctx.filters)
      .map((c) => positionFor(ctx.store, c.material_id, c.site_id))
      .filter((p) => p.severity === "action" || (args.include_watch && p.severity === "watch"))
      .sort((a, b) => (a.cover_days ?? Infinity) - (b.cover_days ?? Infinity))
      .slice(0, args.limit);
    return ok(
      "inventory",
      positions.map((p) =>
        positionCitation(p, `${p.material_id} @ ${p.site_id}: ${p.released_qty} ${p.unit} released, ${p.cover_days} d cover, ROP ${p.reorder_point}`),
      ),
      { today: ctx.store.today(), items: positions.map((p) => toInventoryItem(ctx.store, p)) },
    );
  },
});

export const lookupParts = defineTool({
  name: "lookup_parts",
  description: "Search the material master by name, substance or external_id. Returns host-platform Part records plus material spec.",
  idempotent: true,
  inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().positive().max(50).default(10) }),
  async run(ctx, args) {
    const q = args.query.toLowerCase();
    const hits = ctx.store
      .materials()
      .filter((m) => [m.external_id, m.name, m.substance].some((s) => s.toLowerCase().includes(q)))
      .filter((m) => !ctx.filters.material_class || m.material_class === ctx.filters.material_class)
      .slice(0, args.limit);
    const results = hits.map((m) => {
      const primary = ctx.store.materialSuppliers({ material_id: m.external_id }).find((l) => l.qualification_state === "released_for_use");
      const part: Part = {
        mpn: m.external_id,
        manufacturer: primary ? (ctx.store.supplier(primary.supplier_id)?.name ?? null) : null,
        category: m.material_class,
      };
      return { part, material: m, sites: ctx.store.consumption({ material_id: m.external_id }).map((c) => c.site_id) };
    });
    return ok("materials", hits.length ? [{ source: "materials", ids: hits.map((m) => m.external_id) }] : [], {
      results,
    });
  },
});

export const inventoryValueSummary = defineTool({
  name: "inventory_value_summary",
  description: "Value released stock (qty x lot unit cost) grouped by site, region or material class. Unpriced lots are counted, never estimated.",
  idempotent: true,
  inputSchema: z.object({ group_by: z.enum(["site", "region", "material_class"]).default("site") }),
  async run(ctx, args) {
    const pairs = filteredPairs(ctx.store, ctx.filters);
    const groups = new Map<string, { value_usd: number; lot_ids: string[]; unvalued_lot_ids: string[]; quarantined_value_usd: number }>();
    for (const c of pairs) {
      const site = ctx.store.site(c.site_id);
      const mat = ctx.store.material(c.material_id);
      const k = args.group_by === "site" ? c.site_id : args.group_by === "region" ? (site?.region ?? "?") : (mat?.material_class ?? "?");
      const g = groups.get(k) ?? { value_usd: 0, lot_ids: [], unvalued_lot_ids: [], quarantined_value_usd: 0 };
      for (const lot of ctx.store.lots({ material_id: c.material_id, site_id: c.site_id })) {
        if (lot.qty <= 0 || lot.status === "rejected") continue;
        if (ctx.filters.lot_status && lot.status !== ctx.filters.lot_status) continue;
        if (ctx.filters.expiring_within_days && diffDays(ctx.store.today(), lot.expiry_date) > ctx.filters.expiring_within_days) continue;
        g.lot_ids.push(lot.external_id);
        if (lot.unit_cost == null) g.unvalued_lot_ids.push(lot.external_id);
        else if (lot.status === "released") g.value_usd += lot.qty * lot.unit_cost;
        else g.quarantined_value_usd += lot.qty * lot.unit_cost;
      }
      groups.set(k, g);
    }
    const rows = [...groups.entries()]
      .map(([group, g]) => ({
        group,
        released_value_usd: round(g.value_usd, 2),
        quarantined_value_usd: round(g.quarantined_value_usd, 2),
        lot_count: g.lot_ids.length,
        unvalued_lot_count: g.unvalued_lot_ids.length,
      }))
      .sort((a, b) => b.released_value_usd - a.released_value_usd);
    return ok(
      "inventory",
      [...groups.entries()].map(([group, g]) => ({ source: "inventory", ids: g.lot_ids, excerpt: `group ${group}` })),
      {
        group_by: args.group_by,
        rows,
        total_released_value_usd: round(rows.reduce((s, r) => s + r.released_value_usd, 0), 2),
        note: "Unvalued lots (e.g. quote-only adjuvants) are excluded from value and counted separately.",
      },
    );
  },
});

export const coverProjection = defineTool({
  name: "cover_projection",
  description:
    "Days of cover, reorder point, safety stock, stockout and ROP-breach dates and expiry risk for one material at one site. Only released stock counts.",
  idempotent: true,
  inputSchema: z.object({
    material_id: z.string(),
    site_id: z.string(),
    horizon_days: z.number().int().positive().max(365).default(90),
  }),
  async run(ctx, args) {
    if (!ctx.store.material(args.material_id)) return notFound("inventory", args.material_id);
    if (!ctx.store.consumptionFor(args.material_id, args.site_id)) return notFound("inventory", `${args.material_id} @ ${args.site_id}`);
    const p = positionFor(ctx.store, args.material_id, args.site_id);
    const today = ctx.store.today();
    const stockout = p.cover_days == null ? null : addDays(today, Math.floor(p.cover_days));
    const ropBreach =
      p.reorder_point == null || p.daily_rate <= 0
        ? null
        : p.released_qty <= p.reorder_point
          ? today
          : addDays(today, Math.floor((p.released_qty - p.reorder_point) / p.daily_rate));
    const series = projectCover(p.released_qty, p.daily_rate, args.horizon_days)
      .filter((pt) => pt.day % 7 === 0 || pt.day === args.horizon_days)
      .map((pt) => ({ ...pt, date: addDays(today, pt.day), released_qty: round(pt.released_qty, 2) }));
    return ok(
      "inventory",
      [positionCitation(p, `released ${p.released_qty} ${p.unit}; quarantined ${p.quarantined_qty} ${p.unit} excluded`)],
      {
        today,
        position: p,
        stockout_date: stockout,
        rop_breach_date: ropBreach,
        reorder_needed: p.reorder_point != null && p.released_qty <= p.reorder_point,
        series,
        method: "cover = released / daily; ROP = daily x (lead + safety); safety stock = daily x safety days",
      },
    );
  },
});

export const findSuppliers = defineTool({
  name: "find_suppliers",
  description:
    "Approved suppliers (quality_approved / released_for_use) for a material, ranked by supplier score. Optionally lists non-approved candidates in a separate lane.",
  idempotent: true,
  inputSchema: z.object({
    material_id: z.string(),
    include_candidates: z.boolean().default(false),
    require_cep: z.boolean().default(false),
    require_dmf: z.boolean().default(false),
  }),
  async run(ctx, args) {
    if (!ctx.store.material(args.material_id)) return notFound("approved_suppliers", args.material_id);
    const links = ctx.store
      .materialSuppliers({ material_id: args.material_id })
      .filter((l) => (!args.require_cep || l.cep) && (!args.require_dmf || l.dmf));
    const approved = links
      .filter((l) => isApproved(l.qualification_state))
      .map((l) => scoredLink(ctx.store, l))
      .sort((a, b) => b.score - a.score);
    const candidates = args.include_candidates
      ? links.filter((l) => !isApproved(l.qualification_state)).map((l) => ({ ...scoredLink(ctx.store, l), label: "candidate (not approved)" }))
      : [];
    return ok(
      "approved_suppliers",
      [{ source: "approved_suppliers", ids: [args.material_id, ...[...approved, ...candidates].map((a) => a.material_supplier_id)] }],
      {
        material_id: args.material_id,
        approved,
        candidates,
        approved_count: approved.length,
        note: "Candidates are not approved. A quote never implies approval; qualification states cannot be skipped.",
      },
    );
  },
});

export const matchSpec = defineTool({
  name: "match_spec",
  description:
    "Deterministic spec pre-filter (substance, salt/hydrate form, grade, compendia, endotoxin class, sourcing mode) of candidate materials against a required material. Model confidence is added by the matcher agent afterwards.",
  idempotent: true,
  inputSchema: z.object({ material_id: z.string(), candidate_ids: z.array(z.string()).optional() }),
  async run(ctx, args) {
    const required = ctx.store.material(args.material_id);
    if (!required) return notFound("materials", args.material_id);
    const candidates = args.candidate_ids
      ? args.candidate_ids.map((id) => ctx.store.material(id)).filter((m) => m != null)
      : ctx.store.materials().filter((m) => m.external_id !== required.external_id && m.substance.toLowerCase() === required.substance.toLowerCase());
    const results = candidates.map((c) => ({ candidate_id: c.external_id, name: c.name, grade: c.grade, ...specPrefilter(required, c) }));
    return ok("materials", [{ source: "materials", ids: [required.external_id, ...candidates.map((c) => c.external_id)] }], {
      required: { external_id: required.external_id, name: required.name, sourcing_mode: required.sourcing_mode },
      results,
      equivalent_ids: results.filter((r) => r.match === "exact").map((r) => r.candidate_id),
      note:
        required.sourcing_mode === "access_led"
          ? "Access-led material: analogues and alternate molecules are never substitutes; open a qualification task instead."
          : null,
    });
  },
});

export const compareQuotes = defineTool({
  name: "compare_quotes",
  description:
    "Normalize all quotes on an RFQ to landed USD per unit (FX, Incoterm adder, freight, testing) and rank them. Unpriced quotes stay null with their RFQ reason. Quotes are simulated supplier responses.",
  idempotent: true,
  inputSchema: z.object({ rfq_id: z.string() }),
  async run(ctx, args) {
    const rfq = ctx.store.rfq(args.rfq_id);
    if (!rfq) return notFound("quotes", args.rfq_id);
    const links = ctx.store.materialSuppliers({ material_id: rfq.material_id });
    const rows = ctx.store.quotes(rfq.external_id).map((q) => {
      const n = normalizeQuote(q);
      const link = links.find((l) => l.supplier_id === q.supplier_id);
      return {
        ...n,
        supplier_name: ctx.store.supplier(q.supplier_id)?.name ?? q.supplier_id,
        unit_price: q.unit_price,
        currency: q.currency,
        incoterm: q.incoterm,
        lead_time_days: q.lead_time_days,
        valid_until: q.valid_until,
        expired: q.valid_until < ctx.store.today(),
        qualification_state: link?.qualification_state ?? "discovery_candidate",
        supplier_score: link ? supplierScore(link).score : null,
        blocked: link ? supplierScore(link).blocked : false,
        label: "simulated supplier response",
      };
    });
    const comparable = rows
      .filter((r) => r.comparable && !r.blocked && isApproved(r.qualification_state))
      .sort((a, b) => (a.landed_usd_per_unit as number) - (b.landed_usd_per_unit as number));
    const best = comparable[0] ?? null;
    return ok("quotes", [{ source: "quotes", ids: [rfq.external_id, ...rows.map((r) => r.quote_id ?? "")].filter(Boolean) }], {
      rfq,
      quotes: rows.sort((a, b) => (a.landed_usd_per_unit ?? Infinity) - (b.landed_usd_per_unit ?? Infinity)),
      best_quote_id: best?.quote_id ?? null,
      quotes_received: rows.length,
      comparable_count: comparable.length,
      unpriced: rows.filter((r) => !r.comparable).map((r) => ({ quote_id: r.quote_id, reason: r.reason })),
    });
  },
});

function sisterDemand(store: Store, materialId: string, exceptSite: string) {
  return store
    .consumption({ material_id: materialId })
    .filter((c) => c.site_id !== exceptSite)
    .map((c) => positionFor(store, materialId, c.site_id))
    .filter((p) => p.reorder_point != null && p.released_qty < p.reorder_point)
    .map((p) => ({ site_id: p.site_id, qty: round((p.reorder_point as number) - p.released_qty, 2), position: p }));
}

function marketBand(store: Store, materialId: string) {
  const priced = store
    .materialSuppliers({ material_id: materialId })
    .filter((l) => isApproved(l.qualification_state) && l.price_low != null && l.price_high != null);
  if (!priced.length) return { band: null, ids: [] as string[] };
  return {
    band: { low: Math.min(...priced.map((l) => l.price_low as number)), high: Math.max(...priced.map((l) => l.price_high as number)) },
    ids: priced.map((l) => l.external_id),
  };
}

export const priceInventoryTool = defineTool({
  name: "price_inventory",
  description:
    "Value released stock of a material at a site and recommend transfer / resell / hold. A transfer to a sister site that needs it is considered before any external sale. Market bands are synthetic.",
  idempotent: true,
  inputSchema: z.object({ material_id: z.string(), site_id: z.string(), grade_factor: z.number().positive().max(1.5).default(1) }),
  async run(ctx, args) {
    const m = ctx.store.material(args.material_id);
    if (!m) return notFound("inventory", args.material_id);
    const p = positionFor(ctx.store, args.material_id, args.site_id);
    if (p.released_qty <= 0) return notFound("inventory", `released stock of ${args.material_id} @ ${args.site_id}`);
    const { band, ids: bandIds } = marketBand(ctx.store, args.material_id);
    const demand = sisterDemand(ctx.store, args.material_id, args.site_id);
    const daysToExpiry = p.earliest_expiry ? diffDays(ctx.store.today(), p.earliest_expiry) : m.shelf_life_days;
    const result = priceInventory({
      qty: p.released_qty,
      band,
      gradeFactor: args.grade_factor,
      daysToExpiry,
      shelfLife: m.shelf_life_days,
      sisterSiteDemand: demand.map((d) => ({ site_id: d.site_id, qty: d.qty })),
    });
    return ok(
      "inventory",
      [
        positionCitation(p),
        ...(bandIds.length ? [{ source: "approved_suppliers", ids: bandIds, excerpt: "synthetic market band" }] : []),
        ...demand.map((d) => positionCitation(d.position, `${d.site_id} below ROP by ${d.qty} ${p.unit}`)),
      ],
      {
        material_id: args.material_id,
        site_id: args.site_id,
        qty: p.released_qty,
        unit: p.unit,
        expiry_at_risk_qty: p.expiry_at_risk_qty,
        days_to_expiry: daysToExpiry,
        band,
        band_label: "synthetic market band",
        sister_site_demand: demand.map((d) => ({ site_id: d.site_id, qty: d.qty })),
        ...result,
      },
    );
  },
});

export const proposeTransfer = defineTool({
  name: "propose_transfer",
  description:
    "Propose (never execute) an inter-site transfer of released stock: from-site keeps its reorder point, to-site is filled up to its reorder point, lots picked FEFO.",
  idempotent: true,
  inputSchema: z.object({
    material_id: z.string(),
    from_site_id: z.string().optional().describe("Donor site. Omit to search every sister site for surplus."),
    to_site_id: z.string().optional().describe("Receiving (short) site."),
  }),
  async run(ctx, rawArgs) {
    let args = rawArgs as { material_id: string; from_site_id: string; to_site_id?: string };
    if (!rawArgs.from_site_id) {
      if (!rawArgs.to_site_id) return notFound("inventory", "give from_site_id or to_site_id");
      // Receiver-side search: the donor with the most released stock above its own reorder point.
      const donors = ctx.store
        .consumption({ material_id: rawArgs.material_id })
        .filter((c) => c.site_id !== rawArgs.to_site_id)
        .map((c) => {
          const p = positionFor(ctx.store, rawArgs.material_id, c.site_id);
          return { site_id: c.site_id, surplus: p.released_qty - (p.reorder_point ?? 0) };
        })
        .filter((d) => d.surplus > 0)
        .sort((a, b) => b.surplus - a.surplus);
      if (!donors[0]) {
        return ok("inventory", [], { proposal: null, reason: "no sister site holds released stock above its own reorder point" });
      }
      args = { material_id: rawArgs.material_id, from_site_id: donors[0].site_id, to_site_id: rawArgs.to_site_id };
    }
    if (!ctx.store.consumptionFor(args.material_id, args.from_site_id)) return notFound("inventory", `${args.material_id} @ ${args.from_site_id}`);
    const from = positionFor(ctx.store, args.material_id, args.from_site_id);
    const demand = sisterDemand(ctx.store, args.material_id, args.from_site_id);
    const target = args.to_site_id ? demand.find((d) => d.site_id === args.to_site_id) : demand.sort((a, b) => b.qty - a.qty)[0];
    const available = Math.max(0, from.released_qty - (from.reorder_point ?? 0));
    if (!target || available <= 0) {
      return ok("inventory", [positionCitation(from)], {
        proposal: null,
        reason: !target ? "no sister site is below its reorder point for this material" : "from-site has no stock above its reorder point",
      });
    }
    const qty = round(Math.min(available, target.qty), 2);
    let remaining = qty;
    const picks: Array<{ lot_id: string; qty: number; expiry_date: string }> = [];
    for (const lot of ctx.store
      .lots({ material_id: args.material_id, site_id: args.from_site_id, status: "released" })
      .filter((l) => l.qty > 0 && l.expiry_date > ctx.store.today())
      .sort((a, b) => a.expiry_date.localeCompare(b.expiry_date))) {
      if (remaining <= 0) break;
      const take = Math.min(lot.qty, remaining);
      picks.push({ lot_id: lot.external_id, qty: round(take, 2), expiry_date: lot.expiry_date });
      remaining -= take;
    }
    const a = ctx.store.site(args.from_site_id);
    const b = ctx.store.site(target.site_id);
    const to = target.position;
    return ok("inventory", [positionCitation(from), positionCitation(to)], {
      proposal: {
        material_id: args.material_id,
        from_site_id: args.from_site_id,
        to_site_id: target.site_id,
        qty,
        unit: from.unit,
        lots: picks,
        distance_km: a && b ? Math.round(haversineKm(a, b)) : null,
        to_site_cover_before_days: to.cover_days,
        to_site_cover_after_days: to.daily_rate > 0 ? round((to.released_qty + qty) / to.daily_rate, 1) : null,
        from_site_expiry_at_risk_qty: from.expiry_at_risk_qty,
        status: "proposed",
        note: "Proposal only. A human approves; quality release at the receiving site still applies.",
      },
    });
  },
});

export const dataTools = [
  lowStockItems,
  lookupParts,
  inventoryValueSummary,
  coverProjection,
  findSuppliers,
  matchSpec,
  compareQuotes,
  priceInventoryTool,
  proposeTransfer,
];
