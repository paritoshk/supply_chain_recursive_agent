/**
 * Shared domain contract for supply-agent.
 *
 * Field names for InventoryItem, Supplier, Part, Offer, BillOfMaterials/BomLineItem and WorkOrder
 * mirror the host manufacturing platform exactly. Everything else is new to this prototype.
 *
 * Conventions:
 *  - Every persisted entity is addressed by a human-readable `external_id` (e.g. "MAT-SUC-INJ",
 *    "LOT-GHE-0001", "RFQ-102"). Foreign keys (material_id, site_id, supplier_id, ...) hold
 *    the referenced entity's external_id. Citations always use external_ids.
 *  - Dates are ISO strings: `YYYY-MM-DD` for calendar dates, ISO-8601 for timestamps.
 *  - A missing price is `null` plus a reason, never an invented number.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const Region = z.enum(["US-East", "UK", "EU", "APAC", "IN"]);
export type Region = z.infer<typeof Region>;

export const SiteStage = z.enum([
  "drug_substance",
  "drug_product",
  "fill_finish",
  "inhaled",
  "oral_solids",
  "api",
  "vaccine_antigen",
]);
export type SiteStage = z.infer<typeof SiteStage>;

export const CapacityStatus = z.enum(["operating", "under_construction", "announced"]);
export type CapacityStatus = z.infer<typeof CapacityStatus>;

export const MaterialClass = z.enum([
  "compendial_excipient",
  "specialty_excipient",
  "lipid_surfactant",
  "small_molecule_api",
  "adjuvant_biologic",
  "primary_packaging",
  "process_consumable",
]);
export type MaterialClass = z.infer<typeof MaterialClass>;

export const SourcingMode = z.enum(["spec_led", "access_led", "process_locked"]);
export type SourcingMode = z.infer<typeof SourcingMode>;

export const SupplierType = z.enum(["manufacturer", "distributor", "broker"]);
export type SupplierType = z.infer<typeof SupplierType>;

export const LotStatus = z.enum(["released", "quarantined", "rejected"]);
export type LotStatus = z.infer<typeof LotStatus>;

/** Ordered. A supplier never skips a state (see logic/qualification.ts canPromote). */
export const QualificationState = z.enum([
  "discovery_candidate",
  "technically_suitable",
  "quality_approved",
  "released_for_use",
]);
export type QualificationState = z.infer<typeof QualificationState>;

/** Commercial vs development/tech-pack supply. Development sources can never be promoted past technically_suitable. */
export const SupplyStage = z.enum(["commercial", "development"]);
export type SupplyStage = z.infer<typeof SupplyStage>;

export const BiosecureReview = z.enum(["not_screened", "cleared", "flagged"]);
export type BiosecureReview = z.infer<typeof BiosecureReview>;

export const RfqStatus = z.enum(["draft", "sent", "quoted", "approved", "rejected", "expired"]);
export type RfqStatus = z.infer<typeof RfqStatus>;

export const Incoterm = z.enum(["EXW", "FCA", "FOB", "CIF", "CIP", "DAP", "DDP"]);
export type Incoterm = z.infer<typeof Incoterm>;

export const Currency = z.enum(["USD", "EUR", "GBP", "CHF", "JPY", "INR", "SGD"]);
export type Currency = z.infer<typeof Currency>;

export const MissionStatus = z.enum(["planning", "running", "verifying", "completed", "degraded", "failed"]);
export type MissionStatus = z.infer<typeof MissionStatus>;

export const AgentRole = z.enum([
  "planner",
  "sentinel",
  "matcher",
  "scout",
  "rfq",
  "supplier_persona",
  "pricer",
  "qa_gate",
]);
export type AgentRole = z.infer<typeof AgentRole>;

export const AgentRunStatus = z.enum(["queued", "running", "succeeded", "failed", "timeout", "retrying", "cancelled"]);
export type AgentRunStatus = z.infer<typeof AgentRunStatus>;

export const Severity = z.enum(["info", "watch", "action"]);
export type Severity = z.infer<typeof Severity>;

export const IngestionStatus = z.enum(["ok", "not_ingested", "feature_disabled"]);
export type IngestionStatus = z.infer<typeof IngestionStatus>;

