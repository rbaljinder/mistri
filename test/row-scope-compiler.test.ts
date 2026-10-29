import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { ANSI_STYLE, POSTGRES_STYLE, type Filter, type SqlFragment, type SqlStyle } from '../packages/engine/src/adapters/adapter.js';
import { compileView, compileViewCount, type ViewDef } from '../packages/engine/src/shared/view.js';
import { compileBreakdown, compileBreakdownCount, type BreakdownDef } from '../packages/engine/src/shared/breakdown.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import type { DatabaseSchema, TableMeta } from '../packages/engine/src/shared/schema.js';

const eq = (column: string, value: string | number): Filter => ({ groups: [[{ column, op: '=', value }]] });
const scopeA = (): RowScope =>
  Object.fromEntries(['teams', 'people', 'tickets', 'notes', 'accounts', 'entries'].map((name) => [name, eq('scope_code', 'A')]));
const view = (overrides: Partial<ViewDef> = {}): ViewDef => ({
  id: 'scoped',
  name: 'Scoped',
  base: 'tickets',
  columns: [{ path: 'id' }],
  orderBy: [{ path: 'id', direction: 'asc' }],
  limit: 100,
  ...overrides,
});

function tableMetadata(db: DatabaseSync, name: string): TableMeta {
  const columns = db.prepare(`PRAGMA table_info(${ANSI_STYLE.quote(name)})`).all() as unknown as Array<{
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }>;
  return {
    id: name,
    name,
    schema: '',
    isView: false,
    columns: columns.map((column) => ({
      name: column.name,
      type: column.type,
      nullable: !column.notnull && !column.pk,
      primaryKey: column.pk > 0,
    })),
  };
}

/** Each test owns its database; no adapter, shared fixture, or filesystem lifecycle. */
function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE teams (id INTEGER PRIMARY KEY, name TEXT NOT NULL, scope_code TEXT NOT NULL);
    CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, scope_code TEXT NOT NULL,
      team_id INTEGER REFERENCES teams(id), manager_id INTEGER REFERENCES people(id));
    CREATE TABLE tickets (id INTEGER PRIMARY KEY, title TEXT NOT NULL, scope_code TEXT NOT NULL,
      owner_id INTEGER REFERENCES people(id), approver_id INTEGER REFERENCES people(id),
      amount INTEGER, created_at DATE);
    CREATE TABLE notes (id INTEGER PRIMARY KEY, ticket_id INTEGER REFERENCES tickets(id),
      person_id INTEGER REFERENCES people(id), scope_code TEXT NOT NULL, amount INTEGER);
    CREATE TABLE accounts (org_id INTEGER, person_id INTEGER, scope_code TEXT NOT NULL,
      title TEXT NOT NULL, PRIMARY KEY (org_id, person_id));
    CREATE TABLE entries (id INTEGER PRIMARY KEY, org_id INTEGER, person_id INTEGER,
      scope_code TEXT NOT NULL, amount INTEGER,
      FOREIGN KEY (org_id, person_id) REFERENCES accounts(org_id, person_id));
    INSERT INTO teams VALUES (1, 'Alpha', 'A'), (2, 'Hidden team', 'B');
    INSERT INTO people VALUES (1, 'Alice', 'A', 1, 2), (2, 'Hidden person', 'B', 2, NULL),
      (3, 'Carol', 'A', 2, 1);
    INSERT INTO tickets VALUES
      (10, 'keep', 'A', 1, 2, 10, '2026-09-01'),
      (11, 'keep', 'A', 2, 1, 20, '2026-09-02'),
      (12, 'keep', 'A', NULL, 3, 30, '2026-10-01'),
      (13, 'keep', 'B', 1, 1, 900, '2026-09-01'),
      (14, 'other', 'A', 3, 1, 40, '2026-10-02');
    INSERT INTO notes VALUES (100, 10, 1, 'A', 5), (101, 10, 1, 'B', 900),
      (102, 11, 2, 'A', 7), (103, 13, 1, 'A', 100), (104, 10, 3, 'A', NULL),
      (105, 14, 3, 'A', 3);
    INSERT INTO accounts VALUES (1, 1, 'A', 'First'), (2, 1, 'B', 'Hidden account'), (1, 2, 'A', 'Second');
    INSERT INTO entries VALUES (201, 1, 1, 'A', 5), (202, 2, 1, 'A', 99),
      (203, 1, 2, 'B', 1000), (204, 1, 1, 'B', 900);
  `);
  const schema: DatabaseSchema = {
    dialect: 'sqlite',
    label: 'row scope compiler',
    readAt: '2026-09-07T00:00:00Z',
    tables: ['teams', 'people', 'tickets', 'notes', 'accounts', 'entries'].map((name) => tableMetadata(db, name)),
    foreignKeys: [
      { name: 'person_team', from: { table: 'people', columns: ['team_id'] }, to: { table: 'teams', columns: ['id'] } },
      { name: 'person_manager', from: { table: 'people', columns: ['manager_id'] }, to: { table: 'people', columns: ['id'] } },
      { name: 'ticket_owner', from: { table: 'tickets', columns: ['owner_id'] }, to: { table: 'people', columns: ['id'] } },
      { name: 'ticket_approver', from: { table: 'tickets', columns: ['approver_id'] }, to: { table: 'people', columns: ['id'] } },
      { name: 'note_ticket', from: { table: 'notes', columns: ['ticket_id'] }, to: { table: 'tickets', columns: ['id'] } },
      { name: 'note_person', from: { table: 'notes', columns: ['person_id'] }, to: { table: 'people', columns: ['id'] } },
      {
        name: 'entry_account',
        from: { table: 'entries', columns: ['org_id', 'person_id'] },
        to: { table: 'accounts', columns: ['org_id', 'person_id'] },
      },
    ],
  };
  const rows = (compiled: SqlFragment) =>
    db
      .prepare(compiled.text)
      .all(...(compiled.params as SQLInputValue[]))
      .map((row) => ({ ...row }));
  const count = (compiled: SqlFragment) => rows(compiled)[0].n;
  return { db, schema, rows, count };
}

function cteNames(text: string): string[] {
  return [...text.matchAll(/["`](_tw_scope\$\d+)["`]\s+AS\s*\(/gi)].map((match) => match[1]);
}

