/*
 * A tenant App's server takes a save of its look in place and restarts for
 * anything else (G175, tenantLook.ts): it used to exit on a save of theme.ts,
 * the file a person edits most while dressing an App. What it grants, what its
 * commands do and who may sign in are still fixed at startup.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { loadApp, type LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { lookOnlyChange, wearing } from '../packages/mistri/src/server/tenant/tenantLook.js';
import { watchTenantStartup } from '../packages/mistri/src/server/tenant/tenantStartup.js';

const ROOT = resolve('.');
const work = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-look-'));
after(() => rmSync(work, { recursive: true, force: true }));

const theme = (accent: string) => `import { defineTheme } from '@mistriwork/mistri/app';
export const harbor = defineTheme({ id: 'harbor', label: 'Harbor', extends: 'lumen', colors: { light: { accent: '${accent}' } } });
`;
const app = (title: string) => `import { defineApp, listView } from '@mistriwork/mistri/app';
import { harbor } from './theme.ts';
export default defineApp({
  id: 'tiny',
  name: 'Tiny',
  connection: 'tick',
  resources: { task: {} },
  views: { tasks: listView('${title}', 'task') },
  home: 'tasks',
  ui: { customThemes: [harbor], theme: { preset: 'harbor' } },
});
`;

function appDir(name: string): string {
  const dir = join(work, name);
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', '@mistriwork'), { recursive: true });
  symlinkSync(join(ROOT, 'packages', 'mistri'), join(dir, 'node_modules', '@mistriwork', 'mistri'), 'dir');
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
  writeFileSync(join(dir, 'theme.ts'), theme('#1d4ed8'));
  writeFileSync(join(dir, 'app.ts'), app('Tasks'));
  return dir;
}

test('a save that changes only the look is worn in place; any other difference is a restart', async () => {
  const dir = appDir('judged');
  const before = await loadApp(dir);
  assert.ok(
    before.modules?.some((file) => file.endsWith('theme.ts')),
    'the theme module is in the definition graph',
  );

  writeFileSync(join(dir, 'theme.ts'), theme('#b91c1c'));
  const restyled = await loadApp(dir);
  const look = lookOnlyChange(before, restyled, [join(dir, 'theme.ts')]);
  assert.ok(look, 'a palette is a look');
  assert.equal(JSON.stringify(look.customThemes).includes('#b91c1c'), true);
  // The look is worn over the App it started with, never its authority.
  const worn = wearing(before.app, look);
  assert.equal(JSON.stringify(worn.resources), JSON.stringify(before.app.resources));
  assert.equal(JSON.stringify(worn.ui.customThemes).includes('#b91c1c'), true);
  assert.equal(JSON.stringify(before.app.ui.customThemes).includes('#b91c1c'), false);

  // The same save touching a file the definition never read, or no file at all, is a restart.
  assert.equal(lookOnlyChange(before, restyled, [join(dir, 'lib.ts')]), undefined);
  assert.equal(lookOnlyChange(before, restyled, []), undefined);
  // A save that moved nothing about the look is not one to wear.
  assert.equal(lookOnlyChange(before, before, [join(dir, 'theme.ts')]), undefined);
  // The commands module is code a load's data cannot show: a restart, whatever else moved.
  const commanded: LoadedApp = { ...before, commands: { file: join(dir, 'theme.ts'), registry: {} as never } };
  assert.equal(lookOnlyChange(commanded, { ...restyled, commands: commanded.commands }, [join(dir, 'theme.ts')]), undefined);

  // A save that changes the look and anything else is a restart.
  writeFileSync(join(dir, 'app.ts'), app('Open tasks'));
  const moved = await loadApp(dir);
  assert.equal(lookOnlyChange(before, moved, [join(dir, 'theme.ts'), join(dir, 'app.ts')]), undefined);
});

/** A watcher over an App directory and its policy, its saves offered to `look`. */
async function watching(name: string, worn: boolean) {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  const manifest = join(dir, 'app.ts');
  const policyFile = join(work, `${name}-policy.mjs`);
  writeFileSync(manifest, 'export default {};');
  writeFileSync(join(dir, 'theme.ts'), 'export const a = 1;');
  writeFileSync(policyFile, 'export default {};');
  // Let fixture creation events settle before subscribing to macOS directory watches.
  await delay(200);
  const offered: string[][] = [];
  let restarts = 0;
  const close = watchTenantStartup(
    {
      loaded: { path: manifest, dir, app: {} as never, pages: [], sources: {} },
      policyFile,
      look: async (touched) => {
        offered.push(touched);
        return worn;
      },
      debounceMs: 50,
    },
    () => restarts++,
  );
  after(close);
  await delay(100);
  return { dir, policyFile, offered, restarts: () => restarts };
}

test('the tenant watcher offers an App save to the look and keeps serving when it is worn', async () => {
  const w = await watching('worn', true);
  writeFileSync(join(w.dir, 'theme.ts'), 'export const a = 2;');
  await delay(600);
  assert.ok(w.offered.length >= 1, 'the save was offered to the look');
  assert.ok(w.offered.flat().some((file) => file.endsWith('theme.ts')));
  assert.equal(w.restarts(), 0);
  // The watcher stays open: the next save is offered too.
  const seen = w.offered.length;
  writeFileSync(join(w.dir, 'theme.ts'), 'export const a = 3;');
  await delay(600);
  assert.ok(w.offered.length > seen);
  assert.equal(w.restarts(), 0);
  // A policy save is authority: a restart, never offered.
  const offeredBefore = w.offered.length;
  writeFileSync(w.policyFile, 'export default { changed: true };');
  await delay(600);
  assert.equal(w.restarts(), 1);
  assert.equal(w.offered.length, offeredBefore);
});

test('the tenant watcher restarts when the look says the save was more than the look', async () => {
  const w = await watching('refused', false);
  writeFileSync(join(w.dir, 'theme.ts'), 'export const a = 2;');
  await delay(600);
  assert.ok(w.offered.length >= 1);
  assert.equal(w.restarts(), 1);
});
