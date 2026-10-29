/**
 * The query bar's list paged by key (keysetPage.ts, keysetReadHttp.ts): every
 * page reached by stepping after the last row, or back before the first, or
 * from the end, is the page an offset would have read — nulls, ties and a
 * sort column the list does not show included — and a step costs what the
 * first page costs.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Registry } from '../packages/engine/src/server/connections.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { dispatchResourceReadHttp, MAX_PAGE_OFFSET } from '../packages/engine/src/server/resourceReadHttp.js';
import type { Adapter } from '../packages/engine/src/adapters/adapter.js';
import type { DatabaseSchema, Dialect, Order, TableMeta } from '../packages/engine/src/shared/schema.js';
import { keysetAfter, reversedOrder, type Boundary } from '../packages/engine/src/shared/keysetPage.js';
import { liveSkip } from './live.js';
import { LIVE_PG, ownedPostgresDatabase } from './support/jobStoreEngines.js';

type Row = Record<string, unknown>;
const ROWS = 237,
  SIZE = 20;
// A vocabulary declared out of alphabetical order, and NULL beside it.
const STAGES = ['new', 'qualified', 'won', 'lost', null] as const;

async function sqliteSource(t: { after(fn: () => unknown): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-keyset-'));
  const file = join(directory, 'list.db'),
    db = new DatabaseSync(file);
  db.exec(`CREATE TABLE team (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE item (id INTEGER PRIMARY KEY, team_id INTEGER REFERENCES team(id), score INTEGER, name TEXT NOT NULL, due TEXT,
      stage TEXT CHECK (stage IN ('new', 'qualified', 'won', 'lost')));
    CREATE INDEX item_score ON item (score);
    INSERT INTO team VALUES (1, 'North'), (2, 'South');`);
  const insert = db.prepare('INSERT INTO item VALUES (?, ?, ?, ?, ?, ?)');
  for (let id = 1; id <= ROWS; id++) {
    insert.run(
      id,
      1 + (id % 2),
      id % 5 === 0 ? null : id % 7,
      `Item ${String((id * 37) % 101).padStart(3, '0')}`,
      id % 3 === 0 ? null : `2026-0${1 + (id % 9)}-1${id % 10}`,
      STAGES[id % 5],
    );
  }
  db.close();
  const registry = new Registry();
  registry.add({ id: 'list', name: 'list', url: file, writable: false, source: 'config' });
  const { adapter } = await registry.open('list');
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return { adapter, schema: await adapter.introspect(), registry };
}

/** The same rows in PostgreSQL, whose NULLs sort last ascending where SQLite's sort first. */
async function postgresSource() {
  const url = await ownedPostgresDatabase();
  const setup = new PostgresAdapter(url, 'Owned keyset setup');
  const write = (text: string) => setup.runSql({ text, write: true, limit: 1 });
  await write('DROP TABLE IF EXISTS item');
  await write('DROP TABLE IF EXISTS team');
  await write('CREATE TABLE team (id integer PRIMARY KEY, name text NOT NULL)');
  await write(`INSERT INTO team VALUES (1, 'North'), (2, 'South')`);
  await write(`CREATE TABLE item (id integer PRIMARY KEY, team_id integer REFERENCES team(id), score integer, name text NOT NULL, due date,
    stage text CHECK (stage IN ('new', 'qualified', 'won', 'lost')))`);
  await write('CREATE INDEX item_score ON item (score)');
  await write(`INSERT INTO item SELECT id, 1 + id % 2, CASE WHEN id % 5 = 0 THEN NULL ELSE id % 7 END,
    'Item ' || lpad(((id * 37) % 101)::text, 3, '0'), CASE WHEN id % 3 = 0 THEN NULL ELSE make_date(2026, 1 + id % 9, 10 + id % 10) END,
    (ARRAY['new', 'qualified', 'won', 'lost', NULL])[1 + id % 5]
    FROM generate_series(1, ${ROWS}) id`);
  await setup.close();
  const registry = new Registry();
  registry.add({ id: 'pglist', name: 'pglist', url, writable: false, source: 'config' });
  const { adapter } = await registry.open('pglist');
  return { adapter, schema: await adapter.introspect(), registry };
}

