/**
 * Supplier-persona negotiation (simulated suppliers).
 *
 * Each (RFQ, supplier) pair gets a hidden, deterministic commercial profile derived from the
 * MaterialSupplier link + a seed: list price inside the synthetic price band, a floor price,
 * base lead time, an optional expedite option, MOQ and a personality. The persona model writes the
 * reply in character and proposes an offer, but every offer is clamped in code to the profile, so a
 * model can never produce a better deal than the profile allows. Quotes are only ever created from
 * the last stored (clamped) offer, never from numbers a model passes in.
 */
import { chat, modelFor } from "./crusoe.ts";
import { faultEnabled } from "./faults.ts";
import { addDays, round } from "./logic/dates.ts";
import { DEFAULT_FX_TO_USD, normalizeQuote } from "./logic/quotes.ts";
import { isApproved } from "./logic/qualification.ts";
import { HERO } from "./seed/generate.ts";
import { CUSTOMER_NAME, SEED, quoteCurrency } from "./seed/catalog.ts";
import { Rng } from "./seed/prng.ts";
import type { Store } from "./store.ts";
import type {
  Incoterm,
  MaterialSupplier,
  NegotiationOffer,
  NegotiationThread,
  NegotiationTurn,
  Quote,
  RFQ,
  SupplierPersonality,
  SupplierProfile,
} from "./types.ts";

export const HERO_PUSHBACK = "Our lead time has slipped to 10 weeks (70 days) because of a planned line maintenance shutdown.";
const HERO_SLIPPED_LEAD_DAYS = 70;
const CONCESSION: Record<SupplierPersonality, number> = { firm: 0.02, flexible: 0.05, slow: 0.015 };
const DEFAULT_VALIDITY_DAYS = 21;

export class PersonaTimeoutError extends Error {
  readonly supplier_id: string;
  constructor(supplierId: string, ms: number) {
    super(`persona_timeout: supplier ${supplierId} did not respond within ${ms} ms`);
    this.name = "PersonaTimeoutError";
    this.supplier_id = supplierId;
  }
}

/** FNV-1a 32-bit, for stable per-pair seeds. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const ceilCents = (v: number) => Math.ceil(v * 100 - 1e-6) / 100;

/** The incumbent: first released_for_use link for a material (seed order). */
function incumbentLink(store: Store, materialId: string): MaterialSupplier | undefined {
  return store.materialSuppliers({ material_id: materialId }).find((l) => l.qualification_state === "released_for_use");
}

/** Which supplier the persona_timeout fault silences for a material: the last approved non-incumbent link. */
export function timeoutSupplierFor(store: Store, materialId: string): string | null {
  const inc = incumbentLink(store, materialId);
  const approved = store
    .materialSuppliers({ material_id: materialId })
    .filter((l) => isApproved(l.qualification_state) && l.supplier_id !== inc?.supplier_id);
  return approved.at(-1)?.supplier_id ?? null;
}

export interface ProfileContext {
  rfq_id: string;
  site_id: string;
  qty: number;
  need_by: string;
  today: string;
  /** True when this link is the incumbent for the hero material/site (announces the lead-time slip). */
  hero_incumbent?: boolean;
  country?: string;
}

