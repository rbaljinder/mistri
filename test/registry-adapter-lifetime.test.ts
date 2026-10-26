import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Registry } from '../packages/engine/src/server/connections.js';
import type { Adapter } from '../packages/engine/src/adapters/adapter.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Pure lifecycle fixtures: inject a published fake, never open a database.
// Native acquisition/publication remains covered by the integration gate.
function fixture() {
  const registry = new Registry();
  const config = registry.add({ name: 'lifetime', url: ':memory:', source: 'config' });
  const closing = deferred();
  const adapter = { close: () => closing.promise } as Adapter;
  const entries = (
    registry as unknown as {
      entries: Map<
        string,
        {
          adapter?: Adapter;
          schema?: unknown;
          adapterLifetime?: object;
        }
      >;
    }
  ).entries;
  const entry = entries.get(config.id)!;
  entry.adapter = adapter;
  entry.schema = {};
  entry.adapterLifetime = {};
  return { registry, id: config.id, adapter, closing, entry };
}

for (const operation of ['refresh', 'remove', 'retarget', 'closeAll'] as const) {
  test(`adapter lifetime is revoked synchronously before ${operation} awaits`, async (t) => {
    const { registry, id, adapter, closing } = fixture();
    const current = registry.captureAdapterLifetime(id, adapter);
    current();
    const release = registry.lease(id);
    // Refresh's eventual reopen is outside this pure close-lifetime test.
    if (operation === 'refresh')
      t.mock.method(registry, 'open', async () => {
        throw new Error('fake reopen');
      });
    const work =
      operation === 'refresh'
        ? registry.refresh(id)
        : operation === 'remove'
          ? registry.remove(id)
          : operation === 'retarget'
            ? registry.update(id, { url: 'replacement.sqlite' })
            : registry.closeAll();
    const done = operation === 'refresh' ? assert.rejects(work, /fake reopen/) : work;
    assert.throws(current, /no longer current/);
    assert.throws(() => registry.captureAdapterLifetime(id, adapter), /no longer current/);
    release();
    await Promise.resolve();
    assert.throws(current, /no longer current/);
    closing.resolve();
    await done;
    assert.throws(current, /no longer current/);
    assert.throws(() => registry.captureAdapterLifetime(id, adapter), /no longer current/);
  });
}

test('lifetime binds exact adapter and generation without changing lease or rename behavior', async () => {
  const { registry, id, adapter, entry, closing } = fixture();
  assert.throws(() => registry.captureAdapterLifetime('missing', adapter), /no longer current/);
  assert.throws(() => registry.captureAdapterLifetime(id, {} as Adapter), /no longer current/);
  const current = registry.captureAdapterLifetime(id, adapter);
  const release = registry.lease(id);
  release();
  release();
  current();
  await registry.update(id, { name: 'renamed' });
  current();
  entry.adapterLifetime = {};
  assert.throws(current, /no longer current/);
  registry.captureAdapterLifetime(id, adapter)();
  entry.adapter = {} as Adapter;
  assert.throws(() => registry.captureAdapterLifetime(id, adapter), /no longer current/);
  closing.resolve();
});
