import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pubchemImageUrl, pubchemLookup, pubchemNameCandidates, parseGhs } from "./pubchem.ts";
import { createStore } from "./store.ts";
import { fakeFetch, type FakeFetchLog } from "./testing/fake-fetch.ts";
import { runTool, toolsByName, type ToolCtx } from "./tools/index.ts";

const sucrose = { external_id: "MAT-SUC-INJ", substance: "sucrose", material_class: "compendial_excipient" as const, salt_form: null };

describe("PubChem client (injected fetch, offline)", () => {
  it("found: properties, CAS from synonyms, GHS summary and image URL", async () => {
    const log: FakeFetchLog = { calls: [] };
    const r = await pubchemLookup(sucrose, { fetchImpl: fakeFetch(log) });
    expect(r.status).toBe("found");
    if (r.status !== "found") return;
    expect(r.compound).toMatchObject({
      cid: 5988,
      molecular_formula: "C12H22O11",
      molecular_weight: 342.3,
      xlogp: -3.7,
      cas: ["57-50-1", "8030-20-7"],
      image_url: "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/5988/PNG",
    });
    expect(r.compound.smiles).toContain("C(C1C(");
    expect(r.compound.ghs).toMatchObject({ classification_note: "Not Classified", hazard_statements: [] });
    expect(log.calls.map((c) => c.url)).toEqual(
      expect.arrayContaining([expect.stringContaining("/compound/name/sucrose/property/"), expect.stringContaining("/cid/5988/synonyms/JSON")]),
    );
  });

  it("no CID for polymers/mixtures, with an explanation; biologics are not looked up", async () => {
    const log: FakeFetchLog = { calls: [] };
    const ps = await pubchemLookup({ external_id: "MAT-PS80-SR", substance: "polysorbate 80", material_class: "lipid_surfactant" }, { fetchImpl: fakeFetch(log) });
    expect(ps.status).toBe("no_cid");
    if (ps.status === "no_cid") expect(ps.explanation).toMatch(/polymer or mixture/);
    const before = log.calls.length;
    const adj = await pubchemLookup({ external_id: "MAT-SAP-QS", substance: "saponin adjuvant QS-class", material_class: "adjuvant_biologic" }, { fetchImpl: fakeFetch(log) });
    expect(adj.status).toBe("not_applicable");
    expect(log.calls.length).toBe(before);
  });

  it("network errors are reported, never thrown", async () => {
    const failing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const r = await pubchemLookup(sucrose, { fetchImpl: failing });
    expect(r.status).toBe("error");
  });

  it("name candidates and GHS parsing", () => {
    expect(pubchemNameCandidates({ external_id: "MAT-HIS-HCL", substance: "histidine", salt_form: "monohydrochloride monohydrate" })[0]).toBe("L-histidine monohydrochloride monohydrate");
    expect(pubchemNameCandidates({ external_id: "MAT-X", substance: "glycerol" })).toEqual(["glycerol"]);
    expect(pubchemImageUrl(5988)).toBe("https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/5988/PNG");
    const ghs = parseGhs({
      Record: {
        Section: [
          {
            Information: [
              { Name: "Pictogram(s)", Value: { StringWithMarkup: [{ String: " ", Markup: [{ Extra: "Corrosive" }] }] } },
              { Name: "Signal", Value: { StringWithMarkup: [{ String: "Danger" }] } },
              { Name: "GHS Hazard Statements", Value: { StringWithMarkup: [{ String: "H314 (99.8%): Causes severe skin burns and eye damage [Danger Skin corrosion]" }] } },
            ],
          },
        ],
      },
    });
    expect(ghs).toEqual({ signal_word: "Danger", pictograms: ["Corrosive"], hazard_statements: ["H314: Causes severe skin burns and eye damage"], classification_note: null });
  });
});

describe("material_dossier tool", () => {
  let log: FakeFetchLog;
  beforeEach(() => {
    log = { calls: [] };
    vi.stubGlobal("fetch", fakeFetch(log));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("combines PubChem with our spec and approved suppliers; caches on the board", async () => {
    const store = createStore();
    const ctx: ToolCtx = { organizationId: "org_corvane", role: "planner", filters: {}, store };
    const out = await runTool(toolsByName["material_dossier"]!, ctx, { material_id: "MAT-SUC-INJ" });
    expect(out).toMatchObject({ pubchem_status: "found", cid: 5988, molecular_formula: "C12H22O11", cached: false });
    expect(out.structure_image_url).toBe("https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/5988/PNG");
    expect((out.spec as { grade: string; qc_release_days: number }).grade).toBe("parenteral low-endotoxin");
    expect((out.spec as { qc_release_days: number }).qc_release_days).toBe(7);
    expect((out.approved_suppliers as unknown[]).length).toBeGreaterThanOrEqual(3);
    expect(store.boardItems().map((b) => b.kind).sort()).toEqual(["material_dossier", "structure_image"]);
    const calls = log.calls.length;
    const again = await runTool(toolsByName["material_dossier"]!, ctx, { material_id: "MAT-SUC-INJ" });
    expect(again.cached).toBe(true);
    expect(log.calls.length).toBe(calls);
    expect(store.boardItems()).toHaveLength(2);
  });

  it("adjuvant: explains why there is no CID, still returns the spec", async () => {
    const store = createStore();
    const ctx: ToolCtx = { organizationId: "org_corvane", role: "planner", filters: {}, store };
    const out = await runTool(toolsByName["material_dossier"]!, ctx, { material_id: "MAT-SAP-QS" });
    expect(out.ingestion_status).toBe("ok");
    expect(out.pubchem_status).toBe("not_applicable");
    expect(out.cid).toBeNull();
    expect(String(out.explanation)).toMatch(/licen/);
  });
});
