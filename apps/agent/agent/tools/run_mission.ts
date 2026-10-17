import { runTool, toolsByName } from "@supply-agent/core";
import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import {
  AUTHORITY_LIMIT_USD,
  MAX_ATTEMPTS,
  evaluateChecks,
  finishMission,
  modelFor,
  prepareMission,
  recordRun,
  type CheckResult,
  type ComputedPlan,
  type MissionBrief,
} from "../lib/mission.ts";
import { withStore } from "../lib/store.ts";

const TransferOut = z.object({
  feasible: z.boolean(),
  from_site_id: z.string().nullable(),
  qty: z.number(),
  rationale: z.string(),
});

const SourcingOut = z.object({
  rfq_id: z.string().nullable(),
  recommended_supplier_id: z.string().nullable(),
  rationale: z.string(),
});

const ScoutOut = z.object({
  candidates: z.array(z.object({ name: z.string(), href: z.string(), evidence: z.string() })),
  regulatory_signal: z.string(),
});

const GroundedVerdict = z.object({
  grounded: z.boolean(),
  ungrounded_claims: z.array(z.string()),
  feedback: z.string(),
});

type Transfer = z.infer<typeof TransferOut>;
type Sourcing = z.infer<typeof SourcingOut>;
type Scout = z.infer<typeof ScoutOut>;
type Grounded = z.infer<typeof GroundedVerdict>;

/** Turns failed numeric checks into concrete instructions for the next attempt. */
function replanFeedback(checks: CheckResult[], plan: ComputedPlan): string {
  const failed = checks.filter((c) => !c.pass).map((c) => c.id);
  const notes: string[] = [];
  if (failed.includes("lands_in_time")) {
    notes.push(`No usable quote lands within ${plan.days_available} days. Ask every negotiator for its expedite option and accept the fastest offer that lands within ${plan.days_available} days.`);
  }
  if (failed.includes("comparable_quotes")) notes.push("Fewer than 2 usable quotes. Negotiate with every approved supplier, not just one.");
  if (failed.includes("covers_need")) notes.push("Secured quantity is short of the need. Quote the full remaining quantity.");
  if (failed.includes("qualified_only")) notes.push("Only quality_approved or released_for_use suppliers may be quoted.");
  return notes.join(" ");
}

