/**
 * A command's `datetime` input, stored: whatever offset a moment is sent in,
 * the handler receives the UTC instant, and a column keeps that moment — as
 * ISO text in SQLite, and in PostgreSQL's `timestamptz` (the moment itself)
 * and `timestamp` (the UTC wall time, as `'now'` stamps one). A time with no
 * zone is refused before the handler runs.
 *
 * PostgreSQL is live and opt-in like postgres.test.ts (`TABLEWALK_TEST_PG`,
 * and `TABLEWALK_REQUIRE_LIVE=1` to fail rather than skip); it drops and
 * recreates its own tables in `public` of the database it is pointed at.
 */
import { runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { COMMAND_JOURNAL_TABLES as tables, migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { bindBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { executeBusinessCommand } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { field } from '../packages/mistri/src/server/commands/commandFields.js';
import { defineCommand, defineCommands, type BusinessCommandActor } from '../packages/mistri/src/server/commands/businessCommands.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { liveSkip } from './live.js';
import { parseTestApp } from './support/commandCatalog.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const actor: BusinessCommandActor = { id: 'account-a', appId: 'clinic', roles: ['clerk'] };
const input = { at: field.datetime(), until: field.datetime({ above: 'at', optional: true }) };

/** The command over a `visit` table on one connection: what the handler received, and a run of the command. */
async function harness(registry: Registry, connection: string) {
  const app = parseTestApp(
    {
      id: 'clinic',
      name: 'Clinic',
      sources: { clinic: { connection } },
      resources: { visit: { access: 'write' } },
      auth: { roles: { clerk: { read: true, commands: ['book'] } } },
      views: { visits: { kind: 'list', from: 'visit' } },
      home: 'visits',
    },
    'datetime fixture',
  );
  const received: unknown[] = [];
  const commands = defineCommands({
    book: defineCommand({
      source: 'clinic',
      target: 'visit',
      input,
      output: { parse: (value: unknown) => value as { ok: true } },
      async handle({ db, record }, values) {
        received.push({ ...values });
        await db.visit.update(record!, { at: values.at, ...(values.until ? { until: values.until } : {}) });
        return { ok: true as const };
      },
    }),
  });
  const resources = await loadAppRuntimeResources(registry, app, connection);
  const binding = bindBusinessCommands({ app, resources, registry: commands, writableConnection: () => true });
  let version = 0;
  const book = async (values: Record<string, unknown>) => {
    const result = await executeBusinessCommand(
      binding,
      actor,
      {
        command: 'book',
        commandVersion: 1,
        key: { id: 1 },
        expectedVersion: version,
        input: values,
        idempotencyKey: `book-request-${String(version).padStart(6, '0')}`,
      },
      { door: 'ui' },
    );
    version++;
    return result;
  };
  return { received, book };
}

const refusedAs = (reason: string) => (error: unknown) => {
  assert.match(JSON.stringify(error, Object.getOwnPropertyNames(error)), new RegExp(`"(?:reason|code)":"(?:${reason})"`));
  return true;
};

test('SQLite keeps the UTC instant a datetime input hands over, whatever offset it was sent in', { timeout: 10_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-command-datetime-'));
  const path = join(directory, 'clinic.db');
  const db = new DatabaseSync(path);
  const registry = new Registry();
  try {
    db.exec(`CREATE TABLE visit (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, at TEXT, until TEXT);
      INSERT INTO visit VALUES (1, 0, NULL, NULL);`);
    migrateSqliteCommandJournal(path);
    registry.add({ id: 'clinic-db', name: 'clinic', url: path, writable: true, source: 'config' });
    const { received, book } = await harness(registry, 'clinic-db');
    await book({ at: '2026-10-12T09:30:00-04:00', until: '2026-10-12 15:00Z' });
    assert.deepEqual(received, [{ at: '2026-10-12T13:30:00.000Z', until: '2026-10-12T15:00:00.000Z' }]);
    assert.deepEqual(
      { ...db.prepare('SELECT at, until FROM visit WHERE id = 1').get() },
      {
        at: '2026-10-12T13:30:00.000Z',
        until: '2026-10-12T15:00:00.000Z',
      },
    );
    await assert.rejects(book({ at: '2026-10-12T09:30' }), refusedAs('type|invalid_input'));
    await assert.rejects(book({ at: '2026-10-12T09:30Z', until: '2026-10-12T05:00-04:00' }), refusedAs('not_above|invalid_input'));
    assert.equal(received.length, 1, 'a refused moment never reaches the handler');
  } finally {
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

interface Control extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}

describe('PostgreSQL keeps it in timestamptz and timestamp', { skip: liveSkip('postgres', LIVE) }, () => {
  test('timestamptz holds the moment; timestamp holds its UTC wall time', { timeout: 20_000 }, async () => {
    const specifier = 'pg';
    const pg = (await import(specifier)) as { default?: { Client: new (c: unknown) => Control }; Client?: new (c: unknown) => Control };
    const control = new (pg.Client ?? pg.default!.Client)({ connectionString: LIVE });
    await control.connect();
    const reset = [
      `DROP TABLE IF EXISTS public.visit CASCADE`,
      `DROP TABLE IF EXISTS ${runtimeTable('postgres', tables.receipt)}, ${runtimeTable('postgres', tables.meta)} CASCADE`,
    ];
    const registry = new Registry();
    try {
      for (const statement of reset) await control.query(statement);
      await control.query(
        `CREATE TABLE public.visit (id integer PRIMARY KEY, version integer NOT NULL DEFAULT 0, at timestamptz, until timestamp)`,
      );
      await control.query(`INSERT INTO public.visit (id) VALUES (1)`);
      await migratePostgresCommandJournal(LIVE!);
      registry.add({ id: 'clinic-pg', name: 'clinic', url: LIVE!, writable: true, source: 'config' });
      const { received, book } = await harness(registry, 'clinic-pg');
      await book({ at: '2026-10-12 19:16:00-04', until: '2026-10-13T01:00+01:00' });
      assert.deepEqual(received, [{ at: '2026-10-12T23:16:00.000Z', until: '2026-10-13T00:00:00.000Z' }]);
      // Read back from a session in another zone: the moment is the same one, and the plain timestamp its UTC wall time.
      await control.query(`SET TIME ZONE 'Asia/Kolkata'`);
      const stored = await control.query(
        `SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS at, to_char(until, 'YYYY-MM-DD"T"HH24:MI:SS') AS until FROM public.visit WHERE id = 1`,
      );
      assert.deepEqual(stored.rows[0], { at: '2026-10-12T23:16:00', until: '2026-10-13T00:00:00' });
      await assert.rejects(book({ at: '2026-10-12 19:16:00' }), refusedAs('type|invalid_input'));
      assert.equal(received.length, 1);
    } finally {
      await registry.closeAll();
      for (const statement of reset) await control.query(statement).catch(() => {});
      await control.end();
    }
  });
});
