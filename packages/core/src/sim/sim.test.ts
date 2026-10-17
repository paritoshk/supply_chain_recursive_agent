import { describe, expect, it } from "vitest";
import { buildSimReport, renderSimMarkdown } from "./report.ts";
import { compareSimulation, runSimulation } from "./simulate.ts";

describe("simulation (synthetic)", () => {
  const c = compareSimulation(1729, 90);

  it("is deterministic for a seed", () => {
    expect(runSimulation({ policy: "agent", seed: 1729 })).toEqual(c.agent);
    expect(runSimulation({ policy: "baseline", seed: 1729 })).toEqual(c.baseline);
    expect(runSimulation({ policy: "agent", seed: 7 }).metrics).not.toEqual(c.agent.metrics);
  });

  it("never orders from non-qualified suppliers", () => {
    expect(c.agent.metrics.non_qualified_orders).toBe(0);
    expect(c.baseline.metrics.non_qualified_orders).toBe(0);
  });

  it("agent: fewer stockouts and far fewer human minutes than the manual baseline", () => {
    expect(c.agent.metrics.stockout_days).toBeLessThan(c.baseline.metrics.stockout_days);
    expect(c.agent.metrics.stockout_events).toBeLessThanOrEqual(c.baseline.metrics.stockout_events);
    expect(c.agent.metrics.human_minutes).toBeLessThan(c.baseline.metrics.human_minutes / 10);
    expect(c.agent.metrics.service_level_pct).toBeGreaterThanOrEqual(c.baseline.metrics.service_level_pct);
  });

  it("hero: incumbent slip causes a baseline stockout the agent avoids", () => {
    expect(c.baseline.hero.stockout_days).toBeGreaterThan(0);
    expect(c.agent.hero.stockout_days).toBe(0);
    expect(c.baseline.hero.events.some((e) => e.kind === "order" && e.detail.includes("lead 70 d"))).toBe(true);
  });

  it("human minutes follow the models", () => {
    expect(c.agent.metrics.human_minutes).toBe(c.agent.metrics.approval_pings * 3);
    expect(c.baseline.metrics.approval_pings).toBe(0);
  });

  it("report is labelled synthetic", () => {
    const r = buildSimReport(1729, [1, 2], 30);
    const md = renderSimMarkdown(r);
    expect(md).toMatch(/SYNTHETIC SIMULATION/);
    expect(md).toMatch(/Supplier Chief of Staff/);
  });
});