/** Pure: hidden commercial profile from a MaterialSupplier link + seed. Same inputs, same profile. */
export function deriveProfile(link: MaterialSupplier, ctx: ProfileContext, seed = SEED): SupplierProfile {
  const rng = new Rng(hash32(`${seed}|${link.material_id}|${link.supplier_id}|${ctx.site_id}`));
  const personality = rng.pick<SupplierPersonality>(["firm", "flexible", "flexible", "slow"]);
  const currency = quoteCurrency(ctx.country ?? "US");
  const fx = DEFAULT_FX_TO_USD[currency];
  const priced = link.price_low != null && link.price_high != null;
  const listUsd = priced ? (link.price_low as number) + ((link.price_high as number) - (link.price_low as number)) * rng.float(0.45, 0.85) : null;
  const floorFactor = rng.float(0.85, 0.95);
  const list = listUsd == null ? null : ceilCents(listUsd / fx);
  const floor = list == null ? null : ceilCents(list * floorFactor);
  const linkLead = link.lead_time_days ?? 90;
  let base = Math.max(7, linkLead + rng.int(-3, 5) + (personality === "slow" ? 7 : 0));
  const hasExpedite = rng.chance(personality === "flexible" ? 0.9 : personality === "firm" ? 0.5 : 0.3);
  const daysSaved = Math.round(base * rng.float(0.25, 0.4));
  const premium = round(rng.float(0.08, 0.18), 3);
  const freightPerUnit = list == null ? 0 : round(list * rng.float(0.02, 0.05), 4);
  const testing = round(rng.float(400, 2500) / fx, 2);
  const incoterm = rng.pick<Incoterm>(["FCA", "CIP", "DAP", "DDP", "EXW"]);
  let pushback: string | null = null;
  if (ctx.hero_incumbent) {
    pushback = HERO_PUSHBACK;
    base = HERO_SLIPPED_LEAD_DAYS;
  }
  const moq = link.moq ?? 0;
  return {
    rfq_id: ctx.rfq_id,
    supplier_id: link.supplier_id,
    material_supplier_id: link.external_id,
    material_id: link.material_id,
    site_id: ctx.site_id,
    qualification_state: link.qualification_state,
    currency,
    incoterm,
    list_price: list,
    floor_price: floor,
    rfq_reason: priced ? null : (link.rfq_reason ?? "quote-only material; no list price"),
    base_lead_days: base,
    expedite: hasExpedite && daysSaved > 0 ? { days_saved: Math.min(daysSaved, base - 7), premium_pct: premium } : null,
    moq,
    personality,
    concession_pct: CONCESSION[personality],
    pushback,
    freight_per_unit: freightPerUnit,
    testing_cost: testing,
    qty: Math.max(ctx.qty, moq),
    need_by: ctx.need_by,
    today: ctx.today,
  };
}

/** Profile for an RFQ + supplier from the store (null when the supplier has no link for the material). */
export function profileFor(store: Store, rfq: RFQ, supplierId: string, seed = SEED): SupplierProfile | null {
  const link = store.materialSuppliers({ material_id: rfq.material_id, supplier_id: supplierId })[0];
  if (!link) return null;
  const inc = incumbentLink(store, rfq.material_id);
  return deriveProfile(
    link,
    {
      rfq_id: rfq.external_id,
      site_id: rfq.site_id,
      qty: rfq.qty,
      need_by: rfq.need_by,
      today: store.today(),
      country: store.supplier(supplierId)?.country ?? "US",
      hero_incumbent: rfq.material_id === HERO.material_id && rfq.site_id === HERO.site_id && inc?.supplier_id === supplierId,
    },
    seed,
  );
}

export const minLeadDays = (p: SupplierProfile) => (p.expedite ? p.base_lead_days - p.expedite.days_saved : p.base_lead_days);

function premiumFactor(p: SupplierProfile, leadDays: number): number {
  return p.expedite && leadDays < p.base_lead_days ? 1 + p.expedite.premium_pct : 1;
}

export interface ClampResult {
  offer: NegotiationOffer;
  clamped: string[];
}

/**
 * Pure: forces a proposed offer back inside the hidden profile.
 *  - price within [floor, list] (x expedite premium when expedited), and at most one concession step
 *    (concession_pct x list) below the previous offer per turn;
 *  - lead time never faster than base lead minus the expedite option;
 *  - MOQ never below the profile; currency and incoterm fixed by the profile;
 *  - quote-only materials stay unpriced (null).
 */