export const Unit = z.enum(["kg", "g", "L", "ea"]);
export type Unit = z.infer<typeof Unit>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const isoTimestamp = z.string().min(10);

// ---------------------------------------------------------------------------
// Host-platform entities (field names mirror the host platform exactly)
// ---------------------------------------------------------------------------

export const InventoryItem = z.object({
  external_id: z.string(),
  sku: z.string(),
  name: z.string(),
  quantity_on_hand: z.number(),
  reorder_point: z.number(),
  /** null = unknown */
  lead_time_days: z.number().int().nullable(),
  unit: z.string(),
  unit_cost: z.number().nullable(),
  warehouse_location: z.string(),
  last_restock_at: isoTimestamp.nullable(),
  attributes: z.record(z.string(), z.unknown()),
});
export type InventoryItem = z.infer<typeof InventoryItem>;

export const Supplier = z.object({
  external_id: z.string(),
  name: z.string(),
  /** HQ country (ISO-3166 alpha-2). */
  country: z.string(),
  website: z.string().nullable(),
  type: SupplierType,
  /** Where the material is actually made, when different from HQ. */
  manufacturing_country: z.string().nullable().optional(),
});
export type Supplier = z.infer<typeof Supplier>;

export const Part = z.object({
  mpn: z.string(),
  manufacturer: z.string().nullable(),
  category: z.string(),
});
export type Part = z.infer<typeof Part>;

/** Append-only price observation. */
export const Offer = z.object({
  external_id: z.string().optional(),
  mpn: z.string().optional(),
  supplier_id: z.string().optional(),
  price: z.number().nullable(),
  currency: Currency,
  moq: z.number().nullable(),
  stock_qty: z.number().nullable(),
  lead_days: z.number().int().nullable(),
  seen_at: isoTimestamp,
});
export type Offer = z.infer<typeof Offer>;

export const BomLineItem = z.object({
  /** Soft link to Material.external_id */
  material_external_id: z.string(),
  qty_per_batch: z.number(),
  unit: z.string(),
});
export type BomLineItem = z.infer<typeof BomLineItem>;

export const BillOfMaterials = z.object({
  external_id: z.string(),
  product_id: z.string(),
  name: z.string(),
  line_items: z.array(BomLineItem),
});
export type BillOfMaterials = z.infer<typeof BillOfMaterials>;

export const WorkOrder = z.object({
  external_id: z.string(),
  product_id: z.string(),
  site_id: z.string(),
  qty: z.number(),
  status: z.enum(["planned", "released", "in_progress", "completed", "cancelled"]),
  due_date: isoDate,
  // ---- batch-schedule extension (optional so host-platform payloads still parse) ----
  /** ProductionLine.external_id the batch runs on. */
  line_id: z.string().optional(),
  batch_no: z.string().optional(),
  start_date: isoDate.optional(),
  /** Per-batch material consumption, derived from the product BOM and the site's daily rate. */
  materials: z.array(BomLineItem).optional(),
});
export type WorkOrder = z.infer<typeof WorkOrder>;

/** A scheduled batch: a WorkOrder with every batch-schedule field present. */
export const BatchWorkOrder = WorkOrder.extend({
  line_id: z.string(),
  batch_no: z.string(),
  start_date: isoDate,
  materials: z.array(BomLineItem),
});
export type BatchWorkOrder = z.infer<typeof BatchWorkOrder>;

// ---------------------------------------------------------------------------
// New entities
// ---------------------------------------------------------------------------

export const Site = z.object({
  external_id: z.string(),
  name: z.string(),
  city: z.string(),
  country: z.string(),
  region: Region,
  stage: SiteStage,
  lat: z.number(),
  lng: z.number(),
  capacity_status: CapacityStatus,
});
export type Site = z.infer<typeof Site>;

export const Product = z.object({
  external_id: z.string(),
  name: z.string(),
  modality: z.string(),
  site_ids: z.array(z.string()),
});
export type Product = z.infer<typeof Product>;

export const LineType = z.enum([
  "upstream_bioreactor",
  "downstream_purification",
  "formulation",
  "aseptic_fill",
  "lyophilization",
  "tableting",
  "inhaler_fill",
]);
export type LineType = z.infer<typeof LineType>;

