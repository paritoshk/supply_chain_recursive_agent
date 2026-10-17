/** Fault injection flags: FAULTS=persona_timeout,crusoe_429,bad_tool_json */
export type Fault = "persona_timeout" | "crusoe_429" | "bad_tool_json";

export function activeFaults(env: string | undefined = process.env.FAULTS): Set<Fault> {
  return new Set((env ?? "").split(",").map((s) => s.trim()).filter(Boolean) as Fault[]);
}

export function faultEnabled(f: Fault): boolean {
  return activeFaults().has(f);
}
