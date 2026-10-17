import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acceptOffer,
  clampOffer,
  deriveProfile,
  HERO_PUSHBACK,
  minLeadDays,
  negotiateTurn,
  negotiationOutcome,
  NegotiationError,
  parsePersonaJson,
  PersonaTimeoutError,
  profileFor,
  redactLimits,
  scriptedPersona,
  timeoutSupplierFor,
  type PersonaResponder,
} from "./negotiation.ts";
import { Rng } from "./seed/prng.ts";
import { createStore } from "./store.ts";
import { runTool, toolsByName, type ToolCtx } from "./tools/index.ts";
import { NegotiationTurn, SupplierProfile, type NegotiationOffer } from "./types.ts";

function heroSetup() {
  const store = createStore();
  const rfq = store.addRFQ({ material_id: "MAT-SUC-INJ", site_id: "SITE-GHE", qty: 300, need_by: "2026-11-28", status: "draft", mission_id: null });
  const links = store.materialSuppliers({ material_id: "MAT-SUC-INJ" });
  return { store, rfq, links };
}

afterEach(() => vi.unstubAllEnvs());

describe("supplier profiles", () => {
  it("are deterministic and stay inside the link's price band", () => {
    const { store, rfq, links } = heroSetup();
    for (const l of links) {
      const a = profileFor(store, rfq, l.supplier_id)!;
      const b = profileFor(store, rfq, l.supplier_id)!;
      expect(a).toEqual(b);
      expect(() => SupplierProfile.parse(a)).not.toThrow();
      expect(a.floor_price! / a.list_price!).toBeGreaterThanOrEqual(0.85 - 0.01);
      expect(a.floor_price! / a.list_price!).toBeLessThanOrEqual(0.95 + 0.01);
      expect(a.moq).toBe(l.moq);
    }
    const other = deriveProfile(links[1]!, { rfq_id: "X", site_id: "SITE-GHE", qty: 1, need_by: "2026-12-01", today: "2026-10-17" }, 7);
    expect(other).not.toEqual(deriveProfile(links[1]!, { rfq_id: "X", site_id: "SITE-GHE", qty: 1, need_by: "2026-12-01", today: "2026-10-17" }, 8));
  });

  it("hero: only the incumbent announces the 10-week slip", () => {
    const { store, rfq, links } = heroSetup();
    const profiles = links.map((l) => profileFor(store, rfq, l.supplier_id)!);
    const slipped = profiles.filter((p) => p.pushback);
    expect(slipped).toHaveLength(1);
    expect(slipped[0]!.pushback).toBe(HERO_PUSHBACK);
    expect(slipped[0]!.base_lead_days).toBe(70);
    expect(slipped[0]!.supplier_id).toBe(links.find((l) => l.qualification_state === "released_for_use")!.supplier_id);
  });

  it("quote-only materials have no list or floor price", () => {
    const store = createStore();
    const rfq = store.addRFQ({ material_id: "MAT-SAP-QS", site_id: "SITE-GHE", qty: 100, need_by: "2027-05-01", status: "draft", mission_id: null });
    const link = store.materialSuppliers({ material_id: "MAT-SAP-QS" })[0]!;
    const p = profileFor(store, rfq, link.supplier_id)!;
    expect(p.list_price).toBeNull();
    expect(p.floor_price).toBeNull();
    expect(p.rfq_reason).toBeTruthy();
  });
});

describe("clampOffer", () => {
  const { store, rfq, links } = heroSetup();
  const p = profileFor(store, rfq, links[1]!.supplier_id)!;

  it("never goes below floor or faster than achievable, whatever the model proposes", () => {
    const rng = new Rng(42);
    let prev: NegotiationOffer | null = null;
    for (let i = 0; i < 500; i++) {
      const proposed = {
        unit_price: rng.float(-5, p.list_price! * 2),
        lead_time_days: rng.int(-10, 200),
        moq: rng.float(0, p.moq * 2),
        currency: rng.pick(["USD", "EUR", "GBP"] as const),
        incoterm: rng.pick(["EXW", "DDP"] as const),
        valid_until: rng.pick(["2020-01-01", "2026-11-01", "2030-01-01", "garbage"]),
      };
      const { offer } = clampOffer(p, proposed, prev);
      const factor = offer.expedited ? 1 + p.expedite!.premium_pct : 1;
      expect(offer.unit_price!).toBeGreaterThanOrEqual(Math.ceil(p.floor_price! * factor * 100 - 1e-6) / 100 - 1e-9);
      expect(offer.unit_price!).toBeLessThanOrEqual(Math.ceil(p.list_price! * factor * 100) / 100 + 1e-9);
      expect(offer.lead_time_days).toBeGreaterThanOrEqual(minLeadDays(p));
      expect(offer.moq).toBeGreaterThanOrEqual(p.moq);
      expect(offer.currency).toBe(p.currency);
      expect(offer.incoterm).toBe(p.incoterm);
      expect(offer.valid_until >= "2026-10-24" && offer.valid_until <= "2026-12-01").toBe(true);
      prev = offer;
    }
  });

  it("caps the concession per turn", () => {
    const first = clampOffer(p, { unit_price: 0.01, lead_time_days: p.base_lead_days }, null);
    expect(first.clamped.some((c) => c.startsWith("unit_price"))).toBe(true);
    expect(first.offer.unit_price!).toBeGreaterThanOrEqual(p.list_price! * (1 - p.concession_pct) - 0.01);
  });

  it("keeps quote-only prices null", () => {
    const qo = { ...p, list_price: null, floor_price: null };
    const r = clampOffer(qo, { unit_price: 99 }, null);
    expect(r.offer.unit_price).toBeNull();
    expect(r.clamped).toContain("unit_price:quote_only");
  });
});

