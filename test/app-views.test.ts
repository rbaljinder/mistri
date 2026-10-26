/**
 * The content model: keyed views, a nav that only arranges references, a
 * rule-based home, and the AppDef the parse front leaves behind.
 *
 * Each test states one rule of the parse front: a reference resolves or is
 * refused naming what the App declares; a view nothing can open is refused;
 * the resource owns its New form, its actions and its captions, the views
 * that show it narrow its actions by label, and the payload serves them once,
 * on the resource; the keys the types declare ahead of their feature are
 * refused as not supported yet.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  appAllowsWrite,
  orderAppPages,
  parseAppPages,
  resolveAppAccess,
  resolveResources,
  resolveViews,
  withRollups,
  type AppDashboardView,
  type AppListView,
  type ResolvedListView,
} from '../packages/mistri/src/shared/app.js';
import {
  embeddedOnlyViews,
  servedApp,
  withAvailableEmptyActions,
  withAvailablePageEmptyActions,
  withoutBrokenViews,
} from '../packages/mistri/src/shared/appPayload.js';
import { homeViews } from '../packages/mistri/src/shared/appHome.js';
import { measureText, windowed } from '../packages/engine/src/shared/dashboardAsks.js';
import { sparkText } from '../packages/engine/src/shared/dashboardTrend.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { parseTestApp } from './support/commandCatalog.js';
import { keyedPresentation } from './support/keyedPresentation.js';

const WHERE = 'test/app.json';
const col = (name: string, type = 'text', extra: Record<string, unknown> = {}) => ({
  name,
  type,
  nullable: true,
  primaryKey: false,
  ...extra,
});
const SCHEMA: DatabaseSchema = {
  label: 'demo',
  dialect: 'sqlite',
  readAt: '',
  tables: [
    {
      name: 'task',
      schema: '',
      id: 'task',
      isView: false,
      columns: [
        { ...col('id', 'integer'), primaryKey: true },
        col('name'),
        col('done', 'boolean'),
        col('status', 'text', { allowed: ['open', 'doing', 'done'] }),
        col('due', 'date'),
        col('version', 'integer'),
        col('customer_id', 'integer'),
      ],
    },
    { name: 'customer', schema: '', id: 'customer', isView: false, columns: [{ ...col('id', 'integer'), primaryKey: true }, col('name')] },
  ],
  foreignKeys: [
    { name: 'fk_task_customer', from: { table: 'task', columns: ['customer_id'] }, to: { table: 'customer', columns: ['id'] } },
  ],
};
/* The conditions the tabs below name: a tab holds a segment's word, and the resource holds its conditions. */
const SEGMENTS = {
  open: 'status = open',
  upcoming: 'status = open',
  active: 'status = open or status = doing',
};
/* Every test App declares `task`, the table its views show; a test's own blocks sit beside it. */
const parse = (app: Record<string, unknown>) =>
  parseTestApp(
    { name: 'x', ...app, resources: { task: { segments: SEGMENTS }, ...(app.resources as Record<string, unknown> | undefined) } },
    WHERE,
  );
/** For the tests about resources, auth and pages rather than content: every App needs a view and a
    home, so these Apps get one list of task and name it as the home. */
const bare = (app: Record<string, unknown>) => parse({ views: { tasks: { kind: 'list', from: 'task' } }, home: 'tasks', ...app });
const LIST = { kind: 'list', from: 'task' } as const;
const NOTE = { kind: 'note', text: 'hello' } as const;
const DASH = { kind: 'dashboard', label: 'Board', sections: [NOTE] } as const;
const ACTIONS = {
  start: { label: 'Start', set: { status: 'doing' }, when: 'status = open', bulk: true },
  finish: { label: 'Finish', set: { status: 'done' }, when: 'status = doing' },
};
/* A normalized section carries the table and view it was parsed to; authored again, they are `from` and `to`. */
const authored = (section: unknown) => {
  const { table, view, ...rest } = JSON.parse(JSON.stringify(section)) as Record<string, unknown>;
  return { ...rest, ...(table === undefined ? {} : { from: table }), ...(view === undefined ? {} : { to: view }) };
};
/* As the App serves them: in the order written, each with its id. */
const SERVED = Object.entries(ACTIONS).map(([id, action]) => ({ id, ...action }));
const WELCOME = { kind: 'landing', hero: { heading: 'Hello', actions: [{ label: 'Sign in', signIn: true }] } } as const;

describe('dashboard descriptions', () => {
  test('trims plain copy, carries it through resolution, and refuses any other shape', () => {
    const app = parse({
      views: { board: { kind: 'dashboard', label: 'Board', description: '  Today at a glance.  ', sections: [NOTE] } },
      home: 'board',
      nav: ['board'],
    });
    assert.equal((app.views.board as AppDashboardView).description, 'Today at a glance.');
    assert.equal((resolveViews(app, withRollups(app, SCHEMA)).board as AppDashboardView).description, 'Today at a glance.');
    for (const description of ['', '  ', 7, { text: 'Today' }]) {
      assert.throws(
        () =>
          parse({ views: { board: { kind: 'dashboard', label: 'Board', description, sections: [NOTE] } }, home: 'board', nav: ['board'] }),
        /description.*non-empty string/,
      );
    }
  });
});

describe('record labels', () => {
  test('a non-empty authored path resolves, while an absent declaration preserves legacy metadata', () => {
    const named = bare({ resources: { task: { noun: 'Task', recordLabel: 'customer_id.name' } } });
    assert.equal(resolveResources(named, SCHEMA).resources.task.recordLabel, 'customer_id.name');
    const legacy = resolveResources(bare({ resources: { task: { noun: 'Task' } } }), SCHEMA).resources.task;
    assert.equal(Object.hasOwn(legacy, 'recordLabel'), false);
  });

  test('the parser accepts only a non-empty string path', () => {
    for (const value of ['', '   ', false, ['customer_id.name'], { path: 'customer_id.name' }]) {
      assert.throws(() => bare({ resources: { task: { recordLabel: value } } }), /recordLabel.*non-empty label path/);
    }
  });

  test('a malformed path is a full-catalog problem and is never served as a name', () => {
    const app = bare({ resources: { task: { noun: 'Task', recordLabel: 'customer_id.missing' } } });
    const resolved = resolveResources(app, SCHEMA);
    assert.match(resolved.problems.join('\n'), /resources "task": recordLabel "customer_id\.missing"/);
    assert.equal(Object.hasOwn(resolved.resources.task, 'recordLabel'), false);
  });
});

describe('nav holds references to views', () => {
  test('a view id, or { to, label } for the menu word; the view keeps its own label under its key', () => {
    const app = parse({
      views: { tasks: { ...LIST, label: 'Tasks' }, board: DASH },
      home: 'board',
      nav: [{ to: 'tasks', label: 'My tasks' }, 'board'],
    });
    assert.deepEqual(app.nav, [{ view: 'tasks', label: 'My tasks' }, { view: 'board' }]);
    assert.deepEqual([(app.views.tasks as AppListView).table, app.views.tasks.label], ['task', 'Tasks']);
    const board = app.views.board as AppDashboardView;
    assert.deepEqual(
      [board.label, 'sections' in board, 'id' in board],
      ['Board', true, false],
      'a dashboard is keyed by its view key alone',
    );
    /* Served, every reference carries the menu's word: its own, else its view's label. */
    assert.deepEqual(servedApp(app, SCHEMA).nav, [
      { view: 'tasks', label: 'My tasks' },
      { view: 'board', label: 'Board' },
    ]);
  });

  test('a reference that names nothing, repeats, names a public view or gives no label is refused', () => {
    const views = { tasks: LIST };
    assert.throws(
      () => parse({ views, home: 'nope', nav: ['nope'] }),
      /nav entry 1 names the view "nope", which this App does not declare\. It declares: tasks\./,
    );
    assert.throws(
      () => parse({ views, nav: ['tasks', 'tasks'] }),
      /names the view "tasks" a second time; a view appears in nav at most once/,
    );
    assert.throws(() => parse({ views, nav: [{ to: 'tasks' }] }), /\{ label, to \} needs a non-blank label/);
    assert.throws(
      () =>
        parse({ auth: {}, views: { ...views, welcome: WELCOME }, home: [{ view: 'welcome', signedOut: true }], nav: ['tasks', 'welcome'] }),
      /names the landing view "welcome"\. Public views are not in nav/,
    );
  });

  test('a nav entry that is not a reference is refused by shape', () => {
    assert.throws(
      () => parse({ nav: [{ table: 'task', label: 'Tasks' }] }),
      /nav entry 1 is not a view id, a \{ label, to \} or a navGroup\./,
    );
    assert.throws(
      () => parse({ nav: [{ label: 'Board', sections: [NOTE] }] }),
      /nav entry 1 is not a view id, a \{ label, to \} or a navGroup\./,
    );
    assert.throws(() => parse({ nav: [{ label: 'Board' }] }), /nav entry 1 is not a view id, a \{ label, to \} or a navGroup\./);
  });

  test('groups nest references, and nav keeps the tree as written', () => {
    const app = parse({
      views: { tasks: LIST },
      home: 'tasks',
      nav: [{ id: 'plan', label: 'Plan', children: [{ id: 'daily', label: 'Daily', children: ['tasks'] }] }],
    });
    assert.deepEqual(app.nav, [
      { group: 'plan', label: 'Plan', children: [{ group: 'daily', label: 'Daily', children: [{ view: 'tasks' }] }] },
    ]);
    assert.deepEqual(servedApp(app, SCHEMA).nav, [
      { group: 'plan', label: 'Plan', children: [{ group: 'daily', label: 'Daily', children: [{ view: 'tasks', label: 'Task' }] }] },
    ]);
    assert.throws(
      () =>
        parse({
          views: { tasks: LIST },
          nav: [
            { id: 'plan', label: 'Plan', children: ['tasks'] },
            { id: 'plan', label: 'Again', children: [DASH] },
          ],
        }),
      /repeats navigation group id "plan"/,
    );
  });

  test('a dashboard nothing references is refused by name; an unlinked list is served outside the menu', () => {
    assert.throws(
      () => parse({ views: { tasks: LIST, extra: DASH }, home: 'tasks', nav: ['tasks'] }),
      /views "extra" is referenced by nothing — not nav, not home, not a reachable dashboard's embed, metric or note action, or a landing's \{ kind: 'view' \} section/,
    );
    /* A list is a room at its own address whether or not the menu names it: ⌘K offers it, the menu does not. */
    const unlinked = parse({ views: { tasks: LIST, extra: LIST }, home: 'tasks', nav: ['tasks'] });
    assert.deepEqual(Object.keys(unlinked.views), ['tasks', 'extra']);
    assert.deepEqual(unlinked.nav, [{ view: 'tasks' }]);
    assert.ok(servedApp(unlinked, SCHEMA).views.extra, 'the unlinked list is served');
    assert.doesNotThrow(() =>
      parse({ views: { tasks: LIST, d: { ...DASH, sections: [{ kind: 'view', view: 'tasks' }] } }, home: 'd', nav: ['d'] }),
    );
    assert.doesNotThrow(() => parse({ views: { d: DASH }, home: 'd', nav: ['d'] }));
  });

  test('view keys are addresses; a view names its kind', () => {
    assert.throws(() => parse({ views: { Tasks: LIST }, nav: ['Tasks'] }), /views "Tasks": a view key is its address/);
    assert.throws(
      () => parse({ views: { tasks: { from: 'task' } }, home: 'tasks', nav: ['tasks'] }),
      /has no "kind"; a list view says kind: 'list'/,
    );
    assert.throws(
      () => parse({ views: { tasks: { kind: 'grid', table: 'task' } }, home: 'tasks', nav: ['tasks'] }),
      /has a "kind" of "grid"\. A view is one of: list, dashboard, form or landing/,
    );
  });
});

