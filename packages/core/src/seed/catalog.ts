/**
 * Static catalog for the synthetic Corvane Biologics dataset.
 * Corvane Biologics and every supplier below are fictional. Websites use the reserved `.example` TLD.
 * Price bands, lead times and approved-supplier counts follow the realism rules (synthetic parameters,
 * not observed prices).
 */
import type { MaterialClass, Region, SiteStage, SourcingMode, SupplierType, Unit } from "../types.ts";

export const SEED = 1729;
/** Fixed "today" for deterministic seeding. The simulate-day control advances app_state, not this. */
export const SEED_TODAY = "2026-10-17";
export const ORGANIZATION_ID = "org_corvane";
export const CUSTOMER_NAME = "Corvane Biologics";

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

export type SiteId = "SITE-RAL" | "SITE-KOP" | "SITE-CAM" | "SITE-GHE" | "SITE-LYO" | "SITE-COR" | "SITE-TUA" | "SITE-HYD";

export const SITES: Array<{
  external_id: SiteId;
  name: string;
  city: string;
  country: string;
  region: Region;
  stage: SiteStage;
  lat: number;
  lng: number;
}> = [
  { external_id: "SITE-RAL", name: "Raleigh Drug Product", city: "Raleigh, NC", country: "US", region: "US-East", stage: "drug_product", lat: 35.7796, lng: -78.6382 },
  { external_id: "SITE-KOP", name: "King of Prussia Biologics DS", city: "King of Prussia, PA", country: "US", region: "US-East", stage: "drug_substance", lat: 40.0893, lng: -75.3963 },
  { external_id: "SITE-CAM", name: "Cambridge Inhaled", city: "Cambridge", country: "GB", region: "UK", stage: "inhaled", lat: 52.2053, lng: 0.1218 },
  { external_id: "SITE-GHE", name: "Ghent Vaccine Antigen", city: "Ghent", country: "BE", region: "EU", stage: "vaccine_antigen", lat: 51.0543, lng: 3.7174 },
  { external_id: "SITE-LYO", name: "Lyon Fill/Finish", city: "Lyon", country: "FR", region: "EU", stage: "fill_finish", lat: 45.764, lng: 4.8357 },
  { external_id: "SITE-COR", name: "Cork Oral Solids", city: "Cork", country: "IE", region: "EU", stage: "oral_solids", lat: 51.8985, lng: -8.4756 },
  { external_id: "SITE-TUA", name: "Tuas Drug Substance", city: "Tuas", country: "SG", region: "APAC", stage: "drug_substance", lat: 1.3187, lng: 103.6390 },
  { external_id: "SITE-HYD", name: "Hyderabad API", city: "Hyderabad", country: "IN", region: "IN", stage: "api", lat: 17.385, lng: 78.4867 },
];

export const SITE_CODE: Record<SiteId, string> = {
  "SITE-RAL": "RAL",
  "SITE-KOP": "KOP",
  "SITE-CAM": "CAM",
  "SITE-GHE": "GHE",
  "SITE-LYO": "LYO",
  "SITE-COR": "COR",
  "SITE-TUA": "TUA",
  "SITE-HYD": "HYD",
};

// ---------------------------------------------------------------------------
// Suppliers (30, fictional)
// ---------------------------------------------------------------------------

export type SupKey =
  | "NOR" | "ALT" | "BRW" | "KES" | "HAL" | "COR" | "TAM" | "VEL" | "ORI" | "OST"
  | "LIN" | "SAR" | "DEC" | "MON" | "ARC" | "HOS" | "BAV" | "FEN" | "QSD" | "VAN"
  | "GLN" | "RVS" | "QIN" | "ASH" | "CAL" | "COB" | "WAI" | "HAR" | "ELB" | "SAF";

