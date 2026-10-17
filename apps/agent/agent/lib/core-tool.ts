import { runTool, toolsByName, type ToolResult } from "@supply-agent/core";
import { defineTool } from "eve/tools";
import { withStore } from "./store.ts";

/**
 * Wraps a host-compatible core tool (ToolOutput + citations) as an eve tool.
 * The file name under tools/ must equal the core tool name.
 */
export function coreTool(name: string, role = "agent") {
  const tool = toolsByName[name];
  if (!tool) throw new Error(`unknown core tool: ${name}`);
  return defineTool({
    description: tool.description,
    inputSchema: tool.inputSchema,
    async execute(input: unknown): Promise<ToolResult> {
      return withStore(
        (store) => runTool(tool, { organizationId: "corvane", role, filters: {}, store }, input),
        { write: !tool.idempotent },
      );
    },
  });
}
