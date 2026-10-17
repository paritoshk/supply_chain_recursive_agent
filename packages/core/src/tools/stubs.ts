/**
 * Live-data clients (You.com discovery, openFDA) and the writing tools over the store.
 * The file keeps its historical name; nothing here is a stub any more except notify_user,
 * whose channel delivery lives in the agent.
 */
import { z } from "zod";
import { isApproved, normalizeQuote, supplierScore } from "../logic/index.ts";
import type { Store } from "../store.ts";
import { Finding, Severity, type Citation, type Material, type Quote } from "../types.ts";
import { defineTool, featureDisabled, type ToolResult } from "./contract.ts";
import { collectQuotes } from "./negotiation.ts";

const ok = (source: string, citations: Citation[], body: Record<string, unknown>): ToolResult => ({
  ingestion_status: "ok",
  source,
  citations,
  ...body,
});
const notFound = (source: string, error: string): ToolResult => ({ ingestion_status: "not_ingested", source, citations: [], error });

// ---------------------------------------------------------------------------
// You.com discovery
// ---------------------------------------------------------------------------

export const YOU_SEARCH_URL = "https://ydc-index.io/v1/search";
export const YOU_CONTENTS_URL = "https://ydc-index.io/v1/contents";

export interface YouWebResult {
  url: string;
  title?: string;
  description?: string;
  snippets?: string[];
}

export interface DiscoveryCandidate {
  name: string;
  website: string;
  evidence: string;
  href: string;
  kind: "supplier_site" | "directory";
  label: "discovery_candidate";
  query: string;
  /** Present when the page itself was read via You.com contents (not just the search snippet). */
  page?: { read: boolean; signals: string[]; excerpt: string | null; error?: string };
}

const SIGNAL_PATTERNS: Array<[string, RegExp]> = [
  ["GMP", /\b(c?GMP|IPEC[- ]GMP|good manufacturing practice)\b/i],
  ["US DMF", /\b(US[- ]?DMF|drug master file|DMF)\b/i],
  ["CEP", /\b(CEP|certificate of suitability|CoS)\b/],
  ["USP-NF", /\b(USP|NF|USP[- ]NF)\b/],
  ["Ph. Eur.", /\b(Ph\.? ?Eur\.?|EP)\b/],
  ["JP", /\bJP\b/],
  ["ChP", /\bChP\b/],
  ["low endotoxin", /low[- ]endotoxin|endotoxin[- ](controlled|tested)/i],
  ["parenteral grade", /parenteral|injectable/i],
  ["ISO 9001", /ISO ?9001/i],
];

/** Pure: compliance keywords found in page text. Signals are claims on the page, not verified approvals. */
export function complianceSignals(text: string): string[] {
  return SIGNAL_PATTERNS.filter(([, re]) => re.test(text)).map(([k]) => k);
}

