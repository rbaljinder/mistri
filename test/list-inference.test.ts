/**
 * What a list that declares nothing draws (listInference.ts), and the overview an App that names no home starts on
 * (appOverview.ts): each rule on a small field-service catalog, the shape a coding agent's least effort meets.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  inferBoard,
  inferListColumns,
  inferListFilters,
  inferListSort,
  inferListSubtitles,
  inferListTabs,
  leadColumn,
  mainTable,
  openQuery,
  type InferenceResource,
} from '../packages/engine/src/shared/listInference.js';
import type { ColumnMeta, DatabaseSchema, TableMeta } from '../packages/engine/src/shared/schema.js';
import { overviewSections } from '../packages/mistri/src/shared/appOverview.js';
import { parseAppConfig, resolveViews } from '../packages/mistri/src/shared/app.js';
import type { AppDashboardView, ResolvedListView } from '../packages/mistri/src/shared/appModel.js';
import { machine } from '@mistriwork/mistri/app';

const col = (name: string, type = 'text', extra: Partial<ColumnMeta> = {}): ColumnMeta => ({
  name,
  type,
  nullable: false,
  primaryKey: false,
  ...extra,
});
const key = () => col('id', 'integer', { primaryKey: true });
const ref = (name: string, table: string, extra: Partial<ColumnMeta> = {}) =>
  col(name, 'integer', { references: { table, column: 'id' }, ...extra });
const table = (name: string, columns: ColumnMeta[], extra: Partial<TableMeta> = {}): TableMeta => ({
  name,
  schema: '',
  id: name,
  isView: false,
  columns,
  ...extra,
});

const STATES = ['new', 'scheduled', 'in_progress', 'on_hold', 'completed', 'cancelled'];
const SCHEMA: DatabaseSchema = {
  label: 'field',
  dialect: 'sqlite',
  readAt: '',
  tables: [
    table(
      'customer',
      [
        key(),
        col('name'),
        col('kind', 'text', { allowed: ['residential', 'commercial'] }),
        col('email', 'text', { nullable: true }),
        col('street'),
        col('city'),
        col('state', 'text', { allowed: ['CA'] }),
        col('created_at', 'datetime'),
      ],
      { approxRows: 40 },
    ),
    table(
      'technician',
      [key(), col('name'), col('email'), col('trade', 'text', { allowed: ['plumbing', 'electrical'] }), col('active', 'boolean')],
      { approxRows: 8, unique: ['email'] },
    ),
    table(
      'job',
      [
        key(),
        col('number'),
        col('title'),
        ref('customer_id', 'customer'),
        ref('technician_id', 'technician', { nullable: true }),
        col('status', 'text', { allowed: STATES }),
        col('priority', 'text', { allowed: ['low', 'normal', 'high', 'urgent'] }),
        col('opened_at', 'datetime'),
        col('due_on', 'date', { nullable: true }),
        col('completed_at', 'datetime', { nullable: true }),
        col('total', 'numeric'),
        col('description', 'text', { nullable: true }),
        col('photo', 'blob', { nullable: true }),
      ],
      { approxRows: 120, unique: ['number'] },
    ),
    table(
      'visit',
      [
        key(),
        ref('job_id', 'job'),
        ref('technician_id', 'technician', { nullable: true }),
        col('status', 'text', { allowed: ['scheduled', 'completed', 'missed', 'cancelled'] }),
        col('starts_at', 'datetime'),
        col('summary', 'text', { nullable: true }),
      ],
      { approxRows: 300 },
    ),
    table('note', [key(), ref('job_id', 'job'), col('body'), col('created_at', 'datetime')], { approxRows: 900 }),
    table('code', [key(), col('code'), col('weight', 'integer')]),
  ],
  foreignKeys: [
    { name: 'a', from: { table: 'job', columns: ['customer_id'] }, to: { table: 'customer', columns: ['id'] } },
    { name: 'b', from: { table: 'job', columns: ['technician_id'] }, to: { table: 'technician', columns: ['id'] } },
    { name: 'c', from: { table: 'visit', columns: ['job_id'] }, to: { table: 'job', columns: ['id'] } },
    { name: 'd', from: { table: 'visit', columns: ['technician_id'] }, to: { table: 'technician', columns: ['id'] } },
    { name: 'e', from: { table: 'note', columns: ['job_id'] }, to: { table: 'job', columns: ['id'] } },
  ],
};
const T = (name: string) => SCHEMA.tables.find((t) => t.name === name)!;
const MACHINE: InferenceResource['machine'] = {
  column: 'status',
  states: STATES.map((name) => ({ name, ...(name === 'completed' || name === 'cancelled' ? { final: true } : {}) })),
};
const JOB: InferenceResource = { machine: MACHINE };

describe('a list that names no columns', () => {
  test('leads with the name, then the state, what it belongs to by name, the one date and the money', () => {
    assert.deepEqual(inferListColumns(SCHEMA, T('job'), JOB), [
      'title',
      'status',
      'customer_id',
      'technician_id',
      'due_on',
      'total',
      'priority',
    ]);
  });
  test('the code a row is also quoted by is the name’s second line, not a column', () => {
    assert.deepEqual(inferListSubtitles(SCHEMA, T('job'), JOB), { title: 'number' });
    /* A display rule's own second line is the author's: none is added. */
    assert.deepEqual(inferListSubtitles(SCHEMA, T('job'), { ...JOB, display: { title: { subtitle: 'priority' } } }), {});
  });
  test('leaves out the key, a column the schema pins to one value, long text, bytes and an address past its first part', () => {
    const shown = inferListColumns(SCHEMA, T('customer'));
    assert.deepEqual(shown, ['name', 'created_at', 'kind', 'email', 'street']);
    for (const left of ['id', 'state', 'city']) assert.ok(!shown.includes(left), left);
    assert.ok(!inferListColumns(SCHEMA, T('job'), JOB).includes('description'));
    assert.ok(!inferListColumns(SCHEMA, T('job'), JOB).includes('photo'));
  });
  test('a row whose own name may be blank leads with what it belongs to', () => {
    assert.equal(leadColumn(SCHEMA, T('visit')), 'job_id');
    assert.deepEqual(inferListColumns(SCHEMA, T('visit')), ['job_id', 'status', 'technician_id', 'starts_at']);
  });
  test('a second copy of what the name already says is not a column', () => {
    const shown = inferListColumns(SCHEMA, T('technician'), { display: { name: { subtitle: 'email' } } });
    assert.ok(!shown.includes('email'));
    assert.ok(inferListColumns(SCHEMA, T('technician')).includes('email'));
  });
  test('never more than seven', () => {
    assert.ok(inferListColumns(SCHEMA, T('job'), JOB).length <= 7);
  });
});

