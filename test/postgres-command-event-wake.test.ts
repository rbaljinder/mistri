/**
 * The cross-process wake, against a live PostgreSQL: a listener hears a
 * command-fact notification only when the writing transaction commits, and
 * one whose connection is ended under it connects again and looks once.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COMMAND_EVENT_CHANNEL,
  listenForCommandEvents,
  NOTIFY_COMMAND_EVENTS,
} from '../packages/mistri/src/adapters/events/postgresCommandEventWake.js';
import { liveSkip } from './live.js';
import { LIVE_PG, ownedPostgresDatabase } from './support/jobStoreEngines.js';

interface Client {
  connect(): Promise<void>;
  query(text: string): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}
async function client(url: string): Promise<Client> {
  const specifier = 'pg';
  const pg = (await import(specifier)) as { default: { Client: new (options: unknown) => Client } };
  const made = new pg.default.Client({ connectionString: url });
  await made.connect();
  return made;
}
const until = async (check: () => boolean | Promise<boolean>, what: string, ms = 8_000) => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, what);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test(
  'a command-fact notification is heard at commit, never for a rollback, and across a lost connection',
  { skip: liveSkip('postgres', LIVE_PG) },
  async () => {
    const url = await ownedPostgresDatabase();
    let woken = 0;
    const listener = await listenForCommandEvents(url, () => {
      woken++;
    });
    const writer = await client(url);
    try {
      await writer.query('BEGIN');
      await writer.query(NOTIFY_COMMAND_EVENTS);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(woken, 0, 'nothing is heard while the transaction is open');
      await writer.query('ROLLBACK');
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(woken, 0, 'a rolled-back fact is never announced');
      await writer.query('BEGIN');
      await writer.query(NOTIFY_COMMAND_EVENTS);
      await writer.query('COMMIT');
      await until(() => woken === 1, 'the commit is heard');

      // The listening backend is ended under it: it looks once, then listens again.
      await writer.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = current_database() AND query = 'LISTEN ${COMMAND_EVENT_CHANNEL}'`);
      await until(() => woken === 2, 'a lost listener looks once');
      await until(
        async () =>
          (
            await writer.query(`SELECT 1 FROM pg_stat_activity
      WHERE datname = current_database() AND query = 'LISTEN ${COMMAND_EVENT_CHANNEL}'`)
          ).rows.length === 1,
        'it listens again',
        12_000,
      );
      await writer.query(NOTIFY_COMMAND_EVENTS);
      await until(() => woken === 3, 'and hears the next fact');
    } finally {
      await writer.end();
      await listener.close();
    }
  },
);