function placeholders(compiled: SqlFragment, style: SqlStyle) {
  // The generated CTE identifiers themselves contain '$N'. Only tokens
  // outside quoted identifiers/literals are driver placeholders.
  const tokens = compiled.text.replace(/"(?:[^"]|"")*"|`(?:[^`]|``)*`|'(?:[^']|'')*'/g, '');
  if (style === POSTGRES_STYLE) {
    assert.deepEqual(
      [...tokens.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])),
      compiled.params.map((_, index) => index + 1),
      'each PostgreSQL binding occurs once in textual order',
    );
    assert.ok(!tokens.includes('?'));
  } else {
    assert.equal((tokens.match(/\?/g) ?? []).length, compiled.params.length);
    assert.ok(!/\$\d+/.test(tokens));
  }
}

test('scope omission preserves unscoped SQL; empty, false and true policies have distinct execution semantics', (t) => {
  const { schema, rows, count } = fixture(t);
  const def = view({ filter: { groups: [[{ path: 'title', op: '=', value: 'keep' }]] }, limit: 3 });
  const unscoped = compileView(schema, def, ANSI_STYLE, 1);
  assert.equal(
    unscoped.text,
    'SELECT "tickets_0"."id" AS "id"\n' +
      '  FROM "tickets" "tickets_0"\n WHERE "tickets_0"."title" = ?\n' +
      ' ORDER BY "tickets_0"."id" ASC\n LIMIT ? OFFSET ?',
  );
  assert.deepEqual(unscoped.params, ['keep', 3, 1]);
  assert.deepEqual(rows(unscoped), [{ id: 11 }, { id: 12 }, { id: 13 }]);
  assert.deepEqual(compileView(schema, def, ANSI_STYLE, 1, undefined), unscoped);
  const denied: RowScope[] = [{}, { tickets: false }, { tickets: { groups: [[{ column: 'id', op: 'in', value: [] }]] } }];
  for (const scope of denied) {
    assert.deepEqual(rows(compileView(schema, def, ANSI_STYLE, 0, scope)), []);
    assert.equal(count(compileViewCount(schema, def, ANSI_STYLE, scope)), 0);
  }
  assert.deepEqual(rows(compileView(schema, def, ANSI_STYLE, 1, { tickets: true })), rows(unscoped));
  assert.equal(count(compileViewCount(schema, def, ANSI_STYLE, { tickets: true })), 4);
  assert.equal(
    compileViewCount(schema, def, ANSI_STYLE).text,
    'SELECT COUNT(*) AS n\n  FROM "tickets" "tickets_0" WHERE "tickets_0"."title" = ?',
  );
});

