/**
 * A board's lanes in one statement, and an order that puts empty values last
 * on every engine.
 *
 * A board read each lane apiece: five or eight statements of one shape every
 * time it opened (the observer's N+1). `lanes: { by, limit }` on a read is
 * the first `limit` rows of each value of `by`, in the read's order, as one
 * ROW_NUMBER window (adapter.ts lanesStatement), plain and row-scoped alike.
 * `sort due_on nulls last` says where an undated row goes the one way every
 * engine reads; SQLite and MySQL put it first going up, PostgreSQL last.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import type { Adapter, QueryRequest } from '../packages/engine/src/adapters/adapter.js';
import type { ViewDef } from '../packages/engine/src/shared/view.js';
import { parseQuery } from '../packages/engine/src/shared/query.js';
import { textToView } from '../packages/engine/src/shared/viewtext.js';
import { LANE_ROW } from '../packages/engine/src/adapters/adapter.js';
import { liveSkip } from './live.js';

/* Six jobs: three new (one undated), two scheduled, one done. */
const ROWS = [
  [1, 'new', '2026-03-05', 'b'],
  [2, 'new', null, 'a'],
  [3, 'new', '2026-03-01', 'a'],
  [4, 'scheduled', '2026-03-02', 'b'],
  [5, 'scheduled', '2026-03-09', 'a'],
  [6, 'done', '2026-02-01', 'a'],
] as const;

async function proves(adapter: Adapter & { scopeReads?: Adapter['scopeReads'] }, job: string) {
  const schema = await adapter.introspect();
  const read = (text: string) => parseQuery(text, { schema }).query!;
  const q = read(`${job} sort due_on nulls last`);
  assert.deepEqual(q.orderBy, [{ column: 'due_on', direction: 'asc', nulls: 'last' }]);

  /* The undated job last, going up and going down. */
  const order = async (text: string) =>
    (await adapter.query({ ...read(text), limit: 10, offset: 0 } as QueryRequest)).rows.map((row) => Number(row.id));
  assert.deepEqual(await order(`${job} sort due_on nulls last, id`), [6, 3, 4, 1, 5, 2]);
  assert.deepEqual(await order(`${job} sort due_on desc nulls last, id`), [5, 1, 4, 3, 6, 2]);

  /* Every lane's first two, one statement, in the read's order; the number they were kept by never leaves. */
  const lanes = await adapter.query({ ...q, lanes: { by: 'status', limit: 2 }, limit: 100, offset: 0 } as QueryRequest);
  const byLane = (rows: Array<Record<string, unknown>>) => {
    const out: Record<string, number[]> = {};
    for (const row of rows) (out[String(row.status)] ??= []).push(Number(row.id));
    return out;
  };
  assert.deepEqual(byLane(lanes.rows), { new: [3, 1], scheduled: [4, 5], done: [6] });
  assert.ok(!lanes.columns.includes(LANE_ROW) && lanes.rows.every((row) => !(LANE_ROW in row)), lanes.columns.join());
  /* A projection and a filter read through it as through any read. */
  const narrowed = await adapter.query({
    ...read(`${job} owner = a show id, status sort due_on nulls last`),
    lanes: { by: 'status', limit: 1 },
    limit: 100,
    offset: 0,
  } as QueryRequest);
  assert.deepEqual(narrowed.columns, ['id', 'status']);
  assert.deepEqual(byLane(narrowed.rows), { new: [3], scheduled: [5], done: [6] });
  /* A page across lanes cuts every lane evenly: the first of each before any second. */
  const cut = await adapter.query({ ...q, lanes: { by: 'status', limit: 2 }, limit: 3, offset: 0 } as QueryRequest);
  assert.deepEqual(cut.rows.map((row) => row.status).sort(), ['done', 'new', 'scheduled']);

  /* A list that names a path is read as a view, and its lanes the same one way. */
  const view = (limit: number) =>
    ({
      id: 'lanes',
      name: 'lanes',
      base: job,
      columns: [{ path: 'id' }, { path: 'status' }],
      orderBy: [{ path: 'due_on', direction: 'asc', nulls: 'last' }],
      lanes: { by: 'status', limit },
      limit: 100,
    }) as ViewDef;
  const viewed = await adapter.runView!(view(2));
  assert.deepEqual(viewed.columns, ['id', 'status']);
  assert.ok(viewed.rows.every((row) => !(LANE_ROW in row)));
  assert.deepEqual(byLane(viewed.rows), { new: [3, 1], scheduled: [4, 5], done: [6] });

  /* Row-scoped, as an App's reader with a policy reads: only the rows in scope are numbered. */
  if (adapter.scopeReads) {
    const scoped = await adapter.scopeReads({ [job]: { groups: [[{ column: 'owner', op: '=', value: 'a' }]] } });
    const mine = await scoped.query({ ...q, lanes: { by: 'status', limit: 5 }, limit: 100, offset: 0 } as QueryRequest);
    assert.deepEqual(byLane(mine.rows), { new: [3, 2], scheduled: [5], done: [6] });
    assert.deepEqual(byLane((await scoped.runView!(view(5))).rows), { new: [3, 2], scheduled: [5], done: [6] });
  }

  /* The view planner reads the grammar too (a path in the text makes the read a view). */
  const planned = textToView(schema, `${job} sort due_on nulls last, id`).view!;
  assert.deepEqual(planned.orderBy?.[0], { path: 'due_on', direction: 'asc', nulls: 'last' });
}

test('SQLite: lanes in one statement, and empty dates last', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-lanes-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'lanes.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE job (id INTEGER PRIMARY KEY, status TEXT NOT NULL, due_on DATE, owner TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO job VALUES (?, ?, ?, ?)');
  for (const row of ROWS) insert.run(...row);
  db.close();
  const adapter = new SqliteAdapter(file);
  try {
    await proves(adapter, 'job');
  } finally {
    await adapter.close();
  }
});

const PG = process.env.TABLEWALK_TEST_PG;
describe('PostgreSQL: lanes in one statement, and empty dates last', { skip: liveSkip('postgres', PG) }, () => {
  const job = `tw_lanes_job_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  let adapter: PostgresAdapter;
  type Client = { connect(): Promise<void>; query(text: string, params?: unknown[]): Promise<unknown>; end(): Promise<void> };
  const client = async (): Promise<Client> => {
    const specifier = 'pg';
    const pg = (await import(specifier)) as {
      Client?: new (o: { connectionString: string }) => Client;
      default?: { Client: new (o: { connectionString: string }) => Client };
    };
    const Made = pg.Client ?? pg.default!.Client;
    const made = new Made({ connectionString: PG! });
    await made.connect();
    return made;
  };
  before(async () => {
    const db = await client();
    try {
      await db.query(`CREATE TABLE public.${job} (id integer PRIMARY KEY, status text NOT NULL, due_on date, owner text NOT NULL)`);
      for (const row of ROWS) await db.query(`INSERT INTO public.${job} VALUES ($1, $2, $3, $4)`, [...row]);
    } finally {
      await db.end();
    }
    adapter = new PostgresAdapter(PG!, 'lanes');
  });
  after(async () => {
    await adapter?.close();
    const db = await client();
    try {
      await db.query(`DROP TABLE IF EXISTS public.${job}`);
    } finally {
      await db.end();
    }
  });
  test('the same rows here', async () => {
    const schema = await adapter.introspect();
    await proves(adapter, schema.tables.find((table) => table.name === job)!.id);
  });
});