describe('the order a list reads in', () => {
  test('work with a date to be done by reads soonest first, the undated after it on every engine', () =>
    assert.equal(inferListSort(SCHEMA, T('job'), JOB), 'due_on nulls last'));
  test('a vocabulary of states with a start reads by the start, the unscheduled last', () =>
    assert.equal(inferListSort(SCHEMA, T('visit')), 'starts_at nulls last'));
  test('anything else newest first by when it came to be', () => {
    assert.equal(inferListSort(SCHEMA, T('customer')), 'created_at desc');
    assert.equal(inferListSort(SCHEMA, T('note')), 'created_at desc');
  });
  test('with no date, by its name; never by its key', () => {
    assert.equal(inferListSort(SCHEMA, T('technician')), 'name');
    assert.equal(inferListSort(SCHEMA, table('bare', [key(), col('weight', 'integer')])), undefined);
  });
});

describe('tabs', () => {
  test('from the machine: Open, each open state while five or fewer, Done and All newest first', () => {
    assert.deepEqual(inferListTabs(SCHEMA, T('job'), JOB), [
      { label: 'Open', query: 'status is open' },
      { label: 'New', query: 'status = new' },
      { label: 'Scheduled', query: 'status = scheduled' },
      { label: 'In progress', query: 'status = in_progress' },
      { label: 'On hold', query: 'status = on_hold' },
      { label: 'Done', query: 'status is not open sort opened_at desc' },
      { label: 'All', query: 'sort opened_at desc' },
    ]);
  });
  test('from a status vocabulary, its final words read off what they say', () => {
    assert.deepEqual(inferListTabs(SCHEMA, T('visit')), [
      { label: 'Open', query: 'status = scheduled' },
      { label: 'Done', query: 'status in (completed, missed, cancelled) sort starts_at desc' },
      { label: 'All', query: 'sort starts_at desc' },
    ]);
    assert.equal(openQuery(T('visit')), 'status = scheduled');
  });
  test('none where nothing says a row is ever over', () => {
    assert.equal(inferListTabs(SCHEMA, T('customer')), undefined);
  });
});

