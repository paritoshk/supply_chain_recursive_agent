/** Candidate models (all Crusoe serverless) and list prices in USD per 1M tokens (GET /v1/models, 2026-10-17). */
export const DOER = "nvidia/NVIDIA-Nemotron-3.5-Super-VL";
export const JUDGE = "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B";
export const PERSONA = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B";
export const LIGHTNING = "nvidia/Nemotron-3.5-Lightning-30B-A3B";

export const PRICES: Record<string, { in: number; out: number }> = {
  [DOER]: { in: 0.1, out: 0.4 },
  [JUDGE]: { in: 0.3, out: 2.4 },
  [PERSONA]: { in: 0.05, out: 0.2 },
  [LIGHTNING]: { in: 0.05, out: 0.2 },
};

export const SHORT: Record<string, string> = {
  [DOER]: "Super-VL (doer)",
  [JUDGE]: "Super-120B (judge)",
  [PERSONA]: "Nano-30B (persona)",
  [LIGHTNING]: "Lightning-30B",
};

/** Models benchmarked as doers/classifiers. INKLING_MODEL (a self-serve deployment alias) is added when set. */
export function candidates(): string[] {
  const list = [DOER, JUDGE, PERSONA, LIGHTNING];
  const inkling = process.env.INKLING_MODEL?.trim();
  if (inkling) {
    list.push(inkling);
    SHORT[inkling] ??= "Inkling-Small";
  }
  const only = process.env.EVAL_MODELS?.split(",").map((s) => s.trim()).filter(Boolean);
  return only?.length ? list.filter((m) => only.some((o) => m.includes(o))) : list;
}

export const short = (m: string) => SHORT[m] ?? m.split("/").pop() ?? m;

/** Independent judge: never the model under test. */
export const judgeFor = (subject: string) => (subject === JUDGE ? DOER : JUDGE);
