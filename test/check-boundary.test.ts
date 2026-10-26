// test-package: shared — a check of the repository that names both binaries (scripts/test-owners.mjs).
/**
 * scripts/check-boundary.mjs holds the engine/ui/kit/browser/mistri boundary (docs/boundary.md). These run it over a
 * small workspace of its own, one package per layer: a new import the wrong way fails, whether it is written as a
 * path or as a package's name; and an allowlist entry the tree no longer has fails, so the list can only shrink.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOW, BINS, check, checkEntries, exportTarget } from '../scripts/check-boundary.mjs';
import { ENTRIES } from '../scripts/boundary/entries.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/check-boundary.mjs', import.meta.url));

const DEV = { './schema/*': './schema/*', './package.json': './package.json', './*': { 'mistri-built': './dist/*', default: './src/*' } };
const byPath = (path: string, source: string) => ({ [`./${path}`]: { 'mistri-built': `./dist/${path}`, default: `./src/${source}` } });
/* The engine, ui and kit name each module they export by its path; the products answer theirs with a pattern. */
const EXPLICIT: Record<string, object> = {
  '@fixture/engine': { ...byPath('shared/rule.js', 'shared/rule.ts'), './package.json': './package.json' },
  '@fixture/ui': { ...byPath('client/components/Button.js', 'client/components/Button.tsx'), './package.json': './package.json' },
  '@fixture/kit': { ...byPath('client/grid.js', 'client/grid.ts'), './package.json': './package.json' },
};
const manifest = (name: string, exports: object = {}) => JSON.stringify({ name, exports: { ...(EXPLICIT[name] ?? DEV), ...exports } });

/* The fixture's packages: one per layer, each answering its modules by path as a checkout does. */
const PACKAGES = {
  '@fixture/engine': { dir: 'packages/engine', layer: 'engine' },
  '@fixture/ui': { dir: 'packages/ui', layer: 'ui' },
  '@fixture/kit': { dir: 'packages/kit', layer: 'kit' },
  '@mistriwork/mistri': { dir: 'packages/mistri', layer: 'mistri' },
  tablewalk: { dir: 'packages/tablewalk', layer: 'browser' },
};
const TABLE = { packages: PACKAGES, entries: {} as Record<string, object> };

