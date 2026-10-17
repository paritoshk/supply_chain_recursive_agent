import { addDays as addIsoDays, positionFor, qcReleaseDays, runTool, toolsByName, transferReleaseDays, type Position, type QaPacket, type Store } from "@supply-agent/core";
import { MODELS } from "./models.ts";
import { withStore, withStoreBoardOnly } from "./store.ts";

/** Days of the production schedule the batches_feasible check looks ahead. */
export const FEASIBILITY_HORIZON_DAYS = 60;

/** Purchases at or under this landed value with a quality-approved supplier need no human. */
export const AUTHORITY_LIMIT_USD = 25_000;
export const MAX_ATTEMPTS = 3;

export interface DoneCheck {
  id: string;
  description: string;
}

export interface MissionBrief {
  mission_id: string;
  material_id: string;
  material_name: string;
  site_id: string;
  site_name: string;
  today: string;
  position: Position;
  /** Quantity needed to get back above the reorder point. */
  need_qty: number;
  /** Date by which supply must land to avoid dipping into safety stock. */
  need_by: string;
  /** Executable definition of done, written before any work starts. */
  checks: DoneCheck[];
  /** Incoming QC release for a purchased lot / receipt verification for a transfer, in days. */
  qc_release_days: number;
  transfer_release_days: number;
  /** Production lines with scheduled batches that consume the material at the site. */
  line_ids: string[];
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.floor(n));
  return d.toISOString().slice(0, 10);
}

/** Opens (or reuses) the mission and writes its definition of done from the inventory position. */
export async function prepareMission(materialId: string, siteId: string, trigger: string): Promise<MissionBrief> {
  "use step";
  return withStore((store) => {
    const position = positionFor(store, materialId, siteId);
    const existing = store
      .missions()
      .find((m) => m.material_id === materialId && m.site_id === siteId && !["completed", "failed"].includes(m.status));
    const mission = existing ?? store.addMission({ trigger, material_id: materialId, site_id: siteId, status: "planning" });
    const rop = position.reorder_point ?? position.safety_stock;
    const needQty = Math.max(0, Math.ceil(rop - position.released_qty + position.daily_rate * (position.lead_time_days ?? 0)));
    const coverBeforeSafety = Math.max(0, (position.cover_days ?? 0) - position.safety_days);
    const needBy = addDays(store.today(), coverBeforeSafety);
    const material = store.material(materialId);
    const qcDays = material ? qcReleaseDays(material.material_class) : 14;
    const transferDays = material ? transferReleaseDays(material.material_class) : 3;
    const batches = store.workOrders({ site_id: siteId, material_id: materialId, from: store.today(), to: addIsoDays(store.today(), FEASIBILITY_HORIZON_DAYS) });
    const lineIds = [...new Set(batches.map((b) => b.line_id))];
    const checks: DoneCheck[] = [
      { id: "covers_need", description: `Secured supply (transfer + purchase) totals at least ${needQty} ${position.unit}.` },
      {
        id: "lands_in_time",
        description: `Supply is released for use before the site runs into safety stock. Without help that is ${needBy}. An internal transfer pushes the date out by (transfer qty / ${position.daily_rate} ${position.unit} per day) days. A purchase counts from QC release, not arrival: its lead time plus ${qcDays} days of incoming QC release must fit before the extended date.`,
      },
      { id: "qualified_only", description: "Every purchase source is quality_approved or released_for_use. Discovery candidates are never bought from." },
      { id: "comparable_quotes", description: "A purchase decision compares at least 2 normalized quotes, or explains why only one exists." },
      {
        id: "batches_feasible",
        description: lineIds.length
          ? `Every one of the ${batches.length} batches scheduled in the next ${FEASIBILITY_HORIZON_DAYS} days on ${lineIds.join(", ")} has enough released ${materialId} at its start. Simulated day by day: transfers count from arrival + ${transferDays} days receipt verification, purchases from arrival + ${qcDays} days QC release; quarantined stock never counts.`
          : `No batches scheduled in the next ${FEASIBILITY_HORIZON_DAYS} days consume ${materialId} at ${siteId}; passes when that is still true.`,
      },
      { id: "grounded", description: "Every number in the recommendation comes from a tool output (quote, cover projection, transfer proposal, line feasibility)." },
    ];
    store.updateMission(mission.id, { status: "running" });
    return {
      mission_id: mission.id,
      material_id: materialId,
      material_name: store.material(materialId)?.name ?? materialId,
      site_id: siteId,
      site_name: store.site(siteId)?.name ?? siteId,
      today: store.today(),
      position,
      need_qty: needQty,
      need_by: needBy,
      checks,
      qc_release_days: qcDays,
      transfer_release_days: transferDays,
      line_ids: lineIds,
    };
  }, { write: true });
}