async function youContents(urls: string[], apiKey: string): Promise<Array<{ url: string; markdown?: string }>> {
  const res = await fetch(YOU_CONTENTS_URL, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({ urls, formats: ["markdown"] }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`you.com contents ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as unknown;
  return Array.isArray(json) ? (json as Array<{ url: string; markdown?: string }>) : [];
}

const DIRECTORY_HOSTS = ["pharmacompass.com", "pharmaoffer.com", "pharmacompass", "chemicalbook.com", "made-in-china.com", "alibaba.com", "indiamart.com", "echemi.com", "lookchem.com", "tradeindia.com", "pipelinepharma.com", "dcatvci.org", "cphi-online.com", "pharmasources.com", "molbase.com", "guidechem.com", "pharmaceutical-technology.com", "pharmaexcipients.com", "pharmtech.com", "europeanpharmaceuticalreview.com", "chemeurope.com", "thomasnet.com", "kompass.com", "pharmasalmanac.com"];
const SKIP_HOSTS = ["wikipedia.org", "ncbi.nlm.nih.gov", "sciencedirect.com", "researchgate.net", "youtube.com", "fda.gov", "ema.europa.eu", "edqm.eu", "reddit.com", "linkedin.com", "facebook.com", "springer.com", "mdpi.com", "nature.com", "pubchem.ncbi.nlm.nih.gov", "drugbank.com", "accessdata.fda.gov"];

/** 1-2 discovery queries from the material master: substance + grade + compliance terms. */
export function discoveryQueries(m: Pick<Material, "substance" | "grade" | "compendia" | "sourcing_mode">, extra?: string): string[] {
  const grade = m.grade.replace(/\//g, " ");
  const qs = [`${m.substance} ${grade} GMP manufacturer DMF CEP`];
  if (extra?.trim()) qs.unshift(extra.trim());
  else qs.push(`${m.substance} ${m.compendia.slice(0, 2).join(" ")} pharmaceutical grade supplier`.trim());
  return qs.slice(0, 2);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

const matchesHost = (host: string, list: string[]) => list.some((h) => host === h || host.endsWith(`.${h}`) || host.includes(h));

/** Best-effort company name: a short title segment that shares a token with the domain, else the domain label. */
export function nameFromResult(title: string | undefined, host: string): string {
  const label = host.split(".").slice(0, -1).join(".").split(".").at(-1) ?? host;
  const segments = (title ?? "")
    .split(/\s[|\-–—:]\s|\s[|]\s?/)
    .map((s) => s.trim())
    .filter((s) => s && s.split(/\s+/).length <= 5 && !s.includes("..."));
  const token = label.replace(/[^a-z0-9]/g, "").slice(0, 5);
  const hit = segments.find((s) => token && s.toLowerCase().replace(/[^a-z0-9]/g, "").includes(token));
  if (hit) return hit;
  return label
    .split(/[-_]/)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Pure: You.com web hits -> deduplicated discovery candidates (one per host, proxies and reference sites dropped). */
export function mapYouResults(hits: Array<{ query: string; result: YouWebResult }>, max: number): DiscoveryCandidate[] {
  const seen = new Set<string>();
  const out: DiscoveryCandidate[] = [];
  for (const { query, result } of hits) {
    const host = hostOf(result.url);
    if (!host || host.endsWith("translate.goog") || matchesHost(host, SKIP_HOSTS) || seen.has(host)) continue;
    seen.add(host);
    const kind = matchesHost(host, DIRECTORY_HOSTS) ? "directory" : "supplier_site";
    const snippet = Array.isArray(result.snippets) ? result.snippets[0] : undefined;
    const evidence = [result.description, snippet].filter(Boolean).join(" ... ").replace(/\s+/g, " ").slice(0, 400);
    const name = nameFromResult(result.title, host);
    out.push({
      name: kind === "directory" ? `${name} (directory listing)` : name,
      website: `https://${host}`,
      evidence,
      href: result.url,
      kind,
      label: "discovery_candidate",
      query,
    });
    if (out.length >= max) break;
  }
  return out;
}

