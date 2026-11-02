/**
 * Sums, groups and pages on a command's `db` (commandDb.ts), over a real
 * row-policy transaction on SQLite: what an aggregate or a page answers is
 * exactly what the same command's `where` and `count` read, never a row, a
 * column or a table they could not. A group whose only rows are hidden does
 * not exist, a least value is never a hidden one, a table off the footprint
 * is refused through the handle and the raw `tx` alike, a reference path is
 * refused, a template's value stays a value, and a page's boundary is a
 * position read under whoever asks, never a capability. The totals are exact
 * (decimal strings, past 2^53, an average rounded half to even), the bounds
 * refuse rather than cut, and a cancelled walk writes nothing.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { iterateSize } from '../packages/mistri/src/server/commands/commandDb.js';
import { Refusal, type Filter } from '../packages/engine/src/adapters/adapter.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { parseDecimal, formatDecimal } from '../packages/engine/src/shared/decimals.js';
import { isAuthorFault, refusalReasons } from '../packages/engine/src/shared/refusal.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { loadAppRuntimeResources, type RuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { createAppSourceAdapter } from '../packages/mistri/src/server/app/appSourceAdapter.js';
import { bindBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { BusinessCommandExecutionError, executeBusinessCommand } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import {
  defineCommand,
  defineCommands,
  type BusinessCommandActor,
  type BusinessCommandContext,
} from '../packages/mistri/src/server/commands/businessCommands.js';
import {
  avg,
  count,
  max,
  min,
  period,
  sum,
  type Boundary,
  type Query,
  type UntypedRow,
  type WriteTable,
} from '../packages/mistri/src/server/commands/commandDb.js';
import { bindScopedBusinessCommands } from '../packages/mistri/src/server/commands/scopedBusinessCommandAccess.js';
import { defineEvent } from '../packages/mistri/src/server/commands/businessEvents.js';
import { shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { createWorkflowDriver } from '../packages/mistri/src/server/testing/workflows.js';
import { defineWorkflow } from '../packages/mistri/src/server/workflows.js';
import { parseTestApp } from './support/commandCatalog.js';

const member: BusinessCommandActor = { id: 'desk-one-member', appId: 'ledger', roles: ['member'] };
const clock: BusinessCommandActor = { id: 'service:clock', appId: 'ledger', roles: ['member'], kind: 'service' };
const desk = (value: number): Filter => ({ groups: [[{ column: 'desk', op: '=', value }]] });
const TWO_52 = 4503599627370496;

/* Desk 1 is the member's; rows 3 and 14 are desk 2's, and each holds what would change an answer if it leaked: a
   group of its own ("secret"), the least amount and the earliest day. */
const ROWS = `
  INSERT INTO raw_entry VALUES
    (1, 1, 'cash', 0.10, ${TWO_52}, '2026-10-01', NULL),
    (2, 1, 'cash', 0.20, ${TWO_52}, '2026-10-02', NULL),
    (3, 2, 'secret', 999.99, 5, '2025-01-01', 'hidden'),
    (4, 1, 'cash', 0.07, ${TWO_52}, '2026-10-15', NULL),
    (5, 1, 'cash', 100000000000000.00, 0, '2026-11-03', NULL),
    (6, 1, 'fees', -0.05, 1, '2026-11-04', NULL),
    (7, 1, 'fees', 0, 0, '2026-11-05', NULL), (8, 1, 'fees', 0, 0, '2026-11-06', NULL),
    (9, 1, 'fees', 0, 0, '2026-11-07', NULL), (10, 1, 'fees', 0, 0, '2026-11-08', NULL),
    (11, 1, 'fees', 0, 0, '2026-11-09', NULL), (12, 1, 'fees', 0, 0, '2026-11-10', NULL),
    (13, 1, 'fees', 0, 0, '2026-11-11', NULL),
    (14, 2, 'cash', -1000000.00, 7, '2026-11-20', 'hidden');
  INSERT INTO raw_ledger VALUES (1, 1, 5.00);`;

type Handler = (context: BusinessCommandContext) => unknown;

