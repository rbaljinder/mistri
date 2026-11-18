/**
 * A person's ordinary run of an `approval: 'ai'` command confirms what a maker marked on the row it writes
 * (commandProvenance.ts `settleProvenance`): no proposal, no confirm request, just the run, its receipt the record of
 * who vouched. On SQLite always, and on PostgreSQL where `TABLEWALK_TEST_PG` names one, where the confirm rides the
 * COMMIT: the execute takes no round trip more than the same update on a resource no maker writes. The floor itself,
 * three for a tenant's update, is postgres-tenant-flights.test.ts's and postgres-tenant-statements.test.ts's.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { setServerTiming } from '../packages/engine/src/adapters/telemetry/serverTiming.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';
import { COMMAND_JOURNAL_TABLES as tables, migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { bindBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { defineCommand, defineCommands, type BusinessCommandActor } from '../packages/mistri/src/server/commands/businessCommands.js';
import { markProvenance } from '../packages/mistri/src/server/commands/proposals.js';
import { liveSkip } from './live.js';
import { parseTestApp } from './support/commandCatalog.js';
import { createApp } from './support/createApp.js';

const appId = 'lending';
const LIVE = process.env.TABLEWALK_TEST_PG;

interface Engine {
  url: string;
  directory: string;
  table(name: string): string;
  all(sql: string, params?: readonly unknown[]): Promise<Record<string, unknown>[]>;
}

/** `db-app;dur=…;desc="flights=3 max=1"` → 3: the App's own store, as the server names it. */
const flightsOf = (header: string | null) => Number(/(?:^|, )db-app;[^,]*?desc="flights=(\d+)/.exec(header ?? '')?.[1] ?? NaN);

/** Runs the scenario and answers two executes' database flights, as their Server-Timing headers say them: one that
    confirms marks, and the same update on a resource no maker writes, which confirms nothing. */
async function personRunConfirms(engine: Engine): Promise<{ confirming: number; plain: number }> {
  const registry = new Registry();
  registry.add({ id: 'lending-db', name: 'Lending', url: engine.url, writable: true, source: 'config' });
  const app = parseTestApp(
    {
      id: appId,
      name: 'Lending',
      sources: { lending: { connection: 'lending-db', default: true } },
      resources: {
        loan: {
          access: 'write',
          actions: {
            retitle: { label: 'Retitle', command: { id: 'retitle', version: 1, target: 'loan', input: { title: { type: 'text' } } } },
          },
        },
        branch: {
          access: 'write',
          actions: {
            rename: { label: 'Rename', command: { id: 'rename', version: 1, target: 'branch', input: { title: { type: 'text' } } } },
          },
        },
      },
      auth: { roles: { reviewer: { read: true, commands: ['retitle', 'rename'] } } },
      views: { loans: { kind: 'list', from: 'loan' } },
      home: 'loans',
      nav: ['loans'],
    },
    'provenance person run fixture',
  );
  const commands = defineCommands({
    // A maker proposes it; a person runs it as any other command.
    retitle: defineCommand({
      approval: 'ai',
      source: 'lending',
      target: 'loan',
      track: 'receipts',
      input: { title: { label: 'Title', type: 'text' } },
      async handle({ db: rows, record }, input) {
        await rows.loan.update(record, { title: input.title });
      },
    }),
    // The same update where no maker writes: nothing to confirm, and nothing paid for it (makerWrites.ts).
    rename: defineCommand({
      source: 'lending',
      target: 'branch',
      track: 'receipts',
      input: { title: { label: 'Title', type: 'text' } },
      async handle({ db: rows, record }, input) {
        await rows.branch.update(record, { title: input.title });
      },
    }),
  });
  const people: Record<string, Identity> = { 'account-ada': { id: 'account-ada', who: 'ada@example.test', role: 'reviewer' } };
  const host: AppHost = {
    app: { app, path: join(engine.directory, 'app.ts'), pages: [], sources: {} },
    pages: [],
    auth: {
      spec: app.auth!,
      store: join(engine.directory, 'auth.db'),
      close() {},
      handler: async () => {},
      session: async (request: IncomingMessage) => people[String(request.headers['x-mistri-account'])] ?? null,
    },
  };
  // The maker's side, as a job reaches the store: a binding of its own.
  const makers = new Registry();
  makers.add({ id: 'lending-db', name: 'Lending', url: engine.url, writable: true, source: 'config' });
  const binding = bindBusinessCommands({
    app,
    registry: commands,
    resources: await loadAppRuntimeResources(makers, app, 'lending-db'),
    writableConnection: (id) => makers.configOf(id)?.writable === true,
  });
  const ada: BusinessCommandActor = { id: 'account-ada', appId, roles: ['reviewer'] };
  for (const id of [1, 2, 3])
    await markProvenance(binding, ada, {
      command: 'retitle',
      key: { id },
      field: 'title',
      maker: 'job',
      makerActor: 'job:import',
      evidence: [],
    });
  const marks = async () =>
    (await engine.all(`SELECT row_key, confirmed_by, confirmed_at FROM ${engine.table(tables.provenance)} ORDER BY row_key`)).map((row) => [
      row.row_key,
      row.confirmed_by,
      row.confirmed_at === null ? null : 'stamped',
    ]);
  assert.deepEqual(await marks(), [
    ['{"id":1}', null, null],
    ['{"id":2}', null, null],
    ['{"id":3}', null, null],
  ]);

  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], commands: { appId, registry: commands } });
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const post = (path: string, body: Record<string, unknown>) =>
      fetch(`http://${bound.host}:${address.port}${path}`, {
        method: 'POST',
        signal: AbortSignal.timeout(5_000),
        headers: { 'content-type': 'application/json', 'x-mistri-account': 'account-ada' },
        body: JSON.stringify(body),
      });
    const run = async (command: string, id: number, title: string) => {
      const prepared = await post('/api/commands/prepare', { command, commandVersion: 1, key: { id } });
      const ready = (await prepared.json()) as { expectedVersion: number };
      assert.equal(prepared.status, 200, JSON.stringify(ready));
      const executed = await post('/api/commands/execute', {
        command,
        commandVersion: 1,
        key: { id },
        expectedVersion: ready.expectedVersion,
        idempotencyKey: `person-run-${command}-${id}`,
        input: { title },
      });
      assert.equal(executed.status, 200, await executed.clone().text());
      return executed;
    };
    // The first execute of each warms the server (its catalog, its statements); the second is the one counted.
    await run('retitle', 3, 'Florist, renamed');
    const executed = await run('retitle', 1, 'Corner shop, renamed');
    await run('rename', 1, 'North, renamed');
    const plain = await run('rename', 2, 'South, renamed');
    // The person's receipt, and the mark on the row they wrote confirmed under their name; the other row's waits.
    const receipts = await engine.all(`SELECT actor_id, actor_kind, proposal_id FROM ${engine.table(tables.receipt)}`);
    assert.deepEqual(
      receipts.map((receipt) => [receipt.actor_id, receipt.actor_kind, receipt.proposal_id]),
      Array.from({ length: 4 }, () => ['account-ada', 'person', null]),
    );
    assert.deepEqual(await marks(), [
      ['{"id":1}', 'account-ada', 'stamped'],
      ['{"id":2}', null, null],
      ['{"id":3}', 'account-ada', 'stamped'],
    ]);
    assert.equal((await engine.all('SELECT title FROM loan WHERE id = 1'))[0]!.title, 'Corner shop, renamed');
    return { confirming: flightsOf(executed.headers.get('server-timing')), plain: flightsOf(plain.headers.get('server-timing')) };
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    await makers.closeAll();
  }
}

