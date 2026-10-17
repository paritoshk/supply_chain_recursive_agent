import { describe, expect, it } from "vitest";
import {
  canPromote,
  coverDays,
  expiryDiscount,
  expiryRisk,
  normalizeQuote,
  priceInventory,
  reorderPoint,
  safetyStock,
  severityFor,
  specPrefilter,
  supplierScore,
  surplus,
  type SpecMaterial,
} from "./index.ts";

describe("hero scenario: Ghent injectable sucrose", () => {
  // 120 kg released + 30 kg quarantined, 5 kg/day, 42 d lead, 14 d safety
  const released = 120;
  const daily = 5;
  const cover = coverDays(released, daily);
  const rop = reorderPoint(daily, 42, 14);

  it("counts only released stock: 24 days of cover", () => {
    expect(cover).toBe(24);
    expect(coverDays(released + 30, daily)).not.toBe(24); // quarantined would distort it
  });
  it("reorder point is 280 kg", () => expect(rop).toBe(280));
  it("safety stock is 70 kg", () => expect(safetyStock(daily, 14)).toBe(70));
  it("severity is action", () => {
    expect(severityFor({ coverDays: cover, leadTimeDays: 42, safetyDays: 14, releasedQty: released, reorderPoint: rop })).toBe(
      "action",
    );
  });
});

describe("inventory math", () => {
  it("cover is null with no consumption", () => expect(coverDays(10, 0)).toBeNull());
  it("ROP is null when lead time unknown", () => expect(reorderPoint(5, null, 14)).toBeNull());
  it("surplus is quantity above ROP", () => {
    expect(surplus(1600, 98)).toBe(1502);
    expect(surplus(50, 98)).toBe(0);
  });
  it("severity watch between lead and lead+safety, info when healthy", () => {
    expect(severityFor({ coverDays: 50, leadTimeDays: 42, safetyDays: 14 })).toBe("watch");
    expect(severityFor({ coverDays: 90, leadTimeDays: 42, safetyDays: 14 })).toBe("info");
    expect(severityFor({ coverDays: 5, leadTimeDays: null, safetyDays: 14 })).toBe("action");
  });
  it("expiryRisk simulates FEFO over released lots only", () => {
    const r = expiryRisk(
      [
        { external_id: "A", qty: 1000, status: "released", expiry_date: "2027-02-14" }, // 120 d
        { external_id: "B", qty: 600, status: "released", expiry_date: "2027-02-14" },
        { external_id: "Q", qty: 500, status: "quarantined", expiry_date: "2026-11-01" },
      ],
      2,
      "2026-10-17",
    );
    expect(r.lots.map((l) => l.external_id)).toEqual(["A", "B"]);
    expect(r.at_risk_qty).toBe(1600 - 240);
    expect(r.earliest_expiry).toBe("2027-02-14");
  });
  it("expired lots are fully at risk", () => {
    const r = expiryRisk([{ external_id: "X", qty: 10, status: "released", expiry_date: "2026-10-01" }], 5, "2026-10-17");
    expect(r.at_risk_qty).toBe(10);
  });
});

describe("qualification promotion", () => {
  it("allows exactly one step", () => {
    expect(canPromote("discovery_candidate", "technically_suitable").ok).toBe(true);
    expect(canPromote("quality_approved", "released_for_use").ok).toBe(true);
  });
  it("rejects skipped states", () => {
    const r = canPromote("discovery_candidate", "quality_approved");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/technically_suitable/);
    expect(canPromote("technically_suitable", "released_for_use").ok).toBe(false);
    expect(canPromote("discovery_candidate", "released_for_use").ok).toBe(false);
  });
  it("rejects demotion / no-op as promotion", () => {
    expect(canPromote("released_for_use", "quality_approved").ok).toBe(false);
    expect(canPromote("quality_approved", "quality_approved").ok).toBe(false);
  });
  it("development-stage source stays a candidate", () => {
    expect(canPromote("technically_suitable", "quality_approved", { supply_stage: "development" }).ok).toBe(false);
    expect(canPromote("discovery_candidate", "technically_suitable", { supply_stage: "development" }).ok).toBe(true);
  });
});

describe("supplierScore", () => {
  const base = {
    otd_pct: 95,
    lead_time_variance_days: 3,
    rejection_rate: 0.005,
    qualification_state: "released_for_use" as const,
    biosecure_review: "cleared" as const,
  };
  it("ranks released over discovery with equal metrics", () => {
    expect(supplierScore(base).score).toBeGreaterThan(supplierScore({ ...base, qualification_state: "discovery_candidate" }).score);
  });
  it("blocks BIOSECURE-flagged entities", () => {
    const s = supplierScore({ ...base, biosecure_review: "flagged" });
    expect(s.blocked).toBe(true);
    expect(s.score).toBe(0);
  });
  it("penalises poor OTD and high rejection", () => {
    expect(supplierScore({ ...base, otd_pct: 70, rejection_rate: 0.04 }).score).toBeLessThan(supplierScore(base).score);
  });
  it("stays within 0..100", () => {
    const s = supplierScore({ ...base, otd_pct: 100, lead_time_variance_days: 0, rejection_rate: 0 });
    expect(s.score).toBe(100);
  });
});

