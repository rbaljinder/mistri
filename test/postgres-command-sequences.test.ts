/**
 * The command sequence store on PostgreSQL (postgresCommandSequences.ts):
 * provisioned by the journal migration beside a journal that predates it,
 * attested against its pinned catalog description, and advanced in the
 * command's transaction — a second transaction asking for the same sequence
 * waits for the first, and takes the next number or, after a rollback, the
 * same one. Each test owns a fresh database beside TABLEWALK_TEST_PG (the
 * role needs CREATEDB) and drops it afterwards.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import type { CommandJournalTenant } from '../packages/mistri/src/adapters/commands/commandJournalTypes.js';
import {
  COMMAND_SEQUENCE_META_TABLE,
  COMMAND_SEQUENCE_TABLE,
  CommandSequenceUnavailable,
  handlerNextNumber,
} from '../packages/mistri/src/adapters/commands/commandSequences.js';
import {
  createPostgresCommandJournal,
  migratePostgresCommandJournal,
} from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
interface Client extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}

async function database(t: TestContext) {
  const module = 'pg';
  const pg = (await import(module)) as { default: { Client: new (options: unknown) => Client } };
  const control = new pg.default.Client({ connectionString: LIVE, statement_timeout: 10000 });
  await control.connect();
  const name = `tw_sequences_${randomUUID().replaceAll('-', '')}`;
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) await client.end().catch(() => {});
    await control.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await control.end();
  });
  await control.query(`CREATE DATABASE "${name}"`);
  const url = new URL(LIVE!);
  url.pathname = `/${name}`;
  const connect = async () => {
    const client = new pg.default.Client({ connectionString: url.href, statement_timeout: 10000 });
    await client.connect();
    clients.push(client);
    return client;
  };
  return { url: url.href, connect };
}

const tenant = (tenantId: string): CommandJournalTenant => ({
  appId: 'desk',
  storeId: 'store',
  sourceId: 'business',
  tenantId,
  actorId: 'alice',
  membershipId: `${tenantId}-alice`,
  membershipVersion: '1',
  tenantVersion: '1',
  roles: ['sales'],
  deployment: 'one',
});

/** One number in its own transaction; `hold` keeps the transaction open until it settles, and `fail` rolls it back. */
async function take(
  client: Client,
  options: { owner?: CommandJournalTenant; per?: number; after?: number; hold?: Promise<void>; fail?: boolean } = {},
) {
  const operations = new TransactionOperations();
  await client.query('BEGIN');
  try {
    const number = await handlerNextNumber(createPostgresCommandJournal(client, operations, options.owner), 'desk')('lead', {
      per: options.per ?? 1,
      start: 1001,
      ...(options.after === undefined ? {} : { after: options.after }),
    });
    await options.hold;
    await operations.finish();
    if (options.fail) throw new Error('refused');
    await client.query('COMMIT');
    return number;
  } catch (error) {
    await operations.finish().catch(() => {});
    await client.query('ROLLBACK');
    throw error;
  }
}

test(
  'the journal migration provisions the sequence store on PostgreSQL, and adds it where a journal predates it',
  { skip: liveSkip('postgres', LIVE), timeout: 60_000 },
  async (t) => {
    const { url, connect } = await database(t);
    assert.deepEqual(await migratePostgresCommandJournal(url), { version: 1, migrated: true });
    assert.deepEqual(await migratePostgresCommandJournal(url), { version: 1, migrated: false });
    const client = await connect();
    // A journal that predates the store has neither relation.
    await client.query(
      `DROP TABLE ${runtimeTable('postgres', COMMAND_SEQUENCE_TABLE)}, ${runtimeTable('postgres', COMMAND_SEQUENCE_META_TABLE)}`,
    );
    await assert.rejects(take(client), CommandSequenceUnavailable);
    assert.deepEqual(await migratePostgresCommandJournal(url), { version: 1, migrated: true });
    assert.deepEqual([await take(client), await take(client), await take(client, { per: 2 })], [1001, 1002, 1001]);
    assert.deepEqual([await take(client, { owner: tenant('north') }), await take(client, { owner: tenant('south') })], [1001, 1001]);
    // A foreign layout is refused and left as it is.
    await client.query(`ALTER TABLE ${runtimeTable('postgres', COMMAND_SEQUENCE_TABLE)} ADD COLUMN note text`);
    await assert.rejects(take(client), CommandSequenceUnavailable);
    await assert.rejects(migratePostgresCommandJournal(url), CommandSequenceUnavailable);
  },
);

test(
  'two commands asking for one sequence queue: the second takes the next number, or the same one after a rollback',
  { skip: liveSkip('postgres', LIVE), timeout: 60_000 },
  async (t) => {
    const { url, connect } = await database(t);
    await migratePostgresCommandJournal(url);
    const [first, second] = [await connect(), await connect()];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const committing = take(first, { hold: held });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const waiting = take(second);
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    assert.deepEqual([await committing, await waiting], [1001, 1002]);
    let undo!: () => void;
    const undone = new Promise<void>((resolve) => {
      undo = resolve;
    });
    const failing = take(first, { hold: undone, fail: true });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const after = take(second);
    await new Promise((resolve) => setTimeout(resolve, 200));
    undo();
    await assert.rejects(failing, /refused/);
    assert.equal(await after, 1003);
  },
);

test(
  'rows a seed wrote are numbered past on PostgreSQL, and two commands that read the same highest still take two numbers',
  { skip: liveSkip('postgres', LIVE), timeout: 60_000 },
  async (t) => {
    const { url, connect } = await database(t);
    await migratePostgresCommandJournal(url);
    const [first, second] = [await connect(), await connect()];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Both read SR-1040 as the highest before either takes a number.
    const committing = take(first, { after: 1040, hold: held });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const waiting = take(second, { after: 1040 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    assert.deepEqual([await committing, await waiting], [1041, 1042]);
    // A floor below the count changes nothing.
    assert.equal(await take(first, { after: 3 }), 1043);
  },
);
