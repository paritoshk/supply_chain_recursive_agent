import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

/**
 * Every model runs on Crusoe Managed Inference (OpenAI-compatible Chat Completions).
 * Doers and the judge are deliberately different models: the verifier never grades its own work.
 */
const crusoe = createOpenAICompatible({
  name: "crusoe",
  baseURL: (process.env.CRUSOE_BASE_URL ?? "https://api.inference.crusoecloud.com/v1").replace(/\/$/, ""),
  apiKey: process.env.CRUSOE_API_KEY,
  includeUsage: true,
});

export const MODELS = {
  planner: process.env.MODEL_PLANNER || "nvidia/NVIDIA-Nemotron-3.5-Super-VL",
  worker: process.env.MODEL_WORKER || "nvidia/NVIDIA-Nemotron-3.5-Super-VL",
  verifier: process.env.MODEL_VERIFIER || "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B",
} as const;

export const plannerModel = () => crusoe(MODELS.planner);
export const workerModel = () => crusoe(MODELS.worker);
export const verifierModel = () => crusoe(MODELS.verifier);

export const CONTEXT_WINDOW = 262_144;
