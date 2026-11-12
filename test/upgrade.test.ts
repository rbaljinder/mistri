/**
 * `mistri upgrade` on fixture files: the import rewrite, the key renames, a refusal named by file and line, `--check`'s
 * exit codes, and that a second run has nothing left to do.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { RENAMED_TABLES } from '../packages/mistri/src/shared/renamedWords.js';
import { runUpgrade, upgradeSource } from '../packages/mistri/src/server/cli/upgrade.js';
import { GENERIC_TOKENS, KEYS, NAMES, REFUSED, TOKENS, VALUES } from '../packages/mistri/src/server/cli/upgradeRenames.js';

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
  assert.equal(upgraded('defineTheme({ palette: { light: {}, dark: {} } })'), 'defineTheme({ colors: { light: {}, dark: {} } })');
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
    'c/tile.tsx':
      "import { useToken } from '@mistriwork/mistri/ui';\nexport default () => <b style={{ color: 'var(--danger)', gap: `var(--space-2)` }} />;\nconst ok = useToken('--ok');\n",
  });
  const first = run(['--app', dir]);
  assert.equal(first.code, 1, first.out);
  assert.equal(
    readFileSync(join(dir, 'c/tile.css'), 'utf8'),
    '.c-tile { color: var(--ink-muted); border: 1px solid var(--line-strong, red); --bg: white; background: var(--bg); }\n',
  );
  assert.equal(
    readFileSync(join(dir, 'c/tile.tsx'), 'utf8'),
    "import { useToken } from '@mistriwork/mistri/ui';\nexport default () => <b style={{ color: 'var(--status-critical)', gap: `var(--space-2)` }} />;\nconst ok = useToken('--status-good');\n",
  );
  assert.match(first.out, /refused .*tile\.css:1: --bg is the App's own property/);
  /* A token that is the looks' own today, or a longer name, is left alone. */
  assert.deepEqual(upgradeSource("const a = 'var(--ink) var(--text-sm) var(--border-width)';").changes, []);
});

test('a flag it does not take, or a folder that is not there, is exit 2', () => {
  assert.equal(run(['--force']).code, 2);
  assert.equal(run(['--app', join(tmpdir(), 'mistri-upgrade-no-such-folder')]).code, 2);
});

/** `source` upgraded, as its text; and the lines it refused. */
/* The DSL's calls and a type of its own, imported on the fixture's first line so the line numbers are the fixture's. */
const DSL =
  "import { calendar, defineApp, definePage, defineTheme, embed, fromRecord, metric, page, stream, type View } from '@mistriwork/mistri/app'; ";
function upgraded(source: string): string {
  const upgraded = upgradeSource(DSL + source).text;
  assert.ok(upgraded.startsWith(DSL));
  return upgraded.slice(DSL.length);
}
const text = upgraded;
const refusedLines = (source: string) => upgradeSource(DSL + source).refusals.map((each) => each.line);

test('every word a loader refuses as renamed is a KEYS row or a REFUSED one, so check and upgrade cannot drift', () => {
  const unhandled: string[] = [];
  for (const [table, rows] of Object.entries(RENAMED_TABLES)) {
    for (const row of rows) {
      const rewritten = row.to !== undefined && KEYS.some((each) => each.table === table && each.from === row.from && each.to === row.to);
      const refused = REFUSED.some((each) => each.table === table && each.name === row.from);
      /* A word that is gone or moved has no `to`: a rewrite cannot put it right, so it is refused. */
      const valued = VALUES.some((each) => each.key === row.from && each.to === row.to) || NAMES[row.from] === row.to;
      if (row.to === undefined ? !refused : !rewritten && !refused && !valued) unhandled.push(`${table}.${row.from}`);
    }
  }
  assert.deepEqual(unhandled, []);
  /* The other direction: a row that names a table names one a loader reads. */
  for (const each of [...KEYS, ...REFUSED]) assert.ok(each.table === undefined || each.table in RENAMED_TABLES, `${each.table}`);
});

