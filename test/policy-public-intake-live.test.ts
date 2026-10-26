/** Live PostgreSQL proof for the private fixed public-intake binding.
 *
 * Each case owns a UUID database so its public-schema journal is isolated too.
 * Cleanup drops only that database, and the test is opt-in through
 * TABLEWALK_TEST_ROW_PG like the other row-policy live tests.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { BusinessCommandExecutionError } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { defineCommand, defineCommands, type BusinessCommandContext } from '../packages/mistri/src/server/commands/businessCommands.js';
import { shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import type { CommandResultReference } from '../packages/mistri/src/server/commands/scopedBusinessCommandAccess.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { bindPolicyPublicIntake } from '../packages/mistri/src/server/policy/policyPublicIntake.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { liveSkip } from './live.js';
import { parseTestApp } from './support/commandCatalog.js';

const LIVE = process.env.TABLEWALK_TEST_ROW_PG;
const input = {
  name: { label: 'Name', type: 'text' },
  desk: { label: 'Desk', type: 'number', integer: true },
} as const;
const submission = (suffix = '1', desk = 1) => ({
  input: { name: 'Visitor', desk },
  submission: `intake-submission-${suffix}`,
});
const refusal =
  (code?: string, outcome = 'not_applied') =>
  (error: unknown) => {
    assert.ok(error instanceof BusinessCommandExecutionError, String(error));
    if (code) assert.equal(error.code, code);
    assert.equal(error.outcome, outcome);
    return true;
  };

interface PgClient {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

async function client(url: string): Promise<PgClient> {
  const driver = 'pg';
  const pg = (await import(driver)) as {
    Client?: new (options: object) => PgClient;
    default?: { Client?: new (options: object) => PgClient };
  };
  const Client = pg.Client ?? pg.default?.Client;
  assert.ok(Client);
  const opened = new Client({ connectionString: url, connectionTimeoutMillis: 5_000, statement_timeout: 10_000 });
  await opened.connect();
  return opened;
}

function targetUrl(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.href;
}

async function fixture(t: TestContext) {
  const control = await client(LIVE!);
  const database = `tw_public_intake_${randomUUID().replaceAll('-', '')}`;
  const schema = `tw_intake_${randomUUID().replaceAll('-', '')}`;
  let target: PgClient | undefined;
  let registry: Registry | undefined;
  let adapter: PostgresAdapter | undefined;
  let created = false;
  try {
    await control.query(`CREATE DATABASE "${database}"`);
    created = true;
    const url = targetUrl(LIVE!, database);
    target = await client(url);
    await target.query(`CREATE SCHEMA "${schema}"`);
    await target.query(`CREATE TABLE "${schema}".desk(id integer PRIMARY KEY, name text NOT NULL);
      CREATE TABLE "${schema}".inbox(id serial PRIMARY KEY, desk integer NOT NULL REFERENCES "${schema}".desk(id), name text NOT NULL);
      INSERT INTO "${schema}".desk VALUES (1, 'Allowed'), (2, 'Private');
      INSERT INTO "${schema}".inbox(desk, name) VALUES (2, 'Private submission');`);
    await migratePostgresCommandJournal(url);

    const app = parseTestApp(
      {
        id: 'policy-intake-live',
        name: 'Policy intake live',
        sources: { main: { connection: 'data' } },
        auth: { rows: 'policy', roles: { staff: { read: true } } },
        resources: {
          desk: { physical: `${schema}.desk` },
          inbox: { physical: `${schema}.inbox`, access: 'write' },
        },
        views: {
          inbox: { kind: 'list', from: 'inbox' },
          apply: { kind: 'form', public: true, label: 'Apply', command: { id: 'enrol', version: 1, input } },
        },
        home: 'inbox',
        nav: ['inbox'],
      },
      'live policy intake fixture',
    );
    const registryLocal = new Registry();
    registry = registryLocal;
    registryLocal.add({ id: 'data', name: 'Policy intake data', url, schemas: [schema], source: 'config', writable: true });
    const resources = await loadAppRuntimeResources(registryLocal, app, 'data');
    adapter = (await registryLocal.open('data')).adapter as PostgresAdapter;
    const controlState = {
      calls: 0,
      result: { reference: 'INBOX-001' } as unknown,
      handle: undefined as ((context: BusinessCommandContext) => Promise<void>) | undefined,
      references: [] as readonly CommandResultReference[],
    };
    const registryCommands = defineCommands({
      enrol: defineCommand({
        targets: 'none',
        source: 'main',
        target: 'inbox',
        public: true,
        read: ['desk'],
        input,
        // A public form answers its receipt and nothing else (savedFormChecks.ts).
        output: shape({ reference: text() }),
        async handle(context, value) {
          controlState.calls++;
          if (value.name === 'Visitor') {
            const desks = await context.tx.query({ table: 'desk', limit: 10, offset: 0 });
            assert.deepEqual(
              desks.rows.map((row) => row.id),
              [1],
            );
          }
          await context.tx.insert({ table: 'inbox', values: { name: value.name, desk: value.desk } });
          await controlState.handle?.(context);
          return controlState.result as { reference: string };
        },
      }),
    });
    const rows: RowScope = {
      desk: { groups: [[{ column: 'id', op: '=', value: 1 }]] },
      inbox: { groups: [[{ column: 'desk', op: '=', value: 1 }]] },
    };
    const bindings: Array<ReturnType<typeof bindPolicyPublicIntake>> = [];
    const bind = (scope = rows) => {
      const intake = bindPolicyPublicIntake({
        app,
        resources,
        registry: registryCommands,
        form: 'apply',
        rows: scope,
        resultReferences: (result) => {
          assert.ok(Object.isFrozen(result));
          return controlState.references;
        },
        writableConnection: () => true,
      });
      bindings.push(intake);
      return intake;
    };
    t.after(async () => {
      await Promise.all(bindings.map((binding) => binding.retire()));
      await registryLocal.closeAll();
      await target?.end();
      await control.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      await control.end();
    });
    return { bind, controlState, rows, target, schema };
  } catch (error) {
    await registry?.closeAll().catch(() => {});
    await adapter?.close().catch(() => {});
    await target?.end().catch(() => {});
    if (created) await control.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => {});
    await control.end();
    throw error;
  }
}

test(
  'live public intake inserts once and replays the same receipt',
  { skip: liveSkip('postgres', LIVE, 'TABLEWALK_TEST_ROW_PG'), timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    const intake = f.bind();
    const first = await intake.submit(submission());
    assert.equal(first.status, 'applied');
    assert.equal(first.replayed, false);
    const replay = await intake.submit(submission());
    assert.equal(replay.receiptId, first.receiptId);
    assert.equal(replay.replayed, true);
    assert.equal(f.controlState.calls, 1);
    assert.equal((await f.target!.query(`SELECT count(*) AS n FROM "${f.schema}".inbox`)).rows[0].n, '2');
  },
);

test(
  'live public intake refuses out-of-scope inserts and hidden parents',
  { skip: liveSkip('postgres', LIVE, 'TABLEWALK_TEST_ROW_PG'), timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    await assert.rejects(f.bind().submit(submission('wrong-scope', 2)), refusal());
    await assert.rejects(f.bind({ ...f.rows, inbox: true }).submit(submission('hidden-parent', 2)), refusal());
    assert.equal((await f.target!.query(`SELECT count(*) AS n FROM "${f.schema}".inbox`)).rows[0].n, '1');
  },
);

test(
  'live public intake update refusal rolls back an earlier insert',
  { skip: liveSkip('postgres', LIVE, 'TABLEWALK_TEST_ROW_PG'), timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    f.controlState.handle = async (context) => {
      try {
        await context.tx.update({ table: 'inbox', key: { id: 2 }, values: { name: 'Changed' } });
      } catch {
        /* Deliberately swallowed by a trusted handler. */
      }
    };
    await assert.rejects(f.bind().submit(submission()), refusal());
    assert.equal((await f.target!.query(`SELECT count(*) AS n FROM "${f.schema}".inbox`)).rows[0].n, '1');
  },
);
