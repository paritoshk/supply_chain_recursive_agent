/**
 * Production-line feasibility + QA packet, and the material dossier (PubChem metadata + our spec).
 * Both append evidence-board items (`writes: "board"`); every number comes from logic/, never a model.
 */
import { z } from "zod";
import {
  addDays,
  changeControlAssessment,
  documentsRequired,
  isApproved,
  isColdChain,
  qcReleaseDays,
  round,
  simulateBatchFeasibility,
  transferReleaseDays,
  transferRequirements,
  type FeasibilityReceipt,
} from "../logic/index.ts";
import { pubchemLookup, type PubchemLookup } from "../pubchem.ts";
import type { Store } from "../store.ts";
import type { Citation, Material } from "../types.ts";
import { defineTool, type ToolResult } from "./contract.ts";

const ok = (source: string, citations: Citation[], body: Record<string, unknown>): ToolResult => ({
  ingestion_status: "ok",
  source,
  citations,
  ...body,
});
const notFound = (source: string, error: string): ToolResult => ({ ingestion_status: "not_ingested", source, citations: [], error });

/** Suppliers whose lots this site has received for this material (established sources). */
export function establishedSuppliers(store: Store, materialId: string, siteId: string): string[] {
  return [
    ...new Set(
      store
        .lots({ material_id: materialId, site_id: siteId })
        .filter((l) => l.status !== "rejected" && l.supplier_id)
        .map((l) => l.supplier_id as string),
    ),
  ];
}

export interface QaPacket {
  material_id: string;
  site_id: string;
  material_class: Material["material_class"];
  qc_release_days: number;
  transfer_release_days: number;
  change_control_required: boolean;
  change_control_reasons: string[];
  established_supplier_ids: string[];
  cold_chain: boolean;
  storage: string;
  grade: string;
  compendia: string[];
  endotoxin_class: string | null;
  shelf_life_days: number;
  sourcing_mode: Material["sourcing_mode"];
  supplier: { supplier_id: string; material_supplier_id: string | null; qualification_state: string; dmf: boolean; cep: boolean } | null;
  documents_required: string[];
  transfer_requirements: ReturnType<typeof transferRequirements> | null;
}

export function qaPacketFor(
  store: Store,
  m: Material,
  siteId: string,
  opts: { purchase_supplier_id?: string | null; transfer?: boolean } = {},
): QaPacket {
  const established = establishedSuppliers(store, m.external_id, siteId);
  const links = store.materialSuppliers({ material_id: m.external_id });
  const link = opts.purchase_supplier_id
    ? links.find((l) => l.supplier_id === opts.purchase_supplier_id)
    : links.find((l) => l.qualification_state === "released_for_use");
  const cc = opts.purchase_supplier_id
    ? link
      ? changeControlAssessment({ supplier_id: link.supplier_id, qualification_state: link.qualification_state, established_supplier_ids: established })
      : { required: true, reasons: [`${opts.purchase_supplier_id} has no approved-supplier record for ${m.external_id}: not a qualified source`] }
    : { required: false, reasons: [] };
  return {
    material_id: m.external_id,
    site_id: siteId,
    material_class: m.material_class,
    qc_release_days: qcReleaseDays(m.material_class),
    transfer_release_days: transferReleaseDays(m.material_class),
    change_control_required: cc.required,
    change_control_reasons: cc.reasons,
    established_supplier_ids: established,
    cold_chain: isColdChain(m.storage),
    storage: m.storage,
    grade: m.grade,
    compendia: m.compendia,
    endotoxin_class: m.endotoxin_class ?? null,
    shelf_life_days: m.shelf_life_days,
    sourcing_mode: m.sourcing_mode,
    supplier: link
      ? { supplier_id: link.supplier_id, material_supplier_id: link.external_id, qualification_state: link.qualification_state, dmf: link.dmf, cep: link.cep }
      : opts.purchase_supplier_id
        ? { supplier_id: opts.purchase_supplier_id, material_supplier_id: null, qualification_state: "discovery_candidate", dmf: false, cep: false }
        : null,
    documents_required: documentsRequired({
      substance: m.substance,
      material_class: m.material_class,
      storage: m.storage,
      dmf: link?.dmf,
      cep: link?.cep,
      supplier_id: link?.supplier_id ?? null,
      change_control_required: cc.required,
      transfer: opts.transfer,
    }),
    transfer_requirements: opts.transfer ? transferRequirements(m) : null,
  };
}

