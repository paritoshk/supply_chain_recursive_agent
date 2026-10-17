/**
 * Thin wrapper over the core Crusoe client: a per-model request pacer (stays under the 30 RPM/model
 * no-card limit), usage + cost ledger, and errors captured instead of thrown.
 */
import { chat, type ChatRequest, type ChatResult } from "@supply-agent/core/crusoe";
import { PRICES } from "./models.ts";
import { r4 } from "./stats.ts";

const RPM = Number(process.env.EVAL_RPM_PER_MODEL) || 26;
const nextSlot = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reserves the next start slot for a model so request starts are >= 60/RPM seconds apart. */
export async function pace(model: string) {
  const gap = 60_000 / RPM;
  const now = Date.now();
  const slot = Math.max(now, nextSlot.get(model) ?? 0);
  nextSlot.set(model, slot + gap);
  if (slot > now) await sleep(slot - now);
}

export interface Usage {
  calls: number;
  errors: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  attempts: number;
}

const ledger = new Map<string, Usage>();

export function costOf(model: string, tin: number, tout: number): number {
  const p = PRICES[model] ?? { in: 0.3, out: 2.4 };
  return (tin * p.in + tout * p.out) / 1e6;
}

function book(model: string, r: ChatResult | null, error: boolean) {
  const u = ledger.get(model) ?? { calls: 0, errors: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0, attempts: 0 };
  u.calls += 1;
  if (error) u.errors += 1;
  if (r) {
    u.tokens_in += r.tokens_in;
    u.tokens_out += r.tokens_out;
    u.cost_usd += costOf(model, r.tokens_in, r.tokens_out);
    u.attempts += r.attempts;
  }
  ledger.set(model, u);
}

export type CallResult = { ok: true; r: ChatResult } | { ok: false; error: string; latency_ms: number };

/** Circuit breaker: after this many consecutive failures a model is skipped for the rest of the run. */
const BREAKER = Number(process.env.EVAL_BREAKER) || 4;
const consecutiveFails = new Map<string, number>();
export const unavailable = (model: string) => (consecutiveFails.get(model) ?? 0) >= BREAKER;

export async function call(req: ChatRequest & { model: string }): Promise<CallResult> {
  if (unavailable(req.model)) return { ok: false, error: "skipped: model unavailable (circuit breaker open after repeated 429/errors)", latency_ms: 0 };
  await pace(req.model);
  const t0 = Date.now();
  try {
    const r = await chat({ maxRetries: 6, timeoutMs: 120_000, ...req });
    book(req.model, r, false);
    consecutiveFails.set(req.model, 0);
    return { ok: true, r };
  } catch (err) {
    book(req.model, null, true);
    consecutiveFails.set(req.model, (consecutiveFails.get(req.model) ?? 0) + 1);
    return { ok: false, error: (err as Error).message.slice(0, 300), latency_ms: Date.now() - t0 };
  }
}

export function usageReport(): { by_model: Record<string, Usage>; total_cost_usd: number; total_calls: number } {
  const by_model: Record<string, Usage> = {};
  let total = 0;
  let calls = 0;
  for (const [m, u] of ledger) {
    by_model[m] = { ...u, cost_usd: r4(u.cost_usd) };
    total += u.cost_usd;
    calls += u.calls;
  }
  return { by_model, total_cost_usd: r4(total), total_calls: calls };
}

/** Pulls the first JSON object out of a model reply (tolerates fences and prose). */
export function parseJsonLoose<T = Record<string, unknown>>(text: string | null | undefined): T | null {
  if (!text) return null;
  const t = text.replace(/```(?:json)?/gi, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/** Run async jobs with a fixed concurrency, preserving order. */
export async function pool<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}