describe("normalizeQuote", () => {
  it("converts currency and incoterm to landed USD per unit", () => {
    const n = normalizeQuote({ unit_price: 20, currency: "EUR", incoterm: "EXW", freight: 540, testing_cost: 1080, qty: 300 });
    // goods 21.60 + EXW 10% 2.16 + freight 1.944 + testing 3.888
    expect(n.comparable).toBe(true);
    expect(n.landed_usd_per_unit).toBeCloseTo(21.6 + 2.16 + 1.944 + 3.888, 4);
    expect(n.total_landed_usd).toBeCloseTo((21.6 + 2.16 + 1.944 + 3.888) * 300, 1);
  });
  it("DDP carries no incoterm adder", () => {
    const n = normalizeQuote({ unit_price: 10, currency: "USD", incoterm: "DDP", freight: 0, testing_cost: 0, qty: 100 });
    expect(n.landed_usd_per_unit).toBe(10);
  });
  it("EXW costs more landed than DDP at the same price", () => {
    const q = { unit_price: 10, currency: "USD" as const, freight: 0, testing_cost: 0, qty: 100 };
    expect(normalizeQuote({ ...q, incoterm: "EXW" }).landed_usd_per_unit!).toBeGreaterThan(
      normalizeQuote({ ...q, incoterm: "DDP" }).landed_usd_per_unit!,
    );
  });
  it("handles null price without inventing a number", () => {
    const n = normalizeQuote({
      unit_price: null,
      currency: "USD",
      incoterm: "FCA",
      freight: 0,
      testing_cost: 0,
      qty: 500,
      rfq_reason: "proprietary adjuvant: price on license terms only",
    });
    expect(n.landed_usd_per_unit).toBeNull();
    expect(n.total_landed_usd).toBeNull();
    expect(n.comparable).toBe(false);
    expect(n.reason).toMatch(/proprietary/);
  });
  it("accepts custom fx tables", () => {
    const n = normalizeQuote(
      { unit_price: 100, currency: "GBP", incoterm: "DDP", freight: 0, testing_cost: 0, qty: 1 },
      { fxRates: { GBP: 1.3 } },
    );
    expect(n.landed_usd_per_unit).toBe(130);
  });
});

describe("priceInventory", () => {
  const cork = { qty: 1600, band: { low: 10, high: 32 }, gradeFactor: 1, daysToExpiry: 120, shelfLife: 1095 };

  it("applies the expiry discount on resale", () => {
    const r = priceInventory(cork);
    expect(r.recommendation).toBe("resell");
    expect(expiryDiscount(120, 1095)).toBe(0.35);
    expect(r.unit_price).toBe(21 * 0.65);
    expect(r.total).toBeCloseTo(21 * 0.65 * 1600, 2);
  });
  it("prefers a transfer when a sister site needs the material", () => {
    const r = priceInventory({ ...cork, sisterSiteDemand: [{ site_id: "SITE-RAL", qty: 302 }] });
    expect(r.recommendation).toBe("transfer");
    expect(r.transfer_qty).toBe(302);
    expect(r.transfer_to).toEqual(["SITE-RAL"]);
    expect(r.unit_price).toBe(21);
    expect(r.resale_unit_price).toBe(13.65); // external alternative still reported
  });
  it("holds when unpriced (quote-only) or too close to expiry", () => {
    expect(priceInventory({ ...cork, band: { low: null, high: null } }).recommendation).toBe("hold");
    expect(priceInventory({ ...cork, band: { low: null, high: null } }).unit_price).toBeNull();
    expect(priceInventory({ ...cork, daysToExpiry: 20 }).recommendation).toBe("hold");
  });
  it("no discount with most of shelf life left", () => {
    expect(priceInventory({ ...cork, daysToExpiry: 900 }).unit_price).toBe(21);
  });
});

describe("specPrefilter", () => {
  const sucInj: SpecMaterial = {
    external_id: "MAT-SUC-INJ",
    substance: "sucrose",
    material_class: "compendial_excipient",
    grade: "parenteral low-endotoxin",
    compendia: ["USP-NF", "Ph. Eur.", "JP"],
    endotoxin_class: "low",
    sourcing_mode: "spec_led",
  };
  it("exact for matching spec", () => {
    expect(specPrefilter(sucInj, { ...sucInj, external_id: "MAT-SUC-INJ-B" }).match).toBe("exact");
  });
  it("grade mismatch for oral grade", () => {
    const r = specPrefilter(sucInj, { ...sucInj, external_id: "MAT-SUC-NF", grade: "oral", compendia: ["USP-NF"], endotoxin_class: null });
    expect(r.match).toBe("grade_mismatch");
    expect(r.reasons.join(" ")).toMatch(/compendia/);
  });
  it("form mismatch for different salt", () => {
    const amox: SpecMaterial = {
      external_id: "MAT-AMOX",
      substance: "amoxicillin",
      material_class: "small_molecule_api",
      grade: "compacted, oral",
      compendia: ["USP", "Ph. Eur."],
      salt_form: "trihydrate",
      sourcing_mode: "spec_led",
    };
    expect(specPrefilter(amox, { ...amox, external_id: "MAT-AMOX-NA", salt_form: "sodium" }).match).toBe("form_mismatch");
  });
  it("access-led analogue is not equivalent", () => {
    const sap: SpecMaterial = {
      external_id: "MAT-SAP-QS",
      substance: "saponin adjuvant QS-class",
      material_class: "adjuvant_biologic",
      grade: "licensed GMP",
      compendia: [],
      sourcing_mode: "access_led",
    };
    expect(specPrefilter(sap, { ...sap, external_id: "MAT-SAP-AN", grade: "development" }).match).toBe("not_equivalent");
  });
  it("different substance is not equivalent", () => {
    expect(specPrefilter(sucInj, { ...sucInj, external_id: "MAT-TRE", substance: "trehalose" }).match).toBe("not_equivalent");
  });
});