async function run(adapter: Adapter, schema: DatabaseSchema, body: Record<string, unknown>) {
  const answer = await dispatchResourceReadHttp('/api/run', { count: 'none', ...body }, adapter, schema, {
    app: undefined,
    now: () => new Date('2026-09-25T12:00:00Z'),
  });
  return answer!.body as {
    rows: Row[];
    columns: string[];
    bounds?: { first: Row; last: Row };
    keyset?: true;
    errors?: unknown[];
    sql?: { text: string };
  };
}

/** Every page, stepped after each last row, then back before each first; and the last page from the end. */
async function walk(adapter: Adapter, schema: DatabaseSchema, q: string) {
  const whole = (await run(adapter, schema, { q, limit: 1000 })).rows;
  assert.equal(whole.length, ROWS, q);
  const pages: Row[][] = [];
  let reply = await run(adapter, schema, { q, limit: SIZE, offset: 0 });
  pages.push(reply.rows);
  while (reply.rows.length === SIZE && pages.length * SIZE < ROWS) {
    assert.ok(reply.bounds, `${q}: a page says its bounds`);
    reply = await run(adapter, schema, { q, limit: SIZE, offset: pages.length * SIZE, after: reply.bounds.last });
    assert.equal(reply.keyset, true, `${q}: stepped by key`);
    pages.push(reply.rows);
  }
  assert.deepEqual(pages.flat(), whole, `${q}: the pages after each other are the list`);
  // Back from the last page to the first, each before the page it came from.
  for (let at = pages.length - 1; at > 0; at--) {
    const before = await run(adapter, schema, {
      q,
      limit: SIZE,
      offset: (at - 1) * SIZE,
      before: pages[at].length ? (await run(adapter, schema, { q, limit: SIZE, offset: at * SIZE })).bounds!.first : {},
    });
    assert.deepEqual(before.rows, pages[at - 1], `${q}: page ${at} read before page ${at + 1}`);
  }
  const remainder = ROWS % SIZE || SIZE;
  const end = await run(adapter, schema, { q, limit: remainder, end: true });
  assert.deepEqual(end.rows, pages.at(-1), `${q}: the end is the last page`);
  return whole;
}

test('pages stepped by key are the pages an offset reads, in every order a list takes', async (t) => {
  const { adapter, schema } = await sqliteSource(t);
  for (const q of [
    'item',
    'item sort score',
    'item sort score desc',
    'item sort name desc',
    'item sort due',
    'item sort due desc, score',
    'item sort stage',
    'item sort stage desc',
    'item sort score, stage desc',
  ]) {
    await walk(adapter, schema, q);
  }
  // A sort the list does not show is read for the boundary and not sent.
  const shown = await run(adapter, schema, { q: 'item show name sort score', limit: SIZE });
  assert.deepEqual(shown.columns, ['name']);
  assert.deepEqual(Object.keys(shown.rows[0]), ['name']);
  assert.deepEqual(Object.keys(shown.bounds!.last).sort(), ['id', 'score']);
  await walk(adapter, schema, 'item show name sort score');
  // A view the bar falls through to (a path through a reference) pages by key on its own columns.
  await walk(adapter, schema, 'item show name, team_id.name sort score desc');
});

/** The distinct values in the order a list met them. */
const stages = (rows: Row[]) => [...new Set(rows.map((row) => row.stage))];

