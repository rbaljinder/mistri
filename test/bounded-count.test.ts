/**
 * Bounded counting: `countLimit` on /api/count and on /api/run's total.
 *
 * A menu count asks "how many, up to ten thousand". The adapter wraps its own
 * count plan — the same relation, row scope and WHERE — in a LIMIT, so the
 * answer costs at most the bound plus one row however large the table, and
 * says `capped` past it. Asserted here: below the bound it is the exact
 * count; past it, the bound and `capped`; a row policy still applies, so a
 * scoped role's bounded count is its own and never the table's; absent, the
 * replies are the ones these routes always gave; and the statement the
 * database runs carries the LIMIT — read off the driver, and on PostgreSQL off
 * the planner's own account of how many rows the scan produced.
 *
 * SQLite always; PostgreSQL live and opt-in (test/live.ts).
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { countStatement, Refusal, type Adapter, type Filter } from '../packages/engine/src/adapters/adapter.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { loadHttpAppPolicy, type HttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import { countLimitOf, MAX_COUNT_LIMIT, readCount, ResourceReadError } from '../packages/engine/src/server/resourceReadOperations.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { liveSkip } from './live.js';

const DESK_ONE = 3;
const DESK_TWO = 40;
const ALL = DESK_ONE + DESK_TWO;
const onDesk = (column: string, desk: number): Filter => ({ groups: [[{ column, op: '=', value: desk }]] });
const account = (id: string): Identity => ({ id, who: `${id}@example.test`, role: 'reader' });

type Reply = { status: number; body: any };
type Call = (path: string, body: Record<string, unknown>) => Promise<Reply>;

async function ok(reply: Promise<Reply>) {
  const { status, body } = await reply;
  assert.equal(status, 200, JSON.stringify(body));
  assert.ok(!body.errors?.length, JSON.stringify(body));
  return body;
}

async function listen(
  make: (bound: { host: string; port: number }) => Server,
  extra: Record<string, unknown>,
  headers: () => Record<string, string> = () => ({}),
) {
  const bound = { host: '127.0.0.1', port: 0 };
  const server = make(bound);
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  const call: Call = async (path, body) => {
    const url = new URL(path, `http://${bound.host}:${bound.port}`);
    if (typeof extra.app === 'string') url.searchParams.set('app', extra.app);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers() },
      body: JSON.stringify({ ...extra, ...body }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const close = async () => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  };
  return { call, close };
}

/** Desk one has three tickets, desk two forty. */
function sqliteFile(directory: string): string {
  const file = join(directory, 'data.db');
  const db = new DatabaseSync(file);
  try {
    db.exec(`CREATE TABLE physical_desk (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE physical_ticket (id INTEGER PRIMARY KEY, desk_id INTEGER REFERENCES physical_desk(id), name TEXT);
      INSERT INTO physical_desk VALUES (1, 'One'), (2, 'Two');`);
    const insert = db.prepare('INSERT INTO physical_ticket (desk_id, name) VALUES (?, ?)');
    for (let i = 0; i < DESK_ONE; i++) insert.run(1, `Desk one ${i}`);
    for (let i = 0; i < DESK_TWO; i++) insert.run(2, `Desk two ${i}`);
  } finally {
    db.close();
  }
  return file;
}

/** Every statement the SQLite adapter's read handle prepares, in order. */
function sqliteStatements(adapter: Adapter): string[] {
  const seen: string[] = [];
  const db = Reflect.get(adapter, 'db') as DatabaseSync;
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    seen.push(sql);
    return prepare(sql);
  }) as typeof db.prepare;
  return seen;
}

test('countStatement wraps the relation it is given, and without a bound is the plain COUNT(*)', () => {
  assert.equal(countStatement('"t" WHERE "a" = ?'), 'SELECT COUNT(*) AS n FROM "t" WHERE "a" = ?');
  assert.equal(
    countStatement('"t" WHERE "a" = ?', 11),
    'SELECT COUNT(*) AS n FROM (SELECT 1 AS one FROM "t" WHERE "a" = ? LIMIT 11) AS bounded',
  );
  for (const bad of [0, -1, 1.5, NaN, Infinity, 2 ** 60]) assert.throws(() => countStatement('"t"', bad), Refusal);
});

