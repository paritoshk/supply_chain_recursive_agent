"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";

const AgenticFactory3D = dynamic(() => import("@/components/ui/agentic-factory-3d"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-[#141311] label-mono">Loading mission floor…</div>
  ),
});

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

type Mission = {
  active: boolean;
  startedAt: number | null;
  endedAt: number | null;
  missionId?: string;
  needQty?: number;
  needBy?: string;
  attempt?: number;
  decision?: string;
  checks: Check[];
  agents: string[];
  status?: string;
  planLine?: string;
  approval?: string;
  structureUrl?: string | null;
  stage?: string;
};

type AnyObj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const EMPTY_MISSION: Mission = { active: false, startedAt: null, endedAt: null, checks: [], agents: [] };

const DEFAULT_CHECKS = ["covers_need", "lands_in_time", "qualified_only", "comparable_quotes", "grounded"];

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

/* ----------------------------------------------------------------- utils */

let idSeq = 0;
const nid = () => `m${Date.now().toString(36)}${(idSeq++).toString(36)}`;
const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const fmtUsd = (n: unknown) =>
  typeof n === "number" ? `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : undefined;

function machine() {
  return typeof window !== "undefined" ? window.__machine : undefined;
}
function focus(id: string) {
  try {
    machine()?.focusStation(id);
    machine()?.play();
  } catch {}
}

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

/* ------------------------------------------------------------- component */

export default function Theater() {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [mission, setMission] = useState<Mission>(EMPTY_MISSION);
  const [now, setNow] = useState(() => Date.now());
  const [opsNote, setOpsNote] = useState<string | null>(null);
  const [lastMission, setLastMission] = useState<QuickAction["mission"] | null>(null);

  const sessionRef = useRef<string | null>(null);
  const countRef = useRef(0);
  const seenRef = useRef<Set<string>>(new Set());
  const streamingRef = useRef(false);
  const busyRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const cabinetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamAbort = useRef<AbortController | null>(null);

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

  const startMission = useCallback(() => {
    setMission((m) =>
      m.active && !m.endedAt
        ? m
        : { ...EMPTY_MISSION, active: true, startedAt: Date.now(), checks: DEFAULT_CHECKS.map((id) => ({ id })) }
    );
    try {
      machine()?.setMode("order");
      machine()?.play();
    } catch {}
    if (cabinetTimer.current) clearTimeout(cabinetTimer.current);
    cabinetTimer.current = setTimeout(() => focus("cabinet"), 2500);
  }, []);

  const addAgent = (name: string) =>
    setMission((m) => ({ ...m, agents: [...m.agents, name] }));

  /* ------------------------------------------------------- event handler */
  const handleEvent = useCallback(
    (e: AnyObj) => {
      const type: string = e?.type;
      const d: AnyObj = e?.data ?? {};
      switch (type) {
        case "turn.started":
          setBusyBoth(true);
          break;
        case "message.completed":
          if (typeof d.message === "string" && d.message.trim()) pushMsg({ role: "bot", text: d.message });
          break;
        case "actions.requested": {
          const acts: AnyObj[] = d.actions ?? [];
          if (acts.some((a) => a.toolName === "run_mission")) startMission();
          break;
        }
        case "action.partial": {
          const out: AnyObj = d.result?.output ?? {};
          const stage = out.stage;
          if (stage === "planned") {
            if (cabinetTimer.current) clearTimeout(cabinetTimer.current);
            setMission((m) => ({
              ...m,
              active: true,
              startedAt: m.startedAt ?? Date.now(),
              missionId: out.mission_id,
              needQty: out.need_qty,
              needBy: out.need_by,
              stage,
              checks: Array.isArray(out.definition_of_done)
                ? out.definition_of_done.map((id: string) => ({ id }))
                : m.checks,
            }));
            focus("engine");
          } else if (stage === "dossier") {
            setMission((m) => ({ ...m, structureUrl: out.structure_image_url ?? null }));
          } else if (stage === "branches_done") {
            setMission((m) => ({ ...m, attempt: out.attempt ?? m.attempt, stage }));
            focus("cashdesk");
          } else if (stage === "verified") {
            const checks: Check[] = Array.isArray(out.checks) ? out.checks : [];
            setMission((m) => ({
              ...m,
              attempt: out.attempt ?? m.attempt,
              decision: out.decision,
              stage,
              checks: m.checks.length
                ? m.checks.map((c) => {
                    const hit = checks.find((x) => x.id === c.id);
                    return hit ? { ...c, pass: hit.pass, reason: hit.reason } : c;
                  }).concat(checks.filter((x) => !m.checks.some((c) => c.id === x.id)))
                : checks,
            }));
            focus("cashdesk");
          }
          break;
        }
        case "action.result": {
          const r: AnyObj = d.result ?? {};
          if (r.toolName !== "run_mission") break;
          const out: AnyObj = r.output ?? {};
          setMission((m) => ({
            ...m,
            endedAt: Date.now(),
            status: out.status,
            attempt: out.attempts ?? m.attempt,
            missionId: out.mission_id ?? m.missionId,
            checks: Array.isArray(out.checks) && out.checks.length ? out.checks : m.checks,
            planLine: planLineFrom(out) ?? (typeof out.summary === "string" ? out.summary : m.planLine),
            approval: typeof out.approval === "string" ? out.approval : out.approval?.status ?? m.approval,
          }));
          break;
        }
        case "agent.started": {
          const name: string = d.name ?? "agent";
          addAgent(name);
          if (name === "transfer" || name === "scout") focus("admin");
          else if (name === "sourcing" || name === "negotiator") focus("storefront");
          else if (name === "verifier") focus("cashdesk");
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
          focus("cashdesk");
          break;
        }
        case "turn.waiting":
          if (d.on === "input") {
            setBusyBoth(false);
            try {
              machine()?.pause();
            } catch {}
          }
          break;
        case "turn.completed":
        case "turn.failed":
        case "turn.cancelled":
          setBusyBoth(false);
          setMission((m) => {
            if (m.active) {
              try {
                machine()?.pause();
              } catch {}
            }
            return m.active && !m.endedAt ? { ...m, endedAt: Date.now() } : m;
          });
          if (type !== "turn.completed") pushMsg({ role: "system", text: "The turn ended early. Try again." });
          break;
        case "session.waiting":
        case "session.failed":
          setBusyBoth(false);
          break;
      }
    },
    [pushMsg, startMission]
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
            handleEvent(ev);
          }
        }
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
      } finally {
        streamingRef.current = false;
      }
      if (busyRef.current) setTimeout(ensureStream, 800);
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
      post({ message: t });
    },
    [post, pushMsg]
  );

  const runAction = useCallback(
    (a: QuickAction) => {
      if (busyRef.current) return;
      if (a.mission && a.alert) {
        pushMsg({ role: "alert", text: a.alert });
        setLastMission(a.mission);
        startMission();
        post({ message: a.message });
      } else sendText(a.message);
    },
    [post, pushMsg, sendText, startMission]
  );

  const answer = useCallback(
    (msgId: string, requestId: string, opt: InputOption) => {
      setMsgs((prev) => prev.map((m) => (m.id === msgId ? { ...m, answered: opt.label } : m)));
      pushMsg({ role: "user", text: opt.label });
      try {
        machine()?.play();
      } catch {}
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
    } catch {
      setOpsNote("Failed.");
    }
    setTimeout(() => setOpsNote(null), 4000);
  }, []);

  /* ---------------------------------------------------------------- render */
  const elapsed = mission.startedAt ? Math.max(0, ((mission.endedAt ?? now) - mission.startedAt) / 1000) : 0;
  const mm = Math.floor(elapsed / 60);
  const ss = Math.floor(elapsed % 60).toString().padStart(2, "0");

  return (
    <main className="mx-auto w-full max-w-[1440px] px-5 pb-10 pt-6 lg:px-8">
      {/* header strip */}
      <header className="flex flex-col gap-4 border-b border-hair pb-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="font-display text-[30px] font-light leading-tight tracking-[-0.012em] text-ink">
                Supplier Chief of Staff
              </h1>
              <span className="rounded-full border border-hair px-2.5 py-0.5 label-mono">Synthetic data</span>
            </div>
            <p className="mt-1 text-[16px] text-fg2">
              Texts you before a material runs out <span className="text-muted">— and fixes it with a team of agents.</span>
            </p>
          </div>
          <div className="flex flex-col items-end gap-1 text-right">
            <span className="label-mono">
              Doers: Nemotron 3.5 Super VL · Judge: Nemotron 3 Super 120B · Suppliers: Nemotron 3 Nano · Crusoe
            </span>
            <span className="label-mono">
              Corvane Biologics · Telegram @supplychief_bot ·{" "}
              <button className="underline decoration-hair-strong underline-offset-2 hover:text-ink" onClick={() => ops("reset")}>
                Reset demo
              </button>
              {opsNote && <span className="ml-2 text-accent">{opsNote}</span>}
            </span>
          </div>
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
      <section className="mt-6 grid grid-cols-1 gap-6 min-[1100px]:grid-cols-[410px_1fr]">
        {/* phone */}
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

        {/* theater */}
        <div className="flex min-w-0 flex-col gap-4">
          <div className="overflow-hidden rounded-[8px] border border-hair bg-[#141311]" style={{ height: 640 }}>
            <AgenticFactory3D height={640} embed={false} />
          </div>

          {/* mission trace */}
          <div className="rounded-[8px] border border-hair bg-surface px-5 py-4">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
              <span className="label-mono">Mission trace</span>
              <span className="font-mono text-[12px] text-ink">{mission.missionId ?? (mission.active ? "starting…" : "—")}</span>
              <span className="font-mono text-[12px] tabular-nums text-fg2">
                {mission.startedAt ? `${mm}:${ss}` : "0:00"}
              </span>
              <span className="text-[13px] text-fg2">attempt {mission.attempt ?? (mission.active ? 1 : "—")}</span>
              {mission.needQty != null && (
                <span className="text-[13px] text-fg2">
                  need {mission.needQty} by {mission.needBy}
                </span>
              )}
              {mission.decision && <span className="text-[13px] text-fg2">judge: {mission.decision}</span>}
              {mission.active && !mission.endedAt && <span className="text-[13px] text-accent">running</span>}
              {mission.status && <span className="text-[13px] text-ink">status: {mission.status}</span>}
              {lastMission && (
                <button
                  className="ml-auto rounded-full border border-hair px-3 py-1 text-[12px] text-fg2 hover:border-ink hover:text-ink"
                  onClick={() => ops("sentinel", { material_id: lastMission.material, site_id: lastMission.site })}
                >
                  Also alert my phone
                </button>
              )}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-[12px] text-muted">sub-agents</span>
              {mission.agents.length === 0 && <span className="text-[12px] text-muted">none yet</span>}
              {agentChips(mission.agents).map(([name, n]) => (
                <span key={name} className="rounded-full border border-hair px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-[0.06em] text-fg2">
                  {name}
                  {n > 1 ? ` ×${n}` : ""}
                </span>
              ))}
            </div>

            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
              <span className="text-[12px] text-muted">definition of done</span>
              {(mission.checks.length ? mission.checks : DEFAULT_CHECKS.map((id) => ({ id }) as Check)).map((c) => (
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

            <div className="mt-3 flex items-start gap-3 border-t border-hair pt-3">
              {mission.structureUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={mission.structureUrl} alt="PubChem structure" className="h-10 w-10 shrink-0 rounded border border-hair bg-white object-contain" />
              )}
              <p className="text-[14px] text-ink">
                <span className="text-muted">plan </span>
                {mission.planLine ?? (mission.active ? "waiting for the judge…" : "Run a mission from the chips above.")}
                {mission.approval && <span className="text-fg2"> · approval: {mission.approval}</span>}
              </p>
            </div>
          </div>
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

function agentChips(agents: string[]): [string, number][] {
  const order: string[] = [];
  const count = new Map<string, number>();
  for (const a of agents) {
    if (!count.has(a)) order.push(a);
    count.set(a, (count.get(a) ?? 0) + 1);
  }
  return order.map((a) => [a, count.get(a) ?? 1]);
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
