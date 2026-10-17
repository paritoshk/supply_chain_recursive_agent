import { defineAgent } from "eve";
import { CONTEXT_WINDOW, workerModel } from "../../lib/models.ts";

export default defineAgent({
  description: "Sources a shortage from approved suppliers: drafts the RFQ, runs one negotiator per supplier, and compares normalized quotes.",
  model: workerModel(),
  modelContextWindowTokens: CONTEXT_WINDOW,
  tool: false,
});
