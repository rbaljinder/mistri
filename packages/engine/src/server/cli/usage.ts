/**
 * What both command lines share about their words: the near miss a typo is told, the version, and how a usage text
 * is read for its command and flag words. Each binary keeps its own `USAGE` (packages/mistri/src/server/cli/usage.ts
 * here, the database browser's in its own repository), and each is held to its own README.
 */

import { productVersion } from '../product.js';

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
  /* Never the spelling that was typed: "Did you mean --brief?" to --brief is no help. */
  const near = nearest(
    said,
    among.filter((word) => word !== said),
  );
  return near !== undefined && distance(said.toLowerCase(), near.toLowerCase()) <= Math.max(1, Math.floor(said.length / 3))
    ? ` Did you mean ${near}?`
    : '';
}

/**
 * What this process says it is, best effort: the host product's own version when its main gave one (`setProduct`),
 * else the package's. Every package of the workspace carries the one version.
 */
export async function packageVersion(): Promise<string> {
  const host = productVersion();
  if (host) return host;
  try {
    const { runtimeVersion } = await import('../packageVersion.js');
    return runtimeVersion();
  } catch {
    return '0.0.0';
  }
}

/** The commands whose usage spells `flag` (`mistri schema --brief`), for a flag typed where no command takes it. */
export function commandsTaking(usage: string, bin: string, flag: string): string[] {
  const out = new Set<string>();
  for (const line of usage.split('\n')) {
    const command = new RegExp(`^ {2}${bin} ([a-z][a-z-]*)(?=\\s|$)`).exec(line)?.[1];
    if (command && new RegExp(`(?<![\\w-])${flag}(?![\\w-])`).test(line)) out.add(command);
  }
  return [...out];
}