test('a page file: title is label inside definePage only, path is refused, and nav.order is nav.position', () => {
  assert.equal(
    text("export default definePage({ title: 'Pick walk', views: { a: { title: 'A' } } });"),
    "export default definePage({ label: 'Pick walk', views: { a: { title: 'A' } } });",
  );
  assert.equal(
    text('const title = 1; export default definePage({ title, nav: { order: 2, group: "g" } });'),
    'const title = 1; export default definePage({ label: title, nav: { position: 2, group: "g" } });',
  );
  /* Another call's `title`, a theme's `nav`, and a bare object are what they were. */
  const same = "defineCard({ title: 'x' }); const t = { nav: { order: 1 } }; defineApp({ nav: { order: 1 } }); const o = { title: 'x' };";
  assert.equal(text(same), same);
  assert.deepEqual(refusedLines("definePage({\n  path: '/x',\n  nav: { icon: 'x' },\n});"), [2, 3]);
  /* A key that arrives through a spread, a computed name or a variable cannot be placed. */
  assert.deepEqual(refusedLines('definePage({ ...base, label: "x" });'), [1]);
  assert.deepEqual(refusedLines('definePage({ [key]: 1 });'), [1]);
  assert.deepEqual(refusedLines('definePage(config);'), [1]);
});

test('dashboard sections: a metric view is to, an embed tab is listTab, a custom totals is figures', () => {
  assert.equal(text("metric('Overdue', 'task', { view: 'overdue_list' });"), "metric('Overdue', 'task', { to: 'overdue_list' });");
  assert.equal(text("embed('tasks', { tab: 'open', limit: 5 });"), "embed('tasks', { listTab: 'open', limit: 5 });");
  const same = "chart('x', 'task', { view: 1 }); other('tasks', { tab: 'open' }); const v = { view: 1, tab: 2 };";
  assert.equal(text(same), same);
  assert.deepEqual(refusedLines("metric('Overdue', 'task', { ...shared, view: 'x' });"), [1]);
});

test('views: table and keys on a list, table on a dashboard, with the kind they say they are; refresh is refused', () => {
  assert.equal(
    text("const v: View = { kind: 'list', table: 'task', keys: { e: 'edit' }, totals: ['amount'] };"),
    "const v: View = { kind: 'list', from: 'task', shortcuts: { e: 'edit' }, totals: ['amount'] };",
  );
  assert.equal(
    text("const d = { sections: [], table: 'task', kind: 'dashboard' } satisfies View;"),
    "const d = { sections: [], from: 'task', kind: 'dashboard' } satisfies View;",
  );
  const same =
    "const f: View = { kind: 'form', table: 'task' }; const g: View = { table: 'task' }; const h: View = { kind: 'list', view: { table: 1 } };";
  assert.equal(text(same), same);
  assert.deepEqual(refusedLines("defineApp({\n  kind: 'dashboard',\n  refresh: 30,\n});"), [3]);
  assert.deepEqual(refusedLines("defineApp({ kind: 'list', refresh: 30 });"), []);
});

test('presentations and backdrops: facts on a queue, lines on cards, and the span words of a backdrop', () => {
  assert.equal(
    text("const q: View = { kind: 'queue', primary: 'a', facts: ['b'], lines: ['c'] };"),
    "const q: View = { kind: 'queue', primary: 'a', properties: ['b'], lines: ['c'] };",
  );
  assert.equal(
    text("const c: View = { kind: 'cards', primary: 'a', lines: ['b'], facts: ['c'] };"),
    "const c: View = { kind: 'cards', primary: 'a', properties: ['b'], facts: ['c'] };",
  );
  assert.equal(
    text("calendar('x', 'y', { backdrop: [{ resource: 'holiday', to: 'ends', label: 'name' }], resource: 'x', to: 'y' });"),
    "calendar('x', 'y', { backdrop: [{ from: 'holiday', end: 'ends', labelColumn: 'name' }], resource: 'x', to: 'y' });",
  );
});

