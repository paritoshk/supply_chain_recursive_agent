import { defineAgent } from "eve";
import { CONTEXT_WINDOW, workerModel } from "../../lib/models.ts";

export default defineAgent({
  description: "Finds internal stock transfers from sister sites with surplus to cover a shortage.",
  model: workerModel(),
  modelContextWindowTokens: CONTEXT_WINDOW,
  tool: false,
});