test('unscoped breakdown SQL stays unchanged and explicit all preserves its grouped results', (t) => {
  const { schema, rows, count } = fixture(t);
  const def: BreakdownDef = {
    base: 'tickets',
    by: [{ path: 'title' }],
    measures: [{ fn: 'count', alias: 'n' }],
    filter: { groups: [[{ path: 'amount', op: '>=', value: 20 }]] },
    orderBy: [{ name: 'title', direction: 'asc' }],
    limit: 3,
  };
  const body =
    'SELECT "tickets_0"."title" AS "title",\n       COUNT(*) AS "n"\n' +
    '  FROM "tickets" "tickets_0"\n WHERE "tickets_0"."amount" >= ?\n' +
    ' GROUP BY "tickets_0"."title"\n ORDER BY "title" ASC';
  const compiled = compileBreakdown(schema, def, ANSI_STYLE, 1);
  assert.equal(compiled.text, body + '\n LIMIT ? OFFSET ?');
  assert.deepEqual(compiled.params, [20, 3, 1]);
  assert.deepEqual(rows(compiled), [{ title: 'other', n: 1 }]);
  const counted = compileBreakdownCount(schema, def, ANSI_STYLE);
  assert.equal(counted.text, `SELECT COUNT(*) AS n FROM (\n${body}\n) AS grouped`);
  assert.deepEqual(counted.params, [20]);
  assert.equal(count(counted), 2);
  assert.deepEqual(rows(compileBreakdown(schema, def, ANSI_STYLE, 1, { tickets: true })), rows(compiled));
  assert.equal(count(compileBreakdownCount(schema, def, ANSI_STYLE, { tickets: true })), 2);
});

test('policy OR and request OR intersect before paging; count ignores the page', (t) => {
  const { schema, rows, count } = fixture(t);
  const scope: RowScope = { tickets: { groups: [[{ column: 'id', op: '=', value: 10 }], [{ column: 'id', op: '=', value: 14 }]] } };
  const def = view({ filter: { groups: [[{ path: 'title', op: '=', value: 'keep' }], [{ path: 'id', op: '=', value: 14 }]] }, limit: 1 });
  assert.deepEqual(rows(compileView(schema, def, ANSI_STYLE, 0, scope)), [{ id: 10 }]);
  assert.deepEqual(rows(compileView(schema, def, ANSI_STYLE, 1, scope)), [{ id: 14 }]);
  assert.equal(count(compileViewCount(schema, def, ANSI_STYLE, scope)), 2);
});

test('scoped forward and repeated joins preserve base rows and null hidden targets and intermediate hops', (t) => {
  const { schema, rows, count } = fixture(t);
  const def = view({
    columns: [
      { path: 'id' },
      { path: 'owner_id.name', alias: 'owner' },
      { path: 'owner_id.name', alias: 'again' },
      { path: 'approver_id.name', alias: 'approver' },
      { path: 'owner_id.team_id.name', alias: 'team' },
    ],
  });
  const compiled = compileView(schema, def, ANSI_STYLE, 0, scopeA());
  assert.deepEqual(rows(compiled), [
    { id: 10, owner: 'Alice', again: 'Alice', approver: null, team: 'Alpha' },
    { id: 11, owner: null, again: null, approver: 'Alice', team: null },
    { id: 12, owner: null, again: null, approver: 'Carol', team: null },
    { id: 14, owner: 'Carol', again: 'Carol', approver: 'Alice', team: null },
  ]);
  assert.equal(compiled.joins.length, 3, 'duplicate owner projection reuses its join');
  assert.equal(cteNames(compiled.text).length, 3, 'two people occurrences reuse one scoped relation');
  assert.equal((compiled.text.match(/LEFT JOIN/g) ?? []).length, 3);
  assert.equal(count(compileViewCount(schema, def, ANSI_STYLE, scopeA())), 4);
  assert.deepEqual(
    rows(compileView(schema, def, ANSI_STYLE, 0, { tickets: eq('scope_code', 'A') })).map((row) => row.owner),
    [null, null, null, null],
    'missing joined policy denies target values, not base rows',
  );
});

test('self joins reuse the base scoped relation without exposing a hidden ancestor', (t) => {
  const { schema, rows } = fixture(t);
  const compiled = compileView(
    schema,
    view({
      base: 'people',
      columns: [
        { path: 'id' },
        { path: 'manager_id.name', alias: 'manager' },
        { path: 'manager_id.manager_id.name', alias: 'grandmanager' },
      ],
    }),
    ANSI_STYLE,
    0,
    scopeA(),
  );
  assert.deepEqual(rows(compiled), [
    { id: 1, manager: null, grandmanager: null },
    { id: 3, manager: 'Alice', grandmanager: null },
  ]);
  assert.equal(cteNames(compiled.text).length, 1);
  assert.equal(new Set(compiled.joins.map((join) => join.alias)).size, 2);
});

