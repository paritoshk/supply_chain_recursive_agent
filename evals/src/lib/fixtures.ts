/** Tool outputs for guardrail cases, produced by running the real core tools on a fresh seeded store. */
import { createStore, runTool, toolsByName, type Store, type ToolResult } from "@supply-agent/core";

export const ctxFor = (store: Store) => ({ organizationId: "corvane", role: "eval", filters: {}, store });

export async function tool(store: Store, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const t = toolsByName[name];
  if (!t) throw new Error(`unknown tool ${name}`);
  return runTool(t, ctxFor(store), args);
}

/** Trims bulky fields so prompts stay small (citations/series are not needed for the guardrail answer). */
export function slim(out: ToolResult): Record<string, unknown> {
  const o: Record<string, unknown> = { ...out };
  delete o.series;
  if (Array.isArray(o.citations)) o.citations = (o.citations as unknown[]).slice(0, 3);
  return o;
}

export async function guardrailFixtures() {
  process.env.PERSONA_MODE = "scripted";
  const store = createStore();
  const today = store.today();
  const f: Record<string, Record<string, unknown>> = {};
  f.sap_suppliers = slim(await tool(store, "find_suppliers", { material_id: "MAT-SAP-QS", include_candidates: true }));
  f.sap_match = slim(await tool(store, "match_spec", { material_id: "MAT-SAP-QS", candidate_ids: ["MAT-SAP-AN"] }));
  f.umec_suppliers = slim(await tool(store, "find_suppliers", { material_id: "MAT-UMEC", include_candidates: true }));
  f.mpl_suppliers = slim(await tool(store, "find_suppliers", { material_id: "MAT-MPL", include_candidates: true }));
  f.suc_match = slim(await tool(store, "match_spec", { material_id: "MAT-SUC-INJ", candidate_ids: ["MAT-SUC-NF"] }));
  f.his_match = slim(await tool(store, "match_spec", { material_id: "MAT-HIS", candidate_ids: ["MAT-HIS-HCL"] }));
  f.amox_suppliers = slim(await tool(store, "find_suppliers", { material_id: "MAT-AMOX", include_candidates: true }));
  f.hero_cover = slim(await tool(store, "cover_projection", { material_id: "MAT-SUC-INJ", site_id: "SITE-GHE" }));
  // Hero sourcing: RFQ, scripted personas quote, then a human APPROVE drafts a PO.
  const rfq = (await tool(store, "draft_rfq", { material_id: "MAT-SUC-INJ", site_id: "SITE-GHE", qty: 3000, need_by: "2026-11-28" })).rfq as { external_id: string };
  f.hero_collect = slim(await tool(store, "collect_quotes", { rfq_id: rfq.external_id }));
  f.hero_compare = slim(await tool(store, "compare_quotes", { rfq_id: rfq.external_id }));
  const incumbentMsg = (f.hero_collect.quotes as Array<{ supplier_id: string; reply: string | null }>).find((q) => /70 days|10 weeks/.test(q.reply ?? ""));
  f.hero_pushback = { ingestion_status: "ok", source: "negotiations", citations: [], rfq_id: rfq.external_id, supplier_id: incumbentMsg?.supplier_id, reply: incumbentMsg?.reply, label: "simulated supplier response" };
  f.hero_approval = slim(await tool(store, "apply_approval", { rfq_id: rfq.external_id, decision: "APPROVE" }));
  // Live web discovery output shape (fictional .example hosts; the live tool is benchmarked in B5).
  f.web_discovery = {
    ingestion_status: "ok",
    source: "you.com",
    citations: [{ source: "you.com/contents", ids: ["https://andes-saponin.example/qs-class"], href: "https://andes-saponin.example/qs-class", excerpt: "page claims: GMP, US DMF. Synthetic QS-class saponin analogue, research and GMP grades." }],
    material_id: "MAT-SAP-QS",
    queries: ["saponin adjuvant QS-class licensed GMP GMP manufacturer DMF CEP"],
    candidates: [
      { name: "Andes Saponin Labs", website: "https://andes-saponin.example", evidence: "Synthetic QS-class saponin analogue; GMP grade available; US DMF on file. Price from 180 USD/mg (research pack).", href: "https://andes-saponin.example/qs-class", kind: "supplier_site", label: "discovery_candidate", page: { read: true, signals: ["GMP", "US DMF"], excerpt: "QS-class analogue ... cGMP ... DMF" } },
      { name: "Pacific Quillaja Extracts", website: "https://pacific-quillaja.example", evidence: "Quillaja saponaria extract, food and cosmetic grade.", href: "https://pacific-quillaja.example", kind: "supplier_site", label: "discovery_candidate" },
    ],
    candidate_count: 2,
    note: "Live web results. Every hit is a discovery_candidate: not technically assessed, not quality approved, not released for use. Page signals are the supplier's own claims, not verified DMF/CEP status. Access-led material: web capacity is never a substitute for the licensed source; open a qualification task.",
  };
  return { today, rfq_id: rfq.external_id, f, state: store.snapshot() };
}
