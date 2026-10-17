/** Runs every benchmark in sequence, then the summary and the plots. Usage: pnpm --filter @supply-agent/evals run all */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const here = import.meta.dirname;
const steps: Array<[string, string[]]> = [
  ["b1", ["tsx", join(here, "b1-tools.ts")]],
  ["b3", ["tsx", join(here, "b3-guardrails.ts")]],
  ["b4", ["tsx", join(here, "b4-spec.ts")]],
  ["b5", ["tsx", join(here, "b5-discovery.ts")]],
  ["b5b", ["tsx", join(here, "b5b-negotiation.ts")]],
  ["b6", ["tsx", join(here, "b6-missions.ts")]],
  ["summary", ["tsx", join(here, "summary.ts")]],
  ["plot", ["python3", "-I", join(here, "..", "plot", "plot.py")]],
];
const only = process.argv.slice(2);
const t0 = Date.now();
for (const [name, [cmd, ...args]] of steps) {
  if (only.length && !only.includes(name)) continue;
  console.log(`\n=== ${name}`);
  const r = spawnSync(cmd!, args, { stdio: "inherit", env: process.env });
  if (r.status !== 0) console.error(`${name} exited ${r.status}; continuing`);
}
console.log(`\nall done in ${Math.round((Date.now() - t0) / 1000)} s`);
