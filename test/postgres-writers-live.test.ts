/**
 * An App's writer pool against a live PostgreSQL (TABLEWALK_TEST_PG), in a
 * database of this file's own (WR2, C8).
 *
 * Writes of different records run side by side, each on a writer of its own;
 * two writes of one record commit in the order they arrived, the second
 * waiting in its lane without a connection; a save on a row someone changed
 * since is refused; a write that waits on another transaction's lock gives
 * up after the lock timeout and says so, over HTTP as 503 with Retry-After;
 * background work writes through its own connection, so a held one never
 * delays a person's save; two processes incrementing one row lose nothing;
 * and the database browser keeps one writer, one write at a time, and its
 * Undo.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { asBackgroundWork, configureLockTimeout, configureWriteOrder, lockTimedOut } from '../packages/engine/src/adapters/writeLanes.js';
import { isWriteConflict, type Adapter } from '../packages/engine/src/adapters/adapter.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { recordedUpdate } from '../packages/engine/src/server/recordWriteOperations.js';
import { clearJournal, history, revert } from '../packages/engine/src/server/journal.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { pgClient, uuidPostgresDatabase, type Control } from './support/tenantDialects.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const skip = liveSkip('postgres', LIVE);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
// An App's order, for every adapter this file opens; the browser's test switches it for its own.
configureWriteOrder('keyed');
// The HTTP test's writer takes the process's lock timeout; the others name their own.
configureLockTimeout(400);

let database: { url: string; drop: () => Promise<void> } | undefined;
const opened: Adapter[] = [];
const adapter = (options: { writers?: number; lockTimeoutMs?: number } = {}) => {
  const made = new PostgresAdapter(database!.url, 'writers', [], undefined, {
    writers: options.writers ?? 4,
    lockTimeoutMs: options.lockTimeoutMs ?? 10_000,
  });
  opened.push(made);
  return made;
};
const key = (id: number) => ({ table: 'item', key: { id } });
const labelOf = async (client: Control, id: number) => (await client.query('SELECT label FROM item WHERE id = $1', [id])).rows[0]?.label;
/** A transaction of someone else's holding one row's lock until released. */
async function holdRow(id: number) {
  const client = await pgClient(database!.url);
  await client.query('BEGIN');
  await client.query('SELECT 1 FROM item WHERE id = $1 FOR UPDATE', [id]);
  return {
    client,
    release: async () => {
      await client.query('COMMIT');
      await client.end();
    },
  };
}
const settled = <T>(promise: Promise<T>) => {
  const state = { done: false };
  void promise.then(
    () => {
      state.done = true;
    },
    () => {
      state.done = true;
    },
  );
  return state;
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  if (skip) return;
  database = await uuidPostgresDatabase('writers');
  const setup = await pgClient(database.url);
  try {
    await setup.query(`CREATE TABLE item (id integer PRIMARY KEY, label text NOT NULL);
      INSERT INTO item SELECT n, 'item ' || n FROM generate_series(1, 12) AS n;
      CREATE TABLE counter (id integer PRIMARY KEY, n integer NOT NULL);
      INSERT INTO counter VALUES (1, 0);`);
  } finally {
    await setup.end();
  }
});

after(async () => {
  for (const made of opened) await made.close().catch(() => {});
  await database?.drop();
});

test('writes of different records run side by side, each on a writer of its own', { skip }, async () => {
  const db = adapter();
  await db.introspect();
  const held = await holdRow(1);
  try {
    const waiting = db.update({ ...key(1), values: { label: 'one' } });
    const watched = settled(waiting);
    await pause(100);
    // Record 2 is written while record 1's write still waits for its row.
    await db.update({ ...key(2), values: { label: 'two' } });
    assert.equal(watched.done, false);
    const writers = db.poolStats().find((stats) => stats.role === 'write');
    assert.equal(writers?.size, 4);
    await held.release();
    await waiting;
  } finally {
    await held.release().catch(() => {});
  }
  const check = await pgClient(database!.url);
  try {
    assert.deepEqual([await labelOf(check, 1), await labelOf(check, 2)], ['one', 'two']);
  } finally {
    await check.end();
  }
});

test('two writes of one record commit in the order they arrived; the second waits without a connection', { skip }, async () => {
  const db = adapter();
  await db.introspect();
  const held = await holdRow(3);
  try {
    const first = db.update({ ...key(3), values: { label: 'first' } });
    const second = db.update({ ...key(3), values: { label: 'second' } });
    await pause(100);
    // One writer is out, waiting on the row; the second write waits in its lane, holding none.
    assert.equal(db.poolStats().find((stats) => stats.role === 'write')?.inUse, 1);
    await held.release();
    await Promise.all([first, second]);
  } finally {
    await held.release().catch(() => {});
  }
  const check = await pgClient(database!.url);
  try {
    assert.equal(await labelOf(check, 3), 'second');
  } finally {
    await check.end();
  }
});

