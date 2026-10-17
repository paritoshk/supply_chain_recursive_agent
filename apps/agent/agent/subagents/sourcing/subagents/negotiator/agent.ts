import { defineAgent } from "eve";
import { CONTEXT_WINDOW, workerModel } from "../../../../lib/models.ts";

export default defineAgent({
  description: "Negotiates one RFQ with one supplier over several turns, then accepts the best offer that meets the need-by date.",
  model: workerModel(),
  modelContextWindowTokens: CONTEXT_WINDOW,
});