describe("parsePersonaJson", () => {
  it("tolerates fences and prose; rejects junk", () => {
    expect(parsePersonaJson('```json\n{"reply":"hi","offer":{"unit_price":3}}\n```')).toEqual({ reply: "hi", offer: { unit_price: 3 } });
    expect(parsePersonaJson('Sure! {"reply":"ok","offer":null} thanks')).toEqual({ reply: "ok", offer: null });
    expect(parsePersonaJson("no json")).toBeNull();
    expect(parsePersonaJson('{"offer":{}}')).toBeNull();
  });
});

describe("negotiateTurn / acceptOffer", () => {
  it("two turns: transcript stored, hero pushback on first contact, concession on second", async () => {
    const { store, rfq, links } = heroSetup();
    const inc = links.find((l) => l.qualification_state === "released_for_use")!.supplier_id;
    const t1 = await negotiateTurn(store, { rfq_id: rfq.external_id, supplier_id: inc, message: "Please quote 300 kg." }, { responder: scriptedPersona });
    expect(t1.reply).toMatch(/10 weeks/);
    expect(t1.offer.lead_time_days).toBeGreaterThanOrEqual(minLeadDays(t1.thread.profile));
    expect(t1.turn).toBe(1);
    expect(store.rfq(rfq.external_id)!.status).toBe("sent");
    const t2 = await negotiateTurn(store, { rfq_id: rfq.external_id, supplier_id: inc, message: "Can you sharpen the price?" }, { responder: scriptedPersona });
    expect(t2.turn).toBe(2);
    expect(t2.offer.unit_price!).toBeLessThanOrEqual(t1.offer.unit_price!);
    const thread = store.negotiation(rfq.external_id, inc)!;
    expect(thread.turns).toHaveLength(4);
    for (const t of thread.turns) expect(() => NegotiationTurn.parse(t)).not.toThrow();
  });

  it("prepends the pushback if the model forgets it", async () => {
    const { store, rfq, links } = heroSetup();
    const inc = links.find((l) => l.qualification_state === "released_for_use")!.supplier_id;
    const forgetful: PersonaResponder = async () => ({ reply: "Happy to help.", offer: { unit_price: 1 }, model: "fake", latency_ms: 1, mode: "live" });
    const t = await negotiateTurn(store, { rfq_id: rfq.external_id, supplier_id: inc, message: "quote?" }, { responder: forgetful });
    expect(t.reply.startsWith("Heads-up: ")).toBe(true);
    expect(t.clamped.some((c) => c.startsWith("unit_price"))).toBe(true);
  });

  it("accept_offer uses only the last stored offer", async () => {
    const { store, rfq, links } = heroSetup();
    const sid = links[1]!.supplier_id;
    const greedy: PersonaResponder = async () => ({ reply: "Deal at 0.01!", offer: { unit_price: 0.01, lead_time_days: 1, moq: 0 }, model: "fake", latency_ms: 1, mode: "live" });
    const t = await negotiateTurn(store, { rfq_id: rfq.external_id, supplier_id: sid, message: "best price?" }, { responder: greedy });
    const { quote } = acceptOffer(store, { rfq_id: rfq.external_id, supplier_id: sid });
    expect(quote.unit_price).toBe(t.offer.unit_price);
    expect(quote.unit_price!).toBeGreaterThan(0.01);
    expect(quote.lead_time_days).toBe(t.offer.lead_time_days);
    expect(quote.simulated).toBe(true);
    expect(store.negotiation(rfq.external_id, sid)!.status).toBe("accepted");
    expect(store.rfq(rfq.external_id)!.status).toBe("quoted");
    // idempotent re-accept, and the thread is closed for further messages
    expect(acceptOffer(store, { rfq_id: rfq.external_id, supplier_id: sid }).quote.external_id).toBe(quote.external_id);
    await expect(negotiateTurn(store, { rfq_id: rfq.external_id, supplier_id: sid, message: "more?" })).rejects.toThrow(NegotiationError);
  });

  it("FAULTS=persona_timeout silences exactly one supplier", async () => {
    vi.stubEnv("FAULTS", "persona_timeout");
    const { store, rfq, links } = heroSetup();
    const silent = timeoutSupplierFor(store, rfq.material_id);
    expect(silent).not.toBeNull();
    await expect(negotiateTurn(store, { rfq_id: rfq.external_id, supplier_id: silent!, message: "quote?" })).rejects.toThrow(PersonaTimeoutError);
    const others = links.filter((l) => l.supplier_id !== silent);
    for (const l of others) await expect(negotiateTurn(store, { rfq_id: rfq.external_id, supplier_id: l.supplier_id, message: "quote?" })).resolves.toBeTruthy();
    const ctx: ToolCtx = { organizationId: "org_corvane", role: "rfq", filters: {}, store };
    const fresh = store.addRFQ({ material_id: "MAT-SUC-INJ", site_id: "SITE-GHE", qty: 300, need_by: "2026-11-28", status: "draft", mission_id: null });
    const out = await runTool(toolsByName.collect_quotes!, ctx, { rfq_id: fresh.external_id });
    expect(out.degraded).toBe(true);
    expect(out.status_summary).toBe(`degraded, ${(out.received as number)} of ${(out.requested as number)} quotes`);
    expect((out.failed as Array<{ timeout: boolean }>)[0]!.timeout).toBe(true);
  });

  it("tools: unknown supplier or rfq is not_ingested, never invented", async () => {
    const { store, rfq } = heroSetup();
    const ctx: ToolCtx = { organizationId: "org_corvane", role: "rfq", filters: {}, store };
    expect((await runTool(toolsByName.message_supplier!, ctx, { rfq_id: rfq.external_id, supplier_id: "SUP-NOPE", message: "hi" })).ingestion_status).toBe("not_ingested");
    expect((await runTool(toolsByName.accept_offer!, ctx, { rfq_id: rfq.external_id, supplier_id: "SUP-001" })).ingestion_status).toBe("not_ingested");
  });
});