test("a tenant's branding row: base is preset and brandColor is accent, under fromRecord's fallback and fields", () => {
  assert.equal(
    text("fromRecord('tenant', { fallback: { base: 'mono' }, fields: { brandColor: 'color', base: 'look' } });"),
    "fromRecord('tenant', { fallback: { preset: 'mono' }, fields: { accent: 'color', preset: 'look' } });",
  );
  const same =
    "const a = { fallback: { base: 1 } }; other('t', { fields: { brandColor: 1 } }); fromRecord('t', { elsewhere: { base: 1 } });";
  assert.equal(text(same), same);
});

test('a timeline stream detail or show is refused, not renamed: the positional word needs a reader', () => {
  assert.deepEqual(refusedLines("stream('email', 'ticket_id', 'sent_at', 'subject', {\n  detail: 'status',\n});"), [2]);
  assert.deepEqual(refusedLines("page('x', { streams: [{ from: 'email', show: 'subject', detail: 'status' }] });"), [1, 1]);
  assert.deepEqual(refusedLines("const a = { show: ['x'], detail: 1 }; other('x', { detail: 1 });"), []);
});

test("a record page's section words: renamed where they read the same, refused where the new word is an argument or another shape", () => {
  const SECTIONS = "import { fields, headline, related, stream, timeline } from '@mistriwork/mistri/app';\n";
  const up = (source: string) => upgradeSource(SECTIONS + source);
  assert.equal(
    up("fields(['name'], { edit: true }); related('Notes', 'note', 'ticket_id', { of: 'site_id', orderBy: 'due_on desc' });").text,
    SECTIONS + "fields(['name'], { editable: true }); related('Notes', 'note', 'ticket_id', { about: 'site_id', sort: 'due_on desc' });",
  );
  assert.equal(
    up("headline('price', { links: [{ label: 'Ask', to: 'inquire', kind: 'primary' }] });").text,
    SECTIONS + "headline('price', { links: [{ label: 'Ask', to: 'inquire', intent: 'primary' }] });",
  );
  const refused = up(
    [
      "fields([], { paths: ['name'] });",
      "related('Notes', 'note', 'x', { path: 'ticket_id' });",
      "timeline('Activity', [stream('email', 'ticket_id', 'sent_at', 'subject', { tint: 'warn' })], { order: 'asc' });",
    ].join('\n'),
  ).refusals.map((each) => each.line);
  assert.deepEqual(refused, [2, 3, 4, 4]);
  /* The same words in an App's own objects, or a call that is not mistri's, are left alone. */
  const own = "const q = { edit: true, of: 'x', orderBy: 'y', path: 'z', kind: 'a', links: [{ kind: 'b' }] }; other({ order: 1 });";
  assert.equal(up(own).text, SECTIONS + own);
  assert.deepEqual(up(own).refusals, []);
});

test('a kit prop is renamed on a component imported from the kit, by whatever name, and on nothing else', () => {
  const kit =
    "import { Rows, Metric as Figure } from '@mistriwork/mistri/ui';\nimport * as Kit from '@mistriwork/kit';\nimport { Table } from 'antd';\nimport { Mine } from 'tablewalk/ui';\n";
  const body = [
    '<Rows resource="task" where="open" />',
    '<Figure\n  title="x"\n  resource={name}\n/>',
    '<Kit.Board resource="task">{rows}</Kit.Board>',
    '<Table resource="task" />',
    '<Local resource="task" />',
    '<Mine resource="task" />',
    '<Rows from="task" />',
  ].join('\n');
  const result = upgradeSource(`${kit}export default () => (<>\n${body}\n</>);\n`);
  assert.equal(
    result.text,
    `${kit.replace('tablewalk/ui', '@mistriwork/mistri/ui')}export default () => (<>\n${body
      .replace('<Rows resource', '<Rows from')
      .replace('  resource={name}', '  from={name}')
      .replace('<Kit.Board resource', '<Kit.Board from')}\n</>);\n`,
  );
  assert.deepEqual(result.refusals, []);
  /* The key form of the same word is not a prop. */
  assert.equal(
    text("import { Rows } from '@mistriwork/mistri/ui';\nconst x = { resource: 'task' };\n"),
    "import { Rows } from '@mistriwork/mistri/ui';\nconst x = { resource: 'task' };\n",
  );
});

