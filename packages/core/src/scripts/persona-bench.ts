/**
 * Persona model latency bench: same supplier-persona prompt against each candidate, N runs,
 * reports p50/max latency and how many replies parsed as the expected JSON shape.
 * Usage: pnpm --filter @supply-agent/core bench:persona [runs]
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chat } from "../crusoe.ts";
import { parsePersonaJson } from "../negotiation.ts";

const envFile = join(import.meta.dirname, "../../../../.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const CANDIDATES = ["nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B", "nvidia/Nemotron-3.5-Lightning-30B-A3B"];
const runs = Number(process.argv[2]) || 3;
const thinking = process.argv.includes("--thinking");

const messages = [
  {
    role: "system" as const,
    content:
      "You are a sales rep at a fictional excipient manufacturer replying to a buyer's RFQ. Private terms: list price 21.00 USD/kg, " +
      "you may go as low as 19.20, lead time 42 days, MOQ 100 kg, incoterm FCA. Reply ONLY with a JSON object: " +
      '{"reply": string (2-3 sentences, in character), "offer": {"unit_price": number, "currency": "USD", "incoterm": string, "lead_time_days": integer, "moq": number, "valid_until": "YYYY-MM-DD"}}',
  },
  { role: "user" as const, content: "RFQ-102: 300 kg injectable sucrose, need by 2026-11-28, DAP Ghent. Can you do 18 USD/kg?" },
];

for (const model of CANDIDATES) {
  const lat: number[] = [];
  let valid = 0;
  for (let i = 0; i < runs; i++) {
    try {
      const r = await chat({ model, messages, max_tokens: 1024, temperature: 0.4, response_format: { type: "json_object" }, maxRetries: 2, ...(thinking ? {} : { chat_template_kwargs: { enable_thinking: false } }) });
      lat.push(r.latency_ms);
      if (parsePersonaJson(r.content)) valid++;
    } catch (err) {
      console.log(`${model} run ${i}: ${(err as Error).message.slice(0, 160)}`);
    }
  }
  lat.sort((a, b) => a - b);
  console.log(
    `${model} (thinking ${thinking ? "on" : "off"}): runs=${runs} ok=${lat.length} valid_json=${valid} p50=${lat[Math.floor(lat.length / 2)] ?? "-"}ms max=${lat.at(-1) ?? "-"}ms all=[${lat.join(",")}]`,
  );
}
