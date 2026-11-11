import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintComponents } from '../packages/mistri/src/server/app/componentLint.js';
import { componentCode } from '../packages/mistri/src/server/build/checkProblems.js';

const made: string[] = [];
after(() => Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true }))));

async function lint(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'tw-token-'));
  made.push(dir);
  await mkdir(join(dir, 'c'), { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, 'c', name), text);
  return lintComponents(dir, { entries: { tile: { sources: Object.keys(files).map((n) => `c/${n}`) } } } as never);
}

test('an unknown var(--…) warns with the token it was meant to be; a real or own token does not', async () => {
  const { warnings, problems } = await lint({
    'tile.css': '.c-tile { color: var(--negative); background: var(--surface); gap: var(--tile-gap); --tile-gap: 8px; }',
    'tile.tsx': "export default () => <b style={{ color: 'var(--ink-mutd)' }} />;",
  });
  assert.deepEqual(problems, []);
  const said = warnings.map((w) => w.text);
  assert.equal(said.length, 2);
  assert.match(said[0]!, /"--negative".*var\(--status-critical\)/);
  assert.match(said[1]!, /"--ink-mutd".*var\(--ink-muted\)/);
  assert.equal(componentCode(said[0]!), 'component-token');
});

test('a token renamed before 1.0 is named by its new name, not the nearest spelling', async () => {
  // A field report: by spelling `--text-dim` suggested `--text-sm`, `--ok` `--ink`, and `--warn` nothing.
  const { warnings } = await lint({
    'tile.css': '.c-tile { color: var(--text-dim); border-color: var(--warn); background: var(--ok); }',
  });
  const said = warnings.map((w) => w.text);
  assert.equal(said.length, 3);
  assert.match(said[0]!, /"--text-dim".*renamed --ink-muted.*var\(--ink-muted\)/);
  assert.match(said[1]!, /"--warn".*var\(--status-warning\)/);
  assert.match(said[2]!, /"--ok".*var\(--status-good\)/);
  assert.equal(componentCode(said[0]!), 'component-token');
});

test("a component's own --c-<id>-* property is allowed however it is set; another component's or an unprefixed one still warns", async () => {
  const { warnings } = await lint({
    'tile.css': '.c-tile { color: var(--c-tile-hue); border-color: var(--c-other-hue); outline-color: var(--hue); }',
    'tile.tsx': "export default (p) => <b ref={(el) => el?.style.setProperty('--c-tile-hue', p.hue)} />;",
  });
  const said = warnings.map((w) => w.text);
  assert.equal(said.length, 2);
  assert.match(said[0]!, /"--c-other-hue"/);
  assert.match(said[1]!, /"--hue"/);
});

async function lintShared(files: Record<string, string>, entries: Record<string, string[]>) {
  const dir = await mkdtemp(join(tmpdir(), 'tw-shared-'));
  made.push(dir);
  await mkdir(join(dir, 'c'), { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, 'c', name), text);
  return lintComponents(dir, {
    entries: Object.fromEntries(Object.entries(entries).map(([id, sources]) => [id, { sources: sources.map((n) => `c/${n}`) }])),
  } as never);
}

