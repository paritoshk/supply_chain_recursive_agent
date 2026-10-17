import type { BoardItem } from "@supply-agent/core";

/**
 * Renders evidence-board items as a self-contained HTML page (no client JS). Read-only.
 * Evidence, not a dashboard: each card is one object (structure image, feasibility table, QA packet,
 * supplier evidence, mission summary) with its sources.
 */

const esc = (v: unknown): string =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const safeUrl = (u: unknown): string | null => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : null);
/** Images only from PubChem's renderer. */
const safeImage = (u: unknown): string | null => (typeof u === "string" && u.startsWith("https://pubchem.ncbi.nlm.nih.gov/") ? u : null);

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const KIND_LABEL: Record<BoardItem["kind"], string> = {
  material_dossier: "Material dossier",
  structure_image: "Structure",
  feasibility_report: "Line feasibility",
  qa_packet: "QA packet",
  supplier_evidence: "Supplier evidence",
  mission_summary: "Mission",
};

/** Marks an already-escaped HTML fragment; everything else passed to kv() is escaped. */
class Html {
  constructor(readonly html: string) {}
}
const raw = (html: string) => new Html(html);

function kv(rows: Array<[string, unknown] | null>): string {
  const body = rows
    .filter((r): r is [string, unknown] => r != null && r[1] != null && r[1] !== "")
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v instanceof Html ? v.html : esc(v)}</dd>`)
    .join("");
  return body ? `<dl class="kv">${body}</dl>` : "";
}

function list(items: string[], cls = "list"): string {
  return items.length ? `<ul class="${cls}">${items.map((i) => `<li>${i}</li>`).join("")}</ul>` : "";
}

function sources(urls: string[]): string {
  const links = urls.map(safeUrl).filter((u): u is string => Boolean(u));
  if (!links.length) return "";
  return `<div class="sources"><span class="label">Sources</span>${links
    .slice(0, 6)
    .map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u.replace(/^https?:\/\//, "").slice(0, 64))}</a>`)
    .join("")}</div>`;
}

function dossierBody(item: BoardItem): string {
  const d = rec(item.data);
  const spec = rec(d.spec);
  const pc = rec(d.pubchem);
  const c = rec(pc.compound);
  const ghs = rec(c.ghs);
  const img = safeImage(item.image_url ?? c.image_url);
  const ghsText = c.ghs
    ? (ghs.classification_note as string) || [ghs.signal_word, ...arr(ghs.hazard_statements)].filter(Boolean).join("; ") || "no GHS data"
    : null;
  const page = safeUrl(c.page_url);
  const suppliers = arr(d.approved_suppliers).map((s) => {
    const r = rec(s);
    const flags = [r.dmf ? "DMF" : null, r.cep ? "CEP" : null].filter(Boolean).join(", ");
    return `${esc(r.supplier_name)} <span class="muted">${esc(r.supplier_id)} · ${esc(r.qualification_state)}${flags ? ` · ${esc(flags)}` : ""}</span>`;
  });
  return [
    img ? `<figure class="structure"><img src="${esc(img)}" alt="2D structure of ${esc(c.query)}" loading="lazy" width="300" height="300"></figure>` : "",
    pc.status === "found"
      ? kv([
          ["PubChem CID", page ? raw(`<a href="${esc(page)}" target="_blank" rel="noopener noreferrer">${esc(c.cid)}</a>`) : c.cid],
          ["Formula", c.molecular_formula],
          ["Mol. weight", c.molecular_weight],
          ["CAS", arr(c.cas).join(", ")],
          ["XLogP", c.xlogp],
          ["GHS", ghsText],
          ["IUPAC", c.iupac_name ? raw(`<span class="small">${esc(c.iupac_name)}</span>`) : null],
        ])
      : `<p class="note">${esc(pc.explanation)}</p>`,
    `<span class="label">Our spec</span>`,
    kv([
      ["Grade", spec.grade],
      ["Compendia", arr(spec.compendia).join(", ") || "none"],
      ["Storage", spec.storage],
      ["Shelf life", spec.shelf_life_days != null ? `${spec.shelf_life_days} days` : null],
      ["Sourcing", spec.sourcing_mode],
      ["QC release", spec.qc_release_days != null ? `${spec.qc_release_days} days` : null],
    ]),
    suppliers.length ? `<span class="label">Approved suppliers</span>${list(suppliers)}` : "",
  ].join("");
}

function structureBody(item: BoardItem): string {
  const d = rec(item.data);
  const img = safeImage(item.image_url);
  return [
    img ? `<figure class="structure"><img src="${esc(img)}" alt="2D structure, CID ${esc(d.cid)}" loading="lazy" width="300" height="300"></figure>` : "",
    kv([
      ["CID", d.cid],
      ["Formula", d.molecular_formula],
      ["Mol. weight", d.molecular_weight],
      ["CAS", arr(d.cas).join(", ")],
    ]),
  ].join("");
}

function feasibilityBody(item: BoardItem): string {
  const d = rec(item.data);
  const unit = esc(d.unit);
  const receipts = arr(d.receipts).map((r) => {
    const x = rec(r);
    return `${esc(x.kind)} ${esc(x.qty)} ${unit}: arrives ${esc(x.arrival_date)}, released ${esc(x.release_date)}`;
  });
  const rows = arr(d.batches)
    .map((b) => {
      const x = rec(b);
      return `<tr class="${x.feasible ? "" : "risk"}"><td class="mono">${esc(x.batch_no)}</td><td>${esc(String(x.start_date ?? "").slice(5))}</td><td class="num">${esc(x.material_needed)}</td><td class="num">${esc(x.available_at_start)}</td><td>${x.feasible ? "ok" : "at risk"}</td></tr>`;
    })
    .join("");
  const lines = arr(d.lines).map((l) => {
    const x = rec(l);
    return `${esc(x.line_id)} <span class="muted">${esc(x.name)} · ${esc(x.line_type)} · grade ${esc(x.cleanroom_grade)}</span>`;
  });
  return [
    `<p>${esc(d.headline)}</p>`,
    kv([
      ["Released now", d.released_qty != null ? `${d.released_qty} ${d.unit}` : null],
      ["Horizon", d.horizon_days != null ? `${d.horizon_days} days from ${d.today}` : null],
    ]),
    lines.length ? `<span class="label">Lines</span>${list(lines)}` : "",
    receipts.length ? `<span class="label">Inbound</span>${list(receipts)}` : "",
    rows
      ? `<div class="table-wrap"><table><thead><tr><th>Batch</th><th>Start</th><th class="num">Need</th><th class="num">Released</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
      : "",
  ].join("");
}

