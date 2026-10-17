import { execSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./env.ts";

export const RESULTS_DIR = join(REPO_ROOT, "docs", "evals", "results");

function gitSha(): string | null {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

type UsageLike = { by_model: Record<string, Record<string, number>>; total_cost_usd: number; total_calls: number };
function mergeUsage(a: UsageLike | undefined, b: UsageLike): UsageLike {
  if (!a) return b;
  const by_model: UsageLike["by_model"] = structuredClone(a.by_model);
  for (const [m, u] of Object.entries(b.by_model)) {
    const t = (by_model[m] ??= {});
    for (const [k, v] of Object.entries(u)) t[k] = Math.round(((t[k] ?? 0) + v) * 10_000) / 10_000;
  }
  return { by_model, total_cost_usd: Math.round((a.total_cost_usd + b.total_cost_usd) * 10_000) / 10_000, total_calls: a.total_calls + b.total_calls };
}

export function writeResult(name: string, body: Record<string, unknown>): string {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const file = join(RESULTS_DIR, `${name}.json`);
  // On resume, fold the previous run's usage into this file's usage so per-model cost stays complete.
  if (process.env.EVAL_RESUME === "1" && body.usage) body = { ...body, usage: mergeUsage(readResult<{ usage?: UsageLike }>(name)?.usage, body.usage as UsageLike) };
  const out = { benchmark: name, generated_at: new Date().toISOString(), git_sha: gitSha(), synthetic_data: true, ...body };
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  // Spend ledger across all runs (re-runs and resumes included), summed by the summary script.
  const usage = body.usage as { total_cost_usd?: number; total_calls?: number } | undefined;
  if (usage) appendFileSync(join(RESULTS_DIR, "spend-log.jsonl"), `${JSON.stringify({ benchmark: name, at: out.generated_at, cost_usd: usage.total_cost_usd ?? 0, calls: usage.total_calls ?? 0, resumed: process.env.EVAL_RESUME === "1" })}\n`);
  console.log(`wrote ${file}`);
  return file;
}

export function readResult<T = Record<string, unknown>>(name: string): T | null {
  const file = join(RESULTS_DIR, `${name}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : null;
}

export function readRepoFile(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

/**
 * EVAL_RESUME=1: reuse rows from the previous result file that have no error, so only failed
 * (e.g. 429 / capacity) rows are re-run. Key = model + case id.
 */
export function priorRows<R extends { model: string; id: string; error?: unknown }>(name: string): Map<string, R> {
  const m = new Map<string, R>();
  if (process.env.EVAL_RESUME !== "1") return m;
  const prev = readResult<{ rows?: R[] }>(name);
  for (const r of prev?.rows ?? []) if (!r.error) m.set(`${r.model}|${r.id}`, r);
  if (m.size) console.log(`resume: reusing ${m.size} rows from ${name}.json`);
  return m;
}