export interface DossierSummary {
  pubchem_status: string;
  cid: number | null;
  molecular_formula: string | null;
  molecular_weight: number | null;
  cas: string[];
  structure_image_url: string | null;
  explanation: string | null;
}

/** Chemical metadata for QA (PubChem + our spec), cached on the evidence board. Never fails the mission. */
export async function gatherDossier(materialId: string, missionId: string): Promise<DossierSummary | null> {
  "use step";
  const tool = toolsByName["material_dossier"];
  if (!tool) return null;
  try {
    const out = (await withStoreBoardOnly((store) =>
      runTool(tool, { organizationId: "corvane", role: "planner", filters: {}, store }, { material_id: materialId, mission_id: missionId }),
    )) as unknown as DossierSummary;
    return {
      pubchem_status: out.pubchem_status,
      cid: out.cid ?? null,
      molecular_formula: out.molecular_formula ?? null,
      molecular_weight: out.molecular_weight ?? null,
      cas: out.cas ?? [],
      structure_image_url: out.structure_image_url ?? null,
      explanation: out.explanation ?? null,
    };
  } catch (err) {
    return { pubchem_status: "error", cid: null, molecular_formula: null, molecular_weight: null, cas: [], structure_image_url: null, explanation: (err as Error).message };
  }
}

export interface BranchResult {
  branch: "transfer" | "sourcing" | "scout";
  status: "ok" | "failed";
  data?: unknown;
  error?: string;
  latency_ms: number;
}

/** Records one node of the agent tree so the trace and the report can be rebuilt later. */
export async function recordRun(missionId: string, parentId: string | null, role: string, input: unknown, result: BranchResult | { status: string; data?: unknown; error?: string; latency_ms: number }, model: string) {
  "use step";
  return withStore((store: Store) => {
    const run = store.addAgentRun({
      parent_id: parentId,
      mission_id: missionId,
      role: role as never,
      model,
      status: result.status === "ok" || result.status === "pass" ? "completed" : "failed",
      input,
      output: result.data ?? null,
      tool_calls: [],
      tokens_in: 0,
      tokens_out: 0,
      latency_ms: result.latency_ms,
      error: result.error ?? null,
      ended_at: new Date().toISOString(),
    } as never);
    return run.id;
  }, { write: true });
}

export async function finishMission(
  missionId: string,
  status: "completed" | "degraded" | "failed",
  summary: string,
  finding: { headline: string; severity: "info" | "watch" | "action"; detail: string },
  board?: { material_id: string; site_id: string; data: unknown },
) {
  "use step";
  return withStore((store) => {
    store.updateMission(missionId, { status, summary });
    store.addFinding({ ...finding, cited_tool_calls: [] } as never);
    if (board) {
      store.addBoardItem({
        kind: "mission_summary",
        title: finding.headline,
        mission_id: missionId,
        material_id: board.material_id,
        site_id: board.site_id,
        image_url: null,
        key: `mission:${missionId}`,
        source_urls: [],
        data: { status, summary, ...(board.data as Record<string, unknown>) },
      });
    }
    return { mission_id: missionId, status };
  }, { write: true });
}

export const modelFor = (role: "planner" | "worker" | "verifier") => MODELS[role];

export interface CheckResult {
  id: string;
  pass: boolean;
  reason: string;
}

export interface ComputedPlan {
  transfer: { from_site_id: string; qty: number; arrives_in_days: number; cover_after_days: number | null } | null;
  purchase: {
    rfq_id: string;
    supplier_id: string;
    supplier_name: string;
    qualification_state: string;
    qty: number;
    landed_unit_usd: number | null;
    lead_time_days: number;
    value_usd: number | null;
  } | null;
  quotes_considered: number;
  days_available: number;
  /** Fastest lead time among priced, qualified quotes (null when none is priced). */
  fastest_lead_days: number | null;
  /** True when no re-plan can fix the gap: nothing priced, or the fastest source misses by more than an expedite can recover. */
  unfixable: boolean;
  /** Incoming QC release days added to every purchase lead time. */
  qc_release_days: number;
  /** Production-line check on the computed plan (summary; the per-batch table is in the facts). */
  feasibility: {
    batches_total: number;
    batches_at_risk: number;
    all_feasible: boolean;
    first_infeasible_batch: { batch_no: string; line_id: string; line_name: string; start_date: string; material_needed: number; available_at_start: number } | null;
    line_ids: string[];
  };
  /** QA flags for the computed plan. */
  qa: { change_control_required: boolean; change_control_reasons: string[]; cold_chain: boolean; documents_required: string[] };
}

