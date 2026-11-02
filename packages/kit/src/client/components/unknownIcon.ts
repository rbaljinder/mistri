/**
 * What `mistri dev` says of an icon name that names none (Icon.tsx `sayUnknownIcons`): a console error, which grade
 * counts as the page's (gradeProbe.ts `watchEvents`), naming the nearest name there is. A chunk of its own, fetched
 * only on a miss.
 */

/** The name nearest the one asked for, by edits, where it is near enough to be the one meant. */
export function nearestIconName(name: string, names: readonly string[]): string | undefined {
  let best: string | undefined;
  let least = Math.max(2, Math.floor(name.length / 3)) + 1;
  for (const candidate of names) {
    const cost = edits(name.toLowerCase(), candidate);
    if (cost < least) {
      least = cost;
      best = candidate;
    }
  }
  return best;
}

function edits(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

export function sayUnknownIcon(name: string, names: readonly string[]): void {
  const near = nearestIconName(name, names);
  console.error(
    `mistri: no icon is called "${name}"${near ? `; the nearest is "${near}"` : ''}. It is drawn as a house until it names one: mistri docs icons lists them.`,
  );
}
