"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock,
  FileText,
  FlaskConical,
  Github,
  GripVertical,
  LayoutGrid,
  Loader2,
  Maximize2,
  MessageSquare,
  MoreHorizontal,
  Network,
  PanelRight,
  Play,
  Plus,
  RotateCcw,
  Settings,

  Pause,
  RefreshCw,
  X,
  XCircle,
} from "lucide-react";
import FooterWithSuite from "@/components/ui/footer-with-suite";

const AgenticFactory3D = dynamic(() => import("@/components/ui/agentic-factory-3d"), {
  ssr: false,
  loading: () => <div className="flex h-full w-full items-center justify-center bg-[#141311] label-mono">Loading mission floor…</div>,
});

function machine() {
  return typeof window !== "undefined" ? window.__machine : undefined;
}

/* ------------------------------------------------------------------ types */

type InputOption = { id: string; label: string };
type PendingInput = { requestId: string; options: InputOption[] };

type ChatMsg = {
  id: string;
  role: "user" | "bot" | "alert" | "system";
  text: string;
  at: number;
  input?: PendingInput[];
  answered?: string;
};

type Check = { id: string; pass?: boolean; reason?: string };

type AnyObj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

type NodeId = "sentinel" | "planner" | "transfer" | "sourcing" | "negotiators" | "scout" | "judge" | "approval";
type NodeStatus = "idle" | "active" | "done" | "failed" | "waiting";

type ToolChip = { name: string; done: boolean };

type Pipeline = {
  nodes: Record<NodeId, NodeStatus>;
  notes: Partial<Record<NodeId, string>>;
  tools: ToolChip[];
  negotiators: number;
  mission: boolean;
  missionId?: string;
  needQty?: number;
  needBy?: string;
  dod: string[];
  attempt: number;
  decision?: string;
  checks: Check[];
  planLine?: string;
  approval?: string;
  startedAt: number | null;
  endedAt: number | null;
};

type Molecule = {
  pubchem_status?: string;
  cid?: number | null;
  molecular_formula?: string | null;
  molecular_weight?: number | string | null;
  cas?: string[] | null;
  structure_image_url?: string | null;
  explanation?: string | null;
};
type LineReq = {
  line_id: string;
  line_name?: string;
  line_type?: string;
  cleanroom_grade?: string;
  needs_low_endotoxin?: boolean;
  needs_parenteral?: boolean;
  needs_compendia?: string[];
  rationale?: string;
};
type Batch = {
  batch_no: string;
  line_id?: string;
  line_name?: string;
  product_id?: string;
  start_date: string;
  material_needed?: number;
  available_at_start?: number;
  feasible: boolean;
};
type SupplierFit = {
  supplier_id: string;
  supplier_name?: string;
  approved_grade?: string;
  meets_requirement: boolean;
  gaps?: string[];
  quality_score: number;
  rank: number;
};
type QaFit = {
  material_id?: string;
  material_name?: string;
  site_id?: string;
  site_name?: string;
  molecule?: Molecule | null;
  lines?: LineReq[];
  batches?: Batch[];
  batches_total?: number;
  batches_at_risk?: number;
  suppliers?: SupplierFit[];
  chosen_supplier_id?: string | null;
  qc_release_days?: number | null;
  change_control_required?: boolean;
  documents_required?: string[];
};

const ALL_NODES: NodeId[] = ["sentinel", "planner", "transfer", "sourcing", "negotiators", "scout", "judge", "approval"];
const idleNodes = () => Object.fromEntries(ALL_NODES.map((n) => [n, "idle"])) as Record<NodeId, NodeStatus>;

const EMPTY_PIPE: Pipeline = {
  nodes: idleNodes(),
  notes: {},
  tools: [],
  negotiators: 0,
  mission: false,
  dod: [],
  attempt: 0,
  checks: [],
  startedAt: null,
  endedAt: null,
};

const DEFAULT_CHECKS = [
  "covers_need",
  "lands_in_time",
  "qualified_only",
  "comparable_quotes",
  "batches_feasible",
  "grade_fit",
  "grounded",
];

/* --------------------------------------------------------------- actions */

type QuickAction = {
  key: string;
  label: string;
  ids?: string;
  message: string;
  alert?: string;
  mission?: { material: string; site: string };
};

function missionMsg(name: string, site: string, mat: string, siteId: string) {
  return `Sentinel alert: ${name} at ${site} is below reorder point. Run run_mission for material ${mat} at site ${siteId}, then tell the planner the outcome in four lines.`;
}

const ACTIONS: QuickAction[] = [
  { key: "low", label: "What's low?", message: "What's low?" },
  {
    key: "suc",
    label: "Mission: sucrose @ Ghent",
    ids: "MAT-SUC-INJ · SITE-GHE",
    message: missionMsg("Sucrose injectable grade", "Ghent", "MAT-SUC-INJ", "SITE-GHE"),
    alert: "Sucrose injectable grade at Ghent (MAT-SUC-INJ · SITE-GHE) is below reorder point. Opening a mission.",
    mission: { material: "MAT-SUC-INJ", site: "SITE-GHE" },
  },
  {
    key: "man",
    label: "Mission: mannitol @ Raleigh",
    ids: "MAT-MAN-PAR · SITE-RAL",
    message: missionMsg("Mannitol parenteral grade", "Raleigh", "MAT-MAN-PAR", "SITE-RAL"),
    alert: "Mannitol parenteral grade at Raleigh (MAT-MAN-PAR · SITE-RAL) is below reorder point. Opening a mission.",
    mission: { material: "MAT-MAN-PAR", site: "SITE-RAL" },
  },
  {
    key: "sap",
    label: "Guardrail: saponin @ Ghent",
    ids: "MAT-SAP-QS · SITE-GHE",
    message: missionMsg("Saponin adjuvant QS-class", "Ghent", "MAT-SAP-QS", "SITE-GHE"),
    alert: "Saponin adjuvant QS-class at Ghent (MAT-SAP-QS · SITE-GHE) is below reorder point. Opening a mission.",
    mission: { material: "MAT-SAP-QS", site: "SITE-GHE" },
  },
  { key: "cork", label: "Price expiring mannitol at Cork", message: "Price expiring mannitol at Cork" },
];

const HEADER_TAGS = ["Recursive agents", "Crusoe", "Nemotron", "Telegram", "You.com", "PubChem", "Synthetic data"];


/* ----------------------------------------------------------------- utils */