test('a stylesheet two components share is linted once, and a class either owns is not flagged', async () => {
  const { warnings } = await lintShared(
    { 'receipt.css': '.c-bill { color: #123456; }\n.c-slip-row { gap: 4px; }\n.card { gap: 2px; }' },
    { bill: ['receipt.css'], slip: ['receipt.css'] },
  );
  const said = warnings.map((w) => `${w.component}:${w.line} ${w.text}`);
  assert.equal(said.filter((text) => /#123456/.test(text)).length, 1);
  assert.equal(said.filter((text) => /"\.card"/.test(text)).length, 1);
  assert.equal(said.filter((text) => /c-slip-row/.test(text)).length, 0);
  assert.equal(said.length, 2);
  assert.ok(
    said.every((text) => text.startsWith('bill:')),
    'said under the first component that sources it',
  );
});

test('a radius of all zeros is a square on purpose; any other literal radius still warns', async () => {
  const { warnings } = await lint({
    'tile.css': [
      '.c-tile { border-radius: 0; }',
      '.c-tile-a { border-radius: 0px; }',
      '.c-tile-b { border-radius: 0rem; }',
      '.c-tile-c { border-radius: 0 0 0 0; }',
      '.c-tile-d { border-radius: 0px 0; }',
      '.c-tile-e { border-radius: var(--radius); }',
      '.c-tile-f { border-radius: 0 4px 0 0; }',
      '.c-tile-g { border-top-left-radius: 6px; }',
    ].join('\n'),
  });
  assert.deepEqual(
    warnings.map((w) => w.line),
    [7, 8],
  );
});

/* An icon a component names is held to the App's icons: the declared ones are checked at load, and a name chosen
   at run time (either branch of a conditional) used to escape until a browser drew an empty box. */
test('an icon name a component writes, plain or in either branch of a conditional, must be an App icon', async () => {
  const { problems, warnings } = await lint({
    'tile.tsx': [
      'export const a = <Icon name="hosue" />;',
      "export const b = <Icon name={done ? 'check-circle' : 'circle-dahsed'} size={12} />;",
      "export const c = <Icon name={done ? 'chekc-circle' : 'x-circle'} />;",
      "export const d = <Menu items={[{ label: 'Bell', icon: ready ? 'bel' : 'bell' }]} />;",
      "export const e = <Badge icon={'staar'} />;",
      "export const ok = <Icon name={done ? 'check-circle' : 'circle-dashed'} />;",
      'export const dynamic = <Icon name={row.icon} />;',
      "export const compared = <Icon name={kind === 'hosue' ? 'house' : name} />;",
      "export const mark = { icon: '', title: 'icon' };",
      // A property of something else, or a name that only ends in "icon", is not an icon the App draws.
      "el.dataset.icon = 'not-an-icon';",
      "export const $icon = 'not-an-icon';",
      "export const tray = { trayicon: 'not-an-icon' };",
      // An object of the author's own may mean anything by `icon` (a field report): a table of field labels.
      "export const labels = [{ name: 'Name', icon: 'Icon' }, { name: 'Status', icon: ready ? 'Ready' : 'Waiting' }];",
    ].join('\n'),
  });
  assert.deepEqual(warnings, []);
  assert.deepEqual(
    problems.map((p) => [p.line, /^"([^"]+)"/.exec(p.text)![1]]),
    [
      [1, 'hosue'],
      [2, 'circle-dahsed'],
      [3, 'chekc-circle'],
      [4, 'bel'],
      [5, 'staar'],
    ],
  );
  assert.match(problems[0]!.text, /Did you mean "house"/);
  assert.equal(componentCode(problems[0]!.text), 'component-icon');
});

test("a shared package's declared cssPrefix owns its classes; the App's own package.json and other classes do not excuse", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tw-pkg-'));
  made.push(dir);
  await mkdir(join(dir, 'packages', 'ui', 'dist'), { recursive: true });
  await mkdir(join(dir, 'c'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ mistri: { cssPrefix: 'app' } }));
  await writeFile(join(dir, 'packages', 'ui', 'package.json'), JSON.stringify({ mistri: { cssPrefix: ['acme-', 'ac'] } }));
  await writeFile(
    join(dir, 'packages', 'ui', 'dist', 'ui.css'),
    '.acme { gap: 0; }\n.acme-button { gap: 0; }\n.ac-row { gap: 0; }\n.acmes { gap: 0; }',
  );
  await writeFile(join(dir, 'c', 'tile.css'), '.c-tile { gap: 0; }\n.app-card { gap: 0; }');
  const { warnings } = await lintComponents(dir, {
    entries: { tile: { sources: ['c/tile.css', 'packages/ui/dist/ui.css'] } },
  } as never);
  const classes = warnings.map((w) => /"\.([\w-]+)"/.exec(w.text)?.[1]).sort();
  assert.deepEqual(classes, ['acmes', 'app-card'], 'only a class outside every declared name-space warns');
});

test('a stylesheet several components draw owns classes after its own name, where no other stylesheet has that name', async () => {
  /* A widget two pages draw met neither page's c-<id>- rule and warned on every page (a field report). */
  const dir = await mkdtemp(join(tmpdir(), 'tw-sheet-'));
  made.push(dir);
  for (const folder of ['widgets', 'widgets/badge', 'a', 'b']) await mkdir(join(dir, folder), { recursive: true });
  await writeFile(
    join(dir, 'widgets', 'TicketList.css'),
    '.c-ticket-list { gap: 0; }\n.c-ticket-list-row { gap: 0; }\n.c-ticket-lists { gap: 0; }',
  );
  await writeFile(join(dir, 'widgets', 'badge', 'styles.css'), '.c-badge-dot { gap: 0; }');
  // Two stylesheets called card.css: neither owns c-card-.
  await writeFile(join(dir, 'a', 'card.css'), '.c-card-a { gap: 0; }');
  await writeFile(join(dir, 'b', 'card.css'), '.c-card-b { gap: 0; }');
  const { warnings } = await lintComponents(dir, {
    entries: {
      'page-my-tickets': { sources: ['widgets/TicketList.css', 'widgets/badge/styles.css', 'a/card.css'] },
      'page-my-work': { sources: ['widgets/TicketList.css', 'b/card.css'] },
    },
  } as never);
  const classes = warnings.map((w) => /"\.([\w-]+)"/.exec(w.text)?.[1]).sort();
  assert.deepEqual(classes, ['c-card-a', 'c-card-b', 'c-ticket-lists']);
  assert.match(warnings.find((w) => /c-ticket-lists/.test(w.text))!.text, /or "c-ticket-list-…" after the stylesheet/);
});

test("the looks' own shadow tokens and a blur-free inset stripe are not a shadow warning; any other shadow still is", async () => {
  const fine = await lint({
    'tile.css':
      '.c-tile { box-shadow: var(--shadow-panel); } .c-tile:hover { box-shadow: var(--shadow-pop), var(--shadow-modal); } .c-tile[aria-selected] { box-shadow: inset 3px 0 0 var(--accent); }',
  });
  assert.deepEqual(
    fine.warnings.map((w) => w.text),
    [],
  );
  const odd = await lint({
    'tile.css': '.c-tile { box-shadow: 0 8px 24px rgba(0,0,0,.3); } .c-tile b { box-shadow: var(--shadow-nope); }',
  });
  assert.ok(odd.warnings.some((w) => /a shadow/.test(w.text)));
});
