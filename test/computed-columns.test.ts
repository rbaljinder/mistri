/**
 * Computed columns (computed.ts): an expression over a record's own columns,
 * judged against the catalog, written into the statement on each engine,
 * read like a column by a list, a sort, a condition and a breakdown, never
 * written, and served to a reader only where every column it reads is.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { parseAppConfig, resolveViews, withRollups, type AppDef } from '../packages/mistri/src/shared/app.js';
import { appRollupRules } from '../packages/mistri/src/shared/appRollups.js';
import { rollupReads } from '../packages/engine/src/shared/rollups.js';
import { appComputedRules } from '../packages/mistri/src/shared/appComputed.js';
import { ComputedError } from '../packages/engine/src/shared/computed.js';
import { parseComputed } from '../packages/engine/src/shared/computedParse.js';
import { evaluateComputed } from '../packages/engine/src/shared/computedValue.js';
import { ANSI_STYLE, POSTGRES_STYLE } from '../packages/engine/src/shared/filter.js';
import { compileView, type ViewDef } from '../packages/engine/src/shared/view.js';
import { textToView } from '../packages/engine/src/shared/viewtext.js';
import { withViewComputed } from '../packages/engine/src/shared/viewLabels.js';
import { compileBreakdown, withBreakdownComputed } from '../packages/engine/src/shared/breakdown.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { sqliteParams } from '../packages/engine/src/adapters/sqlite.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { typesForSchema } from '../packages/mistri/src/server/typegen.js';

const column = (name: string, type: string, extra: object = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const catalog = (dialect: DatabaseSchema['dialect'], flag = 'boolean'): DatabaseSchema =>
  ({
    label: 'tasks',
    dialect,
    readAt: '2026-09-27T00:00:00Z',
    tables: [
      {
        id: 'task',
        name: 'task',
        schema: '',
        columns: [
          column('id', 'integer', { primaryKey: true, nullable: false }),
          column('name', 'text'),
          column('completed', flag, flag === 'integer' ? { flag: true } : {}),
          column('due_on', 'date'),
          column('opened_on', 'date'),
          column('estimate', 'integer'),
          column('spent', 'integer'),
          column('project_id', 'integer'),
          column('term', 'integer'),
          column('owner', 'text'),
        ],
      },
      {
        id: 'project',
        name: 'project',
        schema: '',
        columns: [column('id', 'integer', { primaryKey: true, nullable: false }), column('ends_on', 'date')],
      },
    ],
    foreignKeys: [{ name: 'task_project', from: { table: 'task', columns: ['project_id'] }, to: { table: 'project', columns: ['id'] } }],
  }) as DatabaseSchema;

const computed = {
  is_overdue: { type: 'boolean', value: 'due_on < today and not completed' },
  days_open: { type: 'number', value: 'today - opened_on' },
  renews_on: { type: 'date', value: 'due_on + term months' },
  burn: { type: 'number', value: 'spent / estimate' },
  late_for_project: { type: 'boolean', value: 'due_on > project_id.ends_on' },
  mine: { type: 'boolean', value: 'owner = me' },
};
const app = (more: object = {}): AppDef =>
  parseAppConfig(
    {
      id: 'tasks',
      name: 'Tasks',
      resources: { task: { computed, ...more }, project: {} },
      views: { tasks: { kind: 'list', from: 'task' } },
      home: 'tasks',
    },
    'computed fixture',
  );
const NOW = new Date('2026-09-27T15:00:00Z');

describe('the words', () => {
  test('an expression parses to a tree, a bare word after = is a value, and mistakes say where they stand', () => {
    assert.deepEqual(
      parseComputed('status = open', (path) => path === 'status'),
      { k: 'op', op: '=', left: { k: 'path', path: 'status' }, right: { k: 'text', value: 'open' } },
    );
    assert.deepEqual(
      parseComputed('ends_on + 3 months', () => true),
      { k: 'op', op: '+', left: { k: 'path', path: 'ends_on' }, right: { k: 'span', unit: 'month', of: { k: 'number', value: 3 } } },
    );
    for (const [text, at] of [
      ['due_on <', 8],
      ['due_on = null', 9],
      ["name = 'a\\b'", 7],
      ['due_on < today due_on', 15],
    ] as const) {
      assert.throws(
        () => parseComputed(text, () => true),
        (error: unknown) => error instanceof ComputedError && error.at === at,
        text,
      );
    }
  });

  test("`in (…)` and `not in (…)` are the query language's list: the equalities they mean, typed, compiled and worked out as `=` is", () => {
    const owner = (path: string) => path === 'owner';
    const eq = (value: string) => ({ k: 'op', op: '=', left: { k: 'path', path: 'owner' }, right: { k: 'text', value } });
    assert.deepEqual(parseComputed("owner in (ada, 'bo b')", owner), { k: 'op', op: 'or', left: eq('ada'), right: eq('bo b') });
    assert.deepEqual(parseComputed('owner not in (ada)', owner), { k: 'not', of: eq('ada') });
    assert.deepEqual(parseComputed('estimate in (1, spent + 1)', () => true).k, 'op');
    for (const [text, at] of [
      ['owner in ()', 10],
      ['owner in (ada', 13],
      ['owner in ada', 9],
    ] as const)
      assert.throws(
        () => parseComputed(text, owner),
        (error: unknown) => error instanceof ComputedError && error.at === at,
        text,
      );
    const judged = (value: string) => appComputedRules(app({ computed: { x: { type: 'boolean', value } } }), catalog('sqlite')).problems;
    assert.deepEqual(judged('owner in (ada, bo) and estimate not in (1, 2)'), []);
    assert.match(judged("estimate in (1, 'two')")[0], /"=" compares a number with a text/);
    const listed = { open_for: { type: 'boolean', value: 'owner in (ada, bo) and estimate not in (1, 2)' } };
    const view: ViewDef = { id: 'v', name: 'v', base: 'task', columns: [{ path: 'open_for' }] };
    const text = (dialect: 'sqlite' | 'postgres') => {
      const served = withRollups(app({ computed: listed }), catalog(dialect), NOW, null);
      const style = { sqlite: ANSI_STYLE, postgres: POSTGRES_STYLE }[dialect];
      return compileView(served, withViewComputed(served, view), style).text;
    };
    assert.match(
      text('sqlite'),
      /\(\("task_0"\."owner" = 'ada'\) OR \("task_0"\."owner" = 'bo'\)\) AND \(NOT \(\("task_0"\."estimate" = 1\) OR/,
    );
    assert.match(text('postgres'), /THEN TRUE ELSE FALSE END/);
    const tree = parseComputed('owner in (ada, bo) and estimate not in (1, 2)', (path) => path === 'owner' || path === 'estimate');
    const worked = (row: Record<string, string | number | null>) =>
      evaluateComputed(tree, { today: '2026-09-27', now: NOW, me: null }, (path) => row[path] ?? null);
    assert.equal(worked({ owner: 'bo', estimate: 3 }), true);
    assert.equal(worked({ owner: 'bo', estimate: 2 }), false);
    assert.equal(worked({ owner: 'cy', estimate: 3 }), false);
  });

  test('the catalog judges each expression: its columns, what it comes to, and a name of its own', () => {
    const judged = (value: string, type = 'boolean', name = 'x') =>
      appComputedRules(app({ computed: { [name]: { type, value } } }), catalog('sqlite')).problems;
    assert.deepEqual(appComputedRules(app(), catalog('sqlite')).problems, []);
    assert.match(judged('due_on < today and not complted')[0], /computed "x": "complted" is not a column on task/);
    assert.match(
      judged('today - opened_on')[0],
      /is declared a boolean, and "today - opened_on" is a number\. Declare it computed\.number/,
    );
    assert.match(judged('name + 1', 'number')[0], /"\+" adds numbers, or days to a date/);
    assert.match(judged('due_on < today', 'boolean', 'name')[0], /already has a column or a rollup "name"/);
    assert.match(judged('project_id.nope = 1')[0], /"nope" is not a column on project/);
    assert.match(appComputedRules(app(), catalog('http')).problems[0], /read from an API, which computes nothing/);
  });

  test("read-only everywhere: a computed column in a write rule, a form or an action's set is refused", () => {
    const problems = appComputedRules(
      parseAppConfig(
        {
          id: 'tasks',
          name: 'Tasks',
          resources: {
            task: {
              access: 'write',
              computed,
              form: { show: ['name', 'is_overdue'] },
              actions: { flag: { label: 'Flag', set: { is_overdue: true } } },
            },
            project: {},
          },
          auth: {
            roles: {
              staff: {
                read: true,
                write: true,
                fields: { task: { read: ['id', 'name', 'due_on', 'days_open'], write: ['name', 'days_open'] } },
              },
            },
          },
          views: { tasks: { kind: 'list', from: 'task' } },
          home: 'tasks',
        },
        'x',
      ),
      catalog('sqlite'),
    ).problems;
    assert.ok(
      problems.some((p) => /"form", show asks for "is_overdue", which is computed/.test(p)),
      problems.join('\n'),
    );
    assert.ok(problems.some((p) => /action "flag" sets "is_overdue", which is computed/.test(p)));
    assert.ok(problems.some((p) => /role "staff", "fields", "task", write names "days_open", which is computed/.test(p)));
  });
});

describe('the statement, on each engine', () => {
  const view: ViewDef = {
    id: 'v',
    name: 'v',
    base: 'task',
    columns: [{ path: 'name' }, { path: 'is_overdue' }, { path: 'days_open' }, { path: 'renews_on' }, { path: 'burn' }],
    filter: { groups: [[{ path: 'is_overdue', op: '=', value: true }]] },
    orderBy: [{ path: 'days_open', direction: 'desc' }],
  };
  const compiled = (dialect: 'sqlite' | 'postgres', flag = 'boolean') => {
    const served = withRollups(app(), catalog(dialect, flag), NOW, 'ada@example.test');
    const style = { sqlite: ANSI_STYLE, postgres: POSTGRES_STYLE }[dialect];
    return compileView(served, withViewComputed(served, view), style);
  };

  test("SQLite: julianday for days, date() for a span, a 0/1 flag read as not 0, today the App's day", () => {
    const { text } = compiled('sqlite', 'integer');
    assert.match(text, /CASE WHEN \(\("task_0"\."due_on" < '2026-09-27'\) AND \(NOT \("task_0"\."completed" <> 0\)\)\) THEN 1 ELSE 0 END/);
    assert.match(text, /CAST\(julianday\(date\('2026-09-27'\)\) - julianday\(date\("task_0"\."opened_on"\)\) AS INTEGER\)/);
    assert.match(text, /date\("task_0"\."due_on", printf\('%\+d months', CAST\(\("task_0"\."term"\) AS INTEGER\)\)\)/);
    assert.match(text, /\(\("task_0"\."spent"\) \* 1\.0 \/ NULLIF\("task_0"\."estimate", 0\)\)/);
    assert.match(text, /ORDER BY \(CAST\(julianday/);
  });

  test('PostgreSQL: a DATE literal, date subtraction, an interval for months, a native boolean read as itself', () => {
    const { text } = compiled('postgres');
    assert.match(
      text,
      /CASE WHEN \(\("task_0"\."due_on" < DATE '2026-09-27'\) AND \(NOT "task_0"\."completed"\)\) THEN TRUE ELSE FALSE END/,
    );
    assert.match(text, /\(CAST\(DATE '2026-09-27' AS DATE\) - CAST\("task_0"\."opened_on" AS DATE\)\)/);
    assert.match(text, /CAST\(CAST\("task_0"\."due_on" AS DATE\) \+ \("task_0"\."term"\) \* INTERVAL '1 month' AS DATE\)/);
    // A 0/1 integer flag on PostgreSQL is compared, never negated as a boolean.
    assert.match(compiled('postgres', 'integer').text, /NOT \("task_0"\."completed" <> 0\)/);
  });

  test("`me` is the reader's email, and nobody for a visitor", () => {
    const one = (me: string | null) => {
      const served = withRollups(app(), catalog('sqlite'), NOW, me);
      return compileView(served, withViewComputed(served, { id: 'v', name: 'v', base: 'task', columns: [{ path: 'mine' }] }), ANSI_STYLE)
        .text;
    };
    assert.match(one('ada@example.test'), /"task_0"\."owner" = 'ada@example\.test'/);
    assert.match(one(null), /"task_0"\."owner" = NULL/);
  });

  test('through a reference, the joins it needs are planned, and a request cannot write its own expression', () => {
    const served = withRollups(app(), catalog('sqlite'), NOW);
    const text = compileView(
      served,
      withViewComputed(served, { id: 'v', name: 'v', base: 'task', columns: [{ path: 'late_for_project' }] }),
      ANSI_STYLE,
    ).text;
    assert.match(
      text,
      /"task_0"\."due_on" > "project_1"\."ends_on"[\s\S]*LEFT JOIN "project" "project_1" ON "project_1"\."id" = "task_0"\."project_id"/,
    );
    const forged = withViewComputed(served, {
      id: 'v',
      name: 'v',
      base: 'task',
      columns: [{ path: 'name' }],
      expressions: { name: { type: 'boolean', expr: { k: 'text', value: 'x' }, reads: [], on: '' } },
    });
    assert.equal(forged.expressions, undefined);
  });

  test('the query language names one, and a dashboard groups and counts by it', () => {
    const served = withRollups(app(), catalog('sqlite'), NOW);
    const parsed = textToView(served, 'task is_overdue = true sort days_open desc show name, days_open');
    assert.deepEqual(parsed.errors, []);
    assert.match(compileView(served, withViewComputed(served, parsed.view!), ANSI_STYLE).text, /WHERE[\s\S]*CASE WHEN/);
    const grouped = withBreakdownComputed(served, { base: 'task', by: [{ path: 'is_overdue' }], measures: [{ fn: 'count' }] } as never);
    assert.match(compileBreakdown(served, grouped, ANSI_STYLE).text, /GROUP BY[\s\S]*|CASE WHEN/);
  });

  test('its name and type reach the generated types', () => {
    const text = typesForSchema(withRollups(app(), catalog('sqlite'), NOW));
    assert.match(text, /task: [^;]*"is_overdue" \| "days_open"/);
    // What a query string is read against (packages/mistri/schema/query.d.ts) names them with their kinds.
    assert.match(text, /export type Columns = \{[\s\S]*task: \{ [^}]*is_overdue: 'boolean'; days_open: 'number'/);
    assert.match(
      text,
      /export type Computed = \{\n {2}task: \{ is_overdue: boolean; days_open: number \| null; renews_on: string \| null;/,
    );
  });
});

describe('a rollup and a dashboard window read one', () => {
  /* A project over its tasks, and a task over its notes: a rollup of a task's computed column is written inline in
     the project's subquery, and one computed from a task's own rollup is refused, so no rollup reads a rollup by
     the back door. */
  const tree = (): DatabaseSchema =>
    ({
      label: 'work',
      dialect: 'sqlite',
      readAt: '2026-09-27T00:00:00Z',
      tables: [
        {
          id: 'project',
          name: 'project',
          schema: '',
          columns: [column('id', 'integer', { primaryKey: true, nullable: false }), column('ends_on', 'date')],
        },
        {
          id: 'task',
          name: 'task',
          schema: '',
          columns: [
            column('id', 'integer', { primaryKey: true, nullable: false }),
            column('project_id', 'integer'),
            column('estimate', 'integer'),
            column('spent', 'integer'),
            column('due_on', 'date'),
            column('term', 'integer'),
            column('owner', 'text'),
          ],
        },
        {
          id: 'note',
          name: 'note',
          schema: '',
          columns: [column('id', 'integer', { primaryKey: true, nullable: false }), column('task_id', 'integer')],
        },
      ],
      foreignKeys: [
        { name: 'task_project', from: { table: 'task', columns: ['project_id'] }, to: { table: 'project', columns: ['id'] } },
        { name: 'note_task', from: { table: 'note', columns: ['task_id'] }, to: { table: 'task', columns: ['id'] } },
      ],
    }) as DatabaseSchema;
  const work = (rollups: Record<string, object>, more: Record<string, { type: string; value: string }> = {}): AppDef =>
    parseAppConfig(
      {
        id: 'work',
        name: 'Work',
        resources: {
          project: { rollups, computed: { closes_on: { type: 'date', value: 'ends_on + 0 days' } } },
          task: {
            rollups: { notes: { fn: 'count', from: 'note' } },
            computed: {
              overrun: { type: 'number', value: 'spent - estimate' },
              renews_on: { type: 'date', value: 'due_on + term months' },
              mine: { type: 'boolean', value: 'owner = me' },
              noted: { type: 'number', value: 'notes * 2' },
              late: { type: 'number', value: 'project_id.ends_on - due_on' },
              ...more,
            },
          },
          note: {},
        },
        views: {
          projects: { kind: 'list', from: 'project' },
          board: {
            kind: 'dashboard',
            label: 'Board',
            sections: [
              { kind: 'metric', title: 'Renewing', from: 'task', over: 'renews_on' },
              { kind: 'metric', title: 'Closing', from: 'project', over: 'closes_on' },
            ],
          },
        },
        home: 'projects',
        nav: ['projects', 'board'],
      },
      'rollup fixture',
    );
  const ruled = (rollups: Record<string, object>) => appRollupRules(work(rollups), tree(), NOW);

  test('a sum, a min or a max may name a computed column of its rows, judged by what it comes to', () => {
    const { rules, problems } = ruled({
      overrun: { fn: 'sum', from: 'task', column: 'overrun' },
      next: { fn: 'min', from: 'task', column: 'renews_on' },
    });
    assert.deepEqual(problems, []);
    const overrun = rules.get('project')!.overrun;
    assert.deepEqual(
      [overrun.column, overrun.type, overrun.expression?.type, overrun.expression?.reads],
      ['overrun', 'numeric', 'number', ['spent', 'estimate']],
    );
    // The grants a rollup is held to are the columns under it, never the computed name.
    assert.deepEqual(rollupReads(overrun), [{ table: 'task', fields: ['project_id', 'spent', 'estimate'] }]);
    assert.equal(rules.get('project')!.next.type, 'date');
  });

  test('one that reads a rollup, a reference or the reader is refused by name, and a yes-or-no is no sum', () => {
    const said = (column: string) => ruled({ x: { fn: 'sum', from: 'task', column } }).problems;
    assert.match(
      said('noted')[0],
      /rollups "x": "task\.noted" is computed from the rollup "notes", and a rollup reads a computed column only when it reads the row's own columns/,
    );
    assert.match(said('late')[0], /"task\.late" reads "project_id\.ends_on" through a reference/);
    assert.match(said('mine')[0], /"task\.mine" says "me", and a rollup is the same figure for every reader/);
    assert.match(ruled({ x: { fn: 'max', from: 'task', column: 'mine' } }).problems[0], /says "me"/);
    const flag = appRollupRules(
      work({ x: { fn: 'sum', from: 'task', column: 'done' } }, { done: { type: 'boolean', value: 'spent > estimate' } }),
      tree(),
      NOW,
    ).problems;
    assert.match(flag[0], /the computed column "task\.done" is boolean; a sum reads numbers/);
  });

  test("a rollup's query narrows its rows by a computed column of theirs, and `now` is the request's", () => {
    // Count the rows a computed rule says are past due, not only the ones a stored column says.
    const late = { breached: { type: 'boolean', value: 'due_on < today' } };
    const { rules, problems } = appRollupRules(
      work(
        {
          overdue: { fn: 'count', from: 'task', query: 'breached = true' },
          over: { fn: 'sum', from: 'task', column: 'spent', query: 'overrun > 0 or breached = true' },
        },
        late,
      ),
      tree(),
      NOW,
    );
    assert.deepEqual(problems, []);
    const overdue = rules.get('project')!.overdue;
    assert.deepEqual(Object.keys(overdue.computed ?? {}), ['breached']);
    // Held to the columns under it, as a summed computed column is.
    assert.deepEqual(rollupReads(rules.get('project')!.over), [
      { table: 'task', fields: ['project_id', 'spent', 'spent', 'estimate', 'due_on'] },
    ]);
    // What a rollup cannot read in a sum, it cannot read in its query either.
    const refused = (query: string) =>
      appRollupRules(work({ x: { fn: 'count', from: 'task', query } }, late), tree(), NOW).problems[0] ?? '';
    assert.match(refused('noted > 0'), /"task\.noted" is computed from the rollup "notes"/);
    assert.match(refused('late > 0'), /"task\.late" reads "project_id\.ends_on" through a reference/);
    assert.match(refused('mine = true'), /"task\.mine" says "me"/);
    assert.match(refused('nothing > 0'), /"nothing" is not a column on task/);

    const served = withRollups(
      work(
        {
          overdue: { fn: 'count', from: 'task', query: 'breached = true' },
          over: { fn: 'sum', from: 'task', column: 'spent', query: 'overrun > 0 or breached = true' },
        },
        late,
      ),
      tree(),
      NOW,
    );
    const { text, params } = compileView(
      served,
      withViewComputed(served, {
        id: 'v',
        name: 'v',
        base: 'project',
        columns: [{ path: 'id' }, { path: 'overdue' }, { path: 'over' }],
        orderBy: [{ path: 'id', direction: 'asc' }],
      }),
      ANSI_STYLE,
    );
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE project (id INTEGER PRIMARY KEY, ends_on DATE);
      CREATE TABLE task (id INTEGER PRIMARY KEY, project_id INTEGER, estimate INTEGER, spent INTEGER, due_on DATE, term INTEGER, owner TEXT);
      INSERT INTO project VALUES (1, '2026-12-31'), (2, '2026-12-31');
      INSERT INTO task VALUES (1, 1, 5, 8, '2026-12-15', 1, 'a'), (2, 1, 4, 3, '2026-03-15', 2, 'b'), (3, 1, 9, 1, '2026-12-01', 1, 'c'),
        (4, 2, 2, 2, '2026-12-01', 12, 'd');`);
    assert.deepEqual(
      db
        .prepare(text)
        .all(...sqliteParams(params))
        .map((row) => ({ ...row })),
      [
        // Before 2026-09-27 is past due: task 2 alone; overrun or past due: tasks 1 and 2.
        { id: 1, overdue: 1, over: 11 },
        { id: 2, overdue: 0, over: 0 },
      ],
    );
    db.close();
  });

  test('its expression is written inside the aggregate, and SQLite sums what a list of the rows would show', () => {
    const served = withRollups(
      work({ overrun: { fn: 'sum', from: 'task', column: 'overrun' }, next: { fn: 'min', from: 'task', column: 'renews_on' } }),
      tree(),
      NOW,
    );
    const { text, params } = compileView(
      served,
      withViewComputed(served, {
        id: 'v',
        name: 'v',
        base: 'project',
        columns: [{ path: 'id' }, { path: 'overrun' }, { path: 'next' }],
        orderBy: [{ path: 'overrun', direction: 'desc' }],
      }),
      ANSI_STYLE,
    );
    assert.match(
      text,
      /\(SELECT COALESCE\(SUM\(\("task_\d+"\."spent" - "task_\d+"\."estimate"\)\), 0\) FROM "task" "task_\d+" WHERE "task_\d+"\."project_id" = "project_0"\."id"\)/,
    );
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE project (id INTEGER PRIMARY KEY, ends_on DATE);
      CREATE TABLE task (id INTEGER PRIMARY KEY, project_id INTEGER, estimate INTEGER, spent INTEGER, due_on DATE, term INTEGER, owner TEXT);
      INSERT INTO project VALUES (1, '2026-12-31'), (2, '2026-12-31');
      INSERT INTO task VALUES (1, 1, 5, 8, '2026-01-15', 1, 'a'), (2, 1, 4, 3, '2026-03-15', 2, 'b'), (3, 2, 2, 2, '2026-06-01', 12, 'c');`);
    assert.deepEqual(
      db
        .prepare(text)
        .all(...(params as never[]))
        .map((row) => ({ ...row })),
      [
        { id: 1, overrun: 2, next: '2026-02-15' },
        { id: 2, overrun: 0, next: '2027-06-01' },
      ],
    );
    db.close();
  });

  test('a dashboard section windows over a computed date, and the phrase reads it as the list does', () => {
    const served = withRollups(work({}), tree(), NOW);
    const board = resolveViews(work({}), served).board as { error?: string; windows?: string[] };
    assert.equal(board.error, undefined);
    assert.deepEqual(board.windows, ['last 30 days', 'last 90 days', 'last 12 months']);
    const parsed = textToView(served, 'task renews_on = last 30 days show id');
    assert.deepEqual(parsed.errors, []);
    assert.match(compileView(served, withViewComputed(served, parsed.view!), ANSI_STYLE).text, /WHERE[\s\S]*printf\('%\+d months'/);
    // A computed yes-or-no is not a date, and is refused as a stored one is.
    const flagged = parseAppConfig(
      {
        id: 'work',
        name: 'Work',
        resources: { task: { computed: { done: { type: 'boolean', value: 'spent > estimate' } } }, project: {} },
        views: { board: { kind: 'dashboard', label: 'Board', sections: [{ kind: 'metric', title: 'Done', from: 'task', over: 'done' }] } },
        home: 'board',
      },
      'x',
    );
    assert.match(
      (resolveViews(flagged, withRollups(flagged, tree(), NOW)).board as { error?: string }).error ?? '',
      /"done" is boolean, so the time window cannot narrow by it/,
    );
  });
});