function qaBody(item: BoardItem): string {
  const d = rec(item.data);
  const sup = rec(d.supplier);
  return [
    kv([
      ["QC release", d.qc_release_days != null ? `${d.qc_release_days} days after arrival` : null],
      ["Transfer release", d.transfer_release_days != null ? `${d.transfer_release_days} days (receipt verification)` : null],
      ["Change control", d.change_control_required ? raw(`<span class="accent">required</span>`) : "not required"],
      ["Supplier", d.supplier ? `${esc(sup.supplier_id)} · ${esc(sup.qualification_state)}` : null],
      ["Cold chain", d.cold_chain ? "yes" : "no"],
      ["Storage", d.storage],
      ["Grade", d.grade],
      ["Compendia", arr(d.compendia).join(", ") || "none"],
      ["Endotoxin", d.endotoxin_class],
    ]),
    arr(d.change_control_reasons).length ? list(arr(d.change_control_reasons).map((r) => esc(r)), "list small") : "",
    `<span class="label">Documents required</span>`,
    list(arr(d.documents_required).map((x) => esc(x))),
  ].join("");
}

function evidenceBody(item: BoardItem): string {
  const d = rec(item.data);
  const cands = arr(d.candidates).map((c) => {
    const x = rec(c);
    const href = safeUrl(x.href);
    const signals = arr(x.signals).join(", ");
    return `${href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(x.name)}</a>` : esc(x.name)} <span class="muted">${esc(x.kind)}${signals ? ` · page claims: ${esc(signals)}` : ""}</span>${x.evidence ? `<div class="small">${esc(x.evidence)}</div>` : ""}`;
  });
  return [`<p class="note">${esc(d.label ?? "discovery candidates, not approved")}</p>`, list(cands), arr(d.queries).length ? `<p class="small muted">Queries: ${arr(d.queries).map(esc).join(" / ")}</p>` : ""].join("");
}

function missionBody(item: BoardItem): string {
  const d = rec(item.data);
  const plan = rec(d.plan);
  const t = rec(plan.transfer);
  const p = rec(plan.purchase);
  const checks = arr(d.checks).map((c) => {
    const x = rec(c);
    return `<span class="mono">${esc(x.id)}</span> ${x.pass ? "pass" : `<span class="accent">fail</span>`} <span class="muted small">${esc(x.reason)}</span>`;
  });
  return [
    `<p>${esc(d.summary)}</p>`,
    kv([
      ["Status", d.status],
      ["Approval", d.approval],
      ["Transfer", plan.transfer ? `${t.qty} from ${t.from_site_id}, ~${t.arrives_in_days} days` : "none"],
      ["Purchase", plan.purchase ? `${p.qty} from ${p.supplier_name} (${p.rfq_id}), ${p.lead_time_days} days + ${plan.qc_release_days ?? "?"} days QC` : "none"],
    ]),
    checks.length ? `<span class="label">Checks</span>${list(checks)}` : "",
  ].join("");
}

function card(item: BoardItem): string {
  const body =
    item.kind === "material_dossier"
      ? dossierBody(item)
      : item.kind === "structure_image"
        ? structureBody(item)
        : item.kind === "feasibility_report"
          ? feasibilityBody(item)
          : item.kind === "qa_packet"
            ? qaBody(item)
            : item.kind === "supplier_evidence"
              ? evidenceBody(item)
              : missionBody(item);
  const tags = [item.material_id, item.site_id, item.mission_id].filter(Boolean).map((t) => esc(t)).join(" · ");
  return `<article class="card card-${esc(item.kind)}">
<header><span class="label">${esc(KIND_LABEL[item.kind] ?? item.kind)}${tags ? ` · ${tags}` : ""}</span><h2>${esc(item.title)}</h2><time class="muted small" datetime="${esc(item.created_at)}">${esc(item.created_at.slice(0, 16).replace("T", " "))} UTC</time></header>
${body}
${sources(item.source_urls)}
</article>`;
}

export function renderBoardHtml(all: BoardItem[], opts: { filter?: string; refreshSeconds?: number } = {}): string {
  // A dossier card already shows its structure image; skip the standalone structure card for that material.
  const dossierImages = new Set(all.filter((i) => i.kind === "material_dossier" && i.image_url).map((i) => i.material_id));
  const items = all.filter((i) => !(i.kind === "structure_image" && dossierImages.has(i.material_id)));
  const cards = items.length
    ? items.map(card).join("\n")
    : `<p class="empty">Nothing on the board yet. Dossiers, line-feasibility reports, QA packets and supplier evidence appear here as the agent works.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${opts.refreshSeconds ? `<meta http-equiv="refresh" content="${Math.max(5, Math.floor(opts.refreshSeconds))}">` : ""}
<title>Evidence board · Supplier Chief of Staff</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Inter+Tight:wght@500;600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root { --bg:#FDFDFC; --card:#FFFFFF; --line:#EAE8E5; --ink:#141311; --muted:#908E87; --accent:#F25C05; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.5 Inter, system-ui, sans-serif; -webkit-font-smoothing:antialiased; }
  main { max-width:1280px; margin:0 auto; padding:40px 24px 64px; }
  .top h1 { font-family:"Inter Tight", Inter, sans-serif; font-weight:600; font-size:28px; letter-spacing:-0.01em; margin:4px 0 6px; }
  .top p { margin:0; color:var(--muted); max-width:720px; }
  .board { margin-top:32px; columns:3 360px; column-gap:16px; }
  .card { break-inside:avoid; background:var(--card); border:1px solid var(--line); border-radius:8px; padding:18px 18px 14px; margin:0 0 16px; }
  .card h2 { font-family:"Inter Tight", Inter, sans-serif; font-weight:600; font-size:17px; line-height:1.3; margin:6px 0 2px; }
  .label { display:block; font-family:"Geist Mono", ui-monospace, monospace; font-size:10.5px; letter-spacing:0.08em; text-transform:uppercase; color:var(--muted); margin:14px 0 6px; }
  header .label { margin-top:0; }
  .muted { color:var(--muted); }
  .small { font-size:12px; }
  .accent { color:var(--accent); font-weight:500; }
  .note { color:var(--muted); margin:10px 0; }
  .mono { font-variant-numeric:tabular-nums; }
  p { margin:10px 0; }
  a { color:var(--ink); text-decoration:underline; text-decoration-color:var(--line); text-underline-offset:2px; }
  a:hover { text-decoration-color:var(--accent); }
  .structure { margin:12px 0 4px; display:flex; justify-content:center; border:1px solid var(--line); border-radius:8px; background:#fff; }
  .structure img { max-width:100%; height:auto; display:block; }
  .kv { display:grid; grid-template-columns:max-content 1fr; gap:4px 14px; margin:10px 0 0; }
  .kv dt { color:var(--muted); }
  .kv dd { margin:0; overflow-wrap:anywhere; }
  .list { margin:0; padding-left:16px; }
  .list li { margin:3px 0; }
  .table-wrap { overflow-x:auto; margin-top:12px; }
  table { width:100%; border-collapse:collapse; font-size:12.5px; font-variant-numeric:tabular-nums; }
  th { text-align:left; font-weight:500; color:var(--muted); border-bottom:1px solid var(--line); padding:4px 6px 4px 0; }
  td { border-bottom:1px solid var(--line); padding:4px 6px 4px 0; white-space:nowrap; }
  .num { text-align:right; }
  tr.risk td { color:var(--accent); }
  .sources { margin-top:14px; padding-top:10px; border-top:1px solid var(--line); display:flex; flex-direction:column; gap:2px; font-size:12px; }
  .sources .label { margin:0 0 2px; }
  .sources a { color:var(--muted); overflow-wrap:anywhere; }
  .empty { color:var(--muted); margin-top:32px; }
</style>
</head>
<body>
<main>
<section class="top">
<span class="label">Evidence board${opts.filter ? ` · ${esc(opts.filter)}` : ""}</span>
<h1>What the agent looked at</h1>
<p>Chemical dossiers, production-line feasibility, QA packets and supplier evidence gathered during missions. Corvane Biologics is fictional and its inventory, schedules and suppliers are synthetic; PubChem and web evidence are live.</p>
</section>
<section class="board">
${cards}
</section>
</main>
</body>
</html>`;
}
