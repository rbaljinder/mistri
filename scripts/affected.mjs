#!/usr/bin/env node
/**
 * The tests a change could have broken, for the edit loop.
 *
 * Two releases in a row were spent waiting on a gate that ran everything for
 * a change that touched one component. This walks the import graph backwards
 * from the files you changed and names the test files that reach them, so the
 * loop between an edit and an answer is seconds rather than minutes.
 *
 *   node scripts/affected.mjs                 # against the working tree
 *   node scripts/affected.mjs --since main    # against a branch point
 *   node scripts/affected.mjs --run           # and run them
 *   node scripts/affected.mjs packages/kit/src/client/components/Grid.tsx …
 *
 * **Selection never gates a release.** The graph cannot see every edge that
 * matters: `--commands` loads a module by path, pages and themes are data
 * read at runtime, a fixture names a database in a string, and the client
 * imports `src/shared` TypeScript through `.js` specifiers. So this prints
 * what it *excluded* and why, and the release still runs `npm test` in full.
 * The full gate is about twelve minutes; there is nothing to be saved by
 * cutting that corner, and a selection trusted for a release is how a suite
 * quietly stops being one.
 *
 * The graph is `scripts/importGraph.mjs`: runtime edges only, since tsc
 * already guards a type edge. A fixture, an App under `examples/apps` or a
 * script is read by path, so it selects the suites whose source names it,
 * not every suite. A Postgres or MySQL adapter file selects only the
 * reaching suites that mention that dialect: every Registry test reaches
 * `connect.ts` and with it all three, but only some use the one that changed.
 */
import { execFileSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, importsOf, textOf } from './importGraph.mjs';

/** Every test and spec, with everything each one reaches transitively. */
export function suiteGraph() {
  const suites = [
    ...globSync('test/**/*.test.ts', { cwd: ROOT }),
    ...globSync('examples/apps/*/tests/*.test.ts', { cwd: ROOT }),
    ...globSync('packages/*/src/client/**/*.test.{ts,tsx}', { cwd: ROOT }),
    ...globSync('e2e/**/*.spec.ts', { cwd: ROOT }),
  ]
    .map((file) => file.split('\\').join('/'))
    .sort();
  const reaches = new Map();
  const walk = (file, seen) => {
    if (seen.has(file)) return seen;
    seen.add(file);
    for (const next of importsOf(file)) walk(next, seen);
    return seen;
  };
  for (const suite of suites) reaches.set(suite, walk(suite, new Set()));
  return reaches;
}

/** What the working tree, or a range, changed. */
function changedFiles(since) {
  const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  if (since) return git(['diff', '--name-only', `${since}...HEAD`]).concat(git(['diff', '--name-only']));
  return [
    ...new Set([
      ...git(['diff', '--name-only']),
      ...git(['diff', '--name-only', '--cached']),
      ...git(['ls-files', '--others', '--exclude-standard']),
    ]),
  ];
}

/* What the graph cannot see. Each is a real edge with no import behind it, so
   a change to one of these selects everything rather than pretending. */
