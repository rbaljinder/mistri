/**
 * What a PostgreSQL authentication store answered about a session, kept for a
 * few seconds (authStoreReads.ts): a field report counted 116 transactions on
 * the auth store for one list page, a session read and eleven observations of
 * it per API call. These cases hold the rules that make keeping them safe
 * without a server: a write this process sends drops everything kept, before
 * it leaves and when it is answered; a read that overlapped one is not kept; a
 * read-only transaction drops nothing; a burst shares one read. The live half,
 * counted against a real store, is test/postgres-tenant-auth.test.ts.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { authReadTtlMs, createAuthStoreReads, DEFAULT_AUTH_READ_TTL_MS } from '../packages/mistri/src/server/auth/authStoreReads.js';
import { authPoolSize, observedClient, transactionPooledClient } from '../packages/mistri/src/server/auth/authStore.js';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const fixture = (ttlMs = 5_000) => {
  let now = 1_000_000;
  const store = `postgres://reads-${randomUUID()}`;
  const reads = createAuthStoreReads(store, ttlMs, () => now);
  let loads = 0;
  const load = async () => ({ n: ++loads });
  return { reads, store, load, loads: () => loads, advance: (ms: number) => (now += ms) };
};
/** A statement as the pool's client reports it: sent, then answered. */
const send = (reads: ReturnType<typeof createAuthStoreReads>, client: object, text: string | undefined) => reads.statement(client, text)();

test('a read is kept for the TTL, and read again after it', async () => {
  const f = fixture();
  assert.deepEqual(await f.reads.read('k', f.load), { n: 1 });
  assert.deepEqual(await f.reads.read('k', f.load), { n: 1 });
  f.advance(4_999);
  assert.deepEqual(await f.reads.read('k', f.load), { n: 1 });
  f.advance(1);
  assert.deepEqual(await f.reads.read('k', f.load), { n: 2 });
  assert.equal(f.loads(), 2);
});

test('any write this process sends drops what was kept, from every key', async () => {
  const f = fixture(),
    client = {};
  for (const text of [
    'delete from "auth_session" where "token" = $1',
    'UPDATE mistri.auth_user SET banned = true WHERE id = $1',
    'insert into "auth_session" ("id") values ($1)',
    'WITH gone AS (DELETE FROM auth_session RETURNING id) SELECT count(*) FROM gone',
    // Several statements at once, or nothing to read, are taken for a write.
    'SELECT 1; DELETE FROM auth_session',
    'SET search_path TO mistri; DELETE FROM auth_session',
    undefined,
  ]) {
    const before = f.loads();
    await f.reads.read('a', f.load);
    await f.reads.read('b', f.load);
    send(f.reads, client, text);
    await f.reads.read('a', f.load);
    await f.reads.read('b', f.load);
    assert.equal(f.loads(), before + (before === 0 ? 4 : 2), String(text));
  }
});

test('reads, settings and a read-only transaction drop nothing', async () => {
  const f = fixture(),
    client = {};
  await f.reads.read('k', f.load);
  for (const text of [
    'select "primary".* from (select * from "auth_session" where "token" = ?) as "primary"',
    '  /* a comment */ SELECT 1;',
    'BEGIN',
    'SET LOCAL search_path TO pg_catalog, mistri, pg_temp',
    'SELECT id FROM mistri.auth_user WHERE id = $1 FOR UPDATE',
    'SAVEPOINT a',
    'ROLLBACK TO SAVEPOINT a',
    'COMMIT',
    'SHOW search_path',
    // A connection's setup, sent as it opens.
    'SET search_path TO pg_catalog, mistri, pg_temp; SET statement_timeout = 30000',
  ])
    send(f.reads, client, text);
  await f.reads.read('k', f.load);
  assert.equal(f.loads(), 1);
});