async function youSearch(query: string, count: number, apiKey: string): Promise<YouWebResult[]> {
  const url = `${YOU_SEARCH_URL}?${new URLSearchParams({ query, count: String(count) })}`;
  const res = await fetch(url, { headers: { "X-API-Key": apiKey }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`you.com ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { results?: { web?: YouWebResult[] } };
  return json.results?.web ?? [];
}

export const discoverSuppliers = defineTool({
  name: "discover_suppliers",
  description:
    "Live web discovery of public suppliers for a material via You.com search, with citations. Every result is a discovery_candidate, never approved. Results are kept on the evidence board.",
  idempotent: true,
  writes: "board",
  inputSchema: z.object({
    material_id: z.string(),
    mission_id: z.string().nullable().optional(),
    query: z.string().optional(),
    max_results: z.number().int().positive().max(20).default(8),
    /** Read the top N supplier pages with You.com contents to extract compliance claims (0 = snippets only). */
    read_pages: z.number().int().min(0).max(3).default(2),
  }),
  async run(ctx, args) {
    const m = ctx.store.material(args.material_id);
    if (!m) return notFound("you.com", `${args.material_id} not found`);
    const apiKey = process.env.YOU_DOT_COM_API_KEY;
    if (!apiKey) return featureDisabled("you.com", "discover_suppliers: YOU_DOT_COM_API_KEY is not set");
    const queries = discoveryQueries(m, args.query);
    const settled = await Promise.allSettled(queries.map((q) => youSearch(q, Math.min(20, args.max_results + 4), apiKey)));
    const hits = settled.flatMap((s, i) => (s.status === "fulfilled" ? s.value.map((result) => ({ query: queries[i]!, result })) : []));
    const errors = settled.flatMap((s) => (s.status === "rejected" ? [String((s.reason as Error)?.message ?? s.reason)] : []));
    if (!hits.length && errors.length) return { ...notFound("you.com", errors.join("; ")), queries };
    const candidates = mapYouResults(hits, args.max_results);
    const toRead = candidates.filter((c) => c.kind === "supplier_site").slice(0, args.read_pages);
    if (toRead.length) {
      try {
        const pages = await youContents(toRead.map((c) => c.href), apiKey);
        for (const c of toRead) {
          const md = pages.find((p) => p.url === c.href)?.markdown ?? null;
          c.page = md
            ? { read: true, signals: complianceSignals(md), excerpt: md.replace(/\s+/g, " ").slice(0, 400) }
            : { read: false, signals: [], excerpt: null, error: "no content returned" };
        }
      } catch (err) {
        for (const c of toRead) c.page = { read: false, signals: [], excerpt: null, error: (err as Error).message };
        errors.push((err as Error).message);
      }
    }
    const evidence = ctx.store.addBoardItem({
      kind: "supplier_evidence",
      title: `Supplier evidence: ${m.name}`,
      mission_id: args.mission_id ?? null,
      material_id: m.external_id,
      image_url: null,
      key: `evidence:${args.mission_id ?? "adhoc"}:${m.external_id}`,
      source_urls: candidates.map((c) => c.href),
      data: {
        queries,
        label: "discovery_candidate (not approved)",
        candidates: candidates.map((c) => ({
          name: c.name,
          href: c.href,
          kind: c.kind,
          evidence: c.evidence.slice(0, 240),
          page_read: Boolean(c.page?.read),
          signals: c.page?.signals ?? [],
        })),
        errors,
      },
    });
    return ok(
      "you.com",
      candidates.map((c) => ({
        source: c.page?.read ? "you.com/contents" : "you.com",
        ids: [c.href],
        href: c.href,
        excerpt: (c.page?.read && c.page.signals.length ? `page claims: ${c.page.signals.join(", ")}. ` : "") + c.evidence.slice(0, 200),
      })),
      {
        material_id: m.external_id,
        queries,
        candidates,
        candidate_count: candidates.length,
        errors,
        board_item_id: evidence.id,
        note:
          "Live web results. Every hit is a discovery_candidate: not technically assessed, not quality approved, not released for use. " +
          "Page signals are the supplier's own claims (read via You.com contents), not verified DMF/CEP status. " +
          (m.sourcing_mode === "access_led" ? "Access-led material: web capacity is never a substitute for the licensed source; open a qualification task." : ""),
      },
    );
  },
});

// ---------------------------------------------------------------------------
// openFDA
// ---------------------------------------------------------------------------

export const OPENFDA_BASE = "https://api.fda.gov/drug";

interface OpenFdaResponse<T> {
  meta?: { results?: { total?: number } };
  results?: T[];
  error?: { code?: string; message?: string };
}
export interface ShortageRecord {
  generic_name?: string;
  status?: string;
  company_name?: string;
  presentation?: string;
  availability?: string;
  shortage_reason?: string;
  update_date?: string;
  dosage_form?: string;
}
export interface EnforcementRecord {
  recall_number?: string;
  classification?: string;
  status?: string;
  recalling_firm?: string;
  product_description?: string;
  reason_for_recall?: string;
  report_date?: string;
  country?: string;
}

const phrase = (s: string) => `"${s.replace(/"/g, "").trim()}"`;

export function shortageUrl(substance: string, limit = 5): string {
  const search = `generic_name:${phrase(substance)} OR openfda.substance_name:${phrase(substance.toUpperCase())}`;
  return `${OPENFDA_BASE}/shortages.json?${new URLSearchParams({ search, limit: String(limit) })}`;
}
export function enforcementUrl(substance: string, supplier?: string, limit = 5): string {
  const search = supplier
    ? `product_description:${phrase(substance)} AND recalling_firm:${phrase(supplier)}`
    : `product_description:${phrase(substance)}`;
  return `${OPENFDA_BASE}/enforcement.json?${new URLSearchParams({ search, limit: String(limit) })}`;
}

/** GET an openFDA endpoint; a 404 means "no matches", not an error. */
async function openFda<T>(url: string): Promise<{ total: number; results: T[] }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (res.status === 404) return { total: 0, results: [] };
  const json = (await res.json().catch(() => ({}))) as OpenFdaResponse<T>;
  if (!res.ok) throw new Error(`openFDA ${res.status}: ${json.error?.message ?? "request failed"}`);
  return { total: json.meta?.results?.total ?? json.results?.length ?? 0, results: json.results ?? [] };
}