describe('an empty list may offer another App room', () => {
  test('related empty destinations are validated and pruned without changing shared page copy', () => {
    const empty = {
      title: 'No tasks yet',
      description: 'Tasks for this customer appear here.',
      action: { label: 'Browse tasks', to: 'tasks' },
    };
    const parsedEmpty = { ...empty, action: { label: empty.action.label, view: empty.action.to } };
    const raw = {
      views: { tasks: LIST },
      home: 'tasks',
      nav: ['tasks'],
      resources: { customer: {} },
      pages: { customer: { base: 'customer', sections: [{ kind: 'list', from: 'task', whose: 'customer_id', empty }] } },
    };
    const app = parse(raw);
    const pages = parseAppPages(raw, WHERE);
    const served = servedApp(app, SCHEMA);
    assert.deepEqual(withAvailablePageEmptyActions(pages, served), pages);
    const unavailable: Array<typeof served.views> = [{}, { tasks: { ...served.views.tasks, error: 'Not available' } }];
    for (const views of unavailable) {
      const [projected] = withAvailablePageEmptyActions(pages, { views });
      const section = projected.sections[0];
      assert.equal(section.kind, 'list');
      if (section.kind === 'list') assert.deepEqual(section.empty, { title: empty.title, description: empty.description });
    }
    assert.deepEqual(pages[0].sections[0].kind === 'list' && pages[0].sections[0].empty, parsedEmpty);
    for (const view of ['missing', 'constructor']) {
      assert.throws(
        () =>
          parse({
            ...raw,
            pages: {
              customer: {
                ...raw.pages.customer,
                sections: [{ ...raw.pages.customer.sections[0], empty: { ...empty, action: { ...empty.action, to: view } } }],
              },
            },
          }),
        /not a list, a dashboard or a signed-in form view/,
      );
    }
  });

  test('keeps its copy, permits a list or dashboard destination, and leaves reachability independent', () => {
    const empty = {
      title: 'No saved tasks',
      description: 'Browse the work queue to save one.',
      action: { label: 'Browse tasks', to: 'tasks' },
    };
    const parsedEmpty = { ...empty, action: { label: empty.action.label, view: empty.action.to } };
    const app = parse({
      views: {
        shortlist: { ...LIST, label: 'My shortlist', empty },
        tasks: { ...LIST, label: 'Tasks' },
        board: DASH,
      },
      home: 'shortlist',
      nav: ['shortlist', 'tasks', 'board'],
    });
    assert.deepEqual((app.views.shortlist as AppListView).empty, parsedEmpty);
    assert.doesNotThrow(() =>
      parse({
        views: { shortlist: { ...LIST, empty: { ...empty, action: { label: 'Open board', to: 'board' } } }, board: DASH },
        home: 'shortlist',
        nav: ['shortlist', 'board'],
      }),
    );
    const board = { ...DASH, sections: [NOTE] };
    assert.throws(
      () =>
        parse({
          views: { shortlist: { ...LIST, empty: { ...empty, action: { label: 'Open board', to: 'board' } } }, board },
          home: 'shortlist',
          nav: ['shortlist'],
        }),
      /views "board" is referenced by nothing/,
      'an empty action never makes its target reachable',
    );
  });

  test('refuses malformed copy and destinations that are not list, dashboard or signed-in form rooms', () => {
    const view = (empty: unknown, publicForm = false) =>
      parse({
        resources: { task: {} },
        auth: { roles: { reader: { read: true, commands: ['ask'] } } },
        views: {
          shortlist: { ...LIST, empty },
          tasks: LIST,
          form: {
            kind: 'form',
            label: 'Ask',
            ...(publicForm ? { public: true } : {}),
            command: { id: 'ask', version: 1, input: { note: { label: 'Note', type: 'text' } } },
          },
        },
        home: 'shortlist',
        nav: publicForm ? ['shortlist', 'tasks'] : ['shortlist', 'tasks', 'form'],
      });
    assert.throws(() => view({}), /"empty" needs a non-empty "title"/);
    assert.throws(() => view({ title: 'None', action: {} }), /"action" needs a non-empty "label"/);
    // A signed-in form is a room: an empty list's action opens the form that makes its first row.
    assert.equal(
      (view({ title: 'None', action: { label: 'Ask', to: 'form' } }).views.shortlist as { empty?: { action?: { view: string } } }).empty
        ?.action?.view,
      'form',
    );
    assert.throws(
      () => view({ title: 'None', action: { label: 'Missing', to: 'missing' } }),
      /which is not a list, a dashboard or a signed-in form view/,
    );
    // A public form is served outside the App, at its own address: not a room an empty list opens.
    assert.throws(
      () => view({ title: 'None', action: { label: 'Ask', to: 'form' } }, true),
      /which is not a list, a dashboard or a signed-in form view/,
    );
    assert.throws(
      () =>
        parse({
          views: { shortlist: { ...LIST, empty: { title: 'None' }, presentation: { kind: 'calendar', date: 'due', primary: 'name' } } },
          home: 'shortlist',
          nav: ['shortlist'],
        }),
      /has "empty" and a calendar presentation/,
    );
  });

  test('drops only an unavailable destination action after final view pruning', () => {
    const app = parse({
      views: {
        shortlist: { ...LIST, empty: { title: 'No saved tasks', action: { label: 'Browse tasks', to: 'tasks' } } },
        tasks: LIST,
      },
      home: 'shortlist',
      nav: ['shortlist', 'tasks'],
    });
    const served = servedApp(app, SCHEMA);
    assert.deepEqual((withAvailableEmptyActions(served).views.shortlist as AppListView).empty?.action, {
      label: 'Browse tasks',
      view: 'tasks',
    });
    const pruned = withAvailableEmptyActions({ ...served, views: { shortlist: served.views.shortlist } });
    assert.deepEqual((pruned.views.shortlist as AppListView).empty, { title: 'No saved tasks' });
    const broken = withAvailableEmptyActions({
      ...served,
      views: { ...served.views, shortlist: served.views.shortlist, tasks: { ...served.views.tasks, error: 'Unavailable resource.' } },
    });
    assert.equal((broken.views.shortlist as AppListView).empty?.action, undefined);
    assert.equal((served.views.shortlist as AppListView).empty?.action?.view, 'tasks', 'the shared definition remains unchanged');
  });
});

describe('a dashboard note may offer another App room', () => {
  test('keeps its curated action and reaches its target transitively without adding it to nav', () => {
    const note = { kind: 'note', text: 'Enrollment is open.', icon: 'shield-check', action: { label: ' View benefits ', to: ' middle ' } };
    const next = { kind: 'note', text: 'Compare plans.', action: { label: 'See details', to: 'tasks' } };
    const app = parse({
      views: {
        board: { kind: 'dashboard', label: 'Board', sections: [NOTE], aside: [note] },
        middle: { kind: 'dashboard', label: 'Benefits', sections: [next] },
        tasks: LIST,
      },
      home: 'board',
      nav: ['board'],
    });
    assert.deepEqual((app.views.board as AppDashboardView).aside?.[0], {
      kind: 'note',
      text: 'Enrollment is open.',
      icon: 'shield-check',
      action: { label: 'View benefits', view: 'middle' },
      title: undefined,
      table: undefined,
      query: undefined,
      measure: undefined,
      compare: undefined,
      better: undefined,
      spark: undefined,
      by: undefined,
      shape: undefined,
      over: undefined,
      show: undefined,
      sort: undefined,
      limit: undefined,
      width: undefined,
    });
    assert.deepEqual(Object.keys(app.views), ['board', 'middle', 'tasks']);
    assert.deepEqual(app.nav, [{ view: 'board' }], 'action targets stay out of the sidebar');
  });

  test('does not let an orphan cycle of note actions manufacture rooms', () => {
    const note = (view: string) => ({ kind: 'note', text: 'Read this.', action: { label: 'Continue', to: view } });
    assert.throws(
      () =>
        parse({
          views: {
            board: { kind: 'dashboard', label: 'Board', sections: [NOTE] },
            left: { kind: 'dashboard', label: 'Left', sections: [note('right')] },
            right: { kind: 'dashboard', label: 'Right', sections: [note('left')] },
          },
          home: 'board',
          nav: ['board'],
        }),
      /views "left" is referenced by nothing — not nav, not home, not a reachable dashboard's embed, metric or note action/,
    );
  });

  test('refuses malformed guidance actions and destinations outside App rooms', () => {
    const view = (section: Record<string, unknown>) =>
      parse({
        resources: { task: {} },
        auth: { roles: { reader: { read: true, commands: ['ask'] } } },
        views: {
          board: { kind: 'dashboard', label: 'Board', sections: [section] },
          tasks: LIST,
          form: { kind: 'form', label: 'Ask', command: { id: 'ask', version: 1, input: { note: { label: 'Note', type: 'text' } } } },
        },
        home: 'board',
        nav: ['board', 'tasks', 'form'],
      });
    assert.throws(() => view({ kind: 'note', text: 'Read this', icon: 'rocket-ship' }), /is not one of the App icons/);
    assert.throws(
      () => view({ kind: 'note', text: 'Read this', action: { label: ' ', to: 'tasks' } }),
      /views "board", section 1, "action"\.label needs non-empty text\./,
    );
    assert.throws(
      () => view({ kind: 'note', text: 'Read this', action: { label: 'Ask', to: 'form' } }),
      /which is not a list or dashboard view/,
    );
  });

  test('drops only a note action whose target is unavailable after final view pruning', () => {
    const app = parse({
      views: {
        board: {
          kind: 'dashboard',
          label: 'Board',
          sections: [NOTE],
          aside: [{ kind: 'note', text: 'Read this', action: { label: 'Browse tasks', to: 'tasks' } }],
        },
        tasks: LIST,
      },
      home: 'board',
      nav: ['board'],
    });
    const served = servedApp(app, SCHEMA);
    const kept = withAvailableEmptyActions(served).views.board as AppDashboardView;
    assert.deepEqual(kept.aside?.[0].action, { label: 'Browse tasks', view: 'tasks' });
    const pruned = withAvailableEmptyActions({ ...served, views: { board: served.views.board } }).views.board as AppDashboardView;
    assert.equal(pruned.aside?.[0].action, undefined);
    assert.deepEqual(
      (served.views.board as AppDashboardView).aside?.[0].action,
      { label: 'Browse tasks', view: 'tasks' },
      'the shared definition remains unchanged',
    );
  });
});

