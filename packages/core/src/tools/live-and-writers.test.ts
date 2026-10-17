import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "../store.ts";
import { fakeFetch, type FakeFetchLog } from "../testing/fake-fetch.ts";
import { runTool, toolsByName, type ToolCtx } from "./index.ts";
import {
  complianceSignals,
  discoveryQueries,
  enforcementUrl,
  mapYouResults,
  nameFromResult,
  shortageUrl,
  summarizeRegulatory,
} from "./stubs.ts";

let log: FakeFetchLog;
const mk = () => {
  const store = createStore();
  const ctx: ToolCtx = { organizationId: "org_corvane", role: "planner", filters: {}, store };
  return { store, ctx, run: (name: string, args: unknown) => runTool(toolsByName[name]!, ctx, args) };
};

beforeEach(() => {
  log = { calls: [] };
  vi.stubGlobal("fetch", fakeFetch(log));
  vi.stubEnv("YOU_DOT_COM_API_KEY", "test-key");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("discover_suppliers (You.com)", () => {
  it("pure helpers", () => {
    const qs = discoveryQueries({ substance: "sucrose", grade: "parenteral low-endotoxin", compendia: ["Ph. Eur.", "USP-NF"], sourcing_mode: "spec_led" });
    expect(qs).toHaveLength(2);
    expect(qs[0]).toBe("sucrose parenteral low-endotoxin GMP manufacturer DMF CEP");
    expect(discoveryQueries({ substance: "x", grade: "y", compendia: [], sourcing_mode: "spec_led" }, "custom q")[0]).toBe("custom q");
    expect(nameFromResult("Low Endotoxin Sucrose | ExcipientMaker GmbH", "excipientmaker.com")).toBe("ExcipientMaker GmbH");
    expect(nameFromResult("Some long generic page title with many words", "acme-excipients.com")).toBe("Acme Excipients");
    expect(nameFromResult("Pfanstiehl | Sucrose", "pfanstiehl.com")).toBe("Pfanstiehl");
    expect(complianceSignals("IPEC-GMP, US DMF, CEP, Ph. Eur., low endotoxin")).toEqual(expect.arrayContaining(["GMP", "US DMF", "CEP", "Ph. Eur.", "low endotoxin"]));
    const mapped = mapYouResults(
      [
        { query: "q", result: { url: "https://a.example.com/x", title: "A" } },
        { query: "q", result: { url: "https://a.example.com/y", title: "A again" } },
        { query: "q", result: { url: "https://a-example-com.translate.goog/x", title: "proxy" } },
        { query: "q", result: { url: "https://en.wikipedia.org/wiki/X", title: "wiki" } },
        { query: "q", result: { url: "https://www.pharmacompass.com/x", title: "PharmaCompass" } },
      ],
      10,
    );
    expect(mapped.map((c) => c.href)).toEqual(["https://a.example.com/x", "https://www.pharmacompass.com/x"]);
    expect(mapped[1]!.kind).toBe("directory");
  });

  it("returns discovery candidates only, with URL citations and page signals", async () => {
    const { run } = mk();
    const out = await run("discover_suppliers", { material_id: "MAT-SUC-INJ", max_results: 5 });
    expect(out.ingestion_status).toBe("ok");
    const cands = out.candidates as Array<{ label: string; href: string; kind: string; page?: { read: boolean; signals: string[] } }>;
    expect(cands.length).toBe(2);
    expect(cands.every((c) => c.label === "discovery_candidate")).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(/"(quality_approved|released_for_use)"/);
    const site = cands.find((c) => c.kind === "supplier_site")!;
    expect(site.page?.read).toBe(true);
    expect(site.page?.signals).toEqual(expect.arrayContaining(["GMP", "CEP"]));
    expect(out.citations.every((c) => c.href?.startsWith("https://"))).toBe(true);
    expect(log.calls.filter((c) => c.url.includes("/v1/search"))).toHaveLength(2);
    expect(log.calls.some((c) => c.url.includes("/v1/contents") && c.method === "POST")).toBe(true);
  });

  it("is feature_disabled without a key and not_ingested for unknown materials", async () => {
    const { run } = mk();
    expect((await run("discover_suppliers", { material_id: "MAT-NOPE" })).ingestion_status).toBe("not_ingested");
    vi.stubEnv("YOU_DOT_COM_API_KEY", "");
    expect((await run("discover_suppliers", { material_id: "MAT-SUC-INJ" })).ingestion_status).toBe("feature_disabled");
  });
});

describe("check_regulatory (openFDA)", () => {
  it("builds encoded search URLs", () => {
    expect(decodeURIComponent(shortageUrl("sodium chloride")).replace(/\+/g, " ")).toContain('generic_name:"sodium chloride" OR openfda.substance_name:"SODIUM CHLORIDE"');
    expect(decodeURIComponent(enforcementUrl("polysorbate 80", "Acme")).replace(/\+/g, " ")).toContain('product_description:"polysorbate 80" AND recalling_firm:"Acme"');
  });

  it("summarizes status counts with API citations", async () => {
    const { run } = mk();
    const out = await run("check_regulatory", { substance: "polysorbate 80" });
    expect(out.ingestion_status).toBe("ok");
    const sh = out.shortages as { total: number; status_counts: Record<string, number> };
    expect(sh.total).toBe(3);
    expect(sh.status_counts).toEqual({ Current: 2, Resolved: 1 });
    expect((out.enforcement as { classification_counts: Record<string, number> }).classification_counts).toEqual({ "Class II": 1, "Class III": 1 });
    expect(out.citations.map((c) => c.source)).toEqual(["openfda.drug_shortages", "openfda.drug_enforcement"]);
    expect(out.citations[0]!.href).toMatch(/^https:\/\/api\.fda\.gov\/drug\/shortages\.json\?/);
  });

  it("treats 404 as no matches", async () => {
    vi.stubGlobal("fetch", fakeFetch(log, { noMatches: true }));
    const { run } = mk();
    const out = await run("check_regulatory", { substance: "unobtainium" });
    expect(out.ingestion_status).toBe("ok");
    expect((out.shortages as { total: number }).total).toBe(0);
    expect(out.summary).toMatch(/No FDA drug-shortage records/);
    expect(summarizeRegulatory("x", { total: 0, results: [] }, { total: 0, results: [] })).toMatch(/No FDA enforcement/);
  });
});

describe("writing tools: hero RFQ flow", () => {
  it("open_mission dedupes; draft_rfq -> RFQ-102; collect -> approve drafts a PO from the best approved quote", async () => {
    const { store, run } = mk();
    const m1 = await run("open_mission", { trigger: "sentinel breach", material_id: "MAT-SUC-INJ", site_id: "SITE-GHE" });
    const m2 = await run("open_mission", { trigger: "again", material_id: "MAT-SUC-INJ", site_id: "SITE-GHE" });
    const missionId = (m1.mission as { id: string }).id;
    expect(m2.deduplicated).toBe(true);
    expect((m2.mission as { id: string }).id).toBe(missionId);

    const r = await run("draft_rfq", { material_id: "MAT-SUC-INJ", site_id: "SITE-GHE", qty: 300, need_by: "2026-11-28", mission_id: missionId });
    expect((r.rfq as { external_id: string; status: string }).external_id).toBe("RFQ-102");
    expect((r.rfq as { status: string }).status).toBe("draft");
    const again = await run("draft_rfq", { material_id: "MAT-SUC-INJ", site_id: "SITE-GHE", qty: 300, need_by: "2026-11-28", mission_id: missionId });
    expect(again.deduplicated).toBe(true);

    // no quotes yet -> cannot approve
    expect((await run("apply_approval", { rfq_id: "RFQ-102", decision: "approve" })).ingestion_status).toBe("not_ingested");

    const cq = await run("collect_quotes", { rfq_id: "RFQ-102" });
    expect(cq.received).toBe(4);
    expect(cq.degraded).toBe(false);

    const details = await run("apply_approval", { rfq_id: "RFQ-102", decision: "DETAILS" });
    expect(details.changed).toBe(false);

    const ap = await run("apply_approval", { rfq_id: "RFQ-102", decision: "approve" });
    expect(ap.ingestion_status).toBe("ok");
    const po = ap.purchase_order as { status: string; quote_id: string; rfq_id: string; supplier_id: string };
    expect(po.status).toBe("draft");
    expect(po.rfq_id).toBe("RFQ-102");
    expect(store.rfq("RFQ-102")!.status).toBe("approved");
    // idempotent second approve
    const ap2 = await run("apply_approval", { rfq_id: "RFQ-102", decision: "APPROVE" });
    expect(ap2.changed).toBe(false);
    expect(store.purchaseOrders().filter((p) => p.rfq_id === "RFQ-102")).toHaveLength(1);
    // reject after approve is refused
    expect((await run("apply_approval", { rfq_id: "RFQ-102", decision: "reject" })).ingestion_status).toBe("not_ingested");

    const f = await run("record_finding", { headline: "RFQ-102 ready", severity: "action", detail: "3 quotes", cited_tool_calls: ["tu_1"], mission_id: missionId });
    expect((f.finding as { id: string }).id).toMatch(/^FND-/);
  });

  it("apply_approval refuses quotes from non-approved suppliers and supports quote_supplier_id", async () => {
    const { store, run } = mk();
    const rfq = store.addRFQ({ material_id: "MAT-SUC-INJ", site_id: "SITE-GHE", qty: 300, need_by: "2026-11-28", status: "quoted", mission_id: null });
    store.addQuote({ rfq_id: rfq.external_id, supplier_id: "SUP-NOT-LINKED", unit_price: 1, currency: "USD", incoterm: "DDP", freight: 0, testing_cost: 0, qty: 300, lead_time_days: 10, valid_until: "2026-12-01", simulated: true });
    const refused = await run("apply_approval", { rfq_id: rfq.external_id, decision: "APPROVE", quote_supplier_id: "SUP-NOT-LINKED" });
    expect(refused.ingestion_status).toBe("not_ingested");
    expect(store.rfq(rfq.external_id)!.status).toBe("quoted");
    const no = await run("apply_approval", { rfq_id: rfq.external_id, decision: "NO" });
    expect(store.rfq(rfq.external_id)!.status).toBe("rejected");
    expect(no.changed).toBe(true);
  });

  it("notify_user is a core no-op", async () => {
    const { store, run } = mk();
    const out = await run("notify_user", { body: "Reply APPROVE RFQ-102" });
    expect(out.delivered).toBe(false);
    expect(store.messages()).toHaveLength(0);
  });
});