/** Pure: status -> count. */
export function countBy<T>(rows: T[], key: (r: T) => string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = key(r) || "unknown";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export function summarizeRegulatory(
  substance: string,
  shortages: { total: number; results: ShortageRecord[] },
  enforcement: { total: number; results: EnforcementRecord[] },
): string {
  const current = shortages.results.filter((s) => /current/i.test(s.status ?? "")).length;
  const parts = [
    shortages.total
      ? `${shortages.total} FDA drug-shortage record(s) mention ${substance} (${current} of the ${shortages.results.length} shown are Current).`
      : `No FDA drug-shortage records match ${substance}.`,
    enforcement.total
      ? `${enforcement.total} FDA enforcement/recall report(s) mention ${substance} in the product description; classes shown: ${Object.entries(countBy(enforcement.results, (e) => e.classification)).map(([k, v]) => `${k} x${v}`).join(", ")}.`
      : `No FDA enforcement reports mention ${substance}.`,
    "Finished-product records; they signal market stress, not the status of an excipient supplier.",
  ];
  return parts.join(" ");
}

export const checkRegulatory = defineTool({
  name: "check_regulatory",
  description: "Regulatory signals for a substance: openFDA drug shortages and enforcement reports (live). The DMF list index is not wired yet.",
  idempotent: true,
  inputSchema: z.object({ substance: z.string().min(2), supplier_name: z.string().optional() }),
  async run(_ctx, args) {
    const sUrl = shortageUrl(args.substance);
    const eUrl = enforcementUrl(args.substance, args.supplier_name);
    const [sh, en] = await Promise.allSettled([openFda<ShortageRecord>(sUrl), openFda<EnforcementRecord>(eUrl)]);
    if (sh.status === "rejected" && en.status === "rejected") {
      return notFound("openfda", `${(sh.reason as Error).message}; ${(en.reason as Error).message}`);
    }
    const shortages = sh.status === "fulfilled" ? sh.value : { total: 0, results: [] };
    const enforcement = en.status === "fulfilled" ? en.value : { total: 0, results: [] };
    const citations: Citation[] = [
      {
        source: "openfda.drug_shortages",
        ids: [sUrl],
        href: sUrl,
        excerpt: shortages.total ? `${shortages.total} shortage record(s); statuses ${JSON.stringify(countBy(shortages.results, (s) => s.status))}` : "no matches",
      },
      {
        source: "openfda.drug_enforcement",
        ids: [eUrl],
        href: eUrl,
        excerpt: enforcement.total ? `${enforcement.total} enforcement report(s); classes ${JSON.stringify(countBy(enforcement.results, (e) => e.classification))}` : "no matches",
      },
    ];
    return ok("openfda", citations, {
      substance: args.substance,
      supplier_name: args.supplier_name ?? null,
      shortages: {
        total: shortages.total,
        status_counts: countBy(shortages.results, (s) => s.status),
        items: shortages.results.map((s) => ({
          generic_name: s.generic_name ?? null,
          status: s.status ?? null,
          company_name: s.company_name ?? null,
          presentation: s.presentation ?? null,
          availability: s.availability ?? null,
          shortage_reason: s.shortage_reason ?? null,
          update_date: s.update_date ?? null,
        })),
      },
      enforcement: {
        total: enforcement.total,
        classification_counts: countBy(enforcement.results, (e) => e.classification),
        status_counts: countBy(enforcement.results, (e) => e.status),
        items: enforcement.results.map((e) => ({
          recall_number: e.recall_number ?? null,
          classification: e.classification ?? null,
          status: e.status ?? null,
          recalling_firm: e.recalling_firm ?? null,
          reason_for_recall: e.reason_for_recall ?? null,
          report_date: e.report_date ?? null,
          product_description: e.product_description?.slice(0, 200) ?? null,
        })),
      },
      errors: [sh, en].flatMap((s) => (s.status === "rejected" ? [String((s.reason as Error).message)] : [])),
      dmf_index: "not_ingested",
      summary: summarizeRegulatory(args.substance, shortages, enforcement),
    });
  },
});

// ---------------------------------------------------------------------------
// Writing tools
// ---------------------------------------------------------------------------

const OPEN_RFQ = new Set(["draft", "sent", "quoted"]);

export const draftRfq = defineTool({
  name: "draft_rfq",
  description:
    "Create a draft RFQ (next id, e.g. RFQ-102) for a material/site/qty/need-by, linked to a mission. If the same mission already has an open RFQ for this material/site, that RFQ is returned instead.",
  idempotent: false,
  inputSchema: z.object({
    material_id: z.string(),
    site_id: z.string(),
    qty: z.number().positive(),
    need_by: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "need_by must be YYYY-MM-DD"),
    mission_id: z.string().nullable().default(null),
    supplier_ids: z.array(z.string()).default([]),
  }),
  async run(ctx, args) {
    const { store } = ctx;
    if (!store.material(args.material_id)) return notFound("rfqs", `${args.material_id} not found`);
    if (!store.site(args.site_id)) return notFound("rfqs", `${args.site_id} not found`);
    if (args.mission_id && !store.mission(args.mission_id)) return notFound("rfqs", `${args.mission_id} not found`);
    const existing = args.mission_id
      ? store.rfqs({ material_id: args.material_id, site_id: args.site_id, mission_id: args.mission_id }).find((r) => OPEN_RFQ.has(r.status))
      : undefined;
    const rfq = existing ?? store.addRFQ({ material_id: args.material_id, site_id: args.site_id, qty: args.qty, need_by: args.need_by, status: "draft", mission_id: args.mission_id });
    const links = store.materialSuppliers({ material_id: args.material_id });
    const invited = args.supplier_ids.map((id) => {
      const link = links.find((l) => l.supplier_id === id);
      return { supplier_id: id, qualification_state: link?.qualification_state ?? null, approved: link ? isApproved(link.qualification_state) : false };
    });
    return ok("rfqs", [{ source: "rfqs", ids: [rfq.external_id, args.material_id, args.site_id] }], {
      rfq,
      deduplicated: Boolean(existing),
      invited_suppliers: invited,
      note: "Draft only. Supplier replies are simulated persona responses; nothing is sent to real suppliers.",
    });
  },
});

