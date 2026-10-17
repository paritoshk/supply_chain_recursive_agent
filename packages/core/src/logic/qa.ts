/**
 * Incoming-material QA rules (synthetic but typical GMP practice). Pure functions, unit-tested.
 *
 *  - Purchased lots arrive quarantined and are usable only after QC release (sampling, testing, CoA review).
 *  - Lots transferred between our own GMP sites were already released by the donor site; the receiving
 *    site still quarantines them for receipt verification (identity test, CoC and transport-condition review).
 *  - Buying from a supplier that has never supplied this material to this site is a new source:
 *    change control + comparability before first use.
 */
import type { MaterialClass, QualificationState } from "../types.ts";

/** Days from receipt to QC release for a purchased lot, by material class. */
export const QC_RELEASE_DAYS: Record<MaterialClass, number> = {
  compendial_excipient: 7,
  specialty_excipient: 10,
  lipid_surfactant: 12,
  small_molecule_api: 14,
  adjuvant_biologic: 21,
  primary_packaging: 5,
  process_consumable: 5,
};

/** Days from receipt to release for an inter-site transfer (receipt verification only), by material class. */
export const TRANSFER_RELEASE_DAYS: Record<MaterialClass, number> = {
  compendial_excipient: 2,
  specialty_excipient: 2,
  lipid_surfactant: 3,
  small_molecule_api: 3,
  adjuvant_biologic: 5,
  primary_packaging: 1,
  process_consumable: 1,
};

export function qcReleaseDays(materialClass: MaterialClass): number {
  return QC_RELEASE_DAYS[materialClass] ?? 14;
}

export function transferReleaseDays(materialClass: MaterialClass): number {
  return TRANSFER_RELEASE_DAYS[materialClass] ?? 3;
}

export interface ChangeControlInput {
  supplier_id: string;
  qualification_state: QualificationState;
  /** Suppliers whose lots this site has already received for this material (the established sources). */
  established_supplier_ids: Iterable<string>;
}

export interface ChangeControlAssessment {
  required: boolean;
  reasons: string[];
}

/**
 * Change control is required when the purchase would be the first lot from this supplier for this
 * material at this site (new source -> comparability), or when the supplier is approved by QA but not
 * yet released for routine use.
 */
export function changeControlAssessment(input: ChangeControlInput): ChangeControlAssessment {
  const established = new Set(input.established_supplier_ids);
  const reasons: string[] = [];
  if (!established.has(input.supplier_id)) {
    reasons.push(`${input.supplier_id} has not supplied this material to this site before: new source, change control and comparability required`);
  }
  if (input.qualification_state !== "released_for_use") {
    reasons.push(`${input.supplier_id} is ${input.qualification_state}, not released_for_use: first-use release by QA required`);
  }
  return { required: reasons.length > 0, reasons };
}

export function changeControlRequired(input: ChangeControlInput): boolean {
  return changeControlAssessment(input).required;
}

/** True when the storage condition needs temperature-controlled (cold-chain) transport. */
export function isColdChain(storage: string): boolean {
  return /(^|[^0-9])(-\d+|2\s*-\s*8)\s*C\b/i.test(storage) || /frozen|refrigerat/i.test(storage);
}

/** Substances where a TSE/BSE (animal-origin) statement is expected. */
const TSE_RELEVANT = [
  "lactose",
  "magnesium stearate",
  "stearate",
  "polysorbate",
  "glycerol",
  "cholesterol",
  "squalene",
  "histidine",
  "arginine",
  "glycine",
  "medium",
  "feed",
  "poloxamer",
  "MPL",
  "lipid A",
  "DOPC",
  "DSPC",
];

export function tseStatementRelevant(substance: string, materialClass?: MaterialClass): boolean {
  if (materialClass === "adjuvant_biologic") return true;
  const s = substance.toLowerCase();
  return TSE_RELEVANT.some((t) => s.includes(t.toLowerCase()));
}

export interface DocumentsInput {
  substance: string;
  material_class: MaterialClass;
  storage: string;
  /** Regulatory filings held by the chosen (or primary) supplier. */
  dmf?: boolean;
  cep?: boolean;
  supplier_id?: string | null;
  change_control_required?: boolean;
  transfer?: boolean;
}

/** Release documents QA needs before the material can be used. */
export function documentsRequired(input: DocumentsInput): string[] {
  const docs = ["Certificate of Analysis (CoA)", "Certificate of Conformance (CoC)"];
  if (tseStatementRelevant(input.substance, input.material_class)) docs.push("TSE/BSE statement");
  const who = input.supplier_id ? ` (${input.supplier_id})` : "";
  if (input.dmf) docs.push(`US DMF reference / letter of authorisation${who}`);
  if (input.cep) docs.push(`CEP reference${who}`);
  if (input.change_control_required) docs.push("Change control record + comparability assessment (new source)");
  if (input.transfer) {
    docs.push("Inter-site transfer record with donor-site QA release status");
    if (isColdChain(input.storage)) docs.push("Temperature data-logger record for the shipment");
  }
  return docs;
}

export interface TransferRequirements {
  storage: string;
  cold_chain: boolean;
  /** Both sites hold the material under the same storage specification (one material master record). */
  storage_conditions_match: boolean;
  release_days: number;
  documents: string[];
  notes: string[];
}

/** What a GMP inter-site transfer of this material needs. */
export function transferRequirements(m: { substance: string; material_class: MaterialClass; storage: string }): TransferRequirements {
  const cold = isColdChain(m.storage);
  return {
    storage: m.storage,
    cold_chain: cold,
    storage_conditions_match: true,
    release_days: transferReleaseDays(m.material_class),
    documents: [
      "Inter-site transfer record with donor-site QA release status",
      "Original supplier CoA and CoC (copied with the lot)",
      ...(cold ? ["Temperature data-logger record for the shipment"] : []),
      "Receiving-site identity test and receipt verification",
    ],
    notes: [
      cold ? `Ship ${m.storage}; validated cold-chain lane and data logger required.` : `Ship at ${m.storage}.`,
      "Remaining shelf life is carried over; the receiving site does not re-date the lot.",
    ],
  };
}