/** EU GMP Annex 1 cleanroom grade the line operates in ("n/a" for non-sterile oral solids). */
export const CleanroomGrade = z.enum(["A", "B", "C", "D", "n/a"]);
export type CleanroomGrade = z.infer<typeof CleanroomGrade>;

export const ProductionLine = z.object({
  external_id: z.string(),
  site_id: z.string(),
  name: z.string(),
  product_id: z.string(),
  line_type: LineType,
  batch_size: z.number(),
  unit: Unit,
  cleanroom_grade: CleanroomGrade,
});
export type ProductionLine = z.infer<typeof ProductionLine>;

export const Material = z.object({
  external_id: z.string(),
  name: z.string(),
  /** Chemical/biological identity shared across grade variants (e.g. "mannitol"). */
  substance: z.string(),
  material_class: MaterialClass,
  grade: z.string(),
  compendia: z.array(z.string()),
  salt_form: z.string().nullable().optional(),
  endotoxin_class: z.string().nullable().optional(),
  sourcing_mode: SourcingMode,
  unit: Unit,
  shelf_life_days: z.number().int(),
  storage: z.string(),
});
export type Material = z.infer<typeof Material>;

export const Lot = z.object({
  external_id: z.string(),
  material_id: z.string(),
  site_id: z.string(),
  qty: z.number(),
  status: LotStatus,
  expiry_date: isoDate,
  received_at: isoDate,
  supplier_id: z.string().nullable().optional(),
  unit_cost: z.number().nullable().optional(),
});
export type Lot = z.infer<typeof Lot>;

/** Consumption rate plus the planning parameters used by cover/ROP math for this material at this site. */
export const Consumption = z.object({
  material_id: z.string(),
  site_id: z.string(),
  daily_rate: z.number(),
  lead_time_days: z.number().int().nullable().optional(),
  safety_days: z.number().int().optional(),
});
export type Consumption = z.infer<typeof Consumption>;

export const MaterialSupplier = z.object({
  external_id: z.string(),
  material_id: z.string(),
  supplier_id: z.string(),
  qualification_state: QualificationState,
  supply_stage: SupplyStage,
  approved_grade: z.string().nullable(),
  lead_time_days: z.number().int().nullable(),
  moq: z.number().nullable(),
  price_low: z.number().nullable(),
  price_high: z.number().nullable(),
  /** e.g. "USD/kg", "USD/ea". */
  price_basis: z.string(),
  /** Why a price is missing (e.g. proprietary adjuvant, quote-only). Required when price_low is null. */
  rfq_reason: z.string().nullable().optional(),
  dmf: z.boolean(),
  cep: z.boolean(),
  /** 0..100 */
  otd_pct: z.number().nullable(),
  lead_time_variance_days: z.number().nullable(),
  /** 0..1 */
  rejection_rate: z.number().nullable(),
  biosecure_review: BiosecureReview,
});
export type MaterialSupplier = z.infer<typeof MaterialSupplier>;

export const RFQ = z.object({
  external_id: z.string(),
  material_id: z.string(),
  site_id: z.string(),
  qty: z.number(),
  need_by: isoDate,
  status: RfqStatus,
  mission_id: z.string().nullable(),
  created_at: isoTimestamp.optional(),
});
export type RFQ = z.infer<typeof RFQ>;

export const Quote = z.object({
  external_id: z.string(),
  rfq_id: z.string(),
  supplier_id: z.string(),
  /** null when the supplier declines to price (quote-only / proprietary); see rfq_reason */
  unit_price: z.number().nullable(),
  currency: Currency,
  incoterm: Incoterm,
  /** Total freight for the quoted qty, in quote currency. */
  freight: z.number(),
  /** Total incoming QC / release testing cost, in quote currency. */
  testing_cost: z.number(),
  qty: z.number(),
  lead_time_days: z.number().int(),
  valid_until: isoDate,
  /** Supplier replies are produced by persona agents. Always true in this prototype. */
  simulated: z.literal(true),
  rfq_reason: z.string().nullable().optional(),
  received_at: isoTimestamp.optional(),
});
export type Quote = z.infer<typeof Quote>;

