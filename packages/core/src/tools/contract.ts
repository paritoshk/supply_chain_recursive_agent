import type { z } from "zod";
import type { Store } from "../store.ts";
import { ToolOutput, type AgentRole, type Filters } from "../types.ts";

export interface ToolCtx {
  organizationId: string;
  role: AgentRole | (string & {});
  filters: Filters;
  store: Store;
}

export type ToolResult = ToolOutput & Record<string, unknown>;

/**
 * Tool contract (host-platform compatible): snake_case verb names, Zod input schema,
 * output = ToolOutput & {...}. Writing tools are flagged `idempotent: false`.
 */
export interface ToolDef<I extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  idempotent: boolean;
  inputSchema: I;
  run(ctx: ToolCtx, args: z.infer<I>): Promise<ToolResult>;
}

export function defineTool<I extends z.ZodType>(def: ToolDef<I>): ToolDef<I> {
  if (!/^[a-z]+(_[a-z]+)*$/.test(def.name)) throw new Error(`tool name must be snake_case: ${def.name}`);
  return def;
}

/** Validates args, runs the tool, validates the ToolOutput envelope. */
export async function runTool(tool: ToolDef, ctx: ToolCtx, rawArgs: unknown): Promise<ToolResult> {
  const args = tool.inputSchema.parse(rawArgs ?? {});
  const out = await tool.run(ctx, args);
  ToolOutput.parse(out);
  return out;
}

export function featureDisabled(source: string, todo: string): ToolResult {
  return { ingestion_status: "feature_disabled", source, citations: [], todo };
}
