import { defineAgent } from "eve";
import { CONTEXT_WINDOW, workerModel } from "../../lib/models.ts";

export default defineAgent({
  description: "Discovers additional suppliers on the live web (You.com) and checks regulatory signals (openFDA). Results are discovery candidates only.",
  model: workerModel(),
  modelContextWindowTokens: CONTEXT_WINDOW,
});