/** A workspace with one module per layer, every import the right way, and an empty allowlist. */
function tree(
  files: Record<string, string> = {},
  { bins = {} as object, allow = {} as Record<string, string> | null, table = TABLE as object } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'tablewalk-boundary-test-'));
  const all: Record<string, string> = {
    'packages/engine/package.json': manifest('@fixture/engine'),
    'packages/ui/package.json': manifest('@fixture/ui'),
    'packages/kit/package.json': manifest('@fixture/kit'),
    'packages/mistri/package.json': manifest('@mistriwork/mistri'),
    'packages/tablewalk/package.json': manifest('tablewalk'),
    'packages/engine/src/shared/rule.ts': 'export const rule = 1;\n',
    'packages/ui/src/client/components/Button.tsx': 'export const Button = 1;\n',
    'packages/kit/src/client/grid.ts':
      "import { rule } from '@fixture/engine/shared/rule.js';\nimport { Button } from '@fixture/ui/client/components/Button.js';\nexport const grid = rule + Button;\n",
    'packages/tablewalk/src/client/workbench.js': "import { grid } from '@fixture/kit/client/grid.js';\nexport const workbench = grid;\n",
    'packages/mistri/src/server/app/app.ts': "import { rule } from '@fixture/engine/shared/rule.js';\nexport const app = rule;\n",
    'packages/mistri/src/server/app/app.test.ts': "import '../../../../tablewalk/src/client/workbench.js';\n",
    [ENTRIES]: JSON.stringify(table),
    [BINS]: JSON.stringify({ bin: {}, ...bins }),
    ...(allow ? { [ALLOW]: JSON.stringify(allow) } : {}),
    ...files,
  };
  for (const [file, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

function run(files?: Record<string, string>, options?: Parameters<typeof tree>[1]) {
  const root = tree(files, options);
  try {
    return check(root).problems as string[];
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a workspace whose imports all go engine/ui <- kit <- browser/mistri passes; a test file is not a module', () => {
  assert.deepEqual(run(), []);
});

test("a package's exports answer a name as Node does in a checkout: the exact key, else the longest pattern", () => {
  const exports = { '.': { 'mistri-built': './dist/x.js', default: './src/x.ts' }, ...DEV, './client/*': './lib/*' };
  assert.equal(exportTarget(exports, '.'), './src/x.ts');
  assert.equal(exportTarget(exports, './shared/a.js'), './src/shared/a.js');
  assert.equal(exportTarget(exports, './client/b.js'), './lib/b.js');
  assert.equal(exportTarget({ '.': './x.js' }, './y'), null);
});

test('a new import the wrong way fails, by path or by package name, naming the layers and the fix', () => {
  const [problem, ...rest] = run({
    'packages/engine/src/shared/rule.ts': "import { app } from '@mistriwork/mistri/server/app/app.js';\nexport const rule = app;\n",
  });
  assert.deepEqual(rest, []);
  assert.match(
    problem,
    /^packages\/engine\/src\/shared\/rule\.ts -> packages\/mistri\/src\/server\/app\/app\.ts: engine -> mistri goes the wrong way\. The fix for this kind is rules-down/,
  );
  assert.match(
    run({ 'packages/kit/src/client/grid.ts': "import '../../../tablewalk/src/client/workbench.js';\n" })[0],
    /kit -> browser goes the wrong way/,
  );
  assert.match(
    run({ 'packages/tablewalk/src/client/workbench.js': "const app = () => import('@mistriwork/mistri/server/app/app.js');\n" })[0],
    /browser -> mistri goes the wrong way/,
  );
  assert.match(
    run({ 'packages/mistri/src/server/app/app.ts': "export * from 'tablewalk/client/workbench.js';\n" })[0],
    /mistri -> browser goes the wrong way/,
  );
  assert.match(
    run({
      'packages/ui/src/client/components/Button.tsx': "import { grid } from '@fixture/kit/client/grid.js';\nexport const Button = grid;\n",
    })[0],
    /ui -> kit goes the wrong way\. The fix for this kind is props/,
  );
  assert.match(
    run({ 'packages/engine/src/shared/rule.ts': "import '@fixture/ui/client/components/Button.js';\nexport const rule = 1;\n" })[0],
    /engine -> ui goes the wrong way/,
  );
});

test('a name the engine, ui or kit does not export fails, however it is written; there is no list to excuse it', () => {
  const files = { 'packages/engine/src/shared/hidden.ts': 'export const hidden = 1;\n' };
  for (const line of [
    "import { hidden } from '@fixture/engine/shared/hidden.js';\n",
    "export { hidden } from '@fixture/engine/shared/hidden.js';\n",
    "import type { hidden } from '@fixture/engine/shared/hidden.js';\n",
    "const hidden = () => import('@fixture/engine/shared/hidden.js');\n",
  ])
    assert.deepEqual(run({ ...files, 'packages/kit/src/client/grid.ts': line }), [
      "packages/kit/src/client/grid.ts imports @fixture/engine/shared/hidden.js, which @fixture/engine's exports do not name: " +
        'import a name it exports, or add the module to its package.json "exports" by its path.',
    ]);
  const exported = manifest('@fixture/engine', byPath('shared/hidden.js', 'shared/hidden.ts'));
  assert.deepEqual(
    run({
      ...files,
      'packages/engine/package.json': exported,
      'packages/kit/src/client/grid.ts': "import '@fixture/engine/shared/hidden.js';\n",
    }),
    [],
  );
});

test('a published type file is a module of the package it sits in', () => {
  const files = {
    'packages/engine/schema/theme.d.ts': 'export type Look = string;\n',
    'packages/mistri/schema/app.d.ts': 'export type App = string;\n',
  };
  assert.deepEqual(
    run({
      ...files,
      'packages/engine/package.json': manifest('@fixture/engine', { './schema/theme.js': './schema/theme.d.ts' }),
      'packages/kit/src/client/grid.ts': "import type { Look } from '@fixture/engine/schema/theme.js';\n",
    }),
    [],
  );
  assert.match(
    run({ ...files, 'packages/kit/src/client/grid.ts': "import type { App } from '@mistriwork/mistri/schema/app.js';\n" })[0],
    /^packages\/kit\/src\/client\/grid\.ts -> packages\/mistri\/schema\/app\.d\.ts: kit -> mistri/,
  );
});

test("the declared bin may load each product's main with import(), and nothing else across the line", () => {
  const index = 'packages/tablewalk/src/server/index.ts';
  const mains = ['packages/tablewalk/src/server/cli/browserMain.ts', 'packages/mistri/src/server/cli/mistriMain.ts'];
  const bins = { bin: { [index]: { mains, reason: 'one bin, both products' } } };
  const lazy =
    "const mains = { b: () => import('./cli/browserMain.js'), m: () => import('@mistriwork/mistri/server/cli/mistriMain.js') };\n";
  const files = {
    'packages/tablewalk/src/server/cli/browserMain.ts': 'export const main = 1;\n',
    'packages/mistri/src/server/cli/mistriMain.ts': 'export const main = 2;\n',
    [index]: lazy,
  };
  assert.deepEqual(run(files, { bins }), []);
  /* Undeclared, the same import is a crossing like any other. */
  assert.match(run(files)[0], /index\.ts -> packages\/mistri\/src\/server\/cli\/mistriMain\.ts: browser -> mistri goes the wrong way/);
  /* A static import would make the browser's package fail to start without the App framework. */
  assert.match(
    run(
      { ...files, [index]: "import '@mistriwork/mistri/server/cli/mistriMain.js';\nconst b = () => import('./cli/browserMain.js');\n" },
      { bins },
    ).join('\n'),
    /bin packages\/tablewalk\/src\/server\/index\.ts imports packages\/mistri\/src\/server\/cli\/mistriMain\.ts statically/,
  );
  /* The exception is the declared mains only. */
  assert.match(
    run({ ...files, [index]: lazy + "const app = () => import('@mistriwork/mistri/server/app/app.js');\n" }, { bins })[0],
    /index\.ts -> packages\/mistri\/src\/server\/app\/app\.ts: browser -> mistri goes the wrong way/,
  );
  assert.match(
    run({ ...files, [index]: "const b = () => import('./cli/browserMain.js');\n" }, { bins }).join('\n'),
    /no longer imports packages\/mistri\/src\/server\/cli\/mistriMain\.ts/,
  );
  assert.match(
    run(files, { bins: { bin: { [index]: { mains } } } }).join('\n'),
    /bin packages\/tablewalk\/src\/server\/index\.ts needs the reason/,
  );
});

test('a type-only import counts, and is reported as type-only; so is a JSDoc import in a .js module', () => {
  const rule = 'packages/engine/src/shared/rule.ts';
  const grid = 'packages/kit/src/client/grid.ts';
  assert.match(
    run({ [rule]: "import type { App } from '@mistriwork/mistri/server/app/app.js';\nexport type Rule = App;\n" })[0],
    /engine -> mistri goes the wrong way \(type-only/,
  );
  assert.match(
    run({ [rule]: "import { type App } from '@mistriwork/mistri/server/app/app.js';\nexport type Rule = App;\n" })[0],
    /\(type-only/,
  );
  assert.match(
    run({ [grid]: "export type W = import('tablewalk/client/workbench.js').W;\n" })[0],
    /kit -> browser goes the wrong way \(type-only/,
  );
  assert.match(
    run({ [grid]: "/** @type {import('tablewalk/client/workbench.js').W} */\nexport const grid = 1;\n" })[0],
    /kit -> browser goes the wrong way \(type-only/,
  );
  assert.deepEqual(
    run({ [grid]: "const text = \"import '@mistriwork/mistri/server/app/app.js'\";\n// import 'tablewalk/client/workbench.js';\n" }),
    [],
    'strings and comments are not imports',
  );
});

const CROSSING = 'packages/engine/src/shared/rule.ts -> packages/mistri/src/server/app/app.ts';
const RUNTIME = {
  'packages/engine/src/shared/rule.ts': "import { app } from '@mistriwork/mistri/server/app/app.js';\nexport const rule = app;\n",
};

test('an allowlisted crossing passes; one allowed as a type fails once it imports a value', () => {
  assert.deepEqual(run(RUNTIME, { allow: { [CROSSING]: 'rules-down' } }), []);
  assert.match(
    run(RUNTIME, { allow: { [CROSSING]: 'rules-down, type-only' } })[0],
    /it was allowed as a type-only import and now imports a value/,
  );
});

test('a package the table gives an unknown layer fails', () => {
  const table = { packages: { ...PACKAGES, tablewalk: { dir: 'packages/tablewalk', layer: 'workbench' } }, entries: {} };
  assert.match(
    run({}, { table }).join('\n'),
    /package tablewalk names layer "workbench", which is not one of engine, ui, kit, browser, mistri/,
  );
});

test('an allowlist entry the tree no longer has fails, with the command that removes it', () => {
  const [problem] = run({}, { allow: { [CROSSING]: 'rules-down' } });
  assert.match(
    problem,
    /^1 scripts\/boundary\/allow\.json entry is no longer in the tree; remove it with `node scripts\/check-boundary\.mjs --write`:/,
  );
  assert.match(problem, /packages\/engine\/src\/shared\/rule\.ts -> packages\/mistri\/src\/server\/app\/app\.ts/);
});

test('--write writes the allowlist once, then only removes fixed entries and never adds one', () => {
  const root = tree(RUNTIME, { allow: null });
  const cli = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' });
  try {
    assert.equal(cli().status, 1, 'no allowlist yet');
    assert.equal(cli('--write').status, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(root, ALLOW), 'utf8')), { [CROSSING]: 'rules-down' });
    assert.equal(cli().status, 0);
    writeFileSync(join(root, 'packages/kit/src/client/grid.ts'), "import 'tablewalk/client/workbench.js';\n");
    const grown = cli('--write');
    assert.equal(grown.status, 1);
    assert.match(
      grown.stderr,
      /not allowlisted, fix it: packages\/kit\/src\/client\/grid\.ts -> packages\/tablewalk\/src\/client\/workbench\.js/,
    );
    writeFileSync(join(root, 'packages/kit/src/client/grid.ts'), 'export const grid = 1;\n');
    writeFileSync(join(root, 'packages/engine/src/shared/rule.ts'), 'export const rule = 1;\n');
    assert.equal(cli().status, 1, 'the fixed crossing is stale');
    assert.equal(cli('--write').status, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(root, ALLOW), 'utf8')), {});
    const report = cli('--report');
    assert.equal(report.status, 0);
    assert.match(report.stdout, /engine +1\n +ui +1\n +kit +1\n +browser +1\n +mistri +1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* The fixture's entries: the engine's and the kit's mains, and the App framework's one published module. */
const ENTRY_TABLE = {
  packages: PACKAGES,
  entries: {
    '@fixture/engine': {
      layer: 'engine',
      source: 'packages/engine/src/shared/rule.ts',
      types: 'packages/engine/src/shared/rule.ts',
    },
    '@fixture/kit': { layer: 'kit', source: 'packages/kit/src/client/grid.ts', types: 'packages/kit/src/client/grid.ts' },
    '@mistriwork/mistri/app': {
      layer: 'mistri',
      source: 'packages/mistri/src/server/app/app.ts',
      types: 'packages/mistri/src/server/app/app.ts',
    },
  },
};
const ENTRY_FILES = {
  'package.json': JSON.stringify({ name: 'fixture-workspace', private: true, workspaces: Object.values(PACKAGES).map(({ dir }) => dir) }),
  'packages/engine/package.json': manifest('@fixture/engine', {
    '.': { 'mistri-built': './dist/shared/rule.js', default: './src/shared/rule.ts' },
  }),
  'packages/kit/package.json': manifest('@fixture/kit', {
    '.': { 'mistri-built': './dist/client/grid.js', default: './src/client/grid.ts' },
  }),
  'packages/mistri/package.json': manifest('@mistriwork/mistri', {
    './app': {
      'mistri-built': { types: './dist/server/app/app.d.ts', default: './dist/server/app/app.js' },
      default: './src/server/app/app.ts',
    },
  }),
};

function entries(files: Record<string, string> = {}, { table = ENTRY_TABLE as object, allow = {} } = {}) {
  const root = tree({ ...ENTRY_FILES, ...files }, { allow, table });
  try {
    return checkEntries(check(root)).problems as string[];
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('entries: each stays in its layer, and its package exports it from its source', () => {
  assert.deepEqual(entries(), []);
  /* In another layer's package. */
  const kitAsEngine = {
    ...ENTRY_TABLE,
    entries: { ...ENTRY_TABLE.entries, '@fixture/kit': { ...ENTRY_TABLE.entries['@fixture/kit'], layer: 'engine' } },
  };
  assert.match(
    entries({}, { table: kitAsEngine }).join('\n'),
    /@fixture\/kit: its source packages\/kit\/src\/client\/grid\.ts is kit's, not engine's/,
  );
  /* An allowlisted crossing on the way is counted, not failed; one off the list fails with the path to it. */
  const deep = {
    'packages/kit/src/client/grid.ts': "import './middle.ts';\nexport const grid = 1;\n",
    'packages/kit/src/client/middle.ts': "import 'tablewalk/client/workbench.js';\n",
  };
  assert.deepEqual(
    entries(deep, { allow: { 'packages/kit/src/client/middle.ts -> packages/tablewalk/src/client/workbench.js': 'slots' } }),
    [],
  );
  const problems = entries(deep).join('\n');
  assert.match(problems, /@fixture\/kit \(kit\) reaches packages\/tablewalk\/src\/client\/workbench\.js, which is browser's/);
  assert.match(
    problems,
    /packages\/kit\/src\/client\/grid\.ts\n {4}packages\/kit\/src\/client\/middle\.ts\n {4}packages\/tablewalk\/src\/client\/workbench\.js/,
  );
  /* Built from another module, resolved elsewhere in a checkout, an export no entry names, a workspace the root lacks. */
  const elsewhere = manifest('@mistriwork/mistri', {
    './app': {
      'mistri-built': { types: './dist/server/app/x.d.ts', default: './dist/server/app/x.js' },
      default: './src/server/app/app.ts',
    },
  });
  assert.match(
    entries({ 'packages/mistri/package.json': elsewhere }).join('\n'),
    /built, it serves \.\/dist\/server\/app\/x\.js, which is not built from src\/server\/app\/app\.ts/,
  );
  const checkout = manifest('@mistriwork/mistri', { './app': { default: './src/server/app/x.ts' } });
  assert.match(entries({ 'packages/mistri/package.json': checkout }).join('\n'), /in a checkout it resolves to src\/server\/app\/x\.ts/);
  assert.match(
    entries({ 'packages/mistri/package.json': manifest('@mistriwork/mistri') }).join('\n'),
    /mistri\/app: packages\/mistri\/package\.json "exports" does not have it/,
  );
  const extra = manifest('@fixture/kit', { '.': { default: './src/client/grid.ts' }, './more': './src/more.ts' });
  assert.match(entries({ 'packages/kit/package.json': extra }).join('\n'), /packages\/kit\/package\.json exports \.\/more, which no entry/);
  /* A module by its path needs no entry; a pattern in the engine, ui or kit is refused, in the products it is not. */
  const pattern = manifest('@fixture/kit', { '.': { default: './src/client/grid.ts' }, './*': './src/*' });
  assert.match(
    entries({ 'packages/kit/package.json': pattern }).join('\n'),
    /packages\/kit\/package\.json exports the pattern \.\/\*: @fixture\/kit names each module it exports by its path/,
  );
  const astray = manifest('@fixture/kit', { '.': { default: './src/client/grid.ts' }, './client/grid.js': './src/client/other.ts' });
  assert.match(
    entries({ 'packages/kit/package.json': astray }).join('\n'),
    /exports \.\/client\/grid\.js, which no entry .* does not answer from the module its path names/,
  );
  assert.match(entries({ 'package.json': JSON.stringify({ name: 'x', workspaces: [] }) }).join('\n'), /"workspaces" is \[\]/);
});

test("the tree's own allowlist is empty: every crossing is fixed, or its file placed in another package", () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  /* Closed since 0.9.8: a crossing is fixed, or its file placed differently, never listed. */
  assert.deepEqual(JSON.parse(readFileSync(join(root, ALLOW), 'utf8')), {});
});
