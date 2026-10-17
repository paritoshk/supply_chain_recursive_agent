import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isApproved } from "../logic/index.ts";
import { createStore } from "../store.ts";
import { fakeFetch } from "../testing/fake-fetch.ts";
import { ToolOutput } from "../types.ts";
import { allTools, runTool, toolsByName, type ToolCtx } from "./index.ts";

const store = createStore();
const ctx: ToolCtx = { organizationId: "org_corvane", role: "planner", filters: {}, store };
/** Ids that exist in the store right now (tools may create RFQs, quotes, missions, findings, negotiations). */
const knownIds = () =>
  new Set<string>([
    ...store.materials().map((x) => x.external_id),
    ...store.sites().map((x) => x.external_id),
    ...store.suppliers().map((x) => x.external_id),
    ...store.materialSuppliers().map((x) => x.external_id),
    ...store.lots().map((x) => x.external_id),
    ...store.rfqs().map((x) => x.external_id),
    ...store.quotes().map((x) => x.external_id),
    ...store.missions().map((x) => x.id),
    ...store.findings().map((x) => x.id ?? ""),
    ...store.negotiations().map((x) => x.id),
    ...store.productionLines().map((x) => x.external_id),
    ...store.workOrders().map((x) => x.external_id),
    ...store.supplierOutcomes().map((x) => x.id),
    ...store.lessons().map((x) => x.id),
  ]);
/** Live web sources cite URLs instead of external_ids. */
const URL_SOURCES = new Set(["you.com", "you.com/contents", "openfda.drug_shortages", "openfda.drug_enforcement", "pubchem"]);
const run = (name: string, args: unknown, c: ToolCtx = ctx) => runTool(toolsByName[name]!, c, args);

