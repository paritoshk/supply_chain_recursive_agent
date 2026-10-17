import { withStore } from "./store.ts";

/** Generic lesson per failed check; the check's own reason is appended for specifics. */
const LESSON_TEXT: Record<string, string> = {
  lands_in_time: "A previous mission's standard quotes landed too late. Ask every negotiator for its expedite option in the first message.",
  comparable_quotes: "A previous mission had fewer than 2 usable quotes. Negotiate with every approved supplier, not just one.",
  covers_need: "A previous mission secured less than the need. Quote the full remaining quantity.",
  qualified_only: "A previous mission quoted a non-approved supplier. Only quality_approved or released_for_use suppliers may be quoted.",
};

/** The latest lessons from earlier missions on this material, for the doers' context. */
export async function lessonsFor(materialId: string) {
  "use step";
  return withStore((store) =>
    store
      .lessons({ material_id: materialId })
      .slice(-5)
      .map((l) => ({ check_id: l.check_id, supplier_id: l.supplier_id, text: l.text })),
  );
}

/**
 * Turns failed numeric checks and the judge's grounding flags into lessons for the next mission on the
 * same material. Lessons change instructions only; the checks themselves stay fixed in code.
 */
export async function recordLessons(
  missionId: string,
  materialId: string,
  checks: Array<{ id: string; pass: boolean; reason?: string }>,
  grounded: { grounded: boolean; ungrounded_claims: string[] } | null,
  supplierId: string | null,
): Promise<number> {
  "use step";
  const failed = checks.filter((c) => !c.pass && c.id !== "grounded");
  const claims = grounded && !grounded.grounded ? grounded.ungrounded_claims.slice(0, 3) : [];
  if (!failed.length && !claims.length) return 0;
  return withStore(
    (store) => {
      for (const c of failed) {
        const base = LESSON_TEXT[c.id] ?? `Check ${c.id} failed on a previous mission.`;
        store.addLesson({ mission_id: missionId, material_id: materialId, supplier_id: supplierId, check_id: c.id, text: c.reason ? `${base} Last time: ${c.reason}` : base });
      }
      for (const claim of claims) {
        store.addLesson({
          mission_id: missionId,
          material_id: materialId,
          supplier_id: supplierId,
          check_id: "grounding",
          text: `The judge flagged this claim as unsupported by the facts: "${claim}". Quote numbers and statuses only from tool outputs.`,
        });
      }
      return failed.length + claims.length;
    },
    { write: true },
  );
}