test('filter-only and sort-only joins see scoped targets; view counts plan only filter joins', (t) => {
  const { schema, rows, count } = fixture(t);
  const filtered = view({ filter: { groups: [[{ path: 'owner_id.name', op: 'isNull' }]] } });
  assert.deepEqual(rows(compileView(schema, filtered, ANSI_STYLE, 0, scopeA())), [{ id: 11 }, { id: 12 }]);
  const counted = compileViewCount(schema, filtered, ANSI_STYLE, scopeA());
  assert.equal(count(counted), 2);
  assert.equal(cteNames(counted.text).length, 2);
  const sorted = view({
    orderBy: [
      { path: 'owner_id.name', direction: 'asc' },
      { path: 'id', direction: 'asc' },
    ],
  });
  assert.deepEqual(rows(compileView(schema, sorted, ANSI_STYLE, 0, scopeA())), [{ id: 11 }, { id: 12 }, { id: 10 }, { id: 14 }]);
  const sortCount = compileViewCount(schema, sorted, ANSI_STYLE, scopeA());
  assert.equal(count(sortCount), 4);
  assert.equal(cteNames(sortCount.text).length, 1, 'count does not require a sort-only people CTE');
  assert.ok(!sortCount.text.includes('LEFT JOIN'));
});

test('reverse scalar aggregates scope children independently and preserve empty count and sum semantics', (t) => {
  const { schema, rows, count } = fixture(t);
  const def = view({
    aggregates: [
      { fn: 'count', via: 'note_ticket', alias: 'notes' },
      { fn: 'sum', via: 'note_ticket', column: 'amount', alias: 'total' },
    ],
  });
  const compiled = compileView(schema, def, ANSI_STYLE, 0, scopeA());
  assert.deepEqual(rows(compiled), [
    { id: 10, notes: 2, total: 5 },
    { id: 11, notes: 1, total: 7 },
    { id: 12, notes: 0, total: null },
    { id: 14, notes: 1, total: 3 },
  ]);
  assert.equal(cteNames(compiled.text).length, 2, 'count and sum share the child CTE');
  const deniedChildren: RowScope[] = [{ tickets: eq('scope_code', 'A') }, { ...scopeA(), notes: false }];
  for (const scope of deniedChildren) {
    assert.deepEqual(
      rows(compileView(schema, def, ANSI_STYLE, 0, scope)),
      [10, 11, 12, 14].map((id) => ({ id, notes: 0, total: null })),
    );
  }
  const counted = compileViewCount(schema, def, ANSI_STYLE, { tickets: eq('scope_code', 'A') });
  assert.equal(count(counted), 4);
  assert.equal(cteNames(counted.text).length, 1, 'projection aggregates do not add count dependencies');
});

test('reverse aggregates on joined parents cannot recover a parent hidden by its scoped relation', (t) => {
  const { schema, rows } = fixture(t);
  const def = view({
    aggregates: [
      { fn: 'count', via: 'note_person', on: 'owner_id', alias: 'notes' },
      { fn: 'sum', via: 'note_person', on: 'owner_id', column: 'amount', alias: 'total' },
    ],
    orderBy: [
      { path: 'notes', alias: true, direction: 'desc' },
      { path: 'id', direction: 'asc' },
    ],
  });
  // An allowed note may point at a separately hidden ticket: local resource
  // policies do not invent transitive membership through unrelated FKs.
  assert.deepEqual(rows(compileView(schema, def, ANSI_STYLE, 0, scopeA())), [
    { id: 10, notes: 2, total: 105 },
    { id: 14, notes: 2, total: 3 },
    { id: 11, notes: 0, total: null },
    { id: 12, notes: 0, total: null },
  ]);
});

test('composite forward joins and reverse correlations retain every key component', (t) => {
  const { schema, rows, count } = fixture(t);
  const forward = view({ base: 'entries', columns: [{ path: 'id' }, { path: 'org_id+person_id.title', alias: 'account' }] });
  assert.deepEqual(rows(compileView(schema, forward, ANSI_STYLE, 0, scopeA())), [
    { id: 201, account: 'First' },
    { id: 202, account: null },
  ]);
  const reverse = view({
    base: 'accounts',
    columns: [{ path: 'org_id' }, { path: 'person_id' }],
    aggregates: [
      { fn: 'count', via: 'entry_account', alias: 'entries' },
      { fn: 'sum', via: 'entry_account', column: 'amount', alias: 'total' },
    ],
    orderBy: [
      { path: 'org_id', direction: 'asc' },
      { path: 'person_id', direction: 'asc' },
    ],
  });
  assert.deepEqual(rows(compileView(schema, reverse, ANSI_STYLE, 0, scopeA())), [
    { org_id: 1, person_id: 1, entries: 1, total: 5 },
    { org_id: 1, person_id: 2, entries: 0, total: null },
  ]);
  assert.equal(count(compileViewCount(schema, reverse, ANSI_STYLE, scopeA())), 2);
});

