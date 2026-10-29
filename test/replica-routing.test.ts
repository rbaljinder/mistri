/**
 * Which pool a read goes to (packages/engine/src/adapters/replicas.ts), which routes may ask
 * for a replica (packages/engine/src/server/http/readRouting.ts), and how a connection's
 * "replicas" are checked (packages/engine/src/server/poolConfig.ts). The live proof against
 * a PostgreSQL server is postgres-replicas.test.ts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FRESH_READ_MS,
  lagTolerantReads,
  MAX_REPLICAS,
  noteWrite,
  primaryReads,
  readsAs,
  type ReadContext,
  REPLICA_BACKOFF_MS,
  replicaFailure,
  replicaReadWanted,
  ReplicaSet,
  ReplicaUnavailable,
} from '../packages/engine/src/adapters/replicas.js';
import { PoolBusy } from '../packages/engine/src/adapters/poolMetrics.js';
import { StatementStopped } from '../packages/engine/src/adapters/statementControl.js';
import { asBackgroundWork } from '../packages/engine/src/adapters/writeLanes.js';
import { freshCookie, readFreshness, toleratesLag } from '../packages/engine/src/server/http/readRouting.js';
import { replicasOf } from '../packages/engine/src/server/poolConfig.js';
import { connect } from '../packages/engine/src/adapters/connect.js';

test('a read wants a replica only inside lag-tolerant work that nothing pinned to the primary', () => {
  assert.equal(replicaReadWanted(), false, 'nobody classified it: the primary');
  assert.equal(
    lagTolerantReads(() => replicaReadWanted()),
    true,
  );
  assert.equal(
    primaryReads(() => lagTolerantReads(() => replicaReadWanted())),
    false,
    'a record page composed from list reads stays on the primary',
  );
  assert.equal(
    lagTolerantReads(() => primaryReads(() => replicaReadWanted())),
    false,
    "a write's own reads inside a list route stay on the primary",
  );
});

test('a write marks its own request fresh and asks once for the marker; a keyed caller is remembered in this process', () => {
  new ReplicaSet(['r']); // a process with replicas: until there is one, a write marks nothing
  const at = Date.now();
  const wants = (context: ReadContext, now = at + 1) => readsAs(context, () => lagTolerantReads(() => replicaReadWanted(now)));
  let marked = 0;
  const browser: ReadContext = { fresh: false, onWrite: () => marked++ };
  assert.equal(wants(browser), true);
  readsAs(browser, () => {
    noteWrite(at);
    noteWrite(at);
  });
  assert.equal(marked, 1, 'one cookie per request, however many writes');
  assert.equal(wants(browser), false, 'its own later reads stay on the primary');
  /* Two anonymous visitors share nothing: each carries its own marker. */
  assert.equal(wants({ fresh: false }), true, "another visitor's reads still go to a replica");
  assert.equal(wants({ fresh: true }), false, 'a request that brought a fresh marker reads the primary');

  const token = 'bearer:ann';
  readsAs({ fresh: false, key: token }, () => noteWrite(at));
  assert.equal(wants({ fresh: false, key: token }, at + FRESH_READ_MS - 1), false, 'a later request with the same token');
  assert.equal(wants({ fresh: false, key: token }, at + FRESH_READ_MS), true, 'the window has passed');
  assert.equal(wants({ fresh: false, key: 'bearer:bob' }), true, "bob's token did not write");
  /* A job's write is nobody's: it does not pin whoever the work runs as. */
  readsAs({ fresh: false, key: 'bearer:carol' }, () => asBackgroundWork(() => noteWrite(at)));
  assert.equal(wants({ fresh: false, key: 'bearer:carol' }), true);
});

