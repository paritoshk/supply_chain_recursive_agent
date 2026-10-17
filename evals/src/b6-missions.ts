/**
 * B6/B8 Mission telemetry. If SCOS_URL is set, reads each session stream listed in docs/evals/missions.txt
 * (GET $SCOS_URL/eve/v1/session/<id>/stream, NDJSON) and computes wall time, attempts, sub-agent count,
 * tokens in/out and checks passed per mission. Missing or expired streams are recorded, not fatal.
 * Also reads local mission records (Store missions + agent_runs from STATE_FILE or .data/state.json)
 * as a second, clearly labelled source.
 */
import "./lib/env.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./lib/env.ts";
import { writeResult } from "./lib/io.ts";
import { costOf } from "./lib/llm.ts";
import { DOER } from "./lib/models.ts";
import { percentile, r2 } from "./lib/stats.ts";

type Ev = Record<string, unknown>;
const ids = readFileSync(join(REPO_ROOT, "docs/evals/missions.txt"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

/** Depth-first search for the first value under any of the keys. */
function dig(o: unknown, keys: string[], depth = 0): unknown {
  if (!o || typeof o !== "object" || depth > 6) return undefined;
  for (const k of keys) if (k in (o as Ev) && (o as Ev)[k] != null) return (o as Ev)[k];
  for (const v of Object.values(o as Ev)) {
    const r = dig(v, keys, depth + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}
const tsOf = (e: Ev): number | null => {
  const v = dig(e, ["timestamp", "ts", "at", "time", "created_at", "createdAt"]);
  const n = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

function summarizeStream(id: string, events: Ev[]) {
  const typeOf = (e: Ev) => String(e.type ?? e.event ?? e.kind ?? "");
  const times = events.map(tsOf).filter((x): x is number => x != null);
  const t0 = times.length ? Math.min(...times) : null;
  const stages: Array<{ stage: string; attempt: number | null; t_s: number | null; decision?: unknown; checks?: unknown }> = [];
  let tin = 0, tout = 0, steps = 0;
  const agents = new Set<string>();
  for (const e of events) {
    const type = typeOf(e);
    if (type === "agent.started") agents.add(String(dig(e, ["agent", "agentName", "name", "agent_id", "agentId"]) ?? `agent-${agents.size}`));
    if (type === "action.partial") {
      const stage = dig(e, ["stage"]);
      if (typeof stage === "string") {
        const t = tsOf(e);
        stages.push({ stage, attempt: (dig(e, ["attempt"]) as number) ?? null, t_s: t != null && t0 != null ? r2((t - t0) / 1000) : null, decision: dig(e, ["decision"]), checks: dig(e, ["checks"]) });
      }
    }
    if (type === "step.completed") {
      steps++;
      const u = dig(e, ["usage"]) as Ev | undefined;
      tin += Number(u?.inputTokens ?? u?.input_tokens ?? u?.prompt_tokens ?? u?.promptTokens ?? 0);
      tout += Number(u?.outputTokens ?? u?.output_tokens ?? u?.completion_tokens ?? u?.completionTokens ?? 0);
    }
  }
  const verified = stages.filter((s) => s.stage === "verified");
  const last = verified.at(-1);
  const checks = Array.isArray(last?.checks) ? (last.checks as Array<{ pass?: boolean }>) : [];
  return {
    id,
    source: "eve session stream",
    events: events.length,
    wall_s: times.length ? r2((Math.max(...times) - Math.min(...times)) / 1000) : null,
    attempts: verified.length || null,
    sub_agents: agents.size,
    steps,
    tokens_in: tin,
    tokens_out: tout,
    est_cost_usd: r2(costOf(DOER, tin, tout) * 100) / 100,
    checks_passed: checks.length ? `${checks.filter((c) => c.pass).length}/${checks.length}` : null,
    decision: last?.decision ?? null,
    stages,
  };
}

const streams: Array<Record<string, unknown>> = [];
const base = process.env.SCOS_URL?.replace(/\/$/, "");
if (!base) console.log("SCOS_URL not set: skipping deployed session streams");
for (const id of base ? ids : []) {
  try {
    // Streams can stay open (long-poll); read incrementally until EOF or a 25 s deadline.
    const ctl = new AbortController();
    const res = await fetch(`${base}/eve/v1/session/${id}/stream`, { signal: ctl.signal });
    let text = "";
    let timedOut = false;
    if (res.body) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      const deadline = Date.now() + 25_000;
      for (;;) {
        const left = deadline - Date.now();
        if (left <= 0) { timedOut = true; break; }
        const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), left))]);
        if (chunk === null) { timedOut = true; break; }
        if (chunk.done) break;
        text += dec.decode(chunk.value, { stream: true });
      }
      ctl.abort();
    }
    if (!res.ok) {
      let code: string | null = null;
      try { code = (JSON.parse(text) as { code?: string }).code ?? null; } catch { /* not json */ }
      streams.push({ id, available: false, http_status: res.status, reason: code ?? text.slice(0, 120) });
      continue;
    }
    const events = text.split("\n").map((l) => l.trim()).filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Ev]; } catch { return []; } });
    if (!events.length) { streams.push({ id, available: false, http_status: res.status, reason: timedOut ? "stream open but no events within 25 s" : "empty stream" }); continue; }
    streams.push({ available: true, http_status: res.status, ...summarizeStream(id, events) });
  } catch (err) {
    streams.push({ id, available: false, http_status: null, reason: (err as Error).message.slice(0, 120) });
  }
}
for (const s of streams) console.log(s.id, s.available ? `ok wall ${s.wall_s}s attempts ${s.attempts}` : `unavailable (${s.http_status} ${s.reason})`);

