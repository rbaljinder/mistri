/**
 * `mistri upgrade` on fixture files: the import rewrite, the key renames, a refusal named by file and line, `--check`'s
 * exit codes, and that a second run has nothing left to do.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { runUpgrade, upgradeSource } from '../packages/mistri/src/server/cli/upgrade.js';

const OLD_APP = `import { defineApp, table } from 'tablewalk/app';
import { command } from "tablewalk/commands";
import type { CustomTotal } from 'tablewalk/ui';

// import { x } from 'tablewalk/app' in a comment is left as it is
const note = "tablewalk/app in a string";

export default defineApp({
  name: 'Desk',
  views: {
    overview: {
      kind: 'dashboard',
      layout: [['sales', 'sales'], ['tasks', 'tasks']],
      sections: [{ kind: 'custom', totals: { open: 'count' } }],
    },
    tasks: { kind: 'list', table: 'task', totals: ['amount'] },
  },
  pages: { order: { layout: 'listing' } },
  ui: {
    theme: {
      recipes: { head: 'quiet' },
      nav: { currentInk: '#fff' },
      type: { roles: { body: { face: 'mono' }, label: { face: 'sans' } } },
    },
  },
});
`;

const made: string[] = [];
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A folder with the files named, each written under its path. */
function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mistri-upgrade-'));
  made.push(dir);
  for (const [name, text] of Object.entries(files)) {
    const file = join(dir, name);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
  }
  return dir;
}

const run = (argv: string[]) => {
  let out = '';
  let err = '';
  const code = runUpgrade(
    argv,
    (text) => (out += text),
    (text) => (err += text),
  );
  return { code, out, err };
};

test('the old package becomes @mistriwork/mistri in an import, and only in an import', () => {
  const { text } = upgradeSource(OLD_APP);
  assert.match(text, /from '@mistriwork\/mistri\/app'/);
  assert.match(text, /from "@mistriwork\/mistri\/commands"/);
  assert.match(text, /from '@mistriwork\/mistri\/ui'/);
  assert.match(text, /\/\/ import \{ x \} from 'tablewalk\/app' in a comment/);
  assert.match(text, /"tablewalk\/app in a string"/);
  assert.equal(
    upgradeSource("const lazy = await import('tablewalk/page'); require('tablewalk/jobs');").text,
    "const lazy = await import('@mistriwork/mistri/page'); require('@mistriwork/mistri/jobs');",
  );
  assert.equal(upgradeSource("import 'tablewalk/handler';").text, "import '@mistriwork/mistri/handler';");
});

