/** Supplier-persona negotiation tools. Offers are clamped to a hidden profile in code (see ../negotiation.ts). */
import { z } from "zod";
import { isApproved } from "../logic/index.ts";
import { acceptOffer, negotiateTurn, NegotiationError, PersonaTimeoutError, threadId } from "../negotiation.ts";
import type { Citation } from "../types.ts";
import { defineTool, type ToolResult } from "./contract.ts";

const negCitation = (rfqId: string, supplierId: string, excerpt?: string): Citation => ({
  source: "negotiations",
  ids: [threadId(rfqId, supplierId)],
  ...(excerpt ? { excerpt } : {}),
});

const notOk = (error: string): ToolResult => ({ ingestion_status: "not_ingested", source: "negotiations", citations: [], error });

export const messageSupplier = defineTool({
  name: "message_supplier",
  description:
    "Send one negotiation message to a simulated supplier persona on an RFQ. Returns the persona's in-character reply and a structured offer {unit_price, currency, incoterm, lead_time_days, moq, valid_until}. Offers are clamped in code to the supplier's hidden commercial limits. Simulated supplier response.",
  idempotent: false,
  inputSchema: z.object({ rfq_id: z.string(), supplier_id: z.string(), message: z.string().min(1).max(4000) }),
  async run(ctx, args) {
    try {
      const r = await negotiateTurn(ctx.store, args);
      // Negotiation memory: on the opening turn, show how past negotiations with this supplier settled.
      const history =
        r.turn <= 1
          ? ctx.store
              .negotiationMemory({ supplier_id: args.supplier_id })
              .filter((m) => m.rfq_id !== args.rfq_id)
              .slice(-3)
              .map(({ material_id, currency, list_unit_price, accepted_unit_price, savings_vs_list_pct, expedited, supplier_turns }) => ({
                material_id,
                currency,
                opening_unit_price: list_unit_price,
                settled_unit_price: accepted_unit_price,
                savings_vs_opening_pct: savings_vs_list_pct,
                expedited,
                supplier_turns,
              }))
          : [];
      return {
        ingestion_status: "ok",
        source: "negotiations",
        citations: [negCitation(args.rfq_id, args.supplier_id, `turn ${r.turn}: ${r.offer.unit_price ?? "unpriced"} ${r.offer.currency}, ${r.offer.lead_time_days} d`)],
        rfq_id: args.rfq_id,
        supplier_id: args.supplier_id,
        supplier_name: ctx.store.supplier(args.supplier_id)?.name ?? args.supplier_id,
        reply: r.reply,
        offer: r.offer,
        turn: r.turn,
        clamped_fields: r.clamped,
        persona_mode: r.mode,
        model: r.model,
        latency_ms: r.latency_ms,
        ...(history.length ? { negotiation_history: history, history_note: "Past settlements with this supplier. Use them to judge how far it usually moves from its opening price." } : {}),
        label: "simulated supplier response",
      };
    } catch (err) {
      if (err instanceof NegotiationError) return notOk(err.message);
      throw err;
    }
  },
});

export const acceptOfferTool = defineTool({
  name: "accept_offer",
  description:
    "Turn the supplier's LAST stored offer on an RFQ into a simulated Quote (for compare_quotes / apply_approval). Never takes prices as input. Does not award or place anything.",
  idempotent: false,
  inputSchema: z.object({ rfq_id: z.string(), supplier_id: z.string() }),
  async run(ctx, args) {
    try {
      const { quote, approved_supplier } = acceptOffer(ctx.store, args);
      return {
        ingestion_status: "ok",
        source: "quotes",
        citations: [
          { source: "quotes", ids: [quote.external_id, args.rfq_id] },
          negCitation(args.rfq_id, args.supplier_id, "quote created from the last stored offer"),
        ],
        quote,
        approved_supplier,
        label: "simulated supplier response",
        note: approved_supplier
          ? "Quote stored. Approval still requires a human (apply_approval)."
          : "Supplier is not approved for this material: the quote is informational and cannot be awarded.",
      };
    } catch (err) {
      if (err instanceof NegotiationError) return { ...notOk(err.message), source: "quotes" };
      throw err;
    }
  },
});

export const collectQuotes = defineTool({
  name: "collect_quotes",
  description:
    "First-round fan-out: send the RFQ to each supplier persona (default: approved suppliers for the material), store each opening offer as a simulated Quote. Persona timeouts are reported per supplier and mark the result degraded.",
  idempotent: false,
  inputSchema: z.object({ rfq_id: z.string(), supplier_ids: z.array(z.string()).optional(), timeout_ms: z.number().int().positive().default(30_000) }),
  async run(ctx, args) {
    const { store } = ctx;
    const rfq = store.rfq(args.rfq_id);
    if (!rfq) return { ...notOk(`${args.rfq_id} not found`), source: "quotes" };
    const supplierIds =
      args.supplier_ids ??
      store
        .materialSuppliers({ material_id: rfq.material_id })
        .filter((l) => isApproved(l.qualification_state))
        .map((l) => l.supplier_id);
    const material = store.material(rfq.material_id);
    const opening = `${rfq.external_id}: please quote ${rfq.qty} ${material?.unit ?? "units"} of ${material?.name ?? rfq.material_id}, delivered to ${rfq.site_id}, needed by ${rfq.need_by}. Please confirm unit price, incoterm, lead time, MOQ and validity.`;
    const settled = await Promise.allSettled(
      supplierIds.map(async (sid) => {
        const existing = store.negotiation(rfq.external_id, sid);
        const turn = existing?.turns.some((t) => t.from === "supplier") ? null : await negotiateTurn(store, { rfq_id: rfq.external_id, supplier_id: sid, message: opening });
        const { quote } = acceptOffer(store, { rfq_id: rfq.external_id, supplier_id: sid });
        return { supplier_id: sid, quote, reply: turn?.reply ?? null };
      }),
    );
    const received = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
    const failed = settled.flatMap((s, i) =>
      s.status === "rejected"
        ? [{ supplier_id: supplierIds[i]!, error: (s.reason as Error).message, timeout: s.reason instanceof PersonaTimeoutError }]
        : [],
    );
    const degraded = failed.length > 0;
    return {
      ingestion_status: "ok",
      source: "quotes",
      citations: [
        { source: "quotes", ids: [rfq.external_id, ...received.map((r) => r.quote.external_id)] },
        ...received.map((r) => negCitation(rfq.external_id, r.supplier_id)),
      ],
      rfq_id: rfq.external_id,
      requested: supplierIds.length,
      received: received.length,
      quotes: received.map((r) => ({ supplier_id: r.supplier_id, quote: r.quote, reply: r.reply })),
      failed,
      degraded,
      status_summary: degraded ? `degraded, ${received.length} of ${supplierIds.length} quotes` : `${received.length} of ${supplierIds.length} quotes`,
      label: "simulated supplier response",
    };
  },
});

export const negotiationTools = [messageSupplier, acceptOfferTool];