describe('filters', () => {
  test('vocabularies, references to a table of fifty or fewer and the one date; the state only where no tab says it', () => {
    assert.deepEqual(inferListFilters(SCHEMA, T('job'), JOB, true), ['customer_id', 'technician_id', 'priority', 'due_on']);
    assert.deepEqual(inferListFilters(SCHEMA, T('job'), JOB, false), ['status', 'customer_id', 'technician_id', 'priority', 'due_on']);
  });
  test('a reference to a long table, or one the catalog does not count, is searched, not picked', () => {
    assert.deepEqual(inferListFilters(SCHEMA, T('note')), ['created_at']);
    assert.ok(!inferListFilters(SCHEMA, T('visit')).includes('job_id'));
  });
  test('a column pinned to one value is no filter', () => assert.ok(!inferListFilters(SCHEMA, T('customer')).includes('state')));
});

describe('a board to switch to', () => {
  test('a machine of three to seven open states: lanes in its order, the final ones one Done lane, a card of name, owner, date and urgency', () => {
    assert.deepEqual(inferBoard(SCHEMA, T('job'), JOB), {
      kind: 'board',
      by: 'status',
      primary: 'title',
      lines: ['customer_id'],
      footer: [{ column: 'due_on' }, { column: 'priority' }],
      lanes: STATES.filter((name) => name !== 'completed' && name !== 'cancelled'),
      done: ['completed', 'cancelled'],
    });
  });
  test('none for a vocabulary no machine moves, or a machine of two open states or eight', () => {
    assert.equal(inferBoard(SCHEMA, T('visit')), undefined);
    const few = { machine: { column: 'status', states: [{ name: 'new' }, { name: 'scheduled' }, { name: 'completed', final: true }] } };
    assert.equal(inferBoard(SCHEMA, T('job'), few), undefined);
    const many = {
      machine: { column: 'status', states: [...'abcdefgh'].map((name) => ({ name })).concat({ name: 'z', final: true } as never) },
    };
    assert.equal(inferBoard(SCHEMA, T('job'), many), undefined);
  });
});

describe('the main table', () => {
  const entries = (names: string[], machine: string[] = []) => names.map((name) => ({ table: T(name), machine: machine.includes(name) }));
  test('the one a machine moves, before the most pointed at', () => {
    assert.equal(mainTable(SCHEMA, entries(['customer', 'visit', 'job'], ['visit']))?.name, 'visit');
  });
  test('else the one the most of the App’s tables point at, a table that points at others before a lookup; ties in the App’s order', () => {
    /* A technician is pointed at as often as a job, and points at nothing: it is what work is filed under. */
    assert.equal(mainTable(SCHEMA, entries(['customer', 'technician', 'job', 'visit', 'note']))?.name, 'job');
    assert.equal(mainTable(SCHEMA, entries(['code', 'customer']))?.name, 'code');
    assert.equal(mainTable(SCHEMA, []), undefined);
  });
});

/* The App a coding agent writes with least effort: lists that say nothing, and no home. */
const APP = {
  name: 'Field',
  resources: {
    customer: {},
    technician: {},
    job: {
      access: 'write',
      machine: machine('status', {
        new: { on: { schedule: 'scheduled' } },
        scheduled: { on: { start: 'in_progress' } },
        in_progress: { on: { complete: 'completed', hold: 'on_hold' } },
        on_hold: { on: { resume: 'in_progress', cancel: 'cancelled' } },
        completed: { final: true },
        cancelled: { final: true },
      }),
    },
    visit: {},
    note: {},
  },
  views: {
    jobs: { kind: 'list', from: 'job', label: 'Jobs' },
    visits: { kind: 'list', from: 'visit', label: 'Visits' },
    customers: { kind: 'list', from: 'customer', label: 'Customers' },
  },
  nav: ['jobs', 'visits', 'customers'],
};

