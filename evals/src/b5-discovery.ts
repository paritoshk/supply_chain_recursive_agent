/**
 * B5 Supplier discovery realism. Runs the real discover_suppliers tool (You.com live search + contents)
 * for 12 catalog materials whose real-world suppliers are named in .context/research/supplier-landscape.md
 * and scores: recall@5/@8 against those named suppliers, judged precision@5/@8 (is the hit a
 * manufacturer/distributor of that material, vs a directory or noise), share of hits with GMP/DMF/CEP
 * evidence, directory share, and how many hits survive the scout's own keep-rule. It also replays the
 * exact You.com queries without the tool's filters to show what the filters drop.
 */
import "./lib/env.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { complianceSignals, createStore, discoveryQueries, YOU_SEARCH_URL, type DiscoveryCandidate } from "@supply-agent/core";
import { REPO_ROOT } from "./lib/env.ts";
import { tool } from "./lib/fixtures.ts";
import { call, parseJsonLoose, pool, usageReport } from "./lib/llm.ts";
import { JUDGE } from "./lib/models.ts";
import { writeResult } from "./lib/io.ts";
import { mean, r2, r4 } from "./lib/stats.ts";

interface Truth { name: string; patterns: string[] }
const T = {
  pfanstiehl: { name: "Pfanstiehl", patterns: ["pfanstiehl"] },
  merck: { name: "Merck / SAFC (MilliporeSigma)", patterns: ["merckgroup", "sigmaaldrich", "sigma-aldrich", "milliporesigma", "emdmillipore", "merckmillipore", "merck"] },
  croda: { name: "Croda", patterns: ["croda"] },
  roquette: { name: "Roquette", patterns: ["roquette"] },
  hovione: { name: "Hovione", patterns: ["hovione"] },
  schott: { name: "SCHOTT Pharma", patterns: ["schott"] },
  west: { name: "West Pharmaceutical Services", patterns: ["westpharma", "west pharmaceutical"] },
  sartorius: { name: "Sartorius", patterns: ["sartorius"] },
  cytiva: { name: "Cytiva", patterns: ["cytiva"] },
  thermo: { name: "Thermo Fisher Scientific", patterns: ["thermofisher", "thermo fisher"] },
  abec: { name: "ABEC", patterns: ["abec.com", "abec"] },
  purolite: { name: "Purolite (Ecolab)", patterns: ["purolite", "ecolab"] },
  shinetsu: { name: "Shin-Etsu", patterns: ["shinetsu", "shin-etsu", "metolose"] },
  greven: { name: "Peter Greven", patterns: ["peter-greven", "petergreven", "greven"] },
} satisfies Record<string, Truth>;

const MATERIALS: Array<{ material_id: string; label: string; truth: Truth[] }> = [
  { material_id: "MAT-SUC-INJ", label: "Sucrose (injectable)", truth: [T.pfanstiehl, T.merck] },
  { material_id: "MAT-PS80-SR", label: "Polysorbate 80 (super-refined)", truth: [T.croda, T.merck] },
  { material_id: "MAT-TRE-HP", label: "Trehalose dihydrate", truth: [T.pfanstiehl] },
  { material_id: "MAT-MAN-PAR", label: "Mannitol (parenteral)", truth: [T.roquette, T.pfanstiehl] },
  { material_id: "MAT-HIS", label: "L-Histidine", truth: [T.merck, T.pfanstiehl] },
  { material_id: "MAT-FF", label: "Fluticasone furoate", truth: [T.hovione] },
  { material_id: "MAT-VIAL-2R", label: "Type I glass vials", truth: [T.schott] },
  { material_id: "MAT-STOP-13", label: "Elastomeric stoppers", truth: [T.west] },
  { material_id: "MAT-SUB-2000", label: "Single-use bioreactor bags", truth: [T.sartorius, T.cytiva, T.thermo, T.abec] },
  { material_id: "MAT-PROA", label: "Protein A resin", truth: [T.cytiva, T.purolite] },
  { material_id: "MAT-HPMC", label: "Hypromellose (HPMC)", truth: [T.shinetsu] },
  { material_id: "MAT-MGST", label: "Magnesium stearate", truth: [T.greven] },
];

const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
const matches = (t: Truth, c: { name: string; href: string }) => t.patterns.some((p) => host(c.href).includes(p.replace(/\s/g, "")) || c.name.toLowerCase().includes(p));

