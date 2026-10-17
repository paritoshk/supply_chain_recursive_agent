/** Wilson score interval (95%) for k successes out of n. */
export function wilson(k: number, n: number, z = 1.96): { p: number; lo: number; hi: number; k: number; n: number } {
  if (n === 0) return { p: 0, lo: 0, hi: 0, k, n };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { p: r4(p), lo: r4(Math.max(0, c - h)), hi: r4(Math.min(1, c + h)), k, n };
}

export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i]!;
}

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
export const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
export const r2 = (x: number) => Math.round(x * 100) / 100;

export function prf(tp: number, fp: number, fn: number, tn: number) {
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  const f1 = precision != null && recall != null && precision + recall ? (2 * precision * recall) / (precision + recall) : null;
  const n = tp + fp + fn + tn;
  return {
    precision: precision == null ? null : r4(precision),
    recall: recall == null ? null : r4(recall),
    f1: f1 == null ? null : r4(f1),
    accuracy: n ? r4((tp + tn) / n) : null,
    /** Share of truly not-equivalent pairs called equivalent (the dangerous error). */
    false_equivalence_rate: fp + tn ? r4(fp / (fp + tn)) : null,
    confusion: { tp, fp, fn, tn },
  };
}