test('the write marker is a short-lived HttpOnly cookie on the base path; a bearer caller is keyed by its token', () => {
  const now = 1_700_000_000_000;
  const response = () => {
    const headers = new Map<string, unknown>();
    return {
      headers,
      headersSent: false,
      getHeader: (name: string) => headers.get(name) as string | string[] | undefined,
      setHeader(name: string, value: unknown) {
        headers.set(name, value);
        return this as never;
      },
    };
  };
  const reply = response();
  reply.setHeader('set-cookie', 'other=1; Path=/');
  const context = readFreshness({ headers: {} }, reply, '/tools', () => now);
  assert.equal(context.fresh, false);
  assert.equal(context.key, undefined, 'a browser needs no process memory');
  context.onWrite?.();
  assert.deepEqual(reply.headers.get('set-cookie'), [
    'other=1; Path=/',
    `${freshCookie()}=${now}; Path=/tools; Max-Age=${FRESH_READ_MS / 1000}; HttpOnly; SameSite=Lax`,
  ]);
  const atRoot = response();
  readFreshness({ headers: {} }, atRoot, '', () => now).onWrite?.();
  assert.match(String(atRoot.headers.get('set-cookie')), /; Path=\/; /);

  const carrying = (value: string, at = now) =>
    readFreshness({ headers: { cookie: `a=b; ${freshCookie()}=${value}` } }, response(), '', () => at).fresh;
  assert.equal(carrying(String(now - 2_000)), true, 'written two seconds ago: the primary');
  assert.equal(carrying(String(now - FRESH_READ_MS)), false, 'expired');
  assert.equal(carrying(String(now + 60_000)), false, 'a time from the future is not one this server wrote');
  assert.equal(carrying('soon'), false);

  const bearer = readFreshness(
    { headers: { authorization: 'Bearer tw_secret', cookie: `${freshCookie()}=${now}` } },
    response(),
    '',
    () => now,
  );
  assert.equal(bearer.fresh, false, 'a token caller has no cookie jar to trust');
  assert.match(bearer.key ?? '', /^bearer:[\w-]{22}$/);
  assert.ok(!bearer.key?.includes('tw_secret'), 'the token itself is not kept');
  assert.equal(bearer.onWrite, undefined);
  assert.equal(readFreshness({ headers: { authorization: 'Bearer tw_secret' } }, response(), '').key, bearer.key);

  const late = response();
  late.headersSent = true;
  readFreshness({ headers: {} }, late, '').onWrite?.();
  assert.equal(late.headers.size, 0, 'too late for a header: the read is a moment old, nothing worse');
});

test('replicas take turns, a down one is passed over for the backoff, then tried again', () => {
  let now = 1_000;
  const set = new ReplicaSet(['a', 'b', 'c'], () => now);
  assert.deepEqual(
    [set.pick(), set.pick(), set.pick(), set.pick()].map((p) => p?.pool),
    ['a', 'b', 'c', 'a'],
  );
  set.down(1);
  assert.equal(set.healthy(1), false);
  assert.deepEqual(
    [set.pick(), set.pick(), set.pick()].map((p) => p?.pool),
    ['c', 'a', 'c'],
  );
  set.down(0);
  set.down(2);
  assert.equal(set.pick(), undefined, 'every replica down: the primary answers');
  now += REPLICA_BACKOFF_MS;
  assert.equal(set.healthy(1), true);
  assert.ok(set.pick(), 'tried again after the backoff');
});

test('a replica that cannot answer hands the read to the primary; a read the primary would refuse is not run twice', async () => {
  const set = new ReplicaSet(['r1', 'r2']);
  const tolerant = <T>(work: () => Promise<T>) => readsAs({ fresh: false }, () => lagTolerantReads(work));
  const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });
  let primary = 0;
  const onPrimary = async () => {
    primary++;
    return 'primary';
  };
  assert.equal(await tolerant(() => set.read(async () => Promise.reject(refused), onPrimary)), 'primary');
  assert.equal(primary, 1);
  assert.equal(set.healthy(0), false, 'refused: passed over');
  assert.equal(set.fellBack[0], 1);
  assert.equal(await tolerant(() => set.read(async (pool) => pool, onPrimary)), 'r2', 'the next read goes to the healthy one');
  assert.equal(set.served[1], 1);

  const syntax = Object.assign(new Error('syntax error'), { code: '42601' });
  await assert.rejects(
    tolerant(() => set.read(async () => Promise.reject(syntax), onPrimary)),
    /syntax error/,
  );
  assert.equal(primary, 1, 'a bad statement is its own answer');

  const busy = new ReplicaSet(['r']);
  assert.equal(await tolerant(() => busy.read(async () => Promise.reject(new PoolBusy('read', 'queue_full')), onPrimary)), 'primary');
  assert.equal(busy.healthy(0), true, 'a full pool is not a replica that is down');

  /* Outside lag-tolerant work no replica is asked at all. */
  let asked = false;
  assert.equal(
    await set.read(async () => {
      asked = true;
      return 'replica';
    }, onPrimary),
    'primary',
  );
  assert.equal(asked, false);
});