/** Reads the tool's host filter lists from core source so the report documents exactly what runs. */
function hostList(name: string): string[] {
  const src = readFileSync(join(REPO_ROOT, "packages/core/src/tools/stubs.ts"), "utf8");
  const m = src.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
  return m ? [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!) : [];
}

async function rawSearch(query: string, count: number): Promise<Array<{ url: string; title?: string }>> {
  const res = await fetch(`${YOU_SEARCH_URL}?${new URLSearchParams({ query, count: String(count) })}`, { headers: { "X-API-Key": process.env.YOU_DOT_COM_API_KEY ?? "" }, signal: AbortSignal.timeout(25_000) });
  if (!res.ok) throw new Error(`you.com ${res.status}`);
  const j = (await res.json()) as { results?: { web?: Array<{ url: string; title?: string }> } };
  return j.results?.web ?? [];
}

const GMP_RE = /^(GMP|US DMF|CEP)$/;
const store = createStore();
const MAX = 8;
const t0 = Date.now();

const perMaterial = await pool(MATERIALS, 2, async (spec) => {
  const m = store.material(spec.material_id)!;
  const started = Date.now();
  const out = await tool(store, "discover_suppliers", { material_id: spec.material_id, max_results: MAX, read_pages: 2 });
  const latency = Date.now() - started;
  const cands = ((out.candidates as DiscoveryCandidate[] | undefined) ?? []).slice(0, MAX);
  const queries = (out.queries as string[] | undefined) ?? discoveryQueries(m);

  // raw replay of the same queries (no host filters, no dedup, no truncation)
  const raw = (await Promise.allSettled(queries.map((q) => rawSearch(q, Math.min(20, MAX + 4))))).flatMap((s) => (s.status === "fulfilled" ? s.value : []));
  const rawHosts = raw.map((r) => host(r.url));
  const rawTruthFound = spec.truth.filter((t) => raw.some((r) => matches(t, { name: r.title ?? "", href: r.url }))).map((t) => t.name);

  // judge each hit
  const listing = cands.map((c, i) => ({ i, name: c.name, url: c.href, kind: c.kind, evidence: c.evidence.slice(0, 300), page_signals: c.page?.signals ?? [] }));
  let judged: Array<{ i: number; category: string; relevant: boolean }> = [];
  if (listing.length) {
    const res = await call({
      model: JUDGE,
      temperature: 0,
      max_tokens: 4096,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You label web search hits for a pharma raw-material sourcing agent. For each hit decide category: " +
            '"manufacturer" (the site is a company that makes this material), "distributor" (a company that sells/distributes this material), ' +
            '"directory" (marketplace, B2B listing, trade directory, aggregator), or "noise" (news, article, reference, unrelated product, or a different material). ' +
            'relevant = true only for manufacturer or distributor of THIS material (right grade family). Reply JSON only: {"hits": [{"i": number, "category": string, "relevant": boolean}]}',
        },
        { role: "user", content: JSON.stringify({ material: { name: m.name, substance: m.substance, grade: m.grade }, hits: listing }) },
      ],
    });
    if (res.ok) judged = parseJsonLoose<{ hits?: typeof judged }>(res.r.content)?.hits ?? parseJsonLoose<{ hits?: typeof judged }>(res.r.reasoning)?.hits ?? [];
  }

  const hits = cands.map((c, i) => {
    const text = `${c.evidence} ${c.page?.excerpt ?? ""}`;
    const signals = [...new Set([...complianceSignals(text), ...(c.page?.signals ?? [])])];
    const j = judged.find((x) => x.i === i);
    const substanceToken = m.substance.split(/\s+/)[0]!.toLowerCase();
    const gmp = signals.some((s) => GMP_RE.test(s));
    return {
      rank: i + 1,
      name: c.name,
      host: host(c.href),
      href: c.href,
      kind: c.kind,
      query: c.query,
      page_read: c.page?.read ?? false,
      signals,
      gmp_dmf_cep: gmp,
      truth_match: spec.truth.filter((t) => matches(t, c)).map((t) => t.name),
      judged_category: j?.category ?? null,
      judged_relevant: j ? j.relevant === true : null,
      passes_scout_rule: gmp && text.toLowerCase().includes(substanceToken),
    };
  });
  const at = (k: number) => {
    const top = hits.slice(0, k);
    const found = spec.truth.filter((t) => top.some((h) => h.truth_match.includes(t.name)));
    const judgedTop = top.filter((h) => h.judged_relevant != null);
    return {
      recall: r4(found.length / spec.truth.length),
      found: found.map((t) => t.name),
      precision_judged: judgedTop.length ? r4(judgedTop.filter((h) => h.judged_relevant).length / k) : null,
    };
  };
  process.stdout.write(`${spec.material_id} `);
  return {
    material_id: spec.material_id,
    label: spec.label,
    truth: spec.truth.map((t) => t.name),
    queries,
    latency_ms: latency,
    errors: out.errors ?? (out.error ? [out.error] : []),
    candidate_count: hits.length,
    at5: at(5),
    at8: at(8),
    gmp_dmf_cep_share: hits.length ? r4(hits.filter((h) => h.gmp_dmf_cep).length / hits.length) : null,
    directory_share_tool: hits.length ? r4(hits.filter((h) => h.kind === "directory").length / hits.length) : null,
    directory_share_judged: hits.length ? r4(hits.filter((h) => h.judged_category === "directory").length / hits.length) : null,
    scout_rule_survivors: hits.filter((h) => h.passes_scout_rule).length,
    scout_rule_truth_kept: spec.truth.filter((t) => hits.some((h) => h.passes_scout_rule && h.truth_match.includes(t.name))).map((t) => t.name),
    raw: { results: raw.length, unique_hosts: new Set(rawHosts).size, truth_found_anywhere: rawTruthFound },
    hits,
  };
});
console.log();