test('a vocabulary sorts in the order it was declared, NULL after it, and pages by key', async (t) => {
  const { adapter, schema } = await sqliteSource(t);
  assert.deepEqual(stages(await walk(adapter, schema, 'item sort stage')), ['new', 'qualified', 'won', 'lost', null]);
  assert.deepEqual(stages(await walk(adapter, schema, 'item sort stage desc')), [null, 'lost', 'won', 'qualified', 'new']);
  // A view (a path through a reference) says the same order.
  const view = await run(adapter, schema, { q: 'item show name, stage, team_id.name sort stage', limit: 1000 });
  assert.deepEqual(stages(view.rows), ['new', 'qualified', 'won', 'lost', null]);
  // Free text sorts as text.
  const names = (await run(adapter, schema, { q: 'item sort name', limit: 1000 })).rows.map((row) => row.name as string);
  assert.deepEqual(names, [...names].sort());
});

test('an order that cannot page by key pages by offset, and meets the ceiling', async (t) => {
  const { adapter, schema } = await sqliteSource(t);
  // Sorted through a reference: no boundary is offered, and a step is an offset.
  const through = await run(adapter, schema, { q: 'item show name, team_id.name sort team_id.name', limit: SIZE });
  assert.equal(through.bounds, undefined);
  const stepped = await run(adapter, schema, {
    q: 'item show name, team_id.name sort team_id.name',
    limit: SIZE,
    offset: SIZE,
    after: { x: 1 },
  });
  assert.equal(stepped.keyset, undefined);
  const deep = await run(adapter, schema, {
    q: 'item show name, team_id.name sort team_id.name',
    limit: SIZE,
    offset: MAX_PAGE_OFFSET + 1,
    after: { x: 1 },
  });
  assert.equal(deep.errors?.length, 1);
  // A boundary missing a column, or naming null for one that cannot hold it, is not a boundary.
  const partial = await run(adapter, schema, { q: 'item sort score', limit: SIZE, offset: MAX_PAGE_OFFSET + SIZE, after: { score: 3 } });
  assert.equal(partial.errors?.length, 1);
  // A deep page by key is not an offset at all.
  const keyed = await run(adapter, schema, {
    q: 'item sort score',
    limit: SIZE,
    offset: MAX_PAGE_OFFSET + SIZE,
    after: { score: 3, id: 10 },
  });
  assert.equal(keyed.keyset, true);
  assert.ok(keyed.rows.length > 0);
  const malformed = await dispatchResourceReadHttp('/api/run', { q: 'item', after: [1], limit: 1 }, adapter, schema, {
    app: undefined,
    now: () => new Date(),
  });
  assert.equal(malformed!.status, 400);
});

test('on PostgreSQL too, where NULL sorts the other way', { skip: liveSkip('postgres', LIVE_PG) }, async () => {
  const { adapter, schema } = await postgresSource();
  try {
    for (const q of [
      'item',
      'item sort score',
      'item sort score desc',
      'item sort due desc, score',
      'item show name sort score',
      'item show name, team_id.name sort score desc',
      'item sort stage',
      'item sort stage desc',
      'item sort score, stage desc',
    ])
      await walk(adapter, schema, q);
    assert.deepEqual(stages(await walk(adapter, schema, 'item sort stage')), ['new', 'qualified', 'won', 'lost', null]);
  } finally {
    await adapter.close();
  }
});

/* The continuation read in JavaScript, against each engine's own placement
   of NULL: every row after the boundary, and none before it or at it. */
