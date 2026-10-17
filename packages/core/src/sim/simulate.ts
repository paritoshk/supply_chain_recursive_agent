/**
 * Synthetic 90-day inventory simulation: manual baseline vs the agent's decision tree.
 *
 * Both policies run on the SAME world (common random numbers): the Corvane seed, one demand stream
 * with seeded noise, and the same injected supplier delays. Only the decision policy differs.
 *
 *  baseline: weekly manual review against a static reorder point; orders only from the primary
 *            (incumbent) supplier; reactive expedite when a site is about to run dry.
 *            Human minutes: 30 per shortage review, 120 per RFQ, 20 per transfer.
 *  agent:    daily sentinel; decision tree = transfer from sister-site surplus first, else expedite an
 *            in-flight order, else RFQ the best landed approved option that arrives in time.
 *            Never orders from a non-qualified or BIOSECURE-blocked supplier.
 *            Human minutes: 3 per approval ping, only for decisions above the authority threshold.
 *
 *  agent_risk:     same tree, but options are ranked by risk-adjusted expected cost for the client
 *                  profile (logic/risk.ts), using supplier-stated reliability only. Expedites only when
 *                  the premium is below the expected stockout cost it avoids.
 *  agent_learning: agent_risk plus learning: every delivery updates the supplier's reliability belief
 *                  (logic/learning.ts), so later decisions use observed, not stated, reliability.
 *
 * supplierTruth "drifted" gives each supplier a hidden true reliability that can differ from what it
 * states (some overstate on-time delivery), with hidden lateness and incoming-QC rejections. Suppliers
 * give 7 days' notice of a slip. "as_stated" (default) keeps every delivery on its promised date.
 *
 * All data is synthetic. Supplier prices/lead times/expedite options come from the same hidden
 * persona profiles used by message_supplier (negotiation.ts), at list price (no negotiation gains assumed).
 */
import { isApproved, supplierScore } from "../logic/index.ts";
import { DEFAULT_FX_TO_USD, DEFAULT_INCOTERM_ADDERS } from "../logic/quotes.ts";
import { round } from "../logic/dates.ts";
import { ON_TIME_GRACE_DAYS, reliabilityBelief, type Observation, type PriorInput, type ReliabilityBelief } from "../logic/learning.ts";
import { CORVANE_PROFILE, evaluateOption, rankOptions, stockoutCostPerDay, type ClientProfile, type OptionRisk } from "../logic/risk.ts";
import { deriveProfile, hash32 } from "../negotiation.ts";
import { HERO } from "../seed/generate.ts";
import { SEED } from "../seed/catalog.ts";
import { Rng } from "../seed/prng.ts";
import { createStore } from "../store.ts";
import { positionFor } from "../tools/position.ts";

export type SimPolicy = "baseline" | "agent" | "agent_risk" | "agent_learning";
export type SupplierTruth = "as_stated" | "drifted";

export interface SimOptions {
  /** Hidden supplier reliability. Default "as_stated". */
  supplierTruth?: SupplierTruth;
  /** Client profile for agent_risk / agent_learning. Default Corvane. */
  profile?: ClientProfile;
  days?: number;
  seed?: number;
  policy: SimPolicy;
  /** Agent decisions above this value (USD) need a human approval ping. Default 25,000. */
  authorityThresholdUsd?: number;
  /** Std-dev of multiplicative daily demand noise. Default 0.25. */
  demandNoise?: number;
  /** Probability that an approved supplier link suffers a delay event in the horizon. Default 0.15. */
  delayProbability?: number;
}

export interface SimMetrics {
  pairs: number;
  stockout_events: number;
  stockout_days: number;
  /** Mean per-position fill rate (demand served from stock / demand), in percent. */
  service_level_pct: number;
  expedite_spend_usd: number;
  avg_inventory_value_usd: number;
  purchase_spend_usd: number;
  orders: number;
  transfers: number;
  expedites: number;
  human_touches: number;
  human_minutes: number;
  approval_pings: number;
  non_qualified_orders: number;
  /** Supplier deliveries more than the grace days after the supplier's commitment. */
  late_deliveries: number;
  qc_rejections: number;
  /** Stockout pair-days priced with the client profile (floor + multiple x daily consumption value). */
  stockout_cost_usd: number;
}

/** How well the policy's reliability beliefs match the hidden truth, and where its orders went. */
export interface SimReliability {
  truth: SupplierTruth;
  observations: number;
  /** Mean |believed - true| on-time rate (pp) over supplier links that delivered. Stated metrics vs final belief. */
  prior_error_pp: number | null;
  belief_error_pp: number | null;
  /** Share of purchase orders placed with suppliers that overstate their reliability, per half of the horizon. */
  overstated_order_share: { first_half: number | null; second_half: number | null };
  /** Stockout pair-days per 30-day period. */
  stockout_days_by_period: number[];
  qa_review_flags: string[];
}

export interface SimEvent {
  day: number;
  kind: "order" | "transfer" | "expedite" | "stockout_start" | "delay" | "review";
  material_id: string;
  site_id: string;
  detail: string;
}

