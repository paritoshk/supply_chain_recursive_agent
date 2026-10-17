/**
 * B4 Spec matching. 41 labeled (required, candidate) pairs built from the seed catalog plus spec
 * variants of catalog records (same substance with a different grade / salt / hydrate / endotoxin
 * class / compendia; analogue vs licensed; process-locked alternates; synonyms; origin changes).
 * Evaluates (a) the deterministic specPrefilter (what match_spec runs) and (b) LLM-only
 * classification per model. Positive class = "equivalent" (the dangerous error is a false equivalence).
 */
import "./lib/env.ts";
import { createStore, specPrefilter, type Material } from "@supply-agent/core";
import { call, parseJsonLoose, pool, usageReport } from "./lib/llm.ts";
import { candidates, short } from "./lib/models.ts";
import { priorRows, writeResult } from "./lib/io.ts";
import { percentile, prf, r2 } from "./lib/stats.ts";

const store = createStore();
const mat = (id: string): Material => {
  const m = store.material(id);
  if (!m) throw new Error(`missing ${id}`);
  return m;
};
let seq = 0;
const variant = (id: string, patch: Partial<Material>): Material => ({ ...mat(id), external_id: `OFFER-${String(++seq).padStart(3, "0")}`, ...patch });

type Gold = "equivalent" | "not_equivalent";
interface Pair { id: string; kind: string; hard?: boolean; required: Material; candidate: Material; gold: Gold; why: string }

const P: Pair[] = [];
const add = (kind: string, required: string, candidate: Material, gold: Gold, why: string, hard = false) =>
  P.push({ id: `P${String(P.length + 1).padStart(2, "0")}`, kind, required: mat(required), candidate, gold, why, hard });

// ---- equivalent: same spec under another supplier's naming, compendia superset, extra endotoxin control
add("same spec, renamed", "MAT-SUC-INJ", variant("MAT-SUC-INJ", { name: "Sucrose multicompendial, injectable, low endotoxin" }), "equivalent", "identical spec fields");
add("same spec, renamed", "MAT-MAN-PAR", variant("MAT-MAN-PAR", { name: "D-Mannitol parenteral, low bioburden/endotoxin" }), "equivalent", "identical spec fields");
add("same spec, renamed", "MAT-TRE-HP", variant("MAT-TRE-HP", { name: "Trehalose dihydrate HPLE (high purity, low endotoxin)" }), "equivalent", "same hydrate, grade, compendia");
add("compendia superset", "MAT-NACL", variant("MAT-NACL", { compendia: ["USP-NF", "Ph. Eur.", "JP", "ChP"] }), "equivalent", "candidate meets every required compendium plus ChP");
add("same spec, renamed", "MAT-HIS", variant("MAT-HIS", { name: "L-Histidine base, multicompendial, low endotoxin" }), "equivalent", "same free base, grade, compendia");
add("same spec, renamed", "MAT-PS80-SR", variant("MAT-PS80-SR", { name: "Polysorbate 80 HP (high purity, low peroxide)" }), "equivalent", "same super-refined parenteral spec");
add("same spec, renamed", "MAT-MCC-102", variant("MAT-MCC-102", { name: "MCC PH-102 type, 100 um" }), "equivalent", "same particle grade and compendia");
add("grade text case/spacing", "MAT-HPMC", variant("MAT-HPMC", { grade: "2910 / 5 MPA.S FILM FORMER" }), "equivalent", "same grade, different capitalisation");
add("exceeds spec (extra endotoxin control)", "MAT-GLY", variant("MAT-GLY", { endotoxin_class: "low" }), "equivalent", "required has no endotoxin class; candidate is tighter");
add("compendia reordered", "MAT-KCL", variant("MAT-KCL", { compendia: ["JP", "USP-NF", "Ph. Eur."] }), "equivalent", "same compendia set");
add("same spec, renamed", "MAT-CIT", variant("MAT-CIT", { name: "Citric acid 1-hydrate, oral grade" }), "equivalent", "same monohydrate and grade");
add("same spec, renamed", "MAT-LAC-INH", variant("MAT-LAC-INH", { name: "Inhalation lactose, sieved carrier grade" }), "equivalent", "same carrier grade and hydrate");
add("same spec, renamed", "MAT-MGST", variant("MAT-MGST", { name: "Magnesium stearate, vegetable, tablet lubricant grade" }), "equivalent", "same grade and compendia");
add("synonym substance", "MAT-TRIS", variant("MAT-TRIS", { substance: "Tris", name: "Tris(hydroxymethyl)aminomethane, parenteral" }), "equivalent", "Tris is tromethamine", true);
add("synonym substance", "MAT-GLYC", variant("MAT-GLYC", { substance: "glycerin", name: "Glycerin, parenteral grade" }), "equivalent", "glycerin is glycerol", true);
add("synonym substance", "MAT-HPMC", variant("MAT-HPMC", { substance: "HPMC", name: "HPMC 2910, 5 mPa.s" }), "equivalent", "HPMC is hypromellose", true);