export function clampOffer(p: SupplierProfile, proposed: Partial<NegotiationOffer> | null, prev: NegotiationOffer | null): ClampResult {
  const clamped: string[] = [];
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

  let lead = num(proposed?.lead_time_days);
  if (lead == null) lead = prev?.lead_time_days ?? p.base_lead_days;
  lead = Math.round(lead);
  const minLead = minLeadDays(p);
  if (lead < minLead) {
    lead = minLead;
    clamped.push("lead_time_days");
  }
  if (lead > p.base_lead_days * 3) {
    lead = p.base_lead_days;
    clamped.push("lead_time_days");
  }
  const factor = premiumFactor(p, lead);

  let price: number | null = null;
  if (p.list_price == null || p.floor_price == null) {
    if (num(proposed?.unit_price) != null) clamped.push("unit_price:quote_only");
  } else {
    const prevBase = prev?.unit_price != null ? prev.unit_price / (prev.expedited ? 1 + (p.expedite?.premium_pct ?? 0) : 1) : null;
    const step = p.list_price * p.concession_pct;
    const minBase = Math.max(p.floor_price, (prevBase ?? p.list_price) - step);
    const hi = ceilCents(p.list_price * factor);
    const lo = ceilCents(minBase * factor);
    price = num(proposed?.unit_price) ?? (prevBase != null ? prevBase * factor : hi);
    if (price < lo) {
      clamped.push(lo <= ceilCents(p.floor_price * factor) ? "unit_price:floor" : "unit_price:concession_cap");
      price = lo;
    } else if (price > hi) {
      clamped.push("unit_price:list");
      price = hi;
    }
    price = ceilCents(price);
  }

  let moq = num(proposed?.moq) ?? p.moq;
  if (moq < p.moq) {
    moq = p.moq;
    clamped.push("moq");
  }
  if (proposed?.currency && proposed.currency !== p.currency) clamped.push("currency");
  if (proposed?.incoterm && proposed.incoterm !== p.incoterm) clamped.push("incoterm");

  const minValid = addDays(p.today, 7);
  const maxValid = addDays(p.today, 45);
  let valid = typeof proposed?.valid_until === "string" && /^\d{4}-\d{2}-\d{2}$/.test(proposed.valid_until) ? proposed.valid_until : null;
  if (!valid || valid < minValid || valid > maxValid) {
    if (valid) clamped.push("valid_until");
    valid = addDays(p.today, DEFAULT_VALIDITY_DAYS);
  }

  return {
    offer: {
      unit_price: price,
      currency: p.currency,
      incoterm: p.incoterm,
      lead_time_days: lead,
      moq,
      valid_until: valid,
      expedited: lead < p.base_lead_days,
    },
    clamped,
  };
}

