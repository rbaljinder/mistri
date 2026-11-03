/**
 * Which package each test belongs to: the partition that lets a package run its own suites
 * (`node scripts/test-node.mjs --package=kit`, `npm run e2e -- --package=mistri`,
 * `TABLEWALK_TEST_PACKAGE=kit npm run test:components`).
 *
 * Read off the source, like the lanes, so a new test lands in a package by what it reaches rather than by somebody
 * remembering. A file reaches a package when it, or a helper it imports from `test/` or `e2e/`, names that package's
 * source (`packages/mistri/…`), imports it by name (`mistri/…`, `@mistriwork/kit/…`), or serves an App (`--app`, an App under `examples/apps` or `test/fixtures/apps`, the App servers the
 * Playwright config starts). The owner is the package furthest down the dependency graph among those it reaches:
 * engine ← ui ← kit ← mistri. A test that reaches mistri and engine tests mistri, which is engine's dependent. A test
 * may say `test-package: <owner>` in its own text where the rule cannot see what it reaches. The database browser,
 * which stands on engine, ui and kit as a host, keeps its own tests in its own repository
 * (https://github.com/rbaljinder/tablewalk).
 *
 * A test that reaches no package at all checks the repository itself (its scripts, its docs, its layout) and is
 * `shared` too.
 *
 *   node scripts/test-owners.mjs                  how many tests each package owns, by suite
 *   node scripts/test-owners.mjs --list=mistri    the files a package owns
 */
import { globSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Every owner, in dependency order: each one's tests may reach the ones before it. `shared` is no package's. */
export const OWNERS = ['shared', 'engine', 'ui', 'kit', 'mistri'];
/** A file's own say, for a file that reaches a package the rule cannot see. */
const DECLARED = /test-package:\s*(shared|engine|ui|kit|mistri)\b/;

/** Source without its comments: a header that mentions `--app` in a sentence is not serving one. */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

/** A file's code, plus the code of every module it imports from `test/` or `e2e/`: a helper is where the server
 * usually starts. */
function reach(file, seen = new Set()) {
  const absolute = resolve(ROOT, file);
  if (seen.has(absolute)) return '';
  seen.add(absolute);
  let text;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch {
    try {
      text = readFileSync(absolute.replace(/\.ts$/, '.tsx'), 'utf8');
    } catch {
      return '';
    }
  }
  let all = code(text);
  for (const [, specifier] of text.matchAll(/(?:from|import)\s*\(?\s*'(\.[^']+)'/g)) {
    const target = join(dirname(absolute), specifier).replace(/\.js$/, '.ts');
    const at = relative(ROOT, target).split('\\').join('/');
    if (at.startsWith('test/') || at.startsWith('e2e/')) all += reach(at.endsWith('.ts') || at.endsWith('.tsx') ? at : `${at}.ts`, seen);
  }
  /* A helper started by its path rather than imported (`spawn(node, ['--import', 'tsx', 'e2e/support/ladleHost.ts'])`)
     is reached as an import is: it is the server the test drives. */
  for (const [, at] of code(text).matchAll(/'((?:test|e2e)\/[\w./-]+\.tsx?)'/g)) all += reach(at, seen);
  return all;
}

/** The packages a text reaches. */
function reached(text) {
  const found = new Set();
  for (const [, name] of text.matchAll(/packages\/(engine|ui|kit|mistri)\//g)) found.add(name);
  for (const [, scoped, ui] of text.matchAll(/'(?:@mistriwork\/(engine|kit)|mistri-(ui))[/']/g)) found.add(scoped ?? ui);
  if (/'@mistriwork\/mistri[/']/.test(text)) found.add('mistri');
  if (/--app\b|fixtures\/apps\/|examples\/apps\/|TABLEWALK_E2E_(?:APP|CRM)_PORT/.test(text)) found.add('mistri');
  /* The App servers support/ownServers.ts and support/fixtures.ts start or describe, by the names a spec uses. */
  if (/\b(?:FIELDOPS|CRM|COMPASS|APP_DEMO_DB|CRM_DB|CRM_CONFIG|CRM_CLOCK|CRM_TODAY)\b|'(?:fieldops|crm)'/.test(text)) found.add('mistri');
  return found;
}

/** The owner of one test file: the package it sits in, the last one it reaches, or `shared`. */
export function ownerOf(file) {
  const own = readFileSync(resolve(ROOT, file), 'utf8');
  const declared = DECLARED.exec(own)?.[1];
  if (declared) return { owner: declared };
  /* A component test under a package's source is that package's; an App's own tests are mistri's. */
  const under = /^packages\/(engine|ui|kit|mistri)\//.exec(file)?.[1];
  if (under) return { owner: under };
  if (/^(examples\/apps|test\/fixtures\/apps)\//.test(file)) return { owner: 'mistri' };
  const text = reach(file);
  const found = reached(text);
  const owner = [...OWNERS].reverse().find((name) => found.has(name)) ?? 'shared';
  return { owner };
}

/** The component suite's files (vitest.config.ts includes exactly these). */
export const COMPONENT_GLOBS = [
  'packages/*/src/client/**/*.test.{ts,tsx}',
  // @mistriwork/ui's primitives sit at its src/ top; each renders here with no server.
  'packages/ui/src/**/*.test.{ts,tsx}',
  'packages/*/src/embed/**/*.test.{ts,tsx}',
  'examples/apps/*/widgets/**/*.test.{ts,tsx}',
  'examples/apps/*/*/widgets/**/*.test.{ts,tsx}',
  'examples/apps/*/pages/**/*.test.{ts,tsx}',
  'examples/apps/*/*/pages/**/*.test.{ts,tsx}',
  // The fixtures that were examples keep their components' tests.
  'test/fixtures/apps/*/widgets/**/*.test.{ts,tsx}',
  'test/fixtures/apps/*/*/widgets/**/*.test.{ts,tsx}',
  'test/fixtures/apps/*/pages/**/*.test.{ts,tsx}',
  'test/fixtures/apps/*/*/pages/**/*.test.{ts,tsx}',
];

/** Every test file of every suite. Exported so the structure test can hold the partition to the suites' own globs. */
export function suites() {
  const glob = (patterns) =>
    globSync(patterns, { cwd: ROOT, exclude: (path) => path.includes('node_modules') })
      .map((file) => file.split('\\').join('/'))
      .sort();
  return {
    node: glob(['test/**/*.test.ts', 'examples/apps/*/tests/*.test.ts']),
    components: glob(COMPONENT_GLOBS),
    e2e: glob(['e2e/**/*.spec.ts']),
  };
}

/** `files`, kept to the ones a package's run takes: its own, and the shared ones. */
export function ownedBy(files, name) {
  if (!OWNERS.includes(name) || name === 'shared') throw new Error(`--package takes one of ${OWNERS.slice(1).join(', ')}; got "${name}"`);
  return files.filter((file) => {
    const { owner } = ownerOf(file);
    return owner === name || owner === 'shared';
  });
}

/** The package a run is kept to: `--package=<name>` among `argv`, or `TABLEWALK_TEST_PACKAGE`, or none. */
export function packageArg(argv, env = process.env) {
  return argv.find((arg) => arg.startsWith('--package='))?.slice('--package='.length) ?? (env.TABLEWALK_TEST_PACKAGE || undefined);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const list = process.argv.find((arg) => arg.startsWith('--list='))?.slice('--list='.length);
  const all = suites();
  if (list) {
    for (const [suite, files] of Object.entries(all))
      for (const file of files) if (ownerOf(file).owner === list) console.log(`${suite}\t${file}`);
  } else {
    const unowned = [];
    for (const [suite, files] of Object.entries(all)) {
      const counts = Object.fromEntries(OWNERS.map((name) => [name, 0]));
      for (const file of files) {
        const { owner, why } = ownerOf(file);
        if (owner) counts[owner] += 1;
        else unowned.push(`${file}: ${why}`);
      }
      console.log(`${suite.padEnd(11)} ${OWNERS.map((name) => `${name} ${counts[name]}`).join(' · ')}`);
    }
    if (unowned.length) {
      console.error(`\n${unowned.length} with no one owner:\n${unowned.map((line) => `  ${line}`).join('\n')}`);
      process.exitCode = 1;
    }
  }
}