export const lineFeasibility = defineTool({
  name: "line_feasibility",
  description:
    "Production-line feasibility for one material at one site: day-by-day simulation of released stock against the scheduled batches that consume it, with optional transfer and purchase arrivals plus QC release time. Returns a per-batch table (feasible or at risk), the first infeasible batch, and a QA packet (QC release days, change control, cold chain, storage, grade, compendia, release documents).",
  idempotent: true,
  writes: "board",
  inputSchema: z.object({
    material_id: z.string(),
    site_id: z.string(),
    transfer: z
      .object({ qty: z.number().nonnegative(), arrives_in_days: z.number().int().min(0), from_site_id: z.string().optional() })
      .nullable()
      .optional()
      .describe("Inter-site transfer into the site (released after receipt verification)."),
    purchase: z
      .object({ qty: z.number().nonnegative(), lead_time_days: z.number().int().min(0), supplier_id: z.string() })
      .nullable()
      .optional()
      .describe("Purchase from a supplier (quarantined until QC release)."),
    horizon_days: z.number().int().positive().max(120).default(60),
    mission_id: z.string().nullable().optional(),
    record: z.boolean().default(true).describe("Append a feasibility_report and qa_packet to the evidence board."),
  }),
  async run(ctx, args) {
    const { store } = ctx;
    const m = store.material(args.material_id);
    if (!m) return notFound("production_schedule", `${args.material_id} not found`);
    if (!store.site(args.site_id)) return notFound("production_schedule", `${args.site_id} not found`);
    const today = store.today();
    const lots = store.lots({ material_id: m.external_id, site_id: args.site_id }).filter((l) => l.qty > 0);
    const released = lots.filter((l) => l.status === "released" && l.expiry_date > today);
    const quarantined = lots.filter((l) => l.status === "quarantined");
    const wos = store.workOrders({ site_id: args.site_id, material_id: m.external_id, from: today, to: addDays(today, args.horizon_days) });
    const lineIds = [...new Set(wos.map((w) => w.line_id))];
    const lines = lineIds.map((id) => store.productionLine(id)).filter((l) => l != null);
    const lineName = (id: string) => store.productionLine(id)?.name ?? id;

    const qa = qaPacketFor(store, m, args.site_id, { purchase_supplier_id: args.purchase?.supplier_id ?? null, transfer: Boolean(args.transfer && args.transfer.qty > 0) });
    const receipts: FeasibilityReceipt[] = [];
    if (args.transfer && args.transfer.qty > 0) {
      receipts.push({ kind: "transfer", qty: args.transfer.qty, arrives_in_days: args.transfer.arrives_in_days, release_days: qa.transfer_release_days, ref: args.transfer.from_site_id ?? null });
    }
    if (args.purchase && args.purchase.qty > 0) {
      receipts.push({ kind: "purchase", qty: args.purchase.qty, arrives_in_days: args.purchase.lead_time_days, release_days: qa.qc_release_days, ref: args.purchase.supplier_id });
    }
    const sim = simulateBatchFeasibility({
      today,
      horizon_days: args.horizon_days,
      released_lots: released.map((l) => ({ external_id: l.external_id, qty: l.qty, expiry_date: l.expiry_date })),
      receipts,
      batches: wos.map((w) => ({
        batch_no: w.batch_no,
        work_order_id: w.external_id,
        line_id: w.line_id,
        line_name: lineName(w.line_id),
        product_id: w.product_id,
        start_date: w.start_date,
        material_needed: w.materials.find((x) => x.material_external_id === m.external_id)?.qty_per_batch ?? 0,
      })),
    });
    const releasedQty = round(released.reduce((s, l) => s + l.qty, 0), 4);
    const first = sim.first_infeasible_batch;
    const headline = !sim.batches_total
      ? `No scheduled batches consume ${m.external_id} at ${args.site_id} in the next ${args.horizon_days} days.`
      : sim.all_feasible
        ? `All ${sim.batches_total} scheduled batches have released ${m.external_id} at start.`
        : `${sim.batches_at_risk} of ${sim.batches_total} batches at risk; first ${first?.batch_no} on ${first?.start_date} (${first?.line_name}) needs ${first?.material_needed} ${m.unit}, ${first?.available_at_start} released.`;

    const boardIds: string[] = [];
    if (args.record) {
      const scope = `${args.mission_id ?? "adhoc"}:${m.external_id}:${args.site_id}`;
      const fr = store.addBoardItem({
        kind: "feasibility_report",
        title: `Line feasibility: ${m.name} at ${store.site(args.site_id)?.name ?? args.site_id}`,
        mission_id: args.mission_id ?? null,
        material_id: m.external_id,
        site_id: args.site_id,
        image_url: null,
        key: `feasibility:${scope}`,
        source_urls: [],
        data: {
          headline,
          today,
          horizon_days: args.horizon_days,
          released_qty: releasedQty,
          unit: m.unit,
          receipts: sim.receipts,
          lines: lines.map((l) => ({ line_id: l.external_id, name: l.name, line_type: l.line_type, cleanroom_grade: l.cleanroom_grade })),
          batches: sim.rows,
          batches_total: sim.batches_total,
          batches_at_risk: sim.batches_at_risk,
          first_infeasible_batch: first,
        },
      });
      const qp = store.addBoardItem({
        kind: "qa_packet",
        title: `QA packet: ${m.name} at ${store.site(args.site_id)?.name ?? args.site_id}`,
        mission_id: args.mission_id ?? null,
        material_id: m.external_id,
        site_id: args.site_id,
        image_url: null,
        key: `qa:${scope}`,
        source_urls: [],
        data: qa,
      });
      boardIds.push(fr.id, qp.id);
    }

    const citations: Citation[] = [
      { source: "inventory", ids: [m.external_id, args.site_id, ...released.map((l) => l.external_id)], excerpt: `released ${releasedQty} ${m.unit}; quarantined ${round(quarantined.reduce((s, l) => s + l.qty, 0), 4)} ${m.unit} excluded` },
    ];
    if (wos.length) citations.push({ source: "production_schedule", ids: [...lineIds, ...wos.map((w) => w.external_id)], excerpt: headline });
    if (qa.supplier?.material_supplier_id) citations.push({ source: "approved_suppliers", ids: [qa.supplier.material_supplier_id], excerpt: `${qa.supplier.supplier_id} ${qa.supplier.qualification_state}` });
    if (args.transfer?.from_site_id && store.site(args.transfer.from_site_id)) citations.push({ source: "inventory", ids: [args.transfer.from_site_id], excerpt: "transfer donor site" });

    return ok("production_schedule", citations, {
      material_id: m.external_id,
      site_id: args.site_id,
      today,
      horizon_days: args.horizon_days,
      unit: m.unit,
      released_qty: releasedQty,
      quarantined_qty_excluded: round(quarantined.reduce((s, l) => s + l.qty, 0), 4),
      lines: lines.map((l) => ({ line_id: l.external_id, name: l.name, line_type: l.line_type, cleanroom_grade: l.cleanroom_grade, product_id: l.product_id })),
      receipts: sim.receipts,
      batches: sim.rows.map((r) => ({
        batch_no: r.batch_no,
        work_order_id: r.work_order_id,
        line_id: r.line_id,
        line_name: r.line_name,
        product_id: r.product_id,
        start_date: r.start_date,
        material_needed: r.material_needed,
        available_at_start: r.available_at_start,
        feasible: r.feasible,
      })),
      batches_total: sim.batches_total,
      batches_at_risk: sim.batches_at_risk,
      all_feasible: sim.all_feasible,
      first_infeasible_batch: first
        ? { batch_no: first.batch_no, work_order_id: first.work_order_id, line_id: first.line_id, line_name: first.line_name, start_date: first.start_date, material_needed: first.material_needed, available_at_start: first.available_at_start, shortfall: first.shortfall }
        : null,
      headline,
      qa_packet: qa,
      board_item_ids: boardIds,
      method:
        "Released stock only (quarantine excluded), FEFO. Batches draw their BOM quantity on their start date. Transfers are usable after arrival + receipt verification; purchases after arrival + QC release. An infeasible batch draws nothing.",
    });
  },
});

