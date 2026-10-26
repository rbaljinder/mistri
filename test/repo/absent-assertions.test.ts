/**
 * Assertions that cannot fail.
 *
 * A test that asserts an element is *absent* keeps passing after the element
 * is deleted — it passes for the wrong reason, forever, and costs its runtime
 * to say nothing. Four were found and deleted in 0.5.1: `.nest-caret`, whose
 * guard was written in the same commit that removed the element, and
 * `#write-toggle` in three specs. Nothing noticed for months.
 *
 * So: every class or id named in an absence assertion must still be something
 * the client can draw. The check is deliberately narrow — only lines that
 * assert absence, only literal `.class` and `#id` selectors — because the
 * failure mode of a broad version is noise, and a noisy check gets an
 * allowlist entry instead of a fix.
 *
 * `KNOWN` is for a name the client never draws but a test is right to look
 * for: markup from a library, or a name a fixture injects. It only shrinks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { inPackages } from '../support/packages.js';

const root = new URL('../..', import.meta.url).pathname;

/** What "assert this is not there" looks like in this suite's two dialects. */
const ABSENT = [
  /\.not\.toBeVisible\(/,
  /\.not\.toBeInTheDocument\(/,
  /\.not\.toBeAttached\(/,
  /toHaveCount\(\s*0\s*\)/,
  /toBeNull\(\)/,
  /toBeHidden\(\)/,
  /toBeUndefined\(\)/,
];
/* `.thing` and `#thing` inside a string literal, the way a locator names one.
   Lowercase and kebab only, and nothing may follow the name but a
   non-letter: `expect(x).toBeNull()` and `screen.queryByRole(…)` are method
   chains, not selectors, and a camelCase tail is how they give themselves
   away. */
const SELECTOR = /(['"`])([^'"`\n()]*?[.#][a-z][a-z0-9-]{2,}[^'"`\n()]*?)\1/g;
const TOKEN = /[.#]([a-z][a-z0-9-]{2,})(?![A-Za-z])/g;

/** A name the client never draws, and a test is still right to look for it. */
const KNOWN = new Set<string>([]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(root, dir))) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const here = `${dir}/${entry}`;
    if (statSync(join(root, here)).isDirectory()) walk(here, out);
    else if (/\.(test|spec)\.(ts|tsx)$/.test(entry)) out.push(here);
  }
  return out;
}

test('an assertion that an element is absent names something the client can draw', () => {
  /* Every class and id the client's markup and stylesheets mention: JSX
     className strings, CSS selectors, and the classes the vanilla modules
     add. Read as text on purpose — a name assembled at runtime is not one a
     test can pin either. */
  const drawn = new Set<string>();
  const client: string[] = [];
  const collect = (dir: string) => {
    for (const entry of readdirSync(join(root, dir))) {
      const here = `${dir}/${entry}`;
      if (statSync(join(root, here)).isDirectory()) collect(here);
      else if (/\.(ts|tsx|js|css|html)$/.test(entry) && !/\.(test|spec)\./.test(entry)) client.push(here);
    }
  };
  for (const dir of [...inPackages('src/client'), ...inPackages('src/shared')]) collect(dir);
  for (const file of client) {
    const text = readFileSync(join(root, file), 'utf8');
    // Selectors in stylesheets and in the client's own queries.
    for (const match of text.matchAll(/[.#]([a-z][a-z0-9-]{2,})/gi)) drawn.add(match[1]!.toLowerCase());
    /* And any name the client says at all: a class reaches an element by too
       many routes to enumerate — `className="x"`, `class: 'x'`,
       `element('div', null, 'x')`, `classList.add('x')`, a template — and
       chasing each shape produced three false positives before this rule
       replaced them. What remains caught is the case that matters: a name
       that appears nowhere in the client, because its element was deleted. */
    for (const match of text.matchAll(/["'`]([a-z][a-z0-9 -]{2,})["'`]/g)) {
      for (const name of match[1]!.split(/\s+/)) if (name.length > 2) drawn.add(name.toLowerCase());
    }
  }

  /* A name some other assertion expects to *find* is real, however the
     client spells it — several are composed at runtime (`page-list` is drawn
     by a template and asserted visible two lines above the absence check that
     first flagged it here). What this test is looking for is narrower: a name
     that appears only ever in absence assertions, which is what a deleted
     element leaves behind. */
  const suites = [...walk('e2e'), ...inPackages('src/client').flatMap((dir) => walk(dir))];
  for (const file of suites) {
    for (const line of readFileSync(join(root, file), 'utf8').split('\n')) {
      if (ABSENT.some((pattern) => pattern.test(line))) continue;
      for (const literal of line.matchAll(SELECTOR)) {
        for (const token of literal[2]!.matchAll(TOKEN)) drawn.add(token[1]!.toLowerCase());
      }
    }
  }

  const stale: string[] = [];
  for (const file of suites) {
    const lines = readFileSync(join(root, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!ABSENT.some((pattern) => pattern.test(line))) return;
      for (const literal of line.matchAll(SELECTOR)) {
        for (const token of literal[2]!.matchAll(TOKEN)) {
          const name = token[1]!.toLowerCase();
          if (drawn.has(name) || KNOWN.has(name)) continue;
          stale.push(`${file}:${index + 1} asserts "${token[0]}" is absent, and nothing in the client draws it.`);
        }
      }
    });
  }
  assert.deepEqual(
    [...new Set(stale)],
    [],
    'An "assert absent" that outlives its element passes forever. Delete the assertion, or fix the name.',
  );
});
