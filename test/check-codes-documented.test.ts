/**
 * The `mistri check` codes against the page that documents them.
 *
 * check-json.test.ts holds a hand-kept list of codes to the page; this reads the source for the codes the checker can
 * emit, so a new one cannot ship without a row, and holds every row to a fix: an agent that reads a code's `docs`
 * link lands on the row and has to find what to do there.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VALIDATION_CODES } from '../packages/mistri/src/server/build/checkProblems.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const page = readFileSync(join(root, 'site/src/content/docs/docs/check-codes.md'), 'utf8');

/** A row is `| \`code\` | step | what | fix |`; the code is the first cell and the fix the last. */
const rows = [...page.matchAll(/^\| `([a-z][a-z0-9-]*)` \|(.*)\|\s*$/gm)].map((row) => {
  const cells = row[2]!.split(/(?<!\\)\|/).map((cell) => cell.trim());
  return { code: row[1]!, fix: cells[cells.length - 1]! };
});

/* The design rules say their codes on their own page (docsFor: the `design` step links to design-lint), so they are held
   to that page below, not to this one. */
const designRules = readFileSync(join(root, 'packages/mistri/src/server/app/designLint.ts'), 'utf8');
const designPage = readFileSync(join(root, 'site/src/content/docs/docs/design-lint.md'), 'utf8');
const designCodes = new Set([...designRules.matchAll(/\bcode: '([a-z][a-z0-9]*(?:-[a-z0-9]+)*)'/g)].map((match) => match[1]!));

/* Where the checks live. A finding says its code three ways: `code: 'x'` on a record, `problem(step, 'x', …)`, and
   `[x]` inside the sentence a check throws, which checkProblems.ts reads back out. */
const checkSources = ['packages/mistri/src/server/build', 'packages/mistri/src/server/app', 'packages/mistri/src/server/integrations']
  .flatMap((dir) => readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' }).map((file) => join(dir, file)))
  /* recordBranding.ts and appErrors.ts answer a request (`code: 'closed'`, `'forbidden'`); they are not checks. */
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && !/(designLint|recordBranding|appErrors)\.ts$/.test(file));

const emitted = new Set<string>(VALIDATION_CODES.map((entry) => entry.code));
for (const file of checkSources) {
  const source = readFileSync(join(root, file), 'utf8');
  for (const match of source.matchAll(/\bcode: '([a-z][a-z0-9]*(?:-[a-z0-9]+)*)'/g)) emitted.add(match[1]!);
  for (const match of source.matchAll(/\bproblem\(\s*'[a-z ]+',\s*'([a-z][a-z0-9]*(?:-[a-z0-9]+)*)'/g)) emitted.add(match[1]!);
  /* A selector (`[data-open]`, `[aria-current]`) and a character class (`[a-z-…]`) are not codes. */
  for (const match of source.matchAll(/\[([a-z]+(?:-[a-z0-9]+)+)\]/g)) if (!/^(data|aria|a-z)/.test(match[1]!)) emitted.add(match[1]!);
}

test('every documented check code has a fix', () => {
  assert.ok(rows.length > 150, 'the code table was not read');
  assert.deepEqual(
    rows.filter((row) => !row.fix || /^[-—–]?$/.test(row.fix)).map((row) => row.code),
    [],
  );
});

test('every code the checker can emit is documented', () => {
  const documented = new Set(rows.map((row) => row.code));
  assert.deepEqual(
    [...emitted].filter((code) => !documented.has(code)).sort(),
    [],
    'a code the check says needs a row (with its anchor and a fix) in site/src/content/docs/docs/check-codes.md',
  );
});

test('every design rule is documented on the design-lint page', () => {
  assert.ok(designCodes.size > 10, 'the design rules were not read');
  assert.deepEqual([...designCodes].filter((code) => !designPage.includes(`\`${code}\``)).sort(), []);
});