const BLIND = [
  [/^packages\/[^/]+\/schema\//, 'the published schema and types, which authored Apps compile against'],
  [/\.css$/, 'a stylesheet reaches the page without an import edge the graph follows'],
  [/^(?:packages\/[^/]+\/)?package\.json$|^tsconfig|^vite\.config|^playwright\.config/, 'build and runner configuration'],
];

/* Read by path, not imported. These select the suites whose own source (or a
   test helper it imports) names the path, its folder, or its file name, which
   is how a suite finds one. A fixture or an App nobody names selects nothing. */
const BY_NAME = [
  [/^test\/fixtures\//, 'a fixture is read by path'],
  [/^examples\/apps\//, 'an App is loaded by path at runtime, not imported'],
  [/^scripts\//, "the gate's own machinery, run by path"],
];
// A name any suite might contain is no evidence that this file is the one it means.
const GENERIC = new Set(['app.ts', 'index.ts', 'index.js', 'package.json', 'README.md', 'apps', 'fixtures', 'test', 'examples', 'scripts']);

/** The strings a suite would use to name a file read by path. */
export function needlesFor(file) {
  const parts = file.split('/');
  const root = parts[0] === 'test' ? 2 : parts[0] === 'examples' ? 2 : 1; // past test/fixtures, examples/apps, scripts
  const inside = parts.slice(root);
  const needles = new Set([file, inside.join('/')]);
  for (let at = 1; at < inside.length; at++) needles.add(inside.slice(0, at).join('/'));
  needles.add(basename(file));
  if (inside.length > 1) needles.add(inside[inside.length - 2]);
  if (inside.length > 2) needles.delete(inside[0]);
  return [...needles].filter((needle) => needle.length >= 4 && !GENERIC.has(needle));
}

/* A dialect's adapter files, and what a suite says when it uses that dialect. */
const DIALECTS = [
  [/^packages\/[^/]+\/src\/adapters\/postgres[^/]*\.ts$/, /postgres|\bpg\b|TABLEWALK_TEST_PG|pglite/i],
  [/^packages\/[^/]+\/src\/adapters\/mysql[^/]*\.ts$/, /mysql|mariadb|TABLEWALK_TEST_MYSQL/i],
];

/** The suites a set of changed files could have broken, and what could not be followed. */
export function select(changed, reaches = suiteGraph(), read = textOf) {
  // The suite's own text and that of the test-side files it imports (support, helpers), not a package's `src/`.
  const sideTexts = new Map();
  const sideText = (suite, files) => {
    if (!sideTexts.has(suite)) {
      sideTexts.set(
        suite,
        [...files]
          .filter((file) => file === suite || !/^packages\/[^/]+\/src\//.test(file))
          .map(read)
          .join('\n'),
      );
    }
    return sideTexts.get(suite);
  };
  const blind = changed.flatMap((file) => {
    const rule = BLIND.find(([pattern]) => pattern.test(file));
    return rule ? [`${file}: ${rule[1]}`] : [];
  });
  if (blind.length) return { blind, chosen: [...reaches.keys()], total: reaches.size };

  const named = changed.filter((file) => BY_NAME.some(([pattern]) => pattern.test(file)));
  const chosen = [...reaches]
    .filter(([suite, files]) =>
      changed.some((file) => {
        if (named.includes(file)) {
          return files.has(file) || needlesFor(file).some((needle) => sideText(suite, files).includes(needle));
        }
        if (!files.has(file)) return false;
        const dialect = DIALECTS.find(([pattern]) => pattern.test(file));
        return !dialect || suite === file || dialect[1].test(sideText(suite, files));
      }),
    )
    .map(([suite]) => suite);
  return {
    blind,
    named: named.map((file) => `${file}: ${BY_NAME.find(([pattern]) => pattern.test(file))[1]}`),
    chosen,
    total: reaches.size,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const run = argv.includes('--run');
  const sinceAt = argv.indexOf('--since');
  const since = sinceAt >= 0 ? argv[sinceAt + 1] : undefined;
  const named = argv.filter((word, at) => !word.startsWith('--') && !(sinceAt >= 0 && at === sinceAt + 1));
  const changed = (named.length ? named : changedFiles(since)).map((file) => file.split('\\').join('/'));

  if (!changed.length) {
    console.log('Nothing changed.');
    return;
  }
  const { blind, named: byName, chosen, total } = select(changed);

  console.log(`Changed: ${changed.length} file(s)`);
  if (blind.length) {
    console.log('\nThe graph cannot follow these, so everything is selected:');
    for (const line of blind) console.log(`  ${line}`);
  }
  if (byName?.length) {
    console.log('\nThese are read by path, so the suites that name them are selected:');
    for (const line of byName) console.log(`  ${line}`);
  }
  console.log(`\nSelected ${chosen.length} of ${total} suites.`);
  for (const suite of chosen) console.log(`  ${suite}`);
  console.log('\nThis is for the edit loop. A release runs `npm test` and `npm run e2e` in full.');

  if (!run || !chosen.length) return;
  const node = chosen.filter((file) => file.startsWith('test/'));
  const components = chosen.filter((file) => /^packages\/[^/]+\/src\/client\//.test(file));
  const browser = chosen.filter((file) => file.startsWith('e2e/'));
  const step = (command, args) => {
    console.log(`\n$ ${command} ${args.join(' ')}`);
    try {
      /* The suites sign in from 127.0.0.1 more often than Better Auth's per-address limits allow; test-node.mjs lifts
         them the same way (auth.ts authLimitsOffForTests), and a selection must run the files as the gate does. */
      const env = { ...process.env, MISTRI_TEST_AUTH_LIMITS: process.env.MISTRI_TEST_AUTH_LIMITS ?? 'off' };
      execFileSync(command, args, { cwd: ROOT, stdio: 'inherit', env });
    } catch (error) {
      process.exit(typeof error.status === 'number' ? error.status : 1);
    }
  };
  if (node.length) step('npx', ['tsx', '--test', ...node]);
  if (components.length) step('npx', ['vitest', 'run', ...components]);
  if (browser.length) step('npx', ['playwright', 'test', ...browser]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