const OPEN_MISSION = new Set(["planning", "running", "verifying"]);

export const openMission = defineTool({
  name: "open_mission",
  description: "Open a mission for a breach (deduplicated: an open mission for the same material/site is returned instead).",
  idempotent: false,
  inputSchema: z.object({ trigger: z.string(), material_id: z.string().nullable(), site_id: z.string().nullable() }),
  async run(ctx, args) {
    const { store } = ctx;
    if (args.material_id && !store.material(args.material_id)) return notFound("missions", `${args.material_id} not found`);
    if (args.site_id && !store.site(args.site_id)) return notFound("missions", `${args.site_id} not found`);
    const existing = store
      .missions()
      .find((m) => OPEN_MISSION.has(m.status) && m.material_id === args.material_id && m.site_id === args.site_id);
    const mission = existing ?? store.addMission({ trigger: args.trigger, material_id: args.material_id, site_id: args.site_id, status: "planning", summary: null });
    return ok("missions", [{ source: "missions", ids: [mission.id, ...[args.material_id, args.site_id].filter((x): x is string => Boolean(x))] }], {
      mission,
      deduplicated: Boolean(existing),
    });
  },
});

export const recordFinding = defineTool({
  name: "record_finding",
  description: "Persist a Finding {headline, severity, detail, cited_tool_calls}.",
  idempotent: false,
  inputSchema: Finding.extend({ severity: Severity }),
  async run(ctx, args) {
    const f = ctx.store.addFinding(args);
    return ok("findings", [{ source: "findings", ids: [f.id as string] }], { finding: f });
  },
});