test('a renamed key is renamed where it means one thing, and a key of the same name elsewhere is not', () => {
  const { text } = upgradeSource(OLD_APP);
  assert.match(text, /areas: \[\['sales', 'sales'\]/);
  assert.match(text, /figures: \{ open: 'count' \}/);
  assert.match(text, /totals: \['amount'\]/);
  assert.match(text, /layout: 'showcase'/);
  assert.match(text, /recipes: \{ header: 'quiet' \}/);
  assert.match(text, /nav: \{ onCurrent: '#fff' \}/);
  assert.match(text, /body: \{ face: 'code' \}/);
  assert.match(text, /label: \{ face: 'ui' \}/);
  assert.match(text, /CustomFigure/);
  assert.equal(upgradeSource('defineTheme({ palette: { light: {}, dark: {} } })').text, 'defineTheme({ colors: { light: {}, dark: {} } })');
  assert.equal(upgradeSource("ui: { theme: { palette: 'sage' } }").text, "ui: { theme: { palette: 'sage' } }");
  assert.equal(upgradeSource("const list = { head: 1, layout: 'record' };").text, "const list = { head: 1, layout: 'record' };");
});

test('a name inside a string, a template or a regular expression is never rewritten', () => {
  const source = 'const a = `layout: [1] ${ {x: 1}.x } totals: { y }`; const b = /face: \'mono\'/; const c = "recipes: { head: 1 }";';
  assert.deepEqual(upgradeSource(source).changes, []);
});

test('what cannot be rewritten safely is refused with its line, and the rest of the file still is', () => {
  const source = `import { count, defineApp } from 'tablewalk/app';\n\nconst x = 1;\nexport default defineApp({ flagSegments: {} });\n`;
  const result = upgradeSource(source);
  assert.deepEqual(
    result.refusals.map((each) => [each.line, each.said.split(' ')[0]]),
    [
      [1, 'count'],
      [4, 'flagSegments'],
    ],
  );
  assert.match(result.text, /from '@mistriwork\/mistri\/app'/);
  /* A rollup written as a call, or a command's own count, is not the old import. */
  assert.deepEqual(upgradeSource("import { count } from '@mistriwork/mistri/commands'; rollup.count('x');").refusals, []);
});

test('the command rewrites files, names refusals as file:line, and exits 1 while one remains', () => {
  const dir = folder({
    'app.ts': OLD_APP,
    'commands.ts': "import { count } from 'tablewalk/app';\n",
    'node_modules/dep/index.ts': "import 'tablewalk/app';\n",
    'mistri-schema.d.ts': "import 'tablewalk/app';\n",
  });
  const first = run(['--app', dir]);
  assert.equal(first.code, 1, first.out);
  assert.match(first.out, /changed .*app\.ts/);
  assert.match(first.out, /refused .*commands\.ts:1: count /);
  assert.match(readFileSync(join(dir, 'app.ts'), 'utf8'), /@mistriwork\/mistri\/app/);
  assert.match(readFileSync(join(dir, 'node_modules/dep/index.ts'), 'utf8'), /tablewalk\/app/);
  assert.match(readFileSync(join(dir, 'mistri-schema.d.ts'), 'utf8'), /tablewalk\/app/);
});

test('--check writes nothing and exits 1 when a run would change a file, 0 when none would', () => {
  const dir = folder({ 'app.ts': OLD_APP });
  const checked = run(['--app', dir, '--check']);
  assert.equal(checked.code, 1);
  assert.match(checked.out, /would change .*app\.ts/);
  assert.equal(readFileSync(join(dir, 'app.ts'), 'utf8'), OLD_APP);
  assert.equal(run(['--app', dir]).code, 0);
  const after = run(['--app', dir, '--check']);
  assert.equal(after.code, 0, after.out);
  assert.match(after.out, /Nothing to upgrade/);
});

test('a second run changes nothing', () => {
  const dir = folder({ 'app.ts': OLD_APP, 'other.ts': "import { x } from 'tablewalk/page';\n" });
  run(['--app', dir]);
  const once = [readFileSync(join(dir, 'app.ts'), 'utf8'), readFileSync(join(dir, 'other.ts'), 'utf8')];
  const again = run(['--app', dir]);
  assert.equal(again.code, 0, again.out);
  assert.deepEqual([readFileSync(join(dir, 'app.ts'), 'utf8'), readFileSync(join(dir, 'other.ts'), 'utf8')], once);
  assert.equal(upgradeSource(once[0]!).text, once[0]);
});

test("the looks' renamed tokens are rewritten in sources and stylesheets; one the App declares itself is refused", () => {
  const dir = folder({
    'c/tile.css': '.c-tile { color: var(--text-dim); border: 1px solid var(--border-strong, red); --bg: white; background: var(--bg); }\n',
    'c/tile.tsx': "export default () => <b style={{ color: 'var(--danger)', gap: `var(--space-2)` }} />;\nconst ok = useToken('--ok');\n",
  });
  const first = run(['--app', dir]);
  assert.equal(first.code, 1, first.out);
  assert.equal(
    readFileSync(join(dir, 'c/tile.css'), 'utf8'),
    '.c-tile { color: var(--ink-muted); border: 1px solid var(--line-strong, red); --bg: white; background: var(--bg); }\n',
  );
  assert.equal(
    readFileSync(join(dir, 'c/tile.tsx'), 'utf8'),
    "export default () => <b style={{ color: 'var(--status-critical)', gap: `var(--space-2)` }} />;\nconst ok = useToken('--status-good');\n",
  );
  assert.match(first.out, /refused .*tile\.css:1: --bg is the App's own property/);
  /* A token that is the looks' own today, or a longer name, is left alone. */
  assert.deepEqual(upgradeSource("const a = 'var(--ink) var(--text-sm) var(--border-width)';").changes, []);
});

test('a flag it does not take, or a folder that is not there, is exit 2', () => {
  assert.equal(run(['--force']).code, 2);
  assert.equal(run(['--app', join(tmpdir(), 'mistri-upgrade-no-such-folder')]).code, 2);
});
