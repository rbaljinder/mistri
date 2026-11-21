/**
 * A breakdown batch never says an item's last wave. Each item's route (`/api/run`,
 * `/api/breakdown`) knows only its own reads, and a tenant App's fenced snapshot
 * lets its fence leave with the wave after `lastWave`: every read asked later is
 * refused, and the request fails closed (tenantReadSource.ts, `overrun`). In a
 * batch the other items are still queued or between their reads when one item
 * says so, so a dashboard asked right after a tenant switch locked the session.
 * A batch of one is that route alone and keeps its last wave.
 *
 * The fence is modelled here on SQLite: once `lastWave` has been said, a read
 * started on a later turn fails, as the tenant snapshot refuses it.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { Adapter } from '../packages/engine/src/adapters/adapter.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { dispatchResourceReadHttp } from '../packages/engine/src/server/resourceReadHttp.js';

/* After `lastWave`, reads asked in the same turn leave with the fence; anything later is an overrun. */
function fenced(adapter: Adapter) {
  let closing = false,
    gone = false,
    overrun = 0,
    said = 0;
  const guard =
    <A extends unknown[], R>(read: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      if (gone) {
        overrun++;
        return Promise.reject(new Error('read after the fence left'));
      }
      if (closing)
        setImmediate(() => {
          gone = true;
        });
      return read(...args);
    };
  const reader = new Proxy(adapter, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' && /^(run|count|query|read)/.test(String(key))
        ? guard((value as (...args: unknown[]) => Promise<unknown>).bind(target))
        : typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
    },
  });
  return {
    reader,
    lastWave: () => {
      said++;
      closing = true;
    },
    get said() {
      return said;
    },
    get overrun() {
      return overrun;
    },
  };
}

test('a breakdown batch of several items never lets the fence leave before its last read', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-batch-last-wave-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'lead.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE lead(id INTEGER PRIMARY KEY, status TEXT, amount INTEGER);
    INSERT INTO lead VALUES (1, 'new', 10), (2, 'won', 20), (3, 'new', 30), (4, 'lost', 5);`);
  db.close();
  const adapter = new SqliteAdapter(file, 'lead');
  t.after(() => adapter.close());
  const schema = await adapter.introspect();

  /* More items than the batch's workers, lists among them: the shape of a dashboard after a switch. */
  const items = [
    { text: 'lead count by status' },
    { run: { q: 'lead status = new', limit: 5, count: 'exact' } },
    { text: 'lead status = new count', limit: 1 },
    { text: 'lead sum amount by status' },
    { run: { q: 'lead', limit: 2, count: 'exact' } },
    { text: 'lead status = won count', limit: 1 },
    { run: { q: 'lead status = lost', limit: 5, count: 'exact' } },
  ];
  const fence = fenced(adapter);
  const batch = await dispatchResourceReadHttp('/api/breakdowns', { items }, fence.reader, schema, {
    app: undefined,
    now: () => new Date('2026-11-20T00:00:00Z'),
    lastWave: () => fence.lastWave(),
  });
  assert.equal(batch?.status, 200, JSON.stringify(batch?.body));
  const results = (batch!.body as { results: { status: number; body: unknown }[] }).results;
  assert.equal(results.length, items.length);
  for (const [at, result] of results.entries()) assert.equal(result.status, 200, `item ${at}: ${JSON.stringify(result.body)}`);
  assert.equal(fence.said, 0, 'no item of a batch says the last wave');
  assert.equal(fence.overrun, 0, 'no read is asked after the fence left');

  /* A batch of one is the route alone, and keeps its last wave. */
  const alone = fenced(adapter);
  const one = await dispatchResourceReadHttp('/api/breakdowns', { items: [items[1]] }, alone.reader, schema, {
    app: undefined,
    now: () => new Date('2026-11-20T00:00:00Z'),
    lastWave: () => alone.lastWave(),
  });
  assert.equal(one?.status, 200);
  assert.equal(alone.said, 1);
  assert.equal(alone.overrun, 0);
});