test('countLimit is absent, a positive whole number clamped to 100,000, or refused', () => {
  assert.equal(countLimitOf(undefined), undefined);
  assert.equal(countLimitOf(null), undefined);
  assert.equal(countLimitOf(1), 1);
  assert.equal(countLimitOf(10_000), 10_000);
  assert.equal(countLimitOf(1e9), MAX_COUNT_LIMIT);
  assert.equal(MAX_COUNT_LIMIT, 100_000);
  for (const bad of [0, -5, 1.5, '10', true, {}, []]) {
    assert.throws(
      () => countLimitOf(bad),
      (error: unknown) => error instanceof ResourceReadError && error.status === 400,
    );
  }
});

describe('SQLite', () => {
  let directory: string;
  let file: string;
  before(() => {
    directory = mkdtempSync(join(tmpdir(), 'tablewalk-bounded-count-'));
    file = sqliteFile(directory);
  });
  after(() => rmSync(directory, { recursive: true, force: true }));

  test('the adapter: exact below the bound, the bound past it, and the statement carries the LIMIT', async () => {
    const adapter = new SqliteAdapter(file);
    try {
      const seen = sqliteStatements(adapter);
      assert.equal(await adapter.count('physical_ticket'), ALL);
      assert.equal(seen.at(-1), 'SELECT COUNT(*) AS n FROM "physical_ticket"', 'absent, the statement is the one it always was');
      assert.equal(await adapter.count('physical_ticket', undefined, 11), 11);
      assert.equal(seen.at(-1), 'SELECT COUNT(*) AS n FROM (SELECT 1 AS one FROM "physical_ticket" LIMIT 11) AS bounded');
      assert.equal(await adapter.count('physical_ticket', undefined, ALL + 1), ALL);
      assert.equal(await adapter.count('physical_ticket', onDesk('desk_id', 1), 11), DESK_ONE);
      assert.ok(seen.at(-1)!.includes('"desk_id"') && seen.at(-1)!.endsWith(' LIMIT 11) AS bounded'), seen.at(-1));
      await assert.rejects(() => adapter.count('physical_ticket', undefined, 0), Refusal);
      // A scoped reader wraps its own scoped plan, not the table.
      const scoped = await adapter.scopeReads({ physical_ticket: onDesk('desk_id', 2) });
      assert.equal(await scoped.count('physical_ticket'), DESK_TWO);
      assert.equal(await scoped.count('physical_ticket', undefined, 11), 11);
      assert.equal(await scoped.count('physical_ticket', undefined, DESK_TWO + 1), DESK_TWO);
      assert.equal(await scoped.count('physical_ticket', onDesk('desk_id', 1), 11), 0);
      assert.ok(seen.at(-1)!.endsWith(' LIMIT 11) AS bounded') && seen.at(-1)!.includes('desk_id'), seen.at(-1));
    } finally {
      await adapter.close();
    }
  });

  test('readCount: a bound is counted, never estimated, asks for one row past it; absent is the old count', async () => {
    const adapter = new SqliteAdapter(file);
    try {
      const schema = await adapter.introspect();
      const calls: unknown[][] = [];
      const reader = {
        query: adapter.query.bind(adapter),
        count: (table: string, filter?: Filter, limit?: number) => {
          calls.push(['count', ...(limit === undefined ? [] : [limit])]);
          return adapter.count(table, filter, limit);
        },
        estimateCount: async () => {
          calls.push(['estimate']);
          return 60_001;
        },
      };
      // Absent: the statistics above the threshold, as before; an exact request, two arguments as before.
      assert.deepEqual(await readCount(reader, schema, { table: 'physical_ticket' }), { count: 60_001, exact: false });
      assert.deepEqual(await readCount(reader, schema, { table: 'physical_ticket', exact: true }), { count: ALL, exact: true });
      assert.deepEqual(calls.splice(0), [['estimate'], ['count']]);
      // Present: counted, one row past the bound, the estimate never asked.
      assert.deepEqual(await readCount(reader, schema, { table: 'physical_ticket', countLimit: 10 }), {
        count: 10,
        exact: true,
        capped: true,
      });
      assert.deepEqual(calls.splice(0), [['count', 11]]);
      // Exactly the bound is exact: capped means more rows than the bound.
      assert.deepEqual(await readCount(reader, schema, { table: 'physical_ticket', countLimit: ALL }), { count: ALL, exact: true });
      assert.deepEqual(await readCount(reader, schema, { table: 'physical_ticket', countLimit: ALL - 1 }), {
        count: ALL - 1,
        exact: true,
        capped: true,
      });
      assert.deepEqual(await readCount(reader, schema, { table: 'physical_ticket', countLimit: 1e9 }), { count: ALL, exact: true });
      assert.deepEqual(calls.splice(0), [
        ['count', ALL + 1],
        ['count', ALL],
        ['count', MAX_COUNT_LIMIT + 1],
      ]);
      // A bad bound is refused before anything is read.
      await assert.rejects(
        () => readCount(reader, schema, { table: 'physical_ticket', countLimit: 0 }),
        (error: unknown) => error instanceof ResourceReadError && error.status === 400,
      );
      assert.deepEqual(calls, []);
    } finally {
      await adapter.close();
    }
  });

  test('HTTP, the database browser: countLimit on /api/count and /api/run; absent, the old replies', async () => {
    const registry = new Registry();
    registry.add({ id: 'bounded-db', name: 'bounded-db', url: file, source: 'config' });
    const adapter = (await registry.open('bounded-db')).adapter;
    const seen = sqliteStatements(adapter);
    const { call, close } = await listen((bound) => createApp({ registry, bound }), { conn: 'bounded-db' });
    try {
      assert.deepEqual(await ok(call('/api/count', { table: 'physical_ticket' })), { count: ALL, exact: true });
      assert.deepEqual(await ok(call('/api/count', { table: 'physical_ticket', countLimit: 10 })), {
        count: 10,
        exact: true,
        capped: true,
      });
      assert.ok(seen.some((text) => text.endsWith(' LIMIT 11) AS bounded')));
      assert.deepEqual(await ok(call('/api/count', { table: 'physical_ticket', countLimit: 100 })), { count: ALL, exact: true });
      assert.deepEqual(await ok(call('/api/count', { table: 'physical_ticket', filter: onDesk('desk_id', 1), countLimit: 2 })), {
        count: 2,
        exact: true,
        capped: true,
      });
      assert.deepEqual(await ok(call('/api/count', { table: 'physical_ticket', countLimit: null })), { count: ALL, exact: true });

      const capped = await ok(call('/api/run', { q: 'physical_ticket desk_id = 2', limit: 1, countLimit: 10 }));
      assert.deepEqual([capped.total, capped.exactTotal, capped.cappedTotal, capped.rows.length], [10, true, true, 1]);
      const below = await ok(call('/api/run', { q: 'physical_ticket desk_id = 1', limit: 1, countLimit: 10 }));
      assert.deepEqual([below.total, below.exactTotal, Object.hasOwn(below, 'cappedTotal')], [DESK_ONE, true, false]);
      const plain = await ok(call('/api/run', { q: 'physical_ticket desk_id = 2', limit: 1 }));
      assert.deepEqual([plain.total, plain.exactTotal, Object.hasOwn(plain, 'cappedTotal')], [DESK_TWO, true, false]);

      seen.length = 0;
      await ok(call('/api/count', { table: 'physical_ticket', countLimit: 1e9 }));
      assert.ok(
        seen.some((text) => text.endsWith(` LIMIT ${MAX_COUNT_LIMIT + 1}) AS bounded`)),
        'clamped to 100,000',
      );
      for (const countLimit of [0, -1, 2.5, '10', true]) {
        assert.equal((await call('/api/count', { table: 'physical_ticket', countLimit })).status, 400, String(countLimit));
        assert.equal((await call('/api/run', { q: 'physical_ticket', limit: 1, countLimit })).status, 400, String(countLimit));
      }
      // Statistics that say "large" still answer the unbounded count; a bound is counted.
      adapter.estimateCount = async () => 60_001;
      assert.deepEqual(await ok(call('/api/count', { table: 'physical_ticket' })), { count: 60_001, exact: false });
      assert.deepEqual(await ok(call('/api/count', { table: 'physical_ticket', countLimit: 10 })), {
        count: 10,
        exact: true,
        capped: true,
      });
      const run = await ok(call('/api/run', { q: 'physical_ticket', limit: 1, countLimit: 10 }));
      assert.deepEqual([run.total, run.exactTotal, run.cappedTotal], [10, true, true]);
    } finally {
      await close();
      await registry.closeAll();
    }
  });

  test("HTTP, an App without a row policy: the bound reaches the source through the App's resource names", async () => {
    const registry = new Registry();
    registry.add({ id: 'bounded-plain', name: 'bounded-plain', url: file, source: 'config' });
    const seen = sqliteStatements((await registry.open('bounded-plain')).adapter);
    const app = parseAppConfig(
      {
        id: 'bounded-plain-app',
        name: 'Bounded plain',
        connection: 'bounded-plain',
        resources: { desk: { physical: 'physical_desk' }, ticket: { physical: 'physical_ticket' } },
        auth: { roles: { reader: { read: true } } },
        views: { tickets: { kind: 'list', from: 'ticket' } },
        home: 'tickets',
        nav: ['tickets'],
      },
      'bounded count plain App',
    );
    const host: AppHost = {
      app: { app, path: join(directory, 'plain.ts'), pages: [], sources: {} },
      pages: [],
      auth: { spec: app.auth!, store: 'unused', close: async () => {}, handler: async () => {}, session: async () => account('plain') },
    };
    const { call, close } = await listen((bound) => createApp({ registry, bound, apps: [host] }), { app: 'bounded-plain-app' });
    try {
      assert.deepEqual(await ok(call('/api/count', { table: 'ticket' })), { count: ALL, exact: true });
      assert.deepEqual(await ok(call('/api/count', { table: 'ticket', countLimit: 10 })), { count: 10, exact: true, capped: true });
      assert.ok(
        seen.some((text) => text.endsWith('"physical_ticket" LIMIT 11) AS bounded')),
        seen.join('\n'),
      );
      // The App projection keeps the flag and still drops the compiler's output.
      const run = await ok(call('/api/run', { q: 'ticket desk_id = 1', limit: 1, countLimit: 2 }));
      assert.deepEqual([run.total, run.exactTotal, run.cappedTotal], [2, true, true]);
      assert.equal(Object.hasOwn(run, 'sql'), false);
      const below = await ok(call('/api/run', { q: 'ticket desk_id = 1', limit: 1, countLimit: 10 }));
      assert.deepEqual([below.total, Object.hasOwn(below, 'cappedTotal')], [DESK_ONE, false]);
    } finally {
      await close();
      await registry.closeAll();
    }
  });

  test("HTTP, a row policy: a scoped role's bounded count is its own, never the table's", async () => {
    const registry = new Registry();
    const owner = 'bounded-policy';
    registry.add({ id: owner, name: owner, url: file, source: 'config' });
    const seen = sqliteStatements((await registry.open(owner)).adapter);
    const appId = 'bounded-policy-app';
    const app = parseAppConfig(
      {
        id: appId,
        name: 'Bounded policy',
        sources: { main: { connection: owner } },
        resources: { desk: { physical: 'physical_desk' }, ticket: { physical: 'physical_ticket' } },
        auth: { rows: 'policy', roles: { reader: { read: true } } },
        views: { tickets: { kind: 'list', from: 'ticket' } },
        home: 'tickets',
        nav: ['tickets'],
      },
      'bounded count row policy',
    );
    const policyFile = join(directory, 'policy.mjs');
    writeFileSync(
      policyFile,
      `export default { appId: ${JSON.stringify(appId)},
      resolveRows(principal) {
        const desk = principal.id === 'desk-two' ? 2 : 1;
        const eq = (column, value) => ({ groups: [[{ column, op: '=', value }]] });
        return { desk: eq('id', desk), ticket: eq('desk_id', desk) };
      } };`,
    );
    let who = account('desk-one');
    const host: AppHost = {
      app: { app, path: join(directory, 'policy-app.ts'), pages: [], sources: {} },
      pages: [],
      auth: {
        spec: app.auth!,
        store: join(directory, 'auth.db'),
        close: async () => {},
        handler: async () => {},
        session: async () => who,
      },
    };
    let policy: HttpAppPolicy | undefined;
    let close = async () => {};
    try {
      policy = await loadHttpAppPolicy({ app, registry, file: policyFile, verifySession: async () => who });
      const started = await listen(
        (bound) => createApp({ registry, bound, apps: [host], policy }),
        { app: appId },
        () => ({ 'x-mistri-account': who.id }),
      );
      close = started.close;
      const call = started.call;
      // Desk one sees three of the table's forty-three: a bound of five is above its count.
      assert.deepEqual(await ok(call('/api/count', { table: 'ticket', countLimit: 5 })), { count: DESK_ONE, exact: true });
      const statement = seen.filter((text) => text.includes('AS bounded')).at(-1);
      assert.ok(
        statement?.endsWith(' LIMIT 6) AS bounded') && statement.includes('desk_id'),
        `the policy's condition sits inside the bound: ${statement}`,
      );
      assert.deepEqual(await ok(call('/api/count', { table: 'ticket', countLimit: 2 })), { count: 2, exact: true, capped: true });
      assert.deepEqual(await ok(call('/api/count', { table: 'ticket' })), { count: DESK_ONE, exact: true });
      const run = await ok(call('/api/run', { q: 'ticket', limit: 1, countLimit: 2 }));
      assert.deepEqual([run.total, run.exactTotal, run.cappedTotal], [2, true, true]);
      const below = await ok(call('/api/run', { q: 'ticket', limit: 1, countLimit: 5 }));
      assert.deepEqual([below.total, below.exactTotal, Object.hasOwn(below, 'cappedTotal')], [DESK_ONE, true, false]);

      who = account('desk-two');
      assert.deepEqual(await ok(call('/api/count', { table: 'ticket', countLimit: 10 })), { count: 10, exact: true, capped: true });
      assert.deepEqual(await ok(call('/api/count', { table: 'ticket', countLimit: 100 })), { count: DESK_TWO, exact: true });
      // A filter composes inside the scope: desk two asking for desk one's rows counts none.
      assert.deepEqual(await ok(call('/api/count', { table: 'ticket', filter: onDesk('desk_id', 1), countLimit: 10 })), {
        count: 0,
        exact: true,
      });
    } finally {
      await close();
      await policy?.retire();
      await registry.closeAll();
    }
  });
});