export const notifyUser = defineTool({
  name: "notify_user",
  description: "Send a text to the user (iMessage via Photon, Sendblue fallback). Only for decisions. Delivery is performed by the agent's channel adapter.",
  idempotent: false,
  inputSchema: z.object({ body: z.string().min(1), mission_id: z.string().nullable().default(null), to: z.string().optional() }),
  async run(_ctx, args) {
    return ok("messages", [{ source: "messages", ids: [] }], {
      queued: true,
      delivered: false,
      body: args.body,
      mission_id: args.mission_id,
      note: "Core no-op: channel delivery (and Message persistence) lives in the agent.",
    });
  },
});

const Decision = z.preprocess(
  (v) => {
    if (typeof v !== "string") return v;
    const u = v.trim().toUpperCase();
    return u === "REJECT" || u === "REJECTED" ? "NO" : u === "APPROVED" ? "APPROVE" : u;
  },
  z.enum(["APPROVE", "DETAILS", "NO"]),
);

/** Best approved, unblocked, priced, unexpired quote on an RFQ by landed USD/unit. */
export function bestApprovedQuote(store: Store, rfqId: string): Quote | null {
  const rfq = store.rfq(rfqId);
  if (!rfq) return null;
  const links = store.materialSuppliers({ material_id: rfq.material_id });
  const rows = store
    .quotes(rfqId)
    .filter((q) => q.valid_until >= store.today())
    .map((q) => ({ q, n: normalizeQuote(q), link: links.find((l) => l.supplier_id === q.supplier_id) }))
    .filter((r) => r.n.comparable && r.link && isApproved(r.link.qualification_state) && !supplierScore(r.link).blocked)
    .sort((a, b) => (a.n.landed_usd_per_unit as number) - (b.n.landed_usd_per_unit as number));
  return rows[0]?.q ?? null;
}