test('a save on a row someone changed since is refused, not written over theirs', { skip }, async () => {
  const db = adapter();
  await db.introspect();
  const other = await pgClient(database!.url);
  try {
    await other.query(`UPDATE item SET label = 'theirs' WHERE id = 4`);
    await assert.rejects(db.update({ ...key(4), values: { label: 'mine' }, expected: { label: 'item 4' } }), isWriteConflict);
    assert.equal(await labelOf(other, 4), 'theirs');
    await db.update({ ...key(4), values: { label: 'mine' }, expected: { label: 'theirs' } });
    assert.equal(await labelOf(other, 4), 'mine');
  } finally {
    await other.end();
  }
});

test("a write that waits on another transaction's lock gives up after the lock timeout, and the writer goes on", { skip }, async () => {
  const db = adapter({ lockTimeoutMs: 400 });
  await db.introspect();
  const held = await holdRow(5);
  try {
    const started = performance.now();
    const failure = await db.update({ ...key(5), values: { label: 'blocked' } }).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(lockTimedOut(failure), String(failure));
    const waited = performance.now() - started;
    assert.ok(waited >= 350 && waited < 5_000, `waited ${Math.round(waited)} ms`);
  } finally {
    await held.release();
  }
  // The same writer pool writes the row once it is free.
  await db.update({ ...key(5), values: { label: 'free' } });
  // And a transaction that waited out a lock rolled back: nothing it wrote before landed.
  const again = await holdRow(6);
  try {
    const failure = await db
      .transaction(async (tx) => {
        await tx.update({ ...key(7), values: { label: 'half' } });
        await tx.update({ ...key(6), values: { label: 'blocked' } });
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    assert.ok(lockTimedOut(failure), String(failure));
  } finally {
    await again.release();
  }
  const check = await pgClient(database!.url);
  try {
    assert.deepEqual([await labelOf(check, 5), await labelOf(check, 7)], ['free', 'item 7']);
  } finally {
    await check.end();
  }
});

test("background work writes through its own connection: one held never delays a person's save", { skip }, async () => {
  // One writer for people, so a background write taking it would block the save below.
  const quick = adapter({ writers: 1, lockTimeoutMs: 10_000 });
  await quick.introspect();
  const held = await holdRow(8);
  try {
    const job = asBackgroundWork(() => quick.update({ ...key(8), values: { label: 'job' } }));
    const watched = settled(job);
    await pause(150);
    await quick.update({ ...key(9), values: { label: 'person' } });
    assert.equal(watched.done, false, "the person's save finished while the job still waited");
    assert.deepEqual(
      quick
        .poolStats()
        .filter((stats) => stats.role !== 'read')
        .map((stats) => [stats.role, stats.size]),
      [
        ['write', 1],
        ['background', 1],
      ],
    );
    await held.release();
    await job;
  } finally {
    await held.release().catch(() => {});
  }
});

test('two processes incrementing one row lose nothing: every save compares and sets', { skip }, async () => {
  const each = 10;
  const child = `
    const { configureWriteOrder } = await import(${JSON.stringify(`${ROOT}packages/engine/src/adapters/writeLanes.ts`)});
    configureWriteOrder('keyed');
    const { PostgresAdapter } = await import(${JSON.stringify(`${ROOT}packages/engine/src/adapters/postgres.ts`)});
    const { isWriteConflict } = await import(${JSON.stringify(`${ROOT}packages/engine/src/adapters/adapter.ts`)});
    const db = new PostgresAdapter(process.env.WRITERS_URL, 'child', [], undefined, { writers: 4 });
    await db.introspect();
    let conflicts = 0;
    for (let i = 0; i < ${each}; i++) {
      for (;;) {
        const { rows } = await db.query({ table: 'counter', filter: { groups: [[{ column: 'id', op: '=', value: 1 }]] }, limit: 1, offset: 0 });
        const n = Number(rows[0].n);
        try { await db.update({ table: 'counter', key: { id: 1 }, values: { n: n + 1 }, expected: { n } }); break; }
        catch (error) { if (isWriteConflict(error)) { conflicts++; continue; } throw error; }
      }
    }
    await db.close();
    process.stdout.write(JSON.stringify({ conflicts }));`;
  const run = () =>
    promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', child], {
      cwd: ROOT,
      env: { ...process.env, WRITERS_URL: database!.url },
      timeout: 110_000,
    });
  const results = await Promise.all([run(), run()]);
  const conflicts = results.reduce((total, { stdout }) => total + (JSON.parse(stdout) as { conflicts: number }).conflicts, 0);
  const check = await pgClient(database!.url);
  try {
    assert.equal(
      Number((await check.query('SELECT n FROM counter WHERE id = 1')).rows[0].n),
      each * 2,
      `after ${conflicts} refused stale saves`,
    );
  } finally {
    await check.end();
  }
});

