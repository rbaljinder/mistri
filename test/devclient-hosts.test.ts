import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createDevClientHosts, ownDevClient } from '../packages/engine/src/server/devclient.js';

const fake = () => {
  let closed = 0,
    hmrClosed = 0;
  return {
    provider: {
      middlewares: () => {},
      transformIndexHtml: async (_url: string, html: string) => html,
      async close() {
        closed++;
      },
      async closeHmr() {
        hmrClosed++;
      },
    },
    counts: () => ({ closed, hmrClosed }),
  };
};
test('mounted source graphs remain distinct and retire every provider with their shared HTTP owner', async () => {
  const hosts = createDevClientHosts(),
    server = createServer(),
    root = fake(),
    child = fake();
  hosts.attach(server);
  assert.equal(await hosts.get(async () => root.provider, '/tools'), root.provider);
  assert.equal(await hosts.get(async () => child.provider, '/tools/desk'), child.provider);
  assert.equal(
    await hosts.get(async () => {
      throw Error('must reuse mount');
    }, '/tools'),
    root.provider,
  );
  await hosts.closeHmr(server);
  for (const fixture of [root, child]) assert.deepEqual(fixture.counts(), { closed: 0, hmrClosed: 1 });
  await hosts.retire(server);
  for (const fixture of [root, child]) assert.deepEqual(fixture.counts(), { closed: 1, hmrClosed: 1 });
});
test('stopping HMR retains accepted HTML work until full retirement, including a late provider', async () => {
  const hosts = createDevClientHosts(),
    server = createServer(),
    fixture = fake();
  hosts.attach(server);
  await hosts.closeHmr(server);
  const provider = await hosts.get(async () => fixture.provider);
  assert.deepEqual(fixture.counts(), { closed: 0, hmrClosed: 1 });
  assert.equal(await provider.transformIndexHtml('/', 'accepted response'), 'accepted response');
  await hosts.closeHmr(server);
  assert.deepEqual(fixture.counts(), { closed: 0, hmrClosed: 1 });
  await hosts.retire(server);
  assert.deepEqual(fixture.counts(), { closed: 1, hmrClosed: 1 });
});
test('retiring HMR owner retains middleware for other HTTP owners; last retirement closes provider once', async () => {
  const hosts = createDevClientHosts(),
    first = createServer(),
    second = createServer(),
    fixture = fake();
  hosts.attach(first);
  hosts.attach(second);
  assert.equal(
    await hosts.get(async (owner) => {
      assert.equal(owner, first);
      return fixture.provider;
    }),
    fixture.provider,
  );
  const retiring = hosts.retire(first);
  assert.equal(hosts.retire(first), retiring);
  await retiring;
  assert.deepEqual(fixture.counts(), { closed: 0, hmrClosed: 1 });
  assert.equal(
    await hosts.get(async () => {
      throw Error('must retain shared provider');
    }),
    fixture.provider,
  );
  await hosts.retire(second);
  await hosts.retire(first);
  assert.deepEqual(fixture.counts(), { closed: 1, hmrClosed: 1 });
});
test('retiring a non-HMR owner does not close another live server sockets', async () => {
  const hosts = createDevClientHosts(),
    first = createServer(),
    second = createServer(),
    fixture = fake();
  hosts.attach(first);
  hosts.attach(second);
  await hosts.get(async () => fixture.provider);
  await hosts.retire(second);
  assert.deepEqual(fixture.counts(), { closed: 0, hmrClosed: 0 });
  await hosts.retire(first);
  assert.deepEqual(fixture.counts(), { closed: 1, hmrClosed: 0 });
});
test('late provider acquisition clears its retired generation cache, not the next live cache', async () => {
  const hosts = createDevClientHosts(),
    first = createServer(),
    next = createServer(),
    old = fake(),
    fresh = fake();
  let oldCacheClears = 0,
    freshCacheClears = 0,
    finish!: () => void;
  const cacheOwner = (fixture: ReturnType<typeof fake>, clear: () => void) =>
    ownDevClient(
      {
        ...fixture.provider,
        watcher: {
          add() {
            return this;
          },
          async close() {},
        },
      } as unknown as Parameters<typeof ownDevClient>[0],
      async () => {
        clear();
      },
    );
  const oldClient = cacheOwner(old, () => {
    oldCacheClears++;
  });
  const freshClient = cacheOwner(fresh, () => {
    freshCacheClears++;
  });
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  hosts.attach(first);
  const pending = hosts.get(async () => {
    await held;
    return oldClient;
  });
  const rejected = assert.rejects(pending, /retired/);
  await Promise.resolve(); // The old provider factory has acquired its generation.
  const retiring = hosts.retire(first);
  hosts.attach(next);
  assert.equal(await hosts.get(async () => freshClient), freshClient);
  finish();
  await rejected;
  await retiring;
  assert.deepEqual(old.counts(), { closed: 1, hmrClosed: 0 });
  assert.equal(oldCacheClears, 1);
  assert.equal(freshCacheClears, 0);
  await hosts.retire(next);
  assert.equal(freshCacheClears, 1);
});
test('simultaneous last owners share exactly one provider close without relying on provider memoization', async () => {
  const hosts = createDevClientHosts(),
    first = createServer(),
    second = createServer(),
    fixture = fake();
  hosts.attach(first);
  hosts.attach(second);
  await hosts.get(async () => fixture.provider);
  const one = hosts.retire(first),
    two = hosts.retire(second);
  await Promise.all([one, two]);
  assert.deepEqual(fixture.counts(), { closed: 1, hmrClosed: 0 });
});
test('two owners retiring during acquisition share late close and cannot resurrect an ownerless provider', async () => {
  const hosts = createDevClientHosts(),
    first = createServer(),
    second = createServer(),
    fixture = fake();
  let finish!: () => void,
    loads = 0;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  hosts.attach(first);
  hosts.attach(second);
  const acquiring = hosts.get(async () => {
    loads++;
    await held;
    return fixture.provider;
  });
  const rejected = assert.rejects(acquiring, /retired/);
  await Promise.resolve();
  const one = hosts.retire(first),
    two = hosts.retire(second);
  await assert.rejects(
    hosts.get(async () => {
      loads++;
      return fixture.provider;
    }),
    /retired/,
  );
  finish();
  await rejected;
  await Promise.all([one, two]);
  assert.equal(loads, 1);
  assert.deepEqual(fixture.counts(), { closed: 1, hmrClosed: 0 });
  assert.throws(() => hosts.attach(first), /retired/);
});
test('retirement before lazy factory starts prevents acquisition entirely', async () => {
  const hosts = createDevClientHosts(),
    server = createServer(),
    fixture = fake();
  hosts.attach(server);
  let loads = 0;
  const acquiring = hosts.get(async () => {
    loads++;
    return fixture.provider;
  });
  const rejected = assert.rejects(acquiring, /retired/);
  await hosts.retire(server);
  await rejected;
  assert.equal(loads, 0);
  assert.deepEqual(fixture.counts(), { closed: 0, hmrClosed: 0 });
});
