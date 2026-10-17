import { describe, expect, it } from "vitest";
import { generateSeed } from "../seed/generate.ts";
import { generateProduction } from "../seed/production.ts";
import { createStore } from "../store.ts";
import { runTool, toolsByName, type ToolCtx } from "../tools/index.ts";
import * as T from "../types.ts";
import {
  changeControlAssessment,
  changeControlRequired,
  documentsRequired,
  isColdChain,
  qcReleaseDays,
  simulateBatchFeasibility,
  transferReleaseDays,
  transferRequirements,
  tseStatementRelevant,
} from "./index.ts";

describe("QA rules", () => {
  it("qcReleaseDays by material class", () => {
    expect(qcReleaseDays("compendial_excipient")).toBe(7);
    expect(qcReleaseDays("specialty_excipient")).toBe(10);
    expect(qcReleaseDays("lipid_surfactant")).toBe(12);
    expect(qcReleaseDays("small_molecule_api")).toBe(14);
    expect(qcReleaseDays("adjuvant_biologic")).toBe(21);
    expect(qcReleaseDays("primary_packaging")).toBe(5);
    expect(transferReleaseDays("compendial_excipient")).toBeLessThan(qcReleaseDays("compendial_excipient"));
  });

  it("change control: new source for the site, or not yet released for use", () => {
    expect(changeControlRequired({ supplier_id: "SUP-003", qualification_state: "released_for_use", established_supplier_ids: ["SUP-003"] })).toBe(false);
    const newSource = changeControlAssessment({ supplier_id: "SUP-005", qualification_state: "released_for_use", established_supplier_ids: ["SUP-003"] });
    expect(newSource.required).toBe(true);
    expect(newSource.reasons[0]).toMatch(/new source/);
    const notReleased = changeControlAssessment({ supplier_id: "SUP-003", qualification_state: "quality_approved", established_supplier_ids: ["SUP-003"] });
    expect(notReleased.required).toBe(true);
    expect(notReleased.reasons[0]).toMatch(/quality_approved/);
  });

  it("cold chain, TSE relevance, documents and transfer requirements", () => {
    expect(isColdChain("2-8 C, under nitrogen")).toBe(true);
    expect(isColdChain("-20 C")).toBe(true);
    expect(isColdChain("15-25 C, dry, protected from light")).toBe(false);
    expect(isColdChain("below 25 C, low humidity")).toBe(false);
    expect(tseStatementRelevant("lactose")).toBe(true);
    expect(tseStatementRelevant("sucrose", "compendial_excipient")).toBe(false);
    expect(tseStatementRelevant("saponin adjuvant QS-class", "adjuvant_biologic")).toBe(true);
    const docs = documentsRequired({ substance: "polysorbate 80", material_class: "lipid_surfactant", storage: "2-8 C, under nitrogen", dmf: true, cep: true, supplier_id: "SUP-022", change_control_required: true, transfer: true });
    expect(docs).toEqual(
      expect.arrayContaining([
        "Certificate of Analysis (CoA)",
        "Certificate of Conformance (CoC)",
        "TSE/BSE statement",
        "US DMF reference / letter of authorisation (SUP-022)",
        "CEP reference (SUP-022)",
        "Change control record + comparability assessment (new source)",
        "Temperature data-logger record for the shipment",
      ]),
    );
    const tr = transferRequirements({ substance: "squalene", material_class: "lipid_surfactant", storage: "2-8 C, under nitrogen" });
    expect(tr.cold_chain).toBe(true);
    expect(tr.release_days).toBe(3);
    expect(tr.documents.some((d) => /data-logger/.test(d))).toBe(true);
  });
});