let idSeq = 0;
const nid = () => `m${Date.now().toString(36)}${(idSeq++).toString(36)}`;
const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const fmtUsd = (n: unknown) =>
  typeof n === "number" ? `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : undefined;

function planLineFrom(out: AnyObj): string | undefined {
  const plan = out?.plan;
  if (!plan) return undefined;
  const parts: string[] = [];
  const t = plan.transfer;
  if (t && t.qty) parts.push(`transfer ${t.qty} kg from ${t.from_site_id}${t.arrives_in_days != null ? ` (${t.arrives_in_days} d)` : ""}`);
  const p = plan.purchase;
  if (p && p.qty) {
    const unit = fmtUsd(p.landed_unit_usd);
    parts.push(
      `buy ${p.qty} kg from ${p.supplier_name}${unit ? ` at ${unit}/kg` : ""}${p.lead_time_days != null ? `, ${p.lead_time_days} d lead` : ""}${p.rfq_id ? ` (${p.rfq_id})` : ""}`
    );
    const v = fmtUsd(p.value_usd);
    if (v) parts.push(`value ${v}`);
  }
  if (!parts.length) return undefined;
  const s = parts.join(" + ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const APPROVAL_LABEL: Record<string, [string, NodeStatus]> = {
  auto: ["auto-approved", "done"],
  approved: ["approved by you", "done"],
  rejected: ["rejected", "failed"],
  qualification_opened: ["qualification opened", "done"],
  none: ["no PO", "idle"],
};

/* ------------------------------------------------------------- component */

/* ------------------------------------------------------- mission state */

type Phase =
  | "idle"
  | "requesting"
  | "attached"
  | "planned"
  | "running"
  | "verifying"
  | "awaiting_approval"
  | "done"
  | "escalated"
  | "failed"
  | "cancelled";

const LIVE_PHASES: Phase[] = ["attached", "planned", "running", "verifying", "awaiting_approval"];
const TERMINAL_PHASES: Phase[] = ["done", "escalated", "failed", "cancelled"];

const PHASE_LABEL: Record<Phase, string> = {
  idle: "Idle",
  requesting: "Requesting",
  attached: "Mission starting",
  planned: "Planned",
  running: "Running",
  verifying: "Verifying",
  awaiting_approval: "Waiting for approval",
  done: "Done",
  escalated: "Escalated",
  failed: "Failed",
  cancelled: "Cancelled",
};

type Conn = "none" | "connecting" | "live" | "reconnecting" | "lost";

type TheaterState = {
  sessionId: string | null;
  mirror: boolean;
  phase: Phase;
  /** a mission is the subject of this session (run_mission called or a mission chip pressed) */
  turnBusy: boolean;
  conn: Conn;
  msgs: ChatMsg[];
  msgKeys: string[];
  pipe: Pipeline;
  qa: QaFit | null;
  plan: AnyObj | null;
  events: EventRow[];
};

const INITIAL_STATE: TheaterState = {
  sessionId: null,
  mirror: false,
  phase: "idle",
  turnBusy: false,
  conn: "none",
  msgs: [],
  msgKeys: [],
  pipe: EMPTY_PIPE,
  qa: null,
  plan: null,
  events: [],
};

type TheaterAction =
  | { type: "reset" }
  | { type: "mission_requested"; mode: "phone" | "page"; alert?: string }
  | { type: "mission_request_failed"; reason: string }
  | { type: "attached"; sessionId: string; mirror: boolean; note?: string }
  | { type: "user_sent"; text: string; local: boolean }
  | { type: "answered"; msgId: string; label: string }
  | { type: "send_failed"; reason: string }
  | { type: "conn"; sessionId: string; conn: Conn }
  | { type: "event"; sessionId: string; ev: AnyObj };

const setNode = (p: Pipeline, patch: Partial<Record<NodeId, NodeStatus>>, notes?: Partial<Record<NodeId, string>>): Pipeline => ({
  ...p,
  nodes: { ...p.nodes, ...patch },
  notes: notes ? { ...p.notes, ...notes } : p.notes,
});

const missionPipe = (now: number): Pipeline => ({
  ...EMPTY_PIPE,
  nodes: { ...idleNodes(), sentinel: "active" },
  notes: { sentinel: "below reorder point" },
  mission: true,
  dod: DEFAULT_CHECKS,
  checks: DEFAULT_CHECKS.map((id) => ({ id })),
  startedAt: now,
});

/** Append a chat message unless an identical one (same key) is already there. */
function withMsg(s: TheaterState, key: string, m: Omit<ChatMsg, "id" | "at"> & { at?: number }): TheaterState {
  if (s.msgKeys.includes(key)) return s;
  const last = s.msgs[s.msgs.length - 1];
  if (m.role === "system" && last?.role === "system" && last.text === m.text) return s;
  return { ...s, msgKeys: [...s.msgKeys, key], msgs: [...s.msgs, { id: nid(), at: Date.now(), ...m }] };
}

/** Clears everything a previous mission left behind; keeps the chat. */
function clearMission(s: TheaterState): TheaterState {
  return { ...s, pipe: EMPTY_PIPE, qa: null, plan: null, events: [] };
}

function endMission(s: TheaterState, phase: Phase): TheaterState {
  const nodes = { ...s.pipe.nodes };
  const failed = phase === "failed" || phase === "cancelled";
  for (const n of ALL_NODES) if (nodes[n] === "active") nodes[n] = failed ? "failed" : "done";
  return { ...s, phase, pipe: { ...s.pipe, nodes, endedAt: s.pipe.endedAt ?? Date.now() } };
}

function eventRow(e: AnyObj): EventRow | null {
  const type: string = String(e?.type ?? "");
  if (!type || /appended|delta|\.metadata|logprobs/.test(type)) return null;
  const d: AnyObj = e?.data ?? {};
  let text = "";
  if (typeof d.message === "string") text = d.message;
  else if (type === "actions.requested") text = (d.actions ?? []).map((a: AnyObj) => a.toolName ?? a.name).join(", ");
  else if (type === "action.partial") text = String(d.result?.output?.stage ?? "");
  else if (type === "action.result") text = String(d.result?.toolName ?? "");
  else if (type === "agent.started") text = String(d.name ?? "");
  else if (type === "turn.waiting") text = String(d.on ?? "");
  const at = Date.parse(e?.meta?.at ?? "") || Date.now();
  return { at, type, text: text.replace(/\s+/g, " ").slice(0, 120) };
}

function applyEvent(s0: TheaterState, e: AnyObj): TheaterState {
  const type: string = e?.type;
  const d: AnyObj = e?.data ?? {};
  const row = eventRow(e);
  let s: TheaterState = row ? { ...s0, events: [...s0.events.slice(-149), row] } : s0;
  const p = s.pipe;
  const turn = String(d.turnId ?? d.sequence ?? "");
  switch (type) {
    case "turn.started":
      return { ...s, turnBusy: true, pipe: p.nodes.planner === "active" ? p : setNode(p, { planner: "active" }) };

    case "message.received": {
      // Our own page-mode messages are already on screen; in mirror mode the phone's messages come from here.
      if (!s.mirror) return s;
      const text = typeof d.message === "string" ? d.message.trim() : "";
      if (!text) return s;
      const key = `${s.sessionId}|${turn}|in|${text}`;
      if (text.startsWith("Sentinel alert")) {
        const alert = text.replace(/^Sentinel alert:\s*/, "").split(". Run run_mission")[0].replace(/\.?$/, ".");
        s = withMsg(s, key, { role: "alert", text: alert });
        if (!LIVE_PHASES.includes(s.phase)) s = { ...clearMission(s), phase: "attached", pipe: missionPipe(Date.now()) };
        return { ...s, pipe: setNode(s.pipe, { planner: "active" }) };
      }
      s = withMsg(s, key, { role: "user", text });
      return { ...s, pipe: setNode(s.pipe, { planner: "active" }, { planner: "reading your message" }) };
    }

    case "message.completed": {
      const text = typeof d.message === "string" ? d.message.trim() : "";
      if (text) s = withMsg(s, `${s.sessionId}|${turn}|out|${text}`, { role: "bot", text });
      return { ...s, pipe: setNode(s.pipe, { planner: "done" }, { planner: "replied" }) };
    }

    case "actions.requested": {
      const names = (d.actions ?? []).map((a: AnyObj) => String(a.toolName ?? a.name ?? "tool")) as string[];
      if (names.includes("run_mission") && !LIVE_PHASES.includes(s.phase)) {
        s = { ...clearMission(s), phase: "attached", pipe: { ...missionPipe(Date.now()), tools: s.pipe.tools } };
      }
      const tools = [...s.pipe.tools];
      for (const n of names) if (!tools.some((t) => t.name === n && !t.done)) tools.push({ name: n, done: false });
      return { ...s, pipe: { ...setNode(s.pipe, { planner: "active" }, { planner: `calling ${names.join(", ")}` }), tools } };
    }

    case "action.partial": {
      const out: AnyObj = d.result?.output ?? {};
      switch (out.stage) {
        case "planned":
          return {
            ...s,
            phase: "planned",
            pipe: {
              ...setNode(p, { sentinel: "done", planner: "active" }, { sentinel: "alert raised", planner: "mission planned" }),
              mission: true,
              startedAt: p.startedAt ?? Date.now(),
              endedAt: null,
              missionId: out.mission_id,
              needQty: out.need_qty,
              needBy: out.need_by,
              attempt: 1,
              dod: Array.isArray(out.definition_of_done) ? out.definition_of_done : p.dod,
              checks: Array.isArray(out.definition_of_done) ? out.definition_of_done.map((id: string) => ({ id })) : p.checks,
            },
          };
        case "dossier":
          return {
            ...s,
            qa: {
              ...(s.qa ?? {}),
              molecule: { ...(s.qa?.molecule ?? {}), pubchem_status: out.pubchem_status, cid: out.cid ?? null, structure_image_url: out.structure_image_url ?? null },
            },
          };
        case "branches_done": {
          const st = (x: unknown): NodeStatus => (x === "rejected" ? "failed" : "done");
          return {
            ...s,
            phase: "verifying",
            pipe: {
              ...setNode(
                p,
                { transfer: st(out.transfer), sourcing: st(out.sourcing), negotiators: st(out.sourcing), scout: st(out.scout), judge: "active" },
                { judge: "recomputing checks in code", sourcing: out.rfq_id ? String(out.rfq_id) : p.notes.sourcing }
              ),
              attempt: out.attempt ?? p.attempt,
            },
          };
        }
        case "qa_fit":
          return {
            ...s,
            phase: "verifying",
            qa: { ...(out as QaFit), molecule: { ...(s.qa?.molecule ?? {}), ...(out.molecule ?? {}) } },
            pipe: setNode(p, { judge: "active" }, { judge: "Nemotron checking grounding" }),
          };
        case "verified": {
          const checks: Check[] = Array.isArray(out.checks) ? out.checks : [];
          const decision: string = out.decision;
          const merged = p.checks.length
            ? p.checks
                .map((c) => {
                  const hit = checks.find((x) => x.id === c.id);
                  return hit ? { ...c, pass: hit.pass, reason: hit.reason ?? c.reason } : c;
                })
                .concat(checks.filter((x) => !p.checks.some((c) => c.id === x.id)))
            : checks;
          const passed = checks.filter((c) => c.pass).length;
          let next = setNode(p, { judge: decision === "accept" ? "done" : "failed" }, { judge: `${decision} · ${passed}/${checks.length} checks` });
          const replan = decision === "replan";
          next = replan
            ? setNode(next, { planner: "active", sourcing: "idle", negotiators: "idle" }, { planner: `re-planning (attempt ${(out.attempt ?? p.attempt) + 1})` })
            : setNode(next, { approval: "active" }, { approval: "deciding", planner: "waiting on the mission" });
          return {
            ...s,
            phase: replan ? "running" : "verifying",
            pipe: { ...next, attempt: replan ? (out.attempt ?? p.attempt) + 1 : out.attempt ?? p.attempt, decision, checks: merged },
          };
        }
      }
      return s;
    }

    case "action.result": {
      const r: AnyObj = d.result ?? {};
      const tool = String(r.toolName ?? "");
      s = { ...s, pipe: { ...s.pipe, tools: s.pipe.tools.map((t) => (t.name === tool ? { ...t, done: true } : t)) } };
      if (tool !== "run_mission") return s;
      const out: AnyObj = r.output ?? {};
      const apKey: string = typeof out.approval === "string" ? out.approval : out.approval?.status ?? "none";
      const [apLabel, apStatus] = APPROVAL_LABEL[apKey] ?? [apKey, "done"];
      const phase: Phase = apKey === "rejected" ? "cancelled" : apKey === "none" && s.pipe.decision === "escalate" ? "escalated" : "done";
      const qf: AnyObj | undefined = out.quality_fit;
      const qa: QaFit | null =
        qf && !s.qa?.suppliers?.length
          ? {
              ...(s.qa ?? {}),
              lines: qf.requirement ?? s.qa?.lines,
              suppliers: qf.fits ?? s.qa?.suppliers,
              chosen_supplier_id: out.plan?.purchase?.supplier_id ?? s.qa?.chosen_supplier_id ?? null,
              qc_release_days: out.plan?.qc_release_days ?? s.qa?.qc_release_days,
              change_control_required: out.plan?.qa?.change_control_required ?? s.qa?.change_control_required,
              documents_required: out.plan?.qa?.documents_required ?? s.qa?.documents_required,
            }
          : s.qa;
      s = {
        ...s,
        qa,
        plan: out.plan ?? s.plan,
        pipe: {
          ...setNode(s.pipe, { approval: apStatus, sentinel: "done" }, { approval: apLabel }),
          attempt: out.attempts ?? s.pipe.attempt,
          missionId: out.mission_id ?? s.pipe.missionId,
          checks: Array.isArray(out.checks) && out.checks.length ? out.checks : s.pipe.checks,
          planLine: planLineFrom(out) ?? (typeof out.summary === "string" ? out.summary : s.pipe.planLine),
          approval: apLabel,
        },
      };
      return endMission(s, phase);
    }

    case "agent.started": {
      const name = String(d.name ?? "agent").toLowerCase();
      if (s.phase === "attached" || s.phase === "planned") s = { ...s, phase: "running" };
      if (name === "transfer" || name === "sourcing" || name === "scout") return { ...s, pipe: setNode(s.pipe, { [name]: "active" } as Partial<Record<NodeId, NodeStatus>>) };
      if (name === "verifier" || name === "judge") return { ...s, phase: "verifying", pipe: setNode(s.pipe, { judge: "active" }, { judge: "Nemotron checking grounding" }) };
      if (/negot|supplier|persona/.test(name)) return { ...s, pipe: { ...setNode(s.pipe, { negotiators: "active" }), negotiators: s.pipe.negotiators + 1 } };
      return s;
    }

    case "input.requested": {
      for (const r of (d.requests ?? []) as AnyObj[]) {
        const opts: InputOption[] = (r.options ?? r.question?.options ?? []).map((o: AnyObj) => ({ id: String(o.id ?? o.value), label: String(o.label ?? o.id) }));
        const prompt: string = r.prompt ?? r.question?.prompt ?? r.title ?? "Approval needed";
        const requestId = String(r.requestId ?? r.id);
        s = withMsg(s, `${s.sessionId}|input|${requestId}`, { role: "bot", text: prompt, input: [{ requestId, options: opts }] });
      }
      return {
        ...s,
        phase: s.pipe.mission ? "awaiting_approval" : s.phase,
        pipe: { ...setNode(s.pipe, { approval: "waiting" }, { approval: "waiting for you" }), approval: "waiting for you" },
      };
    }

    case "input.resolved":
      return { ...s, msgs: s.msgs.map((m) => (m.input?.some((q) => q.requestId === String(d.requestId ?? "")) && !m.answered ? { ...m, answered: "answered" } : m)) };

    case "turn.waiting":
      return d.on === "input" ? { ...s, turnBusy: false } : s;

    case "turn.completed":
    case "turn.failed":
    case "turn.cancelled": {
      s = { ...s, turnBusy: false };
      const failed = type !== "turn.completed";
      if (failed) s = withMsg(s, `${s.sessionId}|${turn}|ended`, { role: "system", text: "The turn ended early. Try again." });
      if (LIVE_PHASES.includes(s.phase) || s.phase === "requesting") {
        // Turn finished without a mission result: a chat answer, or the agent declined to run the mission.
        if (!s.pipe.missionId && !failed) {
          const nodes = { ...s.pipe.nodes };
          for (const n of ALL_NODES) if (nodes[n] === "active") nodes[n] = "done";
          return { ...s, phase: "idle", pipe: { ...s.pipe, nodes, endedAt: s.pipe.endedAt ?? Date.now() } };
        }
        if (s.phase !== "awaiting_approval") return endMission(s, failed ? (type === "turn.cancelled" ? "cancelled" : "failed") : "done");
      }
      const nodes = { ...s.pipe.nodes };
      for (const n of ALL_NODES) if (nodes[n] === "active") nodes[n] = failed ? "failed" : "done";
      return { ...s, pipe: { ...s.pipe, nodes } };
    }

    case "session.failed":
      return LIVE_PHASES.includes(s.phase) ? endMission({ ...s, turnBusy: false }, "failed") : { ...s, turnBusy: false };
  }
  return s;
}

function theaterReducer(s: TheaterState, a: TheaterAction): TheaterState {
  switch (a.type) {
    case "reset":
      return INITIAL_STATE;

    case "mission_requested": {
      let next: TheaterState = { ...clearMission(s), phase: "requesting", turnBusy: true, pipe: missionPipe(Date.now()) };
      if (a.mode === "page") {
        // A page mission gets its own fresh session; the old one is dropped.
        next = { ...next, sessionId: null, mirror: false, conn: "none" };
        if (a.alert) next = withMsg(next, `alert|${Date.now()}`, { role: "alert", text: a.alert });
      }
      return next;
    }

    case "mission_request_failed":
      return withMsg({ ...clearMission(s), phase: "idle", turnBusy: false }, `failed|${a.reason}|${s.msgs.length}`, { role: "system", text: a.reason });

    case "attached": {
      let next: TheaterState = { ...s, sessionId: a.sessionId, mirror: a.mirror, conn: "connecting", phase: s.phase === "requesting" ? "attached" : s.phase };
      if (a.mirror) next = { ...next, msgs: [], msgKeys: [] };
      if (a.note) next = withMsg(next, `note|${a.sessionId}`, { role: "system", text: a.note });
      return next;
    }

    case "user_sent": {
      let next: TheaterState = { ...s, turnBusy: true };
      if (a.local) next = withMsg(next, `local|${Date.now()}|${a.text}`, { role: "user", text: a.text });
      const missionLive = LIVE_PHASES.includes(next.phase);
      return {
        ...next,
        pipe: missionLive ? setNode(next.pipe, { planner: "active" }) : { ...setNode(next.pipe, { planner: "active" }, { planner: "reading your message" }), tools: [] },
      };
    }

    case "answered": {
      const next = { ...s, turnBusy: true, msgs: s.msgs.map((m) => (m.id === a.msgId ? { ...m, answered: a.label } : m)) };
      return {
        ...withMsg(next, `answer|${a.msgId}`, { role: "user", text: a.label }),
        phase: next.phase === "awaiting_approval" ? "verifying" : next.phase,
        pipe: setNode(next.pipe, { approval: "active", planner: "active" }, { approval: `you chose: ${a.label}` }),
      };
    }

    case "send_failed": {
      if (s.phase === "requesting")
        return withMsg({ ...clearMission(s), phase: "idle", turnBusy: false }, `sendfail|${s.msgs.length}`, { role: "system", text: a.reason });
      const next = { ...s, turnBusy: false, pipe: setNode(s.pipe, { planner: "failed" }, { planner: "agent unreachable" }) };
      return withMsg(LIVE_PHASES.includes(s.phase) ? endMission(next, "failed") : next, `sendfail|${s.msgs.length}`, {
        role: "system",
        text: a.reason,
      });
    }

    case "conn": {
      if (a.sessionId !== s.sessionId) return s;
      if (a.conn === "lost") {
        const next = withMsg({ ...s, conn: "lost", turnBusy: false }, `lost|${s.sessionId}|${s.events.length}`, { role: "system", text: "Connection to the agent was lost." });
        return LIVE_PHASES.includes(s.phase) ? endMission(next, "failed") : next;
      }
      return { ...s, conn: a.conn };
    }

    case "event":
      if (a.sessionId !== s.sessionId) return s; // stale stream from a previous session
      return applyEvent(s.conn === "live" ? s : { ...s, conn: "live" }, a.ev);
  }
}

export default function Theater() {
  const [state, dispatch] = useReducer(theaterReducer, INITIAL_STATE);
  const { msgs, pipe, qa, plan, events, phase } = state;
  const mirroring = state.mirror;
  const requesting = phase === "requesting";
  const busy = state.turnBusy || requesting;

  const [draft, setDraft] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [opsNote, setOpsNote] = useState<string | null>(null);
  const [runOn, setRunOn] = useState<"phone" | "page">("phone");
  const [inspTab, setInspTab] = useState<"data" | "events">("data");
  const [view, setView] = useState<"canvas" | "graph">("canvas");
  const [drawer, setDrawer] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settings, setSettings] = useStored<CardSettings>("sc.cardSettings.v1", DEFAULT_SETTINGS);
  const [layout, setLayout] = useStored<{ order: CanvasCardId[]; collapsed: CardId[] }>("sc.layout.v1", { order: DEFAULT_ORDER, collapsed: [] });
  const [maxCard, setMaxCard] = useState<CardId | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [dragId, setDragId] = useState<CanvasCardId | null>(null);
  const dragRef = useRef<CanvasCardId | null>(null);
  const [overId, setOverId] = useState<CanvasCardId | null>(null);
  const [floorPlaying, setFloorPlaying] = useState(false);
  const [floorMode, setFloorMode] = useState<"assembled" | "cutaway" | "stations" | "order">("assembled");
  const floorHostRef = useRef<HTMLDivElement>(null);
  const floorHomeRef = useRef<HTMLDivElement>(null);
  const floorModalRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // I/O handles only (no UI state): the one live stream and the session it belongs to.
  const stream = useRef<{ sessionId: string; ac: AbortController } | null>(null);
  const sessionRef = useRef<string | null>(null);
  sessionRef.current = state.sessionId;

  const timerLive = LIVE_PHASES.includes(phase);
  useEffect(() => {
    if (!timerLive) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [timerLive]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, busy]);

  useEffect(() => () => stream.current?.ac.abort(), []);

  // Drive the 3D mission floor from the pipeline: focus the station of the latest active node, play during a turn.
  const focusKey = (() => {
    const n = pipe.nodes;
    const hot = (id: NodeId) => n[id] === "active" || n[id] === "waiting";
    if (hot("approval") || hot("judge")) return "cashdesk";
    if (hot("negotiators") || hot("sourcing")) return "storefront";
    if (hot("transfer") || hot("scout")) return "admin";
    if (hot("planner")) return "engine";
    if (hot("sentinel")) return "cabinet";
    return null;
  })();
  const follow = settings.FL.follow;
  useEffect(() => {
    try {
      if (follow && pipe.mission) {
        machine()?.setMode("order");
        setFloorMode("order");
      }
    } catch {}
  }, [pipe.mission, follow]);
  useEffect(() => {
    try {
      if (follow && focusKey) machine()?.focusStation(focusKey);
    } catch {}
  }, [focusKey, follow]);
  const floorRun = busy && phase !== "awaiting_approval";
  useEffect(() => {
    if (!follow) return;
    try {
      if (floorRun) machine()?.play();
      else machine()?.pause();
      setFloorPlaying(floorRun);
    } catch {}
  }, [floorRun, follow]);
  // Camera choice from the $FL settings; retried once in case the scene is still loading.
  const camera = settings.FL.camera;
  useEffect(() => {
    const apply = () => {
      try {
        machine()?.setCamera(camera);
      } catch {}
    };
    apply();
    const t = setTimeout(apply, 1500);
    return () => clearTimeout(t);
  }, [camera]);

  /* ------------------------------------------------------------ streaming */
  const stopStream = useCallback(() => {
    stream.current?.ac.abort();
    stream.current = null;
  }, []);

  /** Follows one session's event stream; reconnects from the last index, gives up after 3 failed attempts in a row. */
  const attachStream = useCallback(
    (sessionId: string) => {
      stopStream();
      const ac = new AbortController();
      stream.current = { sessionId, ac };
      (async () => {
        let index = 0;
        let failures = 0;
        const seen = new Set<string>();
        while (!ac.signal.aborted) {
          let got = 0;
          let healthy = false;
          const opened = Date.now();
          try {
            const res = await fetch(`/api/eve/session/${encodeURIComponent(sessionId)}/stream?startIndex=${index}`, { cache: "no-store", signal: ac.signal });
            if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
            healthy = true;
            if (!ac.signal.aborted) dispatch({ type: "conn", sessionId, conn: "live" });
            const reader = res.body.getReader();
            const dec = new TextDecoder();
            let buf = "";
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              buf += dec.decode(value, { stream: true });
              let nl: number;
              while ((nl = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line) continue;
                index += 1;
                got += 1;
                let ev: AnyObj;
                try {
                  ev = JSON.parse(line);
                } catch {
                  continue;
                }
                const eid: string | undefined = ev?.meta?.id;
                if (eid) {
                  if (seen.has(eid)) continue;
                  seen.add(eid);
                }
                if (ac.signal.aborted) return;
                dispatch({ type: "event", sessionId, ev });
              }
            }
          } catch {
            if (ac.signal.aborted) return;
          }
          if (ac.signal.aborted) return;
          // A stream that delivered events, or stayed open a while, closed normally (proxy time limit): reconnect.
          failures = got > 0 || (healthy && Date.now() - opened > 5000) ? 0 : failures + 1;
          if (failures > 3) {
            dispatch({ type: "conn", sessionId, conn: "lost" });
            return;
          }
          dispatch({ type: "conn", sessionId, conn: "reconnecting" });
          await new Promise((r) => setTimeout(r, 600 * failures + 200));
        }
      })();
    },
    [stopStream]
  );

  /* ---------------------------------------------------------------- send */
  /** Sends to the current session, or opens a new one and attaches to it. */
  const post = useCallback(
    async (body: AnyObj): Promise<boolean> => {
      try {
        const sid = sessionRef.current;
        if (!sid) {
          const res = await fetch("/api/eve/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
          const j: AnyObj = await res.json().catch(() => ({}));
          if (!res.ok || !j?.sessionId) throw new Error(j?.error ?? `session ${res.status}`);
          const newSid = String(j.sessionId);
          sessionRef.current = newSid;
          dispatch({ type: "attached", sessionId: newSid, mirror: false });
          attachStream(newSid);
        } else {
          const res = await fetch(`/api/eve/session/${encodeURIComponent(sid)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
          if (!res.ok) throw new Error(`send ${res.status}`);
          if (stream.current?.sessionId !== sid) attachStream(sid);
        }
        return true;
      } catch (err) {
        dispatch({ type: "send_failed", reason: `Could not reach the agent (${(err as Error).message}).` });
        return false;
      }
    },
    [attachStream]
  );

  const sendText = useCallback(
    (text: string) => {
      const t = text.trim();
      if (!t || busy) return;
      // When mirroring, the phone's own messages come back through the stream; don't draw them twice.
      dispatch({ type: "user_sent", text: t, local: !state.mirror });
      post({ message: t });
    },
    [post, busy, state.mirror]
  );

  /** Fire the real sentinel: the alert lands on the planner's Telegram, and this page mirrors that fresh session. */
  const runOnPhone = useCallback(
    async (m: NonNullable<QuickAction["mission"]>) => {
      dispatch({ type: "mission_requested", mode: "phone" });
      try {
        const res = await fetch("/api/ops/sentinel", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ material_id: m.material, site_id: m.site }),
        });
        const j: AnyObj = await res.json().catch(() => ({}));
        if (!res.ok || j?.ok === false || !j?.sessionId) {
          const reason = j?.reason ?? j?.error ?? (res.ok ? "the agent did not open a session" : `HTTP ${res.status}`);
          dispatch({ type: "mission_request_failed", reason: `Sentinel alert not sent: ${reason}.` });
          return;
        }
        const sid = String(j.sessionId);
        sessionRef.current = sid;
        dispatch({ type: "attached", sessionId: sid, mirror: true, note: "Sentinel alert sent to Telegram. Mirroring that session here." });
        attachStream(sid);
      } catch (err) {
        dispatch({ type: "mission_request_failed", reason: `Sentinel alert not sent: ${(err as Error).message}.` });
      }
    },
    [attachStream]
  );

  const runAction = useCallback(
    (a: QuickAction) => {
      if (busy) return;
      if (a.mission && a.alert) {
        stopStream();
        if (runOn === "phone") {
          runOnPhone(a.mission);
          return;
        }
        sessionRef.current = null;
        dispatch({ type: "mission_requested", mode: "page", alert: a.alert });
        post({ message: a.message });
      } else sendText(a.message);
    },
    [busy, post, sendText, runOn, runOnPhone, stopStream]
  );

  const answer = useCallback(
    (msgId: string, requestId: string, opt: InputOption) => {
      dispatch({ type: "answered", msgId, label: opt.label });
      post({ inputResponses: [{ requestId, optionId: opt.id }] });
    },
    [post]
  );

  const resetAll = useCallback(() => {
    stopStream();
    sessionRef.current = null;
    dispatch({ type: "reset" });
  }, [stopStream]);

  const ops = useCallback(
    async (action: "reset") => {
      setOpsNote("Resetting synthetic data…");
      try {
        const res = await fetch(`/api/ops/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        setOpsNote(res.ok ? "Demo data reset." : `Failed (${res.status}).`);
        if (res.ok) resetAll();
      } catch {
        setOpsNote("Failed.");
      }
      setTimeout(() => setOpsNote(null), 4000);
    },
    [resetAll]
  );

  /* ---------------------------------------------------------------- render */
  const elapsed = pipe.startedAt ? Math.max(0, ((pipe.endedAt ?? now) - pipe.startedAt) / 1000) : 0;
  const mm = Math.floor(elapsed / 60);
  const ss = Math.floor(elapsed % 60).toString().padStart(2, "0");
  const pending = [...msgs].reverse().find((m) => m.input?.length && !m.answered) ?? null;
  const missions = ACTIONS.filter((a) => a.mission);
  const asks = ACTIONS.filter((a) => !a.mission);

  /* ------------------------------------------------------ canvas helpers */
  const order: CanvasCardId[] = [
    ...layout.order.filter((id): id is CanvasCardId => DEFAULT_ORDER.includes(id as CanvasCardId)),
    ...DEFAULT_ORDER.filter((id) => !layout.order.includes(id)),
  ];
  const isCollapsed = (id: CardId) => layout.collapsed.includes(id);
  const toggleCollapse = (id: CardId) =>
    setLayout((l) => ({ ...l, collapsed: l.collapsed.includes(id) ? l.collapsed.filter((x) => x !== id) : [...l.collapsed, id] }));
  const moveBy = (id: CanvasCardId, delta: number) =>
    setLayout((l) => {
      const o = [...order];
      const i = o.indexOf(id);
      const j = Math.max(0, Math.min(o.length - 1, i + delta));
      if (i < 0 || i === j) return l;
      o.splice(i, 1);
      o.splice(j, 0, id);
      return { ...l, order: o };
    });
  const moveTo = (from: CanvasCardId, to: CanvasCardId) =>
    setLayout((l) => {
      const o = [...order];
      const i = o.indexOf(from);
      const j = o.indexOf(to);
      if (i < 0 || j < 0) return l;
      o.splice(i, 1);
      o.splice(j, 0, from);
      return { ...l, order: o };
    });
  const showToast = (t: string) => {
    setToast(t);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 1800);
  };
  const setS = <K extends keyof CardSettings>(k: K, patch: Partial<CardSettings[K]>) =>
    setSettings((s) => ({ ...s, [k]: { ...s[k], ...patch } }));

  const cardData = (id: CardId): unknown => {
    switch (id) {
      case "PL":
        return { mission_id: pipe.missionId ?? null, attempt: pipe.attempt, decision: pipe.decision ?? null, nodes: pipe.nodes, notes: pipe.notes, tools: pipe.tools, negotiators: pipe.negotiators };
      case "MO":
        return { material_id: qa?.material_id ?? null, material_name: qa?.material_name ?? null, molecule: qa?.molecule ?? null };
      case "LN":
        return { lines: qa?.lines ?? [], batches: filterBatches(qa?.batches ?? [], settings.LN), batches_total: qa?.batches_total ?? null, batches_at_risk: qa?.batches_at_risk ?? null };
      case "QF":
        return { chosen_supplier_id: qa?.chosen_supplier_id ?? null, suppliers: sortSuppliers(qa?.suppliers ?? [], settings.QF) };
      case "DD":
        return { decision: pipe.decision ?? null, checks: pipe.checks };
      case "PO":
        return { plan, approval: pipe.approval ?? null, plan_line: pipe.planLine ?? null };
      case "FL":
        return { follow_live_stage: settings.FL.follow, camera: settings.FL.camera, focused_station: focusKey, playing: floorPlaying };
    }
  };
  const copyJson = async (id: CardId) => {
    const text = JSON.stringify(cardData(id), null, 2);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    showToast("Copied");
  };
  const downloadJson = (id: CardId) => {
    const blob = new Blob([JSON.stringify(cardData(id), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${CARD_META[id].title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${pipe.missionId ?? "no-mission"}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("Downloaded");
  };
  const cardMenu = (id: CardId): MenuItem[] => {
    const items: MenuItem[] = [
      { label: "Copy data as JSON", onClick: () => copyJson(id) },
      { label: "Download JSON", onClick: () => downloadJson(id) },
      { label: isCollapsed(id) ? "Expand card" : "Collapse card", onClick: () => toggleCollapse(id) },
    ];
    if (id !== "FL" && view === "canvas") {
      const i = order.indexOf(id as CanvasCardId);
      if (i > 0) items.push({ label: "Move up", onClick: () => moveBy(id as CanvasCardId, -1) });
      if (i < order.length - 1) items.push({ label: "Move down", onClick: () => moveBy(id as CanvasCardId, 1) });
    }
    if (CARD_META[id].mission && pipe.missionId)
      items.push({ label: "Open evidence board", onClick: () => {}, href: `https://supplier-chief-of-staff.vercel.app/board?mission_id=${encodeURIComponent(pipe.missionId)}` });
    return items;
  };

  const openCard = (id: CardId) => setMaxCard(id);
  const closeCard = useCallback(() => {
    const host = floorHostRef.current;
    const home = floorHomeRef.current;
    if (host && home && host.parentElement !== home) home.appendChild(host);
    setMaxCard(null);
  }, []);
  // Move the one WebGL scene into the modal and back; never mount a second one.
  useLayoutEffect(() => {
    if (maxCard !== "FL") return;
    const host = floorHostRef.current;
    const slot = floorModalRef.current;
    if (host && slot && host.parentElement !== slot) slot.appendChild(host);
  }, [maxCard]);

  const toggleFloorPlay = () => {
    try {
      if (floorPlaying) machine()?.pause();
      else machine()?.play();
    } catch {}
    setFloorPlaying((p) => !p);
  };

  const floorSettings = (
    <>
      <Toggle label="Auto-follow live stage" on={settings.FL.follow} onChange={(v) => setS("FL", { follow: v })} />
      <Segmented
        label="Camera"
        value={settings.FL.camera}
        options={[
          ["overview", "Overview"],
          ["side", "Side"],
          ["top", "Top"],
        ]}
        onChange={(v) => setS("FL", { camera: v })}
      />
      <div className="px-2 py-1.5">
        <button onClick={toggleFloorPlay} className="flex h-9 w-full items-center justify-center gap-2 rounded-[6px] border border-hair text-[14px] text-ink hover:border-ink" data-floor-play>
          {floorPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          {floorPlaying ? "Pause" : "Play"}
        </button>
      </div>
    </>
  );

  const settingsFor = (id: CanvasCardId): React.ReactNode => {
    switch (id) {
      case "PL":
        return (
          <>
            <Toggle label="Show model labels" on={settings.PL.models} onChange={(v) => setS("PL", { models: v })} />
            <Toggle label="Animate edges" on={settings.PL.animate} onChange={(v) => setS("PL", { animate: v })} />
            <Toggle label="Show tool chips" on={settings.PL.tools} onChange={(v) => setS("PL", { tools: v })} />
          </>
        );
      case "MO":
        return (
          <>
            <Toggle label="Show CAS numbers" on={settings.MO.cas} onChange={(v) => setS("MO", { cas: v })} />
            <Segmented
              label="Image size"
              value={settings.MO.size}
              options={[
                ["S", "S"],
                ["M", "M"],
                ["L", "L"],
              ]}
              onChange={(v) => setS("MO", { size: v })}
            />
          </>
        );
      case "LN":
        return (
          <>
            <Segmented
              label="Horizon"
              value={settings.LN.horizon}
              options={[
                [30, "30 days"],
                [60, "60 days"],
              ]}
              onChange={(v) => setS("LN", { horizon: v })}
            />
            <Toggle label="Only at-risk batches" on={settings.LN.atRiskOnly} onChange={(v) => setS("LN", { atRiskOnly: v })} />
          </>
        );
      case "QF":
        return (
          <>
            <Segmented
              label="Sort by"
              value={settings.QF.sort}
              options={[
                ["rank", "Rank"],
                ["score", "Score"],
                ["name", "Name"],
              ]}
              onChange={(v) => setS("QF", { sort: v })}
            />
            <Toggle label="Only suppliers meeting the line" on={settings.QF.meetsOnly} onChange={(v) => setS("QF", { meetsOnly: v })} />
          </>
        );
      case "DD":
        return (
          <>
            <Toggle label="Show reasons" on={settings.DD.reasons} onChange={(v) => setS("DD", { reasons: v })} />
            <Toggle label="Failed checks first" on={settings.DD.failedFirst} onChange={(v) => setS("DD", { failedFirst: v })} />
          </>
        );
      case "PO":
        return <Toggle label="Show raw plan JSON" on={settings.PO.raw} onChange={(v) => setS("PO", { raw: v })} />;
    }
  };

  const renderBody = (id: CardId, expanded: boolean, tall?: boolean): React.ReactNode => {
    switch (id) {
      case "PL":
        return <PipelineGraph pipe={pipe} opts={settings.PL} fill={expanded} tall={tall} />;
      case "MO":
        return <MoleculeBody qa={qa} mission={pipe.mission} s={settings.MO} expanded={expanded} />;
      case "LN":
        return <LinesBody qa={qa} mission={pipe.mission} s={settings.LN} expanded={expanded} />;
      case "QF":
        return <SuppliersBody qa={qa} mission={pipe.mission} s={settings.QF} expanded={expanded} />;
      case "DD":
        return <DodBody pipe={pipe} s={settings.DD} expanded={expanded} />;
      case "PO":
        return <PlanBody pipe={pipe} plan={plan} pending={pending} onAnswer={answer} s={settings.PO} />;
      case "FL":
        return null;
    }
  };

  const timer = <span className="mr-1 font-mono text-[12px] tabular-nums text-fg2">{pipe.startedAt ? `${mm}:${ss}` : "0:00"}</span>;

  const newSession = () => {
    resetAll();
    showToast("New session");
  };


  const inspector = (
    <Inspector
      pipe={pipe}
      qa={qa}
      events={events}
      tab={inspTab}
      setTab={setInspTab}
      elapsed={pipe.startedAt ? `${mm}:${ss}` : "0:00"}
      mirroring={mirroring}
    />
  );

  return (
    <div className="min-h-screen bg-page text-[14px] text-ink">
      {/* app bar */}
      <div className="relative">
      <header className="sticky top-0 z-30 border-b border-hair bg-surface">
        <div className="flex h-16 items-center gap-3 whitespace-nowrap px-4">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] bg-ink text-[12px] font-medium text-white">SC</div>
          <div className="flex min-w-0 flex-col justify-center">
          <nav className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[15px] leading-tight" aria-label="Breadcrumb">
            <span className="hidden text-muted sm:inline">Corvane Biologics</span>
            <ChevronRight className="hidden h-3.5 w-3.5 text-muted sm:inline" />
            <span className="hidden text-muted md:inline">Supplier Chief of Staff</span>
            <ChevronRight className="hidden h-3.5 w-3.5 text-muted md:inline" />
            <span className="truncate font-medium text-ink">Mission theater</span>
          </nav>
          <div className="mt-0.5 hidden flex-nowrap gap-1 overflow-hidden min-[1100px]:flex">
            {HEADER_TAGS.map((t) => (
              <span key={t} className="shrink-0 whitespace-nowrap rounded-[3px] border border-hair px-1 font-mono text-[11px] uppercase leading-[14px] tracking-[0.05em] text-muted">
                {t}
              </span>
            ))}
          </div>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {opsNote && <span className="hidden text-[13px] text-accent md:inline">{opsNote}</span>}
            <span className="hidden font-mono text-[11px] uppercase tracking-[0.06em] text-muted lg:inline">Run on</span>
            <div className="hidden h-9 items-center rounded-[6px] border border-hair p-0.5 lg:flex" role="group" aria-label="Run missions on">
              {(["phone", "page"] as const).map((o) => (
                <button
                  key={o}
                  onClick={() => setRunOn(o)}
                  aria-pressed={runOn === o}
                  className={`h-full rounded-[4px] px-2.5 text-[13px] ${runOn === o ? "bg-muted-surface text-ink shadow-[inset_0_0_0_1px_#D4D2CF]" : "text-muted hover:text-ink"}`}
                >
                  {o === "phone" ? "My phone" : "This page"}
                </button>
              ))}
            </div>
            <button onClick={() => ops("reset")} className="flex h-9 items-center gap-1.5 rounded-[6px] px-2.5 text-[13px] text-fg2 hover:bg-muted-surface">
              <RotateCcw className="h-3.5 w-3.5" /> Reset demo
            </button>
            <a href={ARCH_URL} target="_blank" rel="noreferrer" className="hidden h-9 items-center gap-1.5 rounded-[6px] px-2.5 text-[13px] text-fg2 hover:bg-muted-surface md:flex">
              <FileText className="h-3.5 w-3.5" /> Architecture PDF
            </a>
            <a href={REPO_URL} target="_blank" rel="noreferrer" className="hidden h-9 items-center gap-1.5 rounded-[6px] px-2.5 text-[13px] text-fg2 hover:bg-muted-surface md:flex">
              <Github className="h-3.5 w-3.5" /> GitHub
            </a>
            <div className="relative">
              <button
                onClick={() => setMenuOpen((o) => !o)}
                disabled={busy}
                className="flex h-9 items-center gap-1.5 rounded-full bg-ink px-3.5 text-[13px] font-medium text-white disabled:opacity-50"
              >
                <Play className="h-3 w-3" /> Run mission <ChevronDown className="h-3.5 w-3.5" />
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-9 z-40 w-[300px] rounded-[8px] border border-hair bg-surface p-1 shadow-[0_12px_32px_-12px_rgba(20,19,17,0.25)]">
                  {missions.map((a) => (
                    <button
                      key={a.key}
                      onClick={() => {
                        setMenuOpen(false);
                        runAction(a);
                      }}
                      className="flex w-full flex-col items-start rounded-[6px] px-3 py-2 text-left hover:bg-muted-surface"
                    >
                      <span className="text-[14px] text-ink">{a.label.replace(/^(Mission|Guardrail): /, "")}</span>
                      <span className="font-mono text-[11px] uppercase tracking-[0.05em] text-muted">
                        {a.ids} · {runOn === "phone" ? "runs on your phone" : "runs on this page"}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* toolbar */}
        <div className="flex min-h-11 items-center gap-2 border-t border-hair px-4 py-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-0.5 gap-y-1">
          <span className="mr-1 hidden font-mono text-[11px] uppercase tracking-[0.06em] text-muted min-[1560px]:inline">Ask</span>
          {asks.map((a) => (
            <ToolButton key={a.key} disabled={busy} onClick={() => runAction(a)} icon={<MessageSquare className="h-3.5 w-3.5" />}>
              {a.label}
            </ToolButton>
          ))}
          <span className="mx-2 h-5 w-px bg-hair" />
          <span className="mr-1 hidden font-mono text-[11px] uppercase tracking-[0.06em] text-muted min-[1560px]:inline">Missions</span>
          {missions.map((a) => (
            <ToolButton key={a.key} disabled={busy} onClick={() => runAction(a)} icon={<FlaskConical className="h-3.5 w-3.5" />} ids={a.mission?.material} title={a.ids}>
              {a.label.replace(/^(Mission|Guardrail): /, "")}
            </ToolButton>
          ))}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={() => setDrawer((o) => !o)}
              className="flex h-9 items-center gap-1.5 rounded-[6px] px-2.5 text-[13px] text-fg2 hover:bg-muted-surface min-[1560px]:hidden"
            >
              <PanelRight className="h-3.5 w-3.5" /> Inspector
            </button>
            {view === "canvas" && (
              <button
                onClick={() => {
                  setLayout({ order: DEFAULT_ORDER, collapsed: [] });
                  showToast("Layout reset");
                }}
                className="flex h-9 items-center gap-1.5 whitespace-nowrap rounded-[6px] px-2.5 text-[14px] text-fg2 hover:bg-muted-surface"
              >
                <RefreshCw className="h-3.5 w-3.5" /> Reset layout
              </button>
            )}
            {(["canvas", "graph"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setView(t)}
                className={`flex h-9 items-center gap-1.5 border-b-2 px-2.5 text-[14px] ${view === t ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink"}`}
              >
                {t === "canvas" ? <LayoutGrid className="h-3.5 w-3.5" /> : <Network className="h-3.5 w-3.5" />}
                {t === "canvas" ? "Canvas" : "Graph"}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* body */}
      <div className="grid grid-cols-1 gap-4 p-4 pb-16 min-[1100px]:grid-cols-[440px_minmax(0,1fr)] min-[1560px]:grid-cols-[440px_minmax(0,1fr)_340px]">
        {/* left: phone + factory */}
        <aside className="flex flex-col items-center gap-4 min-[1100px]:items-stretch">
          <div className="flex justify-center">
            <Phone
              msgs={msgs}
              busy={busy}
              draft={draft}
              setDraft={setDraft}
              onSend={() => {
                if (busy) return;
                sendText(draft);
                setDraft("");
              }}
              onAnswer={answer}
              scrollRef={scrollRef}
            />
          </div>
          <CardShell
            id="FL"
            className="w-full max-w-[440px] overflow-visible"
            collapsed={isCollapsed("FL")}
            onMaximize={() => openCard("FL")}
            settings={floorSettings}
            menu={cardMenu("FL")}
          >
            <div ref={floorHomeRef} className="h-[440px] overflow-hidden rounded-b-[8px] bg-[#141311]">
              <div ref={floorHostRef} className="h-full w-full">
                <AgenticFactory3D height="100%" embed />
              </div>
            </div>
          </CardShell>
        </aside>

        {/* center canvas */}
        <main className="@container min-w-0">
          {view === "graph" ? (
            <CardShell id="PL" onMaximize={() => openCard("PL")} settings={settingsFor("PL")} menu={cardMenu("PL")} right={timer}>
              {renderBody("PL", false, true)}
            </CardShell>
          ) : (
            <div className="grid grid-cols-1 gap-4 @[880px]:grid-cols-2" data-canvas-order={order.join(",")}>
              {order.map((id) => (
                <CardShell
                  key={id}
                  id={id}
                  className={CARD_META[id].wide ? "@[880px]:col-span-2" : ""}
                  collapsed={isCollapsed(id)}
                  onMaximize={() => openCard(id)}
                  settings={settingsFor(id)}
                  menu={cardMenu(id)}
                  right={id === "PL" ? timer : undefined}
                  drag={{
                    over: overId === id && dragId !== id,
                    onDragStart: (e) => {
                      dragRef.current = id;
                      setDragId(id);
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", id);
                    },
                    onDragOver: (e) => {
                      if (!dragRef.current) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      if (overId !== id) setOverId(id);
                    },
                    onDrop: (e) => {
                      e.preventDefault();
                      const from = (dragRef.current || e.dataTransfer.getData("text/plain")) as CanvasCardId | null;
                      dragRef.current = null;
                      if (from && from !== id) moveTo(from, id);
                      setDragId(null);
                      setOverId(null);
                    },
                    onDragEnd: () => {
                      dragRef.current = null;
                      setDragId(null);
                      setOverId(null);
                    },
                  }}
                >
                  {renderBody(id, false)}
                </CardShell>
              ))}
            </div>
          )}
        </main>

        {/* right inspector (wide screens) */}
        <aside className="hidden min-[1560px]:block">
          <div className="sticky top-[132px]">{inspector}</div>
        </aside>
      </div>

      {/* drawer inspector (narrower screens) */}
      {drawer && (
        <div className="fixed inset-y-0 right-0 z-40 w-[360px] max-w-full overflow-y-auto border-l border-hair bg-page p-3 shadow-[-12px_0_32px_-16px_rgba(20,19,17,0.3)] min-[1560px]:hidden">
          <button onClick={() => setDrawer(false)} className="mb-2 flex h-9 items-center gap-1.5 rounded-[6px] px-2 text-[13px] text-fg2 hover:bg-muted-surface">
            <X className="h-3.5 w-3.5" /> Close
          </button>
          {inspector}
        </div>
      )}

      {maxCard && (
        <CardModal id={maxCard} onClose={closeCard} right={maxCard === "PL" ? timer : undefined}>
          {maxCard === "FL" ? (
            <div className="flex h-full flex-col">
              <div className="flex flex-wrap items-end gap-3 border-b border-hair px-3 py-2" data-floor-controls>
                <div className="w-[340px]">
                  <Segmented
                    label="Mode"
                    value={floorMode}
                    options={[
                      ["assembled", "Assembled"],
                      ["cutaway", "Cutaway"],
                      ["stations", "Stations"],
                      ["order", "Order"],
                    ]}
                    onChange={(v) => {
                      try {
                        machine()?.setMode(v);
                      } catch {}
                      setFloorMode(v);
                    }}
                  />
                </div>
                <div className="w-[280px]">
                  <Segmented
                    label="Camera"
                    value={settings.FL.camera}
                    options={[
                      ["overview", "Overview"],
                      ["side", "Side"],
                      ["top", "Top"],
                    ]}
                    onChange={(v) => setS("FL", { camera: v })}
                  />
                </div>
                <div className="w-[240px]">
                  <Toggle label="Auto-follow live stage" on={settings.FL.follow} onChange={(v) => setS("FL", { follow: v })} />
                </div>
                <div className="py-1.5">
                  <button onClick={toggleFloorPlay} className="flex h-9 items-center gap-2 rounded-[6px] border border-hair px-3 text-[14px] text-ink hover:border-ink" data-floor-play>
                    {floorPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                    {floorPlaying ? "Pause" : "Play"}
                  </button>
                </div>
              </div>
              <div ref={floorModalRef} className="min-h-0 flex-1 bg-[#141311]" data-floor-slot />
            </div>
          ) : (
            <div className="h-full">{renderBody(maxCard, true)}</div>
          )}
        </CardModal>
      )}

      {toast && (
        <div role="status" className="fixed bottom-14 left-1/2 z-[60] -translate-x-1/2 rounded-full bg-ink px-4 py-2 text-[14px] text-white shadow-lg" data-toast>
          {toast}
        </div>
      )}

      {/* bottom tab bar */}
      <div className="sticky bottom-0 z-20 flex h-10 items-center gap-3 border-t border-hair bg-surface px-4 text-[14px]">
        <button onClick={newSession} aria-label="New chat session" title="New chat session" className="flex h-8 items-center gap-1.5 rounded-[6px] px-2 text-[13px] text-fg2 hover:bg-muted-surface hover:text-ink">
          <Plus className="h-4 w-4" /> New session
        </button>
        <span className="flex h-full items-center border-t-2 border-accent px-2 text-ink">{view === "canvas" ? "Canvas" : "Graph"}</span>
        <span className="text-muted">·</span>
        <span className="font-mono text-[12px] text-fg2">{pipe.missionId ? `Mission ${pipe.missionId}` : "No mission"}</span>
        <span className="text-muted">·</span>
        <span className="flex items-center gap-1.5" style={{ color: state.conn === "lost" ? "#DC2626" : busy || timerLive ? "#F25C05" : "#908E87" }} data-phase={phase}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: state.conn === "lost" ? "#DC2626" : busy || timerLive ? "#F25C05" : "#D4D2CF" }} />
          {state.conn === "lost" ? "Connection lost" : PHASE_LABEL[phase]}
          {state.conn === "reconnecting" && <span className="text-muted"> · reconnecting</span>}
        </span>
        {mirroring && <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-accent">Mirroring Telegram session</span>}
        <span className="ml-auto hidden font-mono text-[11px] uppercase tracking-[0.06em] text-muted sm:inline">Synthetic data · Corvane Biologics is fictional</span>
      </div>
      </div>

      <FooterWithSuite
        brandName="Supplier Chief"
        tagline="Texts you before a material runs out — and fixes it with a team of agents."
        navLinks={[
          { text: "Mission theater", url: "#" },
          { text: "Architecture PDF", url: ARCH_URL },
          { text: "Evals", url: "https://github.com/paritoshk/supply_chain_recursive_agent/blob/main/docs/evals/RESULTS.md" },
          { text: "Repo", url: REPO_URL },
          { text: "Evidence board", url: "https://supplier-chief-of-staff.vercel.app/board" },
        ]}
        socialLinks={[
          { text: "Telegram @supplychief_bot", url: "https://t.me/supplychief_bot" },
          { text: "GitHub", url: REPO_URL },
        ]}
        description="A recursive agent team on Crusoe Managed Inference for specialty-pharma supply. Fictional company, synthetic data."
        ctaText="Text the bot"
        ctaUrl="https://t.me/supplychief_bot"
        email=""
        copyright="© 2026 Supplier Chief of Staff · Built at the Crusoe Recursive Agents Hackathon"
        className="border-t border-hair"
      />
    </div>
  );
}

/* ------------------------------------------------------------- workbench */

const ARCH_URL = "https://github.com/paritoshk/supply_chain_recursive_agent/blob/main/docs/architecture.pdf";
const REPO_URL = "https://github.com/paritoshk/supply_chain_recursive_agent";

function ToolButton(props: { children: React.ReactNode; onClick: () => void; disabled?: boolean; icon?: React.ReactNode; ids?: string; title?: string }) {
  return (
    <button
      title={props.title}
      onClick={props.onClick}
      disabled={props.disabled}
      className="flex h-9 items-center gap-1.5 whitespace-nowrap rounded-[6px] px-2.5 text-[14px] text-ink hover:bg-muted-surface disabled:cursor-not-allowed disabled:opacity-45"
    >
      <span className="text-fg3">{props.icon}</span>
      <span>{props.children}</span>
      {props.ids && <span className="font-mono text-[11px] uppercase tracking-[0.04em] text-muted">{props.ids}</span>}
    </button>
  );
}

function IdChip({ id }: { id: string }) {
  return <span className="rounded-[4px] border border-hair bg-muted-surface px-1.5 py-[1px] font-mono text-[12px] text-fg2">{id}</span>;
}

/* ------------------------------------------------------- card settings */

type CardId = "PL" | "MO" | "PO" | "LN" | "DD" | "QF" | "FL";
type CanvasCardId = Exclude<CardId, "FL">;

const CARD_META: Record<CardId, { title: string; type: string; wide?: boolean; mission?: boolean }> = {
  PL: { title: "Agent pipeline", type: "Live graph", wide: true, mission: true },
  MO: { title: "Molecule", type: "PubChem", mission: true },
  PO: { title: "Plan & approval", type: "Decision", mission: true },
  LN: { title: "Production lines & batches", type: "Feasibility", mission: true },
  DD: { title: "Definition of done", type: "Judge", mission: true },
  QF: { title: "Supplier quality ranking", type: "Grade fit", wide: true, mission: true },
  FL: { title: "Mission floor", type: "3D · live" },
};

const DEFAULT_ORDER: CanvasCardId[] = ["PL", "MO", "PO", "LN", "DD", "QF"];

type CardSettings = {
  PL: { models: boolean; animate: boolean; tools: boolean };
  MO: { cas: boolean; size: "S" | "M" | "L" };
  LN: { horizon: 30 | 60; atRiskOnly: boolean };
  QF: { sort: "score" | "rank" | "name"; meetsOnly: boolean };
  DD: { reasons: boolean; failedFirst: boolean };
  PO: { raw: boolean };
  FL: { follow: boolean; camera: "overview" | "side" | "top" };
};

const DEFAULT_SETTINGS: CardSettings = {
  PL: { models: true, animate: true, tools: true },
  MO: { cas: true, size: "M" },
  LN: { horizon: 60, atRiskOnly: false },
  QF: { sort: "rank", meetsOnly: false },
  DD: { reasons: true, failedFirst: false },
  PO: { raw: false },
  FL: { follow: true, camera: "overview" },
};

/** useState backed by localStorage (read after mount so SSR markup stays stable). */
function useStored<T>(key: string, initial: T): [T, (next: T | ((p: T) => T)) => void] {
  const [val, setVal] = useState<T>(initial);
  const loaded = useRef(false);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw) setVal((p) => ({ ...(p as object), ...JSON.parse(raw) }) as T);
    } catch {}
    loaded.current = true;
  }, [key]);
  useEffect(() => {
    if (!loaded.current) return;
    try {
      window.localStorage.setItem(key, JSON.stringify(val));
    } catch {}
  }, [key, val]);
  return [val, setVal];
}

/** Closes a popover on outside click or Esc. */
function useDismiss(open: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close, ref]);
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex h-9 cursor-pointer items-center justify-between gap-3 rounded-[6px] px-2 text-[14px] text-ink hover:bg-muted-surface">
      <span>{label}</span>
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-[#F25C05]" />
    </label>
  );
}

