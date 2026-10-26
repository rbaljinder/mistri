// test-package: shared — a check of the repository that names both binaries (scripts/test-owners.mjs).
/** The authored-App test examples, an example App's own tests/, and the acceptance suites written the same way over
 * two fixtures (Loaner Desk and Keystone) import only what an App's own repository can: Node, the package's public
 * exports, Playwright and pg, and files of the examples, those suites and their fixture Apps. Never mistri's src/,
 * the rest of test/, or e2e/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const exported = new Set(
  Object.keys(JSON.parse(readFileSync(join(root, 'packages/mistri/package.json'), 'utf8')).exports).map(
    (path) => `@mistriwork/mistri${path.slice(1)}`,
  ),
);
const PACKAGES = new Set(['@playwright/test', 'pg']);
/* Where a file these suites reach may live: an App's repository holds its App, its seed and its tests. */
const OWN = ['examples/', 'test/loaner-desk-acceptance/', 'test/keystone-acceptance/', 'test/fixtures/apps/', 'test/fixtures/databases/'];
const own = (where: string) => OWN.some((root) => where.startsWith(root));
const SPECIFIER = /(?:^|[\s;])(?:import|export)\s(?:[^'";]*?\sfrom\s)?\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Every file the examples' tests run, and the modules of theirs they load. */
function files(): string[] {
  const testing = ['examples/testing', 'test/loaner-desk-acceptance', 'test/keystone-acceptance'].flatMap((suite) =>
    readdirSync(join(root, suite), { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.(ts|mjs)$/.test(file))
      .map((file) => join(root, suite, file)),
  );
  // An example App's own suite (examples/apps/lintel/tests) holds to the same rule.
  for (const app of readdirSync(join(root, 'examples/apps'), { withFileTypes: true }))
    if (app.isDirectory() && existsSync(join(root, 'examples/apps', app.name, 'tests')))
      for (const file of readdirSync(join(root, 'examples/apps', app.name, 'tests')))
        if (/\.(ts|mjs)$/.test(file)) testing.push(join(root, 'examples/apps', app.name, 'tests', file));
  const seen = new Set<string>();
  const queue = [...testing];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
      const specifier = match[1] ?? match[2];
      if (specifier.startsWith('.')) queue.push(resolve(dirname(file), specifier));
    }
  }
  return [...seen].sort();
}

test('the authored-App test examples import nothing from mistri internals', () => {
  const reached = files();
  assert.ok(
    reached.some((file) => file.endsWith('loaner-desk-acceptance/acceptance.test.ts')),
    'the scan found the acceptance suite',
  );
  assert.ok(
    reached.some((file) => file.endsWith('apps/lintel/tests/start.ts')),
    'the scan found the flagship App’s own suite',
  );
  assert.ok(
    reached.some((file) => file.endsWith('apps/loaner-desk/jobs.ts')),
    'the scan follows relative imports into the App',
  );
  const problems: string[] = [];
  for (const file of reached) {
    const where = relative(root, file);
    if (!own(where)) problems.push(`${where} is outside what an App's repository holds`);
    for (const match of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
      const specifier = match[1] ?? match[2];
      if (specifier.startsWith('node:') || PACKAGES.has(specifier) || exported.has(specifier)) continue;
      if (specifier.startsWith('.') && own(relative(root, resolve(dirname(file), specifier)))) continue;
      problems.push(`${where} imports ${specifier}`);
    }
  }
  assert.deepEqual(problems, [], 'Import only public package exports; report a missing helper instead of reaching into src/.');
});