test('breakdowns scope keys, joined measures and ordinary filters before grouping', (t) => {
  const { schema, rows, count } = fixture(t);
  const def: BreakdownDef = {
    base: 'tickets',
    by: [{ path: 'owner_id.team_id.name', alias: 'team' }],
    measures: [
      { fn: 'count', alias: 'n' },
      { fn: 'sum', path: 'amount', alias: 'total' },
      { fn: 'count', path: 'owner_id.id', distinct: true, alias: 'owners' },
    ],
    filter: { groups: [[{ path: 'title', op: '=', value: 'keep' }]] },
    orderBy: [{ name: 'team', direction: 'asc' }],
    limit: 1,
  };
  const compiled = compileBreakdown(schema, def, ANSI_STYLE, 0, scopeA());
  assert.deepEqual(rows(compiled), [{ team: null, n: 2, total: 50, owners: 0 }]);
  assert.deepEqual(rows(compileBreakdown(schema, def, ANSI_STYLE, 1, scopeA())), [{ team: 'Alpha', n: 1, total: 10, owners: 1 }]);
  assert.equal(count(compileBreakdownCount(schema, def, ANSI_STYLE, scopeA())), 2);
  assert.deepEqual(compiled.columns, compileBreakdown(schema, def, ANSI_STYLE).columns);
});

test('measure-only and filter-only breakdown relationships are scoped', (t) => {
  const { schema, rows, count } = fixture(t);
  const measured: BreakdownDef = {
    base: 'tickets',
    by: [],
    measures: [
      { fn: 'count', path: 'owner_id.id', distinct: true, alias: 'owners' },
      { fn: 'sum', path: 'owner_id.id', alias: 'ownerSum' },
    ],
  };
  assert.deepEqual(rows(compileBreakdown(schema, measured, ANSI_STYLE, 0, scopeA())), [{ owners: 2, ownerSum: 4 }]);
  assert.deepEqual(rows(compileBreakdown(schema, measured, ANSI_STYLE, 0, { tickets: true })), [{ owners: 0, ownerSum: null }]);
  const filtered: BreakdownDef = {
    base: 'tickets',
    by: [{ path: 'title' }],
    measures: [{ fn: 'count', alias: 'n' }],
    filter: { groups: [[{ path: 'owner_id.name', op: 'isNull' }]] },
  };
  assert.deepEqual(rows(compileBreakdown(schema, filtered, ANSI_STYLE, 0, scopeA())), [{ title: 'keep', n: 2 }]);
  assert.equal(count(compileBreakdownCount(schema, filtered, ANSI_STYLE, scopeA())), 1);
});

test('date buckets count scoped groups independently of paging; denied ungrouped aggregates still form one group', (t) => {
  const { schema, rows, count } = fixture(t);
  const def: BreakdownDef = {
    base: 'tickets',
    by: [{ path: 'created_at', bucket: 'month', alias: 'month' }],
    measures: [
      { fn: 'count', alias: 'n' },
      { fn: 'sum', path: 'amount', alias: 'total' },
    ],
    orderBy: [{ name: 'month', direction: 'asc' }],
    limit: 1,
  };
  assert.deepEqual(rows(compileBreakdown(schema, def, ANSI_STYLE, 1, scopeA())), [{ month: '2026-10', n: 2, total: 70 }]);
  assert.equal(count(compileBreakdownCount(schema, def, ANSI_STYLE, scopeA())), 2);
  const denied: RowScope[] = [{}, { tickets: false }];
  for (const scope of denied) {
    assert.deepEqual(rows(compileBreakdown(schema, def, ANSI_STYLE, 0, scope)), []);
    assert.equal(count(compileBreakdownCount(schema, def, ANSI_STYLE, scope)), 0);
    const ungrouped = { ...def, by: [], orderBy: [] };
    assert.deepEqual(rows(compileBreakdown(schema, ungrouped, ANSI_STYLE, 0, scope)), [{ n: 0, total: null }]);
    assert.equal(count(compileBreakdownCount(schema, ungrouped, ANSI_STYLE, scope)), 1);
  }
});