/** The agent only ever drafts POs. A human approves; nothing is placed automatically. */
export const PurchaseOrder = z.object({
  external_id: z.string(),
  rfq_id: z.string().nullable(),
  quote_id: z.string().nullable(),
  supplier_id: z.string(),
  material_id: z.string(),
  site_id: z.string(),
  qty: z.number(),
  unit_price: z.number().nullable(),
  currency: Currency,
  status: z.literal("draft"),
  created_at: isoTimestamp.optional(),
});
export type PurchaseOrder = z.infer<typeof PurchaseOrder>;

export const Mission = z.object({
  id: z.string(),
  trigger: z.string(),
  material_id: z.string().nullable(),
  site_id: z.string().nullable(),
  status: MissionStatus,
  created_at: isoTimestamp,
  /** Optional free-form summary, e.g. "degraded, 2 of 3 quotes". */
  summary: z.string().nullable().optional(),
});
export type Mission = z.infer<typeof Mission>;

export const ToolCallRecord = z.object({
  tool_use_id: z.string(),
  tool_name: z.string(),
  input: z.unknown(),
  output: z.unknown().optional(),
  error: z.string().nullable().optional(),
  latency_ms: z.number().optional(),
});
export type ToolCallRecord = z.infer<typeof ToolCallRecord>;

export const AgentRun = z.object({
  id: z.string(),
  parent_id: z.string().nullable(),
  mission_id: z.string().nullable(),
  role: AgentRole,
  model: z.string(),
  status: AgentRunStatus,
  input: z.unknown(),
  output: z.unknown().nullable(),
  tool_calls: z.array(ToolCallRecord),
  tokens_in: z.number().int(),
  tokens_out: z.number().int(),
  latency_ms: z.number().int().nullable(),
  error: z.string().nullable(),
  started_at: isoTimestamp,
  ended_at: isoTimestamp.nullable(),
});
export type AgentRun = z.infer<typeof AgentRun>;

export const Message = z.object({
  id: z.string().optional(),
  direction: z.enum(["inbound", "outbound"]),
  channel: z.enum(["imessage", "sms", "web"]),
  to: z.string(),
  from: z.string(),
  body: z.string(),
  mission_id: z.string().nullable(),
  created_at: isoTimestamp.optional(),
});
export type Message = z.infer<typeof Message>;

/** Alert payload (host-platform shape). */
export const Finding = z.object({
  id: z.string().optional(),
  mission_id: z.string().nullable().optional(),
  headline: z.string(),
  severity: Severity,
  detail: z.string(),
  cited_tool_calls: z.array(z.string()),
  material_id: z.string().nullable().optional(),
  site_id: z.string().nullable().optional(),
  created_at: isoTimestamp.optional(),
});
export type Finding = z.infer<typeof Finding>;

/** Evidence board: objects (structure images, feasibility tables, QA packets, supplier evidence) kept for review. */
export const BoardKind = z.enum([
  "material_dossier",
  "structure_image",
  "feasibility_report",
  "qa_packet",
  "supplier_evidence",
  "mission_summary",
]);
export type BoardKind = z.infer<typeof BoardKind>;

export const BoardItem = z.object({
  id: z.string(),
  kind: BoardKind,
  title: z.string(),
  mission_id: z.string().nullable().optional(),
  material_id: z.string().nullable().optional(),
  site_id: z.string().nullable().optional(),
  image_url: z.string().nullable().optional(),
  data: z.unknown(),
  source_urls: z.array(z.string()),
  /** Upsert key: a new item with the same key replaces the old one (e.g. one dossier per material). */
  key: z.string().nullable().optional(),
  created_at: isoTimestamp,
});
export type BoardItem = z.infer<typeof BoardItem>;

// ---------------------------------------------------------------------------
// Tool contract
// ---------------------------------------------------------------------------

export const Citation = z.object({
  source: z.string(),
  /** external_ids of the cited rows (or URLs for live web sources) */
  ids: z.array(z.string()),
  excerpt: z.string().optional(),
  href: z.string().optional(),
});
export type Citation = z.infer<typeof Citation>;

export const ToolOutput = z.object({
  ingestion_status: IngestionStatus,
  source: z.string(),
  citations: z.array(Citation),
});
export type ToolOutput = z.infer<typeof ToolOutput>;