export default defineWorkflowTool({
  description:
    "Run a stockout-prevention mission for one material at one site. Writes the definition of done, fans out to transfer, sourcing (one negotiator per supplier) and scout sub-agents in parallel, checks the numbers in code, has an independent judge model check grounding, re-plans on failure, and asks the human only when a decision exceeds authority.",
  inputSchema: z.object({
    material_id: z.string().describe("e.g. MAT-SUC-INJ"),
    site_id: z.string().describe("e.g. SITE-GHE"),
    trigger: z.string().default("sentinel"),
  }),
  async *execute({ material_id, site_id, trigger }, ctx) {
    "use workflow";
    const brief: MissionBrief = await prepareMission(material_id, site_id, trigger);
    yield { stage: "planned", mission_id: brief.mission_id, need_qty: brief.need_qty, need_by: brief.need_by, definition_of_done: brief.checks.map((c) => c.id) };

    let feedback = "";
    let attempt = 0;
    let transfer = null as Transfer | null;
    let sourcing = null as Sourcing | null;
    let scout = null as Scout | null;
    let checks: CheckResult[] = [];
    let plan = null as ComputedPlan | null;
    let grounded = null as Grounded | null;
    let decision: "accept" | "replan" | "escalate" = "escalate";
    const seen = new Set<string>();

    while (attempt < MAX_ATTEMPTS) {
      attempt += 1;
      const context = JSON.stringify({
        mission_id: brief.mission_id,
        material_id: brief.material_id,
        material_name: brief.material_name,
        site_id: brief.site_id,
        today: brief.today,
        need_qty: brief.need_qty,
        need_by: brief.need_by,
        position: brief.position,
        attempt,
        feedback: feedback || null,
      });
      // Loop guard: identical instructions twice means re-planning is not making progress.
      if (seen.has(feedback)) break;
      seen.add(feedback);

      const [t, s, sc] = await Promise.allSettled([
        attempt === 1
          ? ctx.agent("transfer").send(`Find an internal transfer that covers this need.\n${context}`, { outputSchema: TransferOut, signal: ctx.abortSignal }).then((r) => r.result())
          : Promise.resolve({ data: transfer as unknown }),
        ctx.agent("sourcing").send(`Source the remaining need from approved suppliers. Negotiate with each one through a negotiator.\n${context}`, { outputSchema: SourcingOut, signal: ctx.abortSignal }).then((r) => r.result()),
        attempt === 1
          ? ctx.agent("scout").send(`Discover additional suppliers and regulatory signals for this material.\n${context}`, { outputSchema: ScoutOut, signal: ctx.abortSignal }).then((r) => r.result())
          : Promise.resolve({ data: scout as unknown }),
      ]);
      if (t.status === "fulfilled" && t.value.data) transfer = t.value.data as unknown as Transfer;
      if (s.status === "fulfilled" && s.value.data) sourcing = s.value.data as unknown as Sourcing;
      if (sc.status === "fulfilled" && sc.value.data) scout = sc.value.data as unknown as Scout;
      yield { stage: "branches_done", attempt, transfer: t.status, sourcing: s.status, scout: sc.status, rfq_id: sourcing?.rfq_id ?? null };

      // Judge, part 1: numbers recomputed in code from the store.
      const evaluated = await evaluateChecks(brief, sourcing?.rfq_id ?? null);
      checks = evaluated.checks;
      plan = evaluated.plan;

      // Judge, part 2: a different model checks that the doers' claims match the recomputed facts.
      const g = await ctx
        .agent("verifier")
        .send(
          `Check grounding. Compare each claim in the doers' outputs with the recomputed facts. Do not redo the arithmetic; flag any claimed number, supplier or status that contradicts the facts or does not appear in them.\n${JSON.stringify({ claims: { transfer, sourcing, scout }, facts: { today: brief.today, position: brief.position, need_qty: brief.need_qty, need_by: brief.need_by, checks, plan, transfer_proposal: evaluated.proposal } })}`,
          { outputSchema: GroundedVerdict, signal: ctx.abortSignal },
        )
        .then((r) => r.result());
      grounded = (g.data as unknown as Grounded | undefined) ?? { grounded: false, ungrounded_claims: [], feedback: g.error?.message ?? "judge returned no verdict" };
      checks = [...checks, { id: "grounded", pass: grounded.grounded, reason: grounded.grounded ? "claims match recomputed facts" : grounded.ungrounded_claims.join("; ") }];
      await recordRun(brief.mission_id, null, "verifier", { attempt }, { status: checks.every((c) => c.pass) ? "pass" : "fail", data: { checks, plan }, latency_ms: 0 }, modelFor("verifier"));

      const numericPass = checks.filter((c) => c.id !== "grounded").every((c) => c.pass);
      // The plan we act on is computed in code, so a grounding miss alone never blocks it; it is reported.
      decision = numericPass ? "accept" : attempt < MAX_ATTEMPTS && !plan.unfixable ? "replan" : "escalate";
      yield { stage: "verified", attempt, decision, checks: checks.map((c) => ({ id: c.id, pass: c.pass })) };
      if (decision !== "replan") break;
      feedback = `${replanFeedback(checks, plan)} ${grounded.grounded ? "" : `Judge: ${grounded.feedback}`}`.trim();
    }

    const purchase = plan?.purchase ?? null;
    const accepted = decision === "accept";
    const withinAuthority = accepted && purchase?.value_usd != null && purchase.value_usd <= AUTHORITY_LIMIT_USD;

    let approval: "auto" | "approved" | "rejected" | "none" | "qualification_opened" = "none";
    if (!purchase && !accepted) {
      // No qualified source can close the gap. Never substitute an analogue; ask the planner to start qualification instead.
      const candidates = (scout?.candidates ?? []).slice(0, 3);
      const answer = await ctx.ask({
        prompt: [
          `${brief.material_name} at ${brief.site_name}: ${brief.position.cover_days} days of cover, need ${brief.need_qty} ${brief.position.unit}.`,
          plan?.fastest_lead_days != null
            ? `Fastest qualified source needs ${plan.fastest_lead_days} days; I have ${plan.days_available}.`
            : "No qualified supplier has given a price; this material is quote-only.",
          "I will not substitute an analogue or a different grade for the licensed material.",
          candidates.length ? `Discovery candidates for qualification: ${candidates.map((c) => c.name).join(", ")}.` : "No discovery candidates found yet.",
          "Open a supplier qualification task and notify QA?",
        ].join("\n"),
        display: "confirmation",
        options: [
          { id: "qualify", label: "Open qualification task", style: "primary" },
          { id: "dismiss", label: "Not now" },
        ],
      });
      if (answer.status === "answered" && answer.optionId === "qualify") approval = "qualification_opened";
    }
    if (purchase) {
      if (withinAuthority) {
        approval = "auto";
      } else {
        const failed = checks.filter((c) => !c.pass);
        const answer = await ctx.ask({
          prompt: [
            `${brief.material_name} at ${brief.site_name}: ${brief.position.cover_days} days of cover, reorder point ${brief.position.reorder_point} ${brief.position.unit}.`,
            plan?.transfer ? `Transfer ${plan.transfer.qty} ${brief.position.unit} from ${plan.transfer.from_site_id} (arrives in ~${plan.transfer.arrives_in_days} days).` : "No sister site has surplus to transfer.",
            `Buy ${purchase.qty} ${brief.position.unit} from ${purchase.supplier_name} at $${purchase.landed_unit_usd}/unit landed, ${purchase.lead_time_days} days (${purchase.rfq_id}).`,
            purchase.value_usd == null
              ? "Price needs review."
              : purchase.value_usd > AUTHORITY_LIMIT_USD
                ? `Total $${purchase.value_usd.toLocaleString("en-US")}, above my $${AUTHORITY_LIMIT_USD.toLocaleString("en-US")} limit.`
                : `Total $${purchase.value_usd.toLocaleString("en-US")}, within my limit, but checks failed.`,
            failed.length ? `Failed checks: ${failed.map((c) => `${c.id} (${c.reason})`).join("; ")}` : "All checks passed.",
          ].join("\n"),
          display: "confirmation",
          options: [
            { id: "approve", label: `Approve ${purchase.rfq_id}`, style: "primary" },
            { id: "reject", label: "Reject" },
          ],
        });
        approval = answer.status === "answered" && answer.optionId === "approve" ? "approved" : "rejected";
      }
      if (approval === "auto" || approval === "approved") await applyApproval(purchase.rfq_id, purchase.supplier_id);
    }

    const degraded = !accepted;
    const verb = {
      auto: "Auto-approved",
      approved: "Approved by planner",
      rejected: "Rejected by planner",
      none: accepted ? "No purchase needed" : "Escalated, no action taken",
      qualification_opened: "Escalated; qualification task opened",
    }[approval];
    const summary = `${verb}; ${plan?.quotes_considered ?? 0} quotes; ${attempt} attempt(s); checks ${checks.filter((c) => c.pass).length}/${checks.length}.`;
    await finishMission(brief.mission_id, degraded ? "degraded" : "completed", summary, {
      headline: `${brief.material_name} at ${brief.site_name}: ${summary}`,
      severity: brief.position.severity,
      detail: JSON.stringify({ plan, checks }),
    });

    return {
      mission_id: brief.mission_id,
      status: degraded ? "degraded" : "completed",
      attempts: attempt,
      checks,
      plan,
      approval,
      discovery_candidates: (scout?.candidates ?? []).slice(0, 3),
      summary,
    };
  },
});

async function applyApproval(rfqId: string, supplierId: string) {
  "use step";
  const tool = toolsByName["apply_approval"];
  if (!tool) return null;
  return withStore(
    (store) => runTool(tool, { organizationId: "corvane", role: "planner", filters: {}, store }, { rfq_id: rfqId, decision: "approve", quote_supplier_id: supplierId }),
    { write: true },
  );
}
