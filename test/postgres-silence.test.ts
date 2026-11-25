/**
 * A PostgreSQL connection whose server stops answering is closed by this process, not waited out
 * (adapters/postgresSilence.ts). A field report: a hosted database's network dropped two connections without a reset
 * during one seed, and each command sat about 16 minutes until the kernel gave up retransmitting.
 *
 * The watch is of silence under a waiting statement, so these hold both halves: a connection that hears nothing is
 * destroyed with ETIMEDOUT within the window and the pool dials another, and one that is idle, or still hearing its
 * server, is left alone however long it lasts. Every socket also asks for keepalive ten seconds into a quiet spell.
 *
 * The live half relays a real server (`TABLEWALK_TEST_PG`) through a socket this file can mute; it creates nothing
 * in the database.
 */
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createConnection, createServer, type Socket } from 'node:net';
import { describe, test } from 'node:test';
import { sealedPgOptions } from '../packages/engine/src/adapters/net/untrustedDatabase.js';
import { PgConnectionManager, type PgPool, type PgPoolOptions, type PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { watchSilence } from '../packages/engine/src/adapters/postgresSilence.js';
import { KEEPALIVE_IDLE_MS, pgConnectionOptions } from '../packages/engine/src/adapters/postgresValues.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeStream extends EventEmitter {
  bytesWritten = 0;
  destroyed = false;
  failure?: Error & { code?: string };
  destroy(error?: Error) {
    this.destroyed = true;
    this.failure = error;
    this.emit('close');
  }
}
const fake = () => {
  const stream = new FakeStream();
  const client = { connection: { stream }, active: false, _getActiveQuery: () => (client.active ? {} : null) };
  return { stream, client };
};

test('every socket asks for keepalive ten seconds into a quiet spell, a sealed one too', () => {
  assert.equal(KEEPALIVE_IDLE_MS, 10_000);
  for (const url of ['postgres://u:p@h/db', 'postgres://h/db?sslrootcert=system', 'postgres://h/db?sslmode=disable&sslrootcert=system']) {
    const options = pgConnectionOptions(url);
    assert.equal(options.keepAlive, true);
    assert.equal(options.keepAliveInitialDelayMillis, 10_000);
  }
  const sealed = sealedPgOptions('postgres://u:p@db.example.com/app', { allow: () => true } as never) as Record<string, unknown>;
  assert.equal(sealed.keepAlive, true);
  assert.equal(sealed.keepAliveInitialDelayMillis, 10_000);
});

test('a statement waiting on a silent server closes the connection with ETIMEDOUT; an idle or answering one stays', async () => {
  // Idle: nothing waits, so silence is not a fault however long.
  const idle = fake();
  assert.equal(watchSilence(idle.client as unknown as PgQuery, 200), true);
  await wait(450);
  assert.equal(idle.stream.destroyed, false);
  // A statement is sent and nothing comes back.
  idle.client.active = true;
  idle.stream.bytesWritten += 40;
  await wait(120);
  assert.equal(idle.stream.destroyed, false, 'not before the window');
  await wait(400);
  assert.equal(idle.stream.destroyed, true);
  assert.equal(idle.stream.failure?.code, 'ETIMEDOUT');
  assert.match(idle.stream.failure!.message, /^Connection terminated: the server said nothing for 200 ms/);

  // A server still answering (rows arriving, a pipelined batch answered statement by statement) is never silent.
  const busy = fake();
  watchSilence(busy.client as unknown as PgQuery, 200);
  busy.client.active = true;
  const rows = setInterval(() => busy.stream.emit('data'), 60);
  await wait(700);
  clearInterval(rows);
  assert.equal(busy.stream.destroyed, false);
  // And one still being written to (a large statement leaving) is not silent either.
  const sending = setInterval(() => (busy.stream.bytesWritten += 1), 60);
  await wait(500);
  clearInterval(sending);
  assert.equal(busy.stream.destroyed, false);
  busy.stream.destroy();

  // A client that does not show its socket and its statement as node-postgres does keeps the kernel's wait.
  assert.equal(watchSilence({ query: async () => ({}) } as unknown as PgQuery, 200), false);
});

