/*
 * Near-miss suggestions for error messages: "did you mean", and a list short
 * enough to read. One copy, because the query language, view paths and the
 * MCP argument check each grew their own edit distance.
 */

/**
 * Levenshtein distance, capped: names more than three characters apart in
 * length score 99 without the table being built. Only ever used to suggest
 * a near miss, where anything that far off is no suggestion at all.
 */
export function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = tmp;
    }
  }
  return prev[b.length];
}

/** The candidate closest to `name` ignoring case, if one is within three edits. */
export function nearest(name: string, candidates: readonly string[]): string | undefined {
  const near = candidates.map((c) => ({ c, d: apart(name.toLowerCase(), c.toLowerCase()) })).sort((a, b) => a.d - b.d)[0];
  return near && near.d <= 3 ? near.c : undefined;
}

/* Two letters swapped is the commonest slip and two edits by the distance:
   it ranks ahead of any one-letter change, so `lable` finds `label`, not
   `table`. It never brings a name inside the three edits that was not. */
function apart(a: string, b: string): number {
  const d = distance(a, b);
  return d === 2 && [...a].sort().join('') === [...b].sort().join('') ? 0.5 : d;
}

/**
 * The refusal of a key its place does not take, after the place:
 * `has no "lable". Did you mean "label"? It takes: …`, the caller ending the
 * sentence. A key some other place takes (`homes`) is told where it belongs
 * instead: it is spelled right and put in the wrong place. A key here one
 * slip away still wins, since a typo is the likelier mistake.
 */
export function unknownKey(key: string, takes: readonly string[], homes: readonly string[] = []): string {
  const found = nearest(key, takes);
  const d = found === undefined ? Infinity : apart(key.toLowerCase(), found.toLowerCase());
  /* Three edits is near for a long key and another word for a short one:
     `sql` is not `all`, nor `when` `other`, nor `name` `base`. A slip, or less than half the shorter. */
  const near = found !== undefined && (d <= 1 || d < Math.min(key.length, found.length) / 2) ? found : undefined;
  const slip = near !== undefined && d <= 1;
  const where = homes.length > 1 ? `${homes.slice(0, -1).join(', ')} or ${homes[homes.length - 1]}` : homes[0];
  const hint = where && !slip ? ` "${key}" belongs ${where}.` : near ? ` Did you mean "${near}"?` : '';
  return `has no "${key}".${hint} It takes: ${takes.join(', ')}`;
}

/** A short list for an error message; long lists help nobody. */
export function shortList(items: readonly string[]): string {
  return items.length > 6 ? `${items.slice(0, 6).join(', ')}, …` : items.join(', ');
}