export interface DossierData {
  material_id: string;
  spec: Pick<Material, "name" | "substance" | "material_class" | "grade" | "compendia" | "storage" | "shelf_life_days" | "sourcing_mode" | "unit"> & {
    salt_form: string | null;
    endotoxin_class: string | null;
    cold_chain: boolean;
    qc_release_days: number;
  };
  approved_suppliers: Array<{ material_supplier_id: string; supplier_id: string; supplier_name: string; qualification_state: string; dmf: boolean; cep: boolean; lead_time_days: number | null }>;
  pubchem: PubchemLookup;
  sites: string[];
  fetched_at: string;
}

const DOSSIER_TTL_MS = 7 * 86_400_000;

export const materialDossier = defineTool({
  name: "material_dossier",
  description:
    "Chemical dossier for a material: live PubChem metadata (CID, formula, molecular weight, IUPAC name, SMILES, XLogP, CAS, GHS hazard summary) and a 2D structure image URL, plus our spec (grade, compendia, storage, shelf life, sourcing mode) and approved suppliers. Biologics, adjuvants, polymers and packaging have no PubChem CID; the dossier explains why. Cached on the evidence board for 7 days.",
  idempotent: true,
  writes: "board",
  inputSchema: z.object({
    material_id: z.string(),
    refresh: z.boolean().default(false).describe("Ignore the cached dossier and query PubChem again."),
    mission_id: z.string().nullable().optional(),
  }),
  async run(ctx, args) {
    const { store } = ctx;
    const m = store.material(args.material_id);
    if (!m) return notFound("materials", `${args.material_id} not found`);
    const links = store.materialSuppliers({ material_id: m.external_id }).filter((l) => isApproved(l.qualification_state));
    const key = `dossier:${m.external_id}`;
    const cached = store.boardItems({ kind: "material_dossier", key })[0];
    let data: DossierData;
    let fromCache = false;
    if (cached && !args.refresh && Date.now() - Date.parse(cached.created_at) < DOSSIER_TTL_MS) {
      data = cached.data as DossierData;
      fromCache = true;
    } else {
      const pubchem = await pubchemLookup(m);
      data = {
        material_id: m.external_id,
        spec: {
          name: m.name,
          substance: m.substance,
          material_class: m.material_class,
          grade: m.grade,
          compendia: m.compendia,
          storage: m.storage,
          shelf_life_days: m.shelf_life_days,
          sourcing_mode: m.sourcing_mode,
          unit: m.unit,
          salt_form: m.salt_form ?? null,
          endotoxin_class: m.endotoxin_class ?? null,
          cold_chain: isColdChain(m.storage),
          qc_release_days: qcReleaseDays(m.material_class),
        },
        approved_suppliers: links.map((l) => ({
          material_supplier_id: l.external_id,
          supplier_id: l.supplier_id,
          supplier_name: store.supplier(l.supplier_id)?.name ?? l.supplier_id,
          qualification_state: l.qualification_state,
          dmf: l.dmf,
          cep: l.cep,
          lead_time_days: l.lead_time_days,
        })),
        pubchem,
        sites: store.consumption({ material_id: m.external_id }).map((c) => c.site_id),
        fetched_at: new Date().toISOString(),
      };
      // Only cache answers that will not change on retry (found / no CID / not applicable), never transient errors.
      if (pubchem.status !== "error") {
        const compound = pubchem.status === "found" ? pubchem.compound : null;
        const sourceUrls = pubchem.source_urls;
        store.addBoardItem({
          kind: "material_dossier",
          title: `Dossier: ${m.name}`,
          mission_id: args.mission_id ?? null,
          material_id: m.external_id,
          image_url: compound?.image_url ?? null,
          key,
          source_urls: sourceUrls,
          data,
        });
        if (compound) {
          store.addBoardItem({
            kind: "structure_image",
            title: `Structure: ${compound.query} (CID ${compound.cid})`,
            mission_id: args.mission_id ?? null,
            material_id: m.external_id,
            image_url: compound.image_url,
            key: `structure:${m.external_id}`,
            source_urls: [compound.page_url, compound.image_url],
            data: { cid: compound.cid, molecular_formula: compound.molecular_formula, molecular_weight: compound.molecular_weight, smiles: compound.smiles, cas: compound.cas },
          });
        }
      }
    }
    const pc = data.pubchem;
    const compound = pc.status === "found" ? pc.compound : null;
    const citations: Citation[] = [
      { source: "materials", ids: [m.external_id], excerpt: `${m.grade}; ${m.compendia.join(", ") || "no compendia"}; ${m.storage}` },
    ];
    if (links.length) citations.push({ source: "approved_suppliers", ids: links.map((l) => l.external_id) });
    const urls = pc.source_urls;
    if (urls.length) {
      citations.push({
        source: "pubchem",
        ids: urls,
        href: compound?.page_url ?? urls[0],
        excerpt: compound ? `CID ${compound.cid}, ${compound.molecular_formula}, MW ${compound.molecular_weight}` : pc.status === "found" ? "" : pc.explanation.slice(0, 200),
      });
    }
    return ok("pubchem", citations, {
      ...data,
      cached: fromCache,
      pubchem_status: pc.status,
      cid: compound?.cid ?? null,
      molecular_formula: compound?.molecular_formula ?? null,
      molecular_weight: compound?.molecular_weight ?? null,
      cas: compound?.cas ?? [],
      structure_image_url: compound?.image_url ?? null,
      ghs: compound?.ghs ?? null,
      explanation: pc.status === "found" ? null : pc.explanation,
      note: "PubChem describes the chemical entity, not our grade. Grade, endotoxin class and compendial compliance come from our spec and the supplier CoA.",
    });
  },
});

export const productionTools = [lineFeasibility, materialDossier];
