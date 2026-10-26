import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { typecheck } from './support/tsc.js';
import { listPresentationColumns, resolveViews, type AppListView } from '../packages/mistri/src/shared/app.js';
import type { AppBoardList, AppQueueList } from '../packages/engine/src/shared/listPresentations.js';
import { fieldAccessibleApp } from '../packages/mistri/src/server/app/appFieldProjection.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { defineCommand } from '../packages/mistri/src/server/commands/businessCommands.js';
import { parseTestApp } from './support/commandCatalog.js';
import { keyedPresentation } from './support/keyedPresentation.js';

/**
 * The queue and the board are the second and third presentations a list can
 * take. They share the checklist's grammar — local readable columns, refused
 * by name — and its boundary: a presentation curates reading and never
 * grants a write. The bulk flag is the one new word, and only a fixed update
 * may say it.
 */
const queue = {
  kind: 'queue',
  primary: 'title',
  lines: ['state', 'priority'],
  properties: ['state'],
  openLabel: 'Review payroll',
} as const;
const board = { kind: 'board', by: 'state', lanes: ['new', 'working', 'done'], primary: 'title', lines: ['priority'] } as const;
/* What the parser keeps: the authored card, as written. */
const queueList: AppQueueList = {
  kind: 'queue',
  primary: 'title',
  lines: ['state', 'priority'],
  facts: ['state'],
  openLabel: 'Review payroll',
};
const boardList: AppBoardList = { kind: 'board', by: 'state', lanes: ['new', 'working', 'done'], primary: 'title', lines: ['priority'] };
const parse = ({ actions, segments, ...view }: Record<string, unknown> = {}) =>
  parseTestApp(
    {
      name: 'Work',
      resources: { tasks: { ...(actions === undefined ? {} : { actions }), ...(segments === undefined ? {} : { segments }) } },
      views: { tasks: keyedPresentation({ kind: 'list', from: 'tasks', ...view }) },
      home: 'tasks',
      nav: ['tasks'],
    },
    'list fixture',
  );
