/**
 * Minimal OpenAI-compatible client for Crusoe inference: backoff + jitter on 429/503,
 * process-wide concurrency limit, model chosen per role from env.
 */
import { createOpenAI } from "@ai-sdk/openai";
import pLimit from "p-limit";
import { faultEnabled } from "./faults.ts";

export type ModelRole = "planner" | "worker" | "persona" | "verifier";

export const DEFAULT_BASE_URL = "https://api.inference.crusoecloud.com/v1";
const ROLE_ENV: Record<ModelRole, string> = {
  planner: "MODEL_PLANNER",
  worker: "MODEL_WORKER",
  persona: "MODEL_PERSONA",
  verifier: "MODEL_VERIFIER",
};
/**
 * Nemotron on Crusoe serverless. The verifier deliberately differs from the planner/worker model
 * (the judge must not be the doer). Override any role with MODEL_<ROLE>; MODEL_VERIFIER can later
 * point at a self-serve deployment alias.
 */
export const ROLE_DEFAULT: Record<ModelRole, string> = {
  planner: "nvidia/NVIDIA-Nemotron-3.5-Super-VL",
  worker: "nvidia/NVIDIA-Nemotron-3.5-Super-VL",
  persona: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
  verifier: "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B",
};

export function modelFor(role: ModelRole): string {
  return process.env[ROLE_ENV[role]] || ROLE_DEFAULT[role];
}

function config() {
  const apiKey = process.env.CRUSOE_API_KEY;
  if (!apiKey) throw new Error("CRUSOE_API_KEY is not set");
  return { apiKey, baseURL: (process.env.CRUSOE_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "") };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** Explicit model id; otherwise resolved from `role`. */
  model?: string;
  role?: ModelRole;
  tools?: Array<{ type: "function"; function: { name: string; description?: string; parameters: unknown } }>;
  tool_choice?: "auto" | "none" | "required";
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: "json_object" | "text" };
  /** e.g. Nemotron `{ enable_thinking: false }` (direct answers, lower latency) or `{ force_nonempty_content: true }`. */
  chat_template_kwargs?: Record<string, unknown>;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface ChatResult {
  model: string;
  content: string | null;
  /** Reasoning trace when the model emits one (Nemotron returns `message.reasoning`). */
  reasoning: string | null;
  tool_calls: NonNullable<ChatMessage["tool_calls"]>;
  finish_reason: string | null;
  tokens_in: number;
  tokens_out: number;
  latency_ms: number;
  attempts: number;
  /** From x-ratelimit-remaining-* response headers (null when absent). */
  rate_limit: { remaining_requests: number | null; remaining_tokens: number | null };
  raw: unknown;
}

export class CrusoeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const limit = pLimit(Number(process.env.CRUSOE_CONCURRENCY) || 8);
const RETRYABLE = new Set([429, 503]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff with full jitter, honoring Retry-After when present. */
export function backoffMs(attempt: number, retryAfter?: string | null, baseMs = 500, capMs = 15_000): number {
  const ra = retryAfter ? Number(retryAfter) : Number.NaN;
  if (Number.isFinite(ra) && ra >= 0) return Math.min(capMs, ra * 1000);
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

function numHeader(h: Headers | null, name: string): number | null {
  const v = h?.get(name);
  const n = v == null ? Number.NaN : Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function chat(req: ChatRequest): Promise<ChatResult> {
  const { apiKey, baseURL } = config();
  const model = req.model ?? modelFor(req.role ?? "worker");
  const maxRetries = req.maxRetries ?? 4;
  const body = JSON.stringify({
    model,
    messages: req.messages,
    ...(req.tools ? { tools: req.tools, tool_choice: req.tool_choice ?? "auto" } : {}),
    ...(req.temperature != null ? { temperature: req.temperature } : {}),
    ...(req.max_tokens != null ? { max_tokens: req.max_tokens } : {}),
    ...(req.response_format ? { response_format: req.response_format } : {}),
    ...(req.chat_template_kwargs ? { chat_template_kwargs: req.chat_template_kwargs } : {}),
  });

  return limit(async () => {
    const started = Date.now();
    let injected429 = faultEnabled("crusoe_429");
    for (let attempt = 0; ; attempt++) {
      let status: number;
      let retryAfter: string | null = null;
      let headers: Headers | null = null;
      let text: string;
      if (injected429) {
        injected429 = false;
        status = 429;
        text = "injected fault: crusoe_429";
      } else {
        try {
          const res = await fetch(`${baseURL}/chat/completions`, {
            method: "POST",
            headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
            body,
            signal: AbortSignal.timeout(req.timeoutMs ?? 60_000),
          });
          status = res.status;
          retryAfter = res.headers.get("retry-after");
          headers = res.headers;
          text = await res.text();
        } catch (err) {
          if (attempt >= maxRetries) throw err;
          await sleep(backoffMs(attempt));
          continue;
        }
      }
      if (status >= 200 && status < 300) {
        const json = JSON.parse(text) as {
          choices?: Array<{ message?: ChatMessage & { reasoning?: string; reasoning_content?: string }; finish_reason?: string }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const choice = json.choices?.[0];
        return {
          model,
          content: choice?.message?.content ?? null,
          reasoning: choice?.message?.reasoning ?? choice?.message?.reasoning_content ?? null,
          tool_calls: choice?.message?.tool_calls ?? [],
          finish_reason: choice?.finish_reason ?? null,
          tokens_in: json.usage?.prompt_tokens ?? 0,
          tokens_out: json.usage?.completion_tokens ?? 0,
          latency_ms: Date.now() - started,
          attempts: attempt + 1,
          rate_limit: {
            remaining_requests: numHeader(headers, "x-ratelimit-remaining-requests"),
            remaining_tokens: numHeader(headers, "x-ratelimit-remaining-tokens"),
          },
          raw: json,
        };
      }
      if (!RETRYABLE.has(status) || attempt >= maxRetries) {
        throw new CrusoeError(status, `Crusoe ${status}: ${text.slice(0, 500)}`);
      }
      await sleep(backoffMs(attempt, retryAfter));
    }
  });
}

export async function listModels(): Promise<string[]> {
  const { apiKey, baseURL } = config();
  const res = await fetch(`${baseURL}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new CrusoeError(res.status, `Crusoe ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { data?: Array<{ id: string }> };
  return (json.data ?? []).map((m) => m.id).sort();
}

/**
 * AI SDK provider for Crusoe. IMPORTANT: use `provider.chat(modelId)`, not `provider(modelId)`:
 * the default call targets the OpenAI Responses API, which Crusoe does not serve.
 */
export function createCrusoeProvider() {
  const { apiKey, baseURL } = config();
  return createOpenAI({ name: "crusoe", baseURL, apiKey });
}