test("a kit component reached through a spread or through the App's own module is refused with its line", () => {
  const kit = "import { Rows } from '@mistriwork/mistri/ui';\nimport { Table } from './components';\n";
  const result = upgradeSource(
    `${kit}const a = <Rows {...props} />;\nconst b = <Rows\n  where="x" {...rest} />;\nconst c = <Table resource="task" />;\nconst d = <Table from="task" {...rest} />;\n`,
  );
  assert.deepEqual(
    result.refusals.map((each) => each.line),
    [3, 5, 6],
  );
  assert.match(result.refusals[0]!.said, /spreads props into a kit component/);
  assert.match(result.refusals[2]!.said, /App's own module/);
  assert.equal(result.changes.length, 0);
});

test('the command refuses an ambiguous kit prop with file and line, and --check exits 1 on it', () => {
  const dir = folder({ 'page.tsx': "import { Rows } from '@mistriwork/mistri/ui';\nexport default () => <Rows {...props} />;\n" });
  const checked = run(['--app', dir, '--check']);
  assert.equal(checked.code, 1);
  assert.match(checked.out, /refused .*page\.tsx:2: <Rows \{\.\.\.spread\}>/);
  assert.equal(run(['--app', dir]).code, 1);
});

/** An App folder whose one dependency, fancy-ui, sets `--border`, and whose transitive one, deep-ui, sets `--bg`. */
const withDependencies = (files: Record<string, string>) =>
  folder({
    'package.json': JSON.stringify({ name: 'app', dependencies: { 'fancy-ui': '1.0.0', '@mistriwork/mistri': '1.0.0' } }),
    'node_modules/fancy-ui/package.json': JSON.stringify({ name: 'fancy-ui', dependencies: { 'deep-ui': '1.0.0' } }),
    'node_modules/fancy-ui/dist/style.css': ':root{--border:#ccc;--accent:red}.fancy{color:var(--border)}',
    'node_modules/deep-ui/style.css': ':root { --bg: white; }',
    ...files,
  });

test('a generic token a dependency of the App declares is refused with the package; one only a transitive dependency declares is not read', () => {
  const dir = withDependencies({
    'pages/a.page.tsx':
      "import { definePage } from '@mistriwork/mistri/page';\nexport const a = 'var(--border)';\nexport const b = 'var(--bg)';\nexport const c = 'var(--text-dim)';\n",
  });
  const result = run(['--app', dir]);
  assert.equal(result.code, 1, result.out);
  assert.match(
    result.out,
    /refused .*a\.page\.tsx:2: --border is a token renamed --line, and the stylesheets of fancy-ui, a dependency of the App, declare --border too/,
  );
  const after = readFileSync(join(dir, 'pages/a.page.tsx'), 'utf8');
  assert.match(after, /'var\(--border\)'/);
  assert.match(after, /'var\(--ground\)'/);
  assert.match(after, /'var\(--ink-muted\)'/);
});

test('--border in a mistri page or theme stylesheet is rewritten; the same in a library-aimed rule, an unowned file or a .js file is refused', () => {
  const dir = folder({
    'package.json': JSON.stringify({ name: 'app' }),
    'pages/home.page.tsx':
      "import { definePage } from '@mistriwork/mistri/page';\nimport '../theme/app.css';\nexport const x = 'var(--border)';\n",
    'theme/app.css': '.card { border: 1px solid var(--border); }\n@import "./more.css";\n',
    'theme/more.css': '.more { color: var(--text); }\n.mui-root .x { color: var(--text); }\n[class*="Table"] { background: var(--bg); }\n',
    'theme/loose.css': '.loose { color: var(--text); }\n',
    'other/thing.css': '.thing { color: var(--text); }\n',
    'plain.tsx': "export const y = 'var(--ok)';\n",
    'legacy.js': "import '@mistriwork/mistri/ui';\nexport const z = useToken('--warn');\n",
  });
  const result = run(['--app', dir]);
  assert.equal(result.code, 1, result.out);
  assert.match(readFileSync(join(dir, 'pages/home.page.tsx'), 'utf8'), /var\(--line\)/);
  assert.match(readFileSync(join(dir, 'theme/app.css'), 'utf8'), /var\(--line\)/);
  const more = readFileSync(join(dir, 'theme/more.css'), 'utf8');
  assert.match(more, /\.more \{ color: var\(--ink\)/);
  assert.match(more, /\.mui-root \.x \{ color: var\(--text\)/);
  assert.match(more, /background: var\(--bg\)/);
  assert.match(
    result.out,
    /more\.css:2: --text is a token renamed --ink, read inside a selector for a third-party class \(\.mui-root \.x\)/,
  );
  assert.match(result.out, /more\.css:3: --bg .*third-party class \(\[class\*="Table"\]\)/);
  assert.match(
    result.out,
    /loose\.css:1: --text .*this file is not a stylesheet under the App's theme or styles that an App module imports/,
  );
  assert.match(result.out, /thing\.css:1: --text .*is not a stylesheet/);
  assert.match(result.out, /plain\.tsx:1: --ok .*does not import @mistriwork\/\*/);
  assert.match(result.out, /legacy\.js:2: --warn .*is not a \.ts or \.tsx file/);
});

test('the generic names are the renamed tokens a third party could also set, and every one is a renamed token', () => {
  assert.deepEqual([...GENERIC_TOKENS].sort(), ['--bg', '--border', '--danger', '--ok', '--surface-2', '--text', '--warn']);
  for (const name of GENERIC_TOKENS) assert.ok(name in TOKENS, name);
});

test('every rule is idempotent: a second run of the new rewrites finds nothing and the refusals stay', () => {
  const dir = withDependencies({
    'pages/a.page.tsx': [
      "import { definePage } from '@mistriwork/mistri/page';",
      "import { Rows } from '@mistriwork/mistri/ui';",
      "export default definePage({ title: 'A', nav: { order: 1 }, views: { v: { kind: 'list', table: 'task', keys: {} } } });",
      "import { metric } from '@mistriwork/mistri/app';",
      "export const m = metric('x', 'y', { view: 'z' });",
      'export const e = <Rows resource="task" />;',
      "export const t = 'var(--ok)';",
      '',
    ].join('\n'),
  });
  const first = run(['--app', dir]);
  assert.equal(first.code, 0, first.out);
  const once = readFileSync(join(dir, 'pages/a.page.tsx'), 'utf8');
  assert.match(once, /label: 'A'/);
  assert.match(once, /position: 1/);
  assert.match(once, /from: 'task', shortcuts/);
  assert.match(once, /\{ to: 'z' \}/);
  assert.match(once, /<Rows from="task"/);
  assert.match(once, /var\(--status-good\)/);
  const again = run(['--app', dir, '--check']);
  assert.equal(again.code, 0, again.out);
  assert.equal(readFileSync(join(dir, 'pages/a.page.tsx'), 'utf8'), once);
  assert.equal(upgradeSource(once).text, once);
});

/* A field report: upgrade wrote a built-in function's source into a file, renamed the App's own object key, and
   renamed a prop `<Value>` still takes. Only a site that is mistri's (its import, a call of a name imported from it,
   an object typed as one of its types, a block's renamed prop, a token) is rewritten. */
test('a word Object.prototype holds is not a rename, and nothing is stringified into the file', () => {
  const source = [
    "import { defineApp } from '@mistriwork/mistri/app';",
    "import { constructor, toString as text } from '@mistriwork/mistri/ui';",
    'class Shelf { constructor(public toString: () => string, valueOf = 1) {} }',
    "const words = { constructor: 1, toString: 'x', valueOf: [], hasOwnProperty: {}, __proto__: null };",
    'export default defineApp({ constructor: 1, toString: { valueOf: 2 }, views: { valueOf: { kind: "list" } } });',
    'export const n = words.constructor + text() + constructor + valueOf + toString;',
    '',
  ].join('\n');
  const result = upgradeSource(source);
  assert.equal(result.text, source);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.refusals, []);
});

test("the App's own objects, calls and types keep their keys and names, even where mistri renamed the same word", () => {
  const source = [
    "import { defineApp } from '@mistriwork/mistri/app';",
    "import { helper } from './helper';",
    'type TotalValue = number;',
    'interface CustomTotal { open: TotalValue }',
    "const view = { kind: 'list', table: 'task', keys: { e: 1 }, layout: 'listing' };",
    "const board = { layout: [['a']], totals: { open: 'count' }, face: 'sans', palette: { light: {}, dark: {} } };",
    "const theme = { recipes: { head: 'quiet' }, nav: { currentInk: '#fff' } };",
    "const nested = defineApp({ access: () => ({ layout: [['a']] }), rows: helper({ kind: 'list', table: 'task' }) });",
    "function make() { return { kind: 'dashboard', table: 'task', layout: [['a']] }; }",
    "export const parts = [view, board, theme, nested, make, { kind: 'queue', facts: ['a'] }] as CustomTotal[];",
    '',
  ].join('\n');
  const result = upgradeSource(source);
  assert.equal(result.text, source);
  assert.deepEqual(result.changes, []);
});

test("the same words inside mistri's own call, or typed as its type, are still rewritten; a renamed type only as mistri's", () => {
  const source = [
    "import { defineApp as app, defineTheme, type View } from '@mistriwork/mistri/app';",
    "import type { CustomTotal, TotalValue as Figure } from '@mistriwork/mistri/ui';",
    "import * as ui from '@mistriwork/mistri/ui';",
    "export const v: View = { kind: 'list', table: 'task' };",
    "export default app({ pages: { order: { layout: 'listing' } }, views: { d: { kind: 'dashboard', layout: [['a']] } } });",
    "export const t = defineTheme<'x'>({ palette: { light: {}, dark: {} } });",
    'export type A = CustomTotal | Figure | ui.TotalGroup;',
    '',
  ].join('\n');
  const result = upgradeSource(source);
  assert.equal(
    result.text,
    source
      .replace('import type { CustomTotal, TotalValue as', 'import type { CustomFigure, FigureValue as')
      .replace("table: 'task'", "from: 'task'")
      .replace("layout: 'listing'", "layout: 'showcase'")
      .replace("layout: [['a']]", "areas: [['a']]")
      .replace('palette:', 'colors:')
      .replace('CustomTotal | Figure | ui.TotalGroup', 'CustomFigure | Figure | ui.FigureGroup'),
  );
  assert.equal(upgradeSource(result.text).text, result.text);
});

test('<Value> keeps every prop it takes; a block that took `resource` has it renamed', () => {
  const source = [
    "import { Value, Rows, Gallery } from '@mistriwork/mistri/ui';",
    'export const a = <Value value={row.total} resource="invoice" column="total" display={{ format: "money" }} compact />;',
    'export const b = <Value resource="invoice" {...rest} />;',
    'export const c = <Rows resource="invoice" />;',
    'export const d = <Gallery resource="unit" image="photo" />;',
    '',
  ].join('\n');
  const result = upgradeSource(source);
  assert.equal(result.text, source.replace('<Rows resource', '<Rows from').replace('<Gallery resource', '<Gallery from'));
  assert.deepEqual(result.refusals, []);
  assert.equal(upgradeSource(result.text).text, result.text);
});

test("an object typed by the App's own schema, or returned from a function inside a mistri call, is mistri's; one that only looks like it is refused by line", () => {
  const typed = [
    "import type { Views } from './mistri-schema.d.ts';",
    "export const views = { leads: { kind: 'list', table: 'lead', keys: [] } } satisfies Views;",
    '',
  ].join('\n');
  const result = upgradeSource(typed);
  assert.equal(result.text, typed.replace("table: 'lead', keys: []", "from: 'lead', shortcuts: []"));
  assert.deepEqual(result.refusals, []);
  assert.equal(upgradeSource(result.text).text, result.text);
  /* The schema is imported under whichever specifier the module says it by, and as a namespace or an annotation too. */
  for (const specifier of ['./mistri-schema', '../mistri-schema.js']) {
    const other = `import type { Views } from '${specifier}';\nexport const v: Views = { kind: 'list', table: 'lead' };\n`;
    assert.equal(upgradeSource(other).text, other.replace('table:', 'from:'));
  }
  const space = "import type * as S from './mistri-schema.d.ts';\nexport const v = { kind: 'list', table: 'lead' } as S.Views;\n";
  assert.equal(upgradeSource(space).text, space.replace('table:', 'from:'));
  /* A module that only has the schema's name in its path is not the schema. */
  const other = "import type { Views } from './not-mistri-schema-at-all';\nexport const v: Views = { kind: 'list', table: 'lead' };\n";
  assert.equal(upgradeSource(other).text, other);

  const untyped = ['export const views = {', "  leads: { kind: 'list', table: 'lead' },", '};', ''].join('\n');
  const refused = upgradeSource(untyped);
  assert.equal(refused.text, untyped);
  assert.equal(refused.refusals.length, 1);
  assert.equal(refused.refusals[0]!.line, 2);
  assert.match(
    refused.refusals[0]!.said,
    /`table` is now `from`.*looks like a mistri list view.*by hand, or type it with the App's schema/,
  );

  const returned = [
    "import { defineApp } from '@mistriwork/mistri/app';",
    "export default defineApp({ views: () => ({ leads: { kind: 'list', table: 'lead' } }) });",
    "export const b = defineApp({ views: function () { return { leads: { kind: 'list', table: 'lead' } }; } });",
    "export const c = defineApp({ views() { if (x) { return { leads: { kind: 'list', table: 'lead' } }; } return {}; } });",
    '',
  ].join('\n');
  const fromReturned = upgradeSource(returned);
  assert.equal(fromReturned.text, returned.replaceAll("table: 'lead'", "from: 'lead'"));
  assert.deepEqual(fromReturned.refusals, []);
  assert.equal(upgradeSource(fromReturned.text).text, fromReturned.text);

  /* An App's own function inside a mistri call is still the App's. */
  const own = [
    "import { defineApp } from '@mistriwork/mistri/app';",
    "export default defineApp({ views: () => ownViews({ leads: { table: 'lead', keys: [] } }) });",
    '',
  ].join('\n');
  assert.equal(upgradeSource(own).text, own);
  assert.deepEqual(upgradeSource(own).refusals, []);
});

test('an App object with no mistri kind and no mistri type is left alone, and said nothing of', () => {
  const own = [
    "export const row = { table: 'lead', keys: ['a'], title: 'x', refresh: 30 };",
    "export const form = { kind: 'form', table: 'lead' };",
    "export const mine = { kind: 'widget', facts: [], lines: [] };",
    '',
  ].join('\n');
  const result = upgradeSource(own);
  assert.equal(result.text, own);
  assert.deepEqual(result.refusals, []);
  assert.deepEqual(result.changes, []);
});