// ---- not equivalent: real catalog neighbours
add("grade + endotoxin + compendia", "MAT-SUC-INJ", mat("MAT-SUC-NF"), "not_equivalent", "oral NF grade for an injectable low-endotoxin requirement");
add("grade (parenteral vs DC)", "MAT-MAN-PAR", mat("MAT-MAN-DC"), "not_equivalent", "direct-compression grade, no endotoxin class");
add("salt form", "MAT-HIS", mat("MAT-HIS-HCL"), "not_equivalent", "free base vs monohydrochloride monohydrate");
add("purity grade", "MAT-PS80-SR", mat("MAT-PS80-STD"), "not_equivalent", "standard oral/topical grade for super-refined parenteral");
add("particle grade", "MAT-LAC-INH", mat("MAT-LAC-FINE"), "not_equivalent", "coarse carrier vs micronised fines");
add("grade (inhalation vs tablet)", "MAT-MGST-INH", mat("MAT-MGST"), "not_equivalent", "tablet lubricant for inhalation");
add("particle grade", "MAT-MCC-102", mat("MAT-MCC-101"), "not_equivalent", "50 um wet granulation vs 100 um DC");
add("salt + sterility", "MAT-AMOX", mat("MAT-AMOX-NA"), "not_equivalent", "trihydrate vs sterile sodium salt");
add("analogue vs licensed", "MAT-SAP-QS", mat("MAT-SAP-AN"), "not_equivalent", "development analogue of a licensed adjuvant");
add("different item (process-locked)", "MAT-VIAL-2R", mat("MAT-VIAL-6R"), "not_equivalent", "different vial format on a validated line");
add("different item (process-locked)", "MAT-STOP-13", mat("MAT-STOP-20"), "not_equivalent", "different stopper size");
add("different substance", "MAT-PS80-SR", mat("MAT-PS20"), "not_equivalent", "polysorbate 20 is a different molecule");
add("different substance", "MAT-DOPC", mat("MAT-DSPC"), "not_equivalent", "different phospholipid");
// ---- not equivalent: spec variants
add("hydrate form", "MAT-TRE-HP", variant("MAT-TRE-HP", { salt_form: "anhydrous", name: "Trehalose anhydrous, low endotoxin" }), "not_equivalent", "anhydrous vs dihydrate");
add("endotoxin class", "MAT-SUC-INJ", variant("MAT-SUC-INJ", { endotoxin_class: "standard", name: "Sucrose, multicompendial, standard endotoxin" }), "not_equivalent", "no low-endotoxin control");
add("missing compendium", "MAT-NACL", variant("MAT-NACL", { compendia: ["USP-NF", "Ph. Eur."] }), "not_equivalent", "JP missing");
add("grade", "MAT-MAN-PAR", variant("MAT-MAN-PAR", { grade: "oral", name: "Mannitol, oral grade (low endotoxin tested)" }), "not_equivalent", "oral grade");
add("viscosity grade", "MAT-HPMC", variant("MAT-HPMC", { grade: "2910 / 15 mPa.s film former", name: "Hypromellose 2910, 15 mPa.s" }), "not_equivalent", "15 vs 5 mPa.s");
add("salt form", "MAT-ARG", variant("MAT-ARG", { salt_form: "free base", name: "L-Arginine base" }), "not_equivalent", "free base vs hydrochloride");
add("blend basis", "MAT-CLAV", variant("MAT-CLAV", { grade: "neat (undiluted)", name: "Clavulanate potassium, neat" }), "not_equivalent", "neat vs 1:1 MCC blend");
add("different substance (API)", "MAT-FF", variant("MAT-FF", { substance: "fluticasone propionate", name: "Fluticasone propionate, micronised (inhalation)" }), "not_equivalent", "furoate and propionate are different APIs");
add("access-led alternate source", "MAT-SQU", variant("MAT-SQU", { name: "Squalene, shark-liver derived (vaccine grade)" }), "not_equivalent", "animal-origin source change for a licensed adjuvant component");
add("process-locked alternate vendor", "MAT-SUB-2000", variant("MAT-SUB-2000", { name: "Single-use bioreactor bag, 2000 L (alternate film platform)" }), "not_equivalent", "different validated assembly");
add("process-locked alternate resin", "MAT-PROA", variant("MAT-PROA", { name: "Protein A resin, alkali-stable (alternate ligand)" }), "not_equivalent", "different resin needs process requalification");
add("botanical origin (name only)", "MAT-SUC-INJ", variant("MAT-SUC-INJ", { name: "Sucrose, injectable low endotoxin, beet-derived (current source: cane)" }), "not_equivalent", "origin change needs assessment; not captured in structured fields", true);