function Segmented<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="px-2 py-1.5">
      <div className="label-mono mb-1">{label}</div>
      <div className="flex h-9 overflow-hidden rounded-[6px] border border-hair" role="group" aria-label={label}>
        {options.map(([v, l], i) => (
          <button
            key={String(v)}
            onClick={() => onChange(v)}
            aria-pressed={value === v}
            className={`flex-1 text-[13px] ${i ? "border-l border-hair" : ""} ${value === v ? "bg-muted-surface text-ink" : "text-muted hover:text-ink"}`}
          >
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}

type MenuItem = { label: string; onClick: () => void; href?: string };

function HeaderIconButton(props: { label: string; onClick: () => void; children: React.ReactNode; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className={`flex h-8 w-8 items-center justify-center rounded-[6px] hover:bg-muted-surface hover:text-ink ${props.active ? "bg-muted-surface text-ink" : "text-muted"}`}
    >
      {props.children}
    </button>
  );
}

function CardShell(props: {
  id: CardId;
  right?: React.ReactNode;
  collapsed?: boolean;
  onMaximize: () => void;
  settings: React.ReactNode;
  menu: MenuItem[];
  drag?: {
    onDragStart: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
    onDragEnd: () => void;
    over: boolean;
  };
  className?: string;
  children: React.ReactNode;
}) {
  const meta = CARD_META[props.id];
  const [pop, setPop] = useState<"settings" | "menu" | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setPop(null), []);
  useDismiss(pop !== null, close, popRef);
  return (
    <section
      className={`flex min-w-0 flex-col rounded-[8px] border bg-surface ${props.drag?.over ? "border-accent" : "border-hair"} ${props.className ?? ""}`}
      data-card={props.id}
      onDragOver={props.drag?.onDragOver}
      onDrop={props.drag?.onDrop}
    >
      <div
        className="relative flex h-12 shrink-0 select-none items-center gap-2.5 border-b border-hair px-3"
        onDoubleClick={props.onMaximize}
        data-card-head={props.id}
      >
        {props.drag && (
          <span
            draggable
            onDragStart={props.drag.onDragStart}
            onDragEnd={props.drag.onDragEnd}
            className="flex h-8 w-5 shrink-0 cursor-grab items-center justify-center text-muted hover:text-ink active:cursor-grabbing"
            aria-label={`Drag to reorder ${meta.title}`}
            title="Drag to reorder"
            data-drag-handle={props.id}
          >
            <GripVertical className="h-4 w-4" />
          </span>
        )}
        <IdChip id={`$${props.id}`} />
        <span className="truncate font-display text-[17px] font-normal text-ink">{meta.title}</span>
        <span className="hidden shrink-0 rounded-[4px] border border-hair px-1.5 py-[1px] font-mono text-[11px] uppercase tracking-[0.04em] text-muted sm:inline">
          {meta.type}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-0.5" ref={popRef}>
          {props.right}
          <HeaderIconButton label={`Enlarge ${meta.title}`} onClick={props.onMaximize}>
            <Maximize2 className="h-4 w-4" />
          </HeaderIconButton>
          <HeaderIconButton label={`${meta.title} settings`} onClick={() => setPop((p) => (p === "settings" ? null : "settings"))} active={pop === "settings"}>
            <Settings className="h-4 w-4" />
          </HeaderIconButton>
          <HeaderIconButton label={`More actions for ${meta.title}`} onClick={() => setPop((p) => (p === "menu" ? null : "menu"))} active={pop === "menu"}>
            <MoreHorizontal className="h-4 w-4" />
          </HeaderIconButton>
          {pop === "settings" && (
            <div
              role="dialog"
              aria-label={`${meta.title} settings`}
              className="absolute right-2 top-11 z-30 w-[260px] rounded-[8px] border border-hair bg-surface p-1.5 shadow-[0_12px_32px_-12px_rgba(20,19,17,0.3)]"
              data-popover="settings"
            >
              <div className="label-mono px-2 pb-1 pt-1">{meta.title} · settings</div>
              {props.settings}
            </div>
          )}
          {pop === "menu" && (
            <div role="menu" className="absolute right-2 top-11 z-30 w-[230px] rounded-[8px] border border-hair bg-surface p-1.5 shadow-[0_12px_32px_-12px_rgba(20,19,17,0.3)]" data-popover="menu">
              {props.menu.map((m) =>
                m.href ? (
                  <a
                    key={m.label}
                    role="menuitem"
                    href={m.href}
                    target="_blank"
                    rel="noreferrer"
                    onClick={close}
                    className="flex h-9 items-center rounded-[6px] px-2 text-[14px] text-ink hover:bg-muted-surface"
                  >
                    {m.label}
                  </a>
                ) : (
                  <button
                    key={m.label}
                    role="menuitem"
                    onClick={() => {
                      close();
                      m.onClick();
                    }}
                    className="flex h-9 w-full items-center rounded-[6px] px-2 text-left text-[14px] text-ink hover:bg-muted-surface"
                  >
                    {m.label}
                  </button>
                )
              )}
            </div>
          )}
        </div>
      </div>
      {!props.collapsed && <div className="min-w-0 flex-1">{props.children}</div>}
    </section>
  );
}

/** In-page modal: dimmed backdrop, focus trap, Esc and backdrop close, body scroll lock. */
function CardModal({ id, onClose, right, children }: { id: CardId; onClose: () => void; right?: React.ReactNode; children: React.ReactNode }) {
  const meta = CARD_META[id];
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const opener = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLElement>("[data-modal-close]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const f = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])')
      ).filter((el) => el.offsetParent !== null);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      opener?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()} data-modal={id}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={meta.title}
        className="modal-panel flex flex-col overflow-hidden rounded-[8px] border border-hair bg-surface shadow-[0_32px_80px_-24px_rgba(20,19,17,0.5)]"
        style={{ width: "min(1280px, 92vw)", height: "min(860px, 88vh)" }}
      >
        <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-hair px-4">
          <IdChip id={`$${id}`} />
          <span className="truncate font-display text-[18px] font-normal text-ink">{meta.title}</span>
          <span className="shrink-0 rounded-[4px] border border-hair px-1.5 py-[1px] font-mono text-[11px] uppercase tracking-[0.04em] text-muted">{meta.type}</span>
          <div className="ml-auto flex items-center gap-2">
            {right}
            <button data-modal-close onClick={onClose} aria-label="Close" className="flex h-9 w-9 items-center justify-center rounded-[6px] text-fg2 hover:bg-muted-surface hover:text-ink">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </div>
    </div>
  );
}

