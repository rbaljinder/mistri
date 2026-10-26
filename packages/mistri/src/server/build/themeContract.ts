/**
 * The theme contract: what every look an App can wear promises its reader, C1 to C13, and the codes that hold each
 * promise — `check` where the theme's spec decides it, `grade` where only the drawn page does. Every finding of
 * either code says its promise (`promise` in `check --json` and grade's JSON), so an agent fixing a theme reads
 * which promise broke as well as which measurement.
 *
 * The site's theme-contract page (site/src/content/docs/docs/theme-contract.md) states each promise in the
 * check-codes shape, so `mistri explain C5` prints it; test/theme-contract.test.ts holds the page and this map
 * together, code for code.
 */

export const PROMISES = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'C11', 'C12', 'C13'] as const;
export type ContractPromise = (typeof PROMISES)[number];

/** Each promise in a few words, as the matrix and a finding's line say it. */
export const PROMISE_WORDS: Readonly<Record<ContractPromise, string>> = {
  C1: 'text readable',
  C2: 'controls visible',
  C3: 'focus visible',
  C4: 'targets big enough',
  C5: 'nothing cut or overlapping',
  C6: 'not by color alone',
  C7: 'charts distinguishable',
  C8: 'type legible',
  C9: 'motion safe',
  C10: 'dark complete',
  C11: 'stays fast',
  C12: 'print reads',
  C13: 'same App',
};

/** The codes that measure a promise, `check`'s and `grade`'s, each to the one promise it holds. */
export const CONTRACT_CODES: Readonly<Record<string, ContractPromise>> = {
  // check: the spec decides
  'theme-contrast': 'C1',
  'theme-edge': 'C2',
  'theme-focus': 'C3',
  'theme-chart': 'C7',
  'theme-dark': 'C10',
  'theme-budget': 'C11',
  'theme-print': 'C12',
  'theme-shadow': 'C2',
  'theme-type': 'C8',
  'theme-part': 'C13',
  'theme-band': 'C13',
  'theme-css': 'C13',
  'theme-contract': 'C13',
  // grade: only the drawn page decides
  'low-contrast': 'C1',
  'faint-edge': 'C2',
  'hidden-focus': 'C3',
  'small-target': 'C4',
  overlap: 'C5',
  'clipped-text': 'C5',
  'clipped-number': 'C5',
  'sideways-scroll': 'C5',
  'header-wrap': 'C5',
  'color-only': 'C6',
  'long-measure': 'C8',
  'unsafe-motion': 'C9',
  'layout-shift': 'C11',
  'heavy-theme': 'C11',
  'print-contrast': 'C12',
  'changed-app': 'C13',
};

/** The promise a code holds, or undefined for a code that is not the contract's (`unknown-column`, `page-error`). */
export function promiseOf(code: string): ContractPromise | undefined {
  return Object.hasOwn(CONTRACT_CODES, code) ? CONTRACT_CODES[code] : undefined;
}

/** The codes that measure only color: what `grade --palette all` reads in each other palette, which moves no layout. */
export const COLOR_PROMISES: ReadonlySet<ContractPromise> = new Set(['C1', 'C2', 'C3', 'C6']);