export interface FeasibilityFacts {
  headline: string;
  batches: Array<{ batch_no: string; line_id: string; line_name: string; product_id: string; start_date: string; material_needed: number; available_at_start: number; feasible: boolean }>;
  receipts: Array<{ kind: string; qty: number; arrival_date: string; release_day: number; release_date: string }>;
  batches_total: number;
  batches_at_risk: number;
  all_feasible: boolean;
  first_infeasible_batch: ComputedPlan["feasibility"]["first_infeasible_batch"];
  lines: Array<{ line_id: string; name: string; line_type: string; cleanroom_grade: string }>;
  qa_packet: QaPacket;
}

const APPROVED = new Set(["quality_approved", "released_for_use"]);

/**
 * Deterministic half of the judge: recomputes every number from the store (never from model text)
 * and evaluates the numeric definition-of-done checks.
 */
export async function evaluateChecks(
  brief: MissionBrief,
  rfqId: string | null,
): Promise<{ checks: CheckResult[]; plan: ComputedPlan; proposal: unknown; feasibility: Omit<FeasibilityFacts, "qa_packet">; qa_packet: QaPacket }> {
  "use step";
  // Reads only; the line_feasibility board items (report + QA packet) are merged into fresh state afterwards.
  return withStoreBoardOnly(async (store) => {
    const ctx = { organizationId: "corvane", role: "verifier", filters: {}, store } as const;
    const p = brief.position;
    const t = (await runTool(toolsByName["propose_transfer"]!, ctx, { material_id: brief.material_id, to_site_id: brief.site_id })) as {
      proposal?: { from_site_id: string; qty: number; distance_km: number | null; to_site_cover_after_days: number | null } | null;
    };
    const proposal = t.proposal ?? null;
    const transfer = proposal
      ? {
          from_site_id: proposal.from_site_id,
          qty: proposal.qty,
          arrives_in_days: (proposal.distance_km ?? 0) > 1500 ? 7 : 3,
          cover_after_days: proposal.to_site_cover_after_days,
        }
      : null;
    const releasedAfter = p.released_qty + (transfer?.qty ?? 0);
    const coverAfter = p.daily_rate > 0 ? releasedAfter / p.daily_rate : Infinity;
    const daysAvailable = Math.floor(coverAfter - p.safety_days);
    const purchaseQty = Math.max(0, Math.ceil(brief.need_qty - (transfer?.qty ?? 0)));

    type Row = { quote_id?: string; supplier_id: string; supplier_name: string; qualification_state: string; landed_usd_per_unit: number | null; lead_time_days: number; expired: boolean; blocked: boolean; comparable: boolean };
    let rows: Row[] = [];
    if (rfqId && store.rfq(rfqId)) {
      const q = (await runTool(toolsByName["compare_quotes"]!, ctx, { rfq_id: rfqId })) as unknown as { quotes: Row[] };
      rows = q.quotes;
    }
    const material = store.material(brief.material_id);
    const qcDays = material ? qcReleaseDays(material.material_class) : (brief.qc_release_days ?? 14);
    const usable = rows.filter((r) => r.comparable && !r.blocked && !r.expired && APPROVED.has(r.qualification_state));
    // A purchased lot is usable only after QC release, so lead time + QC release must fit.
    const inTime = usable.filter((r) => r.lead_time_days + qcDays <= daysAvailable).sort((a, b) => (a.landed_usd_per_unit ?? Infinity) - (b.landed_usd_per_unit ?? Infinity));
    const chosen = inTime[0] ?? [...usable].sort((a, b) => a.lead_time_days - b.lead_time_days)[0] ?? null;
    const purchase =
      chosen && purchaseQty > 0 && rfqId
        ? {
            rfq_id: rfqId,
            supplier_id: chosen.supplier_id,
            supplier_name: chosen.supplier_name,
            qualification_state: chosen.qualification_state,
            qty: purchaseQty,
            landed_unit_usd: chosen.landed_usd_per_unit,
            lead_time_days: chosen.lead_time_days,
            value_usd: chosen.landed_usd_per_unit != null ? Math.round(chosen.landed_usd_per_unit * purchaseQty) : null,
          }
        : null;
    const secured = (transfer?.qty ?? 0) + (purchase?.qty ?? 0);
    const lf = (await runTool(toolsByName["line_feasibility"]!, ctx, {
      material_id: brief.material_id,
      site_id: brief.site_id,
      transfer: transfer ? { qty: transfer.qty, arrives_in_days: transfer.arrives_in_days, from_site_id: transfer.from_site_id } : null,
      purchase: purchase ? { qty: purchase.qty, lead_time_days: purchase.lead_time_days, supplier_id: purchase.supplier_id } : null,
      horizon_days: FEASIBILITY_HORIZON_DAYS,
      mission_id: brief.mission_id,
    })) as unknown as FeasibilityFacts;
    const releaseDay = (kind: string) => lf.receipts.find((r) => r.kind === kind)?.release_day;
    const first = lf.first_infeasible_batch;
    const landedDays = purchase ? purchase.lead_time_days + qcDays : null;
    const checks: CheckResult[] = [
      { id: "covers_need", pass: secured >= brief.need_qty, reason: `transfer ${transfer?.qty ?? 0} + purchase ${purchase?.qty ?? 0} = ${secured} vs need ${brief.need_qty} ${p.unit}` },
      {
        id: "lands_in_time",
        pass: purchaseQty === 0 || (landedDays != null && landedDays <= daysAvailable),
        reason: `${daysAvailable} days available after transfer (cover ${coverAfter === Infinity ? "n/a" : coverAfter.toFixed(1)} d − safety ${p.safety_days} d); chosen lead time ${purchase?.lead_time_days ?? "none"} d + QC release ${qcDays} d = ${landedDays ?? "none"} d`,
      },
      {
        id: "qualified_only",
        pass: purchase == null || APPROVED.has(purchase.qualification_state),
        reason: purchase ? `${purchase.supplier_name} is ${purchase.qualification_state}` : "no purchase",
      },
      {
        id: "comparable_quotes",
        pass: purchaseQty === 0 || usable.length >= 2,
        reason: `${usable.length} usable quotes of ${rows.length} received on ${rfqId ?? "no RFQ"}`,
      },
      {
        id: "batches_feasible",
        pass: lf.all_feasible,
        reason: !lf.batches_total
          ? `no batches scheduled in the next ${FEASIBILITY_HORIZON_DAYS} days consume ${brief.material_id} at ${brief.site_id}`
          : `${lf.batches_total - lf.batches_at_risk}/${lf.batches_total} batches on ${lf.lines.map((l) => l.line_id).join(", ")} have released material at start` +
            ` (transfer released day ${releaseDay("transfer") ?? "-"}, purchase released day ${releaseDay("purchase") ?? "-"})` +
            (first ? `; first at risk ${first.batch_no} on ${first.start_date} (${first.line_name}) needs ${first.material_needed} ${p.unit}, ${first.available_at_start} released` : ""),
      },
    ];
    const fastest = usable.length ? Math.min(...usable.map((r) => r.lead_time_days)) : null;
    const unfixable = purchaseQty > 0 && (fastest == null || fastest + qcDays - daysAvailable > 28);
    const qa = lf.qa_packet;
    return {
      checks,
      plan: {
        transfer,
        purchase,
        quotes_considered: rows.length,
        days_available: daysAvailable,
        fastest_lead_days: fastest,
        unfixable,
        qc_release_days: qcDays,
        feasibility: {
          batches_total: lf.batches_total,
          batches_at_risk: lf.batches_at_risk,
          all_feasible: lf.all_feasible,
          first_infeasible_batch: first
            ? { batch_no: first.batch_no, line_id: first.line_id, line_name: first.line_name, start_date: first.start_date, material_needed: first.material_needed, available_at_start: first.available_at_start }
            : null,
          line_ids: lf.lines.map((l) => l.line_id),
        },
        qa: { change_control_required: qa.change_control_required, change_control_reasons: qa.change_control_reasons, cold_chain: qa.cold_chain, documents_required: qa.documents_required },
      },
      proposal: t,
      feasibility: {
        headline: lf.headline,
        batches: lf.batches,
        receipts: lf.receipts,
        batches_total: lf.batches_total,
        batches_at_risk: lf.batches_at_risk,
        all_feasible: lf.all_feasible,
        first_infeasible_batch: first,
        lines: lf.lines,
      },
      qa_packet: qa,
    };
  });
}
