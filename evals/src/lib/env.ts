/**
 * Import FIRST in every benchmark script: loads <repo>/.env and pins the Crusoe client's process-wide
 * concurrency before @supply-agent/core creates its limiter (it reads CRUSOE_CONCURRENCY at import time).
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const envFile = join(REPO_ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
process.env.CRUSOE_CONCURRENCY = process.env.EVAL_CONCURRENCY || "4";
