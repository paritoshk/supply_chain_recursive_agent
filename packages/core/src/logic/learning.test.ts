import { describe, expect, it } from "vitest";
import { runSimulation } from "../sim/simulate.ts";
import { createStore } from "../store.ts";
import { runTool, toolsByName, type ToolCtx } from "../tools/index.ts";
import { reliabilityBelief, type Observation } from "./learning.ts";
import { CORVANE_PROFILE, evaluateOption, LEAN_GENERICS_PROFILE, rankOptions } from "./risk.ts";

const link = { supplier_id: "SUP-X", otd_pct: 92, lead_time_variance_days: 4, rejection_rate: 0.005 };
const obs = (n: number, late: number, day = 100, qc = true): Observation[] =>
  Array.from({ length: n }, () => ({ supplier_id: "SUP-X", day, late_days: late, qc_passed: qc }));

describe("reliability belief", () => {
  it("starts at the stated metrics and moves toward observed deliveries", () => {
    const prior = reliabilityBelief(link, [], 100);
    expect(prior.on_time.mean).toBeCloseTo(0.92, 2);
    expect(prior.observations).toBe(0);
    const late = reliabilityBelief(link, obs(10, 20), 100);
    expect(late.on_time.mean).toBeLessThan(0.45);
    expect(late.late_days_mean).toBeGreaterThan(15);
    expect(late.on_time_shift_pp).toBeLessThan(-40);
    expect(late.qa_review).toMatch(/QA supplier review/);
  });

  it("ignores other suppliers and weighs old outcomes less", () => {
    expect(reliabilityBelief(link, [{ supplier_id: "SUP-Y", day: 100, late_days: 30, qc_passed: false }], 100).observations).toBe(0);
    const recent = reliabilityBelief(link, obs(5, 20, 100), 100);
    const old = reliabilityBelief(link, obs(5, 20, 100 - 720), 100);
    expect(old.on_time.mean).toBeGreaterThan(recent.on_time.mean);
  });

  it("unknown metrics give a wider interval, not a fixed half credit", () => {
    const known = reliabilityBelief(link, [], 0);
    const unknown = reliabilityBelief({ supplier_id: "SUP-X", otd_pct: null, lead_time_variance_days: null, rejection_rate: null }, [], 0);
    expect(unknown.on_time.hi90 - unknown.on_time.lo90).toBeGreaterThan(known.on_time.hi90 - known.on_time.lo90);
  });

  it("QC failures lower the QC pass belief", () => {
    expect(reliabilityBelief(link, obs(10, 0, 100, false), 100).qc_pass.mean).toBeLessThan(0.8);
  });
});

describe("risk-adjusted ranking", () => {
  const steady = reliabilityBelief({ supplier_id: "FAST", otd_pct: 95, lead_time_variance_days: 3, rejection_rate: 0.005 }, [], 0);
  const shaky = reliabilityBelief({ supplier_id: "CHEAP", otd_pct: 85, lead_time_variance_days: 6, rejection_rate: 0.01 }, [], 0);
  const fast = { id: "FAST", supplier_id: "FAST", unit_cost_usd: 130, qty: 1000, lead_days: 20 };
  const cheap = { id: "CHEAP", supplier_id: "CHEAP", unit_cost_usd: 100, qty: 1000, lead_days: 30 };
  const pick = (days: number, profile = CORVANE_PROFILE) => {
    const need = { days_available: days, daily_value_usd: 1000, qc_release_days: 0 };
    return rankOptions([evaluateOption(fast, steady, need, profile), evaluateOption(cheap, shaky, need, profile)])[0]!.supplier_id;
  };

  it("is deterministic", () => {
    const need = { days_available: 34, daily_value_usd: 1000 };
    expect(evaluateOption(cheap, shaky, need, CORVANE_PROFILE)).toEqual(evaluateOption(cheap, shaky, need, CORVANE_PROFILE));
  });

  it("depends on the deadline: tight picks the fast supplier, loose picks the cheap one", () => {
    expect(pick(32)).toBe("FAST");
    expect(pick(120)).toBe("CHEAP");
  });

  it("depends on the client: a risk-averse biologics client pays for reliability, a lean client does not", () => {
    expect(pick(34, CORVANE_PROFILE)).toBe("FAST");
    expect(pick(34, LEAN_GENERICS_PROFILE)).toBe("CHEAP");
  });

  it("learning flips the ranking once a supplier keeps slipping", () => {
    const need = { days_available: 120, daily_value_usd: 1000, qc_release_days: 0 };
    const learned = reliabilityBelief({ supplier_id: "CHEAP", otd_pct: 85, lead_time_variance_days: 6, rejection_rate: 0.01 }, Array.from({ length: 12 }, () => ({ supplier_id: "CHEAP", day: 0, late_days: 100, qc_passed: true })), 0);
    expect(rankOptions([evaluateOption(fast, steady, need, CORVANE_PROFILE), evaluateOption(cheap, shaky, need, CORVANE_PROFILE)])[0]!.supplier_id).toBe("CHEAP");
    expect(rankOptions([evaluateOption(fast, steady, need, CORVANE_PROFILE), evaluateOption(cheap, learned, need, CORVANE_PROFILE)])[0]!.supplier_id).toBe("FAST");
  });
});