// ---- local mission records
const statePath = process.env.STATE_FILE || join(REPO_ROOT, ".data", "state.json");
type Run = { mission_id: string | null; role: string; model: string; status: string; started_at: string; ended_at?: string | null; tokens_in: number; tokens_out: number; input?: { attempt?: number }; output?: { checks?: Array<{ id: string; pass: boolean }> } | null };
type Mission = { id: string; material_id: string | null; site_id: string | null; status: string; created_at: string; trigger: string };
const local: Array<Record<string, unknown>> = [];
if (existsSync(statePath)) {
  const st = JSON.parse(readFileSync(statePath, "utf8")) as { missions: Mission[]; agent_runs: Run[] };
  for (const m of st.missions) {
    const runs = st.agent_runs.filter((r) => r.mission_id === m.id).sort((a, b) => a.started_at.localeCompare(b.started_at));
    const t0 = Date.parse(m.created_at);
    const ends = runs.map((r) => Date.parse(r.ended_at ?? r.started_at)).filter(Number.isFinite);
    const verifier = runs.filter((r) => r.role === "verifier");
    const lastChecks = verifier.at(-1)?.output?.checks ?? [];
    const tin = runs.reduce((s, r) => s + (r.tokens_in || 0), 0);
    const tout = runs.reduce((s, r) => s + (r.tokens_out || 0), 0);
    local.push({
      id: m.id,
      source: "local store (agent_runs)",
      material_id: m.material_id,
      site_id: m.site_id,
      status: m.status,
      trigger: m.trigger,
      wall_s: ends.length ? r2((Math.max(...ends) - t0) / 1000) : null,
      attempts: verifier.length,
      sub_agent_runs: runs.filter((r) => r.role !== "verifier").length,
      roles: [...new Set(runs.map((r) => r.role))],
      tokens_in: tin,
      tokens_out: tout,
      tokens_note: tin + tout === 0 ? "not recorded by this build (verifier runs record tokens as 0)" : null,
      checks_passed: lastChecks.length ? `${lastChecks.filter((c) => c.pass).length}/${lastChecks.length}` : null,
      checks: lastChecks,
      stages: [
        { stage: "planned", attempt: null, t_s: 0 },
        ...verifier.map((r, i) => ({ stage: "verified", attempt: r.input?.attempt ?? i + 1, t_s: r2((Date.parse(r.ended_at ?? r.started_at) - t0) / 1000), pass: (r.output?.checks ?? []).filter((c) => c.pass).length, of: (r.output?.checks ?? []).length })),
      ],
    });
  }
}
for (const l of local) console.log(`local ${l.id} ${l.material_id}@${l.site_id} wall ${l.wall_s}s attempts ${l.attempts} checks ${l.checks_passed}`);

const all = [...streams.filter((s) => s.available), ...local] as Array<{ wall_s: number | null; attempts: number | null }>;
const walls = all.map((m) => m.wall_s).filter((x): x is number => x != null);
writeResult("b6-missions", {
  method: {
    missions_file: "docs/evals/missions.txt",
    endpoint: base ? `${base}/eve/v1/session/<id>/stream` : null,
    events_used: ["agent.started (sub-agent count)", "action.partial stage planned / branches_done / verified (timeline, attempts, checks)", "step.completed usage (tokens)"],
    local_source: statePath.replace(REPO_ROOT, "<repo>"),
    gate_b6: ">= 9 of 10 hero runs complete (not measurable from available data)",
    gate_b8: "p95 time to the text alert < 90 s",
  },
  streams,
  local_missions: local,
  summary: {
    streams_requested: base ? ids.length : 0,
    streams_available: streams.filter((s) => s.available).length,
    missions_measured: all.length,
    wall_s_p50: percentile(walls, 50),
    wall_s_p95: percentile(walls, 95),
    gate_b8_p95_under_90s: walls.length ? (percentile(walls, 95) ?? Infinity) < 90 : null,
  },
});
