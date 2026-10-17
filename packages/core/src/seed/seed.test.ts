import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createStore, filePersistence, openStore } from "../store.ts";
import * as T from "../types.ts";
import { generateSeed } from "./generate.ts";
import { mulberry32 } from "./prng.ts";

const seed = generateSeed();
const hash = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");

describe("seed", () => {
  it("mulberry32 is deterministic", () => {
    const a = mulberry32(1729);
    const b = mulberry32(1729);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("is deterministic (same seed, same data)", () => {
    expect(hash(generateSeed())).toBe(hash(seed));
    expect(hash(generateSeed(7))).not.toBe(hash(seed));
  });

  it("snapshot of shape and content hash", () => {
    expect({
      sites: seed.sites.length,
      materials: seed.materials.length,
      suppliers: seed.suppliers.length,
      material_suppliers: seed.material_suppliers.length,
      lots: seed.lots.length,
      consumption: seed.consumption.length,
      rfqs: seed.rfqs.length,
      quotes: seed.quotes.length,
      sha256: hash(seed),
    }).toMatchSnapshot();
  });

  it("is roughly the planned scale", () => {
    expect(seed.sites).toHaveLength(8);
    expect(seed.suppliers).toHaveLength(30);
    expect(seed.materials.length).toBeGreaterThanOrEqual(55);
    expect(seed.material_suppliers.length).toBeGreaterThanOrEqual(110);
    expect(seed.lots.length).toBeGreaterThanOrEqual(350);
    expect(seed.rfqs).toHaveLength(101);
  });

  it("validates against the Zod contract", () => {
    seed.sites.forEach((x) => T.Site.parse(x));
    seed.materials.forEach((x) => T.Material.parse(x));
    seed.suppliers.forEach((x) => T.Supplier.parse(x));
    seed.material_suppliers.forEach((x) => T.MaterialSupplier.parse(x));
    seed.lots.forEach((x) => T.Lot.parse(x));
    seed.consumption.forEach((x) => T.Consumption.parse(x));
    seed.rfqs.forEach((x) => T.RFQ.parse(x));
    seed.quotes.forEach((x) => T.Quote.parse(x));
    seed.products.forEach((x) => T.Product.parse(x));
    seed.boms.forEach((x) => T.BillOfMaterials.parse(x));
  });

  it("references resolve", () => {
    const mats = new Set(seed.materials.map((m) => m.external_id));
    const sites = new Set(seed.sites.map((s) => s.external_id));
    const sups = new Set(seed.suppliers.map((s) => s.external_id));
    for (const l of seed.lots) expect(mats.has(l.material_id) && sites.has(l.site_id)).toBe(true);
    for (const l of seed.material_suppliers) expect(mats.has(l.material_id) && sups.has(l.supplier_id)).toBe(true);
    for (const b of seed.boms) for (const li of b.line_items) expect(mats.has(li.material_external_id)).toBe(true);
    const rfqIds = new Set(seed.rfqs.map((r) => r.external_id));
    for (const q of seed.quotes) expect(rfqIds.has(q.rfq_id)).toBe(true);
  });

  it("hero lots are exact", () => {
    const lots = seed.lots.filter((l) => l.material_id === "MAT-SUC-INJ" && l.site_id === "SITE-GHE");
    const sum = (s: string) => lots.filter((l) => l.status === s).reduce((a, l) => a + l.qty, 0);
    expect(sum("released")).toBe(120);
    expect(sum("quarantined")).toBe(30);
    expect(seed.consumption.find((c) => c.material_id === "MAT-SUC-INJ" && c.site_id === "SITE-GHE")).toMatchObject({
      daily_rate: 5,
      lead_time_days: 42,
      safety_days: 14,
    });
  });

  it("adjuvant prices are null with an RFQ reason", () => {
    const adj = new Set(seed.materials.filter((m) => m.material_class === "adjuvant_biologic").map((m) => m.external_id));
    const links = seed.material_suppliers.filter((l) => adj.has(l.material_id));
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) {
      expect(l.price_low).toBeNull();
      expect(l.rfq_reason).toBeTruthy();
    }
  });

  it("development-stage inhaled API source is technically_suitable only", () => {
    const dev = seed.material_suppliers.filter((l) => l.supply_stage === "development" && l.material_id === "MAT-UMEC");
    expect(dev).toHaveLength(1);
    expect(dev[0]?.qualification_state).toBe("technically_suitable");
  });

  it("polysorbate 80 suppliers differ on CEP", () => {
    const ps = seed.material_suppliers.filter((l) => l.material_id === "MAT-PS80-SR");
    expect(ps.filter((l) => l.cep).length).toBe(2);
    expect(ps.filter((l) => !l.cep).length).toBe(2);
  });

  it("no open seeded RFQ on scenario pairs; next RFQ is RFQ-102", () => {
    const open = seed.rfqs.filter((r) => r.status === "sent" || r.status === "quoted" || r.status === "draft");
    expect(open.some((r) => r.material_id === "MAT-SUC-INJ" && r.site_id === "SITE-GHE")).toBe(false);
    expect(createStore(seed).nextRfqId()).toBe("RFQ-102");
  });
});

describe("store", () => {
  it("mutators assign ids and snapshot/load round-trips", () => {
    const store = createStore();
    const rfq = store.addRFQ({ material_id: "MAT-SUC-INJ", site_id: "SITE-GHE", qty: 300, need_by: "2026-12-01", status: "draft", mission_id: null });
    expect(rfq.external_id).toBe("RFQ-102");
    const m = store.addMission({ trigger: "breach", material_id: "MAT-SUC-INJ", site_id: "SITE-GHE", status: "planning" });
    expect(m.id).toBe("MSN-0001");
    store.updateRFQ("RFQ-102", { status: "sent", mission_id: m.id });
    const snap = store.snapshot();
    const other = createStore();
    other.load(JSON.stringify(snap));
    expect(other.rfq("RFQ-102")?.status).toBe("sent");
    expect(other.nextRfqId()).toBe("RFQ-103");
  });

  it("advanceDay burns released stock FEFO and never touches quarantine", () => {
    const store = createStore();
    store.advanceDay(2);
    const lots = store.lots({ material_id: "MAT-SUC-INJ", site_id: "SITE-GHE" });
    expect(lots.filter((l) => l.status === "released").reduce((s, l) => s + l.qty, 0)).toBe(110);
    expect(lots.filter((l) => l.status === "quarantined").reduce((s, l) => s + l.qty, 0)).toBe(30);
    expect(store.today()).toBe("2026-10-19");
  });

  it("file persistence saves and reloads", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "supply-agent-")), "state.json");
    const p = filePersistence(path);
    expect(await p.load()).toBeNull();
    const store = createStore();
    store.addMission({ trigger: "test", material_id: null, site_id: null, status: "running" });
    await p.save(store.snapshot());
    const reopened = await openStore(p);
    expect(reopened.missions()).toHaveLength(1);
  });
});