describe("learning in the simulator (synthetic, suppliers that overstate reliability)", () => {
  const seeds = [1, 2, 3];
  const runs = (policy: "agent_risk" | "agent_learning") => seeds.map((seed) => runSimulation({ policy, seed, days: 360, supplierTruth: "drifted" }));
  const risk = runs("agent_risk");
  const learning = runs("agent_learning");
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  it("beliefs get closer to the hidden truth than the stated metrics", () => {
    for (const r of learning) expect(r.reliability.belief_error_pp!).toBeLessThan(r.reliability.prior_error_pp!);
  });

  it("shifts orders away from suppliers that overstate reliability", () => {
    expect(sum(learning.map((r) => r.reliability.overstated_order_share.second_half!))).toBeLessThan(sum(risk.map((r) => r.reliability.overstated_order_share.second_half!)));
  });

  it("never orders from non-qualified suppliers and raises QA flags instead of disqualifying", () => {
    for (const r of [...risk, ...learning]) expect(r.metrics.non_qualified_orders).toBe(0);
    expect(sum(learning.map((r) => r.reliability.qa_review_flags.length))).toBeGreaterThan(0);
    expect(sum(risk.map((r) => r.reliability.qa_review_flags.length))).toBe(0);
  });
});

describe("learning tools", () => {
  it("record_delivery updates the belief that supplier_reliability reports", async () => {
    const store = createStore();
    const ctx: ToolCtx = { organizationId: "corvane", role: "planner", filters: {}, store };
    const link = store.materialSuppliers({ material_id: "MAT-SUC-INJ" }).find((l) => l.otd_pct != null && l.qualification_state === "released_for_use")!;
    const read = async () => {
      const out = await runTool(toolsByName.supplier_reliability!, ctx, { material_id: "MAT-SUC-INJ", site_id: "SITE-GHE" });
      return (out.suppliers as Array<{ supplier_id: string; reliability: { learned_on_time: number; deliveries_observed: number } }>).find((s) => s.supplier_id === link.supplier_id)!;
    };
    const before = await read();
    for (let k = 0; k < 6; k++) {
      await runTool(toolsByName.record_delivery!, ctx, { supplier_id: link.supplier_id, material_id: "MAT-SUC-INJ", site_id: "SITE-GHE", promised_date: "2026-09-01", received_date: "2026-09-25", qc_passed: true });
    }
    const after = await read();
    expect(after.reliability.deliveries_observed).toBe(6);
    expect(after.reliability.learned_on_time).toBeLessThan(before.reliability.learned_on_time - 0.3);
    expect(store.materialSuppliers({ material_id: "MAT-SUC-INJ", supplier_id: link.supplier_id })[0]!.qualification_state).toBe("released_for_use");
  });
});
