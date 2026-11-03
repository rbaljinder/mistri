/**
 * A command's sums and means say the same thing on SQLite and PostgreSQL: a decimal column's places come from its
 * declared type on one and from the catalog's numeric scale on the other, so an empty set and a set with rows both
 * answer with them (the column's places, an average two more), and a float column answers a number on both. The
 * PostgreSQL half runs when TABLEWALK_TEST_PG names a server.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { Adapter } from '../packages/engine/src/adapters/adapter.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { avg, commandCatalog, createCommandDb, max, min, sum } from '../packages/mistri/src/server/commands/commandDb.js';

const PG = process.env.TABLEWALK_TEST_PG;
const ROWS = [
  [1, 'a', '0.001', '10.10', 0.1, '0.00075'],
  [2, 'a', '0.002', '0.25', 0.2, '0.00075'],
  [3, 'b', '0.004', '123456789012.45', 0.3, '0.00075'],
] as const;
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

/** The answers of one engine, through the command handle on a raw transaction. */
async function answers(adapter: Adapter, table: string) {
  const schema = await adapter.introspect();
  const catalog = commandCatalog(schema, ['t'], () => table)!;
  return adapter.transaction!(async (raw) => {
    const tx = {
      query: (r: never) => raw.query({ ...(r as object), table } as never),
      count: (_: string, f: never) => raw.count(table, f),
      aggregate: (r: never) => raw.aggregate!({ ...(r as object), table } as never),
    };
    const db = createCommandDb({ tx: tx as never, catalog, read: ['t'], write: [], now: () => new Date() }) as Record<string, any>;
    const measures = {
      wide: sum('wide'),
      wideMean: avg('wide'),
      money: sum('money'),
      moneyMean: avg('money'),
      hi: max('money'),
      lo: min('money'),
    };
    return plain({
      scales: catalog.t.meta.columns.map((c) => [c.name, c.type]),
      empty: await db.t.where({ grp: 'none' }).aggregate(measures),
      full: await db.t.where().aggregate(measures),
      grouped: await db.t.where().groupBy('grp').aggregate(measures).orderBy('grp'),
      unconstrained: await db.t.where().aggregate({ s: sum('u'), m: avg('u') }),
      floats: await db.t.where().aggregate({ s: sum('f'), m: avg('f') }),
      emptyFloats: await db.t.where({ grp: 'none' }).aggregate({ s: sum('f'), m: avg('f') }),
    });
  });
}

test('a decimal’s places are the same on SQLite and PostgreSQL, over no rows and over some', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-aggregate-engines-'));
  const file = join(directory, 'engines.db');
  const db = new DatabaseSync(file);
  db.exec(
    `CREATE TABLE t (id INTEGER PRIMARY KEY, grp TEXT NOT NULL, wide NUMERIC(38,18) NOT NULL, money NUMERIC(14,2) NOT NULL, f REAL NOT NULL, u NUMERIC NOT NULL)`,
  );
  for (const row of ROWS) db.prepare('INSERT INTO t VALUES (?, ?, ?, ?, ?, ?)').run(...row);
  const sqlite = new SqliteAdapter(file, 'engines');
  t.after(async () => {
    await sqlite.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const lite = await answers(sqlite, 't');
  assert.equal(lite.empty.wide, '0.000000000000000000');
  assert.equal(lite.empty.wideMean, null);
  assert.equal(lite.empty.money, '0.00');
  assert.equal(lite.full.wide, '0.007000000000000000');
  assert.ok(Math.abs(lite.floats.s - 0.6) < 1e-9 && typeof lite.floats.m === 'number', 'a float sums to a number');
  assert.deepEqual(lite.emptyFloats, { s: 0, m: null });
  assert.equal(typeof lite.unconstrained.m, 'number', 'a NUMERIC with no places is a float on SQLite');

  if (!PG) return t.skip('TABLEWALK_TEST_PG names no server');
  const name = `agg_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  type Client = { connect(): Promise<void>; query(text: string, values?: unknown[]): Promise<unknown>; end(): Promise<void> };
  const specifier = 'pg';
  const driver = (await import(specifier)) as {
    Client?: new (o: { connectionString: string }) => Client;
    default?: { Client: new (o: { connectionString: string }) => Client };
  };
  const other = new (driver.Client ?? driver.default!.Client)({ connectionString: PG });
  await other.connect();
  const postgres = new PostgresAdapter(PG, 'engines');
  try {
    await other.query(
      `CREATE TABLE public.${name} (id bigint PRIMARY KEY, grp text NOT NULL, wide numeric(38,18) NOT NULL, money numeric(14,2) NOT NULL, f double precision NOT NULL, u numeric NOT NULL)`,
    );
    for (const row of ROWS) await other.query(`INSERT INTO public.${name} VALUES ($1, $2, $3, $4, $5, $6)`, [...row]);
    const live = await answers(postgres, `public.${name}`);
    // Same places on an empty set, a set with rows and each group; the mean is the exact sum over the count, to places + 2.
    assert.deepEqual(live.empty, lite.empty);
    assert.deepEqual(live.full, lite.full);
    assert.deepEqual(live.grouped, lite.grouped);
    // A float's digits differ by engine (SQLite compensates its sum, PostgreSQL does not): both are numbers.
    assert.ok(Math.abs(live.floats.s - 0.6) < 1e-9 && typeof live.floats.m === 'number');
    assert.deepEqual(live.emptyFloats, lite.emptyFloats);
    // An unconstrained numeric is exact on PostgreSQL, and its mean is PostgreSQL’s own text, not two places (0.00).
    assert.equal(live.unconstrained.s, '0.00225');
    assert.match(live.unconstrained.m, /^0\.00075(0*)$/);
    assert.match(live.full.wideMean, /^0\.\d{20}$/, 'numeric(38,18) means say 20 places');
    assert.match(live.full.moneyMean, /^\d+\.\d{4}$/, 'numeric(14,2) means say 4 places');
  } finally {
    await postgres.close();
    await other.query(`DROP TABLE IF EXISTS public.${name}`).finally(() => other.end());
  }
});
