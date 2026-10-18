/**
 * Quality fit of a sourced material for the production lines that consume it.
 * Pure functions: the line sets the requirement, the supplier's approved grade and dossier set the evidence.
 */

export interface LineLike {
  external_id: string;
  name: string;
  line_type: string;
  cleanroom_grade: string;
}

export interface MaterialLike {
  grade: string;
  compendia: string[];
  endotoxin_class?: string | null;
  material_class: string;
}

export interface SupplierEvidence {
  supplier_id: string;
  supplier_name: string;
  approved_grade: string | null;
  qualification_state: string;
  dmf: boolean;
  cep: boolean;
  rejection_rate: number | null;
  otd_pct: number | null;
}

export interface LineRequirement {
  line_id: string;
  line_name: string;
  line_type: string;
  cleanroom_grade: string;
  needs_low_endotoxin: boolean;
  needs_parenteral: boolean;
  needs_compendia: string[];
  rationale: string;
}

const STERILE_LINES = new Set(["upstream_bioreactor", "downstream_purification", "formulation", "aseptic_fill", "lyophilization"]);

/** What a line demands of an excipient: sterile and parenteral lines need low-endotoxin parenteral grade and USP-NF + Ph. Eur. */
export function lineRequirement(line: LineLike): LineRequirement {
  const sterile = STERILE_LINES.has(line.line_type) || ["A", "B"].includes(line.cleanroom_grade);
  const inhaled = line.line_type === "inhaler_fill";
  return {
    line_id: line.external_id,
    line_name: line.name,
    line_type: line.line_type,
    cleanroom_grade: line.cleanroom_grade,
    needs_low_endotoxin: sterile,
    needs_parenteral: sterile,
    needs_compendia: sterile || inhaled ? ["USP-NF", "Ph. Eur."] : ["USP-NF"],
    rationale: sterile
      ? `${line.line_type.replace(/_/g, " ")} at cleanroom grade ${line.cleanroom_grade}: parenteral, low-endotoxin, USP-NF + Ph. Eur.`
      : inhaled
        ? "inhalation fill: inhalation grade, USP-NF + Ph. Eur."
        : "oral solid dose: compendial grade, USP-NF",
  };
}

export interface FitResult {
  supplier_id: string;
  supplier_name: string;
  approved_grade: string | null;
  meets_requirement: boolean;
  gaps: string[];
  /** 0–100: dossier strength (CEP, DMF), lot rejection rate, on-time delivery, qualification state. */
  quality_score: number;
  rank: number;
}

/** Ranks approved suppliers for one material against the strictest requirement among the consuming lines. */
export function qualityFit(material: MaterialLike, lines: LineLike[], suppliers: SupplierEvidence[]): { requirement: LineRequirement[]; fits: FitResult[] } {
  const reqs = lines.map(lineRequirement);
  const needsLowEndo = reqs.some((r) => r.needs_low_endotoxin);
  const needsParenteral = reqs.some((r) => r.needs_parenteral);
  const needsCompendia = [...new Set(reqs.flatMap((r) => r.needs_compendia))];
  const isRestricted = material.material_class === "adjuvant_biologic";

  const fits = suppliers.map((s) => {
    const grade = (s.approved_grade ?? "").toLowerCase();
    const gaps: string[] = [];
    if (!isRestricted) {
      if (needsParenteral && !/parenteral|injectable/.test(grade)) gaps.push("not a parenteral grade");
      if (needsLowEndo && !/low[- ]endotoxin/.test(grade)) gaps.push("endotoxin limit not stated as low");
      const missing = needsCompendia.filter((c) => !material.compendia.includes(c));
      if (missing.length) gaps.push(`material spec lacks ${missing.join(", ")}`);
    } else if (!/licensed/.test(grade)) {
      gaps.push("not the licensed material");
    }
    if (!["quality_approved", "released_for_use"].includes(s.qualification_state)) gaps.push(`qualification state ${s.qualification_state}`);
    const score =
      (s.cep ? 20 : 0) +
      (s.dmf ? 15 : 0) +
      Math.max(0, 30 - (s.rejection_rate ?? 0.05) * 1000) +
      Math.max(0, ((s.otd_pct ?? 80) - 70) * 1) +
      (s.qualification_state === "released_for_use" ? 10 : 5);
    return {
      supplier_id: s.supplier_id,
      supplier_name: s.supplier_name,
      approved_grade: s.approved_grade,
      meets_requirement: gaps.length === 0,
      gaps,
      quality_score: Math.round(Math.min(100, score)),
      rank: 0,
    };
  });
  fits
    .sort((a, b) => Number(b.meets_requirement) - Number(a.meets_requirement) || b.quality_score - a.quality_score)
    .forEach((f, i) => (f.rank = i + 1));
  return { requirement: reqs, fits };
}
