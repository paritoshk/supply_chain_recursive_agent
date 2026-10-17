/**
 * OpenAI-compatible tool definitions built from the core Zod schemas (z.toJSONSchema), the same
 * contracts the eve agent exposes, plus the run_mission workflow tool (schema mirrored from
 * apps/agent/agent/tools/run_mission.ts).
 */
import { allTools, toolsByName, type ToolDef } from "@supply-agent/core";
import { z } from "zod";

export const RUN_MISSION = {
  name: "run_mission",
  description:
    "Run a stockout-prevention mission for one material at one site. Writes the definition of done, fans out to transfer, sourcing (one negotiator per supplier) and scout sub-agents in parallel, checks the numbers in code, has an independent judge model check grounding, re-plans on failure, and asks the human only when a decision exceeds authority.",
  inputSchema: z.object({
    material_id: z.string().describe("e.g. MAT-SUC-INJ"),
    site_id: z.string().describe("e.g. SITE-GHE"),
    trigger: z.string().default("sentinel"),
  }),
};

export type OpenAITool = { type: "function"; function: { name: string; description: string; parameters: unknown } };

function jsonSchema(schema: z.ZodType): unknown {
  const s = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete s.$schema;
  return s;
}

export function openAITools(names?: string[]): OpenAITool[] {
  const defs: Array<{ name: string; description: string; inputSchema: z.ZodType }> = [
    ...(allTools as ToolDef[]).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    RUN_MISSION,
  ];
  return defs
    .filter((d) => !names || names.includes(d.name))
    .map((d) => ({ type: "function", function: { name: d.name, description: d.description, parameters: jsonSchema(d.inputSchema) } }));
}

/** Zod-validates model-proposed arguments against the real tool schema. */
export function validateArgs(name: string, args: unknown): { ok: boolean; error?: string } {
  const schema = name === "run_mission" ? RUN_MISSION.inputSchema : toolsByName[name]?.inputSchema;
  if (!schema) return { ok: false, error: `unknown tool ${name}` };
  const r = schema.safeParse(args ?? {});
  return r.success ? { ok: true } : { ok: false, error: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 200) };
}
