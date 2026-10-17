import type { Material } from "../types.ts";

export type SpecMaterial = Pick<
  Material,
  "external_id" | "substance" | "grade" | "compendia" | "sourcing_mode" | "material_class"
> & { salt_form?: string | null | undefined; endotoxin_class?: string | null | undefined; name?: string };

export type SpecMatch = "exact" | "grade_mismatch" | "form_mismatch" | "not_equivalent";

export interface SpecPrefilterResult {
  match: SpecMatch;
  reasons: string[];
}

const RANK: Record<SpecMatch, number> = { exact: 0, grade_mismatch: 1, form_mismatch: 2, not_equivalent: 3 };
const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/**
 * Deterministic spec pre-filter run before any model scoring. It never upgrades a match:
 *  - different substance, or any access-led / process-locked item other than the exact one -> not_equivalent
 *  - different salt / hydrate form -> form_mismatch
 *  - different grade, missing required compendia, or a different endotoxin class -> grade_mismatch
 */
export function specPrefilter(required: SpecMaterial, candidate: SpecMaterial): SpecPrefilterResult {
  if (required.external_id === candidate.external_id) return { match: "exact", reasons: ["same material record"] };

  const reasons: string[] = [];
  let match: SpecMatch = "exact";
  const worse = (m: SpecMatch, reason: string) => {
    reasons.push(reason);
    if (RANK[m] > RANK[match]) match = m;
  };

  if (norm(required.substance) !== norm(candidate.substance)) {
    worse("not_equivalent", `different substance (${required.substance} vs ${candidate.substance})`);
    return { match, reasons };
  }
  if (required.sourcing_mode === "access_led" || candidate.sourcing_mode === "access_led") {
    worse(
      "not_equivalent",
      "access-led material: an analogue or alternate source is not the licensed material; substitution needs a qualification and regulatory change",
    );
  }
  if (required.sourcing_mode === "process_locked" || candidate.sourcing_mode === "process_locked") {
    worse("not_equivalent", "process-locked item: a different item requires process requalification");
  }
  if (norm(required.salt_form) !== norm(candidate.salt_form)) {
    worse("form_mismatch", `salt/hydrate form differs (${required.salt_form ?? "none"} vs ${candidate.salt_form ?? "none"})`);
  }
  if (norm(required.grade) !== norm(candidate.grade)) {
    worse("grade_mismatch", `grade differs (${required.grade} vs ${candidate.grade})`);
  }
  const have = new Set(candidate.compendia.map(norm));
  const missing = required.compendia.filter((c) => !have.has(norm(c)));
  if (missing.length) worse("grade_mismatch", `missing compendia: ${missing.join(", ")}`);
  if (required.endotoxin_class && norm(required.endotoxin_class) !== norm(candidate.endotoxin_class)) {
    worse("grade_mismatch", `endotoxin class differs (${required.endotoxin_class} vs ${candidate.endotoxin_class ?? "unspecified"})`);
  }
  if (match === "exact") reasons.push("substance, form, grade, compendia and endotoxin class match");
  return { match, reasons };
}