export interface SimResult {
  policy: SimPolicy;
  seed: number;
  days: number;
  metrics: SimMetrics;
  hero: { material_id: string; site_id: string; stockout_days: number; first_stockout_day: number | null; events: SimEvent[] };
  /** Positions that stocked out, with their starting cover vs the fastest achievable lead time. */
  stockouts_by_position: Array<{ material_id: string; site_id: string; stockout_days: number; initial_cover_days: number; fastest_lead_days: number }>;
  reliability: SimReliability;
  label: "synthetic simulation";
}

export const HUMAN_MINUTES = { shortage_review: 30, rfq: 120, transfer: 20, approval_ping: 3 } as const;

interface SupplierOption {
  supplier_id: string;
  material_supplier_id: string;
  primary: boolean;
  qualified: boolean;
  /** Landed-ish USD per unit at list price (FX + incoterm adder), null for quote-only. */
  landed_usd: number | null;
  goods_usd: number | null;
  base_lead: number;
  moq: number;
  expedite: { days_saved: number; premium_pct: number } | null;
  /** Supplier-stated reliability on the approved-supplier link (the learning prior). */
  prior: PriorInput;
}

interface Order {
  id: number;
  pair: number;
  supplier_id: string | null;
  qty: number;
  /** True arrival (hidden slip and QC replacement included). */
  arrival: number;
  /** Arrival the buyer sees: the commitment plus announced delays. */
  promised: number;
  /** The supplier's commitment at order time (moved only by a buyer-requested expedite). */
  committed: number;
  /** Extra days because the first lot failed incoming QC and was replaced. */
  qc_extra: number;
  placed: number;
  goods_usd: number | null;
  expedite: SupplierOption["expedite"];
  expedited: boolean;
  transfer: boolean;
}

interface Pair {
  material_id: string;
  site_id: string;
  region: string;
  rate: number;
  plan_lead: number;
  safety: number;
  unit_cost_usd: number | null;
  on_hand0: number;
  options: SupplierOption[];
}

interface DelayEvent {
  material_id: string;
  supplier_id: string;
  start: number;
  end: number;
  extra: number;
}

/** Hidden per-supplier reliability (drifted truth only). */
interface SupplierTruthRow {
  kind: "as_stated" | "overstated" | "better";
  /** Subtracted from the stated on-time rate (negative = better than stated). */
  on_time_drop: number;
  late_days_mean: number;
  reject_add: number;
}

interface World {
  days: number;
  pairs: Pair[];
  demand: number[][];
  delays: DelayEvent[];
  truthMode: SupplierTruth;
  truth: Map<string, SupplierTruthRow>;
}

/** Days of notice a supplier gives before a slipped delivery's promised date. */
export const SLIP_NOTICE_DAYS = 7;

const clamp01 = (x: number) => Math.min(0.995, Math.max(0.05, x));

/** True on-time rate of a link under the world's hidden truth. */
function trueOnTime(w: World, o: Pick<SupplierOption, "supplier_id" | "prior">): number {
  const stated = o.prior.otd_pct == null ? 0.8 : o.prior.otd_pct / 100;
  if (w.truthMode === "as_stated") return clamp01(stated);
  return clamp01(stated - (w.truth.get(o.supplier_id)?.on_time_drop ?? 0));
}

function buildTruth(pairs: Pair[], seed: number): Map<string, SupplierTruthRow> {
  const rng = new Rng(hash32(`truth|${seed}`));
  const truth = new Map<string, SupplierTruthRow>();
  const ids = [...new Set(pairs.flatMap((p) => p.options.filter((o) => o.qualified).map((o) => o.supplier_id)))].sort();
  for (const id of ids) {
    const r = rng.float();
    if (r < 0.25) truth.set(id, { kind: "overstated", on_time_drop: rng.float(0.25, 0.45), late_days_mean: rng.float(15, 35), reject_add: rng.float(0.02, 0.06) });
    else if (r < 0.4) truth.set(id, { kind: "better", on_time_drop: -rng.float(0.03, 0.08), late_days_mean: rng.float(3, 6), reject_add: 0 });
    else truth.set(id, { kind: "as_stated", on_time_drop: rng.float(-0.03, 0.03), late_days_mean: rng.float(5, 12), reject_add: 0 });
  }
  return truth;
}