test("a continuation is exactly the rows past its boundary, under each engine's NULL placement", () => {
  const table = {
    id: 't',
    name: 't',
    schema: '',
    isView: false,
    columns: [
      { name: 'id', type: 'integer', nullable: false, primaryKey: true },
      { name: 'a', type: 'integer', nullable: true, primaryKey: false },
      { name: 'b', type: 'text', nullable: true, primaryKey: false },
      { name: 'c', type: 'text', nullable: true, primaryKey: false, allowed: ['z', 'a', 'm'] },
    ],
  } as TableMeta;
  const rows: Row[] = Array.from({ length: 60 }, (_, i) => ({
    id: i + 1,
    a: i % 4 === 0 ? null : i % 3,
    b: i % 5 === 0 ? null : `v${i % 4}`,
    c: (['z', 'a', 'm', null] as const)[(i % 7) % 4],
  }));
  // A vocabulary sorts as declared, NULL after its last value on every engine.
  const rank = (value: unknown) => (value === null ? 3 : ['z', 'a', 'm'].indexOf(value as string));
  const holds = (row: Row, term: { column: string; op: string; value?: unknown }) => {
    const v = row[term.column] as number | string | null;
    if (term.op === 'isNull') return v === null;
    if (term.op === 'isNotNull') return v !== null;
    if (v === null) return false;
    if (term.op === 'in') return (term.value as unknown[]).includes(v);
    const w = term.value as number | string;
    return term.op === '=' ? v === w : term.op === '>' ? v > w : term.op === '<' ? v < w : term.op === '>=' ? v >= w : v <= w;
  };
  for (const dialect of ['sqlite', 'postgres'] as Dialect[]) {
    const high = dialect === 'postgres';
    const compare = (order: Order[]) => (x: Row, y: Row) => {
      for (const o of order) {
        const p = x[o.column] as number | string | null,
          q = y[o.column] as number | string | null;
        if (p === q) continue;
        if (o.column === 'c') return (o.direction === 'asc' ? 1 : -1) * Math.sign(rank(p) - rank(q));
        const sign = p === null ? (high ? 1 : -1) : q === null ? (high ? -1 : 1) : p < q ? -1 : 1;
        return o.direction === 'asc' ? sign : -sign;
      }
      return 0;
    };
    for (const order of [
      [
        { column: 'a', direction: 'asc' },
        { column: 'b', direction: 'desc' },
        { column: 'id', direction: 'asc' },
      ],
      [
        { column: 'b', direction: 'desc' },
        { column: 'id', direction: 'desc' },
      ],
      [
        { column: 'c', direction: 'asc' },
        { column: 'id', direction: 'asc' },
      ],
      [
        { column: 'c', direction: 'desc' },
        { column: 'a', direction: 'asc' },
        { column: 'id', direction: 'desc' },
      ],
    ] as Order[][]) {
      for (const reverse of [false, true]) {
        const read = reverse ? reversedOrder(order) : order;
        const sorted = [...rows].sort(compare(read));
        for (const [at, row] of sorted.entries()) {
          const boundary = Object.fromEntries(read.map((o) => [o.column, row[o.column]])) as Boundary;
          const groups = keysetAfter(table, read, boundary, dialect)!;
          const matched = sorted.filter((candidate) => groups.some((group) => group.every((term) => holds(candidate, term))));
          assert.deepEqual(matched, sorted.slice(at + 1), `${dialect} ${JSON.stringify(read)} after row ${row.id}`);
        }
      }
    }
  }
});

test('a condition every group holds is said once, before the OR', async () => {
  const { buildWhere } = await import('../packages/engine/src/shared/filter.js');
  const { ANSI_STYLE } = await import('../packages/engine/src/adapters/adapter.js');
  const a = { column: 'a', op: '>=' as const, value: 1 },
    b = { column: 'b', op: '=' as const, value: 2 },
    c = { column: 'c', op: 'isNull' as const };
  assert.deepEqual(
    buildWhere(
      {
        groups: [
          [a, b],
          [{ ...a }, c],
        ],
      },
      ANSI_STYLE,
    ),
    { text: ' WHERE "a" >= ? AND (("b" = ?) OR ("c" IS NULL))', params: [1, 2] },
  );
  // A group of nothing else is true once the shared part is.
  assert.deepEqual(buildWhere({ groups: [[a], [a, c]] }, ANSI_STYLE), { text: ' WHERE "a" >= ?', params: [1] });
  assert.deepEqual(buildWhere({ groups: [[a, b]] }, ANSI_STYLE), { text: ' WHERE "a" >= ? AND "b" = ?', params: [1, 2] });
  assert.deepEqual(buildWhere({ groups: [[b], [c]] }, ANSI_STYLE), { text: ' WHERE ("b" = ?) OR ("c" IS NULL)', params: [2] });
});