describe("simulateBatchFeasibility", () => {
  const batch = (n: number, day: number, need: number) => ({
    batch_no: `B${n}`,
    work_order_id: `WO-${n}`,
    line_id: "L1",
    line_name: "Line 1",
    product_id: "P",
    start_date: `2026-10-${String(17 + day).padStart(2, "0")}`,
    material_needed: need,
  });
  it("infeasible batches draw nothing; receipts count from arrival + release days", () => {
    const r = simulateBatchFeasibility({
      today: "2026-10-17",
      horizon_days: 10,
      released_lots: [{ external_id: "LOT-1", qty: 10, expiry_date: "2027-01-01" }],
      batches: [batch(1, 1, 8), batch(2, 3, 8), batch(3, 6, 8), batch(4, 7, 8)],
      receipts: [{ kind: "purchase", qty: 20, arrives_in_days: 4, release_days: 3 }],
    });
    expect(r.rows.map((x) => x.feasible)).toEqual([true, false, false, true]);
    expect(r.first_infeasible_batch?.batch_no).toBe("B2");
    expect(r.first_infeasible_batch?.available_at_start).toBe(2);
    expect(r.receipts[0]?.release_date).toBe("2026-10-24");
    expect(r.batches_at_risk).toBe(2);
  });
  it("expired stock is removed and batches outside the horizon are ignored", () => {
    const r = simulateBatchFeasibility({
      today: "2026-10-17",
      horizon_days: 5,
      released_lots: [{ external_id: "LOT-1", qty: 50, expiry_date: "2026-10-19" }],
      batches: [batch(1, 3, 5), batch(2, 9, 5)],
    });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.feasible).toBe(false);
    expect(r.expired_qty).toBe(50);
  });
});

describe("production schedule seed", () => {
  const seed = generateSeed();
  const prod = generateProduction(seed);
  it("is deterministic and validates against the contract", () => {
    expect(JSON.stringify(generateProduction(generateSeed()))).toBe(JSON.stringify(prod));
    prod.production_lines.forEach((l) => T.ProductionLine.parse(l));
    prod.work_orders.forEach((w) => {
      T.BatchWorkOrder.parse(w);
      T.WorkOrder.parse(w);
    });
    const lineIds = new Set(prod.production_lines.map((l) => l.external_id));
    expect(prod.work_orders.every((w) => lineIds.has(w.line_id))).toBe(true);
    expect(new Set(prod.work_orders.map((w) => w.external_id)).size).toBe(prod.work_orders.length);
  });
  it("Ghent VX-201 lines consume sucrose and saponin; Raleigh lines consume mannitol", () => {
    const uses = (site: string, mat: string) =>
      new Set(prod.work_orders.filter((w) => w.site_id === site && w.materials.some((m) => m.material_external_id === mat)).map((w) => w.line_id));
    expect([...uses("SITE-GHE", "MAT-SUC-INJ")].sort()).toEqual(["LINE-GHE-ANT1", "LINE-GHE-FRM1"]);
    expect([...uses("SITE-GHE", "MAT-SAP-QS")]).toEqual(["LINE-GHE-FRM1"]);
    expect(uses("SITE-RAL", "MAT-MAN-PAR").size).toBe(2);
  });
  it("hero schedule matches the 5 kg/day rate (14 kg + 21 kg per week)", () => {
    const suc = prod.work_orders.filter((w) => w.site_id === "SITE-GHE").flatMap((w) => w.materials.filter((m) => m.material_external_id === "MAT-SUC-INJ").map((m) => ({ line: w.line_id, qty: m.qty_per_batch })));
    expect(new Set(suc.filter((x) => x.line === "LINE-GHE-ANT1").map((x) => x.qty))).toEqual(new Set([14]));
    expect(new Set(suc.filter((x) => x.line === "LINE-GHE-FRM1").map((x) => x.qty))).toEqual(new Set([21]));
  });
  it("older snapshots without production/board collections are backfilled", () => {
    const store = createStore();
    const snap = store.snapshot() as unknown as Record<string, unknown>;
    delete snap.production_lines;
    delete snap.work_orders;
    delete snap.board;
    const other = createStore();
    other.load(JSON.stringify(snap));
    expect(other.productionLines().length).toBe(prod.production_lines.length);
    expect(other.boardItems()).toEqual([]);
  });
});