export const applyApproval = defineTool({
  name: "apply_approval",
  description:
    "Apply a human reply (APPROVE / DETAILS / NO; also approve / reject) to an RFQ. APPROVE drafts a PurchaseOrder from the chosen stored quote (quote_supplier_id or quote_id, else the best approved landed quote). Never places a PO.",
  idempotent: false,
  inputSchema: z.object({
    rfq_id: z.string(),
    decision: Decision,
    quote_supplier_id: z.string().optional(),
    quote_id: z.string().optional(),
    from: z.string().optional(),
  }),
  async run(ctx, args) {
    const { store } = ctx;
    const rfq = store.rfq(args.rfq_id);
    if (!rfq) return notFound("rfqs", `${args.rfq_id} not found`);
    const quotes = store.quotes(rfq.external_id);

    if (args.decision === "DETAILS") {
      return ok("rfqs", [{ source: "rfqs", ids: [rfq.external_id, ...quotes.map((q) => q.external_id)] }], {
        rfq,
        decision: "DETAILS",
        quotes: quotes.map((q) => ({ ...normalizeQuote(q), supplier_id: q.supplier_id, lead_time_days: q.lead_time_days, valid_until: q.valid_until })),
        changed: false,
      });
    }
    if (args.decision === "NO") {
      if (rfq.status === "approved") return notFound("rfqs", `${rfq.external_id} is already approved; cancel the draft PO manually`);
      store.updateRFQ(rfq.external_id, { status: "rejected" });
      return ok("rfqs", [{ source: "rfqs", ids: [rfq.external_id] }], { rfq, decision: "NO", changed: true, purchase_order: null });
    }

    // APPROVE
    const existingPo = store.purchaseOrders().find((p) => p.rfq_id === rfq.external_id);
    if (rfq.status === "approved" && existingPo) {
      return ok("rfqs", [{ source: "rfqs", ids: [rfq.external_id, ...(existingPo.quote_id ? [existingPo.quote_id] : [])] }], {
        rfq,
        decision: "APPROVE",
        changed: false,
        purchase_order: existingPo,
        note: "Already approved; returning the existing draft PO.",
      });
    }
    if (rfq.status === "rejected" || rfq.status === "expired") return notFound("rfqs", `${rfq.external_id} is ${rfq.status}`);
    const quote = args.quote_id
      ? quotes.find((q) => q.external_id === args.quote_id)
      : args.quote_supplier_id
        ? quotes.filter((q) => q.supplier_id === args.quote_supplier_id).at(-1)
        : (bestApprovedQuote(store, rfq.external_id) ?? undefined);
    if (!quote) return notFound("rfqs", `${rfq.external_id} has no matching stored quote to approve`);
    const link = store.materialSuppliers({ material_id: rfq.material_id, supplier_id: quote.supplier_id })[0];
    if (!link || !isApproved(link.qualification_state)) {
      return notFound("rfqs", `${quote.supplier_id} is ${link?.qualification_state ?? "not linked"} for ${rfq.material_id}; only approved suppliers can be awarded`);
    }
    if (supplierScore(link).blocked) return notFound("rfqs", `${quote.supplier_id} is blocked (BIOSECURE flag)`);
    if (quote.unit_price == null) return notFound("rfqs", `${quote.external_id} is unpriced (${quote.rfq_reason ?? "quote-only"}); a human must negotiate it`);
    if (quote.valid_until < store.today()) return notFound("rfqs", `${quote.external_id} expired on ${quote.valid_until}`);
    store.updateRFQ(rfq.external_id, { status: "approved" });
    const po = store.addPurchaseOrder({
      rfq_id: rfq.external_id,
      quote_id: quote.external_id,
      supplier_id: quote.supplier_id,
      material_id: rfq.material_id,
      site_id: rfq.site_id,
      qty: quote.qty,
      unit_price: quote.unit_price,
      currency: quote.currency,
      status: "draft",
    });
    return ok("rfqs", [{ source: "rfqs", ids: [rfq.external_id, quote.external_id, link.external_id] }], {
      rfq,
      decision: "APPROVE",
      changed: true,
      quote_id: quote.external_id,
      purchase_order: po,
      landed: normalizeQuote(quote),
      note: "Draft PO only. Nothing is placed with the supplier; a buyer releases it in the ERP.",
    });
  },
});

export const stubTools = [
  discoverSuppliers,
  checkRegulatory,
  draftRfq,
  collectQuotes,
  openMission,
  recordFinding,
  notifyUser,
  applyApproval,
];