/* ---------- live engines ---------- */

interface Control extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}
type PlanNode = { 'Node Type': string; 'Relation Name'?: string; 'Actual Rows'?: number; Plans?: PlanNode[] };
const planNodes = (plan: PlanNode): PlanNode[] => [plan, ...(plan.Plans ?? []).flatMap(planNodes)];

/** Every statement a Postgres adapter's reader runs, with its parameters. */
function postgresStatements(adapter: object): Array<{ text: string; params: unknown[] }> {
  const seen: Array<{ text: string; params: unknown[] }> = [];
  const conn = (Reflect.get(adapter, 'conn') as () => Promise<PgQuery>).bind(adapter);
  Reflect.set(adapter, 'conn', async () => {
    const db = await conn();
    return new Proxy(db, {
      get(target, key) {
        if (key === 'query') {
          return (text: unknown, params?: unknown[]) => {
            if (typeof text === 'string') seen.push({ text, params: params ?? [] });
            return (target.query as (...args: unknown[]) => unknown).call(target, text, params);
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
  return seen;
}

const PG = process.env.TABLEWALK_TEST_PG;
const PG_DESK_TWO = 20_000;
const PG_BOUND = 10_000;

describe('bounded counts on PostgreSQL, against a real server', { skip: liveSkip('postgres', PG) }, () => {
  const desk = 'bounded_count_desk';
  const ticket = 'bounded_count_ticket';
  const RESET = `DROP TABLE IF EXISTS public.${ticket}, public.${desk} CASCADE`;
  let control: Control;

  /** How many rows the planner says the scans of `relation` produced when the statement ran. */
  async function scanned(statement: { text: string; params: unknown[] }): Promise<number> {
    const result = await control.query(`EXPLAIN (ANALYZE, TIMING OFF, SUMMARY OFF, FORMAT JSON) ${statement.text}`, statement.params);
    const plan = (result.rows[0] as Record<string, unknown>)['QUERY PLAN'] as Array<{ Plan: PlanNode }>;
    const scans = planNodes(plan[0].Plan).filter((node) => node['Relation Name'] === ticket);
    assert.ok(scans.length, JSON.stringify(plan));
    return Math.max(...scans.map((node) => node['Actual Rows'] ?? 0));
  }

  before(async () => {
    const specifier = 'pg';
    const pg = (await import(specifier)) as { default?: { Client: new (c: unknown) => Control }; Client?: new (c: unknown) => Control };
    const Client = (pg.Client ?? pg.default?.Client)!;
    control = new Client({ connectionString: PG, statement_timeout: 20_000 });
    await control.connect();
    for (const statement of [
      RESET,
      `CREATE TABLE public.${desk} (id integer PRIMARY KEY, name text)`,
      `CREATE TABLE public.${ticket} (id serial PRIMARY KEY, desk integer NOT NULL REFERENCES public.${desk} (id), name text)`,
      `INSERT INTO public.${desk} VALUES (1, 'One'), (2, 'Two')`,
      `INSERT INTO public.${ticket} (desk, name) SELECT 1, 'Desk one ' || g FROM generate_series(1, ${DESK_ONE}) g`,
      `INSERT INTO public.${ticket} (desk, name) SELECT 2, 'Desk two ' || g FROM generate_series(1, ${PG_DESK_TWO}) g`,
      `ANALYZE public.${ticket}`,
    ])
      await control.query(statement);
  });
  after(async () => {
    await control?.query(RESET).catch(() => {});
    await control?.end();
  });

  test('the adapter: exact below the bound, the bound past it, and the scan stops at the bound', async () => {
    const adapter = new PostgresAdapter(PG!, 'bounded-count');
    try {
      const id = (await adapter.introspect()).tables.find((table) => table.name === ticket)!.id;
      const seen = postgresStatements(adapter);
      const all = DESK_ONE + PG_DESK_TWO;
      assert.equal(await adapter.count(id), all);
      assert.equal(seen.at(-1)!.text, `SELECT COUNT(*) AS n FROM "public"."${ticket}"`, 'absent, the statement is the one it always was');
      assert.equal(await scanned(seen.at(-1)!), all);
      assert.equal(await adapter.count(id, undefined, PG_BOUND + 1), PG_BOUND + 1);
      assert.equal(
        seen.at(-1)!.text,
        `SELECT COUNT(*) AS n FROM (SELECT 1 AS one FROM "public"."${ticket}" LIMIT ${PG_BOUND + 1}) AS bounded`,
      );
      assert.equal(await scanned(seen.at(-1)!), PG_BOUND + 1, 'the scan produced no more rows than the bound');
      assert.equal(await adapter.count(id, onDesk('desk', 1), PG_BOUND + 1), DESK_ONE);
      assert.equal(await adapter.count(id, undefined, all + 1), all);

      const scoped = await adapter.scopeReads({ [id]: onDesk('desk', 2) });
      assert.equal(await scoped.count(id, undefined, PG_BOUND + 1), PG_BOUND + 1);
      const bounded = seen.at(-1)!;
      assert.ok(bounded.text.endsWith(` LIMIT ${PG_BOUND + 1}) AS bounded`) && bounded.text.includes('"desk"'), bounded.text);
      assert.equal(await scanned(bounded), PG_BOUND + 1);
      assert.equal(await scoped.count(id), PG_DESK_TWO);
      assert.equal(await scanned(seen.at(-1)!), PG_DESK_TWO, 'unbounded, the scoped scan reads every row it may see');
      assert.equal(await scoped.count(id, onDesk('desk', 1), PG_BOUND + 1), 0);
    } finally {
      await adapter.close();
    }
  });

  test("HTTP, a row policy: the scoped role's bounded count is its own, and capped past ten thousand", async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-bounded-count-pg-'));
    const registry = new Registry();
    const owner = 'bounded-count-postgres';
    const appId = 'bounded-count-postgres-app';
    let policy: HttpAppPolicy | undefined;
    let close = async () => {};
    try {
      registry.add({ id: owner, name: owner, url: PG!, source: 'config' });
      const seen = postgresStatements((await registry.open(owner)).adapter);
      const app = parseAppConfig(
        {
          id: appId,
          name: 'Bounded PostgreSQL',
          sources: { main: { connection: owner } },
          resources: { desk: { physical: `public.${desk}` }, ticket: { physical: `public.${ticket}` } },
          auth: { rows: 'policy', roles: { reader: { read: true } } },
          views: { tickets: { kind: 'list', from: 'ticket' } },
          home: 'tickets',
          nav: ['tickets'],
        },
        'bounded count PostgreSQL row policy',
      );
      const file = join(directory, 'policy.mjs');
      writeFileSync(
        file,
        `export default { appId: ${JSON.stringify(appId)},
        resolveRows(principal) {
          const desk = principal.id === 'desk-two' ? 2 : 1;
          const eq = (column, value) => ({ groups: [[{ column, op: '=', value }]] });
          return { desk: eq('id', desk), ticket: eq('desk', desk) };
        } };`,
      );
      let who = account('desk-one');
      const host: AppHost = {
        app: { app, path: join(directory, 'app.ts'), pages: [], sources: {} },
        pages: [],
        auth: {
          spec: app.auth!,
          store: join(directory, 'auth.db'),
          close: async () => {},
          handler: async () => {},
          session: async () => who,
        },
      };
      policy = await loadHttpAppPolicy({ app, registry, file, verifySession: async () => who });
      const started = await listen(
        (bound) => createApp({ registry, bound, apps: [host], policy }),
        { app: appId },
        () => ({ 'x-mistri-account': who.id }),
      );
      close = started.close;
      const call = started.call;

      assert.deepEqual(
        await ok(call('/api/count', { table: 'ticket', countLimit: PG_BOUND })),
        { count: DESK_ONE, exact: true },
        "desk one sees its three, never the table's twenty thousand and three",
      );
      const own = seen.filter((statement) => statement.text.includes('AS bounded')).at(-1)!;
      assert.ok(own.text.endsWith(` LIMIT ${PG_BOUND + 1}) AS bounded`) && own.text.includes('"desk"'), own.text);

      who = account('desk-two');
      assert.deepEqual(await ok(call('/api/count', { table: 'ticket', countLimit: PG_BOUND })), {
        count: PG_BOUND,
        exact: true,
        capped: true,
      });
      assert.equal(await scanned(seen.filter((statement) => statement.text.includes('AS bounded')).at(-1)!), PG_BOUND + 1);
      assert.deepEqual(
        await ok(call('/api/count', { table: 'ticket' })),
        { count: PG_DESK_TWO, exact: true },
        'unbounded, the App path counts exactly: there is no estimate to fall back to',
      );
      const run = await ok(call('/api/run', { q: 'ticket', limit: 1, countLimit: PG_BOUND }));
      assert.deepEqual([run.total, run.exactTotal, run.cappedTotal, run.rows.length], [PG_BOUND, true, true, 1]);
      const narrowed = await ok(call('/api/run', { q: 'ticket id < 100', limit: 1, countLimit: PG_BOUND }));
      assert.equal(Object.hasOwn(narrowed, 'cappedTotal'), false);
      assert.ok(narrowed.total > 0 && narrowed.total < 100, String(narrowed.total));
    } finally {
      await close();
      await policy?.retire();
      await registry.closeAll();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
