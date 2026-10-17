import { defineAgent } from "eve";
import { CONTEXT_WINDOW, plannerModel } from "./lib/models.ts";

export default defineAgent({
  model: plannerModel(),
  modelContextWindowTokens: CONTEXT_WINDOW,
  limits: {
    maxTokenCostUsdPerSession: 2,
  },
});