const FIELDS = (m: Material) => ({ external_id: m.external_id, name: m.name, substance: m.substance, material_class: m.material_class, grade: m.grade, compendia: m.compendia, salt_form: m.salt_form ?? null, endotoxin_class: m.endotoxin_class ?? null, sourcing_mode: m.sourcing_mode });

// (a) deterministic
const detRows = P.map((p) => {
  const r = specPrefilter(p.required, p.candidate);
  const pred: Gold = r.match === "exact" ? "equivalent" : "not_equivalent";
  return { id: p.id, kind: p.kind, gold: p.gold, pred, match: r.match, reasons: r.reasons, correct: pred === p.gold };
});
const score = (rows: Array<{ gold: Gold; pred: Gold | null }>) => {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const r of rows) {
    if (r.pred == null) continue;
    if (r.gold === "equivalent") r.pred === "equivalent" ? tp++ : fn++;
    else r.pred === "equivalent" ? fp++ : tn++;
  }
  return prf(tp, fp, fn, tn);
};

// (b) LLM-only
const SYSTEM =
  "You are the spec matcher for a pharma supply agent. Decide whether the CANDIDATE material can be used in place of the REQUIRED material with no qualification or regulatory change. " +
  "Hard rule: never treat a different grade, salt, hydrate or an analogue as a substitute for a licensed material. " +
  'Reply with JSON only: {"label": "equivalent" | "not_equivalent", "reason": string (one sentence)}';
const prior = priorRows<{ model: string; id: string; error?: unknown }>("b4-spec-matching");
const models = candidates();
const t0 = Date.now();
const llmRows = await pool(models.flatMap((m) => P.map((p) => ({ m, p }))), 4, async ({ m, p }) => {
  const reuse = prior.get(`${m}|${p.id}`);
  if (reuse) return reuse as never as { id: string; model: string; gold: Gold; pred: Gold | null; error?: string; latency_ms?: number };
  const res = await call({
    model: m,
    temperature: 0,
    max_tokens: 4096,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: JSON.stringify({ required: FIELDS(p.required), candidate: { ...FIELDS(p.candidate), external_id: "CANDIDATE" } }) },
    ],
  });
  if (!res.ok) return { id: p.id, model: m, gold: p.gold, pred: null, error: res.error };
  const j = parseJsonLoose<{ label?: string; reason?: string }>(res.r.content) ?? parseJsonLoose(res.r.reasoning);
  const label = j?.label?.toLowerCase().replace(/[\s-]/g, "_");
  const pred: Gold | null = label === "equivalent" ? "equivalent" : label === "not_equivalent" ? "not_equivalent" : null;
  process.stdout.write(pred === p.gold ? "." : "x");
  return { id: p.id, model: m, gold: p.gold, pred, reason: j?.reason ?? null, error: pred ? undefined : `unparseable: ${(res.r.content ?? "").slice(0, 80)}`, latency_ms: res.r.latency_ms, tokens_in: res.r.tokens_in, tokens_out: res.r.tokens_out };
});
console.log();