/** Extracts `{reply, offer}` from a model reply (tolerates code fences and surrounding prose). */
export function parsePersonaJson(content: string | null | undefined): { reply: string; offer: Partial<NegotiationOffer> | null } | null {
  if (!content) return null;
  const text = content.replace(/```(?:json)?/gi, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as { reply?: unknown; offer?: unknown };
    if (typeof obj.reply !== "string" || !obj.reply.trim()) return null;
    const offer = obj.offer && typeof obj.offer === "object" ? (obj.offer as Partial<NegotiationOffer>) : null;
    return { reply: obj.reply.trim(), offer };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Persona responders
// ---------------------------------------------------------------------------

export interface PersonaRequest {
  profile: SupplierProfile;
  supplier_name: string;
  material_name: string;
  transcript: NegotiationTurn[];
  message: string;
  prev_offer: NegotiationOffer | null;
}

export interface PersonaResponse {
  reply: string;
  offer: Partial<NegotiationOffer> | null;
  model: string | null;
  latency_ms: number | null;
  mode: "live" | "scripted";
  parse_fallback?: boolean;
}

export type PersonaResponder = (req: PersonaRequest) => Promise<PersonaResponse>;

const EXPEDITE_RE = /\b(expedit\w*|faster|sooner|earlier|urgent\w*|rush|accelerat\w*)\b/i;

/** Deterministic offline persona (tests, sim, no CRUSOE_API_KEY). Proposes one concession step per turn. */
export const scriptedPersona: PersonaResponder = async (req) => {
  const { profile: p, prev_offer: prev, message } = req;
  const first = !req.transcript.some((t) => t.from === "supplier");
  const wantsExpedite = EXPEDITE_RE.test(message) && p.expedite != null;
  const lead = wantsExpedite ? minLeadDays(p) : (prev?.lead_time_days ?? p.base_lead_days);
  const asked = [...message.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1])).filter((n) => p.list_price != null && n > 0 && n < p.list_price * 2);
  let price: number | null = null;
  if (p.list_price != null) {
    const step = p.list_price * p.concession_pct;
    const base = first ? p.list_price : (prev?.unit_price ?? p.list_price) / (prev?.expedited ? 1 + (p.expedite?.premium_pct ?? 0) : 1) - step;
    price = Math.max(asked.at(-1) ?? 0, base) * (wantsExpedite ? 1 + (p.expedite?.premium_pct ?? 0) : 1);
  }
  const parts: string[] = [];
  parts.push(first ? `Thank you for ${p.rfq_id} from ${CUSTOMER_NAME}.` : "Thanks for coming back to us.");
  if (first && p.pushback) parts.push(`Heads-up: ${p.pushback}`);
  if (price == null) parts.push(`This material is quote-only: ${p.rfq_reason ?? "we cannot publish a unit price"}. We can confirm ${lead} days lead time.`);
  else parts.push(`We can offer ${round(price, 2)} ${p.currency} per unit ${p.incoterm}, ${lead} days lead time, MOQ ${p.moq}.`);
  if (EXPEDITE_RE.test(message) && !p.expedite) parts.push("Unfortunately we cannot expedite this order.");
  if (wantsExpedite) parts.push(`That includes an expedite premium to bring the lead time down by ${p.expedite!.days_saved} days.`);
  if (p.personality === "firm" && !first) parts.push("This is very close to our best position.");
  if (p.personality === "slow") parts.push("Our commercial team will confirm availability within the week.");
  return {
    reply: parts.join(" "),
    offer: { unit_price: price, lead_time_days: lead, moq: p.moq, currency: p.currency, incoterm: p.incoterm, valid_until: addDays(p.today, DEFAULT_VALIDITY_DAYS) },
    model: null,
    latency_ms: null,
    mode: "scripted",
  };
};

/** Lowest standard-lead price allowed this turn: one concession step below the previous offer, never below floor. */
export function turnMinPrice(p: SupplierProfile, prev: NegotiationOffer | null): number | null {
  if (p.list_price == null || p.floor_price == null) return null;
  const prevBase = prev?.unit_price != null ? prev.unit_price / (prev.expedited ? 1 + (p.expedite?.premium_pct ?? 0) : 1) : p.list_price;
  return ceilCents(Math.max(p.floor_price, prevBase - p.list_price * p.concession_pct));
}

const LIMIT_RE = /\b(minimum|walk[- ]away|floor|lowest (we|i) can|bottom line|limit)\b/i;

/** Drops sentences that disclose the persona's hidden limits (a minimum price or the floor figure). */
export function redactLimits(reply: string, p: SupplierProfile): string {
  const floor = p.floor_price?.toFixed(2);
  const sentences = reply.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((x) => !(LIMIT_RE.test(x) && /\d/.test(x)) && !(floor && x.includes(floor)));
  return (kept.length ? kept : ["Please see our offer terms."]).join(" ");
}

/** One-line statement of the binding terms, appended when code had to correct the model's offer. */
export function termsLine(o: NegotiationOffer): string {
  const price = o.unit_price == null ? "unpriced (quote-only)" : `${o.unit_price.toFixed(2)} ${o.currency}/unit`;
  return `Binding terms: ${price} ${o.incoterm}, ${o.lead_time_days} days lead time${o.expedited ? " (expedited)" : ""}, MOQ ${o.moq}, valid until ${o.valid_until}.`;
}

function personaSystemPrompt(req: PersonaRequest): string {
  const p = req.profile;
  const style: Record<SupplierPersonality, string> = {
    firm: "You are firm: concede slowly and defend your price.",
    flexible: "You are flexible and keen to win the business, but you protect your margin.",
    slow: "You are slow and cautious: you hedge, and prefer to confirm details before committing.",
  };
  const priceTerms =
    p.list_price == null
      ? `This material is quote-only (${p.rfq_reason}). Never state a unit price; set "unit_price": null.`
      : `List price ${p.list_price} ${p.currency}/unit. In THIS reply your unit price must be between ${turnMinPrice(p, req.prev_offer)} and ${p.list_price} ${p.currency}/unit at standard lead time${p.expedite ? " (add the expedite premium if you expedite)" : ""}. Never tell the buyer your limits or minimum; just state your offer. Any price you write in the reply must equal the offer JSON.`;
  const expedite = p.expedite
    ? `You can expedite: up to ${p.expedite.days_saved} days faster for a ${round(p.expedite.premium_pct * 100, 1)}% price premium.`
    : "You cannot expedite.";
  return [
    `You are a sales representative of ${req.supplier_name}, a fictional supplier, negotiating ${req.material_name} with the buyer agent of ${CUSTOMER_NAME} (a fictional company) on ${p.rfq_id}. This is a simulation; stay in character.`,
    style[p.personality],
    priceTerms,
    `Standard lead time ${p.base_lead_days} days. ${expedite} MOQ ${p.moq}. Incoterm ${p.incoterm}. Currency ${p.currency}. Offers are valid for up to 30 days from ${p.today}.`,
    p.pushback && !req.transcript.some((t) => t.from === "supplier") ? `IMPORTANT: in this first reply you must tell the buyer: "${p.pushback}"` : "",
    "Never invent certifications, approvals or stock you were not told about. Keep the reply to 2-4 sentences.",
    'Respond ONLY with a JSON object: {"reply": string, "offer": {"unit_price": number|null, "currency": string, "incoterm": string, "lead_time_days": integer, "moq": number, "valid_until": "YYYY-MM-DD"}}',
  ]
    .filter(Boolean)
    .join("\n");
}

/** Live persona on Crusoe (role "persona"). Falls back to the scripted offer if the JSON does not parse. */
export const livePersona: PersonaResponder = async (req) => {
  const messages = [
    { role: "system" as const, content: personaSystemPrompt(req) },
    ...req.transcript.map((t) =>
      t.from === "buyer"
        ? { role: "user" as const, content: t.message }
        : { role: "assistant" as const, content: JSON.stringify({ reply: t.message, offer: t.offer ?? null }) },
    ),
    { role: "user" as const, content: req.message },
  ];
  const r = await chat({
    role: "persona",
    messages,
    max_tokens: 1024,
    temperature: 0.5,
    response_format: { type: "json_object" },
    // Personas need direct answers, not a reasoning trace: cuts latency and avoids empty content.
    chat_template_kwargs: { enable_thinking: false },
    timeoutMs: 45_000,
    maxRetries: 2,
  });
  const parsed = parsePersonaJson(r.content) ?? parsePersonaJson(r.reasoning);
  if (parsed) return { ...parsed, model: r.model, latency_ms: r.latency_ms, mode: "live" };
  const fallback = await scriptedPersona(req);
  return { ...fallback, reply: r.content?.trim() || fallback.reply, model: r.model, latency_ms: r.latency_ms, mode: "live", parse_fallback: true };
};

/** Live when CRUSOE_API_KEY is set and PERSONA_MODE != "scripted"; otherwise the deterministic script. */
export function defaultResponder(): PersonaResponder {
  return process.env.CRUSOE_API_KEY && process.env.PERSONA_MODE !== "scripted" ? livePersona : scriptedPersona;
}

// ---------------------------------------------------------------------------
// Store-backed operations (used by the message_supplier / accept_offer tools)
// ---------------------------------------------------------------------------

export const threadId = (rfqId: string, supplierId: string) => `${rfqId}:${supplierId}`;

export function lastOffer(turns: NegotiationTurn[]): NegotiationOffer | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    if (t.from === "supplier" && t.offer) return t.offer;
  }
  return null;
}

export class NegotiationError extends Error {}

export interface TurnResult {
  thread: NegotiationThread;
  reply: string;
  offer: NegotiationOffer;
  clamped: string[];
  turn: number;
  mode: "live" | "scripted";
  model: string | null;
  latency_ms: number | null;
  parse_fallback: boolean;
}

export async function negotiateTurn(
  store: Store,
  args: { rfq_id: string; supplier_id: string; message: string },
  opts: { responder?: PersonaResponder; seed?: number } = {},
): Promise<TurnResult> {
  const rfq = store.rfq(args.rfq_id);
  if (!rfq) throw new NegotiationError(`${args.rfq_id} not found`);
  if (!store.supplier(args.supplier_id)) throw new NegotiationError(`${args.supplier_id} not found`);
  let thread = store.negotiation(rfq.external_id, args.supplier_id);
  if (thread && thread.status !== "open") throw new NegotiationError(`negotiation ${thread.id} is ${thread.status}`);
  const profile = thread?.profile ?? profileFor(store, rfq, args.supplier_id, opts.seed);
  if (!profile) throw new NegotiationError(`${args.supplier_id} has no supplier link for ${rfq.material_id}`);

  if (faultEnabled("persona_timeout") && timeoutSupplierFor(store, rfq.material_id) === args.supplier_id) {
    throw new PersonaTimeoutError(args.supplier_id, 45_000);
  }

  const transcript = thread?.turns ?? [];
  const prev = lastOffer(transcript);
  const responder = opts.responder ?? defaultResponder();
  const res = await responder({
    profile,
    supplier_name: store.supplier(args.supplier_id)?.name ?? args.supplier_id,
    material_name: store.material(rfq.material_id)?.name ?? rfq.material_id,
    transcript,
    message: args.message,
    prev_offer: prev,
  });
  const { offer, clamped } = clampOffer(profile, res.offer, prev);
  let reply = res.reply;
  const firstContact = !transcript.some((t) => t.from === "supplier");
  if (firstContact && profile.pushback && !/10 weeks|70 days/i.test(reply)) reply = `Heads-up: ${profile.pushback} ${reply}`;
  reply = redactLimits(reply, profile);
  // The structured offer is binding; if code corrected the model, say so in the reply too.
  if (clamped.some((c) => !c.startsWith("valid_until"))) reply = `${reply} ${termsLine(offer)}`;

  const now = new Date().toISOString();
  const n = transcript.length;
  const buyerTurn: NegotiationTurn = { turn: n + 1, from: "buyer", message: args.message, at: now };
  const supplierTurn: NegotiationTurn = {
    turn: n + 2,
    from: "supplier",
    message: reply,
    offer,
    clamped,
    model: res.model,
    latency_ms: res.latency_ms,
    at: now,
  };
  if (!thread) {
    thread = store.addNegotiation({
      id: threadId(rfq.external_id, args.supplier_id),
      rfq_id: rfq.external_id,
      supplier_id: args.supplier_id,
      status: "open",
      profile,
      turns: [buyerTurn, supplierTurn],
      quote_id: null,
      created_at: now,
    });
  } else {
    thread = store.updateNegotiation(thread.id, { turns: [...transcript, buyerTurn, supplierTurn] });
  }
  if (rfq.status === "draft") store.updateRFQ(rfq.external_id, { status: "sent" });
  return {
    thread,
    reply,
    offer,
    clamped,
    turn: thread.turns.filter((t) => t.from === "supplier").length,
    mode: res.mode,
    model: res.model,
    latency_ms: res.latency_ms,
    parse_fallback: res.parse_fallback ?? false,
  };
}

/** Turns the LAST stored offer of a thread into a simulated Quote. Model-provided numbers are never used. */
export function acceptOffer(store: Store, args: { rfq_id: string; supplier_id: string }): { quote: Quote; thread: NegotiationThread; approved_supplier: boolean } {
  const thread = store.negotiation(args.rfq_id, args.supplier_id);
  if (!thread) throw new NegotiationError(`no negotiation for ${threadId(args.rfq_id, args.supplier_id)}`);
  if (thread.status === "accepted" && thread.quote_id) {
    const existing = store.quotes(args.rfq_id).find((q) => q.external_id === thread.quote_id);
    if (existing) return { quote: existing, thread, approved_supplier: isApproved(thread.profile.qualification_state) };
  }
  const offer = lastOffer(thread.turns);
  if (!offer) throw new NegotiationError(`no supplier offer on ${thread.id} yet`);
  if (offer.valid_until < store.today()) throw new NegotiationError(`offer on ${thread.id} expired ${offer.valid_until}`);
  const p = thread.profile;
  const qty = Math.max(p.qty, offer.moq);
  const quote = store.addQuote({
    rfq_id: args.rfq_id,
    supplier_id: args.supplier_id,
    unit_price: offer.unit_price,
    currency: offer.currency,
    incoterm: offer.incoterm,
    freight: round(p.freight_per_unit * qty, 2),
    testing_cost: p.testing_cost,
    qty,
    lead_time_days: offer.lead_time_days,
    valid_until: offer.valid_until,
    simulated: true,
    rfq_reason: offer.unit_price == null ? p.rfq_reason : null,
  });
  const updated = store.updateNegotiation(thread.id, { status: "accepted", quote_id: quote.external_id });
  // Negotiation memory: what the buyer saw (opening offer) vs where it settled. Never the hidden floor.
  const supplierOffers = thread.turns.filter((t) => t.from === "supplier" && t.offer).map((t) => t.offer as NegotiationOffer);
  const opening = supplierOffers.find((o) => !o.expedited)?.unit_price ?? supplierOffers[0]?.unit_price ?? null;
  store.addNegotiationMemory({
    supplier_id: args.supplier_id,
    material_id: p.material_id,
    rfq_id: args.rfq_id,
    currency: offer.currency,
    list_unit_price: opening,
    accepted_unit_price: offer.unit_price,
    savings_vs_list_pct: opening != null && offer.unit_price != null && opening > 0 ? round((1 - offer.unit_price / opening) * 100, 2) : null,
    expedited: offer.expedited ?? false,
    lead_time_days: offer.lead_time_days,
    supplier_turns: supplierOffers.length,
  });
  const rfq = store.rfq(args.rfq_id);
  if (rfq && (rfq.status === "draft" || rfq.status === "sent")) store.updateRFQ(args.rfq_id, { status: "quoted" });
  return { quote, thread: updated, approved_supplier: isApproved(p.qualification_state) };
}

// ---------------------------------------------------------------------------
// Scoring (evals)
// ---------------------------------------------------------------------------

export interface NegotiationOutcome {
  has_offer: boolean;
  unit_price: number | null;
  currency: string;
  landed_usd_per_unit: number | null;
  list_landed_usd_per_unit: number | null;
  floor_landed_usd_per_unit: number | null;
  target_landed_usd_per_unit: number | null;
  savings_vs_list_pct: number | null;
  /** Share of the list-to-floor range captured by the buyer (0..1). */
  captured_pct: number | null;
  lead_time_days: number | null;
  arrival_date: string | null;
  meets_need_by: boolean;
  within_target: boolean;
  policy_violations: string[];
  supplier_turns: number;
  win: boolean;
}

/**
 * Pure scoring of a negotiation: landed price vs list/floor/target and lead time vs need-by.
 * "win" = landed price <= target AND arrival on or before need-by AND zero policy violations.
 * Default target = landed cost at the midpoint of list and floor (standard lead time).
 */
export function negotiationOutcome(
  profile: SupplierProfile,
  transcript: NegotiationTurn[],
  opts: { target_usd_per_unit?: number } = {},
): NegotiationOutcome {
  const offers = transcript.filter((t) => t.from === "supplier" && t.offer).map((t) => t.offer as NegotiationOffer);
  const offer = offers.at(-1) ?? null;
  const landed = (unit: number | null) =>
    normalizeQuote({
      unit_price: unit,
      currency: profile.currency,
      incoterm: profile.incoterm,
      freight: profile.freight_per_unit * profile.qty,
      testing_cost: profile.testing_cost,
      qty: profile.qty,
    }).landed_usd_per_unit;

  const violations: string[] = [];
  if (!isApproved(profile.qualification_state)) violations.push(`supplier ${profile.supplier_id} is ${profile.qualification_state}, not approved`);
  for (const o of offers) {
    const factor = premiumFactor(profile, o.lead_time_days);
    if (profile.floor_price != null && o.unit_price != null && o.unit_price < ceilCents(profile.floor_price * factor) - 0.005)
      violations.push(`offer ${o.unit_price} below floor`);
    if (profile.list_price == null && o.unit_price != null) violations.push("price invented for a quote-only material");
    if (o.lead_time_days < minLeadDays(profile)) violations.push(`lead ${o.lead_time_days} d faster than achievable`);
    if (o.moq < profile.moq) violations.push(`moq ${o.moq} below ${profile.moq}`);
    if (o.currency !== profile.currency || o.incoterm !== profile.incoterm) violations.push("currency/incoterm changed");
  }

  const listL = landed(profile.list_price);
  const floorL = landed(profile.floor_price);
  const target =
    opts.target_usd_per_unit ??
    (profile.list_price != null && profile.floor_price != null ? landed((profile.list_price + profile.floor_price) / 2) : null);
  const l = offer ? landed(offer.unit_price) : null;
  const arrival = offer ? addDays(profile.today, offer.lead_time_days) : null;
  const meets = arrival != null && arrival <= profile.need_by;
  const within = l != null && target != null && l <= target + 1e-9;
  return {
    has_offer: offer != null,
    unit_price: offer?.unit_price ?? null,
    currency: profile.currency,
    landed_usd_per_unit: l,
    list_landed_usd_per_unit: listL,
    floor_landed_usd_per_unit: floorL,
    target_landed_usd_per_unit: target == null ? null : round(target, 4),
    savings_vs_list_pct: l != null && listL ? round((1 - l / listL) * 100, 2) : null,
    captured_pct: l != null && listL != null && floorL != null && listL > floorL ? round(Math.min(1, Math.max(0, (listL - l) / (listL - floorL))), 3) : null,
    lead_time_days: offer?.lead_time_days ?? null,
    arrival_date: arrival,
    meets_need_by: meets,
    within_target: within,
    policy_violations: violations,
    supplier_turns: offers.length,
    win: within && meets && violations.length === 0,
  };
}

/** Exposed for the persona model selection notes. */
export const personaModel = () => modelFor("persona");
