import { defineAgent } from "eve";
import { CONTEXT_WINDOW, verifierModel } from "../../lib/models.ts";

export default defineAgent({
  description: "Independent judge. Grades a mission result against its definition of done and re-checks every number with tools.",
  model: verifierModel(),
  modelContextWindowTokens: CONTEXT_WINDOW,
  tool: false,
  reasoning: "low",
});
