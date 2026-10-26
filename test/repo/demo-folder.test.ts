/*
 * `.demo/` belongs to whoever is running the suite: the demo databases
 * `npx tablewalk --demo` builds there, and the credentials beside them. Five
 * suites once kept their own scratch databases in it, so every `npm test`
 * wrote beside those files, one file name away from overwriting one. A test
 * makes its own directory under the system's temporary directory and removes
 * it; this scan keeps it that way.
 *
 * Allowed: the generators' default output, which applies only when a person
 * runs them by hand without a path, and two tests that only pass
 * `.demo/demo.db` along as a string — to redaction, and to a resolver that
 * opens nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const SELF = 'test/repo/demo-folder.test.ts';

/** Where a path under `.demo/` is written in code: a quoted `.demo/…` or `join('.demo', …)`. */
const DEMO_PATH = /(['"`])\.demo(\/|\1)|join\(\s*['"`]\.demo['"`]/;

/** Files whose `.demo/` mentions are defaults for a person's own run, never a test's. */
const GENERATORS = new Set([
  'test/make-demo-db.ts',
  'test/make-wide-db.ts',
  'test/fixtures/apps/relay/seed.mjs',
  'test/fixtures/apps/service-desk/seed.mjs',
  'test/fixtures/databases/thread/seed.mjs',
]);

/** Lines that only hand `.demo/demo.db` on as a string; nothing opens or writes it. */
const STRING_ONLY = [
  /redact\('\.demo\/demo\.db'\)/,
  /resolveConnection\('demo', '\.demo\/demo\.db'\)/,
  /assert\.equal\(resolved\.url, '\.demo\/demo\.db'\)/,
];

/* Code only: a comment may say why a test stays out of `.demo/`, as the suites
   that moved do. Comments become spaces, newlines kept, so a line number still
   points at the line. A `//` counts as a comment only at a line's start or after
   whitespace, so a URL inside a string is left alone. */
const withoutComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' ')).replace(/(^|\s)\/\/.*$/gm, (_, lead: string) => lead);

test("no test keeps its files in .demo/, where a developer's demo databases live", () => {
  const files = readdirSync(join(root, 'test'), { recursive: true, encoding: 'utf8' })
    .map((file) => join('test', file).split('\\').join('/'))
    .filter((file) => /\.(ts|tsx|js|mjs)$/.test(file) && file !== SELF && !GENERATORS.has(file));
  const problems: string[] = [];
  for (const file of files) {
    withoutComments(readFileSync(join(root, file), 'utf8'))
      .split('\n')
      .forEach((line, index) => {
        if (!DEMO_PATH.test(line) || STRING_ONLY.some((allowed) => allowed.test(line))) return;
        problems.push(
          `${file}:${index + 1} puts a path under .demo/; use a directory of the test's own (mkdtempSync(join(tmpdir(), 'tablewalk-…-'))).`,
        );
      });
  }
  assert.deepEqual(problems, []);
});