test('on SQLite, a person running an approval: ai command confirms the marks on the row it writes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-provenance-person-run-'));
  try {
    const file = join(directory, 'lending.db');
    const db = new DatabaseSync(file);
    try {
      db.exec(`CREATE TABLE loan (id INTEGER PRIMARY KEY, title TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE branch (id INTEGER PRIMARY KEY, title TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);
      INSERT INTO loan VALUES (1, 'Corner shop', 0), (2, 'Bakery', 0), (3, 'Florist', 0);
      INSERT INTO branch VALUES (1, 'North', 0), (2, 'South', 0);`);
      migrateSqliteCommandJournal(file);
      await personRunConfirms({
        url: file,
        directory,
        table: (name) => `"${name}"`,
        all: async (sql, params = []) =>
          db
            .prepare(sql)
            .all(...(params as never[]))
            .map((row) => ({ ...row })),
      });
    } finally {
      db.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface Control extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}

const RESET = [`DROP TABLE IF EXISTS public.loan, public.branch CASCADE`, `DROP SCHEMA IF EXISTS mistri CASCADE`];
const SETUP = [
  `CREATE TABLE public.loan (id integer PRIMARY KEY, title text NOT NULL, version integer NOT NULL DEFAULT 0)`,
  `CREATE TABLE public.branch (id integer PRIMARY KEY, title text NOT NULL, version integer NOT NULL DEFAULT 0)`,
  `INSERT INTO public.loan VALUES (1, 'Corner shop', 0), (2, 'Bakery', 0), (3, 'Florist', 0)`,
  `INSERT INTO public.branch VALUES (1, 'North', 0), (2, 'South', 0)`,
];

test(
  'on PostgreSQL, a person running an approval: ai command confirms the marks it wrote, in no extra round trip',
  { timeout: 60_000, skip: liveSkip('postgres', LIVE) },
  async (t) => {
    setServerTiming(true);
    t.after(() => setServerTiming(false));
    const specifier = 'pg';
    const pg = (await import(specifier)) as { default?: { Client: new (c: unknown) => Control }; Client?: new (c: unknown) => Control };
    const Client = pg.Client ?? pg.default?.Client;
    if (!Client) throw new Error('pg has no Client');
    const control = new Client({ connectionString: LIVE });
    await control.connect();
    const directory = mkdtempSync(join(tmpdir(), 'mistri-provenance-person-run-pg-'));
    try {
      for (const statement of [...RESET, ...SETUP]) await control.query(statement);
      await migratePostgresCommandJournal(LIVE!);
      const flights = await personRunConfirms({
        url: LIVE!,
        directory,
        table: (name) => runtimeTable('postgres', name),
        all: async (sql, params = []) => {
          let n = 0;
          return (
            await control.query(
              sql.replace(/\?/g, () => `$${++n}`),
              [...params],
            )
          ).rows;
        },
      });
      /* The confirm is queued behind the receipt and goes with the COMMIT (postgresCommandJournal.ts
         `confirmProvenance`); sent on its own, with its in-transaction check, it was two flights more. */
      assert.ok(Number.isFinite(flights.plain), 'the execute says its flights');
      assert.equal(
        flights.confirming,
        flights.plain,
        `confirming marks took ${flights.confirming} flights, a plain update ${flights.plain}`,
      );
    } finally {
      for (const statement of RESET) await control.query(statement).catch(() => {});
      await control.end();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