test('a pool opens within ten seconds and waits the statement cap and half a minute on silence, unless its connection says', async () => {
  const made: PgPoolOptions[] = [];
  const pg = {
    Pool: function Pool(options: PgPoolOptions) {
      made.push(options);
      return Object.assign(new EventEmitter(), { options, end: async () => {} });
    },
  };
  const open = async (options: Record<string, number>) => {
    const manager = new PgConnectionManager(
      'postgres://fake',
      () => {},
      async () => pg,
      options,
    );
    try {
      await (manager as unknown as Record<string, (role: string) => Promise<PgPool>>).createPool('read');
      return { connect: made.at(-1)!.connectionTimeoutMillis, silence: (manager as unknown as { silenceMs: number }).silenceMs };
    } finally {
      await manager.close();
    }
  };
  assert.deepEqual(await open({}), { connect: 10_000, silence: 60_000 });
  assert.equal(made.at(-1)!.keepAliveInitialDelayMillis, 10_000);
  assert.deepEqual(await open({ connectTimeoutMs: 3_000, queryTimeoutMs: 8_000 }), { connect: 3_000, silence: 8_000 });
  for (const bad of [{ connectTimeoutMs: 999 }, { connectTimeoutMs: 120_001 }, { queryTimeoutMs: 0 }, { queryTimeoutMs: 1.5 }])
    assert.throws(
      () =>
        new PgConnectionManager(
          'postgres://fake',
          () => {},
          async () => pg,
          bad,
        ),
      RangeError,
    );
});

describe('a live server that stops answering', { skip: liveSkip('postgres', LIVE) }, () => {
  test('fails the statement within the window, and the next one is answered on a new connection', { timeout: 30_000 }, async () => {
    /* A relay that can go mute: sockets stay open and nothing crosses, which is what a dropped route looks like from
       either end. */
    const target = new URL(LIVE!);
    let muted = false;
    const sockets = new Set<Socket>();
    const relay = createServer((near) => {
      const far = createConnection({ host: target.hostname, port: Number(target.port || 5432) });
      for (const socket of [near, far]) {
        sockets.add(socket);
        socket.on('error', () => {});
        socket.on('close', () => sockets.delete(socket));
      }
      near.on('data', (chunk) => muted || far.write(chunk));
      far.on('data', (chunk) => muted || near.write(chunk));
      near.on('close', () => far.destroy());
      far.on('close', () => near.destroy());
    });
    relay.listen(0, '127.0.0.1');
    await once(relay, 'listening');
    const through = new URL(LIVE!);
    through.hostname = '127.0.0.1';
    through.port = String((relay.address() as { port: number }).port);
    const manager = new PgConnectionManager(through.href, undefined, undefined, { readers: 1, queryTimeoutMs: 1_000 });
    const one = () => manager.withReadClient(async (client) => (await client.query('SELECT 1 AS one')).rows[0]);
    try {
      assert.deepEqual(await one(), { one: 1 });
      // Quiet for longer than the window with nothing asked: the connection is kept.
      await wait(1_600);
      assert.deepEqual(await one(), { one: 1 });
      muted = true;
      const started = performance.now();
      await assert.rejects(one(), (error: unknown) => {
        const text = JSON.stringify(error, Object.getOwnPropertyNames(error as object));
        assert.match(text, /ETIMEDOUT|Connection terminated/);
        return true;
      });
      const took = performance.now() - started;
      assert.ok(took >= 900 && took < 5_000, `closed after ${Math.round(took)} ms`);
      muted = false;
      assert.deepEqual(await one(), { one: 1 });
    } finally {
      await manager.close();
      for (const socket of sockets) socket.destroy();
      relay.close();
    }
  });
});
