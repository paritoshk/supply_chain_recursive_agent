/**
 * PubChem PUG REST / PUG View client (public, keyless). Fetch is injectable so tests run offline.
 *
 * - Properties: /rest/pug/compound/name/<name>/property/.../JSON
 * - CAS numbers: /rest/pug/compound/cid/<cid>/synonyms/JSON (synonyms matching the CAS pattern)
 * - Structure image: /rest/pug/compound/cid/<cid>/PNG (a URL; PubChem renders the 2D depiction)
 * - GHS summary: /rest/pug_view/data/compound/<cid>/JSON?heading=GHS+Classification
 */
import type { Material } from "./types.ts";

export const PUBCHEM_REST = "https://pubchem.ncbi.nlm.nih.gov/rest/pug";
export const PUBCHEM_VIEW = "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view";
const PROPS = "MolecularFormula,MolecularWeight,IUPACName,CanonicalSMILES,XLogP";

export const pubchemPropertyUrl = (name: string) => `${PUBCHEM_REST}/compound/name/${encodeURIComponent(name)}/property/${PROPS}/JSON`;
export const pubchemSynonymsUrl = (cid: number) => `${PUBCHEM_REST}/compound/cid/${cid}/synonyms/JSON`;
export const pubchemImageUrl = (cid: number) => `${PUBCHEM_REST}/compound/cid/${cid}/PNG`;
export const pubchemGhsUrl = (cid: number) => `${PUBCHEM_VIEW}/data/compound/${cid}/JSON?heading=GHS+Classification`;
export const pubchemPageUrl = (cid: number) => `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}`;

export interface GhsSummary {
  signal_word: string | null;
  pictograms: string[];
  hazard_statements: string[];
  /** e.g. "Not Classified" for most compendial excipients. */
  classification_note: string | null;
}

export interface PubchemCompound {
  query: string;
  cid: number;
  molecular_formula: string | null;
  molecular_weight: number | null;
  iupac_name: string | null;
  smiles: string | null;
  xlogp: number | null;
  cas: string[];
  synonyms: string[];
  image_url: string;
  page_url: string;
  ghs: GhsSummary | null;
  source_urls: string[];
}

export type PubchemLookup =
  | { status: "found"; compound: PubchemCompound; tried: string[]; source_urls: string[] }
  | { status: "no_cid"; tried: string[]; explanation: string; source_urls: string[] }
  | { status: "not_applicable"; tried: string[]; explanation: string; source_urls: string[] }
  | { status: "error"; tried: string[]; explanation: string; source_urls: string[] };

/** PubChem names for materials whose catalog substance name is not a PubChem compound name. */
export const PUBCHEM_NAMES: Record<string, string> = {
  "MAT-HIS": "L-histidine",
  "MAT-HIS-HCL": "L-histidine monohydrochloride monohydrate",
  "MAT-ARG": "L-arginine hydrochloride",
  "MAT-TRE-HP": "trehalose dihydrate",
  "MAT-NAP-DI": "sodium phosphate dibasic dihydrate",
  "MAT-NAP-MONO": "sodium phosphate monobasic monohydrate",
  "MAT-CIT": "citric acid monohydrate",
  "MAT-NACIT": "sodium citrate dihydrate",
  "MAT-LAC-INH": "lactose monohydrate",
  "MAT-LAC-FINE": "lactose monohydrate",
  "MAT-SIO2": "silicon dioxide",
  "MAT-PEGL": "DMG-PEG 2000",
  "MAT-UMEC": "umeclidinium bromide",
  "MAT-VIL": "vilanterol trifenatate",
  "MAT-AMOX": "amoxicillin trihydrate",
  "MAT-AMOX-NA": "amoxicillin sodium",
  "MAT-CLAV": "potassium clavulanate",
};

const POLYMER_OR_MIXTURE = /polysorbate|poloxamer|povidone|hypromellose|cellulose|croscarmellose|film coating|ionizable lipid|medium|feed/i;

/** Classes that are not discrete chemical entities in our catalog. */
export function pubchemNotApplicable(m: Pick<Material, "material_class" | "substance">): string | null {
  if (m.material_class === "primary_packaging") return "Primary packaging component (glass, elastomer, polymer or foil): not a discrete chemical compound, so PubChem has no CID. Use the supplier drawing, USP/Ph. Eur. chapter compliance and extractables data instead.";
  if (m.material_class === "process_consumable") return "Process consumable (single-use assembly, resin, filter or medium): a device or formulated mixture, so PubChem has no CID. Use the supplier validation guide and extractables data instead.";
  if (m.material_class === "adjuvant_biologic") return `Licensed adjuvant (${m.substance}): a proprietary natural-product or biologic preparation supplied under licence. A public PubChem record for a related molecule is not the licensed material, so no CID is reported. Identity is defined by the licensor's specification.`;
  return null;
}

/** Names to try, most specific first (override, substance + salt form, substance). */
export function pubchemNameCandidates(m: Pick<Material, "external_id" | "substance"> & { salt_form?: string | null }): string[] {
  const out = [PUBCHEM_NAMES[m.external_id], m.salt_form && m.salt_form !== "free base" ? `${m.substance} ${m.salt_form}` : null, m.substance];
  return [...new Set(out.filter((x): x is string => Boolean(x)))].slice(0, 3);
}

const CAS_RE = /^\d{2,7}-\d{2}-\d$/;