describe('a list view keeps its own words', () => {
  test('show, tabs, filters, query, open and sizing carry over; the card is primary and lines', () => {
    const app = parse({
      views: {
        q: {
          ...LIST,
          label: 'Queue',
          query: 'done = false',
          show: ['name', 'due'],
          tabs: ['open'],
          filters: ['status'],
          open: 'drawer',
          presentation: { kind: 'queue', primary: 'name', badge: 'status', lines: ['due'] },
        },
      },
      home: 'q',
      nav: ['q'],
    });
    const view = app.views.q as AppListView;
    assert.deepEqual(view.presentation, { kind: 'queue', primary: 'name', badge: 'status', lines: ['due'] });
    assert.deepEqual([view.query, view.open, view.filters], ['done = false', 'drawer', ['status']]);
    assert.deepEqual(view.show, ['name', 'due']);
    assert.deepEqual(view.tabs, [{ label: 'Open', query: 'open', segment: 'open', slug: 'open' }]);
    assert.equal(resolveViews(app, withRollups(app, SCHEMA)).q.error, undefined);
  });

  test("a tab says its own order as `sort`, kept after its conditions, and it wins over the view's sort", () => {
    const app = parse({
      views: {
        q: {
          ...LIST,
          sort: 'due desc',
          tabs: [{ segment: 'upcoming', sort: 'due' }, { label: 'Soonest', sort: 'due asc, name' }, { label: 'All' }],
        },
      },
      home: 'q',
      nav: ['q'],
    });
    assert.deepEqual((app.views.q as AppListView).tabs, [
      { label: 'Upcoming', query: 'upcoming sort due', segment: 'upcoming', slug: 'upcoming' },
      { label: 'Soonest', query: 'sort due asc, name' },
      { label: 'All', query: undefined },
    ]);
    assert.equal(resolveViews(app, withRollups(app, SCHEMA)).q.error, undefined);
    // A segment's query holds conditions only: its order is its tab's `sort`.
    assert.throws(
      () =>
        parse({
          resources: { task: { segments: { t: 'status = open sort due' } } },
          views: { q: { ...LIST, tabs: ['t'] } },
          home: 'q',
          nav: ['q'],
        }),
      /"segments" "t" has a "query" with a clause \("sort due"\)/,
    );
    // A sort names columns, which the view's resolution judges against the catalog like any tab's query.
    const wrong = parse({ views: { q: { ...LIST, tabs: [{ label: 'T', sort: 'nowhere' }] } }, home: 'q', nav: ['q'] });
    assert.ok(resolveViews(wrong, withRollups(wrong, SCHEMA)).q.error);
  });

  test('each card takes its own number of lines; queues may name one reference label, and names its kind', () => {
    const view = (presentation: Record<string, unknown>) =>
      parse({ views: { v: keyedPresentation({ ...LIST, presentation }) }, home: 'v', nav: ['v'] }).views.v as AppListView;
    assert.deepEqual(view({ kind: 'checklist', primary: 'name', checked: 'done', lines: ['due'] }).presentation, {
      kind: 'checklist',
      primary: 'name',
      checked: 'done',
      lines: ['due'],
    });
    assert.deepEqual(view({ kind: 'board', by: 'status', lanes: ['open', 'doing'], primary: 'name' }).presentation, {
      kind: 'board',
      by: 'status',
      lanes: ['open', 'doing'],
      primary: 'name',
    });
    assert.throws(
      () => view({ kind: 'checklist', primary: 'name', checked: 'done', lines: ['due', 'status'] }),
      /"lines" must be a list of at most 1 local column beneath the primary/,
    );
    const joined = view({ kind: 'queue', primary: 'customer_id.name', lines: ['status'] });
    assert.deepEqual(joined.presentation, { kind: 'queue', primary: 'customer_id.name', lines: ['status'] });
    const unreadable = parse({
      views: { v: { ...LIST, presentation: { kind: 'queue', primary: 'wrong_id.name' } } },
      home: 'v',
      nav: ['v'],
    });
    assert.match(
      resolveViews(unreadable, withRollups(unreadable, SCHEMA)).v.error!,
      /Queue primary: "wrong_id.name" is not a readable one-hop reference label path/,
    );
    assert.throws(
      () => view({ primary: 'name' }),
      /needs a "kind" of "checklist", "queue", "board", "calendar", "tree", "gantt", "cards", "split" or "custom"/,
    );
    assert.throws(
      () => view({ kind: 'queue', title: 'name' }),
      /presentation \(a queue\) has no "title"\. It takes: kind, primary, lines, properties, badge, openLabel\./,
    );
  });

  test('open beside a split is refused, as the split opens its own rows; list is presentation', () => {
    assert.throws(
      () => parse({ views: { v: { ...LIST, open: 'modal', split: { detail: ['name'] } } }, home: 'v', nav: ['v'] }),
      /has "open" and a split presentation, which opens its rows in its own detail pane\. Remove "open"\./,
    );
    assert.throws(
      () => parse({ views: { v: { ...LIST, list: { kind: 'queue', title: 'name' } } }, home: 'v', nav: ['v'] }),
      /has no "list"\. It takes: kind, from, label, path, icon, query, segment, show, presentation/,
    );
    // Beside a list's "from", "form" reads first as a slip of it; a slip is named before a home.
    assert.throws(
      () => parse({ views: { v: { ...LIST, form: { show: ['name'] } } }, home: 'v', nav: ['v'] }),
      /has no "form"\. Did you mean "from"\? It takes: /,
    );
  });
});

describe('captions live on the resource', () => {
  test('resources.<t>.labels caption the table wherever it shows: the resource serves them, a dashboard list carries its own', () => {
    const app = parse({
      resources: { task: { labels: { name: 'Task', 'customer_id.name': 'Customer' } } },
      views: {
        tasks: { ...LIST, show: ['name', 'customer_id.name', 'due'] },
        split: { ...LIST, show: ['name'], split: { detail: ['name', 'due'] } },
        d: { ...DASH, sections: [{ kind: 'rows', from: 'task', show: ['name', 'due'] }] },
      },
      home: 'd',
      nav: ['tasks', 'split', 'd'],
    });
    const [tasks, split, d] = [app.views.tasks as AppListView, app.views.split as AppListView, app.views.d as AppDashboardView];
    assert.deepEqual(tasks.show, ['name', 'customer_id.name', 'due']);
    assert.deepEqual(split.presentation, { kind: 'split', detail: ['name', 'due'] });
    assert.deepEqual(d.sections[0].labels, { name: 'Task' });
    assert.deepEqual(servedApp(app, SCHEMA).resources.task.labels, { name: 'Task', 'customer_id.name': 'Customer' });
    /* A caption for a path this catalog cannot walk is not served: it could only name what a principal cannot read. */
    const hidden = parse({ resources: { task: { labels: { name: 'Task', 'nope.name': 'Nope' } } }, views: { tasks: LIST }, home: 'tasks' });
    assert.deepEqual(resolveResources(hidden, SCHEMA).resources.task.labels, { name: 'Task' });
  });

  test("a view's show entry is a string; an object is refused by shape", () => {
    assert.throws(
      () => parse({ views: { v: { ...LIST, show: [{ column: 'name', label: 'Name' }] } }, home: 'v', nav: ['v'] }),
      /"show" entry 1 is not a column name or a label path\./,
    );
    assert.throws(
      () =>
        parse({ views: { d: { ...DASH, sections: [{ kind: 'rows', from: 'task', show: [{ column: 'name' }] }] } }, home: 'd', nav: ['d'] }),
      /"show" entry 1 is not a column name or a label path\./,
    );
  });
});

/* What the conventions dress on the fixture's task without being told (displayDefaults.ts). */
const INFERRED = { due: { format: 'relative' }, status: { tone: { open: 'info', doing: 'neutral', done: 'good' } } };