export const SUPPLIERS: Array<{
  key: SupKey;
  name: string;
  country: string;
  manufacturing_country?: string;
  type: SupplierType;
}> = [
  { key: "NOR", name: "Nordvik Excipients", country: "NO", type: "manufacturer" },
  { key: "ALT", name: "Altamira Lipids", country: "ES", type: "manufacturer" },
  { key: "BRW", name: "Brightwater Sugars", country: "US", type: "manufacturer" },
  { key: "KES", name: "Kestrel Polyols", country: "FR", type: "manufacturer" },
  { key: "HAL", name: "Halvard Fine Chemicals", country: "DE", type: "manufacturer" },
  { key: "COR", name: "Corrib Pharma Supply", country: "IE", type: "distributor" },
  { key: "TAM", name: "Tamsin Bioprocess", country: "GB", manufacturing_country: "PL", type: "manufacturer" },
  { key: "VEL", name: "Velasco Adjuvant Sciences", country: "CL", type: "manufacturer" },
  { key: "ORI", name: "Oriel Lipid Works", country: "US", type: "manufacturer" },
  { key: "OST", name: "Ostrava Pharma Packaging", country: "CZ", type: "manufacturer" },
  { key: "LIN", name: "Lindqvist Elastomers", country: "SE", manufacturing_country: "DE", type: "manufacturer" },
  { key: "SAR", name: "Sarvam Actives", country: "IN", type: "manufacturer" },
  { key: "DEC", name: "Deccan Molecular", country: "IN", type: "manufacturer" },
  { key: "MON", name: "Monteverde Inhalation APIs", country: "PT", type: "manufacturer" },
  { key: "ARC", name: "Arcadia Media Systems", country: "US", type: "manufacturer" },
  { key: "HOS", name: "Hoshino Cellulose", country: "JP", manufacturing_country: "DE", type: "manufacturer" },
  { key: "BAV", name: "Bavaro Stearates", country: "IT", type: "manufacturer" },
  { key: "FEN", name: "Fenwick Cellulose", country: "US", type: "manufacturer" },
  { key: "QSD", name: "Quayside Chem Distribution", country: "SG", type: "distributor" },
  { key: "VAN", name: "Vantorre Pharma Brokers", country: "BE", type: "broker" },
  { key: "GLN", name: "Glenmoor Amino Acids", country: "GB", type: "manufacturer" },
  { key: "RVS", name: "Rhone Valley Surfactants", country: "FR", type: "manufacturer" },
  { key: "QIN", name: "Qinglan Biochem", country: "CN", type: "manufacturer" },
  { key: "ASH", name: "Ashgrove Resins", country: "US", manufacturing_country: "SE", type: "manufacturer" },
  { key: "CAL", name: "Calder Filtration", country: "GB", type: "manufacturer" },
  { key: "COB", name: "Cobalt Bay Squalene", country: "US", type: "manufacturer" },
  { key: "WAI", name: "Waitaki Dairy Excipients", country: "NZ", manufacturing_country: "NL", type: "manufacturer" },
  { key: "HAR", name: "Harbinger Trading", country: "HK", type: "broker" },
  { key: "ELB", name: "Elbe Process Chemicals", country: "DE", type: "manufacturer" },
  { key: "SAF", name: "Saffron Coast Chemicals", country: "IN", type: "distributor" },
];