test('a write inside a transaction drops what was kept when it is sent and again when the transaction ends', async () => {
  for (const end of ['COMMIT', 'ROLLBACK', 'END']) {
    const f = fixture(),
      client = {};
    send(f.reads, client, 'BEGIN');
    send(f.reads, client, 'DELETE FROM auth_session WHERE id = $1');
    // A read between the write and the end of its transaction saw the store before the COMMIT: it is not kept past it.
    await f.reads.read('k', f.load);
    await f.reads.read('k', f.load);
    assert.equal(f.loads(), 1);
    send(f.reads, client, end);
    await f.reads.read('k', f.load);
    assert.equal(f.loads(), 2, end);
    // The next transaction starts clean: a read-only one drops nothing.
    send(f.reads, client, 'BEGIN');
    send(f.reads, client, 'SELECT 1');
    send(f.reads, client, 'COMMIT');
    await f.reads.read('k', f.load);
    assert.equal(f.loads(), 2);
  }
  // A connection that ends with a write in its open transaction drops what was kept too.
  const f = fixture(),
    client = {};
  send(f.reads, client, 'BEGIN');
  send(f.reads, client, 'UPDATE auth_user SET role = $1');
  await f.reads.read('k', f.load);
  f.reads.ended(client);
  await f.reads.read('k', f.load);
  assert.equal(f.loads(), 2);
});

test('a read asked while a write is in flight, or answered after one was sent, is used but not kept', async () => {
  const f = fixture(),
    client = {};
  // Asked before the write leaves, answered after: not kept.
  let answer!: (value: { n: number }) => void;
  const slow = f.reads.read('k', () => new Promise<{ n: number }>((resolve) => (answer = resolve)));
  const answered = f.reads.statement(client, 'DELETE FROM auth_session WHERE id = $1');
  answer({ n: 0 });
  assert.deepEqual(await slow, { n: 0 }, 'the caller has its answer');
  // Asked after the write left, answered before it was: not kept past the write's answer.
  await f.reads.read('k', f.load);
  answered();
  await f.reads.read('k', f.load);
  await f.reads.read('k', f.load);
  assert.equal(f.loads(), 2);
});

test('reads asked together share one; one asked after a write does not join it', async () => {
  const f = fixture(),
    client = {};
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let loads = 0;
  const load = async () => {
    loads += 1;
    await gate;
    return { n: loads };
  };
  const burst = Array.from({ length: 16 }, () => f.reads.read('k', load));
  assert.equal(loads, 1);
  send(f.reads, client, 'DELETE FROM auth_session WHERE id = $1');
  const after = f.reads.read('k', load);
  assert.equal(loads, 2, 'a write since the flight left is not waited out on its answer');
  release();
  assert.deepEqual(
    await Promise.all(burst),
    Array.from({ length: 16 }, () => ({ n: 2 })),
  );
  assert.deepEqual(await after, { n: 2 });
  // A failed read is everyone's failure and is not kept.
  const failing = Array.from({ length: 3 }, () => f.reads.read('f', () => Promise.reject(new Error('store down'))));
  for (const pending of failing) await assert.rejects(pending, /store down/);
  assert.deepEqual(await f.reads.read('f', async () => ({ n: 9 })), { n: 9 });
});

test('keep and usable: a signed-out answer is not kept, and a kept one that no longer serves is read again', async () => {
  const f = fixture();
  let value: { live: boolean } | null = null;
  const load = async () => value;
  const ask = () => f.reads.read('k', load, { keep: Boolean, usable: (kept) => kept?.live === true });
  assert.equal(await ask(), null);
  const first = { live: true };
  value = first;
  assert.equal(await ask(), first, 'the signed-out answer was not kept');
  value = { live: true };
  assert.equal(await ask(), first, 'kept');
  // The kept answer no longer serves (a session past its expiry, in auth.ts): it is read again.
  first.live = false;
  assert.equal(await ask(), value);
});

test('prime keeps a row only if the store has not changed since the read that found it began', async () => {
  const f = fixture(),
    client = {};
  let mark!: Parameters<Parameters<typeof f.reads.read>[1]>[0];
  await f.reads.read('session', async (given) => {
    mark = given;
    return 'session';
  });
  f.reads.prime('row', { banned: false }, mark);
  assert.deepEqual(await f.reads.read('row', async () => ({ banned: 'read' })), { banned: false });
  send(f.reads, client, 'UPDATE auth_user SET banned = true');
  f.reads.prime('row', { banned: false }, mark);
  assert.deepEqual(await f.reads.read('row', async () => ({ banned: true })), { banned: true });
});

test('a TTL of zero keeps nothing and shares nothing: every observation reads the store', async () => {
  const f = fixture(0);
  await f.reads.read('k', f.load);
  await Promise.all([f.reads.read('k', f.load), f.reads.read('k', f.load)]);
  assert.equal(f.loads(), 3);
});