const agg = (f: (r: (typeof perMaterial)[number]) => number | null) => {
  const xs = perMaterial.map(f).filter((x): x is number => x != null);
  return xs.length ? r4(mean(xs)!) : null;
};
const truthTotal = perMaterial.reduce((s, r) => s + r.truth.length, 0);
const summary = {
  materials: perMaterial.length,
  truth_suppliers: truthTotal,
  recall_at_5_micro: r4(perMaterial.reduce((s, r) => s + r.at5.found.length, 0) / truthTotal),
  recall_at_8_micro: r4(perMaterial.reduce((s, r) => s + r.at8.found.length, 0) / truthTotal),
  recall_at_5_macro: agg((r) => r.at5.recall),
  recall_at_8_macro: agg((r) => r.at8.recall),
  precision_at_5_judged: agg((r) => r.at5.precision_judged),
  precision_at_8_judged: agg((r) => r.at8.precision_judged),
  gmp_dmf_cep_share: agg((r) => r.gmp_dmf_cep_share),
  directory_share_tool: agg((r) => r.directory_share_tool),
  directory_share_judged: agg((r) => r.directory_share_judged),
  scout_rule_survivors_mean: agg((r) => r.scout_rule_survivors),
  raw_recall_any_rank_micro: r4(perMaterial.reduce((s, r) => s + r.raw.truth_found_anywhere.length, 0) / truthTotal),
  latency_ms_mean: Math.round(agg((r) => r.latency_ms) ?? 0),
};
console.log(summary);

writeResult("b5-discovery", {
  method: {
    tool: "discover_suppliers (packages/core/src/tools/stubs.ts), max_results 8, read_pages 2, run live against You.com",
    ground_truth: ".context/research/supplier-landscape.md (named real suppliers per material)",
    matching: "candidate host or name contains a supplier alias (e.g. Merck = merckgroup / sigmaaldrich / milliporesigma)",
    precision: `judged by ${JUDGE}: manufacturer or distributor of this material = relevant; precision@k = relevant / k`,
    gmp_evidence: "complianceSignals() on snippet + page excerpt, or page signals, includes GMP / US DMF / CEP",
    scout_rule: "scout instructions: keep only candidates whose evidence mentions the substance AND a GMP/DMF/CEP signal",
    raw_replay: "same queries sent straight to You.com search (count 12) with no host filter / dedup / truncation",
  },
  what_the_scout_searches_for: {
    query_template: [
      "`${substance} ${grade with / replaced by space} GMP manufacturer DMF CEP`",
      "`${substance} ${first two compendia} pharmaceutical grade supplier` (replaced by the caller's free-text query when one is passed; max 2 queries)",
    ],
    you_search: `${YOU_SEARCH_URL}?query=...&count=min(20, max_results + 4)`,
    filters: {
      skip_hosts: hostList("SKIP_HOSTS"),
      directory_hosts_labelled_not_dropped: hostList("DIRECTORY_HOSTS"),
      other: ["drop *.translate.goog proxies", "one candidate per host (dedup)", "truncate to max_results", "read top read_pages supplier_site pages via You.com contents and regex compliance claims"],
    },
  },
  summary,
  per_material: perMaterial,
  wall_s: r2((Date.now() - t0) / 1000),
  usage: usageReport(),
});
