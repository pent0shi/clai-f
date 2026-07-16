/**
 * Fixed-width pager chrome rows (meta/footer). OpenTUI flex children paint past
 * borders; a single pre-padded string of exact column width does not.
 */

export function fitOneLine(candidates: readonly string[], maxCols: number): string {
  const budget = Math.max(1, maxCols);
  for (const text of candidates) {
    if (text.length <= budget) return text;
  }
  const last = candidates[candidates.length - 1] ?? "";
  if (last.length <= budget) return last;
  if (budget <= 1) return "…";
  return `${last.slice(0, budget - 1)}…`;
}

/**
 * One terminal row of exactly `width` columns: left clipped, right clipped,
 * spaces between.
 */
export function padChromeRow(left: string, right: string, width: number): string {
  const w = Math.max(8, width);
  const rightBudget = Math.min(
    Math.max(right.length, 4),
    Math.max(8, Math.floor(w * 0.4)),
  );
  const r = fitOneLine(
    [right, right.replace(/\s*·\s*.*$/, ""), right.replace(/\D/g, "") || "·"],
    rightBudget,
  );
  const leftBudget = Math.max(1, w - r.length - 1);
  const l = fitOneLine([left], leftBudget);
  const gap = Math.max(1, w - l.length - r.length);
  const row = `${l}${" ".repeat(gap)}${r}`;
  if (row.length === w) return row;
  if (row.length > w) return row.slice(0, w);
  return row + " ".repeat(w - row.length);
}

/** Soft-wrap a body line so it stays inside the pager border. */
export function wrapPagerLine(line: string, width: number): string[] {
  const max = Math.max(8, width);
  if (!line) return [" "];
  if (line.length <= max) return [line];
  const out: string[] = [];
  let rest = line;
  while (rest.length > max) {
    let breakAt = rest.lastIndexOf(" ", max);
    if (breakAt < Math.floor(max * 0.35)) breakAt = max;
    out.push(rest.slice(0, breakAt));
    rest = rest.slice(breakAt).replace(/^\s+/, "");
  }
  if (rest) out.push(rest);
  return out.length > 0 ? out : [" "];
}