const schema: DatabaseSchema = {
  label: 'Work',
  dialect: 'sqlite',
  readAt: '',
  foreignKeys: [],
  tables: [
    {
      id: 'tasks',
      name: 'tasks',
      schema: '',
      isView: false,
      columns: [
        { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
        { name: 'title', type: 'TEXT', nullable: false, primaryKey: false },
        { name: 'state', type: 'TEXT', nullable: false, primaryKey: false, allowed: ['new', 'working', 'done', 'canceled'] },
        { name: 'priority', type: 'TEXT', nullable: true, primaryKey: false },
        { name: 'count', type: 'INTEGER', nullable: true, primaryKey: false },
      ],
    },
  ],
};

test('queue and board presentations round-trip with trimmed local columns and ordered lanes', () => {
  const q = parse({
    presentation: { kind: 'queue', primary: ' title ', lines: [' priority '], properties: [' state '], openLabel: ' Review payroll ' },
  }).views.tasks as AppListView;
  assert.deepEqual(q.presentation, { kind: 'queue', primary: 'title', lines: ['priority'], facts: ['state'], openLabel: 'Review payroll' });
  const b = parse({ presentation: { ...board, lanes: [' new ', 'done'] } }).views.tasks as AppListView;
  assert.deepEqual(b.presentation, { kind: 'board', by: 'state', lanes: ['new', 'done'], primary: 'title', lines: ['priority'] });
  const bare = parse({ presentation: { kind: 'board', by: 'state', primary: 'title' } }).views.tasks as AppListView;
  assert.deepEqual(bare.presentation, { kind: 'board', by: 'state', primary: 'title' });
  assert.deepEqual(listPresentationColumns(queueList), ['title', 'state', 'priority']);
  assert.deepEqual(listPresentationColumns(boardList), ['state', 'title', 'priority']);
  assert.deepEqual(listPresentationColumns({ kind: 'checklist', primary: 'title', checked: 'done' }), ['title', 'done']);
  for (const [presentation, list] of [
    [queue, queueList],
    [board, boardList],
  ] as const) {
    const view = resolveViews(parse({ presentation }), schema).tasks as AppListView & { error?: string };
    assert.equal(view.error, undefined);
    assert.deepEqual(view.presentation, list);
  }
});

test('queue and board parsers refuse unknown kinds, keys, paths and malformed lanes by name', () => {
  assert.throws(
    () => parse({ presentation: { kind: 'kanban', primary: 'title' } }),
    /presentation needs a "kind" of "checklist", "queue", "board", "calendar", "tree", "gantt", "cards", "split" or "custom"/,
  );
  assert.throws(
    () => parse({ presentation: { ...queue, checked: 'done' } }),
    /presentation \(a queue\) has no "checked"\. "checked" belongs inside "presentation" \(checklist\)\. It takes: kind, primary, lines/,
  );
  // A board's card carries one line; the queue's second (meta) position is the queue's alone.
  assert.throws(
    () => parse({ presentation: { ...board, lines: ['priority', 'state'] } }),
    /"lines" must be a list of at most 1 local column beneath the primary/,
  );
  const bad = [null, 4, '', ' ', 'owner.department.name'];
  for (const value of bad) {
    assert.throws(
      () => parse({ presentation: { ...queue, primary: value } }),
      /presentation: "primary" must be a local column or a one-hop label path/,
    );
    assert.throws(
      () => parse({ presentation: { ...queue, lines: [value] } }),
      /presentation, lines: "0" must be a local column or a one-hop label path/,
    );
    assert.throws(
      () => parse({ presentation: { ...queue, lines: ['state', value] } }),
      /presentation, lines: "1" must be a local column or a one-hop label path/,
    );
    assert.throws(
      () => parse({ presentation: { ...queue, properties: [value] } }),
      /presentation, properties: "0" must be a local column or a one-hop label path/,
    );
    assert.throws(() => parse({ presentation: { ...board, by: value } }), /presentation: "by" must name a local column/);
    assert.throws(
      () => parse({ presentation: { ...board, primary: value } }),
      /presentation: "primary" must be a local column or a one-hop label path/,
    );
    assert.throws(() => parse({ presentation: { ...board, lines: [value] } }), /presentation, lines: "0" must name a local column/);
  }
  /* A queue with no `primary` says the record's name (42297f25); one that names it still names a column. */
  assert.equal(
    (parse({ presentation: { kind: 'queue' } }).views.tasks as AppListView & { presentation: AppQueueList }).presentation.primary,
    '$label',
  );
  assert.throws(
    () => parse({ presentation: { ...queue, properties: [] } }),
    /presentation: "properties" must be one to 6 local columns or one-hop label paths/,
  );
  assert.throws(
    () => parse({ presentation: { ...queue, properties: Array.from({ length: 7 }, (_, i) => `fact_${i}`) } }),
    /presentation: "properties" must be one to 6 local columns or one-hop label paths/,
  );
  for (const openLabel of ['', ' ', 4, null]) {
    assert.throws(() => parse({ presentation: { ...queue, openLabel } }), /presentation: "openLabel" must be a non-empty string/);
  }
  assert.throws(() => parse({ presentation: { kind: 'board', primary: 'title' } }), /presentation: "by" must name a local column/);
  for (const lanes of [[], 'new', [''], [' '], [4], Array.from({ length: 9 }, (_, i) => `lane${i}`)]) {
    assert.throws(() => parse({ presentation: { ...board, lanes } }), /presentation: "lanes" must be one to eight non-empty lane values/);
  }
  assert.throws(() => parse({ presentation: { ...board, lanes: ['new', ' new'] } }), /presentation: "lanes" must be unique/);
  // The checklist refuses the same mistakes in the same words.
  assert.throws(
    () => parse({ presentation: { kind: 'checklist', primary: 'title', checked: 'done', extra: 1 } }),
    /presentation \(a checklist\) has no "extra"\. It takes: kind, primary, checked, lines/,
  );
});

test('catalog validation judges queue and board columns and lanes against the readable table', () => {
  const problem = (presentation: object, catalog = schema) =>
    (resolveViews(parse({ presentation }), catalog).tasks as { error?: string }).error;
  assert.match(problem({ ...queue, primary: 'missing' })!, /Queue primary: "missing" must be a readable column/);
  assert.match(problem({ ...queue, primary: 'count' })!, /Queue primary must be a text column/);
  assert.match(problem({ ...queue, lines: ['state', 'missing'] })!, /Queue lines\[1\]: "missing" must be a readable column/);
  assert.match(problem({ ...queue, properties: ['missing'] })!, /Queue properties\[0\]: "missing" must be a readable column/);
  assert.match(problem({ ...board, by: 'missing' })!, /Board by: "missing" must be a local readable column/);
  assert.match(problem({ ...board, by: 'id' })!, /Board by must not be a primary key column/);
  assert.match(problem({ ...board, primary: 'count' })!, /Board primary must be a text column, or a reference/);
  // A reference titles each card by the record it names (its label is read with the row).
  const owned: DatabaseSchema = {
    ...schema,
    tables: schema.tables.map((t) => ({
      ...t,
      columns: [
        ...t.columns,
        { name: 'owner_id', type: 'INTEGER', nullable: true, primaryKey: false, references: { table: 'tasks', column: 'id' } },
      ],
    })),
  };
  assert.equal(problem({ ...board, primary: 'owner_id' }, owned), undefined);
  assert.match(
    problem({ ...board, lanes: ['new', 'archived', 'lost'] })!,
    /Board lanes "archived", "lost" are not in the declared vocabulary of "state"/,
  );
  assert.equal(problem({ ...board, by: 'priority', lanes: ['anything'] }), undefined, 'a column without a vocabulary accepts any lane');
  const noKey = structuredClone(schema);
  for (const column of noKey.tables[0].columns) column.primaryKey = false;
  assert.match(problem(queue, noKey)!, /Queue requires a complete readable primary key/);
  assert.match(problem(board, noKey)!, /Board requires a complete readable primary key/);
});

test('a queue or a board titles its cards by a reference, or by a label path through one', () => {
  const owned: DatabaseSchema = {
    ...schema,
    foreignKeys: [
      { name: 'owner', from: { table: 'tasks', columns: ['owner_id'] }, to: { table: 'tasks', columns: ['id'] } },
    ] as DatabaseSchema['foreignKeys'],
    tables: schema.tables.map((t) => ({
      ...t,
      columns: [
        ...t.columns,
        { name: 'owner_id', type: 'INTEGER', nullable: true, primaryKey: false, references: { table: 'tasks', column: 'id' } },
      ],
    })),
  };
  const problem = (presentation: object, catalog = owned) =>
    (resolveViews(parse({ presentation }), catalog).tasks as { error?: string }).error;
  /* The parser keeps a path as written, on a board as on a queue. */
  assert.equal(
    ((parse({ presentation: { ...board, primary: 'owner_id.title' } }).views.tasks as AppListView).presentation as AppBoardList).primary,
    'owner_id.title',
  );
  assert.equal(problem({ ...queue, primary: 'owner_id' }), undefined, 'a reference column titles a queue card');
  assert.equal(problem({ ...queue, primary: 'owner_id.title' }), undefined);
  assert.equal(problem({ ...board, primary: 'owner_id.title' }), undefined, 'a board card may be titled through a reference');
  assert.equal(problem({ ...board, primary: 'owner_id' }), undefined);
  /* Negative: the path must land on text, walk one hop, and start at a reference. */
  assert.match(problem({ ...board, primary: 'owner_id.count' })!, /Board primary must be a text column/);
  assert.match(problem({ ...queue, primary: 'owner_id.count' })!, /Queue primary must be a text column/);
  assert.match(
    problem({ ...board, primary: 'title.title' })!,
    /Board primary: "title.title" is not a readable one-hop reference label path/,
  );
  assert.match(problem({ ...board, primary: 'owner_id.nope' })!, /Board primary: "owner_id.nope" is not a readable one-hop/);
  assert.throws(() => parse({ presentation: { ...board, primary: 'a.b.c' } }), /"primary" must be a local column or a one-hop label path/);
  assert.match(problem({ ...queue, primary: 'count' })!, /Queue primary must be a text column/);
  assert.match(problem({ ...board, primary: 'count' })!, /Board primary must be a text column, or a reference/);
});

test("a join table's list opens the record a reference names: a reference column, from a grid only", () => {
  const linked = structuredClone(schema);
  linked.tables[0].columns.push({
    name: 'parent_id',
    type: 'INTEGER',
    nullable: true,
    primaryKey: false,
    references: { table: 'tasks', column: 'id' },
  });
  assert.equal((parse({ opens: ' parent_id ' }).views.tasks as AppListView).opens, 'parent_id');
  const problem = (view: Record<string, unknown>) => (resolveViews(parse(view), linked).tasks as { error?: string }).error;
  assert.equal(problem({ opens: 'parent_id' }), undefined);
  assert.match(
    problem({ opens: 'title' })!,
    /This view's opens: "title" must be a reference column of "tasks"; a row opens the record it names/,
  );
  assert.match(problem({ opens: 'missing' })!, /This view's opens: "missing" must be a reference column/);
  for (const value of [4, '', 'parent_id.title'])
    assert.throws(() => parse({ opens: value }), /"opens" must name one of the resource's reference columns/);
  assert.throws(
    () => parse({ opens: 'parent_id', presentation: queue }),
    /has "opens" and a queue presentation; a row opens another record from a grid only/,
  );
});

test('a list view keeps a hand order in a numeric column of its own, refused where it could never be read', () => {
  assert.equal((parse({ order: ' count ', presentation: queue }).views.tasks as AppListView).order, 'count');
  const problem = (view: Record<string, unknown>) => (resolveViews(parse(view), schema).tasks as { error?: string }).error;
  assert.equal(problem({ order: 'count' }), undefined);
  assert.match(problem({ order: 'missing' })!, /This view's order: "missing" must be a local readable column of "tasks"/);
  assert.match(problem({ order: 'title' })!, /This view's order: "title" is TEXT; a row's place in the list is a number/);
  assert.match(problem({ order: 'id' })!, /This view's order must not be a primary key column/);
  for (const value of [4, '', ' ', 'owner.rank', 'rank desc']) {
    assert.throws(() => parse({ order: value }), /"order" must name one of the resource's own numeric columns/);
  }
  assert.throws(
    () => parse({ order: 'count', presentation: board }),
    /has "order" and a board presentation; a board keeps its cards' places in its presentation's "order"/,
  );
  assert.throws(
    () => parse({ order: 'count', presentation: { kind: 'calendar', date: 'title', primary: 'title' } }),
    /has "order" and a calendar presentation/,
  );
  // A tab may still sort its own way, and a condition is not a sort.
  const tabbed = parse({
    order: 'count',
    query: 'state != done',
    segments: { by_title: 'state = new' },
    tabs: [{ segment: 'by_title', sort: 'title' }],
  }).views.tasks as AppListView;
  assert.equal(tabbed.order, 'count');
});

test("header is a boolean, carried only as false: the action is still the resource's, just not drawn in its bar", () => {
  const command = { id: 'assign', version: 1, target: 'tasks', input: {} };
  const resource = parse({
    actions: {
      reopen: { label: 'Reopen', set: { state: 'new' }, header: false },
      start: { label: 'Start', set: { state: 'working' }, header: true },
      assign: { label: 'Assign', command, header: false },
    },
  }).resources!.tasks;
  assert.deepEqual(resource.actions, [
    { id: 'reopen', label: 'Reopen', set: { state: 'new' }, header: false },
    { id: 'start', label: 'Start', set: { state: 'working' } },
    { id: 'assign', label: 'Assign', command: { id: 'assign', version: 1, target: 'tasks', input: [] }, header: false },
  ]);
  for (const header of ['false', 0, null]) {
    assert.throws(
      () => parse({ actions: { start: { label: 'Start', set: { state: 'working' }, header } } }),
      /has a "header" that is not true or false/,
    );
  }
});

test('bulk is a boolean; a command action offers it only when its registered command targets many', () => {
  const resource = parse({
    actions: {
      start: { label: 'Start', set: { state: 'working' }, when: 'state = new', bulk: true },
      cancel: { label: 'Cancel', set: { state: 'canceled' }, confirm: true, bulk: false },
      plain: { label: 'Plain', set: { state: 'done' } },
    },
  }).resources!.tasks;
  assert.deepEqual(resource.actions, [
    { id: 'start', label: 'Start', set: { state: 'working' }, when: 'state = new', bulk: true },
    { id: 'cancel', label: 'Cancel', set: { state: 'canceled' }, confirm: true, bulk: false },
    { id: 'plain', label: 'Plain', set: { state: 'done' } },
  ]);
  for (const bulk of ['true', 1, null, {}]) {
    assert.throws(
      () => parse({ actions: { start: { label: 'Start', set: { state: 'working' }, bulk } } }),
      /has a "bulk" that is not true or false/,
    );
  }
  /* The rule changed in 0.3.x: a command that names one record is still never
     offered for a selection, but one whose registered command declares
     `targets: 'many'` is — one atomic request for the whole selection.
     `bulk: false` is the default spelled out, and is allowed anywhere. */
  const command = { id: 'assign', version: 1, target: 'tasks', input: {} };
  assert.throws(
    () => parse({ actions: { assign: { label: 'Assign', command, bulk: true } } }),
    /can offer "assign" in bulk only when the command declares targets: 'many'/,
  );
  assert.throws(
    () => parse({ actions: { assign: { label: 'Assign', command: { ...command, targets: 'one' }, bulk: true } } }),
    /targets: 'many'/,
  );
  assert.throws(
    () => parse({ actions: { assign: { label: 'Assign', command: { ...command, targets: 'many' }, bulk: 'yes' } } }),
    /has a "bulk" that is not true or false/,
  );
  assert.throws(
    () =>
      defineCommand({
        source: 'work',
        target: 'tasks',
        targets: 'all',
        input: {},
        output: { parse: (value: unknown) => value },
        handle: () => ({}),
      } as never),
    /targets must be "one", "many" or "none"/,
  );
  const many = { ...command, targets: 'many' };
  const offered = parse({
    actions: {
      assign: { label: 'Assign', command: many, bulk: true },
      hold: { label: 'Hold', command: { ...command, id: 'assignOne' }, bulk: false },
    },
  }).resources!.tasks;
  assert.deepEqual(offered.actions, [
    { id: 'assign', label: 'Assign', command: { id: 'assign', version: 1, target: 'tasks', targets: 'many', input: [] }, bulk: true },
    { id: 'hold', label: 'Hold', command: { id: 'assignOne', version: 1, target: 'tasks', input: [] }, bulk: false },
  ]);
});

test('a queue can name one referenced record label, which resolves and is removed when that path is unavailable', () => {
  const joined = structuredClone(schema);
  joined.tables[0].columns.push({ name: 'employee_id', type: 'TEXT', nullable: false, primaryKey: false });
  joined.tables.push({
    id: 'employee',
    name: 'employee',
    schema: '',
    isView: false,
    columns: [
      { name: 'id', type: 'TEXT', nullable: false, primaryKey: true },
      { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
    ],
  });
  joined.foreignKeys.push({
    name: 'task_employee',
    from: { table: 'tasks', columns: ['employee_id'] },
    to: { table: 'employee', columns: ['id'] },
  });
  const presentation = { kind: 'queue' as const, primary: 'title', lines: ['state'], facts: ['employee_id.name'] };
  const app = parse({ presentation: { kind: 'queue', primary: 'title', lines: ['state'], properties: ['employee_id.name'] } });
  assert.deepEqual(listPresentationColumns(presentation), ['title', 'state', 'employee_id.name']);
  assert.equal((resolveViews(app, joined).tasks as { error?: string }).error, undefined);
  const restricted = structuredClone(joined);
  restricted.tables.find((table) => table.id === 'employee')!.columns = restricted.tables
    .find((table) => table.id === 'employee')!
    .columns.filter((column) => column.name !== 'name');
  assert.equal(Object.hasOwn(fieldAccessibleApp(app, restricted).views.tasks, 'presentation'), false);
});

test('field projection drops a queue or board whole when a column it reads is hidden, and never grants a write', () => {
  const app = parseTestApp(
    {
      name: 'Work',
      auth: { roles: { reader: { read: true } } },
      resources: {
        tasks: {
          fields: { read: ['id', 'title', 'state'] },
          actions: { start: { label: 'Start', set: { state: 'working' }, bulk: true } },
        },
      },
      views: { tasks: { kind: 'list', from: 'tasks', presentation: queue } },
      home: 'tasks',
      nav: ['tasks'],
    },
    'fixture',
  );
  const hidden = structuredClone(schema);
  hidden.tables[0].columns = hidden.tables[0].columns.filter((column) => column.name !== 'priority');
  const projected = fieldAccessibleApp(app, hidden).views.tasks as AppListView;
  assert.equal(projected.presentation, undefined, 'the queue reads priority, which this reader cannot');
  const visible = fieldAccessibleApp(app, schema).views.tasks as AppListView;
  assert.deepEqual(visible.presentation, queueList);
  const boardApp = parse({ presentation: board });
  const readOnly = structuredClone(schema);
  for (const column of readOnly.tables[0].columns) column.writable = false;
  assert.deepEqual(
    (fieldAccessibleApp(boardApp, readOnly).views.tasks as AppListView).presentation,
    boardList,
    'presentation survives without write permission; the client decides what it offers',
  );
});

test("JSON schema offers the list kinds and names a bulk action's command", () => {
  const json = JSON.parse(readFileSync(new URL('../packages/mistri/schema/app.schema.json', import.meta.url), 'utf8'));
  /* A board and a split are keys of the list view, declared by reference ($defs boardList, splitListDetail), so the
     presentation holds the rest; the board is read here with the kind its key says, to share the column rules below. */
  const board = { ...json.$defs.boardList, properties: { kind: { const: 'board' }, ...json.$defs.boardList.properties } };
  const presentations = json.$defs.presentation.oneOf.map((option: { $ref?: string }) =>
    option.$ref ? json.$defs[option.$ref.split('/').pop()!] : option,
  );
  const kinds = presentations.map((option: { properties: { kind: { const: string } } }) => option.properties.kind.const);
  assert.deepEqual(kinds, ['checklist', 'queue', 'tree', 'gantt', 'calendar', 'cards', 'custom']);
  assert.deepEqual(
    Object.keys(json.$defs.listView.properties).filter((key) => key === 'board' || key === 'split'),
    ['board', 'split'],
  );
  assert.deepEqual(Object.keys(json.$defs.splitListDetail.properties), ['detail', 'limit', 'row']);
  const options = [...presentations, board];
  const calendarSchema = options.find((option: { properties: { kind: { const: string } } }) => option.properties.kind.const === 'calendar');
  // A calendar with no `primary` titles each entry with the record's name (42297f25).
  assert.deepEqual(calendarSchema.required, ['kind', 'date']);
  assert.deepEqual(Object.keys(calendarSchema.properties), ['kind', 'date', 'end', 'primary', 'lines', 'badge', 'backdrop']);
  assert.equal(calendarSchema.properties.lines.maxItems, 1);
  const [checklist, queueSchema] = options;
  const boardSchema = board;
  assert.deepEqual(checklist.required, ['kind', 'primary', 'checked']);
  assert.deepEqual(queueSchema.required, ['kind']);
  assert.deepEqual(Object.keys(queueSchema.properties), ['kind', 'primary', 'lines', 'properties', 'badge', 'openLabel']);
  assert.equal(queueSchema.properties.lines.maxItems, 2);
  assert.equal(queueSchema.properties.properties.maxItems, 6);
  assert.deepEqual(boardSchema.required, ['by']);
  assert.deepEqual(
    Object.keys(boardSchema.properties).sort(),
    ['kind', 'by', 'lanes', 'order', 'swimlanes', 'limits', 'folded', 'sum', 'primary', 'lines', 'category', 'footer'].sort(),
  );
  // A limit is a whole number of cards per lane, keyed by the lane's value.
  assert.deepEqual(boardSchema.properties.limits.additionalProperties, { type: 'integer', minimum: 1, maximum: 999 });
  assert.equal(boardSchema.properties.lines.maxItems, 1);
  assert.equal(boardSchema.properties.lanes.maxItems, 8);
  for (const option of options) {
    assert.equal(option.additionalProperties, false);
    // The split's columns are paths, not local columns; it has no pattern to check.
    if (option.properties.kind.const === 'split') continue;
    for (const key of ['primary', 'checked', 'by', 'lines']) {
      if (!option.properties[key]) continue;
      // Cards, queues, calendars, trees and gantt charts may follow one reference (a card's title too, since 0.8.14).
      if (key === 'lines' && ['cards', 'queue', 'calendar', 'tree'].includes(option.properties.kind.const)) continue;
      if (key === 'primary' && ['cards', 'queue', 'calendar', 'tree', 'gantt', 'board'].includes(option.properties.kind.const)) continue;
      // A gantt chart's rows may be named through one reference (`owner_id.name`); a board's lanes stay its own column.
      if (key === 'by' && option.properties.kind.const === 'gantt') continue;
      const pattern = new RegExp((key === 'lines' ? option.properties[key].items : option.properties[key]).pattern);
      assert.equal(pattern.test('task title'), true);
      for (const value of ['', ' ', 'owner.name', '.name', 'name.']) assert.equal(pattern.test(value), false);
    }
  }
  /* A queue preserves permissive legacy local names while adding exactly one
     reference hop. Other presentations remain local-only. */
  const queuePrimary = queueSchema.properties.primary;
  const queueLine = queueSchema.properties.lines.items;
  const queueFact = queueSchema.properties.properties.items;
  const queuePattern = (value: string, field: { anyOf: Array<{ pattern: string }> }) =>
    field.anyOf.some((part) => new RegExp(part.pattern).test(value));
  // A calendar names its records and says their status the queue's way; its dates stay its own columns.
  const calendarFields = [calendarSchema.properties.primary, calendarSchema.properties.lines.items, calendarSchema.properties.badge];
  assert.equal(new RegExp(calendarSchema.properties.end.pattern).test('last_day.value'), false);
  for (const field of [queuePrimary, queueLine, queueFact, ...calendarFields]) {
    for (const value of ['task title', 'employee_id.name']) assert.equal(queuePattern(value, field), true);
    for (const value of ['', ' ', 'employee_id.manager.name', '.name', 'name.']) assert.equal(queuePattern(value, field), false);
  }
  /* A card says who sells the car (`dealer_id.name`): its properties and facts are
     columns or one hop of a reference, never two, never blank or dangling. */
  const cards = options.find((option: { properties: { kind: { const: string } } }) => option.properties.kind.const === 'cards');
  /* Both are lists of values; the rule sits on each item — and a fact may be
     `{ column, before }` or `{ column, after }`, whose column follows the same rule. */
  const [factPath, factWorded] = cards.properties.facts.items.oneOf;
  const [factBefore, factAfter] = factWorded.oneOf;
  assert.deepEqual(
    [factBefore.required, factAfter.required],
    [
      ['column', 'before'],
      ['column', 'after'],
    ],
  );
  for (const item of [cards.properties.properties.items, factPath, factBefore.properties.column, factAfter.properties.column]) {
    const pattern = new RegExp(item.pattern);
    for (const value of ['model', 'dealer_id.name']) assert.equal(pattern.test(value), true);
    for (const value of ['', ' ', 'a.b.c', '.name', 'name.']) assert.equal(pattern.test(value), false);
  }
  const action = json.$defs.actions.additionalProperties;
  assert.equal(action.properties.bulk.type, 'boolean');
  const commandBranch = action.oneOf[1];
  // A command sets nothing itself; one that asks nothing may confirm, judged at load against its input.
  assert.deepEqual(commandBranch.not.required, ['set']);
  // A command is named; whether it takes a selection is its registration's, judged at load and by mistri-commands.d.ts.
  assert.equal(json.$defs.commandReference, undefined);
});

test('public TypedAppConfig checks queue and board columns and refuses bulk on a one-target command', () => {
  const filename = new URL('./.app-list-presentation-types.ts', import.meta.url).pathname;
  const source = `import { defineApp, action, type TypedAppConfig, queue, listView } from '@mistriwork/mistri/app';
    declare module '@mistriwork/mistri/app' {
      interface Register { commands: { assign: { target: 'tasks'; targets: 'one'; input: never }; assignMany: { target: 'tasks'; targets: 'many'; input: never } } }
    }
    type App = TypedAppConfig<{tasks: 'id'|'title'|'state'|'priority'|'employee_id'; people: 'id'|'name'}>;
    const lineup = queue('title', { lines: ['state', 'priority'], properties: ['employee_id.name']});
    const board = {by: 'state', primary: 'title'} as const;
    const valid = defineApp({name:'Work',
      resources: {tasks: {actions:{start: action('Start', {set:{state:'working'}, when:'state = new', bulk:true})}}},
      views: {
        queue: listView('Tasks', 'tasks', { presentation: lineup}),
        board: listView('Board', 'tasks', { query:'state != done', board }),
      },
      home: 'queue', nav: ['queue', 'board']} satisfies App);
    // @ts-expect-error Queue columns belong to the owning resource.
    const wrongTable: App = {name:'Work', home:'queue', views:{queue:listView('People', 'people', { presentation: lineup})}};
    // @ts-expect-error A board lane column must exist.
    const wrongBy: App = {name:'Work', home:'board', views:{board:listView('Tasks', 'tasks', { board: {...board, by:'lane'}})}};
    // @ts-expect-error A queue property must start with a declared local column.
    const path: App = {name:'Work', home:'queue', views:{queue:listView('Tasks', 'tasks', { presentation:{...lineup, properties:['missing.name']}})}};
    // @ts-expect-error A command that names one record is never bulk.
    const bulkCommand = action('Assign', {command: 'assign', bulk: true});
    const manyCommand = action('Assign', {command: 'assignMany', bulk: true});
  `;
  assert.equal(typecheck(filename, { files: { [filename]: source } }), '');
});

/* A calendar of ranges: a leave from its first day to its last, named
   through a reference, its status a tone — the grammar a queue already
   speaks for its title and badge, judged against the catalog. */
test('a calendar takes a range, a badge and one-hop label paths, and refuses what it cannot draw', () => {
  const people: DatabaseSchema = {
    label: 'People',
    dialect: 'sqlite',
    readAt: '',
    foreignKeys: [{ name: 'leave_person', from: { table: 'leave', columns: ['person_id'] }, to: { table: 'person', columns: ['id'] } }],
    tables: [
      {
        id: 'person',
        name: 'person',
        schema: '',
        isView: false,
        columns: [
          { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
          { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
          { name: 'hired_on', type: 'DATE', nullable: false, primaryKey: false },
        ],
      },
      {
        id: 'leave',
        name: 'leave',
        schema: '',
        isView: false,
        columns: [
          { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
          { name: 'person_id', type: 'INTEGER', nullable: false, primaryKey: false },
          { name: 'status', type: 'TEXT', nullable: false, primaryKey: false },
          { name: 'first_day', type: 'DATE', nullable: false, primaryKey: false },
          { name: 'last_day', type: 'DATE', nullable: false, primaryKey: false },
          { name: 'note', type: 'TEXT', nullable: true, primaryKey: false },
        ],
      },
    ],
  };
  const app = (presentation: Record<string, unknown>) =>
    parseTestApp(
      {
        name: 'People',
        resources: { leave: {}, person: {} },
        views: { out: { kind: 'list', from: 'leave', presentation } },
        home: 'out',
        nav: ['out'],
      },
      'calendar fixture',
    );
  const ranged = {
    kind: 'calendar',
    date: ' first_day ',
    end: ' last_day ',
    primary: ' person_id.name ',
    badge: 'status',
    lines: ['note'],
  };
  const view = app(ranged).views.out as AppListView;
  assert.deepEqual(view.presentation, {
    kind: 'calendar',
    date: 'first_day',
    end: 'last_day',
    primary: 'person_id.name',
    lines: ['note'],
    badge: 'status',
  });
  assert.deepEqual(listPresentationColumns(view.presentation!), ['first_day', 'last_day', 'person_id.name', 'note', 'status']);
  assert.equal((resolveViews(app(ranged), people).out as { error?: string }).error, undefined);
  // A range ends in its own date column; one column cannot be both ends.
  assert.throws(() => app({ ...ranged, end: 'first_day' }), /"end" names "first_day", the same column as "date"/);
  assert.throws(() => app({ ...ranged, end: 'person_id.hired_on' }), /"end" must name a local column, not a path/);
  assert.throws(() => app({ ...ranged, badge: 'person_id.name.first' }), /one-hop label path/);
  const judged = (presentation: Record<string, unknown>) => (resolveViews(app(presentation), people).out as { error?: string }).error;
  assert.match(judged({ ...ranged, end: 'note' }) ?? '', /Calendar end: "note" is TEXT; a record's last day is a date column/);
  assert.match(
    judged({ ...ranged, primary: 'person_id.missing' }) ?? '',
    /Calendar primary: "person_id.missing" is not a readable one-hop reference label path/,
  );
  assert.match(judged({ ...ranged, primary: 'person_id.hired_on' }) ?? '', /Calendar primary must be a text column/);
});
