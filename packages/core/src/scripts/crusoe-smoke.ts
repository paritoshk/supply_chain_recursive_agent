/** Smoke test: lists Crusoe models. Requires CRUSOE_API_KEY (reads ../../.env if present). */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { listModels } from "../crusoe.ts";

const envFile = join(import.meta.dirname, "../../../../.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const models = await listModels();
console.log(`${models.length} models:\n${models.join("\n")}`);