test('the database browser keeps one writer, one write at a time, and its Undo', { skip }, async () => {
  configureWriteOrder('serial');
  const bench = adapter({ writers: 8 });
  configureWriteOrder('keyed');
  await bench.introspect();
  const held = await holdRow(10);
  try {
    const first = bench.update({ ...key(10), values: { label: 'first' } });
    const second = settled(bench.update({ ...key(11), values: { label: 'second' } }));
    await pause(150);
    // Another record, and still behind the first write: the browser's queue is the whole connection's.
    assert.equal(second.done, false);
    await held.release();
    await first;
  } finally {
    await held.release().catch(() => {});
  }
  await pause(50);
  assert.equal(bench.poolStats().find((stats) => stats.role === 'write')?.size, 1);

  const { undoId } = await recordedUpdate({ adapter: bench, connection: 'bench' }, { ...key(12), values: { label: 'edited' } });
  assert.ok(Number.isSafeInteger(undoId));
  const entry = history('bench', 1)[0];
  const undone = await revert(bench, 'bench', entry);
  assert.equal(undone.reverted, true, JSON.stringify(undone));
  const check = await pgClient(database!.url);
  try {
    assert.equal(await labelOf(check, 12), 'item 12');
  } finally {
    await check.end();
    clearJournal('bench');
  }
});

test("over HTTP an App's save that waited out a lock is 503 with Retry-After and nothing applied", { skip }, async () => {
  const registry = new Registry();
  registry.add({ id: 'writers-db', name: 'Writers', url: database!.url, source: 'config', writable: true });
  const definition = parseAppConfig(
    {
      id: 'writers',
      name: 'Writers',
      connection: 'writers-db',
      resources: { item: { access: 'write' } },
      views: { items: { kind: 'list', from: 'item', show: ['label'] } },
      home: 'items',
      nav: ['items'],
    },
    'writers fixture',
  );
  const host = { app: { path: 'writers.ts', app: definition, pages: [], sources: {} }, pages: [] } as unknown as AppHost;
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages: [] });
  server.listen(0, bound.host);
  await once(server, 'listening');
  bound.port = (server.address() as { port: number }).port;
  const held = await holdRow(11);
  try {
    const response = await fetch(`http://${bound.host}:${bound.port}/api/update`, {
      method: 'POST',
      signal: AbortSignal.timeout(20_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app: 'writers',
        table: 'item',
        key: { id: 11 },
        values: { label: 'locked out' },
        expected: { label: 'second' },
      }),
    });
    const body = (await response.json()) as { code?: string; outcome?: string; error?: string };
    assert.equal(response.status, 503, JSON.stringify(body));
    assert.equal(response.headers.get('retry-after'), '1');
    assert.deepEqual([body.code, body.outcome], ['row_locked', 'not_applied']);
    assert.match(body.error ?? '', /locked by another transaction/);
  } finally {
    await held.release();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
  }
  const check = await pgClient(database!.url);
  try {
    assert.equal(await labelOf(check, 11), 'second');
  } finally {
    await check.end();
  }
});

/* A save sends its record's lock behind the BEGIN (writeAhead.ts). When that lock waited out the lock timeout, the
   transaction began again without it and asked for the same lock again, waiting a second time: a held row was
   answered `row_locked` after ten seconds where five are documented (a live load test). It waits once now. The
   connection is warmed by a save first, so the second save's lock is the one sent ahead. */
test('a save behind a held row is refused after one lock timeout, not two', { skip }, async () => {
  const registry = new Registry();
  registry.add({ id: 'once-db', name: 'Once', url: database!.url, source: 'config', writable: true });
  const definition = parseAppConfig(
    {
      id: 'once',
      name: 'Once',
      connection: 'once-db',
      resources: { item: { access: 'write' } },
      views: { items: { kind: 'list', from: 'item', show: ['label'] } },
      home: 'items',
      nav: ['items'],
    },
    'once fixture',
  );
  const host = { app: { path: 'once.ts', app: definition, pages: [], sources: {} }, pages: [] } as unknown as AppHost;
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages: [] });
  server.listen(0, bound.host);
  await once(server, 'listening');
  bound.port = (server.address() as { port: number }).port;
  const save = (id: number, label: string) =>
    fetch(`http://${bound.host}:${bound.port}/api/update`, {
      method: 'POST',
      signal: AbortSignal.timeout(20_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: 'once', table: 'item', key: { id }, values: { label } }),
    });
  try {
    for (const label of ['warm', 'warmer']) assert.equal((await save(1, label)).status, 200);
    const held = await holdRow(2);
    try {
      const started = performance.now();
      const response = await save(2, 'locked out');
      const waited = performance.now() - started;
      assert.equal(response.status, 503, await response.text());
      // The lock timeout is 400 ms here (configureLockTimeout above): once, with room, and well short of twice.
      assert.ok(waited >= 350 && waited < 750, `waited ${Math.round(waited)} ms`);
    } finally {
      await held.release();
    }
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
  }
});