/** Agents as data. */
export const AgentSpec = z.object({
  id: z.string(),
  label: z.string(),
  bottleneck: z.enum(["inventory", "procurement"]),
  allowed_tools: z.array(z.string()),
  two_pass: z.boolean(),
});
export type AgentSpec = z.infer<typeof AgentSpec>;

/** Dashboard / tool filters. All optional; tools apply what is relevant. */
export const Filters = z.object({
  region: Region.optional(),
  site_id: z.string().optional(),
  product_id: z.string().optional(),
  material_class: MaterialClass.optional(),
  lot_status: LotStatus.optional(),
  expiring_within_days: z.number().int().positive().optional(),
});
export type Filters = z.infer<typeof Filters>;

/** Stream events emitted to the dashboard / chat panel. */
export const StreamEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text_delta"), text: z.string() }),
  z.object({ type: z.literal("tool_use_start"), tool_use_id: z.string(), tool_name: z.string() }),
  z.object({ type: z.literal("tool_use_result"), tool_use_id: z.string(), output: z.unknown() }),
  z.object({ type: z.literal("status"), status: z.string(), detail: z.string().optional() }),
  z.object({ type: z.literal("done") }),
]);
export type StreamEvent = z.infer<typeof StreamEvent>;

// ---------------------------------------------------------------------------
// Supplier negotiations (simulated supplier personas)
// ---------------------------------------------------------------------------

export const SupplierPersonality = z.enum(["firm", "flexible", "slow"]);
export type SupplierPersonality = z.infer<typeof SupplierPersonality>;

/**
 * Hidden, deterministic commercial profile of a supplier persona for one RFQ. Derived from the
 * MaterialSupplier link + a seed. Never shown to the buyer agent; offers are clamped to it in code.
 * Prices are per unit in `currency`; `list_price`/`floor_price` are null for quote-only materials.
 */
export const SupplierProfile = z.object({
  rfq_id: z.string(),
  supplier_id: z.string(),
  material_supplier_id: z.string(),
  material_id: z.string(),
  site_id: z.string(),
  qualification_state: QualificationState,
  currency: Currency,
  incoterm: Incoterm,
  list_price: z.number().nullable(),
  floor_price: z.number().nullable(),
  rfq_reason: z.string().nullable(),
  /** Lead time the supplier can actually deliver (after any announced slip), in days. */
  base_lead_days: z.number().int(),
  expedite: z.object({ days_saved: z.number().int(), premium_pct: z.number() }).nullable(),
  moq: z.number(),
  personality: SupplierPersonality,
  /** Max price concession per supplier turn, as a fraction of list. */
  concession_pct: z.number(),
  /** Scenario pushback announced on first contact (e.g. a lead-time slip). */
  pushback: z.string().nullable(),
  freight_per_unit: z.number(),
  testing_cost: z.number(),
  qty: z.number(),
  need_by: isoDate,
  today: isoDate,
});
export type SupplierProfile = z.infer<typeof SupplierProfile>;

export const NegotiationOffer = z.object({
  unit_price: z.number().nullable(),
  currency: Currency,
  incoterm: Incoterm,
  lead_time_days: z.number().int(),
  moq: z.number(),
  valid_until: isoDate,
  expedited: z.boolean().optional(),
});
export type NegotiationOffer = z.infer<typeof NegotiationOffer>;

export const NegotiationTurn = z.object({
  turn: z.number().int(),
  from: z.enum(["buyer", "supplier"]),
  message: z.string(),
  offer: NegotiationOffer.nullable().optional(),
  /** Which offer fields code had to clamp back inside the hidden profile. */
  clamped: z.array(z.string()).optional(),
  model: z.string().nullable().optional(),
  latency_ms: z.number().nullable().optional(),
  at: isoTimestamp,
});
export type NegotiationTurn = z.infer<typeof NegotiationTurn>;

export const NegotiationThread = z.object({
  /** `${rfq_id}:${supplier_id}` */
  id: z.string(),
  rfq_id: z.string(),
  supplier_id: z.string(),
  status: z.enum(["open", "accepted", "declined"]),
  profile: SupplierProfile,
  turns: z.array(NegotiationTurn),
  quote_id: z.string().nullable(),
  created_at: isoTimestamp,
});
export type NegotiationThread = z.infer<typeof NegotiationThread>;