function Empty({ mission, text }: { mission: boolean; text?: string }) {
  return (
    <div className="flex h-full min-h-[120px] items-center justify-center px-4 py-6 text-center text-[13px] text-muted">
      {mission ? text ?? "Gathering data for this mission…" : "Waiting for a mission…"}
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted">{k}</dt>
      <dd className="min-w-0 truncate text-ink">{v}</dd>
    </>
  );
}

const IMG_SIZE = { S: 140, M: 220, L: 300 } as const;

function MoleculeBody({ qa, mission, s, expanded }: { qa: QaFit | null; mission: boolean; s: CardSettings["MO"]; expanded?: boolean }) {
  const mol = qa?.molecule;
  if (!mol) return <Empty mission={mission} text="Looking the molecule up on PubChem…" />;
  const px = expanded ? 420 : IMG_SIZE[s.size];
  return (
    <div className="flex flex-wrap gap-5 p-5" data-mo-size={s.size}>
      <div className="flex shrink-0 items-center justify-center rounded-[8px] border border-hair bg-white" style={{ width: px, height: px }}>
        {mol.structure_image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={mol.structure_image_url} alt={`PubChem structure${mol.cid ? `, CID ${mol.cid}` : ""}`} className="object-contain" style={{ maxWidth: px - 12, maxHeight: px - 12 }} />
        ) : (
          <span className="px-3 text-center text-[12px] text-muted">No single structure (mixture or biologic)</span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        {qa?.material_name && <div className={expanded ? "font-display text-[22px] font-light text-ink" : "text-[14px] text-ink"}>{qa.material_name}</div>}
        <dl className="mt-1 grid grid-cols-[96px_1fr] gap-x-3 gap-y-1.5 text-[14px]">
          {expanded && <Row k="Material" v={qa?.material_id ?? "—"} />}
          {expanded && <Row k="Site" v={qa?.site_name ? `${qa.site_name} · ${qa.site_id}` : qa?.site_id ?? "—"} />}
          <Row k="CID" v={mol.cid ?? "—"} />
          <Row k="Formula" v={mol.molecular_formula ?? "—"} />
          <Row k="MW" v={mol.molecular_weight != null ? `${mol.molecular_weight} g/mol` : "—"} />
          {s.cas && <Row k="CAS" v={mol.cas?.length ? (expanded ? mol.cas.join(", ") : mol.cas.slice(0, 2).join(", ")) : "—"} />}
          <Row k="PubChem" v={mol.pubchem_status ?? "—"} />
          {expanded && mol.cid != null && (
            <Row
              k="Source"
              v={
                <a className="text-ink underline decoration-hair-strong underline-offset-2 hover:text-accent" href={`https://pubchem.ncbi.nlm.nih.gov/compound/${mol.cid}`} target="_blank" rel="noreferrer">
                  pubchem.ncbi.nlm.nih.gov/compound/{mol.cid}
                </a>
              }
            />
          )}
        </dl>
        {mol.explanation && <p className={`mt-2 text-[13px] leading-snug text-fg2 ${expanded ? "" : "line-clamp-4"}`}>{mol.explanation}</p>}
      </div>
    </div>
  );
}

function filterBatches(batches: Batch[], s: CardSettings["LN"]): Batch[] {
  if (!batches.length) return batches;
  const ref = Math.min(...batches.map((b) => Date.parse(b.start_date)).filter((n) => !Number.isNaN(n)));
  const limit = ref + s.horizon * 86_400_000;
  return batches.filter((b) => {
    const t = Date.parse(b.start_date);
    return (Number.isNaN(t) || t <= limit) && (!s.atRiskOnly || !b.feasible);
  });
}

function LinesBody({ qa, mission, s, expanded }: { qa: QaFit | null; mission: boolean; s: CardSettings["LN"]; expanded?: boolean }) {
  const lines = qa?.lines ?? [];
  const batches = filterBatches(qa?.batches ?? [], s);
  if (!lines.length && !(qa?.batches ?? []).length) return <Empty mission={mission} text="Waiting for the judge to recompute line feasibility…" />;
  return (
    <div className="flex flex-col gap-4 p-5">
      <div className={expanded ? "grid grid-cols-2 gap-3" : "flex flex-col gap-3"}>
        {lines.slice(0, expanded ? lines.length : 2).map((l) => (
          <div key={l.line_id} className="rounded-[6px] border border-hair p-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[14px] text-ink">{l.line_name ?? l.line_id}</span>
              <span className="font-mono text-[11px] uppercase tracking-[0.05em] text-muted">{l.line_id}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              {l.line_type && <Tag>{l.line_type}</Tag>}
              {l.cleanroom_grade && <Tag>cleanroom {l.cleanroom_grade}</Tag>}
              {l.needs_parenteral && <Tag>parenteral</Tag>}
              {l.needs_low_endotoxin && <Tag>low endotoxin</Tag>}
              {(l.needs_compendia ?? []).map((c) => (
                <Tag key={c}>{c}</Tag>
              ))}
            </div>
            {l.rationale && <p className="mt-1.5 text-[13px] leading-snug text-fg2">{l.rationale}</p>}
          </div>
        ))}
      </div>
      <div>
        <div className="flex items-center gap-3">
          <span className="label-mono" data-ln-horizon={s.horizon}>
            Batches · next {s.horizon} days{s.atRiskOnly ? " · at risk only" : ""}
          </span>
          {qa?.batches_total != null && (
            <span className="text-[13px] text-fg2">
              {qa.batches_total} planned · <span style={{ color: (qa.batches_at_risk ?? 0) > 0 ? "#DC2626" : "#16A34A" }}>{qa.batches_at_risk ?? 0} at risk</span>
            </span>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1" data-testid="batch-strip">
          {batches.length === 0 && <span className="text-[13px] text-muted">No batches in this view</span>}
          {batches.map((b) => (
            <span
              key={b.batch_no}
              title={`${b.batch_no} · ${b.start_date}${b.line_name ? ` · ${b.line_name}` : ""}${b.material_needed != null ? ` · needs ${b.material_needed}, available ${b.available_at_start ?? "?"}` : ""}`}
              className="h-[18px] w-[18px] rounded-[4px] border"
              style={{ borderColor: b.feasible ? "#16A34A" : "#DC2626", background: b.feasible ? "rgba(22,163,74,0.12)" : "rgba(220,38,38,0.12)" }}
            />
          ))}
        </div>
      </div>
      {expanded && batches.length > 0 && (
        <table className="w-full border-collapse text-[14px]">
          <thead>
            <tr className="text-left text-muted">
              {["Batch", "Line", "Product", "Start", "Needed", "Available at start", "Feasible"].map((h) => (
                <th key={h} className="py-2 font-normal">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {batches.map((b) => (
              <tr key={b.batch_no} className="border-t border-hair">
                <td className="py-2 font-mono text-[13px]">{b.batch_no}</td>
                <td className="py-2">{b.line_name ?? b.line_id ?? "—"}</td>
                <td className="py-2 text-fg2">{b.product_id ?? "—"}</td>
                <td className="py-2 tabular-nums">{b.start_date}</td>
                <td className="py-2 tabular-nums">{b.material_needed ?? "—"}</td>
                <td className="py-2 tabular-nums">{b.available_at_start ?? "—"}</td>
                <td className="py-2" style={{ color: b.feasible ? "#16A34A" : "#DC2626" }}>
                  {b.feasible ? "✓ feasible" : "✗ at risk"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function sortSuppliers(list: SupplierFit[], s: CardSettings["QF"]): SupplierFit[] {
  const out = list.filter((x) => !s.meetsOnly || x.meets_requirement);
  if (s.sort === "score") out.sort((a, b) => b.quality_score - a.quality_score);
  else if (s.sort === "name") out.sort((a, b) => (a.supplier_name ?? a.supplier_id).localeCompare(b.supplier_name ?? b.supplier_id));
  else out.sort((a, b) => a.rank - b.rank);
  return out;
}

function SuppliersBody({ qa, mission, s, expanded }: { qa: QaFit | null; mission: boolean; s: CardSettings["QF"]; expanded?: boolean }) {
  const all = qa?.suppliers ?? [];
  const suppliers = sortSuppliers(all, s);
  if (!all.length) return <Empty mission={mission} text="Ranked once the judge recomputes the checks…" />;
  return (
    <div className="overflow-x-auto px-5 pb-3">
      <table className="w-full border-collapse text-[14px]" data-qf-sort={s.sort}>
        <thead>
          <tr className="text-left text-muted">
            <th className="w-8 py-2 pl-2 font-normal">#</th>
            <th className="py-2 font-normal">Supplier</th>
            {expanded && <th className="py-2 font-normal">ID</th>}
            <th className="py-2 font-normal">Approved grade</th>
            <th className="py-2 font-normal">Meets line requirement</th>
            <th className="w-[150px] py-2 font-normal">Quality score</th>
          </tr>
        </thead>
        <tbody>
          {suppliers.length === 0 && (
            <tr>
              <td colSpan={6} className="border-t border-hair py-3 text-muted">
                No supplier meets the line requirement.
              </td>
            </tr>
          )}
          {suppliers.map((sp) => {
            const chosen = sp.supplier_id === qa?.chosen_supplier_id;
            return (
              <tr key={sp.supplier_id} className="border-t border-hair" style={chosen ? { boxShadow: "inset 3px 0 0 #F25C05" } : undefined} data-supplier={sp.supplier_id}>
                <td className="py-2 pl-2 font-mono text-fg2">{sp.rank}</td>
                <td className="py-2 text-ink">
                  {sp.supplier_name ?? sp.supplier_id}
                  {chosen && (
                    <span className="ml-2 rounded-full border px-1.5 font-mono text-[11px] uppercase tracking-[0.06em]" style={{ borderColor: "#F25C05", color: "#F25C05" }}>
                      chosen
                    </span>
                  )}
                </td>
                {expanded && <td className="py-2 font-mono text-[13px] text-fg2">{sp.supplier_id}</td>}
                <td className="py-2 text-fg2">{sp.approved_grade ?? "—"}</td>
                <td className="py-2" style={{ color: sp.meets_requirement ? "#16A34A" : "#DC2626" }}>
                  {sp.meets_requirement ? "✓ meets" : `✗ ${(sp.gaps ?? []).join(", ") || "gap"}`}
                </td>
                <td className="py-2">
                  <div className="flex items-center gap-2">
                    <div className="h-2 w-[110px] rounded-full bg-[#EAE8E5]">
                      <div className="h-2 rounded-full" style={{ width: `${Math.max(0, Math.min(100, sp.quality_score))}%`, background: chosen ? "#F25C05" : "#908E87" }} />
                    </div>
                    <span className="font-mono text-[12px] text-fg2">{sp.quality_score}</span>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DodBody({ pipe, s, expanded }: { pipe: Pipeline; s: CardSettings["DD"]; expanded?: boolean }) {
  const base = pipe.checks.length ? pipe.checks : DEFAULT_CHECKS.map((id) => ({ id }) as Check);
  const checks = s.failedFirst ? [...base].sort((a, b) => Number(a.pass !== false) - Number(b.pass !== false)) : base;
  return (
    <ul className="divide-y divide-hair px-5 py-2" data-dd-reasons={s.reasons ? "on" : "off"}>
      {checks.map((c) => (
        <li key={c.id} className="flex items-start gap-2 py-2" data-check={c.id}>
          <span className="mt-[1px] w-3 font-mono text-[13px]" style={{ color: c.pass === true ? "#16A34A" : c.pass === false ? "#DC2626" : "#908E87" }}>
            {c.pass === true ? "✓" : c.pass === false ? "✗" : "○"}
          </span>
          <span className="w-[150px] shrink-0 font-mono text-[12px] text-ink">{c.id}</span>
          {s.reasons && (
            <span className={`min-w-0 flex-1 text-[13px] text-fg2 ${expanded ? "whitespace-normal" : "truncate"}`} title={c.reason}>
              {c.reason ?? (c.pass == null ? (pipe.mission ? "pending" : "—") : c.pass ? "pass" : "fail")}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function PlanBody(props: {
  pipe: Pipeline;
  plan: AnyObj | null;
  pending: ChatMsg | null;
  onAnswer: (msgId: string, requestId: string, opt: InputOption) => void;
  s: CardSettings["PO"];
}) {
  const { pipe, plan, pending, onAnswer, s } = props;
  const t = plan?.transfer;
  const p = plan?.purchase;
  if (!pipe.mission && !plan && !pending) return <Empty mission={false} />;
  const ap = pipe.nodes.approval;
  return (
    <div className="flex flex-col gap-3 p-5">
      <dl className="grid grid-cols-[90px_1fr] gap-x-3 gap-y-1.5 text-[14px]">
        <Row k="Transfer" v={t?.qty ? `${t.qty} kg from ${t.from_site_id}${t.arrives_in_days != null ? ` · ${t.arrives_in_days} d` : ""}` : plan ? "none" : "—"} />
        <Row k="Purchase" v={p?.qty ? `${p.qty} kg · ${p.supplier_name}` : plan ? "none" : "—"} />
        <Row k="Landed" v={p?.landed_unit_usd != null ? `${fmtUsd(p.landed_unit_usd)}/kg · ${p.lead_time_days ?? "?"} d lead` : "—"} />
        <Row k="RFQ" v={p?.rfq_id ?? "—"} />
        <Row k="Value" v={<span className="font-display text-[24px] font-light tabular-nums leading-tight">{fmtUsd(p?.value_usd) ?? "—"}</span>} />
        <Row k="Approval" v={<span style={{ color: STATUS_COLOR[ap] }}>{pipe.approval ?? (pipe.mission ? "waiting for the judge" : "—")}</span>} />
      </dl>
      {!plan && pipe.planLine && <p className="text-[13px] text-fg2">{pipe.planLine}</p>}
      {pending?.input?.map((req) => (
        <div key={req.requestId} className="mt-1 flex flex-wrap gap-2 border-t border-hair pt-2">
          {req.options.map((o, i) => (
            <button
              key={o.id}
              onClick={() => onAnswer(pending.id, req.requestId, o)}
              className={`h-9 rounded-full px-3.5 text-[13px] ${i === 0 ? "bg-ink text-white" : "border border-hair text-ink hover:border-ink"}`}
            >
              {o.label}
            </button>
          ))}
        </div>
      ))}
      {s.raw && (
        <pre className="max-h-[320px] overflow-auto rounded-[6px] border border-hair bg-muted-surface p-3 font-mono text-[12px] leading-snug text-fg2" data-po-raw>
          {plan ? JSON.stringify(plan, null, 2) : "No plan yet."}
        </pre>
      )}
    </div>
  );
}

type EventRow = { at: number; type: string; text: string };

const MODELS: [string, string][] = [
  ["Doers", "Nemotron 3.5 Super VL"],
  ["Judge", "code + Nemotron 3 Super 120B"],
  ["Suppliers", "Nemotron 3 Nano"],
  ["Inference", "Crusoe Managed Inference"],
];

function Inspector(props: {
  pipe: Pipeline;
  qa: QaFit | null;
  events: EventRow[];
  tab: "data" | "events";
  setTab: (t: "data" | "events") => void;
  elapsed: string;
  mirroring: boolean;
}) {
  const { pipe, qa, events, tab, setTab, elapsed } = props;
  const deps: [string, NodeId, string?][] = [
    ["Sentinel", "sentinel"],
    ["Planner", "planner"],
    ["Transfer", "transfer", "Planner →"],
    ["Sourcing", "sourcing", "Planner →"],
    [`Negotiator${pipe.negotiators ? ` ×${pipe.negotiators}` : "s"}`, "negotiators", "Sourcing →"],
    ["Scout", "scout", "Planner →"],
    ["Judge", "judge"],
    ["Approval / PO", "approval"],
  ];
  return (
    <div className="flex flex-col overflow-hidden rounded-[8px] border border-hair bg-surface">
      <div className="flex h-10 items-center gap-2 border-b border-hair px-3">
        <span className="font-mono text-[12px] uppercase tracking-[0.06em] text-fg2">Mission inspector</span>
        {props.mirroring && <span className="ml-auto font-mono text-[11px] uppercase tracking-[0.05em] text-accent">Telegram</span>}
      </div>
      <div className="flex gap-4 border-b border-hair px-3">
        {(["data", "events"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`h-9 border-b-2 text-[14px] ${tab === t ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink"}`}
          >
            {t === "data" ? "Data" : `Events${events.length ? ` (${events.length})` : ""}`}
          </button>
        ))}
      </div>

      {tab === "data" ? (
        <div className="flex flex-col gap-4 p-5">
          <div className="grid grid-cols-3 overflow-hidden rounded-[8px] border border-hair">
            {[
              ["Need", pipe.needQty != null ? `${pipe.needQty}` : "—", pipe.needQty != null ? "kg" : ""],
              ["Attempt", pipe.attempt ? String(pipe.attempt) : "—", ""],
              ["Elapsed", elapsed, ""],
            ].map(([k, v, u], i) => (
              <div key={k} className={`px-3 py-2.5 ${i ? "border-l border-hair" : ""}`}>
                <div className="label-mono">{k}</div>
                <div className="mt-0.5 font-display text-[24px] font-light tabular-nums leading-tight text-ink">
                  {v}
                  {u && <span className="ml-1 text-[13px] text-muted">{u}</span>}
                </div>
              </div>
            ))}
          </div>
          <div>
            <div className="label-mono mb-1">Mission</div>
            <dl className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-1.5 text-[14px]">
              <Row k="Mission" v={<span className="font-mono text-[12px]">{pipe.missionId ?? "—"}</span>} />
              <Row k="Material" v={qa?.material_id ? `${qa.material_id}` : "—"} />
              <Row k="Site" v={qa?.site_name ? `${qa.site_name} · ${qa.site_id}` : qa?.site_id ?? "—"} />
              <Row k="Need" v={pipe.needQty != null ? `${pipe.needQty} kg` : "—"} />
              <Row k="Need by" v={pipe.needBy ?? "—"} />
              <Row k="Attempt" v={pipe.attempt || "—"} />
              <Row k="Elapsed" v={<span className="font-mono tabular-nums">{elapsed}</span>} />
              <Row k="Judge" v={pipe.decision ?? "—"} />
            </dl>
          </div>
          <div>
            <div className="label-mono mb-1">Models</div>
            <dl className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-1.5 text-[14px]">
              {MODELS.map(([k, v]) => (
                <Row key={k} k={k} v={v} />
              ))}
            </dl>
          </div>
          <div>
            <div className="label-mono mb-1">QA flags</div>
            <div className="mb-1.5 flex h-9 overflow-hidden rounded-[6px] border border-hair text-[13px]">
              <span className="flex flex-1 items-center justify-center border-r border-hair text-fg2">
                QC release&nbsp;<span className="text-ink">{qa?.qc_release_days != null ? `${qa.qc_release_days} d` : "—"}</span>
              </span>
              <span
                className="flex flex-1 items-center justify-center"
                style={{ color: qa?.change_control_required == null ? "#908E87" : qa.change_control_required ? "#D97706" : "#16A34A" }}
              >
                {qa?.change_control_required == null ? "Change control —" : qa.change_control_required ? "Change control" : "No change control"}
              </span>
            </div>
            <div className="flex flex-wrap gap-1">
              {(qa?.documents_required ?? []).length === 0 && <span className="text-[13px] text-muted">No documents yet</span>}
              {(qa?.documents_required ?? []).map((d) => (
                <Tag key={d}>{d}</Tag>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <ul className="max-h-[420px] overflow-y-auto px-3 py-2 font-mono text-[12px]" data-testid="event-log">
          {events.length === 0 && <li className="py-2 font-sans text-[13px] text-muted">No events yet. Send a message or run a mission.</li>}
          {[...events].reverse().map((e, i) => (
            <li key={i} className="flex gap-2 border-b border-hair py-1 last:border-0">
              <span className="shrink-0 tabular-nums text-muted">{new Date(e.at).toLocaleTimeString([], { hour12: false })}</span>
              <span className="shrink-0 text-ink">{e.type}</span>
              <span className="min-w-0 truncate font-sans text-fg2" title={e.text}>
                {e.text}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="border-t border-hair">
        <div className="flex h-9 items-center gap-2 px-3">
          <span className="font-mono text-[12px] uppercase tracking-[0.06em] text-fg2">Dependencies</span>
          <span className="ml-auto flex items-center gap-1 text-[12px] text-muted">
            sub-agents
          </span>
        </div>
        <ul className="px-2 pb-2">
          {deps.map(([label, id, parent]) => {
            const st = pipe.nodes[id];
            return (
              <li
                key={id}
                className="flex h-7 items-center gap-2 rounded-[4px] px-1.5 text-[13px]"
                style={st === "active" || st === "waiting" ? { background: "#FAF9F8", boxShadow: "inset 0 0 0 1px #F25C05" } : undefined}
              >
                <StatusIcon st={st} />
                {parent && <span className="text-[12px] text-muted">{parent}</span>}
                <span className="text-ink">{label}</span>
                <span className="ml-auto text-[12px]" style={{ color: STATUS_COLOR[st] }}>
                  {STATUS_TEXT[st]}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function StatusIcon({ st }: { st: NodeStatus }) {
  const c = STATUS_COLOR[st];
  if (st === "done") return <CheckCircle2 className="h-3.5 w-3.5" style={{ color: c }} />;
  if (st === "failed") return <XCircle className="h-3.5 w-3.5" style={{ color: c }} />;
  if (st === "active") return <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: c }} />;
  if (st === "waiting") return <Clock className="h-3.5 w-3.5" style={{ color: c }} />;
  return <Circle className="h-3.5 w-3.5" style={{ color: "#D4D2CF" }} />;
}

/* --------------------------------------------------------------- pipeline */

type NodeDef = { id: NodeId; title: string; models: string[]; col: number; row: number };

const GRAPH_H = 500;
const ROW_Y = [70, 250, 430];
const NODE_H = 96;

// Four columns: triggers, branches, negotiation + judge, approval. Vertical hops keep it readable in ~720px.
const NODE_DEFS: NodeDef[] = [
  { id: "sentinel", title: "Sentinel", models: ["code · reorder points"], col: 0, row: 0 },
  { id: "planner", title: "Planner", models: ["Nemotron 3.5 Super VL"], col: 0, row: 1 },
  { id: "sourcing", title: "Sourcing", models: ["Nemotron 3.5 Super VL"], col: 1, row: 0 },
  { id: "transfer", title: "Transfer", models: ["Nemotron 3.5 Super VL"], col: 1, row: 1 },
  { id: "scout", title: "Scout", models: ["Nemotron 3.5 Super VL", "+ You.com search"], col: 1, row: 2 },
  { id: "negotiators", title: "Negotiators", models: ["Nemotron 3.5 Super VL", "vs Nemotron 3 Nano"], col: 2, row: 0 },
  { id: "judge", title: "Judge", models: ["code checks", "+ Nemotron 3 Super 120B"], col: 2, row: 1 },
  { id: "approval", title: "Approval / PO", models: ["authority limit · you"], col: 3, row: 1 },
];

const EDGES: [NodeId, NodeId][] = [
  ["sentinel", "planner"],
  ["planner", "sourcing"],
  ["planner", "transfer"],
  ["planner", "scout"],
  ["sourcing", "negotiators"],
  ["negotiators", "judge"],
  ["transfer", "judge"],
  ["scout", "judge"],
  ["judge", "approval"],
];

const STATUS_TEXT: Record<NodeStatus, string> = {
  idle: "idle",
  active: "running",
  done: "done",
  failed: "failed",
  waiting: "waiting for you",
};
const STATUS_COLOR: Record<NodeStatus, string> = {
  idle: "#908E87",
  active: "#F25C05",
  done: "#16A34A",
  failed: "#DC2626",
  waiting: "#F25C05",
};

function PipelineGraph({ pipe, opts = DEFAULT_SETTINGS.PL, fill, tall }: { pipe: Pipeline; opts?: CardSettings["PL"]; fill?: boolean; tall?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(720);
  const [h, setH] = useState(GRAPH_H);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      setW(Math.max(600, el.clientWidth - 40));
      setH(el.clientHeight - 40);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  const graphH = fill ? Math.max(GRAPH_H, h) : tall ? 620 : GRAPH_H;
  const k = graphH / GRAPH_H;
  const rowY = ROW_Y.map((y) => Math.round(y * k));
  const gap = 28;
  const nodeW = Math.max(130, Math.min(fill || tall ? 240 : 190, (w - 3 * gap) / 4));
  const colGap = (w - 4 * nodeW) / 3;
  const pos = (id: NodeId) => {
    const n = NODE_DEFS.find((d) => d.id === id)!;
    return { cx: nodeW / 2 + n.col * (nodeW + colGap), cy: rowY[n.row] };
  };
  const flowing = (a: NodeId, b: NodeId) => {
    const sa = pipe.nodes[a];
    const sb = pipe.nodes[b];
    return sb === "active" || sb === "waiting" || (sa === "active" && sb === "idle" && a !== "planner" && a !== "sentinel");
  };
  const lit = (a: NodeId, b: NodeId) => pipe.nodes[a] !== "idle" && pipe.nodes[b] !== "idle";
  const edgePath = (a: NodeId, b: NodeId) => {
    const s = pos(a);
    const t = pos(b);
    if (Math.abs(s.cx - t.cx) < 4) {
      const y1 = s.cy + NODE_H / 2;
      const y2 = t.cy - NODE_H / 2 - 3;
      return `M${s.cx},${y1} L${t.cx},${y2}`;
    }
    const x1 = s.cx + nodeW / 2;
    const x2 = t.cx - nodeW / 2 - 3;
    const mx = (x1 + x2) / 2;
    return `M${x1},${s.cy} C${mx},${s.cy} ${mx},${t.cy} ${x2},${t.cy}`;
  };

  const replan = pipe.attempt > 1;
  const pl = pos("planner");
  const jg = pos("judge");
  const loopY = (rowY[0] + rowY[1]) / 2 + 2;

  return (
    <div ref={ref} className={`overflow-x-auto p-5 ${fill ? "h-full" : ""}`} data-pl-models={opts.models ? "on" : "off"} data-pl-animate={opts.animate ? "on" : "off"}>
      <div className="relative mx-auto" style={{ width: w, height: graphH }}>
        <svg className="absolute inset-0 overflow-visible" width={w} height={graphH} aria-hidden>
          <defs>
            <marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="#D4D2CF" />
            </marker>
            <marker id="arr-on" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="#F25C05" />
            </marker>
          </defs>
          {EDGES.map(([a, b]) => {
            const on = flowing(a, b);
            const seen = lit(a, b);
            return (
              <path
                key={`${a}-${b}`}
                d={edgePath(a, b)}
                fill="none"
                stroke={on ? "#F25C05" : seen ? "#908E87" : "#D4D2CF"}
                strokeWidth={on ? 1.75 : 1.25}
                strokeDasharray={on && opts.animate ? "6 6" : undefined}
                className={on && opts.animate ? "edge-flow" : undefined}
                markerEnd={on ? "url(#arr-on)" : "url(#arr)"}
              />
            );
          })}
          {replan && (
            <g>
              <path
                d={`M${jg.cx - nodeW / 4},${jg.cy - NODE_H / 2} C${jg.cx - nodeW / 4},${loopY - 18} ${pl.cx + nodeW / 4},${loopY - 18} ${pl.cx + nodeW / 4},${pl.cy - NODE_H / 2 - 3}`}
                fill="none"
                stroke="#F25C05"
                strokeWidth={1.5}
                strokeDasharray="5 5"
                className={opts.animate ? "edge-flow" : undefined}
                markerEnd="url(#arr-on)"
              />
              <text x={(jg.cx + pl.cx) / 2} y={loopY - 2} textAnchor="middle" fontFamily="var(--font-geist-mono)" fontSize="12" fill="#F25C05" letterSpacing="0.06em" stroke="#FFFFFF" strokeWidth={6} paintOrder="stroke">
                RE-PLAN #{pipe.attempt - 1}
              </text>
            </g>
          )}
        </svg>

        {NODE_DEFS.map((n) => {
          const st = pipe.nodes[n.id];
          const p = pos(n.id);
          const hot = st === "active" || st === "waiting";
          const border = hot ? "#F25C05" : st === "done" ? "#16A34A" : st === "failed" ? "#DC2626" : "#EAE8E5";
          return (
            <div
              key={n.id}
              data-node={n.id}
              data-status={st}
              className={`absolute flex flex-col rounded-[8px] border bg-surface px-3.5 py-2.5 ${hot && opts.animate ? "node-pulse" : ""}`}
              style={{ left: p.cx - nodeW / 2, top: p.cy - NODE_H / 2, width: nodeW, minHeight: NODE_H, borderColor: border }}
            >
              <div className="flex items-baseline justify-between gap-1">
                <span className="font-display text-[17px] font-normal leading-tight text-ink">{n.title}</span>
                {n.id === "negotiators" && pipe.negotiators > 0 && <span className="font-mono text-[12px] text-fg2">×{pipe.negotiators}</span>}
              </div>
              {opts.models && n.models.map((m) => (
                <span key={m} className="font-mono text-[11px] uppercase leading-[1.35] tracking-[0.02em] text-muted">
                  {m}
                </span>
              ))}
              <span className="mt-1 text-[13px] leading-tight" style={{ color: STATUS_COLOR[st] }}>
                {n.id === "approval" && pipe.notes.approval && st !== "idle" ? pipe.notes.approval : STATUS_TEXT[st]}
              </span>
              {n.id !== "approval" && pipe.notes[n.id] && st !== "idle" && (
                <span className="line-clamp-1 text-[12px] leading-tight text-fg2" title={pipe.notes[n.id]}>
                  {pipe.notes[n.id]}
                </span>
              )}
            </div>
          );
        })}

        {/* tool chips under the Planner */}
        {opts.tools && pipe.tools.length > 0 && (
          <div className="absolute flex flex-wrap gap-1.5" style={{ left: pl.cx - nodeW / 2, top: pl.cy + NODE_H / 2 + 14, width: nodeW + 20 }} data-testid="tool-chips">
            {pipe.tools.map((t, i) => (
              <span
                key={`${t.name}-${i}`}
                className="rounded-full border bg-surface px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-[0.04em]"
                style={{ borderColor: t.done ? "#16A34A" : "#F25C05", color: t.done ? "#16A34A" : "#F25C05" }}
              >
                {t.name}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-hair px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.05em] text-fg2">{children}</span>
  );
}

/* ------------------------------------------------------------------ phone */

function Phone(props: {
  msgs: ChatMsg[];
  busy: boolean;
  draft: string;
  setDraft: (s: string) => void;
  onSend: () => void;
  onAnswer: (msgId: string, requestId: string, opt: InputOption) => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { msgs, busy, draft, setDraft, onSend, onAnswer, scrollRef } = props;
  return (
    <div className="relative h-[780px] w-[390px] max-w-full shrink-0 rounded-[54px] bg-[#141311] p-[11px] shadow-[0_30px_60px_-20px_rgba(20,19,17,0.45)]">
      <div className="relative flex h-full flex-col overflow-hidden rounded-[44px] bg-white">
        {/* status bar */}
        <div className="relative flex h-[46px] shrink-0 items-center justify-between bg-[#f7f7f7] px-7 pt-1 text-[14px] font-semibold text-black">
          <span>9:41</span>
          <div className="absolute left-1/2 top-[10px] h-[28px] w-[110px] -translate-x-1/2 rounded-full bg-black" />
          <span className="flex items-center gap-1 text-[13px]">
            <svg width="17" height="11" viewBox="0 0 17 11" fill="currentColor"><rect x="0" y="7" width="3" height="4" rx="1"/><rect x="4.5" y="5" width="3" height="6" rx="1"/><rect x="9" y="2.5" width="3" height="8.5" rx="1"/><rect x="13.5" y="0" width="3" height="11" rx="1"/></svg>
            <svg width="25" height="12" viewBox="0 0 25 12" fill="none"><rect x="0.5" y="0.5" width="21" height="11" rx="3" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="16" height="8" rx="2" fill="currentColor"/><rect x="23" y="4" width="1.5" height="4" rx=".75" fill="currentColor" opacity=".4"/></svg>
          </span>
        </div>
        {/* chat header */}
        <div className="flex shrink-0 items-center gap-3 border-b border-[#e3e3e3] bg-[#f7f7f7] px-3 pb-2 pt-1">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#F25C05] text-[14px] font-semibold text-white">SC</div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[16px] font-semibold text-black">Supplier Chief of Staff</div>
            <div className="text-[13px] text-[#8a8a8a]">{busy ? "typing…" : "bot"}</div>
          </div>
        </div>
        {/* messages */}
        <div ref={scrollRef} className="tg-wall flex-1 space-y-1.5 overflow-y-auto px-2.5 py-3">
          {msgs.length === 0 && (
            <div className="mx-auto mt-6 w-[85%] rounded-xl bg-black/25 px-3 py-2 text-center text-[14px] text-white">
              Tap a chip above, or ask “What’s low?”. Every number is synthetic.
            </div>
          )}
          {msgs.map((m) => (
            <Bubble key={m.id} m={m} onAnswer={onAnswer} />
          ))}
          {busy && (
            <div className="flex">
              <div className="flex items-center gap-1 rounded-2xl rounded-bl-md bg-white px-3.5 py-3 shadow-sm">
                <span className="typing-dot h-1.5 w-1.5 rounded-full bg-[#8a8a8a]" />
                <span className="typing-dot h-1.5 w-1.5 rounded-full bg-[#8a8a8a]" />
                <span className="typing-dot h-1.5 w-1.5 rounded-full bg-[#8a8a8a]" />
              </div>
            </div>
          )}
        </div>
        {/* composer */}
        <form
          className="flex shrink-0 items-center gap-2 border-t border-[#e3e3e3] bg-[#f7f7f7] px-3 pb-6 pt-2"
          onSubmit={(e) => {
            e.preventDefault();
            onSend();
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Message"
            className="h-9 flex-1 rounded-full border border-[#dcdcdc] bg-white px-4 text-[16px] text-black outline-none focus:border-[#3390ec]"
          />
          <button
            type="submit"
            disabled={busy || !draft.trim()}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-[#3390ec] text-white disabled:opacity-40"
            aria-label="Send"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M3 20.5l18-8.5L3 3.5v6.6l12 1.9-12 1.9z"/></svg>
          </button>
        </form>
      </div>
    </div>
  );
}

function Bubble({ m, onAnswer }: { m: ChatMsg; onAnswer: (msgId: string, requestId: string, opt: InputOption) => void }) {
  if (m.role === "system") {
    return (
      <div className="flex justify-center">
        <span className="rounded-full bg-black/25 px-3 py-1 text-[13px] text-white">{m.text}</span>
      </div>
    );
  }
  const mine = m.role === "user";
  return (
    <div className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
      <div
        className={`relative max-w-[82%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-[15px] leading-[1.35] shadow-sm ${
          mine ? "rounded-br-md bg-[#e1fec6] text-black" : "rounded-bl-md bg-white text-black"
        } ${m.role === "alert" ? "border-l-[3px] border-[#F25C05]" : ""}`}
      >
        {m.role === "alert" && (
          <div className="mb-0.5 text-[13px] font-semibold text-[#F25C05]">Sentinel alert</div>
        )}
        <span>{m.text}</span>
        <span className={`float-right ml-2 mt-1.5 text-[12px] ${mine ? "text-[#5fa94e]" : "text-[#a0a0a0]"}`}>
          {hhmm(m.at)}
          {mine ? " ✓✓" : ""}
        </span>
      </div>
      {m.input?.map((req) => (
        <div key={req.requestId} className="mt-1 grid w-[82%] gap-1" style={{ gridTemplateColumns: `repeat(${Math.min(req.options.length, 2) || 1}, 1fr)` }}>
          {req.options.map((o) => (
            <button
              key={o.id}
              disabled={!!m.answered}
              onClick={() => onAnswer(m.id, req.requestId, o)}
              className={`rounded-lg px-2 py-2 text-[14px] font-medium text-white backdrop-blur ${
                m.answered === o.label ? "bg-[#3390ec]" : "bg-black/30 hover:bg-black/40"
              } disabled:cursor-default`}
            >
              {o.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