describe("line_feasibility (hero: Ghent sucrose)", () => {
  const mk = () => {
    const store = createStore();
    const ctx: ToolCtx = { organizationId: "org_corvane", role: "planner", filters: {}, store };
    return { store, run: (args: unknown) => runTool(toolsByName["line_feasibility"]!, ctx, args) };
  };

  it("no action: first infeasible batch is the formulation batch on the stockout date", async () => {
    const { run } = mk();
    const out = await run({ material_id: "MAT-SUC-INJ", site_id: "SITE-GHE" });
    expect(out.released_qty).toBe(120);
    expect(out.quarantined_qty_excluded).toBe(30);
    expect(out.batches_total).toBe(18);
    expect(out.batches_at_risk).toBe(11);
    expect(out.first_infeasible_batch).toMatchObject({
      batch_no: "VX201-GHE-FRM1-004",
      line_id: "LINE-GHE-FRM1",
      start_date: "2026-11-10",
      material_needed: 21,
      available_at_start: 1,
    });
    const batches = out.batches as Array<{ batch_no: string; feasible: boolean }>;
    expect(batches.filter((b) => b.feasible).map((b) => b.batch_no)).toEqual([
      "VX201-GHE-ANT1-001",
      "VX201-GHE-FRM1-001",
      "VX201-GHE-ANT1-002",
      "VX201-GHE-FRM1-002",
      "VX201-GHE-ANT1-003",
      "VX201-GHE-FRM1-003",
      "VX201-GHE-ANT1-004",
    ]);
  });

  it("agent plan (transfer 160 kg day 7 + purchase 210 kg, 36-day supplier): every batch feasible, QA flags new source", async () => {
    const { run, store } = mk();
    const out = await run({
      material_id: "MAT-SUC-INJ",
      site_id: "SITE-GHE",
      transfer: { qty: 160, arrives_in_days: 7, from_site_id: "SITE-KOP" },
      purchase: { qty: 210, lead_time_days: 36, supplier_id: "SUP-005" },
      mission_id: "MSN-TEST",
    });
    expect(out.all_feasible).toBe(true);
    expect(out.batches_at_risk).toBe(0);
    expect(out.first_infeasible_batch).toBeNull();
    const receipts = out.receipts as Array<{ kind: string; release_day: number; release_date: string }>;
    expect(receipts.map((r) => [r.kind, r.release_day])).toEqual([
      ["transfer", 9],
      ["purchase", 43],
    ]);
    const qa = out.qa_packet as { qc_release_days: number; change_control_required: boolean; documents_required: string[]; established_supplier_ids: string[] };
    expect(qa.qc_release_days).toBe(7);
    expect(qa.change_control_required).toBe(true);
    expect(qa.established_supplier_ids).toEqual(["SUP-003"]);
    expect(qa.documents_required).toContain("Certificate of Analysis (CoA)");
    // board: one feasibility report + one QA packet per mission scope (upserted on re-run)
    await run({ material_id: "MAT-SUC-INJ", site_id: "SITE-GHE", purchase: { qty: 210, lead_time_days: 36, supplier_id: "SUP-005" }, mission_id: "MSN-TEST" });
    expect(store.boardItems({ mission_id: "MSN-TEST" }).map((b) => b.kind).sort()).toEqual(["feasibility_report", "qa_packet"]);
  });

  it("purchase only from the established supplier: no change control; QC release decides the late batches", async () => {
    const { run } = mk();
    const out = await run({ material_id: "MAT-SUC-INJ", site_id: "SITE-GHE", purchase: { qty: 370, lead_time_days: 42, supplier_id: "SUP-003" }, record: false });
    expect((out.qa_packet as { change_control_required: boolean }).change_control_required).toBe(false);
    // lands day 42 + 7 QC = day 49 (2026-12-05): batches from 2026-11-10 to 2026-12-01 are at risk
    expect(out.first_infeasible_batch).toMatchObject({ start_date: "2026-11-10" });
    const late = (out.batches as Array<{ start_date: string; feasible: boolean }>).filter((b) => b.start_date >= "2026-12-05");
    expect(late.every((b) => b.feasible)).toBe(true);
  });

  it("no scheduled consumption: zero batches, still a valid packet", async () => {
    const { run } = mk();
    const out = await run({ material_id: "MAT-MAN-PAR", site_id: "SITE-COR", record: false });
    expect(out.batches_total).toBe(0);
    expect(out.all_feasible).toBe(true);
  });
});
