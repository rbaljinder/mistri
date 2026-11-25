/**
 * A handler's `db.<table>.where` reads the same rows on SQLite and PostgreSQL, through a command's own transaction
 * (executeBusinessCommand), not a handle over a raw adapter:
 *
 * - a path through a reference (`'coverage_id.payer_name': payer`), alone and beside an operator (a tenant App's
 *   command, where PostgreSQL refused it, is held in tenant-command-aggregates.test.ts);
 * - a list of more values than the language allows OR branches (`{ id: ids }` beside an operator, which is read
 *   through the language): it was written as one `=` per value joined by `or`, and refused past 64 on both engines
 *   while the same list alone was read.
 *
 * PostgreSQL is live and opt-in (`TABLEWALK_TEST_PG`, `TABLEWALK_REQUIRE_LIVE=1` to fail rather than skip); it drops
 * and recreates its own tables in `public` of the database it is pointed at.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { COMMAND_JOURNAL_TABLES as tables, migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { bindBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { executeBusinessCommand } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { defineCommand, defineCommands, type BusinessCommandActor } from '../packages/mistri/src/server/commands/businessCommands.js';
import { field } from '../packages/mistri/src/server/commands/commandFields.js';
import { refusalReasons } from '../packages/engine/src/shared/refusal.js';
import { liveSkip } from './live.js';
import { parseTestApp } from './support/commandCatalog.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const actor: BusinessCommandActor = { id: 'account-a', appId: 'billing', roles: ['clerk'] };
/* 150 claims, every third on the second plan: more ids than the language's 64 OR branches. */
const CLAIMS = 150;
const everyId = Array.from({ length: CLAIMS }, (_, index) => index + 1);
const ids = (rows: readonly Record<string, unknown>[]) => rows.map((row) => Number(row.id)).sort((a, b) => a - b);

async function harness(registry: Registry, connection: string) {
  const app = parseTestApp(
    {
      id: 'billing',
      name: 'Billing',
      sources: { billing: { connection } },
      resources: { claim: { access: 'write' }, coverage: {} },
      auth: { roles: { clerk: { read: true, commands: ['draft'] } } },
      views: { claims: { kind: 'list', from: 'claim' } },
      home: 'claims',
    },
    'where engines fixture',
  );
  const commands = defineCommands({
    draft: defineCommand({
      source: 'billing',
      target: 'claim',
      read: ['coverage'],
      input: { payer: field.text() },
      output: { parse: (value: unknown) => value as Record<string, number[] | number> },
      async handle({ db }, values) {
        return {
          path: ids(await db.claim.where({ 'coverage_id.payer_name': values.payer })),
          pathBesideOperator: ids(await db.claim.where({ 'coverage_id.payer_name': values.payer, amount: { gte: 100 } })),
          plain: (await db.claim.where({ id: everyId })).length,
          besideOperator: (await db.claim.where({ id: everyId, amount: { gte: 0 } })).length,
          texts: (await db.claim.where({ note: everyId.map((id) => `n ${id}`), amount: { gte: 0 } })).length,
          counted: await db.claim.count({ id: everyId, amount: { lt: 100 } }),
          besideNot: (await db.claim.where({ id: everyId.slice(0, 100), amount: { not: [0, 1] } })).length,
        };
      },
    }),
  });
  const resources = await loadAppRuntimeResources(registry, app, connection);
  const binding = bindBusinessCommands({ app, resources, registry: commands, writableConnection: () => true });
  let asked = 0;
  return (command: string, input: Record<string, unknown>) =>
    executeBusinessCommand(
      binding,
      actor,
      {
        command,
        commandVersion: 1,
        key: { id: 1 },
        expectedVersion: 0,
        input,
        idempotencyKey: `where-engines-${String(asked++).padStart(6, '0')}`,
      },
      { door: 'ui' },
    ).catch((error: unknown) => {
      /* What the owner is told of a refusal, beside what the caller is: a failure here names its cause. */
      throw Object.assign(error as Error, { told: refusalReasons(error) });
    });
}

async function proofs(run: Awaited<ReturnType<typeof harness>>) {
  const drafted = (await run('draft', { payer: 'Acme Health' })) as { result: Record<string, unknown> };
  const second = everyId.filter((id) => id % 3 === 0);
  assert.deepEqual(drafted.result, {
    path: second,
    pathBesideOperator: second.filter((id) => id >= 100),
    plain: CLAIMS,
    besideOperator: CLAIMS,
    texts: CLAIMS,
    counted: 99,
    besideNot: 99,
  });
}

test('SQLite: a path, a long list beside an operator in a command', { timeout: 20_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-command-where-'));
  const path = join(directory, 'billing.db');
  const db = new DatabaseSync(path);
  const registry = new Registry();
  try {
    db.exec(`CREATE TABLE coverage (id INTEGER PRIMARY KEY, payer_name TEXT NOT NULL);
      CREATE TABLE claim (id INTEGER PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0, coverage_id INTEGER NOT NULL REFERENCES coverage (id),
        amount INTEGER NOT NULL, note TEXT NOT NULL);
      INSERT INTO coverage VALUES (1, 'Borealis'), (2, 'Acme Health');`);
    const insert = db.prepare('INSERT INTO claim (id, coverage_id, amount, note) VALUES (?, ?, ?, ?)');
    for (const id of everyId) insert.run(id, id % 3 === 0 ? 2 : 1, id, `n ${id}`);
    migrateSqliteCommandJournal(path);
    registry.add({ id: 'billing-db', name: 'billing', url: path, writable: true, source: 'config' });
    await proofs(await harness(registry, 'billing-db'));
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

describe('PostgreSQL reads the same wheres', { skip: liveSkip('postgres', LIVE) }, () => {
  test('a path, a long list beside an operator in a command', { timeout: 30_000 }, async () => {
    const specifier = 'pg';
    const pg = (await import(specifier)) as { default?: { Client: new (c: unknown) => Control }; Client?: new (c: unknown) => Control };
    const control = new (pg.Client ?? pg.default!.Client)({ connectionString: LIVE });
    await control.connect();
    const reset = [
      `DROP TABLE IF EXISTS public.claim, public.coverage CASCADE`,
      `DROP TABLE IF EXISTS ${Object.values(tables)
        .map((table) => runtimeTable('postgres', table))
        .join(', ')} CASCADE`,
    ];
    const registry = new Registry();
    try {
      for (const statement of reset) await control.query(statement);
      await control.query(`CREATE TABLE public.coverage (id integer PRIMARY KEY, payer_name text NOT NULL)`);
      await control.query(
        `CREATE TABLE public.claim (id integer PRIMARY KEY, version integer NOT NULL DEFAULT 0, coverage_id integer NOT NULL REFERENCES public.coverage (id),
          amount integer NOT NULL, note text NOT NULL)`,
      );
      await control.query(`INSERT INTO public.coverage VALUES (1, 'Borealis'), (2, 'Acme Health')`);
      await control.query(
        `INSERT INTO public.claim (id, coverage_id, amount, note) SELECT n, CASE WHEN n % 3 = 0 THEN 2 ELSE 1 END, n, 'n ' || n FROM generate_series(1, ${CLAIMS}) AS n`,
      );
      await migratePostgresCommandJournal(LIVE!);
      registry.add({ id: 'billing-pg', name: 'billing', url: LIVE!, writable: true, source: 'config' });
      await proofs(await harness(registry, 'billing-pg'));
    } finally {
      await registry.closeAll();
      for (const statement of reset) await control.query(statement).catch(() => {});
      await control.end();
    }
  });
});