const deterministic = { ...score(detRows), n: detRows.length, misses: detRows.filter((r) => !r.correct).map((r) => ({ id: r.id, kind: r.kind, gold: r.gold, match: r.match })) };
const per_model = models.map((m) => {
  const rs = llmRows.filter((r) => r.model === m);
  const ok = rs.filter((r) => r.pred != null);
  const lat = ok.map((r) => r.latency_ms ?? 0);
  return {
    model: m,
    label: short(m),
    n: rs.length,
    errors: rs.length - ok.length,
    ...score(ok),
    latency_ms: { p50: percentile(lat, 50), p95: percentile(lat, 95) },
    gate_b4: null as boolean | null,
    misses: ok.filter((r) => r.pred !== r.gold).map((r) => ({ id: r.id, kind: P.find((p) => p.id === r.id)?.kind, gold: r.gold, pred: r.pred })),
  };
});
for (const p of per_model) p.gate_b4 = p.n - p.errors > 0 ? (p.accuracy ?? 0) >= 0.9 && p.false_equivalence_rate === 0 : null;
// Hybrid as deployed: prefilter first; the model can only downgrade (never upgrade) a prefilter "exact".
const hybrid = models.map((m) => {
  const rows = P.map((p, i) => {
    const d = detRows[i]!;
    const l = llmRows.find((r) => r.model === m && r.id === p.id);
    return { gold: p.gold, pred: (d.pred === "equivalent" && l?.pred === "not_equivalent" ? "not_equivalent" : d.pred) as Gold };
  });
  return { model: m, label: short(m), ...score(rows) };
});

console.log(`deterministic acc ${deterministic.accuracy} P ${deterministic.precision} R ${deterministic.recall} FE ${deterministic.false_equivalence_rate}`);
for (const p of per_model) console.log(`${p.label.padEnd(22)} acc ${p.accuracy} P ${p.precision} R ${p.recall} F1 ${p.f1} FE ${p.false_equivalence_rate} err ${p.errors}`);
for (const h of hybrid) console.log(`hybrid ${h.label.padEnd(15)} acc ${h.accuracy} FE ${h.false_equivalence_rate}`);

writeResult("b4-spec-matching", {
  method: {
    pairs: P.length,
    gold_equivalent: P.filter((p) => p.gold === "equivalent").length,
    gold_not_equivalent: P.filter((p) => p.gold === "not_equivalent").length,
    hard_pairs: P.filter((p) => p.hard).map((p) => p.id),
    positive_class: "equivalent",
    deterministic: "specPrefilter (match_spec): exact => equivalent, anything else => not_equivalent",
    llm: "model sees both records' spec fields (name, substance, class, grade, compendia, salt_form, endotoxin_class, sourcing_mode), one call per pair, temperature 0, JSON label",
    hybrid: "prefilter decides; the model may only veto an 'exact' (never upgrade a mismatch)",
    gate: "B4 accuracy >= 90% and false-equivalence = 0",
  },
  pairs: P.map((p) => ({ id: p.id, kind: p.kind, hard: !!p.hard, gold: p.gold, why: p.why, required: FIELDS(p.required), candidate: FIELDS(p.candidate) })),
  deterministic,
  deterministic_rows: detRows,
  per_model,
  hybrid,
  rows: llmRows,
  wall_s: r2((Date.now() - t0) / 1000),
  usage: usageReport(),
});
