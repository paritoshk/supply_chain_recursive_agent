/**
 * Learning tools. record_delivery writes a goods-receipt outcome; supplier_reliability reads the learned
 * beliefs and ranks approved suppliers for a need by risk-adjusted cost under the client profile.
 * Learning changes rankings and risk estimates only, never qualification or approval rules.
 */
import { z } from "zod";
import { diffDays, isApproved, round, supplierScore } from "../logic/index.ts";
import { epochDay, reliabilityBelief } from "../logic/learning.ts";
import { CLIENT_PROFILES, CORVANE_PROFILE, evaluateOption, rankOptions } from "../logic/risk.ts";
import type { Citation } from "../types.ts";
import { defineTool, type ToolResult } from "./contract.ts";
import { positionFor } from "./position.ts";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const notFound = (source: string, what: string): ToolResult => ({ ingestion_status: "not_ingested", source, citations: [], error: `${what} not found` });

const beliefView = (b: ReturnType<typeof reliabilityBelief>) => ({
  stated_on_time: b.prior.on_time,
  learned_on_time: b.on_time.mean,
  on_time_90: [b.on_time.lo90, b.on_time.hi90],
  on_time_shift_pp: b.on_time_shift_pp,
  late_days_when_late: b.late_days_mean,
  qc_pass: b.qc_pass.mean,
  deliveries_observed: b.observations,
  qa_review: b.qa_review,
});

export const recordDelivery = defineTool({
  name: "record_delivery",
  description:
    "Record a goods receipt for a supplier: promised vs received date and the incoming QC result. Updates the supplier's learned reliability (on-time rate, lateness, QC pass rate) and returns the belief before and after. Advisory only: never changes qualification state.",
  idempotent: false,
  inputSchema: z.object({
    supplier_id: z.string(),
    material_id: z.string(),
    site_id: z.string(),
    promised_date: isoDate,
    received_date: isoDate,
    qc_passed: z.boolean(),
    po_id: z.string().optional(),
  }),
  async run(ctx, args) {
    const { store } = ctx;
    const link = store.materialSuppliers({ material_id: args.material_id, supplier_id: args.supplier_id })[0];
    if (!link) return notFound("material_suppliers", `${args.supplier_id} for ${args.material_id}`);
    if (!store.site(args.site_id)) return notFound("sites", args.site_id);
    const now = epochDay(store.today());
    const before = reliabilityBelief(link, store.observations(), now);
    const outcome = store.addSupplierOutcome({
      supplier_id: args.supplier_id,
      material_id: args.material_id,
      site_id: args.site_id,
      po_id: args.po_id ?? null,
      promised_date: args.promised_date,
      received_date: args.received_date,
      late_days: Math.max(0, diffDays(args.promised_date, args.received_date)),
      qc_passed: args.qc_passed,
      source: "receipt",
    });
    const after = reliabilityBelief(link, store.observations(), now);
    return {
      ingestion_status: "ok",
      source: "supplier_outcomes",
      citations: [
        { source: "supplier_outcomes", ids: [outcome.id] },
        { source: "material_suppliers", ids: [link.external_id] },
      ],
      outcome,
      before: beliefView(before),
      after: beliefView(after),
      note: after.qa_review
        ? "Reliability is well below the supplier's stated metrics. Raise a QA supplier review; qualification state is unchanged."
        : "Belief updated. Rankings use it from the next decision on.",
    };
  },
});