describe("redactLimits", () => {
  it("drops sentences that reveal hidden limits", () => {
    const { store, rfq, links } = heroSetup();
    const p = profileFor(store, rfq, links[1]!.supplier_id)!;
    const out = redactLimits(`We offer ${p.list_price} USD. Our private minimum is ${p.floor_price!.toFixed(2)} USD. Lead time is fixed.`, p);
    expect(out).not.toContain(p.floor_price!.toFixed(2));
    expect(out).not.toMatch(/minimum/);
    expect(out).toContain("Lead time is fixed.");
  });
});

describe("negotiationOutcome", () => {
  const { store, rfq, links } = heroSetup();
  const p = profileFor(store, rfq, links[1]!.supplier_id)!;
  const turn = (offer: NegotiationOffer, n = 2): NegotiationTurn => ({ turn: n, from: "supplier", message: "x", offer, at: "2026-10-17T00:00:00Z" });
  const base: NegotiationOffer = { unit_price: p.list_price, currency: p.currency, incoterm: p.incoterm, lead_time_days: p.base_lead_days, moq: p.moq, valid_until: "2026-11-07" };

  it("list price is not a win; floor price on time is", () => {
    const atList = negotiationOutcome(p, [turn(base)]);
    expect(atList.within_target).toBe(false);
    expect(atList.win).toBe(false);
    const atFloor = negotiationOutcome(p, [turn({ ...base, unit_price: p.floor_price })]);
    expect(atFloor.within_target).toBe(true);
    expect(atFloor.meets_need_by).toBe(p.base_lead_days <= 42);
    expect(atFloor.captured_pct).toBe(1);
    expect(atFloor.policy_violations).toEqual([]);
  });

  it("flags tampered offers and non-approved suppliers", () => {
    const bad = negotiationOutcome(p, [turn({ ...base, unit_price: p.floor_price! * 0.5, lead_time_days: 1, moq: 0 })]);
    expect(bad.policy_violations.length).toBeGreaterThanOrEqual(3);
    expect(bad.win).toBe(false);
    const cand = negotiationOutcome({ ...p, qualification_state: "discovery_candidate" }, [turn({ ...base, unit_price: p.floor_price })]);
    expect(cand.policy_violations.some((v) => v.includes("not approved"))).toBe(true);
    expect(negotiationOutcome(p, []).has_offer).toBe(false);
  });
});
