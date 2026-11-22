/**
 * A page loader reads the App's computed columns and rollups beside a row's own (`db.account.where(…).with('balance',
 * 'open_alerts')`, pageLoaders.ts): a field report's page spent about 350 ms of follow-up reads working out a balance and
 * an alert count that the App's lists already work out in SQL. The read is a view through the reader a list reads
 * through, so its values are the list's, its statement is one, and its grants and row policy are the list's.
 * SQLite always; PostgreSQL when `TABLEWALK_TEST_PG` names a disposable server (the schema `loader_with`, dropped
 * before and after).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import type { Adapter } from '../packages/engine/src/adapters/adapter.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { accessibleSchema } from '../packages/engine/src/server/columnGrants.js';
import { readView } from '../packages/engine/src/server/resourceReadOperations.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { withRollups } from '../packages/mistri/src/shared/app.js';
import { checkPageLoaders } from '../packages/mistri/src/server/app/pageLoaderCheck.js';
import { commandCatalog, createCommandDb } from '../packages/mistri/src/server/commands/commandDb.js';
import { runPageLoader } from '../packages/mistri/src/server/commands/pageLoaderRun.js';
import { defineLoader, defineLoaders, type PageLoader } from '../packages/mistri/src/server/commands/pageLoaders.js';
import { liveSkip } from './live.js';
import { parseTestApp } from './support/commandCatalog.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const SCHEMA = 'loader_with';
const NOW = new Date('2026-09-27T15:00:00Z');

/* Three accounts. Billed - paid: 70, 0, -5. Open alerts: 2, 0, 1 (a closed one on account 2 does not count). */
function statements(postgres: boolean): string[] {
  const [no, yes] = postgres ? ['false', 'true'] : ['0', '1'];
  return [
    `CREATE TABLE account (id INTEGER PRIMARY KEY, name TEXT NOT NULL, billed INTEGER NOT NULL, paid INTEGER NOT NULL, region TEXT NOT NULL)`,
    `CREATE TABLE alert (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES account(id), open BOOLEAN NOT NULL)`,
    `INSERT INTO account VALUES (1, 'a', 100, 30, 'west'), (2, 'b', 50, 50, 'east'), (3, 'c', 5, 10, 'west')`,
    `INSERT INTO alert VALUES (1, 1, ${yes}), (2, 1, ${yes}), (3, 2, ${no}), (4, 3, ${yes})`,
  ];
}

const APP = {
  id: 'desk',
  name: 'Desk',
  resources: {
    account: {
      rollups: { open_alerts: { fn: 'count', from: 'alert', query: 'open = true' } },
      computed: {
        balance: { type: 'number', value: 'billed - paid' },
        flagged: { type: 'boolean', value: 'open_alerts > 0' },
      },
    },
    alert: {},
  },
  views: {
    accounts: { kind: 'list', from: 'account' },
    board: {
      kind: 'page',
      label: 'Board',
      component: { id: 'page-board', module: './pages/board.page.tsx', kind: 'page' },
      reads: ['account', 'alert'],
      loader: 'board',
    },
  },
  home: 'accounts',
  nav: ['accounts', 'board'],
};
const app = parseTestApp(APP, 'desk');

interface World {
  id(table: string): string;
  readonly adapter: SqliteAdapter | PostgresAdapter;
  close(): Promise<void>;
}