export const supplierReliability = defineTool({
  name: "supplier_reliability",
  description:
    "Learned reliability of the approved suppliers for a material (stated vs observed on-time rate with a 90% interval, lateness, QC pass rate, deliveries observed), plus past negotiation settlements and lessons from earlier missions. With site_id, ranks the suppliers for this need by risk-adjusted cost under the client profile: P(released in time), expected stockout days, and cost blending the average and worst-10% outcomes. Estimates use list price ranges; final choice uses stored quotes.",
  idempotent: true,
  inputSchema: z.object({
    material_id: z.string(),
    site_id: z.string().optional(),
    qty: z.number().positive().optional(),
    need_by: isoDate.optional(),
    client_profile: z.string().optional().describe(`one of: ${Object.keys(CLIENT_PROFILES).join(", ")} (default corvane)`),
  }),
  async run(ctx, args) {
    const { store } = ctx;
    const material = store.material(args.material_id);
    if (!material) return notFound("materials", args.material_id);
    const profile = CLIENT_PROFILES[args.client_profile ?? "corvane"] ?? CORVANE_PROFILE;
    const links = store.materialSuppliers({ material_id: args.material_id }).filter((l) => isApproved(l.qualification_state) && !supplierScore(l).blocked);
    const now = epochDay(store.today());
    const obs = store.observations();
    const pos = args.site_id ? positionFor(store, args.material_id, args.site_id) : null;
    const qty = args.qty ?? (pos ? Math.max(1, pos.daily_rate * 30) : 1);
    const daysAvailable = args.need_by ? diffDays(store.today(), args.need_by) : Math.max(0, (pos?.cover_days ?? 0) - (pos?.safety_days ?? 0));

    const rows = links.map((l) => {
      const b = reliabilityBelief(l, obs, now);
      const mid = l.price_low != null && l.price_high != null ? (l.price_low + l.price_high) / 2 : null;
      const risk = pos
        ? evaluateOption(
            { id: `${l.external_id}|${args.site_id}|${store.today()}`, supplier_id: l.supplier_id, unit_cost_usd: mid, qty, lead_days: l.lead_time_days ?? 90 },
            b,
            { days_available: daysAvailable, daily_value_usd: pos.daily_rate * (pos.unit_cost ?? mid ?? 0) },
            profile,
          )
        : null;
      const history = store
        .negotiationMemory({ supplier_id: l.supplier_id })
        .slice(-2)
        .map((m) => ({ material_id: m.material_id, opening_unit_price: m.list_unit_price, settled_unit_price: m.accepted_unit_price, savings_vs_opening_pct: m.savings_vs_list_pct, currency: m.currency }));
      return {
        supplier_id: l.supplier_id,
        supplier_name: store.supplier(l.supplier_id)?.name ?? l.supplier_id,
        material_supplier_id: l.external_id,
        qualification_state: l.qualification_state,
        lead_time_days: l.lead_time_days,
        reliability: beliefView(b),
        risk,
        negotiation_history: history,
      };
    });
    const ranked = pos ? rankOptions(rows.map((r) => r.risk!)).map((r) => rows.find((x) => x.supplier_id === r.supplier_id)!) : rows;
    const recommended = pos ? (ranked.find((r) => r.risk?.meets_min_p) ?? ranked[0] ?? null) : null;
    const lessons = store.lessons({ material_id: args.material_id }).slice(-5);
    const outcomeIds = store.supplierOutcomes({}).filter((o) => links.some((l) => l.supplier_id === o.supplier_id)).map((o) => o.id);
    const citations: Citation[] = [{ source: "material_suppliers", ids: links.map((l) => l.external_id) }];
    if (outcomeIds.length) citations.push({ source: "supplier_outcomes", ids: outcomeIds.slice(-20) });
    if (lessons.length) citations.push({ source: "lessons", ids: lessons.map((l) => l.id) });
    return {
      ingestion_status: "ok",
      source: "supplier_reliability",
      citations,
      material_id: args.material_id,
      client_profile: { id: profile.id, risk_aversion: profile.risk_aversion, min_p_in_time: profile.min_p_in_time },
      need: pos ? { site_id: args.site_id, qty: round(qty, 2), days_available: round(daysAvailable, 1) } : null,
      suppliers: ranked,
      recommended_supplier_id: recommended?.supplier_id ?? null,
      lessons: lessons.map((l) => ({ check_id: l.check_id, supplier_id: l.supplier_id, text: l.text, mission_id: l.mission_id })),
      guardrail: "Learning reorders approved suppliers only. It never qualifies, disqualifies or substitutes a material.",
    };
  },
});

export const learningTools = [recordDelivery, supplierReliability];