for (const [dialect, style] of [['postgres', POSTGRES_STYLE]] as const) {
  test(`${dialect}: CTE policy bindings precede user bindings, with late joins and reverse aggregates`, (t) => {
    const { schema } = fixture(t);
    const scope: RowScope = {
      tickets: { groups: [[{ column: 'id', op: 'in', value: [10, 11, 12, 14] }]] },
      notes: { groups: [[{ column: 'id', op: 'in', value: [100, 102, 104, 105] }]] },
      people: eq('scope_code', 'A'),
      teams: eq('name', 'Alpha'),
    };
    const def = view({
      aggregates: [{ fn: 'count', via: 'note_ticket', alias: 'notes' }],
      filter: { groups: [[{ path: 'owner_id.name', op: 'contains', value: 'Ali' }]] },
      orderBy: [
        { path: 'approver_id.team_id.name', direction: 'asc' },
        { path: 'id', direction: 'asc' },
      ],
      limit: 7,
    });
    const compiled = compileView(schema, def, style, 2, scope);
    assert.deepEqual(compiled.params, [10, 11, 12, 14, 100, 102, 104, 105, 'A', 'Alpha', '%Ali%', 7, 2]);
    placeholders(compiled, style);
    assert.equal(cteNames(compiled.text).length, 4);
    assert.equal(compiled.joins.length, 3);
    assert.ok(!compiled.text.includes('Alpha') && !compiled.text.includes('%Ali%'), 'policy and request values stay bound');
    assert.match(compiled.text, dialect === 'postgres' ? / LIMIT \$12 OFFSET \$13$/ : / LIMIT \? OFFSET \?$/);
    const counted = compileViewCount(schema, def, style, scope);
    assert.deepEqual(counted.params, [10, 11, 12, 14, 'A', '%Ali%']);
    placeholders(counted, style);
    assert.equal(cteNames(counted.text).length, 2);
    assert.ok(!/\bLIMIT\b|\bOFFSET\b|\bORDER BY\b/.test(counted.text));
  });

  test(`${dialect}: breakdown count retains the scoped prefix and removes only pagination bindings`, (t) => {
    const { schema } = fixture(t);
    const scope: RowScope = { tickets: eq('scope_code', 'A'), people: eq('name', 'Alice'), teams: eq('name', 'Alpha') };
    const def: BreakdownDef = {
      base: 'tickets',
      by: [{ path: 'owner_id.team_id.name', alias: 'team' }],
      measures: [{ fn: 'count', alias: 'n' }],
      filter: { groups: [[{ path: 'amount', op: '>=', value: 10 }]] },
      orderBy: [{ name: 'n', direction: 'desc' }],
      limit: 7,
    };
    const compiled = compileBreakdown(schema, def, style, 2, scope);
    assert.deepEqual(compiled.params, ['A', 'Alice', 'Alpha', 10, 7, 2]);
    placeholders(compiled, style);
    const counted = compileBreakdownCount(schema, def, style, scope);
    assert.deepEqual(counted.params, ['A', 'Alice', 'Alpha', 10]);
    placeholders(counted, style);
    assert.equal(cteNames(counted.text).length, 3);
    assert.ok(!/\bLIMIT\b|\bOFFSET\b/.test(counted.text));
    assert.match(counted.text, /COUNT\(\*\) AS n FROM/);
  });
}

test('CTE names avoid the entire case-folded catalog and CTEs preserve explicit column names', (t) => {
  const { db, schema, rows, count } = fixture(t);
  // These tables are unrelated to the query, but WITH names can shadow them.
  for (const name of ['_TW_SCOPE$0', '_tw_scope$1', '_Tw_ScOpE$2']) {
    db.exec(`CREATE TABLE ${ANSI_STYLE.quote(name)} (id INTEGER PRIMARY KEY, marker TEXT)`);
    schema.tables.push(tableMetadata(db, name));
  }
  db.exec('ALTER TABLE tickets ADD COLUMN "private value" TEXT');
  schema.tables = schema.tables.map((table) => (table.id === 'tickets' ? tableMetadata(db, 'tickets') : table));
  db.prepare('UPDATE tickets SET "private value" = ? WHERE id = 10').run('match');
  const scope: RowScope = { tickets: eq('private value', 'match'), people: true };
  const def = view({ columns: [{ path: 'id' }, { path: 'owner_id.name' }] });
  const reserved = new Set(schema.tables.map((table) => table.name.toLowerCase()));
  for (const style of [ANSI_STYLE, POSTGRES_STYLE]) {
    const compiled = compileView(schema, def, style, 0, scope);
    const names = cteNames(compiled.text);
    assert.equal(names.length, 2);
    assert.equal(new Set(names.map((name) => name.toLowerCase())).size, names.length);
    assert.ok(names.every((name) => !reserved.has(name.toLowerCase())));
    assert.ok(!/SELECT\s+\*/i.test(compiled.text), 'CTEs explicitly project catalog columns, including invisible-capable columns');
    assert.ok(compiled.text.includes(style.quote('private value')));
    assert.deepEqual(compiled.params, ['match', 100, 0]);
    placeholders(compiled, style);
  }
  assert.deepEqual(rows(compileView(schema, def, ANSI_STYLE, 0, scope)), [{ id: 10, 'owner_id.name': 'Alice' }]);
  assert.equal(count(compileViewCount(schema, def, ANSI_STYLE, scope)), 1);
  const collisionTable = view({ base: '_TW_SCOPE$0', columns: [{ path: 'id' }] });
  db.exec('INSERT INTO "_TW_SCOPE$0" VALUES (99, \'physical\')');
  assert.deepEqual(rows(compileView(schema, collisionTable, ANSI_STYLE, 0, { _TW_SCOPE$0: true })), [{ id: 99 }]);
});

