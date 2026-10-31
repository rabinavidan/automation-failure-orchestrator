/** Pure metric helpers for the investigation benchmark. */

export function accuracy(pairs: Array<{ expected: string; predicted: string }>): number | null {
  if (pairs.length === 0) return null;
  return pairs.filter((p) => p.expected === p.predicted).length / pairs.length;
}

/**
 * Macro-averaged F1 over the labels present in either expected or predicted values. A label
 * with no true positives and no predictions/support contributes 0, which penalises classes
 * the system never gets right instead of hiding them.
 */
export function macroF1(pairs: Array<{ expected: string; predicted: string }>): number | null {
  if (pairs.length === 0) return null;
  const labels = [...new Set(pairs.flatMap((p) => [p.expected, p.predicted]))];
  const f1s = labels.map((label) => {
    const tp = pairs.filter((p) => p.expected === label && p.predicted === label).length;
    const fp = pairs.filter((p) => p.expected !== label && p.predicted === label).length;
    const fn = pairs.filter((p) => p.expected === label && p.predicted !== label).length;
    if (tp === 0) return 0;
    const precision = tp / (tp + fp);
    const recall = tp / (tp + fn);
    return (2 * precision * recall) / (precision + recall);
  });
  return f1s.reduce((a, b) => a + b, 0) / f1s.length;
}

export function confusion(
  pairs: Array<{ expected: string; predicted: string }>
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const { expected, predicted } of pairs) {
    out[expected] ??= {};
    out[expected][predicted] = (out[expected][predicted] ?? 0) + 1;
  }
  return out;
}

/** Nearest-rank percentile; null for an empty sample. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

export function rate(flags: boolean[]): number | null {
  return flags.length === 0 ? null : flags.filter(Boolean).length / flags.length;
}

/** Recall@k: share of queries whose top-k results include at least one relevant document. */
export function recallAtK(rankings: Array<{ ranked: string[]; relevant: string[] }>, k: number) {
  if (rankings.length === 0) return null;
  return (
    rankings.filter((r) => r.ranked.slice(0, k).some((doc) => r.relevant.includes(doc))).length /
    rankings.length
  );
}

/** Mean reciprocal rank of the first relevant document (0 when none is retrieved). */
export function meanReciprocalRank(rankings: Array<{ ranked: string[]; relevant: string[] }>) {
  if (rankings.length === 0) return null;
  const rr = rankings.map((r) => {
    const index = r.ranked.findIndex((doc) => r.relevant.includes(doc));
    return index === -1 ? 0 : 1 / (index + 1);
  });
  return rr.reduce((a, b) => a + b, 0) / rr.length;
}
