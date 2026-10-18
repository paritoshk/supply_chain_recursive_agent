"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

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

const TAGS = [
  "Recursive agents",
  "Crusoe Managed Inference",
  "Nemotron doers · Nemotron judge",
  "Telegram @supplychief_bot",
  "You.com search",
  "PubChem",
  "Synthetic data",
];

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

export default function Theater() {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [pipe, setPipe] = useState<Pipeline>(EMPTY_PIPE);
  const [qa, setQa] = useState<QaFit | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [opsNote, setOpsNote] = useState<string | null>(null);
  const [runOn, setRunOn] = useState<"phone" | "page">("phone");
  const [mirroring, setMirroring] = useState(false);

  const sessionRef = useRef<string | null>(null);
  const countRef = useRef(0);
  const seenRef = useRef<Set<string>>(new Set());
  const streamingRef = useRef(false);
  const busyRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const streamAbort = useRef<AbortController | null>(null);
  // Mirror mode: the web view follows the real Telegram session started by the sentinel.
  const mirrorRef = useRef(false);
  const sinceRef = useRef(0);
  const localTexts = useRef<string[]>([]);

  const setBusyBoth = (b: boolean) => {
    busyRef.current = b;
    setBusy(b);
  };

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, busy]);

  useEffect(() => () => streamAbort.current?.abort(), []);

  const pushMsg = useCallback((m: Omit<ChatMsg, "id" | "at"> & { at?: number }) => {
    setMsgs((prev) => [...prev, { id: nid(), at: Date.now(), ...m }]);
  }, []);

  const setNode = (p: Pipeline, patch: Partial<Record<NodeId, NodeStatus>>, notes?: Partial<Record<NodeId, string>>): Pipeline => ({
    ...p,
    nodes: { ...p.nodes, ...patch },
    notes: notes ? { ...p.notes, ...notes } : p.notes,
  });

  /** A new user turn: Planner lights up. Non-mission turns clear the previous turn's tool chips. */
  const beginTurn = useCallback((mission?: boolean) => {
    if (mission) {
      setQa(null);
      setPipe({
        ...EMPTY_PIPE,
        nodes: { ...idleNodes(), sentinel: "active", planner: "active" },
        notes: { sentinel: "below reorder point" },
        mission: true,
        dod: DEFAULT_CHECKS,
        checks: DEFAULT_CHECKS.map((id) => ({ id })),
        attempt: 0,
        startedAt: Date.now(),
      });
      return;
    }
    setPipe((p) => {
      const running = p.mission && !p.endedAt;
      if (running) return setNode(p, { planner: "active" });
      return { ...setNode(p, { planner: "active" }, { planner: "reading your message" }), tools: [] };
    });
  }, []);

  /* ------------------------------------------------------- event handler */
  const handleEvent = useCallback(
    (e: AnyObj) => {
      const type: string = e?.type;
      const d: AnyObj = e?.data ?? {};
      switch (type) {
        case "turn.started":
          setBusyBoth(true);
          setPipe((p) => (p.nodes.planner === "active" ? p : setNode(p, { planner: "active" })));
          break;
        case "message.received": {
          if (!mirrorRef.current) break;
          const text = typeof d.message === "string" ? d.message.trim() : "";
          if (!text) break;
          const i = localTexts.current.indexOf(text);
          if (i >= 0) {
            localTexts.current.splice(i, 1);
            break;
          }
          if (text.startsWith("Sentinel alert")) {
            pushMsg({ role: "alert", text: text.replace(/^Sentinel alert:\s*/, "").split(". Run run_mission")[0] + "." });
            beginTurn(true);
          } else {
            pushMsg({ role: "user", text });
            beginTurn(false);
          }
          break;
        }
        case "message.completed":
          if (typeof d.message === "string" && d.message.trim()) pushMsg({ role: "bot", text: d.message });
          setPipe((p) => setNode(p, { planner: "done" }, { planner: "replied" }));
          break;
        case "actions.requested": {
          const acts: AnyObj[] = d.actions ?? [];
          const names = acts.map((a) => String(a.toolName ?? a.name ?? "tool"));
          const isMission = names.includes("run_mission");
          setPipe((p) => {
            let next = p;
            if (isMission && !(p.mission && !p.endedAt)) {
              next = {
                ...EMPTY_PIPE,
                nodes: { ...idleNodes(), sentinel: "active", planner: "active" },
                mission: true,
                dod: DEFAULT_CHECKS,
                checks: DEFAULT_CHECKS.map((id) => ({ id })),
                startedAt: Date.now(),
                tools: p.tools,
              };
            }
            const tools = [...next.tools];
            for (const n of names) if (!tools.some((t) => t.name === n && !t.done)) tools.push({ name: n, done: false });
            return { ...setNode(next, { planner: "active" }, { planner: `calling ${names.join(", ")}` }), tools };
          });
          break;
        }
        case "action.partial": {
          const out: AnyObj = d.result?.output ?? {};
          const stage = out.stage;
          if (stage === "planned") {
            setPipe((p) => ({
              ...setNode(p, { sentinel: "done", planner: "active" }, { sentinel: "alert raised", planner: "mission planned" }),
              mission: true,
              startedAt: p.startedAt ?? Date.now(),
              missionId: out.mission_id,
              needQty: out.need_qty,
              needBy: out.need_by,
              attempt: 1,
              dod: Array.isArray(out.definition_of_done) ? out.definition_of_done : p.dod,
              checks: Array.isArray(out.definition_of_done) ? out.definition_of_done.map((id: string) => ({ id })) : p.checks,
            }));
          } else if (stage === "dossier") {
            setQa((q) => ({
              ...(q ?? {}),
              molecule: {
                ...(q?.molecule ?? {}),
                pubchem_status: out.pubchem_status,
                cid: out.cid ?? null,
                structure_image_url: out.structure_image_url ?? null,
              },
            }));
          } else if (stage === "branches_done") {
            const st = (s: unknown): NodeStatus => (s === "fulfilled" ? "done" : s === "rejected" ? "failed" : "done");
            setPipe((p) => ({
              ...setNode(
                p,
                {
                  transfer: st(out.transfer),
                  sourcing: st(out.sourcing),
                  negotiators: st(out.sourcing),
                  scout: st(out.scout),
                  judge: "active",
                },
                { judge: "recomputing checks in code", sourcing: out.rfq_id ? String(out.rfq_id) : p.notes.sourcing }
              ),
              attempt: out.attempt ?? p.attempt,
            }));
          } else if (stage === "qa_fit") {
            setQa((q) => ({ ...out, molecule: { ...(q?.molecule ?? {}), ...(out.molecule ?? {}) } }) as QaFit);
            setPipe((p) => setNode(p, { judge: "active" }, { judge: "Nemotron checking grounding" }));
          } else if (stage === "verified") {
            const checks: Check[] = Array.isArray(out.checks) ? out.checks : [];
            const decision: string = out.decision;
            setPipe((p) => {
              const merged = p.checks.length
                ? p.checks
                    .map((c) => {
                      const hit = checks.find((x) => x.id === c.id);
                      return hit ? { ...c, pass: hit.pass, reason: hit.reason ?? c.reason } : c;
                    })
                    .concat(checks.filter((x) => !p.checks.some((c) => c.id === x.id)))
                : checks;
              const passed = checks.filter((c) => c.pass).length;
              const judge: NodeStatus = decision === "accept" ? "done" : "failed";
              let next = setNode(p, { judge }, { judge: `${decision} · ${passed}/${checks.length} checks` });
              if (decision === "replan") {
                next = setNode(next, { planner: "active", sourcing: "idle", negotiators: "idle" }, { planner: `re-planning (attempt ${(out.attempt ?? p.attempt) + 1})` });
              } else {
                next = setNode(next, { approval: "active" }, { approval: "deciding", planner: "waiting on the mission" });
              }
              return {
                ...next,
                attempt: decision === "replan" ? (out.attempt ?? p.attempt) + 1 : out.attempt ?? p.attempt,
                decision,
                checks: merged,
              };
            });
          }
          break;
        }
        case "action.result": {
          const r: AnyObj = d.result ?? {};
          const tool = String(r.toolName ?? "");
          setPipe((p) => ({ ...p, tools: p.tools.map((t) => (t.name === tool ? { ...t, done: true } : t)) }));
          if (tool !== "run_mission") break;
          const out: AnyObj = r.output ?? {};
          const apKey: string = typeof out.approval === "string" ? out.approval : out.approval?.status ?? "none";
          const [apLabel, apStatus] = APPROVAL_LABEL[apKey] ?? [apKey, "done"];
          setPipe((p) => ({
            ...setNode(p, { approval: apStatus, sentinel: "done" }, { approval: apLabel }),
            endedAt: Date.now(),
            attempt: out.attempts ?? p.attempt,
            missionId: out.mission_id ?? p.missionId,
            checks: Array.isArray(out.checks) && out.checks.length ? out.checks : p.checks,
            planLine: planLineFrom(out) ?? (typeof out.summary === "string" ? out.summary : p.planLine),
            approval: apLabel,
          }));
          const qf: AnyObj | undefined = out.quality_fit;
          if (qf) {
            setQa((q) =>
              q?.suppliers?.length
                ? q
                : {
                    ...(q ?? {}),
                    lines: qf.requirement ?? q?.lines,
                    suppliers: qf.fits ?? q?.suppliers,
                    chosen_supplier_id: out.plan?.purchase?.supplier_id ?? q?.chosen_supplier_id ?? null,
                    qc_release_days: out.plan?.qc_release_days ?? q?.qc_release_days,
                    change_control_required: out.plan?.qa?.change_control_required ?? q?.change_control_required,
                    documents_required: out.plan?.qa?.documents_required ?? q?.documents_required,
                  }
            );
          }
          break;
        }
        case "agent.started": {
          const name: string = String(d.name ?? "agent").toLowerCase();
          setPipe((p) => {
            if (name === "transfer" || name === "sourcing" || name === "scout") return setNode(p, { [name]: "active" } as Partial<Record<NodeId, NodeStatus>>);
            if (name === "verifier" || name === "judge") return setNode(p, { judge: "active" }, { judge: "Nemotron checking grounding" });
            if (/negot|supplier|persona/.test(name))
              return { ...setNode(p, { negotiators: "active" }), negotiators: p.negotiators + 1 };
            return p;
          });
          break;
        }
        case "input.requested": {
          const reqs: AnyObj[] = d.requests ?? [];
          for (const r of reqs) {
            const opts: InputOption[] = (r.options ?? r.question?.options ?? []).map((o: AnyObj) => ({
              id: String(o.id ?? o.value),
              label: String(o.label ?? o.id),
            }));
            const prompt: string = r.prompt ?? r.question?.prompt ?? r.title ?? "Approval needed";
            pushMsg({ role: "bot", text: prompt, input: [{ requestId: r.requestId ?? r.id, options: opts }] });
          }
          setPipe((p) => ({ ...setNode(p, { approval: "waiting" }, { approval: "waiting for you" }), approval: "waiting for you" }));
          break;
        }
        case "turn.waiting":
          if (d.on === "input") setBusyBoth(false);
          break;
        case "turn.completed":
        case "turn.failed":
        case "turn.cancelled": {
          setBusyBoth(false);
          const failed = type !== "turn.completed";
          setPipe((p) => {
            const nodes = { ...p.nodes };
            for (const n of ALL_NODES) if (nodes[n] === "active") nodes[n] = failed ? "failed" : "done";
            return { ...p, nodes, endedAt: p.mission && !p.endedAt ? Date.now() : p.endedAt };
          });
          if (failed) pushMsg({ role: "system", text: "The turn ended early. Try again." });
          break;
        }
        case "session.waiting":
        case "session.failed":
          setBusyBoth(false);
          break;
      }
    },
    [pushMsg, beginTurn]
  );

  /* ------------------------------------------------------------ streaming */
  const ensureStream = useCallback(() => {
    const sid = sessionRef.current;
    if (!sid || streamingRef.current) return;
    streamingRef.current = true;
    const ac = new AbortController();
    streamAbort.current = ac;
    (async () => {
      try {
        const res = await fetch(`/api/eve/session/${sid}/stream?startIndex=${countRef.current}`, {
          cache: "no-store",
          signal: ac.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
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
            let ev: AnyObj;
            try {
              ev = JSON.parse(line);
            } catch {
              continue;
            }
            const eid: string | undefined = ev?.meta?.id;
            if (eid) {
              if (seenRef.current.has(eid)) continue;
              seenRef.current.add(eid);
            }
            countRef.current += 1;
            if (mirrorRef.current && sinceRef.current) {
              const at = ev?.meta?.at;
              const t = typeof at === "number" ? at : typeof at === "string" ? Date.parse(at) : NaN;
              if (!Number.isNaN(t) && t < sinceRef.current) continue;
            }
            handleEvent(ev);
          }
        }
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
      } finally {
        streamingRef.current = false;
      }
      if (ac.signal.aborted) return;
      if (busyRef.current) setTimeout(ensureStream, 800);
      else if (mirrorRef.current) setTimeout(ensureStream, 2500);
    })();
  }, [handleEvent]);

  /* ---------------------------------------------------------------- send */
  const post = useCallback(
    async (body: AnyObj) => {
      setBusyBoth(true);
      try {
        let sid = sessionRef.current;
        if (!sid) {
          const res = await fetch("/api/eve/session", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          const j = await res.json();
          if (!j?.sessionId) throw new Error(j?.error ?? "no session");
          sid = j.sessionId as string;
          sessionRef.current = sid;
        } else {
          const res = await fetch(`/api/eve/session/${sid}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          if (!res.ok) throw new Error(`send ${res.status}`);
        }
        ensureStream();
      } catch (err) {
        setBusyBoth(false);
        setPipe((p) => setNode(p, { planner: "failed" }, { planner: "agent unreachable" }));
        pushMsg({ role: "system", text: `Could not reach the agent (${(err as Error).message}).` });
      }
    },
    [ensureStream, pushMsg]
  );

  const sendText = useCallback(
    (text: string) => {
      const t = text.trim();
      if (!t) return;
      pushMsg({ role: "user", text: t });
      if (mirrorRef.current) localTexts.current.push(t);
      beginTurn(false);
      post({ message: t });
    },
    [post, pushMsg, beginTurn]
  );

  /** Fire the real sentinel: the alert lands on the planner's Telegram, and this page mirrors that session live. */
  const runOnPhone = useCallback(
    async (m: NonNullable<QuickAction["mission"]>) => {
      setBusyBoth(true);
      beginTurn(true);
      pushMsg({ role: "system", text: "Sentinel alert sent to Telegram. Mirroring that session here." });
      const clickAt = Date.now();
      try {
        const res = await fetch("/api/ops/sentinel", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ material_id: m.material, site_id: m.site }),
        });
        const j: AnyObj = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j?.error ?? j?.reason ?? `sentinel ${res.status}`);
        if (!j.sessionId) {
          setBusyBoth(false);
          pushMsg({ role: "system", text: j.breaches === 0 ? "No breach for that material right now." : "Alert sent, but no session to mirror." });
          setPipe((p) => setNode(p, { sentinel: "done", planner: "idle" }));
          return;
        }
        streamAbort.current?.abort();
        streamingRef.current = false;
        seenRef.current = new Set();
        countRef.current = 0;
        sessionRef.current = String(j.sessionId);
        mirrorRef.current = true;
        sinceRef.current = clickAt - 5000;
        setMirroring(true);
        ensureStream();
      } catch (err) {
        setBusyBoth(false);
        setPipe((p) => setNode(p, { sentinel: "failed", planner: "idle" }));
        pushMsg({ role: "system", text: `Could not fire the sentinel (${(err as Error).message}).` });
      }
    },
    [beginTurn, ensureStream, pushMsg]
  );

  const runAction = useCallback(
    (a: QuickAction) => {
      if (busyRef.current) return;
      if (a.mission && a.alert) {
        if (runOn === "phone") {
          runOnPhone(a.mission);
          return;
        }
        // Run on this page: a fresh web session, separate from the Telegram conversation.
        if (mirrorRef.current) {
          streamAbort.current?.abort();
          streamingRef.current = false;
          sessionRef.current = null;
          countRef.current = 0;
          seenRef.current = new Set();
          mirrorRef.current = false;
          setMirroring(false);
        }
        pushMsg({ role: "alert", text: a.alert });
        beginTurn(true);
        post({ message: a.message });
      } else sendText(a.message);
    },
    [post, pushMsg, sendText, beginTurn, runOn, runOnPhone]
  );

  const answer = useCallback(
    (msgId: string, requestId: string, opt: InputOption) => {
      setMsgs((prev) => prev.map((m) => (m.id === msgId ? { ...m, answered: opt.label } : m)));
      pushMsg({ role: "user", text: opt.label });
      setPipe((p) => ({ ...setNode(p, { approval: "active", planner: "active" }, { approval: `you chose: ${opt.label}` }) }));
      post({ inputResponses: [{ requestId, optionId: opt.id }] });
    },
    [post, pushMsg]
  );

  const ops = useCallback(async (action: "reset" | "sentinel", body?: AnyObj) => {
    setOpsNote(action === "reset" ? "Resetting synthetic data…" : "Sending alert to the phone…");
    try {
      const res = await fetch(`/api/ops/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      setOpsNote(res.ok ? (action === "reset" ? "Demo data reset." : "Alert sent to Telegram.") : `Failed (${res.status}).`);
      if (res.ok && action === "reset") {
        setPipe(EMPTY_PIPE);
        setQa(null);
      }
    } catch {
      setOpsNote("Failed.");
    }
    setTimeout(() => setOpsNote(null), 4000);
  }, []);

  /* ---------------------------------------------------------------- render */
  const elapsed = pipe.startedAt ? Math.max(0, ((pipe.endedAt ?? now) - pipe.startedAt) / 1000) : 0;
  const mm = Math.floor(elapsed / 60);
  const ss = Math.floor(elapsed % 60).toString().padStart(2, "0");

  return (
    <main className="mx-auto w-full max-w-[1440px] px-5 pb-10 pt-6 lg:px-8">
      {/* header */}
      <header className="flex flex-col gap-3 border-b border-hair pb-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <span className="label-mono" style={{ color: "#F25C05" }}>
              Mission theater · Corvane Biologics
            </span>
            <h1 className="mt-1 font-display text-[30px] font-light leading-tight tracking-[-0.012em] text-ink">
              Supplier Chief of Staff
            </h1>
            <p className="mt-1 text-[16px] text-fg2">
              Texts you before a material runs out <span className="text-muted">and fixes it with a team of agents.</span>
            </p>
          </div>
          <div className="flex items-center gap-3">
            {opsNote && <span className="text-[13px] text-accent">{opsNote}</span>}
            <button
              className="rounded-full border border-hair bg-surface px-3 py-1.5 text-[13px] text-fg2 hover:border-ink hover:text-ink"
              onClick={() => ops("reset")}
            >
              Reset demo
            </button>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5" aria-label="Stack">
          {TAGS.map((t) => (
            <span key={t} className="rounded-full border border-hair bg-surface px-2.5 py-0.5 label-mono">
              {t}
            </span>
          ))}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span className="label-mono">Run missions on</span>
          {(["phone", "page"] as const).map((o) => (
            <button
              key={o}
              onClick={() => setRunOn(o)}
              aria-pressed={runOn === o}
              className="rounded-full border px-3 py-1 text-[13px] transition-colors"
              style={runOn === o ? { borderColor: "#F25C05", color: "#141311" } : { borderColor: "#EAE8E5", color: "#908E87" }}
            >
              {o === "phone" ? "Run on my phone" : "This page"}
            </button>
          ))}
          <span className="text-[12px] text-muted">
            {runOn === "phone" ? "Fires the real sentinel to Telegram; this page mirrors it live." : "Runs a separate web session."}
          </span>
        </div>
        <nav className="flex flex-wrap gap-2" aria-label="Quick actions">
          {ACTIONS.map((a) => (
            <button
              key={a.key}
              disabled={busy}
              onClick={() => runAction(a)}
              className="group flex items-center gap-2 rounded-full border border-hair bg-surface px-4 py-2 text-[14px] text-ink transition-colors hover:border-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span>{a.label}</span>
              {a.ids && <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-muted">{a.ids}</span>}
            </button>
          ))}
        </nav>
      </header>

      {/* body */}
      <section className="mt-6 grid grid-cols-1 gap-6 min-[1100px]:grid-cols-[390px_1fr]">
        <div className="flex justify-center min-[1100px]:block">
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

        <div className="flex min-w-0 flex-col gap-4">
          {/* pipeline */}
          <div className="rounded-[8px] border border-hair bg-surface" data-testid="pipeline">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-hair px-5 py-3">
              <span className="label-mono">Live agent pipeline</span>
              <span className="font-mono text-[12px] text-ink">{pipe.missionId ?? (pipe.mission ? "mission starting…" : "chat turn")}</span>
              <span className="font-mono text-[12px] tabular-nums text-fg2">{pipe.startedAt ? `${mm}:${ss}` : "0:00"}</span>
              {pipe.attempt > 0 && <span className="text-[13px] text-fg2">attempt {pipe.attempt}</span>}
              {pipe.needQty != null && (
                <span className="text-[13px] text-fg2">
                  need {pipe.needQty} kg by {pipe.needBy}
                </span>
              )}
              {mirroring && <span className="label-mono" style={{ color: "#F25C05" }}>Mirroring Telegram session</span>}
              {busy && <span className="ml-auto text-[13px] text-accent">running</span>}
            </div>
            <PipelineGraph pipe={pipe} />
            <div className="border-t border-hair px-5 py-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="label-mono">Definition of done</span>
                {(pipe.checks.length ? pipe.checks : DEFAULT_CHECKS.map((id) => ({ id }) as Check)).map((c) => (
                  <span
                    key={c.id}
                    title={c.reason}
                    className="font-mono text-[12px]"
                    style={{ color: c.pass === true ? "#16A34A" : c.pass === false ? "#DC2626" : "#908E87" }}
                  >
                    {c.pass === true ? "✓" : c.pass === false ? "✗" : "○"} {c.id}
                  </span>
                ))}
              </div>
              <p className="mt-2 text-[14px] text-ink">
                <span className="text-muted">plan </span>
                {pipe.planLine ?? (pipe.mission ? "waiting for the judge…" : "Tap a mission chip to run the full pipeline.")}
                {pipe.approval && <span className="text-fg2"> · approval: {pipe.approval}</span>}
              </p>
            </div>
          </div>

          <QaPanel qa={qa} mission={pipe.mission} />
        </div>
      </section>

      <footer className="mt-8 flex flex-wrap gap-x-6 gap-y-1 border-t border-hair pt-4 label-mono">
        <a className="hover:text-ink" href="https://github.com/paritoshk/supply_chain_recursive_agent/blob/main/docs/architecture.pdf" target="_blank" rel="noreferrer">
          Architecture (PDF)
        </a>
        <a className="hover:text-ink" href="https://github.com/paritoshk/supply_chain_recursive_agent" target="_blank" rel="noreferrer">
          Repo
        </a>
        <span>All data synthetic · Corvane Biologics is fictional</span>
      </footer>
    </main>
  );
}

/* --------------------------------------------------------------- pipeline */

type NodeDef = { id: NodeId; title: string; models: string[]; x: number; y: number };

const GRAPH_H = 380;
const NODE_W = 138;
const NODE_H = 78;

const NODE_DEFS: NodeDef[] = [
  { id: "sentinel", title: "Sentinel", models: ["code · reorder points"], x: 0.075, y: 192 },
  { id: "planner", title: "Planner", models: ["Nemotron 3.5 Super VL"], x: 0.245, y: 192 },
  { id: "transfer", title: "Transfer", models: ["Nemotron 3.5 Super VL"], x: 0.44, y: 84 },
  { id: "sourcing", title: "Sourcing", models: ["Nemotron 3.5 Super VL"], x: 0.44, y: 192 },
  { id: "scout", title: "Scout", models: ["Nemotron 3.5 Super VL", "You.com search"], x: 0.44, y: 304 },
  { id: "negotiators", title: "Negotiators", models: ["Nemotron 3.5 Super VL", "vs Nemotron 3 Nano"], x: 0.615, y: 192 },
  { id: "judge", title: "Judge", models: ["code checks", "+ Nemotron 3 Super 120B"], x: 0.775, y: 192 },
  { id: "approval", title: "Approval / PO", models: ["authority limit · you"], x: 0.925, y: 192 },
];

const EDGES: [NodeId, NodeId][] = [
  ["sentinel", "planner"],
  ["planner", "transfer"],
  ["planner", "sourcing"],
  ["planner", "scout"],
  ["sourcing", "negotiators"],
  ["transfer", "judge"],
  ["negotiators", "judge"],
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

function PipelineGraph({ pipe }: { pipe: Pipeline }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(960);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(860, el.clientWidth)));
    ro.observe(el);
    setW(Math.max(860, el.clientWidth));
    return () => ro.disconnect();
  }, []);

  const pos = (id: NodeId) => {
    const n = NODE_DEFS.find((d) => d.id === id)!;
    return { cx: n.x * w, cy: n.y };
  };
  const flowing = (a: NodeId, b: NodeId) => {
    const sa = pipe.nodes[a];
    const sb = pipe.nodes[b];
    return sb === "active" || sb === "waiting" || (sa === "active" && sb === "idle" && a !== "planner" && a !== "sentinel");
  };
  const lit = (a: NodeId, b: NodeId) => pipe.nodes[a] !== "idle" && pipe.nodes[b] !== "idle";

  const replan = pipe.attempt > 1;
  const pl = pos("planner");
  const jg = pos("judge");

  return (
    <div ref={ref} className="overflow-x-auto">
      <div className="relative" style={{ width: w, height: GRAPH_H }}>
        <svg className="absolute inset-0" width={w} height={GRAPH_H} aria-hidden>
          <defs>
            <marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="#D4D2CF" />
            </marker>
            <marker id="arr-on" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="#F25C05" />
            </marker>
          </defs>
          {EDGES.map(([a, b]) => {
            const s = pos(a);
            const t = pos(b);
            const x1 = s.cx + NODE_W / 2;
            const x2 = t.cx - NODE_W / 2 - 2;
            const mx = (x1 + x2) / 2;
            const d = `M${x1},${s.cy} C${mx},${s.cy} ${mx},${t.cy} ${x2},${t.cy}`;
            const on = flowing(a, b);
            const seen = lit(a, b);
            return (
              <path
                key={`${a}-${b}`}
                d={d}
                fill="none"
                stroke={on ? "#F25C05" : seen ? "#908E87" : "#D4D2CF"}
                strokeWidth={on ? 1.75 : 1.25}
                strokeDasharray={on ? "6 6" : undefined}
                className={on ? "edge-flow" : undefined}
                markerEnd={on ? "url(#arr-on)" : "url(#arr)"}
              />
            );
          })}
          {replan && (
            <g>
              <path
                d={`M${jg.cx},${jg.cy - NODE_H / 2} C${jg.cx},${-34} ${pl.cx},${-34} ${pl.cx},${pl.cy - NODE_H / 2 - 2}`}
                fill="none"
                stroke="#F25C05"
                strokeWidth={1.5}
                strokeDasharray="5 5"
                className="edge-flow"
                markerEnd="url(#arr-on)"
              />
              <text x={(jg.cx + pl.cx) / 2} y={20} textAnchor="middle" className="font-mono" fontSize="11" fill="#F25C05" letterSpacing="0.06em" stroke="#FFFFFF" strokeWidth={5} paintOrder="stroke">
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
              className={`absolute flex flex-col rounded-[8px] border bg-surface px-3 py-2 ${hot ? "node-pulse" : ""}`}
              style={{ left: p.cx - NODE_W / 2, top: p.cy - NODE_H / 2, width: NODE_W, minHeight: NODE_H, borderColor: border }}
            >
              <div className="flex items-baseline justify-between gap-1">
                <span className="font-display text-[15px] font-normal leading-tight text-ink">{n.title}</span>
                {n.id === "negotiators" && pipe.negotiators > 0 && (
                  <span className="font-mono text-[11px] text-fg2">×{pipe.negotiators}</span>
                )}
              </div>
              {n.models.map((m) => (
                <span key={m} className="font-mono text-[9.5px] uppercase leading-[1.35] tracking-[0.05em] text-muted">
                  {m}
                </span>
              ))}
              <span className="mt-1 text-[12px] leading-tight" style={{ color: STATUS_COLOR[st] }}>
                {n.id === "approval" && pipe.notes.approval && st !== "idle" ? pipe.notes.approval : STATUS_TEXT[st]}
              </span>
              {n.id !== "approval" && pipe.notes[n.id] && st !== "idle" && (
                <span className="truncate text-[11px] leading-tight text-fg2" title={pipe.notes[n.id]}>{pipe.notes[n.id]}</span>
              )}
            </div>
          );
        })}

        {/* tool chips under the Planner */}
        {pipe.tools.length > 0 && (
          <div
            className="absolute flex flex-wrap gap-1"
            style={{ left: pl.cx - NODE_W / 2 - 20, top: pl.cy + NODE_H / 2 + 34, width: NODE_W + 40 }}
            data-testid="tool-chips"
          >
            {pipe.tools.map((t, i) => (
              <span
                key={`${t.name}-${i}`}
                className="rounded-full border bg-surface px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.05em]"
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

/* --------------------------------------------------------------------- QA */

function QaPanel({ qa, mission }: { qa: QaFit | null; mission: boolean }) {
  const mol = qa?.molecule ?? null;
  const lines = qa?.lines ?? [];
  const batches = qa?.batches ?? [];
  const suppliers = [...(qa?.suppliers ?? [])].sort((a, b) => a.rank - b.rank);
  const title = qa?.material_name
    ? `${qa.material_name}${qa.site_name ? ` @ ${qa.site_name}` : ""}`
    : mission
      ? "Gathering molecule and line data…"
      : "Run a mission to see the molecule, the line it feeds and the supplier ranking.";

  return (
    <div className="rounded-[8px] border border-hair bg-surface" data-testid="qa-panel">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-hair px-5 py-3">
        <span className="label-mono">Molecule + production line QA</span>
        <span className="text-[14px] text-ink">{title}</span>
        {qa?.material_id && (
          <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted">
            {qa.material_id}
            {qa.site_id ? ` · ${qa.site_id}` : ""}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 p-5 min-[1300px]:grid-cols-[230px_1fr]">
        {/* molecule */}
        <div className="rounded-[8px] border border-hair bg-surface p-3">
          <div className="flex items-center justify-between">
            <span className="label-mono">Molecule</span>
            {mol?.cid != null && <span className="font-mono text-[11px] text-fg2">CID {mol.cid}</span>}
          </div>
          <div className="mt-2 flex h-[150px] items-center justify-center rounded-[6px] border border-hair bg-white">
            {mol?.structure_image_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={mol.structure_image_url} alt={`PubChem structure${mol.cid ? `, CID ${mol.cid}` : ""}`} className="max-h-[140px] max-w-full object-contain" />
            ) : (
              <span className="px-3 text-center text-[12px] text-muted">
                {mol?.pubchem_status && mol.pubchem_status !== "ok" ? "No single structure (mixture or biologic)" : "PubChem structure appears here"}
              </span>
            )}
          </div>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px]">
            <dt className="text-muted">Formula</dt>
            <dd className="text-ink">{mol?.molecular_formula ?? "—"}</dd>
            <dt className="text-muted">MW</dt>
            <dd className="text-ink">{mol?.molecular_weight != null ? `${mol.molecular_weight} g/mol` : "—"}</dd>
            <dt className="text-muted">CAS</dt>
            <dd className="text-ink">{mol?.cas?.length ? mol.cas.slice(0, 2).join(", ") : "—"}</dd>
          </dl>
          {mol?.explanation && <p className="mt-2 text-[12px] leading-snug text-fg2">{mol.explanation}</p>}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          {/* lines */}
          <div className="grid grid-cols-1 gap-3 min-[1300px]:grid-cols-2">
            {lines.length === 0 && (
              <div className="rounded-[8px] border border-hair p-3 text-[12px] text-muted">
                <span className="label-mono block">Production line</span>
                <span className="mt-1 block">The line this material feeds, its cleanroom grade and the grade it requires.</span>
              </div>
            )}
            {lines.slice(0, 2).map((l) => (
              <div key={l.line_id} className="rounded-[8px] border border-hair p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[14px] text-ink">{l.line_name ?? l.line_id}</span>
                  <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-muted">{l.line_id}</span>
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
                {l.rationale && <p className="mt-1.5 text-[12px] leading-snug text-fg2">{l.rationale}</p>}
              </div>
            ))}
          </div>

          {/* batches */}
          <div>
            <div className="flex items-center gap-3">
              <span className="label-mono">Batches · next 60 days</span>
              {qa?.batches_total != null && (
                <span className="text-[12px] text-fg2">
                  {qa.batches_total} planned ·{" "}
                  <span style={{ color: (qa.batches_at_risk ?? 0) > 0 ? "#DC2626" : "#16A34A" }}>{qa.batches_at_risk ?? 0} at risk</span>
                </span>
              )}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1" data-testid="batch-strip">
              {batches.length === 0 && <span className="text-[12px] text-muted">—</span>}
              {batches.map((b) => (
                <span
                  key={b.batch_no}
                  title={`${b.batch_no} · ${b.start_date}${b.line_name ? ` · ${b.line_name}` : ""}${b.material_needed != null ? ` · needs ${b.material_needed}, available ${b.available_at_start ?? "?"}` : ""}`}
                  className="h-4 w-4 rounded-[3px] border"
                  style={{
                    borderColor: b.feasible ? "#16A34A" : "#DC2626",
                    background: b.feasible ? "rgba(22,163,74,0.12)" : "rgba(220,38,38,0.12)",
                  }}
                />
              ))}
            </div>
          </div>

          {/* suppliers */}
          <div>
            <span className="label-mono">Supplier quality ranking</span>
            <table className="mt-1.5 w-full border-collapse text-[12px]">
              <thead>
                <tr className="text-left text-muted">
                  <th className="w-8 py-1 font-normal">#</th>
                  <th className="py-1 font-normal">Supplier</th>
                  <th className="py-1 font-normal">Approved grade</th>
                  <th className="py-1 font-normal">Meets line</th>
                  <th className="w-[140px] py-1 font-normal">Quality</th>
                </tr>
              </thead>
              <tbody>
                {suppliers.length === 0 && (
                  <tr>
                    <td colSpan={5} className="border-t border-hair py-2 text-muted">
                      Ranked once the judge recomputes the checks.
                    </td>
                  </tr>
                )}
                {suppliers.map((s) => {
                  const chosen = s.supplier_id === qa?.chosen_supplier_id;
                  return (
                    <tr key={s.supplier_id} className="border-t border-hair" style={chosen ? { boxShadow: "inset 3px 0 0 #F25C05" } : undefined}>
                      <td className="py-1.5 pl-2 font-mono text-fg2">{s.rank}</td>
                      <td className="py-1.5 text-ink">
                        {s.supplier_name ?? s.supplier_id}
                        {chosen && (
                          <span className="ml-2 rounded-full border px-1.5 font-mono text-[9.5px] uppercase tracking-[0.06em]" style={{ borderColor: "#F25C05", color: "#F25C05" }}>
                            chosen
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 text-fg2">{s.approved_grade ?? "—"}</td>
                      <td className="py-1.5" style={{ color: s.meets_requirement ? "#16A34A" : "#DC2626" }}>
                        {s.meets_requirement ? "✓ meets" : `✗ ${(s.gaps ?? []).join(", ") || "gap"}`}
                      </td>
                      <td className="py-1.5">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-[90px] rounded-full bg-[#EAE8E5]">
                            <div
                              className="h-1.5 rounded-full"
                              style={{ width: `${Math.max(0, Math.min(100, s.quality_score))}%`, background: chosen ? "#F25C05" : "#908E87" }}
                            />
                          </div>
                          <span className="font-mono text-[11px] text-fg2">{s.quality_score}</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* QA flags */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-hair pt-3 text-[12px]">
            <span className="label-mono">QA flags</span>
            <span className="text-fg2">
              QC release <span className="text-ink">{qa?.qc_release_days != null ? `${qa.qc_release_days} days` : "—"}</span>
            </span>
            <span className="text-fg2">
              Change control{" "}
              <span style={{ color: qa?.change_control_required == null ? "#908E87" : qa.change_control_required ? "#D97706" : "#16A34A" }}>
                {qa?.change_control_required == null ? "—" : qa.change_control_required ? "required" : "not required"}
              </span>
            </span>
            {(qa?.documents_required ?? []).map((d) => (
              <Tag key={d}>{d}</Tag>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-hair px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.05em] text-fg2">{children}</span>
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
          <span className="flex items-center gap-1 text-[12px]">
            <svg width="17" height="11" viewBox="0 0 17 11" fill="currentColor"><rect x="0" y="7" width="3" height="4" rx="1"/><rect x="4.5" y="5" width="3" height="6" rx="1"/><rect x="9" y="2.5" width="3" height="8.5" rx="1"/><rect x="13.5" y="0" width="3" height="11" rx="1"/></svg>
            <svg width="25" height="12" viewBox="0 0 25 12" fill="none"><rect x="0.5" y="0.5" width="21" height="11" rx="3" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="16" height="8" rx="2" fill="currentColor"/><rect x="23" y="4" width="1.5" height="4" rx=".75" fill="currentColor" opacity=".4"/></svg>
          </span>
        </div>
        {/* chat header */}
        <div className="flex shrink-0 items-center gap-3 border-b border-[#e3e3e3] bg-[#f7f7f7] px-3 pb-2 pt-1">
          <span className="text-[22px] leading-none text-[#3390ec]">‹</span>
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#F25C05] text-[13px] font-semibold text-white">SC</div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold text-black">Supplier Chief of Staff</div>
            <div className="text-[12px] text-[#8a8a8a]">{busy ? "typing…" : "bot"}</div>
          </div>
        </div>
        {/* messages */}
        <div ref={scrollRef} className="tg-wall flex-1 space-y-1.5 overflow-y-auto px-2.5 py-3">
          {msgs.length === 0 && (
            <div className="mx-auto mt-6 w-[85%] rounded-xl bg-black/25 px-3 py-2 text-center text-[13px] text-white">
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
            className="h-9 flex-1 rounded-full border border-[#dcdcdc] bg-white px-4 text-[15px] text-black outline-none focus:border-[#3390ec]"
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
        <span className="rounded-full bg-black/25 px-3 py-1 text-[12px] text-white">{m.text}</span>
      </div>
    );
  }
  const mine = m.role === "user";
  return (
    <div className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
      <div
        className={`relative max-w-[82%] whitespace-pre-wrap break-words rounded-2xl px-3 py-1.5 text-[14.5px] leading-[1.35] shadow-sm ${
          mine ? "rounded-br-md bg-[#e1fec6] text-black" : "rounded-bl-md bg-white text-black"
        } ${m.role === "alert" ? "border-l-[3px] border-[#F25C05]" : ""}`}
      >
        {m.role === "alert" && (
          <div className="mb-0.5 text-[12px] font-semibold text-[#F25C05]">Sentinel alert</div>
        )}
        <span>{m.text}</span>
        <span className={`float-right ml-2 mt-1.5 text-[11px] ${mine ? "text-[#5fa94e]" : "text-[#a0a0a0]"}`}>
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
              className={`rounded-lg px-2 py-2 text-[13px] font-medium text-white backdrop-blur ${
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
