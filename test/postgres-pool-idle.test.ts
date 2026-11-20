/**
 * What each PostgreSQL pool role is given to keep through a quiet spell. A field report: the first command after
 * half a minute of quiet reconnected, about 230 ms on a hosted database. Idle connections now stay five minutes,
 * readers keep two warm and the writer one; every role lets an idle connection go when the process is done, so a
 * one-shot mode that forgets to close still exits.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { PgConnectionManager, type PgPool, type PgPoolOptions } from '../packages/engine/src/adapters/postgresPool.js';
import { configureWriteOrder } from '../packages/engine/src/adapters/writeLanes.js';

class FakePool extends EventEmitter {
  constructor(readonly options: PgPoolOptions) {
    super();
  }
  totalCount = 0;
  idleCount = 0;
  waitingCount = 0;
  async end(): Promise<void> {}
}

async function optionsFor(sizes: { readers: number; writers: number }): Promise<Record<'read' | 'write' | 'background', PgPoolOptions>> {
  const made: PgPoolOptions[] = [];
  const pg = {
    Pool: function Pool(options: PgPoolOptions) {
      made.push(options);
      return new FakePool(options);
    },
  };
  configureWriteOrder('keyed');
  const manager = new PgConnectionManager(
    'postgres://fake',
    () => {},
    async () => pg,
    sizes,
  );
  try {
    const create = (role: string) => (manager as unknown as Record<string, (role: string) => Promise<PgPool>>).createPool(role);
    const pools = { read: await create('read'), write: await create('write'), background: await create('background') };
    return Object.fromEntries(Object.entries(pools).map(([role, pool]) => [role, (pool as unknown as FakePool).options])) as Record<
      'read' | 'write' | 'background',
      PgPoolOptions
    >;
  } finally {
    configureWriteOrder('serial');
    await manager.close();
  }
}

test('idle connections stay five minutes; readers keep two warm, the writer one, the background writer none; none holds the process open', async () => {
  const { read, write, background } = await optionsFor({ readers: 6, writers: 4 });
  for (const options of [read, write, background]) {
    assert.equal(options.idleTimeoutMillis, 300_000);
    assert.equal(options.allowExitOnIdle, true);
  }
  assert.equal(read.min, 2);
  assert.equal(write.min, 1);
  assert.equal(background.min, undefined);
});

test('a warm minimum never exceeds the pool', async () => {
  const { read, write } = await optionsFor({ readers: 1, writers: 1 });
  assert.equal(read.min, 1);
  assert.equal(write.min, 1);
});
