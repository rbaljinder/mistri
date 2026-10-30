/**
 * A read snapshot that ends itself, against a live PostgreSQL (TABLEWALK_TEST_PG).
 *
 * readSnapshot's `whole` sends BEGIN, the owner's question and COMMIT in one
 * message, and `finish` sends a snapshot's COMMIT with a fresh snapshot of its
 * own behind it: the tenant reader's membership fences ride them
 * (tenantReadSource.ts), one round trip where each was two or three. What has
 * to hold: each is one flight on the wire and no COMMIT follows it; the fresh
 * snapshot sees what committed after the first began, which the first does
 * not; and nothing can be asked of a snapshot once it has ended.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { PgConnectionManager } from '../packages/engine/src/adapters/postgresPool.js';
import { startLatencyProxy } from '../e2e/support/latencyProxy.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const skip = liveSkip('postgres', LIVE);

test('a whole snapshot is one flight, and its owner can ask nothing more of it', { skip }, async () => {
  const proxy = await startLatencyProxy(LIVE!, 5);
  const adapter = new PostgresAdapter(proxy.route(LIVE!), 'whole probe', [], undefined, { pipelineReads: true });
  try {
    const since = Date.now();
    const answered = await adapter.readSnapshot(
      async (lease) => {
        assert.equal(lease.finish, undefined, 'a whole snapshot has nothing left to finish');
        await assert.rejects(lease.client.query('SELECT 1'), /unavailable/);
        await assert.rejects(lease.execute({ text: 'SELECT 1', params: [] }), /unavailable/);
        return lease.prologue!.map((result) => result.rows[0]);
      },
      false,
      'SELECT 41 + 1 AS whole_probe',
      false,
      true,
    );
    assert.deepEqual(answered, [{ whole_probe: 42 }]);
    await new Promise((done) => setTimeout(done, 30));
    // On the snapshot's connection, from its BEGIN: a reader's session settings, sent as it opened, are not the snapshot's.
    const all = proxy.statements(since),
      begun = all.find((statement) => statement.text.includes('whole_probe'))!;
    const sent = all.filter((statement) => statement.connection === begun.connection && statement.flight >= begun.flight);
    assert.equal(new Set(sent.map((statement) => statement.flight)).size, 1, JSON.stringify(sent));
    assert.match(sent[0]!.text, /^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT 41 \+ 1 AS whole_probe; COMMIT$/);
  } finally {
    await adapter.close();
    await proxy.close();
  }
});

test('finish commits the snapshot and answers from a fresh one, in one flight', { skip }, async () => {
  const proxy = await startLatencyProxy(LIVE!, 5);
  const adapter = new PostgresAdapter(proxy.route(LIVE!), 'finish probe', [], undefined, { pipelineReads: true });
  const writer = new PgConnectionManager(LIVE!);
  const table = `finish_probe_${randomUUID().replaceAll('-', '')}`;
  await writer.withWriteClient(async (client) => {
    await client.query(`CREATE TABLE public.${table} (id int PRIMARY KEY)`);
    await client.query(`INSERT INTO public.${table} VALUES (1)`);
  });
  try {
    let since = 0;
    const counts = await adapter.readSnapshot(async (lease) => {
      const before = (await lease.execute({ text: `SELECT count(*)::int AS n FROM public.${table}`, params: [] })).rows[0]!.n;
      // Committed after this snapshot began: it does not see it, the fresh one does.
      await writer.withWriteClient((client) => client.query(`INSERT INTO public.${table} VALUES (2)`));
      const held = (await lease.execute({ text: `SELECT count(*)::int AS n FROM public.${table}`, params: [] })).rows[0]!.n;
      since = Date.now();
      const fresh = await lease.finish!(`SELECT 'fresh' AS finish_probe; SELECT count(*)::int AS n FROM public.${table}`);
      await assert.rejects(lease.execute({ text: 'SELECT 1', params: [] }), /unavailable/);
      // Nor its client: a statement asked now would run outside any transaction.
      await assert.rejects(lease.client.query('SELECT 1'), /unavailable/);
      await assert.rejects(lease.finish!('SELECT 1'), /unavailable/);
      return [before, held, fresh.length, fresh[0]!.rows[0]!.finish_probe, fresh[1]!.rows[0]!.n];
    });
    assert.deepEqual(counts, [1, 1, 2, 'fresh', 2]);
    await new Promise((done) => setTimeout(done, 30));
    const sent = proxy.statements(since);
    assert.equal(new Set(sent.map((statement) => `${statement.connection}:${statement.flight}`)).size, 1, JSON.stringify(sent));
    assert.match(sent[0]!.text, /^COMMIT; BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT 'fresh'.*; COMMIT$/s);
    // The reader went back to the pool idle, and serves the next snapshot.
    assert.equal(await adapter.readSnapshot(async (lease) => (await lease.execute({ text: 'SELECT 3 AS n', params: [] })).rows[0]!.n), 3);
  } finally {
    await writer.withWriteClient((client) => client.query(`DROP TABLE IF EXISTS public.${table}`));
    await writer.close();
    await adapter.close();
    await proxy.close();
  }
});