beforeAll(() => {
  vi.stubGlobal("fetch", fakeFetch());
  vi.stubEnv("YOU_DOT_COM_API_KEY", "test-key");
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// An open seeded RFQ (not the hero) for the negotiation tools' contract run.
const openRfq = store.rfqs().find((r) => r.status === "sent" && store.materialSuppliers({ material_id: r.material_id }).some((l) => isApproved(l.qualification_state) && l.price_low != null))!;
const openRfqSupplier = store.materialSuppliers({ material_id: openRfq.material_id }).find((l) => isApproved(l.qualification_state) && l.price_low != null)!.supplier_id;

const SAMPLE_ARGS: Record<string, unknown> = {
  low_stock_items: {},
  lookup_parts: { query: "sucrose" },
  inventory_value_summary: { group_by: "region" },
  cover_projection: { material_id: "MAT-SUC-INJ", site_id: "SITE-GHE" },
  find_suppliers: { material_id: "MAT-PS80-SR", include_candidates: true },
  match_spec: { material_id: "MAT-MAN-PAR" },
  compare_quotes: { rfq_id: "RFQ-090" },
  price_inventory: { material_id: "MAT-MAN-PAR", site_id: "SITE-COR" },
  propose_transfer: { material_id: "MAT-MAN-PAR", from_site_id: "SITE-COR" },
  discover_suppliers: { material_id: "MAT-SAP-QS" },
  check_regulatory: { substance: "polysorbate 80" },
  draft_rfq: { material_id: "MAT-SUC-INJ", site_id: "SITE-GHE", qty: 300, need_by: "2026-12-01" },
  collect_quotes: { rfq_id: "RFQ-102" },
  open_mission: { trigger: "breach", material_id: "MAT-SUC-INJ", site_id: "SITE-GHE" },
  record_finding: { headline: "x", severity: "action", detail: "y", cited_tool_calls: [] },
  notify_user: { body: "Reply APPROVE RFQ-102" },
  apply_approval: { rfq_id: "RFQ-102", decision: "APPROVE" },
  message_supplier: { rfq_id: openRfq.external_id, supplier_id: openRfqSupplier, message: "Please quote your best price and lead time." },
  accept_offer: { rfq_id: openRfq.external_id, supplier_id: openRfqSupplier },
  line_feasibility: { material_id: "MAT-SUC-INJ", site_id: "SITE-GHE", purchase: { qty: 210, lead_time_days: 36, supplier_id: "SUP-005" } },
  material_dossier: { material_id: "MAT-SUC-INJ" },
  record_delivery: { supplier_id: "SUP-005", material_id: "MAT-SUC-INJ", site_id: "SITE-GHE", promised_date: "2026-10-01", received_date: "2026-10-20", qc_passed: true },
  supplier_reliability: { material_id: "MAT-SUC-INJ", site_id: "SITE-GHE" },
};

describe("tool contract", () => {
  it("names are snake_case and unique; writers are non-idempotent", () => {
    expect(new Set(allTools.map((t) => t.name)).size).toBe(allTools.length);
    for (const t of allTools) expect(t.name).toMatch(/^[a-z]+(_[a-z]+)*$/);
    for (const n of ["draft_rfq", "collect_quotes", "open_mission", "record_finding", "notify_user", "apply_approval", "message_supplier", "accept_offer"]) {
      expect(toolsByName[n]?.idempotent).toBe(false);
    }
    for (const n of ["low_stock_items", "cover_projection", "find_suppliers", "compare_quotes", "price_inventory", "propose_transfer", "line_feasibility", "material_dossier"]) {
      expect(toolsByName[n]?.idempotent).toBe(true);
    }
  });

  it.each(allTools.map((t) => t.name))("%s returns a valid ToolOutput with external_id citations", async (name) => {
    const out = await run(name, SAMPLE_ARGS[name]);
    expect(() => ToolOutput.parse(out)).not.toThrow();
    expect(out.ingestion_status, `${name}: ${String(out.error ?? out.todo ?? "")}`).toBe("ok");
    expect(out.citations.length).toBeGreaterThan(0);
    const known = knownIds();
    for (const c of out.citations) {
      for (const id of c.ids) {
        if (URL_SOURCES.has(c.source)) expect(id, `${name}: ${c.source} cites a URL`).toMatch(/^https:\/\//);
        else expect(known.has(id), `${name}: unknown id ${id}`).toBe(true);
      }
    }
  });
});

describe("demo scenarios through tools", () => {
  it("hero: low_stock_items surfaces Ghent sucrose with 24 d cover / ROP 280 / action", async () => {
    const out = await run("low_stock_items", {});
    const items = out.items as Array<{ sku: string; warehouse_location: string; quantity_on_hand: number; reorder_point: number; attributes: Record<string, unknown> }>;
    const hero = items.find((i) => i.sku === "MAT-SUC-INJ" && i.warehouse_location === "SITE-GHE");
    expect(hero).toBeDefined();
    expect(hero!.quantity_on_hand).toBe(120);
    expect(hero!.reorder_point).toBe(280);
    expect(hero!.attributes.cover_days).toBe(24);
    expect(hero!.attributes.severity).toBe("action");
    expect(hero!.attributes.quarantined_qty).toBe(30);
  });

  it("hero: cover_projection", async () => {
    const out = await run("cover_projection", { material_id: "MAT-SUC-INJ", site_id: "SITE-GHE" });
    const p = out.position as Record<string, unknown>;
    expect(p).toMatchObject({ cover_days: 24, reorder_point: 280, safety_stock: 70, severity: "action", released_qty: 120, quarantined_qty: 30 });
    expect(out.stockout_date).toBe("2026-11-10");
    expect(out.reorder_needed).toBe(true);
  });

  it("hero: three approved sucrose suppliers available for personas", async () => {
    const out = await run("find_suppliers", { material_id: "MAT-SUC-INJ" });
    expect((out.approved as unknown[]).length).toBeGreaterThanOrEqual(3);
  });

  it("filters narrow results", async () => {
    const all = (await run("low_stock_items", {})).items as unknown[];
    const eu = (await run("low_stock_items", {}, { ...ctx, filters: { region: "EU" } })).items as Array<{ warehouse_location: string }>;
    expect(eu.length).toBeLessThan(all.length);
    expect(eu.every((i) => ["SITE-GHE", "SITE-LYO", "SITE-COR"].includes(i.warehouse_location))).toBe(true);
  });

  it("guardrail: saponin analogue is not equivalent; adjuvant is short at Ghent", async () => {
    const m = await run("match_spec", { material_id: "MAT-SAP-QS" });
    const r = (m.results as Array<{ candidate_id: string; match: string }>).find((x) => x.candidate_id === "MAT-SAP-AN");
    expect(r?.match).toBe("not_equivalent");
    expect(m.equivalent_ids).toEqual([]);
    const c = await run("cover_projection", { material_id: "MAT-SAP-QS", site_id: "SITE-GHE" });
    expect((c.position as { severity: string }).severity).toBe("action");
  });

  it("pricing: Cork mannitol prefers a transfer to Raleigh, with a resale alternative", async () => {
    const out = await run("price_inventory", { material_id: "MAT-MAN-PAR", site_id: "SITE-COR" });
    expect(out.recommendation).toBe("transfer");
    expect(out.transfer_to).toContain("SITE-RAL");
    expect(out.resale_unit_price).not.toBeNull();
    expect(out.expiry_discount).toBeGreaterThan(0);
    const t = await run("propose_transfer", { material_id: "MAT-MAN-PAR", from_site_id: "SITE-COR" });
    expect((t.proposal as { to_site_id: string; qty: number }).to_site_id).toBe("SITE-RAL");
    expect((t.proposal as { qty: number }).qty).toBe(302);
  });

  it("ad-hoc: polysorbate 80 suppliers with a CEP", async () => {
    const out = await run("find_suppliers", { material_id: "MAT-PS80-SR", require_cep: true });
    const approved = out.approved as Array<{ cep: boolean }>;
    expect(approved).toHaveLength(2);
    expect(approved.every((a) => a.cep)).toBe(true);
  });

  it("compare_quotes keeps unpriced quotes null", async () => {
    const adjRfq = store.rfqs().find((r) => r.material_id === "MAT-SAP-QS" || r.material_id === "MAT-MPL");
    if (!adjRfq) return;
    const out = await run("compare_quotes", { rfq_id: adjRfq.external_id });
    for (const q of out.quotes as Array<{ landed_usd_per_unit: number | null; reason: string | null }>) {
      expect(q.landed_usd_per_unit).toBeNull();
      expect(q.reason).toBeTruthy();
    }
  });

  it("unknown ids return not_ingested, not invented data", async () => {
    const out = await run("cover_projection", { material_id: "MAT-NOPE", site_id: "SITE-GHE" });
    expect(out.ingestion_status).toBe("not_ingested");
  });
});