test('two handles on one store URL in this process drop together; another store is left alone', async () => {
  const one = fixture();
  const other = createAuthStoreReads(one.store, 5_000);
  const elsewhere = createAuthStoreReads(`postgres://reads-${randomUUID()}`, 5_000);
  let loads = 0;
  const load = async () => ++loads;
  await one.reads.read('k', load);
  await elsewhere.read('k', load);
  send(other, {}, 'DELETE FROM auth_session');
  await one.reads.read('k', load);
  await elsewhere.read('k', load);
  assert.equal(loads, 3);
});

test('MISTRI_AUTH_SESSION_CACHE and MISTRI_AUTH_POOL are read as seconds and connections, and refused out of range', () => {
  assert.equal(authReadTtlMs({}), DEFAULT_AUTH_READ_TTL_MS);
  assert.equal(authReadTtlMs({ MISTRI_AUTH_SESSION_CACHE: '0' }), 0);
  assert.equal(authReadTtlMs({ MISTRI_AUTH_SESSION_CACHE: ' 2.5 ' }), 2_500);
  for (const bad of ['-1', '61', 'five', '1e3']) assert.throws(() => authReadTtlMs({ MISTRI_AUTH_SESSION_CACHE: bad }), /0 to 60/);
  assert.equal(authPoolSize({}), 4);
  assert.equal(authPoolSize({ MISTRI_AUTH_POOL: '16' }), 16);
  for (const bad of ['0', '65', '2.5', 'many']) assert.throws(() => authPoolSize({ MISTRI_AUTH_POOL: bad }), /1 to 64/);
});

/** pg's Client as far as the store's wrappers use it: query with a promise or a callback, and 'end'. */
class FakeClient extends EventEmitter {
  static sent: string[] = [];
  constructor(_options: Record<string, unknown>) {
    super();
  }
  query(request: string | { text: string }, ...rest: unknown[]): unknown {
    const text = typeof request === 'string' ? request : request.text;
    FakeClient.sent.push(text);
    const done = typeof rest.at(-1) === 'function' ? (rest.at(-1) as (error: unknown, result?: unknown) => void) : undefined;
    const result = new Promise((resolve) => setImmediate(() => resolve({ rows: [], fields: [], rowCount: 0 })));
    if (!done) return result;
    void result.then((value) => done(null, value));
    return undefined;
  }
}

test("the store's client tells its reads what the caller sent, whether it is answered by promise or by callback", async () => {
  const f = fixture();
  const Client = observedClient(FakeClient as unknown as new (options: Record<string, unknown>) => PgQuery, f.reads);
  const client = new Client({}) as PgQuery & EventEmitter;
  await f.reads.read('k', f.load);
  await client.query('SELECT 1');
  await f.reads.read('k', f.load);
  assert.equal(f.loads(), 1, 'a read drops nothing');
  // pg-pool's pool.query answers through a callback.
  await new Promise<void>((resolve) =>
    (client.query as (text: string, values: unknown[], done: () => void) => void)('DELETE FROM t', [], resolve),
  );
  await f.reads.read('k', f.load);
  assert.equal(f.loads(), 2);
  // A write in flight: what is read meanwhile is not kept past its answer.
  const writing = client.query('UPDATE t SET x = 1');
  await f.reads.read('k', f.load);
  await writing;
  await f.reads.read('k', f.load);
  assert.equal(f.loads(), 4);
  // A connection that ends inside a transaction with a write in it.
  await client.query('BEGIN');
  await client.query('UPDATE t SET x = 2');
  await f.reads.read('k', f.load);
  client.emit('end');
  await f.reads.read('k', f.load);
  assert.equal(f.loads(), 6);
});

test("behind a transaction-mode pooler the store's reads see the caller's statements, not the transaction wrapped around each", async () => {
  const f = fixture();
  FakeClient.sent = [];
  const Client = observedClient(
    transactionPooledClient(FakeClient as unknown as new (options: Record<string, unknown>) => PgQuery),
    f.reads,
  );
  const client = new Client({}) as PgQuery;
  await f.reads.read('k', f.load);
  await client.query('SELECT 1', []);
  await tick();
  // The BEGIN and COMMIT around the read reach the server, and drop nothing.
  assert.match(FakeClient.sent[0], /^BEGIN; SET LOCAL statement_timeout = 30000; SET LOCAL search_path TO /);
  assert.deepEqual(FakeClient.sent.slice(1), ['SELECT 1', 'COMMIT']);
  await f.reads.read('k', f.load);
  assert.equal(f.loads(), 1);
  await client.query('DELETE FROM t', []);
  await f.reads.read('k', f.load);
  assert.equal(f.loads(), 2);
});