async function fixture(t: TestContext, rows = ROWS, options: { snapshot?: true; amount?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-command-aggregates-')),
    path = join(directory, 'ledger.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE raw_entry (id INTEGER PRIMARY KEY, desk INTEGER NOT NULL, account TEXT NOT NULL, amount ${options.amount ?? 'NUMERIC(16,2)'} NOT NULL,
      qty INTEGER NOT NULL, posted_on DATE NOT NULL, memo TEXT);
    CREATE TABLE raw_ledger (id INTEGER PRIMARY KEY, desk INTEGER NOT NULL, total NUMERIC(16,2));
    CREATE TABLE raw_note (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
    ${rows}`);
  migrateSqliteCommandJournal(path);
  const adapter = new SqliteAdapter(path, 'ledger');
  t.after(async () => {
    await adapter.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const runtime = createAppSourceAdapter(
    {
      books: {
        adapter,
        schema: await adapter.introspect(),
        writable: true,
        resources: { entries: 'raw_entry', ledger: 'raw_ledger', notes: 'raw_note' },
      },
    },
    'books',
  );
  const anchor = runtime.forSource('books');
  const resources: RuntimeResources = {
    adapter: runtime.adapter,
    schema: runtime.schema,
    connections: ['books-db'],
    connectionFor: () => 'books-db',
    toPhysical: (resource) => runtime.resolve(resource).physicalTable,
    toLogical: (physical) => runtime.catalogs.get('books')!.toLogical(physical),
    toLogicalAt: (physical) => runtime.catalogs.get('books')!.toLogical(physical),
    forConnection: (connection) => {
      if (connection !== 'books-db') throw new Refusal('Unknown connection');
      return anchor;
    },
  };
  const app = parseTestApp(
    {
      id: 'ledger',
      name: 'Ledger',
      sources: { books: { connection: 'books-db', default: true } },
      resources: { entries: {}, ledger: {}, notes: { access: 'write' } },
      auth: { rows: 'policy', roles: { member: { read: true, commands: ['report'] } } },
      views: { entries: { kind: 'list', from: 'entries' } },
      home: 'entries',
    },
    'command aggregates fixture',
  );
  let handler: Handler = () => ({});
  const registry = {
    report: defineCommand({
      source: 'books',
      target: 'notes',
      targets: 'none',
      read: ['entries'],
      write: ['notes'],
      ...(options.snapshot ? { snapshot: true as const } : {}),
      input: {},
      output: { parse: (value: unknown) => value },
      handle: (context) => handler(context as BusinessCommandContext),
    }),
  };
  const bound = bindScopedBusinessCommands({
    app,
    resources,
    registry,
    writableConnection: () => true,
    resultReferences: { report: () => [] },
  });
  let n = 0;
  /** Runs `run` as the report command's handler, under `scope`, as `who`; its answer is the command's result. */
  const report = async <T>(
    run: (context: BusinessCommandContext) => T | Promise<T>,
    options: { who?: BusinessCommandActor; scope?: Filter; signal?: AbortSignal } = {},
  ) => {
    handler = run as Handler;
    const binding = bound.withScope({ entries: options.scope ?? desk(1), ledger: true, notes: true }, () => {});
    const status = await executeBusinessCommand(
      binding,
      options.who ?? member,
      {
        command: 'report',
        commandVersion: 1,
        key: {},
        expectedVersion: 0,
        idempotencyKey: `aggregate-report-${String(++n).padStart(4, '0')}`,
        input: {},
      },
      { signal: options.signal ?? new AbortController().signal, door: 'ui' },
    );
    return status.result as Awaited<T>;
  };
  return { db, report };
}

const refusal =
  (code: string, author = false) =>
  (error: unknown) => {
    assert.ok(error instanceof BusinessCommandExecutionError, String(error));
    assert.equal(error.code, code);
    if (author) assert.ok(isAuthorFault(error), 'said to the operator as the App author’s to fix');
    return true;
  };
/* What a where reads, added up here with BigInt: the answer an aggregate must equal. */
const exactTotal = (values: readonly unknown[], scale: number) => {
  let units = 0n;
  for (const value of values) {
    const parsed = parseDecimal(value as string | number)!;
    units += parsed.units * 10n ** BigInt(scale - parsed.scale);
  }
  return formatDecimal(units, scale);
};
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test('an aggregate answers exactly what the same where reads, and a hidden row makes no group, no least value and no count', async (t) => {
  const f = await fixture(t);
  const answer = await f.report(async ({ db }) => {
    const rows = await db.entries.where().limit(100);
    const grouped = await db.entries
      .where()
      .groupBy('account')
      .aggregate({
        entries: count(),
        amount: sum('amount'),
        qty: sum('qty'),
        low: min('amount'),
        high: max('amount'),
        first: min('posted_on'),
        mean: avg('amount'),
        share: avg('qty'),
      });
    const whole = await db.entries
      .where()
      .aggregate({ entries: count(), memos: count('memo'), low: min('amount'), first: min('posted_on') });
    return { rows, grouped, whole, counted: await db.entries.count(), total: await db.entries.where().sum('amount') };
  });
  assert.deepEqual(plain(answer.grouped), [
    {
      account: 'cash',
      entries: 4,
      amount: '100000000000000.37',
      qty: String(3n * BigInt(TWO_52)),
      low: '0.07',
      high: '100000000000000.00',
      first: '2026-10-01',
      mean: '25000000000000.0925',
      share: '3377699720527872.00',
    },
    // -0.05 / 8 is -0.00625 and 1 / 8 is 0.125: half to even, -0.0062 and 0.12, where half up would say -0.0063 and 0.13.
    {
      account: 'fees',
      entries: 8,
      amount: '-0.05',
      qty: '1',
      low: '-0.05',
      high: '0.00',
      first: '2026-11-04',
      mean: '-0.0062',
      share: '0.12',
    },
  ]);
  // The same rows a where reads, and nothing else: no "secret" group, no -1,000,000.00, no 2025.
  assert.equal(answer.rows.length, 12);
  assert.equal(answer.counted, 12);
  assert.deepEqual(plain(answer.whole), { entries: 12, memos: 0, low: '-0.05', first: '2026-10-01' });
  assert.equal(
    answer.total,
    exactTotal(
      answer.rows.map((row) => row.amount),
      2,
    ),
  );
  assert.equal(answer.total, '100000000000000.32');
});

test('groups by a period of a date, and orders groups by a measure, an average included', async (t) => {
  const f = await fixture(t);
  const answer = await f.report(async ({ db }) => ({
    months: await db.entries.where().groupBy(period.month('posted_on')).aggregate({ entries: count() }),
    bySum: await db.entries
      .where()
      .groupBy('account')
      .aggregate({ amount: sum('amount') })
      .orderBy('amount', 'desc'),
    byMean: await db.entries
      .where()
      .groupBy('account')
      .aggregate({ mean: avg('qty') })
      .orderBy('mean')
      .limit(1),
    template: await db.entries.where`account = ${'fees'} and qty >= ${1}`.aggregate({ entries: count() }),
  }));
  assert.deepEqual(plain(answer.months), [
    { posted_on: '2026-10', entries: 3 },
    { posted_on: '2026-11', entries: 9 },
  ]);
  assert.deepEqual(
    answer.bySum.map((row) => row.account),
    ['cash', 'fees'],
  );
  assert.deepEqual(plain(answer.byMean), [{ account: 'fees', mean: '0.12' }]);
  assert.deepEqual(plain(answer.template), { entries: 1 });
});

test('over no rows: zero with the column’s places, no mean, no least value, and no groups', async (t) => {
  const f = await fixture(t);
  const answer = await f.report(async ({ db }) => ({
    none: await db.entries
      .where({ account: 'nobody' })
      .aggregate({ entries: count(), amount: sum('amount'), qty: sum('qty'), mean: avg('amount'), low: min('amount') }),
    empty: await db.entries.where({ account: [] }).aggregate({ entries: count(), amount: sum('amount') }),
    groups: await db.entries.where({ account: 'nobody' }).groupBy('account').aggregate({ entries: count() }),
  }));
  assert.deepEqual(plain(answer), {
    none: { entries: 0, amount: '0.00', qty: '0', mean: null, low: null },
    empty: { entries: 0, amount: '0.00' },
    groups: [],
  });
});

test('a table off the footprint, a reference path and a value spelled as language are refused or stay values', async (t) => {
  const f = await fixture(t);
  // The ledger is the App's and the role reads it, but this command's footprint does not name it.
  await assert.rejects(
    f.report(({ tx }) => tx.aggregate!({ table: 'ledger', measures: [{ name: 'n', fn: 'count' }], limit: 1 })),
    refusal('forbidden'),
  );
  assert.deepEqual(await f.report(({ db }) => Object.keys(db).sort()), ['entries', 'notes'], 'the handle holds the footprint, and only it');
  // A reference walked from a key, a measure or a where: refused, never answered as an empty group.
  await assert.rejects(
    f.report(({ db }) =>
      db.entries
        .where()
        .groupBy('desk.name' as 'desk')
        .aggregate({ n: count() }),
    ),
    refusal('invalid_result', true),
  );
  await assert.rejects(
    f.report(({ tx }) =>
      tx.aggregate!({ table: 'entries', by: [{ name: 'k', column: 'desk.name' }], measures: [{ name: 'n', fn: 'count' }], limit: 10 }),
    ),
    refusal('forbidden'),
  );
  await assert.rejects(f.report(({ db }) => db.entries.where('ledger.total > 1').aggregate({ n: count() })));
  // The raw tx reads the footprint under the same scope as the handle.
  const raw = await f.report(({ tx }) =>
    tx.aggregate!({ table: 'entries', by: [{ name: 'account', column: 'account' }], measures: [{ name: 'n', fn: 'count' }], limit: 10 }),
  );
  assert.deepEqual(plain(raw.rows), [
    { account: 'cash', n: 4 },
    { account: 'fees', n: 8 },
  ]);
  // A template's value is quoted whatever it says: `x" or 1 = 1` matches no account.
  assert.deepEqual(plain(await f.report(({ db }) => db.entries.where`account = ${'x" or 1 = 1'}`.aggregate({ n: count() }))), { n: 0 });
  // A sum of a text column is the author's mistake, said with the column.
  await assert.rejects(
    f.report(({ db }) => db.entries.where().sum('account')),
    refusal('invalid_result', true),
  );
});

test('a page is a position read under whoever asks: a hidden row’s boundary pages only visible rows, a replay reads its own scope', async (t) => {
  const f = await fixture(t);
  const walked = await f.report(async ({ db }) => {
    const pages: { ids: unknown[]; next?: Boundary }[] = [];
    let after: Boundary | undefined;
    do {
      const page = await db.entries.where().page({ after, size: 5 });
      pages.push({ ids: page.rows.map((row) => row.id), ...(page.next ? { next: page.next } : {}) });
      after = page.next;
    } while (after);
    return pages;
  });
  assert.deepEqual(plain(walked), [
    { ids: [1, 2, 4, 5, 6], next: { id: 6 } },
    { ids: [7, 8, 9, 10, 11], next: { id: 11 } },
    { ids: [12, 13] },
  ]);
  // A boundary taken from a hidden row (id 3, desk 2): the rows after it the member may read, never row 3.
  const forged = await f.report(({ db }) => db.entries.where().page({ after: { id: 3 }, size: 3 }));
  assert.deepEqual(
    forged.rows.map((row) => row.id),
    [4, 5, 6],
  );
  // Ordered by a column, the key appended: a hidden row's day as the boundary reveals nothing past it.
  const byDay = await f.report(({ db }) =>
    db.entries
      .where()
      .orderBy('posted_on')
      .page({ after: { posted_on: '2026-11-10', id: 0 }, size: 10 }),
  );
  assert.deepEqual(
    byDay.rows.map((row) => row.id),
    [12, 13],
  );
  // The member's boundary, replayed by a service principal whose scope is desk 2: desk 2's rows, nothing of desk 1.
  const replayed = await f.report(({ db }) => db.entries.where().page({ after: { id: 1 }, size: 10 }), { who: clock, scope: desk(2) });
  assert.deepEqual(
    replayed.rows.map((row) => row.id),
    [3, 14],
  );
  // A boundary naming other columns than the order is the caller's input, refused.
  await assert.rejects(
    f.report(({ db }) => db.entries.where().page({ after: { desk: 2 } as Boundary, size: 5 })),
    refusal('invalid_input'),
  );
  await assert.rejects(
    f.report(({ db }) => db.entries.where().page({ after: { id: 1, desk: 2 }, size: 5 })),
    refusal('invalid_input'),
  );
  // An order a page cannot keep exact: a column that can be empty.
  await assert.rejects(
    f.report(({ db }) => db.entries.where().orderBy('memo').page({ size: 5 })),
    refusal('invalid_result', true),
  );
});

test('the bounds refuse rather than cut: groups without a limit, a page’s size, and a walk past 100,000 rows', async (t) => {
  const f = await fixture(
    t,
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100001)
     INSERT INTO raw_entry SELECT i, 1, 'a' || (i % 1500), 1, 1, '2026-10-01', NULL FROM n;`,
  );
  await assert.rejects(
    f.report(({ db }) => db.entries.where().groupBy('account').aggregate({ n: count() })),
    refusal('invalid_result', true),
  );
  const limited = await f.report(
    async ({ db }) => (await db.entries.where().groupBy('account').aggregate({ n: count() }).limit(2000)).length,
  );
  assert.equal(limited, 1500);
  await assert.rejects(
    f.report(({ db }) => db.entries.where().page({ size: 1001 })),
    refusal('invalid_result', true),
  );
  await assert.rejects(
    f.report(({ db }) => db.entries.where().page({ size: 0 })),
    refusal('invalid_result', true),
  );
  await assert.rejects(
    f.report(({ db }) => db.entries.where().groupBy('account').aggregate({ n: count() }).limit(100_001)),
    refusal('invalid_result', true),
  );
  let seen = 0;
  await assert.rejects(
    f.report(async ({ db }) => {
      for await (const _row of db.entries.where().iterate({ size: 1000 })) seen++;
    }),
    refusal('invalid_result', true),
  );
  assert.equal(seen, 100_000, 'every row up to the bound, then refused, not cut');
  // A page size that does not divide the bound is clamped to what the bound leaves: nothing past it is yielded.
  seen = 0;
  await assert.rejects(
    f.report(async ({ db }) => {
      for await (const _row of db.entries.where().iterate({ size: 999 })) seen++;
    }),
    refusal('invalid_result', true),
  );
  assert.equal(seen, 100_000, 'the last page is cut to the bound, never read past it');
  assert.equal(iterateSize(999, 99_900), 100);
  assert.equal(iterateSize(999, 0, 10), 10);
  assert.equal(iterateSize('x', 0), 'x', 'a size that is not a number is left for the page to refuse');
  // Within the bound, a walk reads every row once.
  const walked = await f.report(async ({ db }) => {
    let rows = 0;
    for await (const _row of db.entries.where`qty = 1 and id <= 2500`.iterate({ size: 1000 })) rows++;
    return rows;
  });
  assert.equal(walked, 2500);
});

test('a walk cancelled between pages answers cancelled, and what it wrote is rolled back', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(
    f.report(
      async (context) => {
        await (context.db.notes as WriteTable<UntypedRow>).insert({ id: 1, body: 'written before the walk' });
        for await (const _row of context.db.entries.where().iterate({ size: 2 })) controller.abort();
      },
      { signal: controller.signal },
    ),
    refusal('cancelled'),
  );
  assert.deepEqual(plain(f.db.prepare('SELECT count(*) AS n FROM raw_note').get()), { n: 0 });
});

test('under elevate, an aggregate reads what the elevated where reads, and a role without the command reads nothing through it', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-command-aggregates-elevate-')),
    path = join(directory, 'shop.db');
  const db = new DatabaseSync(path);
  const registry = new Registry();
  t.after(async () => {
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  db.exec(`CREATE TABLE quote (id INTEGER PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE rate (id INTEGER PRIMARY KEY, band TEXT NOT NULL, price NUMERIC(10,2) NOT NULL);
    INSERT INTO rate VALUES (1, 'a', 0.10), (2, 'a', 0.20), (3, 'b', 0.07);`);
  migrateSqliteCommandJournal(path);
  registry.add({ id: 'shop-db', name: 'Shop', url: path, writable: true, source: 'config' });
  const app = parseAppConfig(
    {
      id: 'quotes',
      name: 'Quotes',
      sources: { shop: { connection: 'shop-db' } },
      resources: { quote: { access: 'write' }, rate: {} },
      auth: { roles: { clerk: { read: ['quote'], commands: ['price'] }, viewer: { read: ['quote'] } } },
      views: { quotes: { kind: 'list', from: 'quote' } },
      home: 'quotes',
    },
    'elevate fixture',
  );
  const commands = defineCommands({
    price: defineCommand({
      source: 'shop',
      target: 'quote',
      targets: 'none',
      read: ['quote', 'rate'],
      write: ['quote'],
      elevate: { read: ['rate'] },
      input: {},
      output: { parse: (value: unknown) => value },
      handle: async ({ db }) => ({
        rows: (await db.rate.where({ band: 'a' })).length,
        counted: await db.rate.count({ band: 'a' }),
        bands: await db.rate
          .where()
          .groupBy('band')
          .aggregate({ n: count(), total: sum('price') }),
      }),
    }),
  });
  const resources = await loadAppRuntimeResources(registry, app, 'shop-db');
  const binding = bindBusinessCommands({ app, registry: commands, resources, writableConnection: () => true });
  const run = (roles: string[]) =>
    executeBusinessCommand(
      binding,
      { id: 'clerk-one', appId: 'quotes', roles },
      {
        command: 'price',
        commandVersion: 1,
        key: {},
        expectedVersion: 0,
        idempotencyKey: `elevated-${roles.join('-')}-request`,
        input: {},
      },
    );
  const answer = (await run(['clerk'])).result as { rows: number; counted: number; bands: unknown };
  assert.equal(answer.rows, answer.counted);
  assert.deepEqual(plain(answer.bands), [
    { band: 'a', n: 2, total: '0.30' },
    { band: 'b', n: 1, total: '0.07' },
  ]);
  // The elevation is the command's, never the reader's: a role not granted the command reads nothing through it.
  await assert.rejects(run(['viewer']), refusal('forbidden'));
});

/* Checked by tsc, never run: the answers are typed by the table's columns, a column the table lacks does not compile,
   and a typed table's query still widens to an untyped one, as a handler's `db` (BusinessCommandContext) is typed. */
export async function typedAnswers(q: Query<Readonly<{ id: number; posted_on: string; amount: string }>>) {
  const widened: Query<UntypedRow> = q;
  const one = await q.aggregate({ n: count(), top: max('id'), first: min('posted_on'), total: sum('amount'), mean: avg('id') });
  const typed: [number, number | null, string | null, string | number, string | number | null] = [
    one.n,
    one.top,
    one.first,
    one.total,
    one.mean,
  ];
  // @ts-expect-error The greatest id is a number.
  const notText: string | null = one.top;
  // @ts-expect-error A column the table does not have.
  await q.aggregate({ bad: sum('nope') });
  // @ts-expect-error A key the table does not have.
  q.groupBy('nope');
  const groups = await q.groupBy('id', period.month('posted_on')).aggregate({ n: count() });
  const keys: [number, string | number | null] = [groups[0].id, groups[0].posted_on];
  return [widened, typed, notText, keys];
}

test("a snapshot command's serialization failure is the record moving, which a job retries; SQLite reads the same either way", async (t) => {
  // PostgreSQL's 40001, raised where a REPEATABLE READ transaction writes a row that moved after its snapshot.
  const moved = () => {
    throw Object.assign(new Error('could not serialize access due to concurrent update'), { code: '40001' });
  };
  const plainCommand = await fixture(t);
  await assert.rejects(plainCommand.report(moved), refusal('temporarily_unavailable'));
  const snapshot = await fixture(t, ROWS, { snapshot: true });
  await assert.rejects(snapshot.report(moved), refusal('stale_record'));
  // On SQLite the declaration changes nothing: the writer is one snapshot already.
  const total = ({ db }: BusinessCommandContext) => db.entries.where().sum('amount');
  assert.equal(await snapshot.report(total), await plainCommand.report(total));
});

test('a walk paged across a workflow, killed after a batch committed, resumes at the next batch, runs none twice and totals as one pass', async (t) => {
  const f = await fixture(t);
  const Reconcile = defineEvent('ledger.reconcile', shape({ id: text() }));
  /* The note's checkpoint pattern (docs/command-aggregates.md, Checkpoints): a mark first, then one command per
     batch, each handed the boundary the last one answered. A batch writes its subtotal under its own number, so a
     batch run twice is refused on the key and shows. */
  const reconciliation = defineWorkflow({
    runAs: 'member',
    start: { event: Reconcile, key: (event) => event.id },
    run: async (w) => {
      const { through } = await w.run<{ through: number }>('mark', 'ledgerMark');
      let after: Boundary | undefined;
      for (let batch = 0; ; batch++) {
        const out = await w.run<{ next?: Boundary }>(['batch', batch], 'reconcileBatch', {
          input: { through, batch, ...(after ? { after } : {}) },
        });
        if (!(after = out.next)) return;
      }
    },
  });
  const driver = await createWorkflowDriver({
    workflow: { reconciliation },
    commands: {
      ledgerMark: () => f.report(async ({ db }) => ({ through: Number((await db.entries.where().aggregate({ top: max('id') })).top) })),
      reconcileBatch: ({ input }) =>
        f.report(async ({ db }) => {
          const { through, after, batch } = input as { through: number; after?: Boundary; batch: number };
          const page = await db.entries.where`id <= ${through}`.page({ ...(after ? { after } : {}), size: 4 });
          await (db.notes as WriteTable<UntypedRow>).insert({
            id: batch + 1,
            body: exactTotal(
              page.rows.map((row) => row.amount),
              2,
            ),
          });
          return page.next ? { next: page.next } : {};
        }),
    },
  });
  t.after(() => driver.close());
  driver.killDuring('batch[1]');
  await driver.emit(Reconcile, { id: 'october' });
  const [instance] = await driver.instances();
  assert.equal(instance!.state, 'running', 'the advance died after batch 1 committed, its step unrecorded');
  assert.equal(driver.executed('reconcileBatch'), 2);
  // Posted while the walk was down: past the mark (13, the last row desk 1 could read), so not this reconciliation's.
  f.db.exec("INSERT INTO raw_entry VALUES (15, 1, 'cash', 5.00, 0, '2026-11-30', NULL)");
  assert.equal(await driver.resume(instance!.id), 'completed');
  // Eleven rows to the mark in pages of four: batches 0, 1 and 2, each once.
  assert.equal(driver.executed('reconcileBatch'), 3);
  const notes = f.db.prepare('SELECT id, body FROM raw_note ORDER BY id').all() as { id: number; body: string }[];
  assert.deepEqual(
    notes.map((note) => note.id),
    [1, 2, 3],
  );
  const onePass = await f.report(({ db }) => db.entries.where`id <= ${13}`.sum('amount'));
  assert.equal(
    exactTotal(
      notes.map((note) => note.body),
      2,
    ),
    onePass,
  );
});

/* ---------- exactness: what SQLite cannot add exactly is refused, never answered wrong ---------- */

const said = (error: unknown) => refusalReasons(error).join(' ');

test('SQLite refuses a decimal sum or mean it cannot add exactly, naming the column, and still adds what it can', async (t) => {
  const beyond = (error: unknown) => {
    refusal('invalid_result', true)(error);
    assert.match(said(error), /"amount"/);
    assert.match(said(error), /exact/);
    return true;
  };
  // A scaled value past 2^63 (10 x 10^18, with a half): 10.223372036854775808 was the answer once.
  const wide = await fixture(
    t,
    `INSERT INTO raw_entry VALUES (1, 1, 'a', 10, 1, '2026-10-01', NULL), (2, 1, 'a', 0.5, 1, '2026-10-02', NULL);`,
    {
      amount: 'NUMERIC(38,18)',
    },
  );
  await assert.rejects(
    wide.report(({ db }) => db.entries.where().sum('amount')),
    beyond,
  );
  await assert.rejects(
    wide.report(({ db }) => db.entries.where().aggregate({ m: avg('amount') })),
    beyond,
  );
  await assert.rejects(
    wide.report(({ db }) =>
      db.entries
        .where()
        .groupBy('account')
        .aggregate({ m: avg('amount') }),
    ),
    beyond,
  );
  // An integer held past 2^63 once scaled became a REAL: 100000000000000000.07 was the answer.
  const big = await fixture(
    t,
    `INSERT INTO raw_entry VALUES (1, 1, 'a', 100000000000000000, 1, '2026-10-01', NULL), (2, 1, 'a', 1.25, 1, '2026-10-02', NULL);`,
    { amount: 'NUMERIC(20,2)' },
  );
  await assert.rejects(
    big.report(({ db }) => db.entries.where().sum('amount')),
    beyond,
  );
  // A REAL whose scaled value is past 2^53 has no whole units left to add.
  const real = await fixture(
    t,
    `INSERT INTO raw_entry VALUES (1, 1, 'a', 123456789012345.67, 1, '2026-10-01', NULL), (2, 1, 'a', 1e15, 1, '2026-10-02', NULL);`,
  );
  await assert.rejects(
    real.report(({ db }) => db.entries.where().sum('amount')),
    beyond,
  );
  // Integers whose sum overflows 2^63 are SQLite's own `integer overflow`: the same refusal, not a wrapped total.
  const overflow = await fixture(
    t,
    `INSERT INTO raw_entry VALUES (1, 1, 'a', 90000000000000000, 1, '2026-10-01', NULL), (2, 1, 'a', 90000000000000000, 1, '2026-10-02', NULL);`,
    { amount: 'NUMERIC(20,2)' },
  );
  await assert.rejects(
    overflow.report(({ db }) => db.entries.where().sum('amount')),
    beyond,
  );
  // What is within range is still added, and said with the column's places.
  const small = await fixture(
    t,
    `INSERT INTO raw_entry VALUES (1, 1, 'a', 0.001, 1, '2026-10-01', NULL), (2, 1, 'a', 0.002, 1, '2026-10-02', NULL);`,
    {
      amount: 'NUMERIC(38,18)',
    },
  );
  assert.equal(await small.report(({ db }) => db.entries.where().sum('amount')), '0.003000000000000000');
});

test('a sum or mean over a float column is a number, and a decimal or an integer is exact text', async (t) => {
  for (const type of ['REAL', 'NUMERIC', 'DOUBLE PRECISION']) {
    const f = await fixture(
      t,
      `INSERT INTO raw_entry VALUES (1, 1, 'a', 1e30, 1, '2026-10-01', NULL), (2, 1, 'a', 0.5, 2, '2026-10-02', NULL);`,
      {
        amount: type,
      },
    );
    const answer = await f.report(async ({ db }) => ({
      total: await db.entries.where().sum('amount'),
      mean: (await db.entries.where().aggregate({ m: avg('amount') })).m,
      grouped: (
        await db.entries
          .where()
          .groupBy('account')
          .aggregate({ s: sum('amount') })
      )[0].s,
      qty: await db.entries.where().sum('qty'),
      qtyMean: (await db.entries.where().aggregate({ m: avg('qty') })).m,
    }));
    assert.equal(answer.total, 1e30, type);
    assert.equal(answer.mean, 5e29, type);
    assert.equal(answer.grouped, 1e30, type);
    assert.equal(answer.qty, '3', `${type}: an integer sum stays text`);
    assert.equal(answer.qtyMean, '1.50', type);
  }
  const f = await fixture(t);
  const decimal = await f.report(({ db }) => db.entries.where().sum('amount'));
  assert.equal(typeof decimal, 'string');
});

test('a least and greatest value of a decimal column keep their places past 1e15', async (t) => {
  const f = await fixture(
    t,
    `INSERT INTO raw_entry VALUES (1, 1, 'a', 1234567890123456.5, 1, '2026-10-01', NULL), (2, 1, 'a', -2234567890123456.25, 1, '2026-10-02', NULL), (3, 1, 'a', 1.5, 1, '2026-10-03', NULL);`,
    { amount: 'NUMERIC(20,2)' },
  );
  const answer = await f.report(({ db }) => db.entries.where().aggregate({ hi: max('amount'), lo: min('amount') }));
  assert.deepEqual(plain(answer), { hi: '1234567890123456.50', lo: '-2234567890123456.25' });
});

test('a key may be any readable column, and no answer is named for an object’s prototype', async (t) => {
  const f2 = await fixture(
    t,
    `${ROWS}
    ALTER TABLE raw_entry ADD COLUMN _tag TEXT; ALTER TABLE raw_entry ADD COLUMN "región" TEXT;
    UPDATE raw_entry SET _tag = 't' || (id % 2), "región" = 'r' || (id % 3);`,
  );
  const grouped = await f2.report(({ db }) => (db.entries.where('id <= 6') as any).groupBy('_tag', 'región').aggregate({ n: count() }));
  const inScope = (f2.db.prepare('SELECT count(*) AS n FROM raw_entry WHERE desk = 1 AND id <= 6').get() as { n: number }).n;
  assert.ok(grouped.length >= 2);
  assert.deepEqual(Object.keys(grouped[0]).sort(), ['_tag', 'n', 'región']);
  assert.equal(
    grouped.reduce((sum: number, row: { n: number }) => sum + row.n, 0),
    inScope,
  );
  // A raw request cannot name an output for the prototype either, and neither can a handler's measure.
  for (const bad of ['__proto__', 'constructor', 'prototype']) {
    await assert.rejects(
      f2.report(({ tx }) => tx.aggregate!({ table: 'entries', measures: [{ name: bad, fn: 'count' }], limit: 1 })),
      refusal('invalid_result', true),
      bad,
    );
    await assert.rejects(
      f2.report(({ db }) => db.entries.where().aggregate({ [bad]: count() } as never)),
      refusal('invalid_result', true),
      bad,
    );
  }
});

test('a raw request cannot declare a column a date: only the catalog does', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.report(({ tx }) =>
      tx.aggregate!({
        table: 'entries',
        by: [{ name: 'm', column: 'account', bucket: 'month' }],
        measures: [{ name: 'n', fn: 'count' }],
        limit: 5,
        dates: ['account'],
      } as never),
    ),
    refusal('invalid_result', true),
  );
});

test('a malformed raw request is the App author’s fault, said as invalid_result and never retried', async (t) => {
  const f = await fixture(t);
  const mistakes: Record<string, (context: BusinessCommandContext) => unknown> = {
    'an aggregate of a function it does not have': ({ tx }) =>
      tx.aggregate!({ table: 'entries', measures: [{ name: 'n', fn: 'bogus' as never, column: 'amount' }], limit: 1 }),
    'an aggregate with an output name it may not use': ({ tx }) =>
      tx.aggregate!({ table: 'entries', measures: [{ name: 'a"b', fn: 'count' }], limit: 1 }),
    'a query with an operator the tool does not know': ({ tx }) =>
      tx.query({
        table: 'entries',
        filter: { groups: [[{ column: 'account', op: 'OR 1=1 --' as never, value: 'x' }]] },
        limit: 5,
        offset: 0,
      }),
  };
  for (const [what, run] of Object.entries(mistakes)) {
    await assert.rejects(f.report(run), refusal('invalid_result', true), what);
  }
});