test('replica failures are classified by what they say about the replica', () => {
  const failure = (fields: Record<string, unknown>) => replicaFailure(Object.assign(new Error(String(fields.message ?? 'x')), fields));
  assert.equal(failure({ code: 'ECONNREFUSED' }), 'down');
  assert.equal(failure({ code: '57P01' }), 'down');
  assert.equal(failure({ code: '08006' }), 'down');
  assert.equal(failure({ code: '28P01' }), 'down', 'credentials the replica refuses');
  assert.equal(failure({ code: '3D000' }), 'down');
  assert.equal(failure({ message: 'Connection terminated unexpectedly' }), 'down');
  assert.equal(failure({ code: 'PROTOCOL_CONNECTION_LOST', fatal: true }), 'down');
  assert.equal(failure({ code: '40001', message: 'canceling statement due to conflict with recovery' }), 'retry');
  assert.equal(failure({ code: '42P01' }), 'retry', 'a migration not yet replayed');
  assert.equal(replicaFailure(new PoolBusy('read', 'queue_timeout')), 'retry');
  assert.equal(failure({ code: '40001', message: 'could not serialize access' }), undefined);
  assert.equal(failure({ code: '22P02' }), undefined);
  assert.equal(failure({ code: '25006' }), undefined, 'a write refused by a read-only session is not retried on the primary');
  assert.equal(replicaFailure(new StatementStopped('cancelled')), undefined);
  assert.equal(replicaFailure(new ReplicaUnavailable('retry', 'a member the replica has not seen yet')), 'retry');
  assert.equal(replicaFailure(new ReplicaUnavailable('down', 'its catalog did not attest')), 'down');
});

test('lists, counts, breakdowns and exports tolerate lag; a one-row read and everything else do not', () => {
  for (const path of [
    '/api/query',
    '/api/run',
    '/api/view/run',
    '/api/count',
    '/api/counts',
    '/api/breakdown',
    '/api/breakdowns',
    '/api/export',
  ])
    assert.equal(toleratesLag(path, { limit: 50 }), true, path);
  assert.equal(toleratesLag('/api/view/run', { view: { base: 'lead', limit: 1 } }), false, 'a record page row');
  assert.equal(toleratesLag('/api/query', { table: 'lead', limit: 1 }), false);
  assert.equal(toleratesLag('/api/view/run', { view: { base: 'lead', limit: 25 } }), true);
  for (const path of [
    '/api/pages/compose',
    '/api/references',
    '/api/update',
    '/api/insert',
    '/api/sql',
    '/api/commands/execute',
    '/api/record-history',
    '/api/inbox',
  ])
    assert.equal(toleratesLag(path, {}), false, path);
});

test('a connection\'s "replicas" are database URLs of its own engine, and SQLite has none', () => {
  const check = (entry: Record<string, unknown>, http = false) => replicasOf({ name: 'main', ...entry }, http, 'tablewalk.json');
  assert.equal(check({ url: 'postgres://app@primary/app' }), undefined);
  assert.deepEqual(check({ url: 'postgres://app@primary/app', replicas: [' postgres://app@r1/app', 'postgresql://app@r2/app'] }), [
    'postgres://app@r1/app',
    'postgresql://app@r2/app',
  ]);
  /* A reference is checked once it resolves (Registry.dial). */
  assert.deepEqual(check({ url: '${DATABASE_URL}', replicas: ['${REPLICA_URL}'] }), ['${REPLICA_URL}']);
  assert.throws(() => check({ url: './shop.db', replicas: ['./copy.db'] }), /SQLite has no replicas/);
  assert.throws(() => check({ url: 'postgres://app@primary/app', replicas: ['mongodb://app@r1/app'] }), /not a PostgreSQL URL/);
  assert.throws(() => check({ url: 'postgres://p/app', replicas: [] }), /list of database URLs/);
  assert.throws(() => check({ url: 'postgres://p/app', replicas: 'postgres://r/app' }), /list of database URLs/);
  assert.throws(() => check({ url: 'postgres://p/app', replicas: ['postgres://r/app', 'postgres://r/app'] }), /twice/);
  assert.throws(
    () => check({ url: 'postgres://p/app', replicas: Array.from({ length: MAX_REPLICAS + 1 }, (_, i) => `postgres://r${i}/app`) }),
    /at most/,
  );
  assert.throws(() => check({ url: 'https://api.example.com', replicas: ['https://b.example.com'] }, true), /HTTP connection/);
  assert.throws(() => connect('./shop.db', { replicas: ['./copy.db'] }), /SQLite has no replicas/);
  assert.throws(() => connect('postgres://app@primary/app', { replicas: ['mongodb://app@r1/app'] }), /postgres:\/\/… URLs/);
});
