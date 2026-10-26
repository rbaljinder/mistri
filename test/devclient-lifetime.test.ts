import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownDevClient, sweepDevCaches } from '../packages/engine/src/server/devclient.js';

test('retirement fences late dependency watches before provider close and never reactivates them', async () => {
  const watched: string[] = [];
  let closed = false,
    closes = 0,
    cacheClears = 0,
    finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const watcher = {
    add(path: string) {
      closed = false;
      watched.push(path);
      return watcher;
    },
    async close() {
      closed = true;
    },
  };
  const provider = {
    watcher,
    middlewares: () => {},
    transformIndexHtml: async (_path: string, html: string) => html,
    close: () => {
      closes++;
      closed = true;
      watcher.add('during-close');
      return pending;
    },
  };
  const owner = ownDevClient(provider as unknown as Parameters<typeof ownDevClient>[0], async () => {
    assert.equal(closed, true);
    cacheClears++;
  });
  assert.equal(watcher.add('live-dependency'), watcher);
  assert.deepEqual(watched, ['live-dependency']);
  const closing = owner.close();
  assert.equal(closed, true);
  assert.equal(owner.close(), closing);
  assert.equal(closes, 1);
  assert.equal(cacheClears, 0);
  assert.equal(watcher.add('late-transform'), watcher);
  finish();
  await closing;
  watcher.add('after-close');
  assert.equal(cacheClears, 1);
  assert.equal(closed, true);
  assert.deepEqual(watched, ['live-dependency']);
});

test('client wrapper preserves middleware and bound HTML transformation without sharing another owner retirement', async () => {
  let firstAdds = 0,
    secondAdds = 0;
  const create = (add: () => void) => {
    const provider = {
      marker: 'html-owner',
      watcher: {
        add() {
          add();
          return this;
        },
        async close() {},
      },
      middlewares: () => {},
      async transformIndexHtml(_path: string, html: string) {
        return `${this.marker}:${html}`;
      },
      async close() {},
    };
    return { provider, owner: ownDevClient(provider as unknown as Parameters<typeof ownDevClient>[0]) };
  };
  const first = create(() => firstAdds++),
    second = create(() => secondAdds++);
  assert.equal(first.owner.middlewares, first.provider.middlewares);
  assert.equal(await first.owner.transformIndexHtml('/', 'body'), 'html-owner:body');
  await first.owner.close();
  first.provider.watcher.add();
  second.provider.watcher.add();
  assert.equal(firstAdds, 0);
  assert.equal(secondAdds, 1);
  await second.owner.close();
});

test('provider restart can replace its watcher and renderer without escaping final retirement', async () => {
  const watched: string[] = [];
  const watcher = () => ({
    add(path: string) {
      watched.push(path);
      return this;
    },
    async close() {},
  });
  const original = watcher(),
    replacement = watcher();
  const provider = {
    watcher: original,
    middlewares: () => {},
    async transformIndexHtml() {
      return 'first';
    },
    async close() {
      await this.watcher.close();
      this.watcher.add('late-close');
    },
  };
  const owner = ownDevClient(provider as unknown as Parameters<typeof ownDevClient>[0]);
  // A native restart closes the previous watcher without calling owner.close.
  await original.close();
  original.add('late-old-transform');
  provider.watcher = replacement;
  provider.transformIndexHtml = async () => 'replacement';
  assert.equal(await owner.transformIndexHtml('/', ''), 'replacement');
  replacement.add('live-replacement');
  await owner.close();
  replacement.add('late-new-transform');
  assert.deepEqual(watched, ['live-replacement']);
});

test("a start sweeps optimizer directories whose process is gone, and keeps a live one's", async () => {
  const root = mkdtempSync(join(tmpdir(), 'tablewalk-vite-sweep-'));
  try {
    const gone = spawnSync(process.execPath, ['-e', '0']).pid!;
    const unnamedOld = join(root, 'client-Ab12Cd');
    for (const name of [`client-${gone}-x1`, `client-${process.pid}-x2`, 'client-Zz99Yy', 'deps']) mkdirSync(join(root, name));
    mkdirSync(unnamedOld);
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    utimesSync(unnamedOld, twoDaysAgo, twoDaysAgo);
    await sweepDevCaches(root);
    assert.deepEqual(readdirSync(root).sort(), [`client-${process.pid}-x2`, 'client-Zz99Yy', 'deps']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
