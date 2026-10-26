/**
 * The HTTP command proof from business-command-http.test.ts, with a
 * PostgreSQL registry entry under it: prepare, execute and status round
 * trips, a business failure with confirmed rollback, and the startup
 * attestation that refuses an unmigrated journal without migrating it.
 *
 * Live and opt-in like postgres.test.ts (`TABLEWALK_TEST_PG`, and
 * `TABLEWALK_REQUIRE_LIVE=1` to fail rather than skip). It drops and
 * recreates its own tables in `public` of the database it is pointed at.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, describe, test } from 'node:test';
import { runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';
import { COMMAND_JOURNAL_TABLES as tables } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { refuse } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { validateBusinessCommandStartup } from '../packages/mistri/src/server/commands/businessCommandLoader.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { liveSkip } from './live.js';
import { parseTestApp } from './support/commandCatalog.js';

const LIVE = process.env.TABLEWALK_TEST_PG;

interface Control extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}
async function client(): Promise<Control> {
  const specifier = 'pg';
  const pg = (await import(specifier)) as { default?: { Client: new (c: unknown) => Control }; Client?: new (c: unknown) => Control };
  const Client = (pg.Client ?? pg.default?.Client)!;
  const created = new Client({ connectionString: LIVE });
  await created.connect();
  return created;
}

const account: Identity = { id: 'account-a', who: 'manager@example.test', role: 'manager' };
const request = (extra: Record<string, unknown> = {}) => ({
  command: 'assign',
  commandVersion: 1,
  key: { id: 1 },
  expectedVersion: 0,
  idempotencyKey: 'assignment-request-0001',
  input: { reviewer: 1 },
  ...extra,
});

const RESET = [`DROP TABLE IF EXISTS public.loan, public.reviewer, public.hidden CASCADE`, `DROP SCHEMA IF EXISTS mistri CASCADE`];
const SETUP = [
  `CREATE TABLE public.loan (id integer PRIMARY KEY, version integer NOT NULL DEFAULT 0, reviewer integer)`,
  `CREATE TABLE public.reviewer (id integer PRIMARY KEY, name text NOT NULL)`,
  `CREATE TABLE public.hidden (id integer PRIMARY KEY, name text)`,
  `INSERT INTO public.loan VALUES (1, 0, NULL)`,
  `INSERT INTO public.reviewer VALUES (1, 'Ada')`,
];

/* Declared once: the action's reference and the registration read the same list. */
const assignInput = {
  reviewer: { label: 'Reviewer', type: 'reference', from: 'reviewer', by: 'id', labelColumn: 'name', optional: true },
} as const;