test('a binary collation is said by each style on column orders and comparisons, and refused where it cannot be said', (t) => {
  const { schema, rows } = fixture(t);
  const def = view({
    orderBy: [
      { path: 'scope_code', direction: 'desc', collation: 'binary' },
      { path: 'id', direction: 'asc' },
    ],
    filter: { groups: [[{ path: 'scope_code', op: '>', value: 'A', collation: 'binary' }]] },
  });
  for (const [style, clause] of [
    [ANSI_STYLE, ' COLLATE BINARY'],
    [POSTGRES_STYLE, ' COLLATE "C"'],
  ] as const) {
    const compiled = compileView(schema, def, style, 0);
    // Once on the ORDER BY, once on the comparison; the value stays bound.
    assert.equal(compiled.text.split(clause).length - 1, 2, compiled.text);
    assert.deepEqual(compiled.params, ['A', 100, 0]);
    assert.ok(compileViewCount(schema, def, style).text.includes(clause));
  }
  // Executed where the engine can: SQLite's own BINARY is a real collation.
  assert.ok(Array.isArray(rows(compileView(schema, def, ANSI_STYLE, 0))));
  const refused = [
    view({ filter: { groups: [[{ path: 'scope_code', op: 'contains', value: 'A', collation: 'binary' }]] } }),
    view({ filter: { groups: [[{ path: 'scope_code', op: '=', value: 'A', collation: 'nocase' as never }]] } }),
    view({ orderBy: [{ path: 'id', direction: 'asc', near: 3, collation: 'binary' }] }),
  ];
  for (const definition of refused) assert.throws(() => compileView(schema, definition, ANSI_STYLE, 0));
});

test('scope identities use exact qualified catalog IDs rather than conflating same-named tables', (t) => {
  const { db, schema, rows } = fixture(t);
  db.exec(
    "ATTACH DATABASE ':memory:' AS other; CREATE TABLE other.tickets (id INTEGER PRIMARY KEY, scope_code TEXT);" +
      " INSERT INTO other.tickets VALUES (90, 'B'), (91, 'A');",
  );
  const mainTicket = schema.tables.find((table) => table.id === 'tickets')!;
  const qualified: DatabaseSchema = {
    ...schema,
    foreignKeys: [],
    tables: [
      { ...mainTicket, id: 'main.tickets', schema: 'main' },
      {
        ...mainTicket,
        id: 'other.tickets',
        schema: 'other',
        columns: mainTicket.columns.filter((column) => ['id', 'scope_code'].includes(column.name)),
      },
    ],
  };
  const scope: RowScope = { 'main.tickets': eq('scope_code', 'A'), 'other.tickets': eq('scope_code', 'B') };
  assert.deepEqual(rows(compileView(qualified, view({ base: 'main.tickets' }), ANSI_STYLE, 0, scope)), [
    { id: 10 },
    { id: 11 },
    { id: 12 },
    { id: 14 },
  ]);
  assert.deepEqual(rows(compileView(qualified, view({ base: 'other.tickets' }), ANSI_STYLE, 0, scope)), [{ id: 90 }]);
  assert.deepEqual(rows(compileView(qualified, view({ base: 'other.tickets' }), ANSI_STYLE, 0, { 'main.tickets': true })), []);
});