describe('a running App', () => {
  test('SQLite answers with the value, sorts and filters by it; a role that cannot read its inputs is not served it', async (t) => {
    const previousClock = process.env.MISTRI_CLOCK;
    process.env.MISTRI_CLOCK = NOW.toISOString();
    t.after(() => {
      if (previousClock === undefined) delete process.env.MISTRI_CLOCK;
      else process.env.MISTRI_CLOCK = previousClock;
    });
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-computed-'));
    const file = join(directory, 'tasks.db');
    const db = new DatabaseSync(file);
    const day = (offset: number) => new Date(NOW.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
    db.exec(`CREATE TABLE task (id INTEGER PRIMARY KEY, name TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
      due_on DATE, opened_on DATE);
      INSERT INTO task VALUES (1, 'Late', 0, '${day(-2)}', '${day(-10)}'), (2, 'Soon', 0, '${day(3)}', '${day(-1)}'),
        (3, 'Done late', 1, '${day(-5)}', '${day(-20)}');`);
    const registry = new Registry();
    registry.add({ id: 'tasks', name: 'Tasks', url: file, source: 'config' });
    const definition = parseAppConfig(
      {
        id: 'tasks',
        name: 'Tasks',
        connection: 'tasks',
        ui: { timezone: 'UTC' },
        resources: {
          task: {
            computed: {
              is_overdue: { type: 'boolean', value: 'due_on < today and not completed' },
              days_open: { type: 'number', value: 'today - opened_on' },
            },
          },
        },
        auth: {
          roles: {
            lead: { read: true },
            guest: { read: true, fields: { task: { read: ['id', 'name', 'completed', 'opened_on'] } } },
          },
        },
        views: { tasks: { kind: 'list', from: 'task' } },
        home: 'tasks',
      },
      'computed app',
    );
    let role = 'lead';
    const host: AppHost = {
      app: { path: 'tasks.ts', app: definition, pages: [], sources: {} },
      pages: [],
      auth: {
        spec: definition.auth!,
        store: 'not-used',
        handler: async () => {},
        close: async () => {},
        session: async () => ({ id: 'account', who: 'person@example.test', role }),
      },
    };
    const bound = { host: '127.0.0.1', port: 0 };
    const server = createApp({ registry, bound, apps: [host], pages: [] });
    server.listen(0, bound.host);
    await once(server, 'listening');
    bound.port = (server.address() as { port: number }).port;
    const run = async (view: object) => {
      const response = await fetch(`http://${bound.host}:${bound.port}/api/view/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app: 'tasks', view: { id: 'v', name: 'v', base: 'task', ...view } }),
        signal: AbortSignal.timeout(10_000),
      });
      return { status: response.status, body: await response.json() };
    };
    try {
      const read = await run({
        columns: [{ path: 'name' }, { path: 'is_overdue' }, { path: 'days_open' }],
        orderBy: [{ path: 'days_open', direction: 'desc' }],
      });
      assert.equal(read.status, 200, JSON.stringify(read.body));
      assert.deepEqual(
        read.body.rows.map((row: Record<string, unknown>) => [row.name, row.is_overdue, row.days_open]),
        [
          ['Done late', 0, 20],
          ['Late', 1, 10],
          ['Soon', 0, 1],
        ],
      );
      const overdue = await run({ columns: [{ path: 'name' }], filter: { groups: [[{ path: 'is_overdue', op: '=', value: true }]] } });
      assert.deepEqual(
        overdue.body.rows.map((row: Record<string, unknown>) => row.name),
        ['Late'],
      );
      const schema = (await (await fetch(`http://${bound.host}:${bound.port}/api/schema?app=tasks`)).json()) as DatabaseSchema;
      assert.deepEqual(Object.keys(schema.tables.find((table) => table.id === 'task')!.computed ?? {}), ['is_overdue', 'days_open']);

      /* The guest reads no due date: `is_overdue` is not served, so it cannot
         be shown, filtered or sorted by — it would say what `due_on` may not.
         `days_open` reads only what the guest reads, so it is served. */
      role = 'guest';
      const leaked = [
        await run({ columns: [{ path: 'name' }, { path: 'is_overdue' }] }),
        await run({ columns: [{ path: 'name' }], filter: { groups: [[{ path: 'is_overdue', op: '=', value: true }]] } }),
        await run({ columns: [{ path: 'name' }], orderBy: [{ path: 'is_overdue', direction: 'desc' }] }),
        await run({
          columns: [{ path: 'name' }],
          expressions: { name: { type: 'boolean', expr: { k: 'path', path: 'due_on' }, reads: ['due_on'], on: '' } },
        }),
      ];
      // Shown, filtered or sorted by, it is a column that is not there: refused, and no rows come back.
      for (const answer of leaked.slice(0, 3)) {
        assert.equal(answer.status, 400, JSON.stringify(answer));
        assert.match(answer.body.error, /"is_overdue" is not a column on task/);
      }
      // An expression a request writes is never compiled: every row comes back, none saying anything of due_on.
      assert.deepEqual(leaked[3].body.rows, [{ name: 'Late' }, { name: 'Soon' }, { name: 'Done late' }], JSON.stringify(leaked[3]));
      assert.equal(leaked[3].body.view.expressions, undefined);
      const guestSchema = (await (await fetch(`http://${bound.host}:${bound.port}/api/schema?app=tasks`)).json()) as DatabaseSchema;
      assert.deepEqual(Object.keys(guestSchema.tables.find((table) => table.id === 'task')!.computed ?? {}), ['days_open']);
      const allowed = await run({ columns: [{ path: 'name' }, { path: 'days_open' }] });
      assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
    } finally {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      await registry.closeAll();
      clearJournal('tasks');
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