describe('the resource owns its New form and its actions', () => {
  const REF = { id: 'advance', version: 1, target: 'task', input: {} };

  test('the resource keeps its form and actions, and the payload serves them once, on the resource', () => {
    const app = parse({
      resources: { task: { access: 'write', form: { show: ['name'] }, actions: ACTIONS } },
      views: { all: LIST, q: { ...LIST, query: 'status = open', presentation: { kind: 'queue', primary: 'name' } } },
      home: 'all',
      nav: ['all', 'q'],
    });
    assert.deepEqual([app.resources?.task.form, app.resources?.task.actions], [{ show: ['name'] }, SERVED]);
    assert.deepEqual(
      [(app.views.all as AppListView).actions, (app.views.q as AppListView).actions],
      [undefined, undefined],
      'neither view narrows',
    );
    const served = servedApp(app, SCHEMA);
    assert.deepEqual(served.resources.task, { actions: SERVED, form: { show: ['name'] }, display: INFERRED });
    assert.equal(
      Object.values(served.views).some((view) => 'form' in view || 'actions' in view),
      false,
      'no view carries them',
    );
  });

  test("a queue or a board narrows by id, in its order; bulk stays the action's", () => {
    const app = parse({
      resources: { task: { access: 'write', actions: ACTIONS } },
      views: { all: LIST, q: { ...LIST, query: 'status = open', presentation: { kind: 'queue', primary: 'name' }, actions: ['start'] } },
      home: 'all',
      nav: ['all', 'q'],
    });
    assert.deepEqual((app.views.q as AppListView).actions, ['start'], 'the view keeps only its selector');
    assert.deepEqual(
      (resolveViews(app, withRollups(app, SCHEMA)).q as ResolvedListView).actions,
      ['start'],
      "and serves it, for the client to narrow the resource's actions by",
    );
  });

  test('each view serves only its selector, an empty one included; the resource serves the actions a principal may run', () => {
    const app = parse({
      resources: { task: { access: 'write', form: { show: ['name'] }, actions: ACTIONS } },
      views: {
        all: LIST,
        q: { ...LIST, query: 'status = open', presentation: { kind: 'queue', primary: 'name' }, actions: ['finish', 'start'] },
        b: { ...LIST, query: 'done = false', board: { by: 'status', primary: 'name' }, actions: [] },
        c: { ...LIST, query: 'done = true', presentation: { kind: 'checklist', primary: 'name', checked: 'done' } },
      },
      home: 'all',
      nav: ['all', 'q', 'b', 'c'],
    });
    const served = servedApp(app, SCHEMA);
    assert.deepEqual(
      ['all', 'q', 'b', 'c'].map((key) => (served.views[key] as ResolvedListView).actions),
      [undefined, ['finish', 'start'], [], undefined],
    );
    assert.deepEqual(served.resources.task, { actions: SERVED, form: { show: ['name'] }, display: INFERRED });
    /* Where a principal's filters emptied the actions, the resource serves none: no write presentation at all. */
    const emptied = { ...app, resources: { task: { ...app.resources!.task, actions: [] } } };
    assert.equal(Object.hasOwn(servedApp(emptied, SCHEMA).resources.task, 'actions'), false);
    /* And a resource with nothing to say serves only what the conventions say of its columns. */
    assert.deepEqual(servedApp(parse({ views: { all: LIST }, home: 'all', nav: ['all'] }), SCHEMA).resources.task, { display: INFERRED });
    /* An empty actions object declares none, as an absent one does. */
    const none = parse({ resources: { task: { actions: {} } }, views: { all: LIST }, home: 'all', nav: ['all'] });
    assert.equal(Object.hasOwn(none.resources!.task, 'actions'), false);
  });

  test('actions or a form this catalog cannot run are withheld from the resource, with the reason; its lists still draw', () => {
    const app = parse({
      resources: { task: { access: 'write', form: { show: ['name'] }, actions: { bad: { label: 'Bad', set: { nope: 1 } } } } },
      views: { all: LIST },
      home: 'all',
      nav: ['all'],
    });
    const { resources, problems } = resolveResources(app, SCHEMA);
    assert.deepEqual(resources.task, { display: INFERRED }, 'neither the actions nor the form is served');
    assert.deepEqual(problems, ['resources "task", action "bad": "task" has no column "nope".']);
    assert.equal(resolveViews(app, withRollups(app, SCHEMA)).all.error, undefined);
    /* A resource this connection does not have is not served at all. */
    const elsewhere = parse({ resources: { invoice: { actions: ACTIONS } }, views: { all: LIST }, home: 'all', nav: ['all'] });
    assert.equal(Object.hasOwn(resolveResources(elsewhere, SCHEMA).resources, 'invoice'), false);
  });

  test('a selector elsewhere, an undeclared id, an action object, a list of actions or a repeated label is refused', () => {
    const app = (view: Record<string, unknown>, actions: unknown = ACTIONS) =>
      parse({
        resources: { task: { access: 'write', actions } },
        views: { all: LIST, v: { ...LIST, query: 'done = false', ...view } },
        home: 'all',
        nav: ['all', 'v'],
      });
    assert.throws(() => app({ actions: ['start'] }), /has "actions", which only a queue, a board or a custom list takes/);
    assert.throws(
      () => app({ presentation: { kind: 'queue', primary: 'name' }, actions: ['Nope'] }),
      /names "Nope", which resources\.task\.actions does not declare\. It declares: start, finish\./,
    );
    assert.throws(
      () => app({ presentation: { kind: 'queue', primary: 'name' }, actions: { x: { label: 'X', set: { done: true } } } }),
      /views "v" has "actions" that are not a list of action ids\./,
    );
    assert.throws(() => app({}, { ...ACTIONS, again: ACTIONS.start }), /has two actions labelled "Start" \("start" and "again"\)/);
    assert.throws(() => app({}, Object.values(ACTIONS)), /"actions" is not an object of action id to action/);
    assert.throws(
      () => app({}, { 'mark-lost': ACTIONS.start }),
      /action "mark-lost": an action's id is a word of letters, digits and underscores/,
    );
  });

  test('a command action may be offered in bulk only when its reference takes many targets', () => {
    const app = (command: Record<string, unknown>) =>
      parse({
        resources: { task: { access: 'write', actions: { advance: { label: 'Advance', command, bulk: true } } } },
        views: { all: LIST },
        home: 'all',
        nav: ['all'],
      });
    assert.throws(() => app(REF), /can offer "advance" in bulk only when the command declares targets: 'many'/);
    assert.equal(app({ ...REF, targets: 'many' }).resources?.task.actions?.[0].bulk, true);
  });

  test('a command action that asks nothing may confirm; one with inputs asks them in its form instead', () => {
    const app = (command: Record<string, unknown>) =>
      parse({
        resources: { task: { access: 'write', actions: { advance: { label: 'Advance', command, confirm: true } } } },
        views: { all: LIST },
        home: 'all',
        nav: ['all'],
      });
    assert.equal(app(REF).resources?.task.actions?.[0].confirm, true);
    assert.throws(
      () => app({ ...REF, input: { note: { type: 'text' } } }),
      /confirms, but its command "advance" asks for input in its form, which is already the confirmation/,
    );
  });

  test("a resource's form and actions need no list view to carry them, and a queue's narrowing narrows only the queue", () => {
    const dash = parse({ resources: { task: { actions: ACTIONS } }, views: { d: DASH }, home: 'd', nav: ['d'] });
    assert.deepEqual(servedApp(dash, SCHEMA).resources.task.actions, SERVED);
    const embedded = parse({
      resources: { task: { form: { show: ['name'] } } },
      views: { tasks: LIST, d: { ...DASH, sections: [{ kind: 'view', view: 'tasks' }] } },
      home: 'd',
      nav: ['d'],
    });
    assert.deepEqual(servedApp(embedded, SCHEMA).resources.task.form, { show: ['name'] });
    const narrowed = parse({
      resources: { task: { actions: ACTIONS } },
      views: { q: { ...LIST, presentation: { kind: 'queue', primary: 'name' }, actions: ['start'] } },
      home: 'q',
      nav: ['q'],
    });
    assert.deepEqual(servedApp(narrowed, SCHEMA).resources.task.actions, SERVED, 'record pages offer every action');
  });
});