test('forged scope properties in view and breakdown definitions cannot replace the private scope argument', (t) => {
  const { schema, rows, count } = fixture(t);
  const def = view();
  const breakdown: BreakdownDef = {
    base: 'tickets',
    by: [{ path: 'title' }],
    measures: [{ fn: 'count', alias: 'n' }],
    orderBy: [{ name: 'title', direction: 'asc' }],
  };
  const forgeries: RowScope[] = [{ tickets: true }, { tickets: false }, {}];
  for (const claimed of forgeries) {
    // JSON-shaped extra fields are untrusted definition data, even when their
    // names and contents resemble internal execution options.
    const forgedView = { ...def, scope: claimed, rowScope: claimed, options: { scope: claimed } };
    const forgedBreakdown = { ...breakdown, scope: claimed, rowScope: claimed, options: { scope: claimed } };
    assert.deepEqual(rows(compileView(schema, forgedView, ANSI_STYLE, 0, scopeA())), [{ id: 10 }, { id: 11 }, { id: 12 }, { id: 14 }]);
    assert.equal(count(compileViewCount(schema, forgedView, ANSI_STYLE, scopeA())), 4);
    assert.deepEqual(rows(compileBreakdown(schema, forgedBreakdown, ANSI_STYLE, 0, scopeA())), [
      { title: 'keep', n: 3 },
      { title: 'other', n: 1 },
    ]);
    assert.equal(count(compileBreakdownCount(schema, forgedBreakdown, ANSI_STYLE, scopeA())), 2);
    assert.deepEqual(rows(compileView(schema, forgedView, ANSI_STYLE, 0, {})), []);
    assert.equal(count(compileViewCount(schema, forgedView, ANSI_STYLE, {})), 0);
    assert.deepEqual(rows(compileBreakdown(schema, forgedBreakdown, ANSI_STYLE, 0, {})), []);
    assert.equal(count(compileBreakdownCount(schema, forgedBreakdown, ANSI_STYLE, {})), 0);
    assert.deepEqual(compileView(schema, forgedView, ANSI_STYLE), compileView(schema, def, ANSI_STYLE));
    assert.deepEqual(compileViewCount(schema, forgedView, ANSI_STYLE), compileViewCount(schema, def, ANSI_STYLE));
    assert.deepEqual(compileBreakdown(schema, forgedBreakdown, ANSI_STYLE), compileBreakdown(schema, breakdown, ANSI_STYLE));
    assert.deepEqual(compileBreakdownCount(schema, forgedBreakdown, ANSI_STYLE), compileBreakdownCount(schema, breakdown, ANSI_STYLE));
  }
});

test('scope compilation leaves definitions, metadata and later unscoped compilations unchanged', (t) => {
  const { schema } = fixture(t);
  const def = view({
    columns: [{ path: 'id' }, { path: 'owner_id.name', alias: 'Owner' }],
    aggregates: [{ fn: 'count', via: 'note_ticket', alias: 'notes' }],
  });
  const breakdown: BreakdownDef = { base: 'tickets', by: [{ path: 'title' }], measures: [{ fn: 'count', alias: 'n' }] };
  const scope = scopeA();
  const before = structuredClone({ schema, def, breakdown, scope });
  for (const style of [ANSI_STYLE, POSTGRES_STYLE]) {
    const ordinary = compileView(schema, def, style, 2);
    const ordinaryCount = compileViewCount(schema, def, style);
    const ordinaryBreakdown = compileBreakdown(schema, breakdown, style, 2);
    const ordinaryGroups = compileBreakdownCount(schema, breakdown, style);
    const scoped = compileView(schema, def, style, 2, scope);
    assert.deepEqual(scoped.columns, ordinary.columns);
    assert.deepEqual(scoped.joins, ordinary.joins);
    assert.equal(scoped.limit, ordinary.limit);
    assert.deepEqual(compileBreakdown(schema, breakdown, style, 2, scope).columns, ordinaryBreakdown.columns);
    compileViewCount(schema, def, style, scope);
    compileBreakdownCount(schema, breakdown, style, scope);
    assert.deepEqual(compileView(schema, def, style, 2, undefined), ordinary);
    assert.deepEqual(compileViewCount(schema, def, style, undefined), ordinaryCount);
    assert.deepEqual(compileBreakdown(schema, breakdown, style, 2, undefined), ordinaryBreakdown);
    assert.deepEqual(compileBreakdownCount(schema, breakdown, style, undefined), ordinaryGroups);
    assert.deepEqual(compileView(schema, def, style, 2, scope), scoped, 'scope compilation is deterministic');
  }
  assert.deepEqual({ schema, def, breakdown, scope }, before);
});
