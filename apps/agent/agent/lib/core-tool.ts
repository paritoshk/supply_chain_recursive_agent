import { runTool, toolsByName, type ToolResult } from "@supply-agent/core";
import { defineTool } from "eve/tools";
import { withStore, withStoreBoardOnly } from "./store.ts";

/**
 * Wraps a host-compatible core tool (ToolOutput + citations) as an eve tool.
 * The file name under tools/ must equal the core tool name.
 * Tools flagged `writes: "board"` persist only the evidence-board items they add.
 */
export function coreTool(name: string, role = "agent") {
  const tool = toolsByName[name];
  if (!tool) throw new Error(`unknown core tool: ${name}`);
  return defineTool({
    description: tool.description,
    inputSchema: tool.inputSchema,
    async execute(input: unknown): Promise<ToolResult> {
      const run = (store: Parameters<Parameters<typeof withStore>[0]>[0]) =>
        runTool(tool, { organizationId: "corvane", role, filters: {}, store }, input);
      if (tool.writes === "board") return withStoreBoardOnly(run);
      return withStore(run, { write: !tool.idempotent });
    },
  });
}