/** Pure: PUG View GHS Classification record -> summary. */
export function parseGhs(json: unknown): GhsSummary | null {
  const pictograms = new Set<string>();
  const hazards: string[] = [];
  let signal: string | null = null;
  let note: string | null = null;
  type Info = { Name?: string; Value?: { StringWithMarkup?: Array<{ String?: string; Markup?: Array<{ Extra?: string; Type?: string }> }> } };
  type Sec = { Section?: Sec[]; Information?: Info[] };
  const walk = (sec: Sec) => {
    for (const info of sec.Information ?? []) {
      const parts = info.Value?.StringWithMarkup ?? [];
      if (info.Name === "Pictogram(s)") for (const p of parts) for (const mk of p.Markup ?? []) if (mk.Extra) pictograms.add(mk.Extra);
      if (info.Name === "Signal" && !signal) signal = parts[0]?.String?.trim() || null;
      if (info.Name === "GHS Hazard Statements") {
        for (const p of parts) {
          const s = p.String?.trim();
          if (!s) continue;
          if (/^not classified/i.test(s)) note ??= "Not Classified";
          else if (/^H\d{3}/.test(s)) hazards.push(s.replace(/\s*\[.*$/, "").replace(/\s*\([^)]*%\)/, ""));
        }
      }
    }
    for (const child of sec.Section ?? []) walk(child);
  };
  const rec = (json as { Record?: Sec } | null)?.Record;
  if (!rec) return null;
  walk(rec);
  return { signal_word: signal, pictograms: [...pictograms], hazard_statements: [...new Set(hazards)].slice(0, 8), classification_note: note };
}

async function getJson(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<{ status: number; body: unknown }> {
  const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/**
 * Looks a material up in PubChem. Never throws: mixtures, biologics and network failures come back
 * as a status with an explanation.
 */
export async function pubchemLookup(
  m: Pick<Material, "external_id" | "substance" | "material_class"> & { salt_form?: string | null },
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; ghs?: boolean } = {},
): Promise<PubchemLookup> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const na = pubchemNotApplicable(m);
  if (na) return { status: "not_applicable", tried: [], explanation: na, source_urls: [] };

  const tried: string[] = [];
  const urls: string[] = [];
  let lastError: string | null = null;
  for (const name of pubchemNameCandidates(m)) {
    tried.push(name);
    const url = pubchemPropertyUrl(name);
    urls.push(url);
    let res: { status: number; body: unknown };
    try {
      res = await getJson(fetchImpl, url, timeoutMs);
    } catch (err) {
      lastError = (err as Error).message;
      continue;
    }
    if (res.status === 404) continue;
    if (res.status >= 400) {
      lastError = `PubChem ${res.status}`;
      continue;
    }
    const p = (res.body as { PropertyTable?: { Properties?: Array<Record<string, unknown>> } })?.PropertyTable?.Properties?.[0];
    const cid = typeof p?.CID === "number" ? p.CID : null;
    if (!p || cid == null) continue;

    const compound: PubchemCompound = {
      query: name,
      cid,
      molecular_formula: (p.MolecularFormula as string) ?? null,
      molecular_weight: p.MolecularWeight != null ? Number(p.MolecularWeight) : null,
      iupac_name: (p.IUPACName as string) ?? null,
      smiles: ((p.CanonicalSMILES ?? p.ConnectivitySMILES ?? p.SMILES) as string) ?? null,
      xlogp: typeof p.XLogP === "number" ? p.XLogP : null,
      cas: [],
      synonyms: [],
      image_url: pubchemImageUrl(cid),
      page_url: pubchemPageUrl(cid),
      ghs: null,
      source_urls: [url],
    };
    const [syn, ghs] = await Promise.allSettled([
      getJson(fetchImpl, pubchemSynonymsUrl(cid), timeoutMs),
      opts.ghs === false ? Promise.resolve(null) : getJson(fetchImpl, pubchemGhsUrl(cid), timeoutMs),
    ]);
    if (syn.status === "fulfilled" && syn.value.status < 400) {
      const list = (syn.value.body as { InformationList?: { Information?: Array<{ Synonym?: string[] }> } })?.InformationList?.Information?.[0]?.Synonym ?? [];
      compound.cas = [...new Set(list.filter((s) => CAS_RE.test(s)))].slice(0, 3);
      compound.synonyms = list.filter((s) => !CAS_RE.test(s)).slice(0, 8);
      compound.source_urls.push(pubchemSynonymsUrl(cid));
    }
    if (ghs.status === "fulfilled" && ghs.value && ghs.value.status < 400) {
      compound.ghs = parseGhs(ghs.value.body);
      compound.source_urls.push(pubchemGhsUrl(cid));
    }
    compound.source_urls.push(compound.page_url);
    return { status: "found", compound, tried, source_urls: compound.source_urls };
  }
  if (lastError && tried.length && urls.length) {
    return { status: "error", tried, explanation: `PubChem lookup failed: ${lastError}`, source_urls: urls };
  }
  return {
    status: "no_cid",
    tried,
    source_urls: urls,
    explanation: POLYMER_OR_MIXTURE.test(m.substance)
      ? `${m.substance} is a polymer or mixture with a distribution of structures; PubChem files it as a substance, not a single compound, so there is no CID or structure image. Identity rests on the compendial monograph and the supplier CoA.`
      : `No PubChem compound matches ${tried.map((t) => `"${t}"`).join(", ")}. The material may be proprietary or named differently; identity rests on our specification and the supplier CoA.`,
  };
}