async function sqliteWorld(): Promise<World> {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-loader-with-'));
  const file = join(directory, 'data.db');
  const db = new DatabaseSync(file);
  for (const statement of statements(false)) db.exec(statement);
  const adapter = new SqliteAdapter(file, 'lw');
  return {
    id: (table) => table,
    adapter,
    async close() {
      await adapter.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function postgresWorld(): Promise<World> {
  const specifier = 'pg';
  const pg = (await import(specifier)) as { default?: { Client: never }; Client?: never };
  const Client = (pg.Client ?? pg.default?.Client)! as new (c: unknown) => {
    connect(): Promise<void>;
    query(sql: string): Promise<unknown>;
    end(): Promise<void>;
  };
  const control = new Client({ connectionString: LIVE, statement_timeout: 60_000 });
  await control.connect();
  await control.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  await control.query(`SET search_path TO ${SCHEMA}`);
  for (const statement of statements(true)) await control.query(statement);
  const adapter = new PostgresAdapter(LIVE!, 'lw', [SCHEMA]);
  return {
    id: (table) => `${SCHEMA}.${table}`,
    adapter,
    async close() {
      await adapter.close();
      await control.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await control.end();
    },
  };
}

type Row = Record<string, unknown>;
type Handle = { where(where?: unknown): { with(...names: string[]): PromiseLike<Row[]> & { orderBy(c: string): PromiseLike<Row[]> } } };
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function proofs(open: () => Promise<World>, label: string, skip: false | string = false) {
  describe(`a loader's .with on ${label}`, { skip }, () => {
    let w: World;
    before(async () => {
      w = await open();
    });
    after(async () => {
      await w?.close();
    });

    /** The catalog the App serves a reader, as http/source.ts makes it: the reader's grants cut, then rollups and computed columns. */
    const served = async (cut?: (schema: DatabaseSchema) => DatabaseSchema) => {
      const full = await w.adapter.introspect();
      return withRollups(app, cut ? cut(full) : full, NOW);
    };
    const load = async (
      reads: string[],
      body: (db: Record<string, Handle>) => Promise<unknown>,
      options: { schema?: DatabaseSchema; reader?: Pick<Adapter, 'query' | 'count' | 'aggregate' | 'runView'> } = {},
    ) =>
      runPageLoader({
        name: 'board',
        loader: defineLoader({ reads, load: ({ db }: { db: Record<string, Handle> }) => body(db) } as never) as unknown as PageLoader,
        reader: options.reader ?? w.adapter,
        schema: options.schema ?? (await served()),
        params: {},
        viewer: { roles: [] },
        now: NOW,
      });

    /** What the account list shows for the same rows, through the reader the loader reads through. */
    const list = async (schema: DatabaseSchema, reader: Pick<Adapter, 'runView'> = w.adapter) => {
      const view = {
        id: 'list',
        name: 'list',
        base: w.id('account'),
        columns: ['id', 'balance', 'open_alerts', 'flagged'].map((path) => ({ path })),
        orderBy: [{ path: 'id', direction: 'asc' as const }],
        limit: 100,
      };
      const read = await readView(reader as never, schema, view, {}, 'none');
      return json(read.result.rows as Row[]);
    };
    const wanted = (rows: Row[]) => rows.map(({ id, balance, open_alerts, flagged }) => ({ id, balance, open_alerts, flagged }));

    test('a computed column and a rollup come back as the list shows them, beside the row’s own columns', async () => {
      const schema = await served();
      const answer = (await load(['account', 'account.balance', 'account.open_alerts', 'account.flagged'], async (db) =>
        db.account!.where().with('balance', 'open_alerts', 'flagged').orderBy('id'),
      )) as Row[];
      assert.deepEqual(wanted(answer), await list(schema));
      assert.ok(
        answer.some((row) => Number(row.open_alerts) > 0) && answer.some((row) => Number(row.balance) < 0),
        'the fixture has an alert count and a negative balance, so the comparison is not of empty values',
      );
      // The row's own columns are there too, as a plain read has them.
      assert.deepEqual(
        answer.map((row) => row.name),
        ['a', 'b', 'c'],
      );
      // A where over stored columns and a computed one narrows the same read; its order and limit are the query's.
      const flagged = (await load(['account', 'account.balance', 'account.open_alerts'], async (db) =>
        db.account!.where({ region: 'west', balance: { gt: -10 } }).with('balance', 'open_alerts'),
      )) as Row[];
      assert.deepEqual(flagged.map((row) => Number(row.id)).sort(), [1, 3]);
    });

    test('one .with read is one database query', async () => {
      const calls: string[] = [];
      const counting = new Proxy(w.adapter, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver);
          if (typeof value !== 'function' || !['query', 'count', 'aggregate', 'runView', 'countView'].includes(String(key))) return value;
          return (...args: unknown[]) => {
            calls.push(String(key));
            return value.apply(target, args);
          };
        },
      });
      await load(['account', 'account.balance', 'account.open_alerts'], async (db) => db.account!.where().with('balance', 'open_alerts'), {
        reader: counting,
      });
      assert.deepEqual(calls, ['runView']);
    });

    test("the reader's row policy narrows it as it narrows a list", async () => {
      const schema = await served();
      const scope: RowScope = { [w.id('account')]: { groups: [[{ column: 'region', op: '=', value: 'west' }]] }, [w.id('alert')]: true };
      const reader = await w.adapter.scopeReads(scope);
      const answer = (await load(
        ['account', 'account.balance', 'account.open_alerts', 'account.flagged'],
        async (db) => db.account!.where().with('balance', 'open_alerts', 'flagged').orderBy('id'),
        { reader: reader as never },
      )) as Row[];
      assert.deepEqual(wanted(answer), await list(schema, reader));
      assert.deepEqual(
        answer.map((row) => Number(row.id)),
        [1, 3],
      );
    });

    test("a command's db has no .with: its reads are stored columns, whatever it is told", async () => {
      const catalog = commandCatalog(await served(), ['account'], (local) => w.id(local))!;
      const tx = {
        query: (request: never) => w.adapter.query({ ...(request as object), table: w.id('account') } as never),
        count: async () => 0,
      };
      const db = createCommandDb({ tx: tx as never, catalog, read: ['account'], write: [], now: () => NOW }) as unknown as Record<
        string,
        Handle
      >;
      await assert.rejects(async () => db.account!.where().with('balance'), {
        name: 'BusinessCommandExecutionError',
        code: 'invalid_result',
      });
    });

    test('a name the loader did not declare is refused when it runs, saying what to list', async () => {
      await assert.rejects(
        load(['account', 'account.balance'], async (db) => db.account!.where().with('open_alerts')),
        (error: { code?: string; status?: number; message?: string }) => error.code === 'loader_refused' && error.status === 422,
      );
      // Not at all, with no declared name: the reads alone name tables.
      await assert.rejects(
        load(['account'], async (db) => db.account!.where().with('balance')),
        (error: { code?: string }) => error.code === 'loader_refused',
      );
      // A command's db reads stored columns: the same handle with no loader's reads behind it has no `.with`.
      await assert.rejects(
        load(['account', 'account.nothing'], async (db) => db.account!.where().with('nothing')),
        (error: { code?: string; status?: number }) => error.code === 'loader_refused' && error.status === 403,
        'a declared name the reader is not served is refused as a list has no such column',
      );
    });

    test('a computed column reading a field outside the reader’s grant is refused, as a list does not serve it', async () => {
      // This reader may not read `paid`: `balance` (billed - paid) is not served to them, so a loader cannot ask for it.
      const grant = (schema: DatabaseSchema) => {
        const id = (table: string) => schema.tables.find((each) => each.name === table)!.id;
        return accessibleSchema(schema, {
          readable: new Set([id('account'), id('alert')]),
          writable: new Set<string>(),
          fields: new Map([[id('account'), { read: new Set(['id', 'name', 'billed', 'region']), write: new Set<string>() }]]),
        });
      };
      const schema = await served(grant);
      const table = schema.tables.find((each) => each.name === 'account')!;
      assert.equal(table.computed?.balance, undefined, 'the list is not served it either');
      await assert.rejects(
        load(['account', 'account.balance'], async (db) => db.account!.where().with('balance'), { schema }),
        (error: { code?: string; status?: number }) => error.code === 'loader_refused' && error.status === 403,
      );
      // What the grant does not touch still reads.
      const open = (await load(['account', 'account.open_alerts'], async (db) => db.account!.where().with('open_alerts').orderBy('id'), {
        schema,
      })) as Row[];
      assert.deepEqual(
        open.map((row) => Number(row.open_alerts)),
        [2, 0, 1],
      );
    });
  });
}

