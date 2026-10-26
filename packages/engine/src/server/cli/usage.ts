/**
 * What both command lines share about their words: the near miss a typo is told, the version, and how a usage text
 * is read for its command and flag words. Each binary keeps its own `USAGE` (packages/tablewalk/src/server/cli/usage.ts,
 * packages/mistri/src/server/cli/usage.ts), and test/prose.test.ts holds each one to its own README.
 */

/** The command words a usage names (`tablewalk migrate`, `mistri check`, …), for a near miss's suggestion. */
export function commandWordsOf(usage: string, bin: string): string[] {
  return [...new Set([...usage.matchAll(new RegExp(`^ {2}${bin} ([a-z][a-z-]*)(?=\\s|$)`, 'gm'))].map((match) => match[1]))];
}

/** Every flag a usage spells, for an unknown option's suggestion. */
export function flagWordsOf(usage: string): string[] {
  return [...new Set([...usage.matchAll(/(?<![\w-])--?[a-zA-Z][\w-]*/g)].map((match) => match[0]))];
}

/** What was probably meant, said the way a person would type it, or nothing when nothing is near. */
export async function didYouMean(said: string, among: readonly string[]): Promise<string> {
  const { distance, nearest } = await import('../../shared/suggest.js');
  const near = nearest(said, among);
  return near !== undefined && distance(said.toLowerCase(), near.toLowerCase()) <= Math.max(1, Math.floor(said.length / 3))
    ? ` Did you mean ${near}?`
    : '';
}

/** What the package says it is, best effort. Every package of the workspace carries the one version. */
export async function packageVersion(): Promise<string> {
  try {
    const { runtimeVersion } = await import('../packageVersion.js');
    return runtimeVersion();
  } catch {
    return '0.0.0';
  }
}