describe('dashboards embed list views', () => {
  const views = {
    tasks: {
      ...LIST,
      label: 'Tasks',
      query: 'done = false',
      show: ['name', 'due'],
      tabs: ['open', { label: 'All' }],
    },
    q: { ...LIST, presentation: { kind: 'queue', primary: 'name', lines: ['status'] } },
    b: { ...LIST, board: { by: 'status', lanes: ['open', 'doing'], primary: 'name', lines: ['due'] } },
  };

  test('a grid embed lists its show under its query and first tab; a queue lists its card; a board stays a board', () => {
    const app = parse({
      views: {
        ...views,
        d: {
          ...DASH,
          sections: [
            { kind: 'view', view: 'tasks', limit: 5 },
            { kind: 'view', view: 'tasks', tab: 'all', title: 'Everything' },
            { kind: 'view', view: 'q' },
          ],
          aside: [{ kind: 'view', view: 'b' }],
        },
      },
      home: 'd',
      nav: ['d'],
    });
    const [grid, all, queue] = (app.views.d as AppDashboardView).sections;
    const [board] = (app.views.d as AppDashboardView).aside!;
    assert.deepEqual(grid, {
      kind: 'rows',
      title: 'Tasks',
      table: 'task',
      query: 'done = false and open',
      limit: 5,
      show: ['name', 'due'],
      view: 'tasks',
    });
    assert.deepEqual([all.title, all.query, all.view], ['Everything', 'done = false', 'tasks']);
    assert.deepEqual(queue, { kind: 'rows', title: 'Task', table: 'task', show: ['name', 'status'], view: 'q' });
    assert.deepEqual(board, {
      kind: 'board',
      title: 'Task',
      table: 'task',
      by: 'status',
      lanes: ['open', 'doing'],
      show: ['name', 'due'],
      view: 'b',
    });
    assert.equal(resolveViews(app, withRollups(app, SCHEMA)).d.error, undefined);
    /* A list view only a dashboard embeds has a room, where the embed's
       "open →" goes: after the rooms nav lists, never the home, never in nav. */
    assert.deepEqual(Object.keys(app.views), ['d', 'tasks', 'q', 'b']);
    assert.deepEqual(app.views.tasks, {
      table: 'task',
      label: 'Tasks',
      query: 'done = false',
      show: ['name', 'due'],
      tabs: [
        { label: 'Open', query: 'open', segment: 'open', slug: 'open' },
        { label: 'All', query: undefined },
      ],
    });
    assert.deepEqual(app.home, [{ view: 'd' }]);
    const served = servedApp(app, SCHEMA);
    assert.deepEqual(served.nav, [{ view: 'd', label: 'Board' }]);
    assert.deepEqual([...embeddedOnlyViews(served, homeViews(app))], ['tasks', 'q', 'b']);
    /* A view nav lists is its own room already, and is no embed's alone. */
    const listed = parse({
      views: { ...views, d: { ...DASH, sections: [{ kind: 'view', view: 'tasks' }] } },
      home: 'd',
      nav: ['d', 'tasks', 'q', 'b'],
    });
    assert.deepEqual(
      [Object.keys(listed.views), [...embeddedOnlyViews(servedApp(listed, SCHEMA), homeViews(listed))]],
      [['d', 'tasks', 'q', 'b'], []],
    );
  });

  test('a view only a dashboard embeds goes, for a principal, with the last dashboard that embeds it', () => {
    const app = servedApp(
      parse({
        views: {
          tasks: LIST,
          q: LIST,
          d: { ...DASH, sections: [{ kind: 'view', view: 'tasks' }] },
          e: {
            ...DASH,
            sections: [
              { kind: 'view', view: 'tasks' },
              { kind: 'view', view: 'q' },
            ],
          },
        },
        home: 'd',
        nav: ['d', 'e'],
      }),
      SCHEMA,
    );
    assert.deepEqual(Object.keys(withoutBrokenViews(app, ['d']).views), ['d', 'e', 'tasks', 'q']);
    const broken: typeof app = { ...app, views: { ...app.views, e: { ...app.views.e, error: 'Broken.' } } };
    assert.deepEqual(Object.keys(withoutBrokenViews(broken, ['d']).views), ['d', 'tasks'], 'q had only e to open it');
    /* A home rule's view is no embed's alone: it stays while it can be drawn. */
    assert.deepEqual(Object.keys(withoutBrokenViews(broken, ['d', 'q']).views), ['d', 'tasks', 'q']);
    const none: typeof app = { ...broken, views: { ...broken.views, d: { ...broken.views.d, error: 'Broken.' } } };
    assert.deepEqual([Object.keys(withoutBrokenViews(none, ['d']).views), withoutBrokenViews(none, ['d']).nav], [[], []]);
  });

  test('an embed names a list view, and one of its tabs', () => {
    assert.throws(
      () => parse({ views: { ...views, e: DASH, d: { ...DASH, sections: [{ kind: 'view', view: 'e' }] } }, nav: ['d', 'e'] }),
      /embeds "e", which is not a list view this App declares\. Its list views: tasks, q, b\./,
    );
    assert.throws(
      () => parse({ views: { ...views, d: { ...DASH, sections: [{ kind: 'view', view: 'tasks', tab: 'Nope' }] } }, home: 'd', nav: ['d'] }),
      /names the tab "Nope", which the view "tasks" does not have\. Its tabs: open, all\./,
    );
    assert.throws(
      () => parse({ views: { ...views, d: { ...DASH, sections: [{ kind: 'view', view: 'tasks', tab: 'All' }] } }, home: 'd', nav: ['d'] }),
      /names the tab "All" by its label\. Name a tab by its address word: "all"\./,
    );
  });

  test("a dashboard board's card is primary and lines; show is a list's", () => {
    const board = (extra: Record<string, unknown>) =>
      parse({ views: { d: { ...DASH, sections: [{ kind: 'board', from: 'task', by: 'status', ...extra }] } }, home: 'd', nav: ['d'] });
    assert.deepEqual((board({ primary: 'name', lines: ['customer_id.name'] }).views.d as AppDashboardView).sections[0].show, [
      'name',
      'customer_id.name',
    ]);
    assert.equal((board({}).views.d as AppDashboardView).sections[0].show, undefined);
    assert.throws(() => board({ lines: ['name'] }), /has "lines" and no "primary"/);
    assert.throws(() => board({ show: ['name'] }), /section 1 has "show", which only a rows section carries\./);
  });

  test('a metric opens a list view of the rows it counted, named by its key', () => {
    const dash = (metric: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      parse({
        nav: ['d', 'q', 'b'],
        ...extra,
        views: { ...views, d: { ...DASH, sections: [{ kind: 'metric', from: 'task', query: 'done = false', ...metric }] } },
        home: 'd',
      });
    // The list a metric opens is reached through it, as an embed's is: nav need not name it.
    const opens = dash({ to: 'tasks' });
    assert.equal((opens.views.d as AppDashboardView).sections[0].view, 'tasks');
    assert.equal(
      (opens.views.d as AppDashboardView).sections[0].query,
      'done = false',
      'an explicit query does not inherit the Open tab or repeat its standing condition',
    );
    assert.equal(embeddedOnlyViews(servedApp(opens, SCHEMA), ['d']).has('tasks'), true);
    assert.equal((dash({}, { nav: ['d', 'tasks', 'q', 'b'] }).views.d as AppDashboardView).sections[0].view, undefined);
    assert.throws(
      () => dash({ to: 'nope' }),
      /section 1 opens "nope", which is not a list view this App declares\. Its list views: tasks, q, b\./,
    );
    // false, as a breakdown's groups take it: the card is a figure that opens nothing.
    const still = (dash({ to: false }).views.d as AppDashboardView).sections[0];
    assert.equal(still.noDrill, true);
    assert.equal(still.view, undefined);
    assert.throws(() => dash({ to: 3 }), /section 1 has a "to" that is not a list view's key or false\./);
    assert.throws(
      () => dash({ to: 'tasks', from: 'customer' }, { resources: { customer: {} } }),
      /section 1 counts customer and opens "tasks", a list of task\. A metric opens a list of the rows it counted\./,
    );
    // `to` is a metric's, and a breakdown's, chart's, funnel's and matrix's groups; on any other section it is refused by name.
    assert.throws(
      () =>
        parse({
          views: { ...views, d: { ...DASH, sections: [{ kind: 'rows', from: 'task', to: 'tasks' }] } },
          home: 'd',
          nav: ['d', 'tasks', 'q', 'b'],
        }),
      /has "to", which only a metric or breakdown or chart or funnel or matrix carries\./,
    );
  });

  test('a breakdown, a chart and a matrix say their figures as a metric does: format and unit', () => {
    const measured = { from: 'task', measure: 'avg version * 100', format: 'percent', unit: 'met' };
    const sections = [
      { kind: 'breakdown', by: 'status', ...measured },
      { kind: 'chart', by: 'month due', ...measured },
      { kind: 'matrix', by: 'status, month due', ...measured },
    ];
    const parsed = parse({ views: { d: { ...DASH, sections } }, home: 'd', nav: ['d'] });
    for (const section of (parsed.views.d as AppDashboardView).sections) {
      assert.equal(section.format, 'percent', section.kind);
      assert.equal(section.unit, 'met', section.kind);
    }
    assert.throws(
      () => parse({ views: { d: { ...DASH, sections: [{ kind: 'chart', from: 'task', by: 'status', format: 'share' }] } }, home: 'd' }),
      /has a "format" of "share"\. Use "percent" \(a figure 0–100\), "number", "money" or "duration" \(a figure in seconds\)\./,
    );
    // A computed measure of seconds is a time taken: "First response", not "First response (minutes)" over a division.
    const timed = { from: 'task', measure: 'avg version', format: 'duration' };
    const timedDash = parse({
      views: {
        d: {
          ...DASH,
          sections: [
            { kind: 'chart', by: 'month due', ...timed },
            { kind: 'breakdown', by: 'status', ...timed },
          ],
        },
      },
      home: 'd',
      nav: ['d'],
    });
    for (const section of (timedDash.views.d as AppDashboardView).sections) assert.equal(section.format, 'duration', section.kind);
    // A board's cards say their own columns; it has no measure to dress.
    assert.throws(
      () => parse({ views: { d: { ...DASH, sections: [{ kind: 'board', from: 'task', by: 'status', format: 'percent' }] } }, home: 'd' }),
      /has "format", which only a metric or breakdown or chart or matrix carries\./,
    );
  });

  test('a breakdown measures each group against a goal row of another table, windowed by its own clock', async () => {
    const { targetText, windowed } = await import('../packages/engine/src/shared/dashboardAsks.js');
    const target = { from: 'customer', by: 'id', measure: 'count' };
    const section = { kind: 'breakdown', from: 'task', by: 'customer_id', measure: 'sum version', over: 'due', target };
    const app = parse({ resources: { customer: {} }, views: { d: { ...DASH, sections: [section] } }, home: 'd', nav: ['d'] });
    const [parsed] = (app.views.d as AppDashboardView).sections;
    // Written `from`, kept as the goal's `table`.
    assert.deepEqual(parsed.target, { table: 'customer', by: 'id', measure: 'count' });
    const view = resolveViews(app, withRollups(app, SCHEMA)).d as AppDashboardView & { error?: string };
    assert.equal(view.error, undefined);
    const [resolved] = view.sections;
    assert.equal(targetText(resolved), 'customer count by id limit 200');
    // Its own clock follows the reader's window; a goal with none stands for every window.
    const clocked = { ...resolved, target: { table: 'task', by: 'customer_id', measure: 'sum version', over: 'due' } };
    assert.equal(targetText(windowed(clocked, 'this quarter')), 'task due = this quarter sum version by customer_id limit 200');
    assert.equal(targetText(windowed(resolved, 'this quarter')), 'customer count by id limit 200');
    const judged = (goal: Record<string, unknown>) =>
      (
        resolveViews(
          parse({ resources: { customer: {} }, views: { d: { ...DASH, sections: [{ ...section, target: goal }] } }, home: 'd' }),
          SCHEMA,
        ).d as { error?: string }
      ).error;
    assert.match(
      judged({ from: 'task', by: 'customer_id', measure: 'count', over: 'name' })!,
      /"name" is text, so the time window cannot narrow by it/,
    );
    assert.match(judged({ from: 'task', by: 'nowhere', measure: 'count' })!, /target:/);
    const refused =
      (goal: unknown, extra: Record<string, unknown> = {}) =>
      () =>
        parse({ resources: { customer: {} }, views: { d: { ...DASH, sections: [{ ...section, ...extra, target: goal }] } }, home: 'd' });
    assert.throws(refused(5000), /a goal per group: \{ from, by, measure, over\? \}/);
    assert.throws(refused({ from: 'customer', measure: 'count' }), /no single "by"/);
    assert.throws(refused({ ...target, sort: 'id' }), /"sort"\. A breakdown's target says "from", "by", "measure", "query" and "over"/);
    assert.throws(refused(target, { shape: 'steps' }), /steps, which have no bar/);
  });

  test("a record page's breakdown and chart take the same words, and keep them when the page is written back (G111)", async () => {
    const { parsePagesConfig, sectionConfig } = await import('../packages/engine/src/shared/page.js');
    const measured = { from: 'deal', whose: 'owner_id', by: 'stage', measure: 'avg win_rate', format: 'percent', unit: 'won' };
    const [page] = parsePagesConfig(
      {
        pages: [
          {
            label: 'Seller',
            base: 'person',
            sections: [
              { kind: 'breakdown', ...measured },
              { kind: 'chart', ...measured },
            ],
          },
        ],
      },
      'g111 pages',
    );
    for (const section of page.sections) {
      assert.deepEqual([(section as { format?: string }).format, (section as { unit?: string }).unit], ['percent', 'won'], section.kind);
      const said = sectionConfig(section) as { format?: string; unit?: string };
      assert.deepEqual([said.format, said.unit], ['percent', 'won'], section.kind);
    }
    assert.throws(
      () =>
        parsePagesConfig({ pages: [{ label: 'S', base: 'person', sections: [{ kind: 'breakdown', ...measured, format: 'share' }] }] }, 'x'),
      /has a "format" of "share"/,
    );
  });

  test("a metric counts its own query within the target list's standing filters, never its first tab", () => {
    const tasks = {
      ...LIST,
      query: 'done = false or customer_id = 7',
      sort: 'name',
      tabs: [{ segment: 'active', sort: 'due' }],
    };
    const metric = { kind: 'metric', from: 'task', to: 'tasks' };
    const config = (sections: unknown[]) => ({ views: { tasks, d: { ...DASH, sections } }, home: 'd', nav: ['d'] });
    const parsed = parse(
      config([
        metric,
        { ...metric, query: 'status = done or name = Ada' },
        { ...metric, query: 'done = false or customer_id = 7 or status = done' },
      ]),
    );
    const sections = (parsed.views.d as AppDashboardView).sections;
    assert.deepEqual(
      sections.map((section) => measureText(section, section.query)),
      [
        // No query: every row the list shows, not its "Active" tab's open ones.
        'task (done = false or customer_id = 7) count',
        'task (done = false or customer_id = 7) and (status = done or name = Ada) count',
        'task (done = false or customer_id = 7) and (done = false or customer_id = 7 or status = done) count',
      ],
    );
    assert.equal(resolveViews(parsed, withRollups(parsed, SCHEMA)).d.error, undefined);
    // A normalized section used as authoring input keeps exactly one scope.
    const again = parse(config(sections.map(authored)));
    assert.deepEqual((again.views.d as AppDashboardView).sections, sections);
  });

  test('a target metric refuses clause-only queries and comparisons instead of silently changing its cohort', () => {
    const metric = { kind: 'metric', from: 'task', to: 'tasks' };
    const config = (section: Record<string, unknown>, standing?: string) => ({
      views: {
        tasks: { ...LIST, query: standing, tabs: ['open'] },
        d: { ...DASH, sections: [section] },
      },
      home: 'd',
      nav: ['d'],
    });
    for (const standing of [undefined, 'done = false']) {
      for (const key of ['query', 'compare']) {
        for (const clause of ['sort name', 'order by name', 'show name', 'limit 5', 'sort name show name limit 5']) {
          assert.throws(
            () => parse(config({ ...metric, [key]: clause }, standing)),
            new RegExp(`views "d", section 1 has a "${key}" with a (sort|show|limit) clause`),
            `${key}: ${clause}, standing: ${standing}`,
          );
        }
      }
    }
    // Absence is every row the list shows, not its first tab, and that normalized query is stable.
    const parsed = parse(config(metric));
    const [section] = (parsed.views.d as AppDashboardView).sections;
    assert.equal(section.query, undefined);
    const again = parse(config(authored(section)));
    assert.deepEqual((again.views.d as AppDashboardView).sections, [section]);
  });

  test('a metric keeps its target cohort in explicit comparisons, derived periods, windows and sparks', () => {
    const metric = { kind: 'metric', from: 'task', to: 'tasks', over: 'due', spark: true };
    const tasks = { ...LIST, query: 'done = false or customer_id = 7', tabs: ['open'] };
    const written = [
      { ...metric, compare: 'previous period' },
      { ...metric, query: 'status = doing and due = last 30 days', compare: 'previous period' },
      { ...metric, query: 'status = doing and due = last 30 days', compare: 'status = done and due = previous 30 days' },
    ];
    const config = (sections: unknown[]) => ({ views: { tasks, d: { ...DASH, sections } }, home: 'd', nav: ['d'] });
    const parsed = parse(config(written));
    const normalized = (parsed.views.d as AppDashboardView).sections;
    const again = parse(config(normalized.map(authored)));
    assert.deepEqual((again.views.d as AppDashboardView).sections, normalized, 'query and explicit comparison are not scoped twice');
    const resolved = resolveViews(parsed, withRollups(parsed, SCHEMA)).d as AppDashboardView;
    assert.equal(resolved.error, undefined);
    const [follows, period, explicit] = resolved.sections;
    const standing = '(done = false or customer_id = 7)';
    // No query: the list's standing rows, not its "Open" tab.
    assert.equal(follows.query, standing);
    assert.equal(follows.compare, undefined);
    assert.equal(follows.comparePeriod, true);
    const weekly = windowed(follows, 'last 7 days');
    assert.equal(weekly.query, `${standing} and due = last 7 days`);
    assert.equal(weekly.compare, `${standing} and due = previous 7 days`);
    assert.equal(period.compare, `${standing} and status = doing and due = previous 30 days`);
    assert.equal(period.windowBase, `${standing} and status = doing`);
    const changed = windowed(period, 'last 7 days');
    assert.equal(changed.query, `${standing} and status = doing and due = last 7 days`);
    assert.equal(changed.compare, `${standing} and status = doing and due = previous 7 days`);
    // The trend is the window's own, a day at a time, inside the same cohort.
    assert.equal(sparkText(changed), `task ${standing} and status = doing and due = last 7 days count by day due limit 400`);
    assert.equal(
      explicit.compare,
      `${standing} and status = done and due = previous 30 days`,
      'an explicit comparison inherits standing, not the first tab or the current query',
    );
    assert.equal(
      windowed(explicit, 'last 7 days').compare,
      undefined,
      'an authored comparison still hides when the reader changes the window',
    );
  });

  test('a dashboard opens on the window it declares, one of those it offers', () => {
    const metric = { kind: 'metric', from: 'task', title: 'Raised', over: 'due' };
    const app = (extra: Record<string, unknown>) =>
      parse({ views: { tasks: LIST, d: { ...DASH, sections: [metric], ...extra } }, home: 'd', nav: ['d'] });
    const declared = app({ windows: ['last 7 days', 'last 30 days'], window: '  last  30 days ' });
    assert.equal((declared.views.d as AppDashboardView).window, 'last 30 days');
    assert.equal(
      (resolveViews(declared, withRollups(declared, SCHEMA)).d as AppDashboardView).window,
      'last 30 days',
      'served beside its windows',
    );
    // The default windows count as offered.
    assert.equal((app({ window: 'last 90 days' }).views.d as AppDashboardView).window, 'last 90 days');
    assert.equal((app({}).views.d as AppDashboardView).window, undefined);
    assert.throws(
      () => app({ windows: ['last 7 days'], window: 'last 30 days' }),
      /views "d" has a "window" of "last 30 days", which is not one of the windows it offers: "last 7 days"\./,
    );
    assert.throws(() => app({ window: 30 }), /has a "window" of 30/);
  });

  test('a target standing date filter is retained rather than replaced or shifted with the metric window', () => {
    const parsed = parse({
      views: {
        tasks: { ...LIST, query: 'due = last 90 days', tabs: ['open'] },
        d: {
          ...DASH,
          sections: [
            {
              kind: 'metric',
              from: 'task',
              to: 'tasks',
              query: 'status = doing and due = last 30 days',
              over: 'due',
              compare: 'previous period',
              spark: true,
            },
          ],
        },
      },
      home: 'd',
      nav: ['d'],
    });
    const resolved = resolveViews(parsed, withRollups(parsed, SCHEMA)).d as AppDashboardView;
    assert.equal(resolved.error, undefined, 'only the metric window is used to derive previous period');
    const [section] = resolved.sections;
    assert.equal(section.query, 'due = last 90 days and status = doing and due = last 30 days');
    assert.equal(section.compare, 'due = last 90 days and status = doing and due = previous 30 days');
    assert.equal(section.windowBase, 'due = last 90 days and status = doing');
    const weekly = windowed(section, 'last 7 days');
    assert.equal(weekly.query, 'due = last 90 days and status = doing and due = last 7 days');
    assert.equal(weekly.compare, 'due = last 90 days and status = doing and due = previous 7 days');
    assert.equal(sparkText(weekly), 'task due = last 90 days and status = doing and due = last 7 days count by day due limit 400');
    // An authored false is heard over a window as well: the card is its figure alone.
    assert.equal(sparkText({ ...weekly, spark: false }), null);
  });

  test('a list in the aside is a name, a line and a value: at most three columns', () => {
    const aside = (show: string[]) =>
      parse({
        views: { ...views, d: { ...DASH, aside: [{ kind: 'rows', from: 'task', show }] } },
        home: 'd',
        nav: ['d', 'tasks', 'q', 'b'],
      });
    assert.deepEqual((aside(['name', 'status', 'due']).views.d as AppDashboardView).aside![0].show, ['name', 'status', 'due']);
    assert.throws(
      () => aside(['name', 'status', 'due', 'customer_id.name']),
      /"aside", section 1 shows 4 columns\. Rows in the aside draw as a name, a line under it and a value at its end: show at most three, or move them into "sections"\./,
    );
    // The main column keeps its tables, however wide.
    const main = parse({
      views: { ...views, d: { ...DASH, sections: [{ kind: 'rows', from: 'task', show: ['name', 'status', 'due', 'customer_id.name'] }] } },
      home: 'd',
      nav: ['d', 'tasks', 'q', 'b'],
    });
    assert.equal((main.views.d as AppDashboardView).sections[0].show?.length, 4);
  });
});

describe('home', () => {
  const content = { views: { tasks: LIST, d: DASH }, nav: ['d', 'tasks'] };
  const roles = { resources: { task: {} }, auth: { roles: { reader: { read: true } } } };

  test('every App names its home: the refusal names the App, says what to write and lists the views', () => {
    assert.throws(
      () => parse(content),
      (error: Error) => {
        assert.equal(
          error.message,
          `${WHERE}: the App "x" has no "home", so nothing says where a visitor starts. Write home: '<view id>', ` +
            "or a list of rules that ends with a rule with no condition, { view: '<view id>' }. It declares: tasks, d.",
        );
        return true;
      },
    );
    assert.throws(() => parse({}), /the App "x" has no "home", so nothing says where a visitor starts\.[\s\S]* It declares no views yet\./);
  });

  test('a rule list ends with a rule with no condition, so no visitor is left without a home', () => {
    const last =
      /"home", rule 1 has a condition and is the last rule, so a visitor it does not match has no home\. End the list with a rule with no condition: \{ view: '<view id>' \}\./;
    assert.throws(() => parse({ ...content, ...roles, home: [{ view: 'tasks', roles: ['reader'] }] }), last);
    assert.throws(
      () =>
        parse({ auth: {}, views: { ...content.views, welcome: WELCOME }, nav: content.nav, home: [{ view: 'welcome', signedOut: true }] }),
      last,
    );
    assert.throws(
      () =>
        parse({
          auth: {},
          ...content,
          views: { ...content.views, welcome: WELCOME },
          home: [
            { view: 'welcome', signedOut: true },
            { view: 'd', roles: [] },
          ],
        }),
      /rule 2 has "roles" that are not a non-empty list/,
    );
  });

  test('the rules are kept as written, for the server to evaluate per visitor; a view id is one rule for everyone', () => {
    for (const home of ['d', [{ view: 'd' }]]) assert.deepEqual(parse({ ...content, home }).home, [{ view: 'd' }]);
    const app = parse({ ...content, ...roles, home: [{ view: 'tasks', roles: ['reader'] }, { view: 'd' }] });
    assert.deepEqual(app.home, [{ view: 'tasks', roles: ['reader'] }, { view: 'd' }]);
    /* No view says it is the home: nothing about a view depends on who asks. */
    assert.equal(
      Object.values(resolveViews(app, withRollups(app, SCHEMA))).some((view) => 'home' in view),
      false,
    );
    const landing = parse({
      auth: {},
      views: { ...content.views, welcome: WELCOME },
      nav: content.nav,
      home: [{ view: 'welcome', signedOut: true }, { view: 'd' }],
    });
    assert.deepEqual([landing.landing?.view, landing.landing?.content.hero.heading], ['welcome', 'Hello']);
  });

  test('nav is optional: an App without it has one room, its home, and a menu of nothing', () => {
    const app = parse({ views: { tasks: { ...LIST, label: 'Tasks' } }, home: 'tasks' });
    assert.deepEqual([app.nav, app.views], [[], { tasks: { table: 'task', label: 'Tasks' } }]);
    assert.deepEqual(resolveViews(app, withRollups(app, SCHEMA)), { tasks: { table: 'task', label: 'Tasks' } });
    assert.deepEqual(parse({ views: { tasks: LIST }, home: 'tasks', nav: [] }).nav, [], 'an empty nav is no nav');
    /* The resource's form and actions are served on the resource, as for any App. */
    const tick = parse({
      resources: { task: { access: 'write', form: { show: ['name'] }, actions: ACTIONS } },
      views: { tasks: LIST },
      home: 'tasks',
    });
    assert.deepEqual(servedApp(tick, SCHEMA).resources.task, { actions: SERVED, form: { show: ['name'] }, display: INFERRED });
    /* A dashboard home is the one room a menu would list; the list it embeds
       has a room of its own. */
    const board = parse({ views: { tasks: LIST, d: { ...DASH, sections: [{ kind: 'view', view: 'tasks' }] } }, home: 'd' });
    assert.deepEqual(Object.keys(board.views), ['d', 'tasks']);
    const signed = parse({
      auth: {},
      views: { tasks: LIST, welcome: WELCOME },
      home: [{ view: 'welcome', signedOut: true }, { view: 'tasks' }],
    });
    assert.deepEqual([signed.landing?.content.hero.heading, Object.keys(signed.views), signed.nav], ['Hello', ['tasks'], []]);
  });

  test('without nav, home is a reference; a dashboard nothing references is still refused', () => {
    assert.doesNotThrow(() => parse({ views: { tasks: LIST }, home: 'tasks' }));
    assert.throws(
      () => parse({ views: { tasks: LIST, extra: DASH }, home: 'tasks' }),
      /views "extra" is referenced by nothing — not nav, not home, not a reachable dashboard's embed, metric or note action, or a landing's \{ kind: 'view' \} section/,
    );
  });

  test('references and audiences are checked at load', () => {
    assert.throws(
      () => parse({ ...content, home: 'nope' }),
      /"home" names the view "nope", which this App does not declare\. It declares: tasks, d\./,
    );
    assert.throws(() => parse({ ...content, home: [{ view: 'd' }, { view: 'tasks' }] }), /rule 2 can never match: rule 1 has no condition/);
    assert.throws(() => parse({ ...content, home: [{ view: 'd', signedOut: true }] }), /says "signedOut", and the App has no "auth"/);
    const auth = { resources: { task: {} }, auth: { roles: { viewer: { read: [] }, reader: { read: true } } } };
    assert.throws(
      () => parse({ ...content, ...auth, home: [{ view: 'd', signedOut: true }] }),
      /a signed-out visitor can open only a public view/,
    );
    assert.throws(
      () => parse({ ...content, ...auth, home: [{ view: 'd', roles: ['boss'] }] }),
      /names the role "boss", which auth\.roles does not declare\. It declares: viewer, reader\./,
    );
    assert.throws(
      () => parse({ ...content, ...auth, home: [{ view: 'tasks', roles: ['viewer'] }] }),
      /the role "viewer" does not read "task", which the view "tasks" shows/,
    );
    assert.throws(
      () => parse({ ...content, ...auth, home: [{ view: 'd', realm: 'tenant' }] }),
      /home rule 1 has a "realm", which needs the platform realm: auth\.tenancy\.platform\./,
    );
  });

  test('a home the server evaluates may be chosen by role, follow a roles rule when signed out, be the landing, or sit outside nav', () => {
    const welcome = { ...content, ...roles, views: { ...content.views, welcome: WELCOME } };
    assert.deepEqual(
      parse({ ...welcome, home: [{ view: 'tasks', roles: ['reader'] }, { view: 'welcome', signedOut: true }, { view: 'd' }] }).home,
      [{ view: 'tasks', roles: ['reader'] }, { view: 'welcome', signedOut: true }, { view: 'd' }],
    );
    assert.deepEqual(parse({ ...welcome, home: [{ view: 'welcome' }] }).home, [{ view: 'welcome' }]);
    /* A landing no rule names is still the App's front page, served at /welcome. */
    assert.equal(parse({ ...welcome, home: 'd' }).landing?.view, 'welcome');
    /* A home nav does not reference is a room all the same, after nav's own. */
    const offMenu = parse({ views: { tasks: LIST, d: DASH }, nav: ['tasks'], home: 'd' });
    assert.deepEqual([Object.keys(offMenu.views), offMenu.nav], [['tasks', 'd'], [{ view: 'tasks' }]]);
  });
});

describe('the tenancy vocabulary is live, and says what it needs where it is out of place', () => {
  const base = {
    resources: { task: {} },
    auth: { roles: { reader: { read: true } } },
    views: { tasks: LIST },
    home: 'tasks',
    nav: ['tasks'],
  };
  const T5 = /has a "realm", which needs the platform realm: auth\.tenancy\.platform\./;
  test('each tenancy key names what it needs; the later keys are still refused as not supported yet, never as a typo', () => {
    assert.throws(
      () => parse({ ...base, auth: { ...base.auth, tenancy: { label: 'Dealer' } } }),
      /"tenancy" describes a tenant App's tenants; it needs "rows": "tenant"\./,
    );
    assert.throws(
      () => parse({ ...base, resources: { task: { owner: 'tenant' } } }),
      /has an "owner", which says whose rows a tenant App's resource holds; it needs "auth\.rows": "tenant"\./,
    );
    /* What the support write trail keeps is live: it parses, and stays on the resource. */
    assert.deepEqual(parse({ ...base, resources: { task: { audit: { redact: 'values' } } } }).resources?.task.audit, { redact: 'values' });
    assert.throws(() => parse({ ...base, auth: { roles: { reader: { read: true, realm: 'tenant' } } } }), T5);
    assert.throws(() => parse({ ...base, views: { tasks: { ...LIST, realm: 'tenant' } } }), T5);
    assert.throws(() => parse({ ...base, nav: [{ id: 'g', label: 'G', children: ['tasks'], realm: 'tenant' }] }), T5);
    assert.throws(() => parse({ ...base, pages: { task: { base: 'task', realm: 'tenant' } } }), T5);
    assert.throws(
      () => parse({ ...base, resources: { task: { actions: { enter: { label: 'Enter', enter: 'tenant' } } } } }),
      /is not supported yet: it needs support sessions/,
    );
    assert.throws(
      () =>
        parse({
          ...base,
          resources: {
            task: {
              access: 'write',
              actions: { go: { label: 'Go', command: { id: 'go', version: 1, target: 'task', input: {}, realm: 'tenant' } } },
            },
          },
        }),
      T5,
    );
  });

  test('a tenant App is rows: tenant, kept as authored', () => {
    const app = parse({
      ...base,
      sources: { business: { connection: 'db' } },
      resources: { task: { owner: 'tenant' } },
      auth: { rows: 'tenant', roles: { reader: { read: true } } },
    });
    assert.equal(app.auth?.rows, 'tenant');
  });
});

describe('ceilings and grants lower into the policy the server enforces', () => {
  test('without auth, a declared ceiling is the write scope; a ceiling that writes nothing is read-only', () => {
    const scoped = bare({ resources: { task: { access: 'write' }, customer: {} } });
    assert.deepEqual(resolveAppAccess(scoped, SCHEMA, []).writable, new Set(['task']));
    assert.equal(appAllowsWrite(scoped, SCHEMA, 'customer'), false);
    assert.deepEqual(resolveAppAccess(bare({ resources: { task: {} } }), SCHEMA, []).writable, new Set());
    // No ceiling: every declared resource reads and none writes, and no other table reads.
    const open = resolveAppAccess(bare({ resources: { task: { display: { name: { format: 'number' } } } } }), SCHEMA, []);
    assert.deepEqual([open.readable, open.writable], [new Set(['task']), new Set()]);
    assert.throws(
      () => bare({ resources: { task: { fields: { read: ['id'] } } } }),
      /a column ceiling for signed-in roles; it needs "auth" and "auth\.roles"/,
    );
  });

  test('with auth, roles grant within the ceilings; bundle is the support bundle; rows is the enrollment flag', () => {
    const app = bare({
      sources: { main: { connection: 'db' } },
      resources: { task: { access: 'write', fields: { read: ['id', 'name', 'status'], write: ['status'] } }, customer: {} },
      auth: {
        rows: 'policy',
        defaultRole: 'agent',
        roles: { agent: { read: true, write: ['task'], commands: ['advance'], operations: ['readiness', 'bundle'] } },
      },
    });
    assert.deepEqual(app.resources, {
      task: { source: 'main', access: 'write', fields: { read: ['id', 'name', 'status'], write: ['status'] } },
      customer: { source: 'main' },
    });
    assert.deepEqual(app.auth, {
      providers: ['email'],
      signUp: 'invite',
      defaultRole: 'agent',
      rows: 'policy',
      roles: { agent: { read: true, write: ['task'], commands: ['advance'], operations: ['readiness', 'support'] } },
    });
  });

  test('the grants and their ceilings must agree', () => {
    const roles = (grant: Record<string, unknown>, resources: Record<string, unknown> = { task: {} }) =>
      bare({ resources, auth: { roles: { agent: grant } } });
    assert.throws(
      () => bare({ resources: { task: { access: 'write' } }, auth: {} }),
      /declares access 'write', and this App signs people in, so its ceilings are granted through "auth\.roles"/,
    );
    assert.throws(
      () => roles({ read: ['customer'] }),
      /role "agent", "read" names "customer", and the App declares no resource "customer" \[outside-ceiling\]/,
    );
    assert.throws(
      () => roles({ read: true, write: ['task'] }),
      /"write" names "task", and resources "task" is not written \(it has no access 'write'\) \[outside-ceiling\]/,
    );
    assert.throws(
      () => roles({ read: [], write: ['task'] }, { task: { access: 'write' } }),
      /"write" names "task", which the role does not read/,
    );
    assert.throws(
      () => roles({ read: true, operations: ['audit'] }),
      /"operations" must be a nonempty list from "readiness", "bundle", "workflows", "jobs", "deliveries", "stores", "analytics" and "support"/,
    );
    assert.throws(
      () => roles({ writable: true }),
      /role "agent" has no "writable"\. It takes: label, extends, read, write, create, export, commands, /,
    );
    assert.throws(
      () => bare({ resources: { task: {} }, auth: { rows: 'policy', roles: { agent: { read: true } } } }),
      /"rows": "policy", which requires named "sources"/,
    );
  });
});

describe('resource slots and pages', () => {
  test('a dotted resource names a declared, non-default source; an engine schema is a physical binding', () => {
    assert.throws(
      () => parse({ views: { v: { kind: 'list', from: 'public.task' } }, home: 'v', nav: ['v'] }),
      /names "public\.task": a dot in a resource name always qualifies it by source, and "public" is not a declared, non-default source\. Name the resource \("task"\), and bind it if needed: resources: \{ task: \{ physical: 'public\.task' \} \}/,
    );
    const sources = { main: { connection: 'db', default: true }, other: { connection: 'db2' } };
    assert.doesNotThrow(() =>
      parse({ sources, resources: { 'other.task': {} }, views: { v: { kind: 'list', from: 'other.task' } }, home: 'v', nav: ['v'] }),
    );
    assert.throws(
      () => parse({ sources, views: { v: { kind: 'list', from: 'main.task' } }, home: 'v', nav: ['v'] }),
      /"main" is the default source, whose resources stay bare/,
    );
    const bound = bare({ sources, resources: { task: { physical: 'public.task' }, 'other.ticket': { physical: 'public.ticket' } } });
    assert.deepEqual(
      [bound.sources?.main.default, bound.resources],
      [true, { task: { source: 'main', physical: 'public.task' }, 'other.ticket': { source: 'other', physical: 'public.ticket' } }],
    );
    // A root connection is the App's one source, named for it.
    assert.deepEqual(bare({ connection: 'db', resources: { task: { physical: 'public.task' } } }).resources, {
      task: { source: 'db', physical: 'public.task' },
    });
    // Without a default every name is qualified, so a bare block names no source.
    assert.throws(
      () => bare({ sources: { main: { connection: 'db' }, other: { connection: 'db2' } } }),
      /bare name, and no source says "default: true"/,
    );
  });

  test('pages are keyed; resources.<t>.page chooses between two pages over one table', () => {
    const raw = {
      name: 'x',
      resources: { task: { page: 'task-detail' } },
      views: { tasks: LIST },
      home: 'tasks',
      nav: ['tasks'],
      pages: { task: { base: 'task' }, 'task-detail': { base: 'task' } },
    };
    const app = parseTestApp(raw, WHERE);
    assert.deepEqual(
      orderAppPages(app, parseAppPages(raw, WHERE), WHERE).map((page) => page.id),
      ['task-detail', 'task'],
    );
    const one = { ...raw, pages: { 'task-detail': { base: 'task' } } };
    assert.throws(
      () => orderAppPages(parseTestApp(one, WHERE), parseAppPages(one, WHERE), WHERE),
      /chooses between the pages over "task", and there is one/,
    );
    assert.throws(
      () => bare({ pages: { task: { id: 'task', name: 'Task', base: 'task' } } }),
      /pages "task" \("Task"\) has no "id"\. It takes: /,
    );
    assert.throws(() => bare({ pages: [{ base: 'task' }] }), /"pages" must be an object of pages keyed by id\./);
    assert.throws(
      () => bare({ pages: { task: { base: 'task', connection: 'db' } } }),
      /has no "connection"\. "connection" belongs at the App's root\. It takes: .*listTabs/,
    );
    // The App names its one connection, so a page has no `connection` of its own.
    assert.throws(() => bare({ pages: { task: { base: 'task', connection: 'db' } } }), /has no "connection"/);
    assert.throws(
      () => bare({ pages: { task: { base: 'task', sections: [{ kind: 'metric', from: 'task', whose: 'id', filter: 'done = true' }] } } }),
      /has no "filter"\. It takes: .*query/,
    );
  });
});

describe('a first run', () => {
  const STEPS = [
    { label: ' Add your first task ', to: 'tasks', description: 'What needs doing.' },
    { label: 'Add a customer', to: 'customers' },
  ];
  const app = (section: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    parse({
      resources: { customer: {} },
      views: {
        tasks: LIST,
        customers: { kind: 'list', from: 'customer' },
        home: { kind: 'dashboard', label: 'Home', sections: [section, NOTE], ...extra },
      },
      home: 'home',
      nav: ['home'],
    });

  test('its steps are list views, trimmed, reachable through it, and served with their tables', () => {
    const parsed = app({ kind: 'firstRun', title: 'Welcome', description: 'Two steps.', steps: STEPS });
    assert.deepEqual((parsed.views.home as AppDashboardView).sections[0], {
      kind: 'firstRun',
      title: 'Welcome',
      text: 'Two steps.',
      steps: [
        { label: 'Add your first task', view: 'tasks', detail: 'What needs doing.' },
        { label: 'Add a customer', view: 'customers' },
      ],
    });
    const served = servedApp(parsed, SCHEMA);
    // Reached only through the first run, the lists are still rooms.
    assert.ok(served.views.tasks && served.views.customers);
    assert.deepEqual(
      (served.views.home as AppDashboardView).sections[0].steps!.map((step) => step.table),
      ['task', 'customer'],
    );
  });

  test('a step this reader cannot take is left out', () => {
    const parsed = app({ kind: 'firstRun', steps: STEPS });
    const narrow: DatabaseSchema = { ...SCHEMA, tables: SCHEMA.tables.filter((table) => table.id !== 'customer'), foreignKeys: [] };
    assert.deepEqual(
      (resolveViews(parsed, narrow).home as AppDashboardView).sections[0].steps!.map((step) => step.view),
      ['tasks'],
    );
    const views = servedApp(parsed, SCHEMA).views;
    const served = withAvailableEmptyActions({ views: { ...views, customers: { ...views.customers, error: 'gone' } } as typeof views });
    assert.deepEqual(
      (served.views.home as AppDashboardView).sections[0].steps!.map((step) => step.view),
      ['tasks'],
    );
  });

  test('it refuses what it cannot honour, naming the fix', () => {
    assert.throws(() => app({ kind: 'firstRun', steps: [] }), /needs "steps": 1 to 6 list views/);
    assert.throws(
      () => app({ kind: 'firstRun', steps: [{ label: 'Go', to: 'home' }] }),
      /opens "home", which is not a list view.*Its list views: tasks, customers/,
    );
    assert.throws(() => app({ kind: 'firstRun', steps: [{ to: 'tasks' }] }), /needs a "label"/);
    assert.throws(() => app({ kind: 'firstRun', steps: [{ title: 'Go', to: 'tasks' }] }), /has "title", which is now "label"/);
    assert.throws(() => app({ kind: 'firstRun', steps: [STEPS[0], STEPS[0]] }), /names the view "tasks" in two steps/);
    assert.throws(() => app({ kind: 'firstRun', steps: STEPS, table: 'task' }), /\(a first run\)/);
    // The sentence under a heading is `description`; the word it once was is refused by name.
    assert.throws(() => app({ kind: 'firstRun', text: 'Two steps.', steps: STEPS }), /has "text", which is now "description"/);
    assert.throws(
      () => app({ kind: 'firstRun', steps: [{ label: 'Go', to: 'tasks', text: 'Why' }] }),
      /has "text", which is now "description"/,
    );
    assert.throws(
      () => app({ kind: 'firstRun', steps: STEPS }, { aside: [{ kind: 'firstRun', steps: STEPS }] }),
      /stands in the dashboard's main flow/,
    );
    assert.throws(
      () =>
        parse({
          resources: { customer: {} },
          views: {
            tasks: LIST,
            customers: { kind: 'list', from: 'customer' },
            home: {
              kind: 'dashboard',
              label: 'Home',
              sections: [
                { kind: 'firstRun', steps: STEPS },
                { kind: 'firstRun', steps: STEPS },
              ],
            },
          },
          home: 'home',
          nav: ['home'],
        }),
      /more than one first run/,
    );
  });
});

describe('page embeds and notes, against the App', () => {
  test('an embed becomes the related list of its view; a note action must name a list or dashboard', () => {
    const app = bare({
      resources: { customer: {} },
      views: { tasks: { ...LIST, label: 'Open work', show: ['name', 'status'], query: 'done = false' } },
    });
    const pages = parseAppPages(
      {
        pages: {
          customer: {
            base: 'customer',
            sections: [
              { kind: 'view', view: 'tasks', whose: 'customer_id' },
              { kind: 'note', text: 'Call first.', action: { label: 'All work', to: 'tasks' } },
            ],
          },
        },
      },
      WHERE,
    );
    const [page] = orderAppPages(app, pages, WHERE);
    assert.deepEqual(JSON.parse(JSON.stringify(page.sections[0])), {
      kind: 'list',
      view: 'tasks',
      from: 'task',
      path: 'customer_id',
      title: 'Open work',
      columns: ['name', 'status'],
      filter: 'done = false',
    });
    const unavailable = withAvailablePageEmptyActions([page], { views: {} });
    assert.equal((unavailable[0].sections[1] as { action?: unknown }).action, undefined);
    assert.throws(
      () =>
        orderAppPages(
          app,
          parseAppPages(
            { pages: { customer: { base: 'customer', sections: [{ kind: 'view', view: 'nope', whose: 'customer_id' }] } } },
            WHERE,
          ),
          WHERE,
        ),
      /embeds "nope", which is not a list view this App declares/,
    );
  });
});

describe('page embeds of a board or a calendar', () => {
  test("keep the view's presentation, with every column it reads, and a table view stays a table", () => {
    const app = bare({
      resources: { customer: {} },
      views: {
        lanes: { ...LIST, label: 'Lanes', board: { by: 'status', primary: 'name', lines: ['owner'] } },
        tasks: { ...LIST, label: 'Plain', show: ['name'] },
      },
    });
    const pages = parseAppPages(
      {
        pages: {
          customer: {
            base: 'customer',
            sections: [
              { kind: 'view', view: 'lanes', whose: 'customer_id' },
              { kind: 'view', view: 'tasks', whose: 'customer_id' },
            ],
          },
        },
      },
      WHERE,
    );
    const [page] = orderAppPages(app, pages, WHERE);
    const [board, plain] = page.sections as Array<{ lanes?: { kind: string }; columns?: string[]; presentation?: unknown }>;
    assert.equal(board.lanes?.kind, 'board');
    assert.deepEqual(board.columns, ['status', 'name', 'owner']);
    assert.equal(plain.lanes, undefined);
  });
});

describe("a dashboard's rows", () => {
  test('carry the record’s name unseen, so a card on a phone is titled by it and not by its key (CX8)', async () => {
    const { dashboardListQuery } = await import('../packages/engine/src/shared/dashboardAsks.js');
    const column = (name: string, primaryKey = false) => ({ name, type: 'INTEGER', nullable: !primaryKey, primaryKey });
    const lease = {
      id: 'lease',
      name: 'lease',
      schema: '',
      isView: false,
      columns: [column('id', true), column('unit_id'), column('end_on')],
    };
    const lookups = {
      table: (id: string) => (id === 'lease' ? lease : undefined),
      references: () => [],
      referenceNames: () => ({}),
      naming: () => '$label',
    };
    const asked = dashboardListQuery(lookups, { table: 'lease', show: ['unit_id', 'end_on'], limit: 6 });
    assert.equal(asked.query, 'lease show unit_id, end_on, $label, id limit 6');
    // Fetched to title the row, never drawn as a column of its own.
    assert.deepEqual(asked.named, ['$label']);
    // A table named by its key has nothing to add; a shown name is not asked twice.
    assert.deepEqual(dashboardListQuery({ ...lookups, naming: () => 'id' }, { table: 'lease', show: ['end_on'] }).named, []);
    assert.deepEqual(dashboardListQuery({ ...lookups, naming: () => 'end_on' }, { table: 'lease', show: ['end_on'] }).named, []);
  });
});
