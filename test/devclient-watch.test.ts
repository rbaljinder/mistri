/**
 * The source client's file watcher stays inside the package it serves, and
 * an error from it never reaches the process. A served App's Vite watcher on
 * a CI runner once walked into /run and died on udev's self-referring links
 * (ELOOP), an 'error' event nobody listened for (packages/engine/src/server/devclient.ts).
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { outsidePackage, quietWatcherErrors } from '../packages/engine/src/server/devclient.js';

test('the watcher may look inside the package, never beyond it', () => {
  const ignored = outsidePackage('/work/tablewalk');
  assert.equal(ignored('/work/tablewalk'), false);
  assert.equal(ignored('/work/tablewalk/src/shared/view.ts'), false);
  assert.equal(ignored('/work/tablewalk/'), false);
  assert.equal(ignored('/run/udev/watch/1'), true);
  assert.equal(ignored('/'), true);
  assert.equal(ignored('/work'), true);
  assert.equal(ignored('/work/tablewalk-other/x.ts'), true, 'a sibling that shares the prefix is outside');
});

test('a watcher error is said once and the process goes on', () => {
  const watcher = new EventEmitter();
  const said: string[] = [];
  quietWatcherErrors(watcher, (message) => said.push(message));
  const loop = Object.assign(new Error("ELOOP: too many symbolic links encountered, stat '/run/udev/watch/1'"), { code: 'ELOOP' });
  assert.doesNotThrow(() => watcher.emit('error', loop));
  assert.doesNotThrow(() => watcher.emit('error', loop));
  assert.equal(said.length, 1);
  assert.match(said[0]!, /ELOOP/);
});

test("Vite's own watcher, so bounded, does not take a folder outside the package", async () => {
  const work = mkdtempSync(join(tmpdir(), 'tablewalk-watch-'));
  const pkg = join(work, 'package');
  const client = join(pkg, 'src', 'client');
  const outside = join(work, 'outside');
  mkdirSync(client, { recursive: true });
  mkdirSync(join(outside, 'deep'), { recursive: true });
  writeFileSync(join(client, 'boot.js'), 'export {};\n');
  writeFileSync(join(pkg, 'shared.ts'), 'export {};\n');
  writeFileSync(join(outside, 'deep', 'file.ts'), 'export {};\n');
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: false,
    root: client,
    cacheDir: join(work, 'cache'),
    logLevel: 'silent',
    server: { middlewareMode: true, ws: false, watch: { ignored: [outsidePackage(pkg)] } },
  });
  try {
    quietWatcherErrors(vite.watcher, () => {});
    vite.watcher.add([outside, join(pkg, 'shared.ts')]);
    const watched = () => Object.keys(vite.watcher.getWatched());
    for (let i = 0; i < 100 && !watched().includes(pkg); i++) await new Promise((done) => setTimeout(done, 20));
    assert.ok(watched().includes(pkg), 'a file inside the package is watched');
    assert.deepEqual(
      watched().filter((dir) => dir === outside || dir.startsWith(`${outside}/`) || dir.startsWith(`${outside}\\`)),
      [],
    );
    assert.doesNotThrow(() => vite.watcher.emit('error', new Error('ELOOP')));
  } finally {
    await vite.close();
    rmSync(work, { recursive: true, force: true });
  }
});
