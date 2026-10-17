import type { ToolDef } from "./contract.ts";
import { dataTools } from "./data.ts";
import { learningTools } from "./learning.ts";
import { negotiationTools } from "./negotiation.ts";
import { productionTools } from "./production.ts";
import { stubTools } from "./stubs.ts";

export * from "./contract.ts";
export * from "./data.ts";
export * from "./stubs.ts";
export * from "./negotiation.ts";
export * from "./production.ts";
export * from "./learning.ts";
export { filteredPairs, positionFor, type Position } from "./position.ts";

export const allTools: ToolDef[] = [...dataTools, ...stubTools, ...negotiationTools, ...productionTools, ...learningTools] as ToolDef[];
export const toolsByName: Record<string, ToolDef> = Object.fromEntries(allTools.map((t) => [t.name, t]));