describe('a list view, resolved', () => {
  test('infers only what it does not declare, and says which', () => {
    const views = resolveViews(parseAppConfig(APP, 'x'), SCHEMA);
    const jobs = views.jobs as ResolvedListView;
    assert.deepEqual(jobs.inferred, ['show', 'sort', 'tabs', 'filters']);
    assert.equal(jobs.sort, 'due_on nulls last');
    assert.deepEqual(jobs.subtitles, { title: 'number' });
    assert.equal(jobs.asBoard?.by, 'status');
    /* A declared part is drawn as written; the rest are still inferred. */
    const sorted = resolveViews(
      parseAppConfig({ ...APP, views: { ...APP.views, jobs: { ...APP.views.jobs, sort: 'number', tabs: [{ label: 'All' }] } } }, 'x'),
      SCHEMA,
    ).jobs as ResolvedListView;
    assert.equal(sorted.sort, 'number');
    assert.deepEqual(sorted.inferred, ['show', 'filters']);
    /* A list that names its columns was arranged: nothing is inferred for it. */
    const arranged = resolveViews(
      parseAppConfig({ ...APP, views: { ...APP.views, jobs: { ...APP.views.jobs, show: ['number', 'title'] } } }, 'x'),
      SCHEMA,
    ).jobs as ResolvedListView;
    assert.deepEqual(arranged.show, ['number', 'title']);
    assert.equal(arranged.sort, undefined);
    assert.equal(arranged.tabs, undefined);
    assert.equal(arranged.subtitles, undefined);
    assert.equal(arranged.asBoard, undefined);
    assert.equal(arranged.inferred, undefined);
  });
  test('a standing query that names the state keeps its own tabs, order and board', () => {
    const open = resolveViews(
      parseAppConfig({ ...APP, views: { ...APP.views, jobs: { ...APP.views.jobs, query: 'status = new' } } }, 'x'),
      SCHEMA,
    ).jobs as ResolvedListView;
    assert.equal(open.tabs, undefined);
    assert.equal(open.asBoard, undefined);
    assert.ok(!open.inferred?.includes('sort'));
  });
});

describe('the overview an App that names no home starts on', () => {
  const ME = { auth: { roles: { staff: { read: true } }, me: { from: 'technician', column: 'email' } } };
  test('its main table by state, overdue or due today, the reader’s own and the newest: four reads at most', () => {
    const app = parseAppConfig({ ...APP, ...ME }, 'x');
    assert.deepEqual(app.home, [{ view: 'overview' }]);
    const overview = resolveViews(app, SCHEMA).overview as AppDashboardView;
    assert.deepEqual(
      overview.sections.map((s) => [s.kind, s.title, s.query, s.sort]),
      [
        ['breakdown', 'Jobs', undefined, undefined],
        ['rows', 'Overdue or due today', 'status is open and due_on <= today', 'due_on'],
        ['rows', 'Mine', 'technician_id.email = me and status is open', 'due_on nulls last'],
        ['rows', 'Recent', undefined, 'opened_at desc'],
      ],
    );
    assert.equal(overview.sections[0].shape, 'steps');
    assert.ok(overview.sections.every((s) => s.view === 'jobs'));
    /* Rows and no total, so each list is one statement; the reader's own are said empty rather than left out. */
    assert.deepEqual(
      overview.sections.filter((s) => s.kind === 'rows').map((s) => [s.counted, s.emptyMode, s.empty?.title]),
      [
        [false, 'hide', undefined],
        [false, undefined, 'Nothing of yours is open'],
        [false, undefined, 'No jobs yet'],
      ],
    );
  });
  test('says only what the table can answer', () => {
    const sections = overviewSections(
      { views: { customers: { table: 'customer', label: 'Customers' } } as never, auth: undefined },
      SCHEMA,
      () => ({}),
    );
    assert.deepEqual(
      sections.map((s) => s.title),
      ['Recent'],
    );
  });
  test('a reader who cannot read the main table is shown the next one they can', () => {
    const app = parseAppConfig(APP, 'x');
    const narrowed = { ...SCHEMA, tables: SCHEMA.tables.filter((t) => t.name !== 'job') };
    const overview = resolveViews(app, narrowed).overview as AppDashboardView;
    assert.equal(overview.sections[0].table, 'visit');
  });
});
