/**
 * TC6: a theme may suggest where the menu goes (defineTheme's `shell.placement`), and the App's own
 * `ui.shell.placement` wins. The suggestion could not be previewed — shot --theme and the theme bench drew the
 * menu where the App wore it — and the App's word won silently. Now the look shot by name and the bench's frames
 * stand the menu where the theme suggests, unless the App says where itself, and check, shot, grade and the bench
 * say in one line when it does.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ownPlacement, parseUi, placementIn } from '../packages/mistri/src/shared/appUi.js';
import { shotLooks } from '../packages/mistri/src/server/build/shot.js';
import { benchReading } from '../packages/mistri/src/server/themeBench/bench.js';
import type { AppHost, LoadedApp } from '../packages/mistri/src/server/app/apps.js';

const theme = (id: string, placement?: 'side' | 'top') => ({
  kind: 'theme',
  id,
  label: id[0]!.toUpperCase() + id.slice(1),
  extends: 'lumen',
  ...(placement ? { shell: { placement } } : {}),
});
const ui = (shell?: Record<string, unknown>, worn = 'harbor') =>
  parseUi(
    {
      customThemes: [theme('harbor', 'top'), theme('daybook', 'side'), theme('plain')],
      theme: { preset: worn },
      ...(shell ? { shell } : {}),
    },
    'app.ts',
  );
const loaded = (parsed: ReturnType<typeof parseUi>) => ({ app: { id: 'books', name: 'Books', ui: parsed } }) as unknown as LoadedApp;
const host = (parsed: ReturnType<typeof parseUi>) =>
  ({ app: { app: { id: 'books', name: 'Books', ui: parsed } }, pages: [] }) as unknown as AppHost;

test("the App's own word is told from its theme's suggestion, even where the two agree", () => {
  // Harbor, worn, suggests the top: the App draws it there without saying so.
  assert.equal(ui().shell?.placement, 'top');
  assert.equal(ownPlacement(ui()), undefined);
  // The App saying the same is its own word: another theme's suggestion does not move it.
  assert.deepEqual(ownPlacement(ui({ placement: 'top' })), { placement: 'top', by: 'ui.shell.placement' });
  // A rail is the side menu folded: it keeps the side.
  assert.deepEqual(ownPlacement(ui({ rail: true })), { placement: 'side', by: 'ui.shell.rail' });
});

test('a theme worn by name stands the menu where it suggests, unless the App says where', () => {
  const [harbor, daybook, plain] = ui().customThemes!;
  // Worn as the App wears it: where it is drawn now, nothing moves.
  assert.deepEqual(placementIn(ui(), harbor), { placement: 'top' });
  // Another theme: its suggestion, or the side where it suggests none.
  assert.deepEqual(placementIn(ui(), daybook), { placement: 'side', moved: 'side' });
  assert.deepEqual(placementIn(ui(), plain), { placement: 'side', moved: 'side' });
  assert.deepEqual(placementIn(ui(undefined, 'plain'), harbor), { placement: 'top', moved: 'top' });
  // The App's own word wins, and says so in one line.
  assert.deepEqual(placementIn(ui({ placement: 'side' }), harbor), {
    placement: 'side',
    overridden: "Harbor suggests the menu on top; the App's ui.shell.placement puts it at the side, which wins.",
  });
  assert.match(placementIn(ui({ rail: true }), harbor).overridden!, /the App's ui\.shell\.rail puts it at the side, which wins\.$/);
  assert.match(placementIn(ui({ placement: { top: ['clerk'] } }), daybook).overridden!, /puts it on top for clerk, which wins\.$/);
  // Agreeing is not overriding.
  assert.equal(placementIn(ui({ placement: 'top' }), harbor).overridden, undefined);
});

test('shot and grade tell the page where the look shot by name stands the menu, or say the App overrides it', () => {
  const [harbor, daybook] = shotLooks(loaded(ui(undefined, 'plain')), ['harbor', 'daybook']);
  assert.equal(harbor!.placement, 'top');
  assert.equal(daybook!.placement, undefined, 'the side, where the App already draws it: nothing to tell');
  const [overridden] = shotLooks(loaded(ui({ placement: 'side' })), ['harbor']);
  assert.equal(overridden!.placement, undefined);
  assert.match(overridden!.overridden!, /^Harbor suggests the menu on top; .* which wins\.$/);
});

test("the bench's frames stand the menu where the theme being written suggests, or the bench says the App overrides it", () => {
  const top = { id: 'draft', label: 'Draft', extends: 'lumen', shell: { placement: 'top' } };
  const reading = benchReading(top, host(ui(undefined, 'plain')));
  assert.equal(reading.placement, 'top');
  assert.equal(reading.overridden, undefined);
  assert.equal(benchReading({ ...top, shell: undefined }, host(ui(undefined, 'plain'))).placement, undefined);
  const held = benchReading(top, host(ui({ placement: 'side' })));
  assert.equal(held.placement, undefined);
  assert.equal(held.overridden, "Draft suggests the menu on top; the App's ui.shell.placement puts it at the side, which wins.");
});

const ROOT = resolve('.');
const work = mkdtempSync(join(tmpdir(), 'tablewalk-shell-placement-'));
after(() => rmSync(work, { recursive: true, force: true }));

test("check says in one line that the App's placement overrides the one its theme suggests", async () => {
  const db = join(work, 'tick.db');
  spawnSync(process.execPath, [join(ROOT, 'examples/databases/tick/seed.mjs'), db], { encoding: 'utf8' });
  const dir = join(work, 'app');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', '@mistriwork'), { recursive: true });
  symlinkSync(join(ROOT, 'packages', 'mistri'), join(dir, 'node_modules', '@mistriwork', 'mistri'), 'dir');
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
  writeFileSync(
    join(dir, 'app.ts'),
    `import { defineApp, defineTheme, listView } from '@mistriwork/mistri/app';
const harbor = defineTheme({ id: 'harbor', label: 'Harbor', extends: 'lumen', shell: { placement: 'top' } });
export default defineApp({
  id: 'tiny',
  name: 'Tiny',
  connection: 'tick',
  resources: { task: {} },
  views: { tasks: listView('Tasks', 'task') },
  home: 'tasks',
  ui: { customThemes: [harbor], theme: { preset: 'harbor' }, shell: { placement: 'side' } },
});
`,
  );
  const out = await new Promise<string>((done) =>
    execFile(
      process.execPath,
      ['--import', 'tsx', join(ROOT, 'packages/mistri/src/server/index.ts'), 'check', '--app', dir, '--config', `${db}.json`],
      { cwd: ROOT, env: { ...process.env, XDG_CONFIG_HOME: join(work, 'xdg') }, timeout: 240_000 },
      (_error, stdout) => done(stdout),
    ),
  );
  const said = out.split('\n').filter((line) => line.includes('suggests the menu'));
  assert.deepEqual(
    said.map((line) => line.trim()),
    ["note: Harbor suggests the menu on top; the App's ui.shell.placement puts it at the side, which wins."],
    out,
  );
});
