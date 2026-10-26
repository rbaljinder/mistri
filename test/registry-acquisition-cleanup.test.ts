import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Registry } from '../packages/engine/src/server/connections.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';

for (const failure of ['introspection', 'wrapping', 'close'] as const) {
  test(`Registry closes unpublished adapters after ${failure} failure`, async (t) => {
    const registry = new Registry();
    const entry = registry.add({ name: 'cleanup', url: ':memory:', rows: false, source: 'config' });
    const introspect = SqliteAdapter.prototype.introspect;
    const close = SqliteAdapter.prototype.close;
    let closes = 0;
    t.mock.method(SqliteAdapter.prototype, 'close', async function (this: SqliteAdapter) {
      closes++;
      await close.call(this);
      if (failure === 'close') throw new Error('cleanup error must not replace original');
    });
    t.mock.method(SqliteAdapter.prototype, 'introspect', async function (this: SqliteAdapter) {
      if (failure !== 'wrapping') throw new Error('original introspection failure');
      const schema = await introspect.call(this);
      Object.defineProperty(this, 'wrappingFailure', {
        enumerable: true,
        get() {
          throw new Error('original wrapping failure');
        },
      });
      return schema;
    });
    try {
      await assert.rejects(registry.open(entry.id), /cleanup: original (introspection|wrapping) failure/);
      assert.equal(closes, 1);
      await registry.closeAll();
      assert.equal(closes, 1, 'failed acquisition is not published for a second close');
    } finally {
      await registry.closeAll();
    }
  });
}

test('Registry retains ownership of successfully published shape-only adapters', async (t) => {
  const registry = new Registry();
  const entry = registry.add({ name: 'published', url: ':memory:', rows: false, source: 'config' });
  const close = SqliteAdapter.prototype.close;
  let closes = 0;
  t.mock.method(SqliteAdapter.prototype, 'close', async function (this: SqliteAdapter) {
    closes++;
    await close.call(this);
  });
  try {
    await registry.open(entry.id);
    assert.equal(closes, 0);
  } finally {
    await registry.closeAll();
  }
  assert.equal(closes, 1);
});