export function supplierId(key: SupKey): string {
  const i = SUPPLIERS.findIndex((s) => s.key === key);
  return `SUP-${String(i + 1).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// Class-level economics (realism rules)
// ---------------------------------------------------------------------------

export const CLASS_RULES: Record<
  MaterialClass,
  { leadDays: [number, number]; approved: [number, number]; safetyDays: number; moq: [number, number] }
> = {
  compendial_excipient: { leadDays: [14, 56], approved: [3, 4], safetyDays: 14, moq: [25, 100] },
  specialty_excipient: { leadDays: [42, 112], approved: [1, 3], safetyDays: 21, moq: [25, 200] },
  lipid_surfactant: { leadDays: [56, 168], approved: [1, 3], safetyDays: 28, moq: [1, 10] },
  small_molecule_api: { leadDays: [56, 168], approved: [1, 3], safetyDays: 28, moq: [5, 50] },
  adjuvant_biologic: { leadDays: [112, 280], approved: [1, 2], safetyDays: 60, moq: [50, 200] },
  primary_packaging: { leadDays: [42, 140], approved: [1, 3], safetyDays: 21, moq: [10_000, 50_000] },
  process_consumable: { leadDays: [56, 210], approved: [1, 2], safetyDays: 30, moq: [1, 10] },
};

export const ADJUVANT_RFQ_REASON =
  "Proprietary adjuvant supplied under license agreement: no list price, quotation only (RFQ required).";

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

export interface CatalogMaterial {
  id: string;
  name: string;
  substance: string;
  cls: MaterialClass;
  grade: string;
  compendia: string[];
  salt?: string;
  endo?: string;
  mode: SourcingMode;
  unit: Unit;
  shelf: number;
  storage: string;
  sites: SiteId[];
  /** daily consumption range per site, in `unit` */
  daily: [number, number];
  /** USD per unit; null = quote only */
  band: [number, number] | null;
  /** eligible suppliers, in preference order (first is the primary released source) */
  pool: SupKey[];
}

const PH = ["USP-NF", "Ph. Eur.", "JP"];
const RT = "15-25 C, dry, protected from light";

export const MATERIALS: CatalogMaterial[] = [
  // --- compendial excipients (spec-led) ---
  { id: "MAT-SUC-INJ", name: "Sucrose, injectable grade (low endotoxin)", substance: "sucrose", cls: "compendial_excipient", grade: "parenteral low-endotoxin", compendia: [...PH, "ChP"], endo: "low", mode: "spec_led", unit: "kg", shelf: 1095, storage: RT, sites: ["SITE-GHE", "SITE-RAL", "SITE-LYO", "SITE-KOP"], daily: [3, 8], band: [12, 30], pool: ["BRW", "HAL", "COR", "QIN", "SAF"] },
  { id: "MAT-SUC-NF", name: "Sucrose, NF oral grade", substance: "sucrose", cls: "compendial_excipient", grade: "oral", compendia: ["USP-NF", "Ph. Eur."], mode: "spec_led", unit: "kg", shelf: 1095, storage: RT, sites: ["SITE-COR"], daily: [10, 25], band: [5, 12], pool: ["BRW", "COR", "SAF", "KES"] },
  { id: "MAT-MAN-PAR", name: "Mannitol, parenteral grade (low endotoxin)", substance: "mannitol", cls: "compendial_excipient", grade: "parenteral low-endotoxin", compendia: PH, endo: "low", mode: "spec_led", unit: "kg", shelf: 1095, storage: RT, sites: ["SITE-RAL", "SITE-COR", "SITE-LYO"], daily: [2, 8], band: [10, 32], pool: ["KES", "BRW", "HAL", "COR"] },
  { id: "MAT-MAN-DC", name: "Mannitol, direct-compression grade", substance: "mannitol", cls: "compendial_excipient", grade: "direct compression", compendia: ["USP-NF", "Ph. Eur."], mode: "spec_led", unit: "kg", shelf: 1095, storage: RT, sites: ["SITE-COR"], daily: [20, 50], band: [6, 20], pool: ["KES", "COR", "NOR"] },
  { id: "MAT-TRE-HP", name: "Trehalose dihydrate, high-purity low-endotoxin", substance: "trehalose", cls: "compendial_excipient", grade: "parenteral low-endotoxin", compendia: [...PH, "ChP"], salt: "dihydrate", endo: "low", mode: "spec_led", unit: "kg", shelf: 1095, storage: RT, sites: ["SITE-KOP", "SITE-TUA", "SITE-RAL"], daily: [1, 4], band: [30, 50], pool: ["BRW", "HAL", "QSD", "COR"] },
  { id: "MAT-HIS", name: "L-Histidine, parenteral grade", substance: "histidine", cls: "compendial_excipient", grade: "parenteral low-endotoxin", compendia: PH, salt: "free base", endo: "low", mode: "spec_led", unit: "kg", shelf: 1460, storage: RT, sites: ["SITE-KOP", "SITE-TUA", "SITE-RAL"], daily: [0.3, 1.5], band: [35, 50], pool: ["GLN", "HAL", "QIN", "QSD"] },
  { id: "MAT-HIS-HCL", name: "L-Histidine monohydrochloride monohydrate", substance: "histidine", cls: "compendial_excipient", grade: "parenteral low-endotoxin", compendia: PH, salt: "monohydrochloride monohydrate", endo: "low", mode: "spec_led", unit: "kg", shelf: 1460, storage: RT, sites: ["SITE-KOP", "SITE-RAL"], daily: [0.2, 1], band: [35, 50], pool: ["GLN", "HAL", "QIN"] },
  { id: "MAT-NACL", name: "Sodium chloride, parenteral grade", substance: "sodium chloride", cls: "compendial_excipient", grade: "parenteral low-endotoxin", compendia: PH, endo: "low", mode: "spec_led", unit: "kg", shelf: 1825, storage: RT, sites: ["SITE-GHE", "SITE-KOP", "SITE-RAL", "SITE-LYO", "SITE-TUA"], daily: [2, 10], band: [5, 15], pool: ["ELB", "HAL", "COR", "QSD", "SAF"] },
  { id: "MAT-NAP-DI", name: "Sodium phosphate dibasic dihydrate", substance: "sodium phosphate dibasic", cls: "compendial_excipient", grade: "parenteral", compendia: PH, salt: "dihydrate", mode: "spec_led", unit: "kg", shelf: 1825, storage: RT, sites: ["SITE-GHE", "SITE-LYO"], daily: [0.5, 3], band: [8, 20], pool: ["ELB", "HAL", "COR"] },
  { id: "MAT-NAP-MONO", name: "Sodium phosphate monobasic monohydrate", substance: "sodium phosphate monobasic", cls: "compendial_excipient", grade: "parenteral", compendia: PH, salt: "monohydrate", mode: "spec_led", unit: "kg", shelf: 1825, storage: RT, sites: ["SITE-GHE", "SITE-KOP"], daily: [0.5, 3], band: [8, 20], pool: ["ELB", "HAL", "COR"] },
  { id: "MAT-KCL", name: "Potassium chloride, parenteral grade", substance: "potassium chloride", cls: "compendial_excipient", grade: "parenteral", compendia: PH, mode: "spec_led", unit: "kg", shelf: 1825, storage: RT, sites: ["SITE-GHE"], daily: [0.2, 1], band: [6, 16], pool: ["ELB", "HAL", "COR"] },
  { id: "MAT-TRIS", name: "Tromethamine (Tris), parenteral grade", substance: "tromethamine", cls: "compendial_excipient", grade: "parenteral", compendia: ["USP-NF", "Ph. Eur."], mode: "spec_led", unit: "kg", shelf: 1460, storage: RT, sites: ["SITE-GHE", "SITE-KOP"], daily: [0.5, 2], band: [20, 45], pool: ["HAL", "ELB", "QSD"] },
  { id: "MAT-GLY", name: "Glycine, parenteral grade", substance: "glycine", cls: "compendial_excipient", grade: "parenteral", compendia: PH, mode: "spec_led", unit: "kg", shelf: 1460, storage: RT, sites: ["SITE-KOP"], daily: [0.5, 2], band: [10, 25], pool: ["GLN", "HAL", "QIN"] },
  { id: "MAT-ARG", name: "L-Arginine hydrochloride", substance: "arginine", cls: "compendial_excipient", grade: "parenteral", compendia: PH, salt: "hydrochloride", mode: "spec_led", unit: "kg", shelf: 1460, storage: RT, sites: ["SITE-TUA", "SITE-KOP"], daily: [0.5, 2], band: [25, 50], pool: ["GLN", "QIN", "QSD"] },
  { id: "MAT-CIT", name: "Citric acid monohydrate", substance: "citric acid", cls: "compendial_excipient", grade: "oral", compendia: ["USP-NF", "Ph. Eur."], salt: "monohydrate", mode: "spec_led", unit: "kg", shelf: 1095, storage: RT, sites: ["SITE-COR", "SITE-LYO"], daily: [1, 4], band: [5, 12], pool: ["ELB", "COR", "SAF"] },
  { id: "MAT-NACIT", name: "Sodium citrate dihydrate", substance: "sodium citrate", cls: "compendial_excipient", grade: "parenteral", compendia: PH, salt: "dihydrate", mode: "spec_led", unit: "kg", shelf: 1095, storage: RT, sites: ["SITE-LYO", "SITE-COR"], daily: [0.5, 3], band: [5, 14], pool: ["ELB", "COR", "HAL"] },
  { id: "MAT-NAOH", name: "Sodium hydroxide pellets, Ph. Eur.", substance: "sodium hydroxide", cls: "compendial_excipient", grade: "process", compendia: ["Ph. Eur.", "USP-NF"], mode: "spec_led", unit: "kg", shelf: 1095, storage: RT, sites: ["SITE-KOP", "SITE-TUA", "SITE-HYD"], daily: [1, 5], band: [5, 10], pool: ["ELB", "QSD", "SAF", "HAL"] },
  { id: "MAT-GLYC", name: "Glycerol, parenteral grade", substance: "glycerol", cls: "compendial_excipient", grade: "parenteral", compendia: PH, mode: "spec_led", unit: "kg", shelf: 1095, storage: RT, sites: ["SITE-LYO"], daily: [0.5, 2], band: [8, 20], pool: ["HAL", "ELB", "COR"] },

  // --- specialty excipients ---
  { id: "MAT-LAC-INH", name: "Lactose monohydrate, inhalation grade (coarse carrier)", substance: "lactose", cls: "specialty_excipient", grade: "inhalation carrier", compendia: ["Ph. Eur.", "USP-NF"], salt: "monohydrate", mode: "spec_led", unit: "kg", shelf: 1095, storage: RT, sites: ["SITE-CAM"], daily: [20, 60], band: [60, 160], pool: ["WAI", "NOR", "COR"] },
  { id: "MAT-LAC-FINE", name: "Lactose monohydrate, inhalation grade (micronised fines)", substance: "lactose", cls: "specialty_excipient", grade: "inhalation fines", compendia: ["Ph. Eur.", "USP-NF"], salt: "monohydrate", mode: "spec_led", unit: "kg", shelf: 1095, storage: RT, sites: ["SITE-CAM"], daily: [3, 10], band: [120, 250], pool: ["WAI", "NOR"] },
  { id: "MAT-MGST-INH", name: "Magnesium stearate, inhalation grade", substance: "magnesium stearate", cls: "specialty_excipient", grade: "inhalation", compendia: ["Ph. Eur.", "USP-NF"], mode: "spec_led", unit: "kg", shelf: 1095, storage: RT, sites: ["SITE-CAM"], daily: [0.2, 0.8], band: [150, 250], pool: ["BAV", "NOR"] },
  { id: "MAT-MGST", name: "Magnesium stearate, vegetable-source tablet grade", substance: "magnesium stearate", cls: "compendial_excipient", grade: "tablet lubricant", compendia: ["Ph. Eur.", "USP-NF"], mode: "spec_led", unit: "kg", shelf: 1095, storage: RT, sites: ["SITE-COR"], daily: [2, 6], band: [8, 20], pool: ["BAV", "FEN", "COR"] },
  { id: "MAT-MCC-102", name: "Microcrystalline cellulose, 100 um direct-compression type", substance: "microcrystalline cellulose", cls: "specialty_excipient", grade: "direct compression 100 um", compendia: ["Ph. Eur.", "USP-NF", "JP"], mode: "spec_led", unit: "kg", shelf: 1825, storage: RT, sites: ["SITE-COR"], daily: [80, 200], band: [30, 60], pool: ["FEN", "HOS", "COR"] },
  { id: "MAT-MCC-101", name: "Microcrystalline cellulose, 50 um wet-granulation type", substance: "microcrystalline cellulose", cls: "specialty_excipient", grade: "wet granulation 50 um", compendia: ["Ph. Eur.", "USP-NF", "JP"], mode: "spec_led", unit: "kg", shelf: 1825, storage: RT, sites: ["SITE-COR"], daily: [30, 80], band: [30, 55], pool: ["FEN", "HOS"] },
  { id: "MAT-HPMC", name: "Hypromellose 2910, 5 mPa.s", substance: "hypromellose", cls: "specialty_excipient", grade: "2910 / 5 mPa.s film former", compendia: ["Ph. Eur.", "USP-NF", "JP"], mode: "spec_led", unit: "kg", shelf: 1825, storage: RT, sites: ["SITE-COR"], daily: [10, 30], band: [40, 90], pool: ["HOS", "FEN"] },
  { id: "MAT-CCS", name: "Croscarmellose sodium", substance: "croscarmellose sodium", cls: "specialty_excipient", grade: "tablet disintegrant", compendia: ["Ph. Eur.", "USP-NF", "JP"], mode: "spec_led", unit: "kg", shelf: 1825, storage: RT, sites: ["SITE-COR"], daily: [5, 15], band: [35, 80], pool: ["FEN", "HOS", "NOR"] },
  { id: "MAT-SIO2", name: "Colloidal silicon dioxide", substance: "colloidal silicon dioxide", cls: "specialty_excipient", grade: "glidant", compendia: ["Ph. Eur.", "USP-NF"], mode: "spec_led", unit: "kg", shelf: 1825, storage: RT, sites: ["SITE-COR"], daily: [1, 4], band: [30, 70], pool: ["NOR", "COR"] },
  { id: "MAT-FILM", name: "Film-coating system, white (HPMC-based)", substance: "film coating system HPMC white", cls: "specialty_excipient", grade: "immediate-release film coat", compendia: [], mode: "spec_led", unit: "kg", shelf: 1095, storage: RT, sites: ["SITE-COR"], daily: [8, 20], band: [40, 110], pool: ["HOS", "FEN"] },
  { id: "MAT-PVP", name: "Povidone K30", substance: "povidone", cls: "specialty_excipient", grade: "K30 binder", compendia: ["Ph. Eur.", "USP-NF", "JP"], mode: "spec_led", unit: "kg", shelf: 1095, storage: RT, sites: ["SITE-COR"], daily: [5, 12], band: [30, 70], pool: ["NOR", "HAL"] },

  // --- lipids / surfactants ---
  { id: "MAT-PS80-SR", name: "Polysorbate 80, super-refined (low peroxide)", substance: "polysorbate 80", cls: "lipid_surfactant", grade: "parenteral super-refined", compendia: ["USP-NF", "Ph. Eur.", "ChP"], endo: "low", mode: "spec_led", unit: "kg", shelf: 730, storage: "2-8 C, under nitrogen", sites: ["SITE-GHE", "SITE-KOP", "SITE-RAL", "SITE-LYO", "SITE-TUA"], daily: [0.05, 0.3], band: [300, 900], pool: ["RVS", "ALT", "HAL", "COR"] },
  { id: "MAT-PS80-STD", name: "Polysorbate 80, standard grade", substance: "polysorbate 80", cls: "lipid_surfactant", grade: "oral/topical", compendia: ["USP-NF", "Ph. Eur."], mode: "spec_led", unit: "kg", shelf: 730, storage: RT, sites: ["SITE-COR"], daily: [0.2, 0.6], band: [200, 400], pool: ["RVS", "COR"] },
  { id: "MAT-PS20", name: "Polysorbate 20, super-refined", substance: "polysorbate 20", cls: "lipid_surfactant", grade: "parenteral super-refined", compendia: ["USP-NF", "Ph. Eur."], endo: "low", mode: "spec_led", unit: "kg", shelf: 730, storage: "2-8 C, under nitrogen", sites: ["SITE-TUA", "SITE-KOP"], daily: [0.05, 0.2], band: [300, 800], pool: ["RVS", "ALT"] },
  { id: "MAT-P188", name: "Poloxamer 188, cell-culture grade", substance: "poloxamer 188", cls: "lipid_surfactant", grade: "cell culture", compendia: ["USP-NF", "Ph. Eur."], mode: "spec_led", unit: "kg", shelf: 1095, storage: RT, sites: ["SITE-KOP", "SITE-TUA"], daily: [0.2, 1], band: [200, 500], pool: ["RVS", "ARC", "QSD"] },
  { id: "MAT-SQU", name: "Squalene, non-animal origin (vaccine grade)", substance: "squalene", cls: "lipid_surfactant", grade: "vaccine adjuvant grade", compendia: ["Ph. Eur."], mode: "access_led", unit: "kg", shelf: 730, storage: "2-8 C, under nitrogen", sites: ["SITE-GHE"], daily: [0.1, 0.4], band: [400, 1500], pool: ["COB", "ALT"] },
  { id: "MAT-DOPC", name: "DOPC, synthetic GMP (liposome lipid)", substance: "DOPC", cls: "lipid_surfactant", grade: "GMP synthetic", compendia: [], mode: "access_led", unit: "kg", shelf: 730, storage: "-20 C", sites: ["SITE-GHE"], daily: [0.01, 0.05], band: [2000, 5000], pool: ["ORI", "ALT"] },
  { id: "MAT-CHOL", name: "Cholesterol, plant-derived GMP (liposome lipid)", substance: "cholesterol", cls: "lipid_surfactant", grade: "GMP plant-derived", compendia: ["Ph. Eur."], mode: "access_led", unit: "kg", shelf: 1095, storage: "2-8 C", sites: ["SITE-GHE"], daily: [0.01, 0.05], band: [800, 3000], pool: ["ORI", "ALT"] },
  { id: "MAT-ILIP", name: "Ionizable lipid, IL-7 class (pilot LNP platform)", substance: "ionizable lipid IL-7", cls: "lipid_surfactant", grade: "GMP", compendia: [], mode: "access_led", unit: "kg", shelf: 365, storage: "-20 C", sites: ["SITE-GHE"], daily: [0.005, 0.02], band: [3000, 5000], pool: ["ORI", "ALT"] },
  { id: "MAT-DSPC", name: "DSPC, synthetic GMP (pilot LNP platform)", substance: "DSPC", cls: "lipid_surfactant", grade: "GMP synthetic", compendia: [], mode: "access_led", unit: "kg", shelf: 730, storage: "-20 C", sites: ["SITE-GHE"], daily: [0.003, 0.01], band: [1500, 4500], pool: ["ORI", "ALT"] },
  { id: "MAT-PEGL", name: "DMG-PEG2000 (pilot LNP platform)", substance: "DMG-PEG2000", cls: "lipid_surfactant", grade: "GMP", compendia: [], mode: "access_led", unit: "kg", shelf: 365, storage: "-20 C", sites: ["SITE-GHE"], daily: [0.002, 0.008], band: [2500, 5000], pool: ["ORI"] },

  // --- adjuvants (access-led, quote only) ---
  { id: "MAT-SAP-QS", name: "Saponin adjuvant QS-class (licensed)", substance: "saponin adjuvant QS-class", cls: "adjuvant_biologic", grade: "licensed GMP", compendia: [], mode: "access_led", unit: "g", shelf: 730, storage: "-20 C", sites: ["SITE-GHE", "SITE-LYO"], daily: [4, 8], band: null, pool: ["VEL"] },
  { id: "MAT-SAP-AN", name: "Saponin adjuvant analogue (synthetic QS-class)", substance: "saponin adjuvant QS-class", cls: "adjuvant_biologic", grade: "development", compendia: [], mode: "access_led", unit: "g", shelf: 730, storage: "-20 C", sites: [], daily: [0, 0], band: null, pool: [] },
  { id: "MAT-MPL", name: "MPL-class lipid A adjuvant (licensed)", substance: "MPL-class lipid A adjuvant", cls: "adjuvant_biologic", grade: "licensed GMP", compendia: [], mode: "access_led", unit: "g", shelf: 730, storage: "-20 C", sites: ["SITE-GHE"], daily: [5, 10], band: null, pool: ["ORI"] },

  // --- small-molecule APIs ---
  { id: "MAT-FF", name: "Fluticasone furoate, micronised (inhalation)", substance: "fluticasone furoate", cls: "small_molecule_api", grade: "inhalation micronised", compendia: ["Ph. Eur."], mode: "access_led", unit: "kg", shelf: 1095, storage: RT, sites: ["SITE-CAM"], daily: [0.05, 0.15], band: [3000, 5000], pool: ["MON", "DEC"] },
  { id: "MAT-UMEC", name: "Umeclidinium bromide, micronised (inhalation)", substance: "umeclidinium", cls: "small_molecule_api", grade: "inhalation micronised", compendia: [], salt: "bromide", mode: "access_led", unit: "kg", shelf: 1095, storage: RT, sites: ["SITE-CAM"], daily: [0.05, 0.15], band: [3000, 5000], pool: ["DEC", "MON"] },
  { id: "MAT-VIL", name: "Vilanterol trifenatate, micronised (inhalation)", substance: "vilanterol", cls: "small_molecule_api", grade: "inhalation micronised", compendia: [], salt: "trifenatate", mode: "access_led", unit: "kg", shelf: 1095, storage: RT, sites: ["SITE-CAM"], daily: [0.02, 0.06], band: [3000, 5000], pool: ["MON", "DEC"] },
  { id: "MAT-AMOX", name: "Amoxicillin trihydrate, compacted", substance: "amoxicillin", cls: "small_molecule_api", grade: "compacted oral", compendia: ["USP", "Ph. Eur."], salt: "trihydrate", mode: "spec_led", unit: "kg", shelf: 1460, storage: RT, sites: ["SITE-COR"], daily: [300, 700], band: [100, 300], pool: ["SAR", "DEC", "QIN"] },
  { id: "MAT-AMOX-NA", name: "Amoxicillin sodium, sterile", substance: "amoxicillin", cls: "small_molecule_api", grade: "sterile", compendia: ["USP", "Ph. Eur."], salt: "sodium", mode: "spec_led", unit: "kg", shelf: 1095, storage: RT, sites: [], daily: [0, 0], band: [150, 400], pool: [] },
  { id: "MAT-CLAV", name: "Clavulanate potassium, diluted 1:1 with MCC", substance: "clavulanate", cls: "small_molecule_api", grade: "diluted 1:1 microcrystalline cellulose", compendia: ["USP", "Ph. Eur."], salt: "potassium", mode: "spec_led", unit: "kg", shelf: 730, storage: "below 25 C, low humidity", sites: ["SITE-COR"], daily: [60, 150], band: [400, 1200], pool: ["SAR", "DEC"] },
  { id: "MAT-6APA", name: "6-Aminopenicillanic acid (6-APA)", substance: "6-aminopenicillanic acid", cls: "small_molecule_api", grade: "API starting material", compendia: [], mode: "spec_led", unit: "kg", shelf: 730, storage: RT, sites: ["SITE-HYD"], daily: [200, 450], band: [100, 250], pool: ["QIN", "SAR", "SAF"] },
  { id: "MAT-DANE", name: "D-(-)-4-Hydroxyphenylglycine Dane salt (potassium)", substance: "hydroxyphenylglycine Dane salt", cls: "small_molecule_api", grade: "API starting material", compendia: [], salt: "potassium", mode: "spec_led", unit: "kg", shelf: 730, storage: RT, sites: ["SITE-HYD"], daily: [250, 500], band: [100, 200], pool: ["QIN", "SAF", "DEC"] },

  // --- primary packaging ---
  { id: "MAT-VIAL-2R", name: "Type I borosilicate vial, 2R, ready-to-use", substance: "type I glass vial 2R", cls: "primary_packaging", grade: "Type I RTU", compendia: ["USP <660>", "Ph. Eur. 3.2.1"], mode: "process_locked", unit: "ea", shelf: 1825, storage: RT, sites: ["SITE-RAL", "SITE-LYO"], daily: [20_000, 60_000], band: [0.1, 0.4], pool: ["OST", "COR"] },
  { id: "MAT-VIAL-6R", name: "Type I borosilicate vial, 6R, ready-to-use", substance: "type I glass vial 6R", cls: "primary_packaging", grade: "Type I RTU", compendia: ["USP <660>", "Ph. Eur. 3.2.1"], mode: "process_locked", unit: "ea", shelf: 1825, storage: RT, sites: ["SITE-LYO", "SITE-RAL"], daily: [5_000, 20_000], band: [0.15, 0.6], pool: ["OST", "COR"] },
  { id: "MAT-STOP-13", name: "Bromobutyl stopper, 13 mm, fluoropolymer-coated, ready-to-sterilise", substance: "bromobutyl stopper 13 mm", cls: "primary_packaging", grade: "coated RTS", compendia: ["USP <381>", "Ph. Eur. 3.2.9"], mode: "process_locked", unit: "ea", shelf: 1095, storage: RT, sites: ["SITE-RAL", "SITE-LYO"], daily: [20_000, 60_000], band: [0.12, 0.6], pool: ["LIN"] },
  { id: "MAT-STOP-20", name: "Bromobutyl stopper, 20 mm, fluoropolymer-coated, ready-to-sterilise", substance: "bromobutyl stopper 20 mm", cls: "primary_packaging", grade: "coated RTS", compendia: ["USP <381>", "Ph. Eur. 3.2.9"], mode: "process_locked", unit: "ea", shelf: 1095, storage: RT, sites: ["SITE-LYO"], daily: [5_000, 20_000], band: [0.2, 0.9], pool: ["LIN"] },
  { id: "MAT-SEAL-13", name: "Aluminium flip-off seal, 13 mm", substance: "aluminium seal 13 mm", cls: "primary_packaging", grade: "standard", compendia: [], mode: "spec_led", unit: "ea", shelf: 1825, storage: RT, sites: ["SITE-RAL", "SITE-LYO"], daily: [20_000, 60_000], band: [0.1, 0.25], pool: ["LIN", "OST"] },
  { id: "MAT-PFS", name: "Prefilled syringe, 1 mL long, Type I glass, staked needle", substance: "prefilled syringe 1 mL long", cls: "primary_packaging", grade: "Type I nested RTF", compendia: ["USP <660>", "ISO 11040-4"], mode: "process_locked", unit: "ea", shelf: 1095, storage: RT, sites: ["SITE-LYO"], daily: [10_000, 30_000], band: [0.8, 2], pool: ["OST"] },
  { id: "MAT-FOIL", name: "Blister foil laminate, cold-form, DPI strip", substance: "cold-form foil laminate", cls: "primary_packaging", grade: "DPI strip", compendia: [], mode: "process_locked", unit: "kg", shelf: 1095, storage: RT, sites: ["SITE-CAM"], daily: [30, 80], band: [20, 45], pool: ["OST"] },
  { id: "MAT-HDPE", name: "HDPE bottle, 100 cc, child-resistant closure", substance: "HDPE bottle 100 cc", cls: "primary_packaging", grade: "pharma HDPE", compendia: ["USP <661>"], mode: "spec_led", unit: "ea", shelf: 1825, storage: RT, sites: ["SITE-COR"], daily: [5_000, 15_000], band: [0.1, 0.3], pool: ["OST", "COR"] },

  // --- process consumables (process-locked) ---
  { id: "MAT-SUB-2000", name: "Single-use bioreactor bag, 2000 L", substance: "single-use bioreactor bag 2000 L", cls: "process_consumable", grade: "validated assembly", compendia: ["USP <665>"], mode: "process_locked", unit: "ea", shelf: 1095, storage: RT, sites: ["SITE-KOP", "SITE-TUA"], daily: [0.2, 0.5], band: [4000, 9000], pool: ["TAM", "CAL"] },
  { id: "MAT-MIX-500", name: "Single-use mixing bag, 500 L", substance: "single-use mixing bag 500 L", cls: "process_consumable", grade: "validated assembly", compendia: ["USP <665>"], mode: "process_locked", unit: "ea", shelf: 1095, storage: RT, sites: ["SITE-GHE", "SITE-KOP"], daily: [0.5, 2], band: [1500, 3500], pool: ["TAM", "CAL"] },
  { id: "MAT-PROA", name: "Protein A affinity resin, alkali-stable", substance: "protein A resin", cls: "process_consumable", grade: "bioprocess", compendia: [], mode: "process_locked", unit: "L", shelf: 1825, storage: "2-8 C, 20% ethanol", sites: ["SITE-KOP", "SITE-TUA"], daily: [0.3, 1.2], band: [9000, 18000], pool: ["ASH"] },
  { id: "MAT-AEX", name: "Anion-exchange resin, strong Q", substance: "anion exchange resin Q", cls: "process_consumable", grade: "bioprocess", compendia: [], mode: "process_locked", unit: "L", shelf: 1825, storage: "2-8 C, 20% ethanol", sites: ["SITE-KOP"], daily: [0.2, 0.8], band: [1500, 4000], pool: ["ASH"] },
  { id: "MAT-MED-CD", name: "CHO chemically defined basal medium (powder)", substance: "CHO basal medium", cls: "process_consumable", grade: "bioproduction", compendia: [], mode: "process_locked", unit: "kg", shelf: 730, storage: "2-8 C", sites: ["SITE-KOP", "SITE-TUA"], daily: [40, 120], band: [90, 300], pool: ["ARC", "QSD"] },
  { id: "MAT-FEED", name: "CHO concentrated feed (powder)", substance: "CHO feed", cls: "process_consumable", grade: "bioproduction", compendia: [], mode: "process_locked", unit: "kg", shelf: 730, storage: "2-8 C", sites: ["SITE-KOP", "SITE-TUA"], daily: [15, 50], band: [120, 350], pool: ["ARC"] },
  { id: "MAT-FIL-02", name: "Sterilising-grade filter capsule, 0.2 um PES", substance: "0.2 um PES filter capsule", cls: "process_consumable", grade: "sterilising grade", compendia: ["USP <788>"], mode: "process_locked", unit: "ea", shelf: 1825, storage: RT, sites: ["SITE-GHE", "SITE-KOP", "SITE-LYO", "SITE-TUA", "SITE-RAL"], daily: [4, 15], band: [300, 900], pool: ["CAL", "TAM"] },
  { id: "MAT-VF", name: "Virus-retentive filter, 20 nm", substance: "20 nm virus filter", cls: "process_consumable", grade: "virus clearance", compendia: [], mode: "process_locked", unit: "ea", shelf: 1825, storage: RT, sites: ["SITE-KOP", "SITE-TUA"], daily: [0.5, 2], band: [1500, 4000], pool: ["CAL"] },
];

// ---------------------------------------------------------------------------
// Products (codes only) and BOMs
// ---------------------------------------------------------------------------

export const PRODUCTS: Array<{ external_id: string; name: string; modality: string; site_ids: SiteId[]; bom: string[] }> = [
  {
    external_id: "VX-201",
    name: "VX-201 recombinant adjuvanted vaccine",
    modality: "vaccine",
    site_ids: ["SITE-GHE", "SITE-LYO", "SITE-RAL"],
    bom: ["MAT-SAP-QS", "MAT-MPL", "MAT-DOPC", "MAT-CHOL", "MAT-SUC-INJ", "MAT-PS80-SR", "MAT-NACL", "MAT-NAP-DI", "MAT-NAP-MONO", "MAT-KCL", "MAT-MAN-PAR", "MAT-VIAL-2R", "MAT-STOP-13", "MAT-SEAL-13", "MAT-FIL-02", "MAT-MIX-500", "MAT-TRIS"],
  },
  {
    external_id: "RX-310",
    name: "RX-310 triple-therapy dry-powder inhaler",
    modality: "inhaled",
    site_ids: ["SITE-CAM"],
    bom: ["MAT-FF", "MAT-UMEC", "MAT-VIL", "MAT-LAC-INH", "MAT-LAC-FINE", "MAT-MGST-INH", "MAT-FOIL"],
  },
  {
    external_id: "AB-120",
    name: "AB-120 amoxicillin/clavulanate tablets",
    modality: "oral_solid",
    site_ids: ["SITE-COR", "SITE-HYD"],
    bom: ["MAT-AMOX", "MAT-CLAV", "MAT-MCC-102", "MAT-MCC-101", "MAT-MGST", "MAT-CCS", "MAT-SIO2", "MAT-FILM", "MAT-HPMC", "MAT-PVP", "MAT-MAN-DC", "MAT-HDPE", "MAT-6APA", "MAT-DANE", "MAT-NAOH"],
  },
  {
    external_id: "MB-114",
    name: "MB-114 IL-5 monoclonal antibody",
    modality: "monoclonal_antibody",
    site_ids: ["SITE-KOP", "SITE-TUA", "SITE-RAL", "SITE-LYO"],
    bom: ["MAT-HIS", "MAT-HIS-HCL", "MAT-TRE-HP", "MAT-PS80-SR", "MAT-PS20", "MAT-ARG", "MAT-GLY", "MAT-NACL", "MAT-MED-CD", "MAT-FEED", "MAT-P188", "MAT-PROA", "MAT-AEX", "MAT-SUB-2000", "MAT-VF", "MAT-FIL-02", "MAT-VIAL-6R", "MAT-STOP-20", "MAT-SUC-INJ", "MAT-MAN-PAR"],
  },
];

/** Currency a supplier quotes in, by HQ country. */
export function quoteCurrency(country: string): "USD" | "EUR" | "GBP" | "CHF" | "JPY" | "INR" | "SGD" {
  if (["DE", "FR", "ES", "IT", "BE", "NL", "IE", "PT", "CZ", "SE", "NO"].includes(country)) return "EUR";
  if (country === "GB") return "GBP";
  if (country === "CH") return "CHF";
  if (country === "JP") return "JPY";
  if (country === "SG") return "SGD";
  return "USD";
}