function gaussian(rng: Rng): number {
  const u = Math.max(1e-12, rng.float());
  const v = rng.float();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Deterministic world for a seed: pairs, supplier options, demand stream and delay events. */
export function buildWorld(seed = SEED, days = 90, demandNoise = 0.25, delayProbability = 0.15, truthMode: SupplierTruth = "as_stated"): World {
  const store = createStore();
  const today = store.today();
  const pairs: Pair[] = [];
  for (const c of store.consumption()) {
    const links = store.materialSuppliers({ material_id: c.material_id });
    const approved = links.filter((l) => isApproved(l.qualification_state) && !supplierScore(l).blocked);
    if (!approved.length || c.daily_rate <= 0) continue;
    const incumbent = links.find((l) => l.qualification_state === "released_for_use") ?? approved[0]!;
    const pos = positionFor(store, c.material_id, c.site_id);
    const options: SupplierOption[] = links
      .filter((l) => !supplierScore(l).blocked)
      .map((l) => {
        const country = store.supplier(l.supplier_id)?.country ?? "US";
        const p = deriveProfile(
          l,
          {
            rfq_id: "SIM",
            site_id: c.site_id,
            qty: c.daily_rate * 30,
            need_by: today,
            today,
            country,
            hero_incumbent: c.material_id === HERO.material_id && c.site_id === HERO.site_id && l.supplier_id === incumbent.supplier_id,
          },
          seed,
        );
        const fx = DEFAULT_FX_TO_USD[p.currency];
        const goods = p.list_price == null ? null : p.list_price * fx;
        return {
          supplier_id: l.supplier_id,
          material_supplier_id: l.external_id,
          primary: l.supplier_id === incumbent.supplier_id,
          qualified: isApproved(l.qualification_state),
          goods_usd: goods,
          landed_usd: goods == null ? null : goods * (1 + DEFAULT_INCOTERM_ADDERS[p.incoterm]) + p.freight_per_unit * fx,
          base_lead: p.base_lead_days,
          moq: p.moq,
          expedite: p.expedite,
          prior: { supplier_id: l.supplier_id, otd_pct: l.otd_pct, lead_time_variance_days: l.lead_time_variance_days, rejection_rate: l.rejection_rate },
        };
      });
    const primary = options.find((o) => o.primary);
    pairs.push({
      material_id: c.material_id,
      site_id: c.site_id,
      region: store.site(c.site_id)?.region ?? "?",
      rate: c.daily_rate,
      plan_lead: c.lead_time_days ?? primary?.base_lead ?? 60,
      safety: c.safety_days ?? 14,
      unit_cost_usd: pos.unit_cost ?? primary?.goods_usd ?? null,
      on_hand0: pos.released_qty,
      options,
    });
  }

  const rng = new Rng(hash32(`sim|${seed}`));
  const demand = pairs.map((p) => Array.from({ length: days }, () => Math.max(0, p.rate * (1 + demandNoise * gaussian(rng)))));

  const delays: DelayEvent[] = [];
  const seen = new Set<string>();
  for (const p of pairs) {
    for (const o of p.options) {
      const k = `${p.material_id}|${o.supplier_id}`;
      if (seen.has(k) || !o.qualified) continue;
      seen.add(k);
      if (!rng.chance(delayProbability)) continue;
      const start = rng.int(0, Math.max(0, days - 20));
      delays.push({ material_id: p.material_id, supplier_id: o.supplier_id, start, end: start + rng.int(21, 45), extra: rng.int(14, 35) });
    }
  }
  const truth = truthMode === "drifted" ? buildTruth(pairs, seed) : new Map<string, SupplierTruthRow>();
  return { days, pairs, demand, delays, truthMode, truth };
}

const delayFor = (w: World, materialId: string, supplierId: string, day: number) =>
  w.delays.find((d) => d.material_id === materialId && d.supplier_id === supplierId && day >= d.start && day < d.end)?.extra ?? 0;

/** Runs one policy over the world. Pure and deterministic for (seed, options). */
export function runSimulation(opts: SimOptions): SimResult {
  const days = opts.days ?? 90;
  const seed = opts.seed ?? SEED;
  const threshold = opts.authorityThresholdUsd ?? 25_000;
  const profile = opts.profile ?? CORVANE_PROFILE;
  const risky = opts.policy === "agent_risk" || opts.policy === "agent_learning";
  const learns = opts.policy === "agent_learning";
  const w = buildWorld(seed, days, opts.demandNoise ?? 0.25, opts.delayProbability ?? 0.15, opts.supplierTruth ?? "as_stated");
  const n = w.pairs.length;
  const onHand = w.pairs.map((p) => p.on_hand0);
  const orders: Order[] = [];
  let orderSeq = 0;
  const inStockout = new Array<boolean>(n).fill(false);
  const heroIdx = w.pairs.findIndex((p) => p.material_id === HERO.material_id && p.site_id === HERO.site_id);
  const events: SimEvent[] = [];
  const m: SimMetrics = {
    pairs: n,
    stockout_events: 0,
    stockout_days: 0,
    service_level_pct: 0,
    expedite_spend_usd: 0,
    avg_inventory_value_usd: 0,
    purchase_spend_usd: 0,
    orders: 0,
    transfers: 0,
    expedites: 0,
    human_touches: 0,
    human_minutes: 0,
    approval_pings: 0,
    non_qualified_orders: 0,
    late_deliveries: 0,
    qc_rejections: 0,
    stockout_cost_usd: 0,
  };
  let heroStockoutDays = 0;
  let heroFirst: number | null = null;
  const demandByPair = new Array<number>(n).fill(0);
  const servedByPair = new Array<number>(n).fill(0);
  const stockoutDaysByPair = new Array<number>(n).fill(0);
  const stockoutByPeriod = new Array<number>(Math.ceil(days / 30)).fill(0);
  const ordersByHalf = [
    { all: 0, overstated: 0 },
    { all: 0, overstated: 0 },
  ];
  let invValueSum = 0;
  const observations: Observation[] = [];

  // Reliability beliefs, cached per day. agent_risk never learns: it always sees the stated prior.
  let beliefDay = -1;
  const beliefCache = new Map<string, ReliabilityBelief>();
  const belief = (o: SupplierOption, day: number): ReliabilityBelief => {
    if (beliefDay !== day) {
      beliefCache.clear();
      beliefDay = day;
    }
    const key = o.material_supplier_id;
    let b = beliefCache.get(key);
    if (!b) {
      b = reliabilityBelief(o.prior, learns ? observations : [], day);
      beliefCache.set(key, b);
    }
    return b;
  };

  const log = (e: SimEvent) => {
    const idx = w.pairs.findIndex((p) => p.material_id === e.material_id && p.site_id === e.site_id);
    if (idx === heroIdx) events.push(e);
  };
  const human = (minutes: number, touches = 1) => {
    m.human_minutes += minutes;
    m.human_touches += touches;
  };
  const ping = (valueUsd: number | null) => {
    if (opts.policy === "baseline") return;
    if (valueUsd == null || valueUsd > threshold) {
      m.approval_pings++;
      human(HUMAN_MINUTES.approval_ping);
    }
  };
  const outstanding = (i: number) => orders.filter((o) => o.pair === i);
  const position = (i: number) => onHand[i]! + outstanding(i).reduce((s, o) => s + o.qty, 0);
  const rop = (p: Pair, lead = p.plan_lead) => p.rate * (lead + p.safety);
  const orderUpTo = (p: Pair, lead = p.plan_lead) => rop(p, lead) + p.rate * 30;

  /** Arrival the buyer can see: the promise, until the supplier gives notice of a slip. */
  const visible = (o: Order, day: number) => (o.arrival > o.promised && day >= o.promised - SLIP_NOTICE_DAYS ? o.arrival : o.promised);
  const optionOf = (o: Order) => w.pairs[o.pair]!.options.find((x) => x.supplier_id === o.supplier_id);
  /** Risk policies plan on expected arrival: a promise without notice is discounted by the believed lateness. */
  const expected = (o: Order, day: number) => {
    const v = visible(o, day);
    if (!risky || o.supplier_id == null || v !== o.promised) return v;
    const opt = optionOf(o);
    if (!opt) return v;
    const b = belief(opt, day);
    return v + (1 - b.on_time.mean) * b.late_days_mean;
  };

  /** Hidden outcome of an order (drifted truth only). Keyed by the order, not the policy (common random numbers). */
  const realize = (day: number, p: Pair, opt: SupplierOption, lead: number) => {
    if (w.truthMode === "as_stated") return { slip: 0, qc_extra: 0 };
    const t = w.truth.get(opt.supplier_id);
    const r = new Rng(hash32(`outcome|${seed}|${p.material_id}|${p.site_id}|${opt.supplier_id}|${day}`));
    const late = r.float() > trueOnTime(w, opt);
    const slip = late ? Math.max(ON_TIME_GRACE_DAYS + 1, Math.round(-(t?.late_days_mean ?? 10) * Math.log(Math.max(1e-9, r.float())))) : 0;
    const reject = Math.min(0.5, (opt.prior.rejection_rate ?? 0.01) + (t?.reject_add ?? 0));
    const qcExtra = r.float() < reject ? Math.ceil(lead * 0.5) : 0;
    return { slip, qc_extra: qcExtra };
  };

  const placeOrder = (day: number, i: number, opt: SupplierOption, qty: number, expedite: boolean) => {
    const p = w.pairs[i]!;
    if (!opt.qualified) m.non_qualified_orders++;
    const q = Math.max(qty, opt.moq);
    const lead = opt.base_lead + delayFor(w, p.material_id, opt.supplier_id, day) - (expedite && opt.expedite ? opt.expedite.days_saved : 0);
    const goods = opt.goods_usd == null ? null : opt.goods_usd * q;
    const premium = expedite && opt.expedite && goods != null ? goods * opt.expedite.premium_pct : 0;
    const promised = day + Math.max(1, lead);
    const out = realize(day, p, opt, Math.max(1, lead));
    orders.push({
      id: ++orderSeq,
      pair: i,
      supplier_id: opt.supplier_id,
      qty: q,
      arrival: promised + out.slip + out.qc_extra,
      promised,
      committed: promised,
      qc_extra: out.qc_extra,
      placed: day,
      goods_usd: goods,
      expedite: opt.expedite,
      expedited: expedite,
      transfer: false,
    });
    m.orders++;
    const half = ordersByHalf[day < days / 2 ? 0 : 1]!;
    half.all++;
    if (w.truth.get(opt.supplier_id)?.kind === "overstated") half.overstated++;
    if (goods != null) m.purchase_spend_usd += goods;
    if (expedite) {
      m.expedites++;
      m.expedite_spend_usd += premium;
    }
    log({ day, kind: "order", material_id: p.material_id, site_id: p.site_id, detail: `${round(q, 2)} from ${opt.supplier_id}${opt.primary ? " (primary)" : ""}, lead ${Math.max(1, lead)} d${expedite ? " expedited" : ""}` });
    return goods == null ? null : goods + premium;
  };

  const expediteOrder = (day: number, o: Order) => {
    if (!o.expedite || o.expedited) return null;
    const shift = (x: number) => Math.max(day + 1, x - o.expedite!.days_saved);
    o.arrival = shift(o.arrival);
    o.promised = shift(o.promised);
    o.committed = shift(o.committed);
    o.expedited = true;
    const premium = o.goods_usd == null ? null : o.goods_usd * o.expedite.premium_pct;
    m.expedites++;
    if (premium != null) m.expedite_spend_usd += premium;
    const p = w.pairs[o.pair]!;
    log({ day, kind: "expedite", material_id: p.material_id, site_id: p.site_id, detail: `order #${o.id} from ${o.supplier_id} now arrives day ${visible(o, day)}` });
    return premium;
  };

  const baselineReview = (day: number) => {
    w.pairs.forEach((p, i) => {
      const primary = p.options.find((o) => o.primary)!;
      const pos = position(i);
      const cover = onHand[i]! / p.rate;
      if (pos <= rop(p)) {
        human(HUMAN_MINUTES.shortage_review);
        human(HUMAN_MINUTES.rfq);
        log({ day, kind: "review", material_id: p.material_id, site_id: p.site_id, detail: `weekly review: position ${round(pos, 1)} <= static ROP ${round(rop(p), 1)}` });
        placeOrder(day, i, primary, orderUpTo(p) - pos, false);
      }
      // Reactive expedite: less than a week of stock and the next delivery lands after stock runs out.
      const next = outstanding(i)
        .filter((o) => !o.transfer)
        .sort((a, b) => visible(a, day) - visible(b, day))[0];
      if (cover < 7 && next && visible(next, day) > day + cover && next.expedite && !next.expedited) {
        human(HUMAN_MINUTES.shortage_review);
        expediteOrder(day, next);
      }
    });
  };

  /** Days until stock runs out at the planned rate, counting in-flight arrivals as the policy sees them. */
  const runway = (i: number, day: number) => {
    const p = w.pairs[i]!;
    let stock = onHand[i]!;
    let t = 0;
    for (const o of outstanding(i)
      .map((o) => ({ o, at: expected(o, day) - day }))
      .sort((a, b) => a.at - b.at)) {
      if (stock - p.rate * (o.at - t) < 0) return t + stock / p.rate;
      stock -= p.rate * (o.at - t);
      t = o.at;
      stock += o.o.qty;
    }
    return t + stock / p.rate;
  };

  /** Moves up to `qty` from the sister site with the largest surplus (above its ROP + 14 d), if it lands within `maxTransit` days. */
  const tryTransfer = (day: number, i: number, qty: number, maxTransit: number): number => {
    const p = w.pairs[i]!;
    let pick: { j: number; surplus: number } | null = null;
    w.pairs.forEach((s, j) => {
      if (j === i || s.material_id !== p.material_id) return;
      const surplus = onHand[j]! - (rop(s) + s.rate * 14);
      if (surplus > 0 && (!pick || surplus > pick.surplus)) pick = { j, surplus };
    });
    const tp = pick as { j: number; surplus: number } | null;
    if (!tp || qty <= 0) return 0;
    const sister = w.pairs[tp.j]!;
    const transit = sister.region === p.region ? 3 : 7;
    if (transit > maxTransit) return 0;
    const moved = Math.min(qty, tp.surplus);
    onHand[tp.j] = onHand[tp.j]! - moved;
    orders.push({ id: ++orderSeq, pair: i, supplier_id: null, qty: moved, arrival: day + transit, promised: day + transit, committed: day + transit, qc_extra: 0, placed: day, goods_usd: null, expedite: null, expedited: false, transfer: true });
    m.transfers++;
    log({ day, kind: "transfer", material_id: p.material_id, site_id: p.site_id, detail: `${round(moved, 2)} from ${sister.site_id}, ${transit} d transit` });
    ping(p.unit_cost_usd == null ? null : moved * p.unit_cost_usd);
    return moved;
  };

  const agentSentinel = (day: number) => {
    w.pairs.forEach((p, i) => {
      const qualified = p.options.filter((o) => o.qualified);
      const effLead = (o: SupplierOption) => o.base_lead + delayFor(w, p.material_id, o.supplier_id, day);
      const fastestLead = (o: SupplierOption) => effLead(o) - (o.expedite?.days_saved ?? 0);
      const dryIn = runway(i, day);
      const inflight = outstanding(i).sort((a, b) => visible(a, day) - visible(b, day));
      const late = inflight.find((o) => !o.transfer && visible(o, day) - day > dryIn);
      const belowRop = position(i) <= rop(p);
      // Act on a coming gap only when it is inside the safety window (later gaps may still be fixed cheaply).
      const gapSoon = late != null && dryIn <= p.safety;
      if (!gapSoon && !belowRop) return;

      if (gapSoon && late) {
        const need = p.rate * (visible(late, day) - day - dryIn + 2);
        // a) bridge with a transfer from sister-site surplus
        const bridged = tryTransfer(day, i, need, dryIn + 1) > 0;
        if (bridged) {
          // covered from sister-site surplus; no expedite needed
        } else if (late.expedite && !late.expedited) {
          // b) expedite the late in-flight order
          ping(expediteOrder(day, late));
        } else {
          // b') expedited bridge shipment from the fastest approved option, if it beats the late order
          const opt = [...qualified].sort((a, b) => fastestLead(a) - fastestLead(b))[0];
          if (opt && day + fastestLead(opt) < visible(late, day)) ping(placeOrder(day, i, opt, need, Boolean(opt.expedite)));
        }
      }
      if (!belowRop) return;

      // c) RFQ: cheapest landed approved option that arrives with half the safety days still in stock.
      //    If none does, buy the main quantity from the fastest standard option and expedite only a
      //    bridge shipment that covers the gap (partial expedite, not the whole order).
      const remaining = orderUpTo(p) - position(i);
      if (remaining <= 0) return;
      const window = runway(i, day) - p.safety / 2;
      const byCost = [...qualified].sort((a, b) => (a.landed_usd ?? Infinity) - (b.landed_usd ?? Infinity) || effLead(a) - effLead(b));
      const onTime = byCost.find((o) => effLead(o) <= window);
      if (onTime) {
        ping(placeOrder(day, i, onTime, remaining, false));
        return;
      }
      const main = [...qualified].sort((a, b) => effLead(a) - effLead(b) || (a.landed_usd ?? Infinity) - (b.landed_usd ?? Infinity))[0]!;
      let bridgeQty = Math.min(remaining, p.rate * (effLead(main) - window + p.safety / 2));
      // transfer first: cover the gap from sister-site surplus before paying for an expedite
      const moved = tryTransfer(day, i, bridgeQty, Math.max(0, runway(i, day) - 1));
      bridgeQty -= moved;
      if (bridgeQty <= 1e-9) {
        if (remaining - moved > 0) ping(placeOrder(day, i, main, remaining - moved, false));
        return;
      }
      const bridge = byCost.find((o) => o.expedite && fastestLead(o) <= window) ?? [...qualified].sort((a, b) => fastestLead(a) - fastestLead(b))[0]!;
      if (bridgeQty > 0 && fastestLead(bridge) < effLead(main)) {
        ping(placeOrder(day, i, bridge, bridgeQty, Boolean(bridge.expedite)));
        if (remaining - moved - bridgeQty > 0) ping(placeOrder(day, i, main, remaining - moved - bridgeQty, false));
      } else ping(placeOrder(day, i, main, remaining - moved, false));
    });
  };

  /**
   * Risk policies: same order of moves (transfer, expedite, RFQ), but every choice is priced. Suppliers are
   * ranked by risk-adjusted expected cost for the client profile, and an expedite or bridge is bought only
   * when its premium is below the risk-adjusted stockout cost it removes.
   */
  const riskSentinel = (day: number) => {
    w.pairs.forEach((p, i) => {
      const qualified = p.options.filter((o) => o.qualified);
      if (!qualified.length) return;
      const effLead = (o: SupplierOption) => o.base_lead + delayFor(w, p.material_id, o.supplier_id, day);
      const need = { daily_value_usd: p.rate * (p.unit_cost_usd ?? 0), qc_release_days: 0 };
      const perDay = stockoutCostPerDay(need, profile);
      // Learned reorder point: the planned lead time padded by the believed lateness of the most reliable
      // qualified supplier. With learning, a supplier that keeps slipping moves the reorder point earlier.
      const slip = Math.min(...qualified.map((o) => (1 - belief(o, day).on_time.mean) * belief(o, day).late_days_mean));
      const lead = p.plan_lead + slip;
      const evaluate = (o: SupplierOption, qty: number, expedite: boolean, daysAvailable: number): OptionRisk & { opt: SupplierOption; expedite: boolean; premium: number } => {
        const x = expedite && o.expedite ? o.expedite : null;
        const lead = Math.max(1, effLead(o) - (x?.days_saved ?? 0));
        const unit = o.landed_usd == null ? null : o.landed_usd * (1 + (x?.premium_pct ?? 0));
        const r = evaluateOption(
          { id: `${o.material_supplier_id}${x ? ":x" : ""}|${p.site_id}|${day}`, supplier_id: o.supplier_id, unit_cost_usd: unit, qty: Math.max(qty, o.moq), lead_days: lead },
          belief(o, day),
          { ...need, days_available: daysAvailable },
          profile,
          SIM_SAMPLES,
        );
        return { ...r, opt: o, expedite: x != null, premium: o.goods_usd == null || !x ? 0 : o.goods_usd * Math.max(qty, o.moq) * x.premium_pct };
      };
      const dryIn = runway(i, day);
      const inflight = outstanding(i).sort((a, b) => expected(a, day) - expected(b, day));
      const late = inflight.find((o) => !o.transfer && expected(o, day) - day > dryIn);
      const belowRop = position(i) <= rop(p, lead);
      const gapSoon = late != null && dryIn <= p.safety;
      if (!gapSoon && !belowRop) return;

      if (gapSoon && late) {
        const gapDays = expected(late, day) - day - dryIn;
        const qty = p.rate * (gapDays + 2);
        if (tryTransfer(day, i, qty, dryIn + 1) <= 0) {
          // Cheapest of: do nothing, expedite the late order, or a bridge shipment. Bridge goods are not a
          // loss (they are consumed later), so a bridge costs its premium plus its own stockout risk.
          const nothing = gapDays * perDay;
          const exp =
            late.expedite && !late.expedited && late.goods_usd != null
              ? late.goods_usd * late.expedite.premium_pct + Math.max(0, gapDays - late.expedite.days_saved) * perDay
              : Infinity;
          const bridges = qualified.flatMap((o) => [evaluate(o, qty, false, dryIn), ...(o.expedite ? [evaluate(o, qty, true, dryIn)] : [])]);
          const bridge = bridges.sort((a, b) => a.premium + a.risk_adjusted_stockout_usd - (b.premium + b.risk_adjusted_stockout_usd))[0];
          const bridgeCost = bridge ? bridge.premium + bridge.risk_adjusted_stockout_usd : Infinity;
          if (exp <= bridgeCost && exp < nothing) ping(expediteOrder(day, late));
          else if (bridge && bridgeCost < nothing) ping(placeOrder(day, i, bridge.opt, qty, bridge.expedite));
        }
      }
      if (!belowRop) return;

      const remaining = orderUpTo(p, lead) - position(i);
      if (remaining <= 0) return;
      // Supply must land with half the safety stock still on hand (demand noise eats the rest), as in the rule policy.
      const avail = runway(i, day) - p.safety / 2;
      const main = rankOptions(qualified.map((o) => evaluate(o, remaining, false, avail)))[0] as ReturnType<typeof evaluate>;
      if (main.p_in_time >= profile.min_p_in_time) {
        ping(placeOrder(day, i, main.opt, remaining, false));
        return;
      }
      // Main supply is likely late: cover the expected gap with a transfer, then a bridge if it pays for itself.
      let bridgeQty = Math.min(remaining, p.rate * Math.max(0, main.expected_release_days - avail + p.safety / 2));
      const moved = tryTransfer(day, i, bridgeQty, Math.max(0, avail - 1));
      bridgeQty -= moved;
      if (bridgeQty > 1e-9) {
        const bridges = qualified.flatMap((o) => [evaluate(o, bridgeQty, false, avail), ...(o.expedite ? [evaluate(o, bridgeQty, true, avail)] : [])]);
        const bridge = bridges.sort((a, b) => a.premium + a.risk_adjusted_stockout_usd - (b.premium + b.risk_adjusted_stockout_usd))[0];
        if (bridge && bridge.premium + bridge.risk_adjusted_stockout_usd < main.risk_adjusted_stockout_usd) {
          ping(placeOrder(day, i, bridge.opt, bridgeQty, bridge.expedite));
          if (remaining - moved - bridgeQty > 0) ping(placeOrder(day, i, main.opt, remaining - moved - bridgeQty, false));
          return;
        }
      }
      if (remaining - moved > 0) ping(placeOrder(day, i, main.opt, remaining - moved, false));
    });
  };

  for (let day = 0; day < days; day++) {
    // delay events also hit in-flight orders from that supplier when they start (announced: the promise moves too)
    for (const d of w.delays) {
      if (d.start !== day) continue;
      for (const o of orders) {
        const p = w.pairs[o.pair]!;
        if (!o.transfer && o.supplier_id === d.supplier_id && p.material_id === d.material_id) {
          o.arrival += d.extra;
          o.promised += d.extra;
        }
      }
      const hp = w.pairs[heroIdx];
      if (hp && d.material_id === hp.material_id) log({ day, kind: "delay", material_id: hp.material_id, site_id: hp.site_id, detail: `${d.supplier_id} +${d.extra} d until day ${d.end}` });
    }
    // receipts: each supplier delivery is an observed outcome
    for (let k = orders.length - 1; k >= 0; k--) {
      const o = orders[k]!;
      if (o.arrival <= day) {
        onHand[o.pair] = onHand[o.pair]! + o.qty;
        orders.splice(k, 1);
        if (!o.transfer && o.supplier_id) {
          const lateDays = Math.max(0, o.arrival - o.qc_extra - o.committed);
          if (lateDays > ON_TIME_GRACE_DAYS) m.late_deliveries++;
          if (o.qc_extra > 0) m.qc_rejections++;
          observations.push({ supplier_id: o.supplier_id, day, late_days: lateDays, qc_passed: o.qc_extra === 0 });
        }
      }
    }
    if (opts.policy === "baseline") {
      if (day % 7 === 0) baselineReview(day);
    } else if (risky) riskSentinel(day);
    else agentSentinel(day);
    // consumption
    for (let i = 0; i < n; i++) {
      const d = w.demand[i]![day]!;
      const take = Math.min(onHand[i]!, d);
      onHand[i] = onHand[i]! - take;
      demandByPair[i] = demandByPair[i]! + d;
      servedByPair[i] = servedByPair[i]! + take;
      const short = d - take > 1e-9;
      if (short) {
        m.stockout_days++;
        stockoutByPeriod[Math.floor(day / 30)]!++;
        m.stockout_cost_usd += stockoutCostPerDay({ daily_value_usd: w.pairs[i]!.rate * (w.pairs[i]!.unit_cost_usd ?? 0) }, profile);
        stockoutDaysByPair[i] = stockoutDaysByPair[i]! + 1;
        if (!inStockout[i]) {
          m.stockout_events++;
          const p = w.pairs[i]!;
          log({ day, kind: "stockout_start", material_id: p.material_id, site_id: p.site_id, detail: `short ${round(d - take, 2)}` });
        }
        if (i === heroIdx) {
          heroStockoutDays++;
          heroFirst ??= day;
        }
      }
      inStockout[i] = short;
      const cost = w.pairs[i]!.unit_cost_usd;
      if (cost != null) invValueSum += onHand[i]! * cost;
    }
  }

  // Calibration: stated metrics vs the end-of-horizon belief, over links whose supplier delivered.
  const delivered = new Set(observations.map((o) => o.supplier_id));
  const links = new Map<string, SupplierOption>();
  for (const p of w.pairs) for (const o of p.options) if (o.qualified && delivered.has(o.supplier_id)) links.set(o.material_supplier_id, o);
  const errs = [...links.values()].map((o) => {
    const t = trueOnTime(w, o);
    const b = reliabilityBelief(o.prior, observations, days);
    return { prior: Math.abs(b.prior.on_time - t), post: Math.abs(b.on_time.mean - t), flag: b.qa_review ? `${o.supplier_id}: ${b.qa_review}` : null };
  });
  const meanPp = (xs: number[]) => (xs.length ? round((xs.reduce((a, x) => a + x, 0) / xs.length) * 100, 1) : null);
  const share = (h: { all: number; overstated: number }) => (h.all ? round(h.overstated / h.all, 3) : null);

  // Mean per-position fill rate (unit-agnostic: kg, g and ea positions weigh the same).
  m.service_level_pct = round((demandByPair.reduce((acc, d, i) => acc + (d > 0 ? servedByPair[i]! / d : 1), 0) / Math.max(1, n)) * 100, 2);
  m.avg_inventory_value_usd = round(invValueSum / days, 0);
  m.expedite_spend_usd = round(m.expedite_spend_usd, 0);
  m.purchase_spend_usd = round(m.purchase_spend_usd, 0);
  m.stockout_cost_usd = round(m.stockout_cost_usd, 0);
  return {
    policy: opts.policy,
    seed,
    days,
    metrics: m,
    hero: { ...HERO, stockout_days: heroStockoutDays, first_stockout_day: heroFirst, events },
    stockouts_by_position: stockoutDaysByPair
      .map((d, i) => ({ material_id: w.pairs[i]!.material_id, site_id: w.pairs[i]!.site_id, stockout_days: d, initial_cover_days: round(w.pairs[i]!.on_hand0 / w.pairs[i]!.rate, 1), fastest_lead_days: Math.min(...w.pairs[i]!.options.filter((o) => o.qualified).map((o) => o.base_lead - (o.expedite?.days_saved ?? 0))) }))
      .filter((x) => x.stockout_days > 0)
      .sort((a, b) => b.stockout_days - a.stockout_days),
    reliability: {
      truth: w.truthMode,
      observations: observations.length,
      prior_error_pp: meanPp(errs.map((e) => e.prior)),
      belief_error_pp: learns ? meanPp(errs.map((e) => e.post)) : meanPp(errs.map((e) => e.prior)),
      overstated_order_share: { first_half: share(ordersByHalf[0]!), second_half: share(ordersByHalf[1]!) },
      stockout_days_by_period: stockoutByPeriod,
      qa_review_flags: learns ? [...new Set(errs.map((e) => e.flag).filter((f): f is string => f != null))] : [],
    },
    label: "synthetic simulation",
  };
}

/** Monte Carlo samples per option evaluation inside the simulator. */
export const SIM_SAMPLES = 400;

export interface SimComparison {
  seed: number;
  days: number;
  baseline: SimResult;
  agent: SimResult;
}

export function compareSimulation(seed = SEED, days = 90): SimComparison {
  return { seed, days, baseline: runSimulation({ days, seed, policy: "baseline" }), agent: runSimulation({ days, seed, policy: "agent" }) };
}