describe('what check says of a loader’s .with names', () => {
  const loaders = (reads: string[]) =>
    defineLoaders({ board: defineLoader({ reads: reads as never, load: () => null }) }) as unknown as Readonly<Record<string, PageLoader>>;

  test('a computed column or rollup of the table the App declares passes; an unknown or misplaced one is named', () => {
    assert.doesNotThrow(() => checkPageLoaders(app, loaders(['account', 'account.balance', 'account.open_alerts']), 'desk'));
    assert.throws(
      () => checkPageLoaders(app, loaders(['account', 'account.nothing']), 'desk'),
      /\[page-loader\].*its loader "board" reads "account\.nothing", which is no computed column or rollup of "account" \(it has balance, flagged, open_alerts\)/,
    );
    assert.throws(
      () => checkPageLoaders(app, loaders(['account', 'alert', 'alert.balance']), 'desk'),
      /\[page-loader\].*reads "alert\.balance", which is no computed column or rollup of "alert"/,
    );
  });

  test('a derived name needs its table among the reads, and is read as one entry of them', () => {
    assert.throws(() => defineLoader({ reads: ['account.balance'] as never, load: () => null }), /list "account" in reads too/);
    const loader = defineLoader({ reads: ['account', 'account.balance', 'account.balance', 'alert'], load: () => null });
    assert.deepEqual([...loader.reads], ['account', 'alert']);
    assert.deepEqual(JSON.parse(JSON.stringify(loader.derived)), { account: ['balance'] });
  });
});

proofs(sqliteWorld, 'SQLite');
proofs(postgresWorld, 'PostgreSQL', liveSkip('postgres', LIVE));