describe('HTTP business commands on PostgreSQL, against a real server', { skip: liveSkip('postgres', LIVE) }, () => {
  let control: Control;
  before(async () => {
    control = await client();
  });
  after(async () => {
    for (const statement of RESET) await control.query(statement).catch(() => {});
    await control.end();
  });

  async function fixture(
    run: (f: {
      base: string;
      registry: Registry;
      host: AppHost;
      commands: ReturnType<typeof defineCommands>;
      control: { current: Identity | null; calls: number; fail: boolean };
    }) => Promise<void>,
    migrated = true,
    versionless = false,
  ) {
    for (const statement of [...RESET, ...SETUP]) await control.query(statement);
    if (versionless)
      await control.query("ALTER TABLE public.loan DROP COLUMN version, ADD COLUMN attachment bytea DEFAULT decode('6f6c64', 'hex')");
    if (migrated) await migratePostgresCommandJournal(LIVE!);
    const registry = new Registry();
    registry.add({ id: 'pg-db', name: 'Private', url: LIVE!, writable: true, source: 'config' });
    // Receipts: these requests are the browser's, which keep none unless the App asks.
    const app = parseTestApp(
      {
        id: 'loans',
        name: 'Loans',
        track: 'receipts',
        sources: { lending: { connection: 'pg-db' } },
        resources: {
          loan: {
            access: 'write',
            actions: {
              assign: {
                label: 'Assign',
                command: {
                  id: 'assign',
                  version: 1,
                  target: 'loan',
                  input: assignInput,
                },
              },
            },
          },
          reviewer: {},
          hidden: {},
        },
        auth: {
          roles: {
            manager: { read: true, commands: ['assign'] },
            viewer: { read: ['loan'] },
          },
        },
        views: { loans: { kind: 'list', from: 'loan' } },
        home: 'loans',
        nav: ['loans'],
      },
      'postgres command HTTP fixture',
    );
    const state = { current: account as Identity | null, calls: 0, fail: false };
    const commands = defineCommands({
      assign: defineCommand({
        source: 'lending',
        target: 'loan',
        ...(versionless ? {} : {}),
        read: ['reviewer'],
        input: assignInput,
        validate(input): { reviewer: number } {
          if (!Number.isSafeInteger(input.reviewer)) throw new Error('Private input details');
          return { reviewer: input.reviewer as number };
        },
        output: {
          parse(value: unknown) {
            return { version: (value as { version: number }).version };
          },
        },
        async handle({ db, record }, input) {
          state.calls++;
          const { version } = await db.loan.update(record, { reviewer: input.reviewer });
          if (state.fail) refuse('reviewer_unavailable');
          return { version: versionless ? 0 : Number(version), sql: 'PRIVATE SQL MUST BE PROJECTED' };
        },
      }),
    });
    const host: AppHost = {
      app: { app, path: '/private/app.ts', pages: [], sources: {} },
      pages: [],
      auth: {
        spec: app.auth!,
        store: '/private/auth.db',
        close() {},
        handler: async () => {},
        session: async () => state.current,
      },
    };
    const bound = { host: '127.0.0.1', port: 0 };
    const server = createApp({ registry, bound, apps: [host], commands: { appId: 'loans', registry: commands } });
    try {
      server.listen(0, bound.host);
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      bound.port = address.port;
      await run({ base: `http://${bound.host}:${bound.port}`, registry, host, commands, control: state });
    } finally {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      await registry.closeAll();
    }
  }

  async function post(base: string, path: string, body: unknown) {
    const response = await fetch(`${base}/api/commands/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mistri-account': account.id },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  const loanVersion = async () => (await control.query('SELECT version FROM public.loan WHERE id = 1')).rows[0].version;
  const receipts = async () =>
    Number((await control.query(`SELECT count(*) AS n FROM ${runtimeTable('postgres', tables.receipt)}`)).rows[0].n);

  test('HTTP prepare, execute and exact status round-trip through the PostgreSQL journal', { timeout: 20_000 }, async () => {
    await fixture(async (f) => {
      const prepare = await post(f.base, 'prepare', { command: 'assign', commandVersion: 1, key: { id: 1 } });
      assert.equal(prepare.status, 200, JSON.stringify(prepare.body));
      assert.deepEqual(prepare.body, { expectedVersion: 0 });
      assert.deepEqual((await post(f.base, 'status', request())).body, { status: 'not_found', outcome: 'unknown' });
      const applied = await post(f.base, 'execute', request());
      assert.equal(applied.status, 200, JSON.stringify(applied.body));
      assert.deepEqual(applied.body.result, { version: 1 });
      assert.equal(applied.body.replayed, false);
      assert.doesNotMatch(JSON.stringify(applied.body), /PRIVATE|private|sql|postgres/);
      assert.equal(applied.headers.get('cache-control'), 'no-store');
      const status = await post(f.base, 'status', request());
      assert.deepEqual(status.body, { ...applied.body, replayed: true });
      const replay = await post(f.base, 'execute', request());
      assert.deepEqual(replay.body, { ...applied.body, replayed: true });
      const conflict = await post(f.base, 'execute', request({ input: { reviewer: 2 } }));
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body.code, 'idempotency_conflict');
      assert.equal(f.control.calls, 1);
      assert.equal(await loanVersion(), 1);
      assert.equal(await receipts(), 1);
      f.control.current = { ...account, role: 'viewer' };
      const forbidden = await post(f.base, 'status', request());
      assert.equal(forbidden.status, 403);
      assert.equal(forbidden.body.outcome, 'unknown');
    });
  });

  test('a target without a version column refuses scalar and equal-length binary changes after prepare', { timeout: 60_000 }, async () => {
    await fixture(
      async (f) => {
        const prepare = () => post(f.base, 'prepare', { command: 'assign', commandVersion: 1, key: { id: 1 } });
        for (const [index, sql] of [
          'UPDATE public.loan SET reviewer = 1 WHERE id = 1',
          "UPDATE public.loan SET attachment = decode('6e6577', 'hex') WHERE id = 1",
        ].entries()) {
          const before = await prepare();
          assert.equal(before.status, 200, JSON.stringify(before.body));
          await control.query(sql);
          const after = await prepare();
          assert.equal(after.status, 200, JSON.stringify(after.body));
          assert.notEqual(after.body.expectedVersion, before.body.expectedVersion);
          const stale = await post(
            f.base,
            'execute',
            request({ expectedVersion: before.body.expectedVersion, idempotencyKey: `versionless-stale-${index}-0001` }),
          );
          assert.equal(stale.body.code, 'stale_record', JSON.stringify(stale.body));
        }
        assert.equal(f.control.calls, 0);
        const fresh = await prepare();
        const applied = await post(f.base, 'execute', request({ expectedVersion: fresh.body.expectedVersion }));
        assert.equal(applied.status, 200, JSON.stringify(applied.body));
        assert.equal(f.control.calls, 1);
        assert.equal(await receipts(), 1);
      },
      true,
      true,
    );
  });

  test('HTTP business failures have fixed public messages and confirmed rollback', { timeout: 20_000 }, async () => {
    await fixture(async (f) => {
      f.control.fail = true;
      const result = await post(f.base, 'execute', request());
      assert.equal(result.status, 409);
      assert.equal(result.body.code, 'reviewer_unavailable');
      assert.equal(result.body.message, 'The selected reviewer is unavailable.');
      assert.equal(result.body.outcome, 'not_applied');
      assert.equal(f.control.calls, 1);
      assert.equal(await loanVersion(), 0);
      assert.equal(await receipts(), 0);
    });
  });

  test('startup attests the PostgreSQL journal without migrating it', { timeout: 20_000 }, async () => {
    await fixture(async (f) => {
      const resources = await loadAppRuntimeResources(f.registry, f.host.app.app, 'pg-db');
      await validateBusinessCommandStartup(f.host.app.app, f.commands, resources, () => true);
    });
    await fixture(async (f) => {
      const resources = await loadAppRuntimeResources(f.registry, f.host.app.app, 'pg-db');
      await assert.rejects(
        validateBusinessCommandStartup(f.host.app.app, f.commands, resources, () => true),
        /command journal on connection "pg-db" is unavailable: it is provisioned once, never on startup\. Run `mistri migrate stores up --app <the App's directory>` with the server stopped, as a role that may create tables \(or migratePostgresCommandJournal\(url\) from @mistriwork\/mistri\/commands\)/,
      );
      assert.equal(
        (await control.query(`SELECT count(*) AS n FROM pg_class WHERE relname LIKE '\\_\\_mistri\\_command\\_%'`)).rows[0].n,
        '0',
      );
      const refused = await post(f.base, 'execute', request());
      assert.equal(refused.status, 503, JSON.stringify(refused.body));
      assert.equal(refused.body.code, 'temporarily_unavailable');
      assert.equal(refused.body.outcome, 'not_applied');
      assert.equal(await loanVersion(), 0);
    }, false);
  });
});
