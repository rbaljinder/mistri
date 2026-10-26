/**
 * The authoring surface: the `@mistriwork/mistri/app` helpers return exactly the
 * JSON they stand for, and both typed layers catch in the editor what the
 * parser would refuse at startup — the schema layer (`satisfies
 * TypedAppConfig<Tables>`) checks table and column names, and the reference
 * layer (`defineApp`) checks the App against its own view ids, action
 * labels and pages. The compile check reads the helpers themselves, because
 * a helper whose signature widened a literal is a typed check that quietly
 * stopped.
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { typecheck } from './support/tsc.js';
import {
  action,
  applyTo,
  board,
  breakdown,
  calendar,
  cards,
  checklist,
  commandForm,
  current,
  dashboard,
  chart,
  embed,
  fields,
  header,
  hero,
  landing,
  listView,
  me,
  metric,
  navGroup,
  now,
  page,
  queue,
  search,
  step,
  text,
  timeline,
  today,
  note,
} from '@mistriwork/mistri/app';
import { parseAppConfig, withRollups } from '../packages/mistri/src/shared/app.js';
import { typesForSchema } from '../packages/mistri/src/server/typegen.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

describe('the helpers return exactly the JSON they stand for', () => {
  test('views: a dashboard, a command form and a landing say their kind; nothing is keyed by the helper', () => {
    assert.deepEqual(dashboard('Front door', [note('hi')], { description: 'Today at a glance', from: 'task' }), {
      kind: 'dashboard',
      label: 'Front door',
      sections: [{ kind: 'note', text: 'hi' }],
      description: 'Today at a glance',
      from: 'task',
    });
    const command = 'apply';
    assert.deepEqual(commandForm('Apply', command, [step('About you', ['a'])], { submitLabel: 'Send', public: true }), {
      kind: 'form',
      label: 'Apply',
      command,
      steps: [{ id: 'about-you', label: 'About you', fields: ['a'] }],
      submitLabel: 'Send',
      public: true,
    });
    // The steps may be left out, with or without the options after them.
    assert.deepEqual(commandForm('Note', command), { kind: 'form', label: 'Note', command });
    assert.deepEqual(commandForm('Note', command, { done: { title: 'Saved' } }), {
      kind: 'form',
      label: 'Note',
      command,
      done: { title: 'Saved' },
    });
    assert.deepEqual(landing(hero('Hello', [applyTo('apply', 'Apply now')])), {
      kind: 'landing',
      hero: { heading: 'Hello', actions: [{ label: 'Apply now', to: 'apply' }] },
    });
  });

  test('a page has no id: its key in `pages` is its id', () => {
    assert.deepEqual(page('task', [fields(['name'])], { listTabs: false }), {
      base: 'task',
      sections: [{ kind: 'fields', show: ['name'] }],
      listTabs: false,
    });
    assert.deepEqual(fields(['status'], { presentation: 'summary', region: 'aside' }), {
      kind: 'fields',
      show: ['status'],
      presentation: 'summary',
      region: 'aside',
    });
  });

  test('the head and the current card are kinds of their own; a header names its verbs by their ids', () => {
    assert.deepEqual(header({ status: 'status', primary: 'renew', destructive: ['end'] }), {
      kind: 'header',
      status: 'status',
      primary: 'renew',
      destructive: ['end'],
    });
    assert.deepEqual(current('Current lease', 'lease', 'unit_id', { query: 'status = active', sort: 'starts_on desc' }), {
      kind: 'current',
      title: 'Current lease',
      from: 'lease',
      whose: 'unit_id',
      query: 'status = active',
      sort: 'starts_on desc',
    });
  });

  test('the day, the moment and the person are constants, never words a literal could be', () => {
    assert.deepEqual([today, now, me], [{ auto: 'today' }, { auto: 'now' }, { auto: 'me' }]);
    assert.deepEqual(action('Resolve', { set: { resolved_at: now, resolved_by: me } }).set, {
      resolved_at: { auto: 'now' },
      resolved_by: { auto: 'me' },
    });
  });

  test('a group of references, a board card, an action label', () => {
    assert.deepEqual(navGroup('plan', 'Plan', ['tasks', { to: 'board', label: 'Board' }]), {
      id: 'plan',
      label: 'Plan',
      children: ['tasks', { to: 'board', label: 'Board' }],
    });
    assert.deepEqual(board('Flow', 'task', 'status', { primary: 'name', lines: ['due'] }), {
      kind: 'board',
      title: 'Flow',
      from: 'task',
      by: 'status',
      primary: 'name',
      lines: ['due'],
    });
    assert.deepEqual(action('Finish', { set: { done: true }, when: 'done = false' }), {
      label: 'Finish',
      set: { done: true },
      when: 'done = false',
    });
  });

  test('the page helpers keep their shapes; a metric narrows by query', () => {
    assert.deepEqual(metric('Open tasks', 'task', { whose: 'account_id', query: 'status = open', width: 'third' }), {
      kind: 'metric',
      title: 'Open tasks',
      from: 'task',
      whose: 'account_id',
      query: 'status = open',
      width: 'third',
    });
    assert.deepEqual(metric('Pipeline', 'opportunity', { whose: 'account_id', measure: 'sum amount' }), {
      kind: 'metric',
      title: 'Pipeline',
      from: 'opportunity',
      whose: 'account_id',
      measure: 'sum amount',
    });
    assert.deepEqual(chart('Bookings', 'opportunity', 'month close_date', { height: 240 }), {
      kind: 'chart',
      title: 'Bookings',
      from: 'opportunity',
      by: 'month close_date',
      height: 240,
    });
    assert.deepEqual(timeline('Activity', [], { when: 'status = open', region: 'aside' }), {
      kind: 'timeline',
      title: 'Activity',
      streams: [],
      when: 'status = open',
      region: 'aside',
    });
  });

  test('a list view and its presentations, the display rules, an embed, a page breakdown and the landing prose and search', () => {
    assert.deepEqual(listView('Tasks', 'task', { presentation: checklist('name', 'done', { lines: ['due'] }) }), {
      kind: 'list',
      label: 'Tasks',
      from: 'task',
      presentation: { kind: 'checklist', primary: 'name', checked: 'done', lines: ['due'] },
    });
    assert.deepEqual(queue('name', { lines: ['status'] }), { kind: 'queue', primary: 'name', lines: ['status'] });
    assert.deepEqual(calendar('due', 'name'), { kind: 'calendar', date: 'due', primary: 'name' });
    assert.deepEqual(cards('title', { value: 'price', facts: ['year'] }), {
      kind: 'cards',
      primary: 'title',
      value: 'price',
      facts: ['year'],
    });
    assert.deepEqual(embed('tasks', { width: 'half', limit: 5 }), { kind: 'view', view: 'tasks', width: 'half', limit: 5 });
    assert.deepEqual(breakdown('By status', 'task', 'status', { whose: 'order_id', width: 'half' }), {
      kind: 'breakdown',
      title: 'By status',
      from: 'task',
      whose: 'order_id',
      by: 'status',
      width: 'half',
    });
    assert.deepEqual(text('Words'), { kind: 'text', text: 'Words' });
    assert.deepEqual(text('About', 'Words'), { kind: 'text', title: 'About', text: 'Words' });
    assert.deepEqual(search('cars', ['make'], { submitLabel: 'Go' }), {
      kind: 'search',
      view: 'cars',
      filters: ['make'],
      submitLabel: 'Go',
    });
  });

  test('what the helpers build, the parser takes', () => {
    assert.doesNotThrow(() =>
      parseAppConfig(
        {
          name: 'x',
          resources: { task: { access: 'write', actions: { finish: action('Finish', { set: { done: true } }) } } },
          views: {
            tasks: listView('Tasks', 'task', { presentation: queue('name') }),
            d: dashboard('D', [board('Flow', 'task', 'status', { primary: 'name' }), embed('tasks')]),
          },
          pages: { task: page('task', [fields(['name'])]) },
          home: 'd',
          nav: [navGroup('work', 'Work', ['d', 'tasks'])],
        },
        'test/app.json',
      ),
    );
  });
});

test('both typed layers check names through the helpers, take no hand-written object in their place, and leave grammar strings alone', () => {
  const filename = new URL('./.app-dsl-surface-types.ts', import.meta.url).pathname;
  const source = `import { defineApp, dashboard, metric, rows, board, chart, note, page, related, breakdown, stream, timeline, navGroup, action, computed, header, fields, commandForm, step, landing, hero, applyTo, signIn, embed, listView, queue, cards, type TypedAppConfig, type TypedDashboardView, type AppForm, type FormStep, type AppDashSection, type RowsDashSection } from '@mistriwork/mistri/app';
    type Tables = { work_order: 'id'|'reference'|'status'|'customer_id'|'opened_on'|'version'|'is_open'|'age'; customer: 'id'|'name'; task: 'id'|'subject'|'done'|'order_id' };
    type App = TypedAppConfig<Tables>;
    declare module '@mistriwork/mistri/app' {
      interface Register { commands: {
        assign: { target: 'work_order'; targets: 'many'; input: 'customer' };
        apply: { target: 'task'; targets: 'none'; input: 'note'; public: true };
        c: { target: 'customer'; targets: 'one'; input: never };
      } }
    }
    const assign = 'assign';
    const apply = 'apply';

    // Every section kind, by its helper, with typed over / by and untyped grammar.
    const ops = dashboard('Ops', [
      metric('Open', 'work_order', { query: 'status = open', over: 'opened_on', compare: 'previous period', better: 'up', spark: true }),
      chart('Per month', 'work_order', 'month opened_on', { over: 'opened_on', height: 200, shape: 'line' }),
      board('Flow', 'work_order', 'status', { primary: 'reference', lines: ['customer_id.name'], sort: 'id desc', limit: 4 }),
      rows('Newest', 'work_order', { show: ['reference'], sort: 'id desc', over: 'opened_on', sizing: 'scroll' }),
      note('The author speaking', { width: 'half' }),
      metric('Customers', 'customer', { measure: 'count' }),
      embed('queue', { limit: 5 }),
      embed('orders', { width: 'half' }),
    ], { from: 'work_order', filters: ['status'] }) satisfies TypedDashboardView<Tables>;

    // The schema layer and the reference layer together, as the samples write them.
    export const valid = defineApp({ name: 'Ops',
      resources: {
        work_order: { access: 'write', display: { status: { tone: { open: 'info' } }, version: { format: 'number', unit: 'rev' }, opened_on: { format: 'relative' } },
          labels: { reference: 'Ref', 'customer_id.name': 'Customer' }, recordLabel: 'customer_id.name',
          form: { show: ['reference', 'status'], when: { status: 'reference is not empty' } },
          validation: [{ must: 'reference is not empty', when: 'status = open', message: 'A reference.' }],
          actions: { assign: action('Assign', { command: assign, bulk: true }), close: action('Close', { set: { status: 'closed' } }) },
          computed: { is_open: computed.boolean('status = open'), age: computed.number('today - opened_on') },
          page: 'order' },
        customer: {},
      },
      auth: { rows: 'all', roles: { reader: { read: true }, clerk: { read: true, write: ['work_order'], commands: ['assign'], operations: ['bundle'] } } },
      views: {
        ops,
        orders: listView('Orders', 'work_order', { filters: ['status', 'customer_id'], show: ['reference', 'customer_id.name', 'is_open', 'age'], sort: 'age desc' }),
        queue: listView('Queue', 'work_order', { query: 'status = open', presentation: queue('reference', { lines: ['status'] }), actions: ['assign'] }),
        helped: listView('Helped', 'work_order', { presentation: queue('reference', { lines: ['status', 'customer_id'] }), filters: ['status'] }),
        shelf: listView('Shelf', 'work_order', { presentation: cards('reference', { value: 'id', facts: ['status', 'customer_id.name'] }) }),
        split: listView('Split', 'work_order', { show: ['reference'], split: { limit: 25, detail: ['customer_id.name'] } }),
        welcome: landing(hero('Hello', [applyTo('note', 'Leave a note'), signIn('Staff')])),
        note: commandForm('Leave a note', apply, [step('Note', ['note'])], { public: true }),
      },
      pages: {
        order: page('work_order', [
          fields(['reference']),
          metric('Open task ids', 'task', { measure: 'sum id', whose: 'order_id', query: 'done = false' }),
          metric('Tasks', 'task', { whose: 'order_id', query: 'done = false' }),
          breakdown('Tasks by state', 'task', 'done', { whose: 'order_id', width: 'half' }),
          metric('Task ids', 'task', { whose: 'order_id', measure: 'sum id' }),
          related('Tasks', 'task', 'order_id', { show: ['subject', { column: 'done', label: 'Done' }], query: 'done = false' }),
          timeline('Activity', [stream('task', 'order_id', 'id', 'subject', { query: 'done = true' })], { when: 'status = open', region: 'aside' }),
        ]),
        'order-summary': page('work_order', [fields(['status'])]),
      },
      home: [{ view: 'welcome', signedOut: true }, { view: 'ops' }],
      nav: [navGroup('work', 'Work', ['ops', 'orders', { to: 'queue', label: 'To assign' }, 'split', 'helped', 'shelf'])],
      ui: { shell: { placement: 'top' }, editing: { save: 'blur' } },
    } satisfies App);

    // The reference layer alone, for an untyped App.
    export const untyped = defineApp({ name: 'x', views: { a: listView('T', 't') }, nav: ['a'], home: 'a' });

    const step1: FormStep<'a' | 'b'> = { id: 's', label: 'S', fields: ['a'] };
    export const form: AppForm<'a' | 'b'> = { steps: [step1] };
    // @ts-expect-error Repeatable children are not on the public form.
    export const children: AppForm = { children: [] };
    // @ts-expect-error A rows section carries no compare — the union is keyed on kind.
    export const compareOnRows: AppDashSection = rows('R', 't', { compare: 'x' });
    // @ts-expect-error A note needs its text.
    export const bareNote: AppDashSection = note();
    export const rowsShow: RowsDashSection = rows('R', 't', { show: ['a', 'b.name'] });
    // @ts-expect-error A view shows strings; captions are the resource's labels.
    export const labelledShow: RowsDashSection = rows('R', 't', { show: [{ column: 'a', label: 'A' }] });
    // @ts-expect-error A filter is a bare column of the view's table.
    export const badFilter: App = { name: 'x', views: { v: listView('V', 'work_order', { filters: ['reference', 'nope'] }) } };
    // @ts-expect-error A card's primary is a column of the view's table.
    export const badPrimary: App = { name: 'x', views: { v: listView('V', 'work_order', { presentation: queue('nope') }) } };
    // @ts-expect-error A presentation built by its helper is checked the same way.
    export const badHelped: App = { name: 'x', views: { v: listView('V', 'work_order', { presentation: queue('nope') }) } };
    // @ts-expect-error A page breakdown's from is a table.
    export const badCountBy: App = { name: 'x', pages: { p: page('work_order', [breakdown('T', 'nope', 'done', { whose: 'order_id' })]) } };
    // @ts-expect-error over is a bare column of the section's own table.
    export const badOver: App = { name: 'x', views: { d: dashboard('D', [metric('Open', 'work_order', { over: 'nope' })]) } };
    // @ts-expect-error A board's by is a bare column of its table.
    export const badBy: App = { name: 'x', views: { d: dashboard('D', [board('Flow', 'work_order', 'nope')]) } };
    // @ts-expect-error A display rule is keyed by a column of its resource.
    export const badDisplay: App = { name: 'x', resources: { work_order: { display: { nope: { format: 'money' } } } } };
    // @ts-expect-error A record label starts with a column of its resource.
    export const badRecordLabel: App = { name: 'x', resources: { work_order: { recordLabel: 'nope' } } };
    // @ts-expect-error A form field is a column of its resource.
    export const badForm: App = { name: 'x', resources: { work_order: { form: { show: ['nope'] } } } };
    // @ts-expect-error An update's set names columns of its resource.
    export const badSet: App = { name: 'x', resources: { work_order: { actions: { x: action('X', { set: { nope: 1 } }) } } } };
    // @ts-expect-error A page section's from is a table.
    export const badFrom: App = { name: 'x', pages: { p: page('work_order', [related('T', 'nope', 'order_id')]) } };
    // @ts-expect-error A stream's from is a table.
    export const badStream: App = { name: 'x', pages: { p: page('work_order', [timeline('A', [stream('nope', 'order_id', 'id', 'subject')])]) } };
    // @ts-expect-error A command's target is the resource that offers it.
    export const badTarget: App = { name: 'x', resources: { work_order: { actions: { a: action('A', { command: 'c' }) } } } };
    // @ts-expect-error An action is keyed by its id; a list of them is not the shape.
    export const listedActions: App = { name: 'x', resources: { work_order: { actions: [action('Close', { set: { status: 'closed' } })] } } };
    // @ts-expect-error A computed column is named like a column: its name misspelt fails.
    export const badComputedName: App = { name: 'x', views: { v: listView('V', 'work_order', { show: ['reference', 'is_opn'] }) } };
    // @ts-expect-error A computed column is a boolean, a number or a date.
    export const badComputed: App = { name: 'x', resources: { work_order: { computed: { x: { type: 'text', value: 'reference' } } } } };
    // @ts-expect-error rows is one of three words.
    export const badRows: App = { name: 'x', auth: { rows: 'open' } };
    // @ts-expect-error A view says presentation; it has no list key.
    export const oldList: App = { name: 'x', views: { v: listView('V', 'work_order', { list: { kind: 'queue', title: 'reference' } }) } };

    // The reference layer: nav, home and embeds name the App's own views, of the right kind.
    // @ts-expect-error nav names a view the App does not declare.
    export const badNav = defineApp({ name: 'x', views: { a: listView('T', 't') }, home: 'b', nav: ['b'] });
    // @ts-expect-error Public views are not nav destinations.
    export const publicInNav = defineApp({ name: 'x', auth: {}, views: { a: landing(hero('Hi', [signIn('In')])) }, nav: ['a'], home: [{ view: 'a', signedOut: true }] });
    // @ts-expect-error home names a view the App does not declare.
    export const badHome = defineApp({ name: 'x', views: { a: listView('T', 't') }, nav: ['a'], home: 'b' });
    // @ts-expect-error A dashboard embeds list views only.
    export const badEmbed = defineApp({ name: 'x', views: { d: dashboard('D', [embed('e')]), e: dashboard('E', [note('n')]) }, nav: ['d', 'e'] });
    const go = { go: action('Go', { set: { done: true } }), stop: action('Stop', { set: { done: false }, confirm: true }) };
    // @ts-expect-error A selector names the resource's own action ids.
    export const badSelector = defineApp({ name: 'x', resources: { t: { actions: go } }, views: { q: listView('T', 't', { presentation: queue('name'), actions: ['Go'] }) }, home: 'q', nav: ['q'] });
    export const goodSelector = defineApp({ name: 'x', resources: { t: { actions: go } }, views: { q: listView('T', 't', { presentation: queue('name'), actions: ['go', 'stop'] }) }, home: 'q', nav: ['q'] });
    // @ts-expect-error A grid draws no actions, so it takes no selector.
    export const gridSelector = defineApp({ name: 'x', resources: { t: { actions: go } }, views: { g: listView('T', 't', { actions: ['go'] }) }, home: 'g', nav: ['g'] });
    // A header names its verbs by the ids of its page's resource's actions, written inline where the resource is.
    export const goodHeader = defineApp({ name: 'x', resources: { t: { actions: go } }, views: { g: listView('T', 't') }, home: 'g', nav: ['g'],
      pages: { t: page('t', [header({ primary: 'go', destructive: ['stop'] }), fields(['name'])]) } });
    // @ts-expect-error A header's primary is one of its resource's action ids, never a label.
    export const labelPrimary = defineApp({ name: 'x', resources: { t: { actions: go } }, views: { g: listView('T', 't') }, home: 'g', nav: ['g'], pages: { t: page('t', [header({ primary: 'Go' })]) } });
    declare const someVerb: string;
    // @ts-expect-error A header's primary is a literal id: a string variable cannot be checked against the resource's actions.
    export const widePrimary = header({ primary: someVerb });
    // @ts-expect-error A header's destructive ids are its resource's.
    export const badDestructive = defineApp({ name: 'x', resources: { t: { actions: go }, u: { actions: { end: action('End', { set: { done: true } }) } } }, views: { g: listView('T', 't') }, home: 'g', nav: ['g'], pages: { t: page('t', [header({ status: 'done', destructive: ['end'] })]) } });
    // @ts-expect-error A role grants a fixed action by its id.
    export const badGrant = defineApp({ name: 'x', resources: { t: { access: 'write', actions: go } }, auth: { roles: { r: { read: true, actions: { t: ['Go'] } } } }, views: { g: listView('T', 't') }, home: 'g', nav: ['g'] });
    export const goodGrant = defineApp({ name: 'x', resources: { t: { access: 'write', actions: go } }, auth: { roles: { r: { read: true, actions: { t: ['go'] } } } },
      views: { g: listView('T', 't') }, home: 'g', nav: ['g'] });
    // @ts-expect-error A call to action names a public form view.
    export const badApply = defineApp({ name: 'x', auth: {}, views: { w: landing(hero('Hi', [applyTo('nope', 'Go')])) }, home: [{ view: 'w', signedOut: true }] });
    // @ts-expect-error A signed-in form is no call to action's: only a form that says public: true is.
    export const signedInApply = defineApp({ name: 'x', auth: {}, views: { w: landing(hero('Hi', [applyTo('f', 'Go')])), f: commandForm('F', apply, [step('Note', ['note'])]) }, nav: ['f'], home: [{ view: 'w', signedOut: true }, { view: 'f' }] });
    // A signed-in form is a nav destination; a public one is not.
    export const formInNav = defineApp({ name: 'x', auth: {}, views: { f: commandForm('F', apply, [step('Note', ['note'])]) }, nav: ['f'], home: 'f' });
    // @ts-expect-error Public views are not nav destinations.
    export const publicFormInNav = defineApp({ name: 'x', auth: {}, views: { f: commandForm('F', apply, [step('Note', ['note'])], { public: true }) }, nav: ['f'], home: 'f' });
    // @ts-expect-error resources.<t>.page names a page over that table.
    export const badPage = defineApp({ name: 'x', resources: { t: { page: 'other' } }, pages: { other: page('u', []) } });
    // The helpers are the only spelling: a hand-written view, action or page is a type error, however right its fields.
    // @ts-expect-error A view is made by listView(), not written as an object.
    export const rawView = defineApp({ name: 'x', views: { v: { kind: 'list', label: 'X', from: 't' } }, home: 'v', nav: ['v'] });
    // @ts-expect-error An action is made by action(), not written as an object.
    export const rawAction = defineApp({ name: 'x', resources: { t: { actions: { close: { label: 'Close', set: { status: 'closed' } } } } } });
    // @ts-expect-error A page is made by page(), not written as an object.
    export const rawPage = defineApp({ name: 'x', pages: { t: { base: 't', sections: [] } } });
  `;
  assert.equal(typecheck(filename, { files: { [filename]: source } }), '');
});

/* A query string is checked where a helper names its table, once the generated schema registers its `Columns`:
   a column that is not there, an operator the language lacks and a value the column never holds each fail the
   typecheck at the string, and the message names the column or the value. What reads passes. */
const QUERY_SCHEMA = `
    type Columns = {
      work_order: { id: 'number'; reference: 'text'; status: ['open', 'closed']; customer_id: 'number'; opened_on: 'date'; is_open: 'boolean' };
      customer: { id: 'number'; name: 'text'; tier: ['gold', 'silver'] };
      task: { id: 'number'; subject: 'text'; done: 'boolean'; order_id: 'number' };
    };
    type References = { work_order: { customer_id: 'customer' }; task: { order_id: 'work_order' } };
    declare module '@mistriwork/mistri/app' { interface Register { schema(): { columns: Columns; references: References } } }`;

function probe(source: string): string {
  const filename = new URL('./.app-dsl-query-types.ts', import.meta.url).pathname;
  return typecheck(filename, { files: { [filename]: source }, options: { allowImportingTsExtensions: true } });
}

test('a registered schema checks query strings at the helper that names the table', () => {
  const source = `import { listView, metric, chart, breakdown, matrix, rows, board, related, current, count, sum, dashboard, page } from '@mistriwork/mistri/app';
    import { defineCommand, field } from '../packages/mistri/src/server/commands.ts';
    ${QUERY_SCHEMA}

    // What reads passes: conditions joined by and/or and parentheses, lists, paths, phrases, quoted text, me.
    export const good = listView('Orders', 'work_order', {
      query: '(status = open or status = closed) and opened_on = last 30 days and customer_id.tier in (gold, silver) and reference = "a and b"',
      sort: 'opened_on desc, customer_id.name', tabs: [{ label: 'Mine', query: 'customer_id = me and is_open = true', sort: 'id' }] });
    export const named = listView('Orders', 'work_order', { sort: [{ label: 'Newest', sort: 'opened_on desc' }, { label: 'Ref', sort: 'reference' }] });
    export const board1 = dashboard('D', [
      metric('Open', 'work_order', { query: 'status = open', measure: 'count' }),
      chart('Opened', 'work_order', 'month opened_on', { query: 'reference is not empty' }),
      breakdown('By status', 'work_order', 'status', { measure: 'sum id as total' }),
      matrix('Cross', 'work_order', 'status, month opened_on'),
      rows('Newest', 'work_order', { query: 'opened_on >= 2026-01-31', sort: 'id desc' }),
      board('Flow', 'work_order', 'status', { query: 'status != closed' }),
    ]);
    export const p = page('work_order', [related('Tasks', 'task', 'order_id', { query: 'done = false', sort: 'subject' }),
      current('Latest', 'task', 'order_id', { query: 'subject contains "x"' })]);
    export const r = count('task', { query: 'done = false' });
    export const command = defineCommand({ source: 'main', target: 'work_order', when: 'status = open and is_open = true',
      input: { task: field.reference('task', { by: 'id', labelColumn: 'subject', query: 'done = false sort subject' }) }, handle() {} });
    // An untyped table is not judged here.
    export const elsewhere = listView('X', 'not_a_table', { query: 'anything = goes' });

    // @ts-expect-error A column that is not there.
    export const badColumn = listView('Orders', 'work_order', { query: 'stauts = open' });
    // @ts-expect-error \`is\` reads open or a group of the column's machine.
    export const badOperator = listView('Orders', 'work_order', { query: 'status is shut' });
    // @ts-expect-error An operator the language does not have.
    export const badWord = listView('Orders', 'work_order', { query: 'status equals open' });
    // A machine's open states are asked by name; the server judges whether the column has a machine.
    export const openStates = listView('Orders', 'work_order', { query: 'status is not open' });
    // @ts-expect-error A value outside the column's vocabulary.
    export const badValue = listView('Orders', 'work_order', { query: 'status = opne' });
    // @ts-expect-error A value through a path is read against the column it lands on.
    export const badPathValue = listView('Orders', 'work_order', { query: 'customer_id.tier = platinum' });
    // @ts-expect-error A date column takes a date or a phrase.
    export const badDate = listView('Orders', 'work_order', { query: 'opened_on > soon' });
    // @ts-expect-error A yes-or-no takes true or false.
    export const badFlag = listView('Orders', 'work_order', { query: 'is_open = maybe' });
    // @ts-expect-error An unquoted value with a space is a missing pair of quotes.
    export const unquoted = listView('Orders', 'work_order', { query: 'reference = big order' });
    // @ts-expect-error Every sort key is read, not only the first.
    export const badSort = listView('Orders', 'work_order', { sort: 'id desc, nope' });
    // @ts-expect-error A named sort's keys too.
    export const badNamedSort = listView('Orders', 'work_order', { sort: [{ label: 'A', sort: 'id' }, { label: 'B', sort: 'nope' }] });
    // @ts-expect-error A tab's query is read against the view's table.
    export const badTab = listView('Orders', 'work_order', { tabs: [{ label: 'T', query: 'status = shut' }] });
    // @ts-expect-error A query holds conditions only; the order is sort.
    export const sortInQuery = listView('Orders', 'work_order', { query: 'status = open sort id' });
    // @ts-expect-error A measure's column is the table's.
    export const badMeasure = metric('Sum', 'work_order', { measure: 'sum nope' });
    // @ts-expect-error A group-by's column is the table's.
    export const badBy = chart('Opened', 'work_order', 'month opend_on');
    // @ts-expect-error A period buckets a date only.
    export const badBucket = chart('Opened', 'work_order', 'month status');
    // @ts-expect-error A page section's query is read against its from.
    export const badRelated = related('Tasks', 'task', 'order_id', { query: 'done = sometimes' });
    // @ts-expect-error A rollup's query too.
    export const badRollup = sum('task', 'id', { query: 'subjct = x' });
    // @ts-expect-error A command's when is read against its target.
    export const badWhen = defineCommand({ source: 'main', target: 'work_order', when: 'status = shut', handle() {} });
    // @ts-expect-error A picker's query is read against the resource it picks from.
    export const badPicker = field.reference('task', { by: 'id', labelColumn: 'subject', query: 'done = false sort nope' });
  `;
  assert.equal(probe(source), '');

  /* The message names what is wrong: the column, or the value and the column's values. */
  const messages = probe(`import { listView } from '@mistriwork/mistri/app';
    ${QUERY_SCHEMA}
    export const a = listView('Orders', 'work_order', { query: 'stauts = open' });
    export const b = listView('Orders', 'work_order', { query: 'status = opne' });
    export const c = listView('Orders', 'work_order', { query: 'reference = big order' });
  `);
  assert.match(messages, /`stauts` is not a column of work_order/);
  assert.match(messages, /opne is not a value of status: open, closed/);
  assert.match(messages, /The value big order has a space, so quote it: reference = \\"big order\\"/);
});

/* Every other string a condition, a measure or a column is written in is read against the table its place names,
   in the register `mistri check` writes, computed columns among its names: a metric's compare and target, a
   rollup's column, a page section's `when` against the page's base, a custom section's reads, and a fixed
   action's, notify rule's and machine verb's `when` against the resource block `defineApp` or `defineFeature`
   keys them under. Each fails for a wrong name and passes for a right one, a computed one among them. */
test('the strings whose table is their place are read too, against a generated register with computed columns', () => {
  const column = (name: string, type: string, extra: object = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
  const catalog = {
    label: 'work',
    dialect: 'sqlite',
    readAt: '2026-10-05T00:00:00Z',
    tables: [
      {
        id: 'work_order',
        name: 'work_order',
        schema: '',
        columns: [
          column('id', 'integer', { primaryKey: true, nullable: false }),
          column('status', 'text', { allowed: ['open', 'closed'] }),
          column('opened_on', 'date'),
          column('due_on', 'date'),
          column('reference', 'text'),
        ],
      },
      {
        id: 'task',
        name: 'task',
        schema: '',
        columns: [
          column('id', 'integer', { primaryKey: true, nullable: false }),
          column('order_id', 'integer'),
          column('subject', 'text'),
          column('estimate', 'integer'),
          column('spent', 'integer'),
          column('done', 'boolean'),
        ],
      },
    ],
    foreignKeys: [{ name: 'task_order', from: { table: 'task', columns: ['order_id'] }, to: { table: 'work_order', columns: ['id'] } }],
  } as unknown as DatabaseSchema;
  const app = parseAppConfig(
    {
      name: 'Work',
      resources: {
        work_order: {
          computed: { is_late: { type: 'boolean', value: 'due_on < today' }, age: { type: 'number', value: 'today - opened_on' } },
        },
        task: { computed: { overrun: { type: 'number', value: 'spent - estimate' } } },
      },
      views: { orders: { kind: 'list', from: 'work_order' } },
      nav: ['orders'],
      home: 'orders',
    },
    'guard fixture',
  );
  const register = typesForSchema(withRollups(app, catalog), 'Work');
  // Generation is half of it: the computed columns are named in `Columns` with their kinds.
  assert.match(register, /work_order: \{ [^}]*is_late: 'boolean'; age: 'number' \}/);
  assert.match(register, /task: \{ [^}]*overrun: 'number' \}/);
  const check = (source: string) => {
    const schema = new URL('./.app-dsl-guard-schema.ts', import.meta.url).pathname;
    const filename = new URL('./.app-dsl-guard.ts', import.meta.url).pathname;
    return typecheck(filename, {
      files: { [schema]: register, [filename]: `import type {} from './.app-dsl-guard-schema.ts';\n${source}` },
      options: { allowImportingTsExtensions: true },
    });
  };
  const source = `import { action, component, custom, defineApp, defineFeature, fields, listView, max, metric, page, sum } from '@mistriwork/mistri/app';
    export const tile = component('tile', { module: './tile.tsx' });

    // What reads passes, computed columns among the names.
    export const good = [
      metric('Late', 'work_order', { query: 'is_late = true', measure: 'sum age as days', compare: 'previous period',
        target: { from: 'task', measure: 'sum overrun', query: 'done = false' } }),
      metric('Open', 'work_order', { compare: 'is_late = true' }),
      metric('Over', 'task', { whose: 'order_id', measure: 'sum order_id.age' }),
      // Two operators: each term ends at the next one.
      metric('Share', 'task', { measure: 'sum overrun / sum estimate * 100 as share', format: 'percent' }),
      sum('task', 'overrun'), max('task', 'estimate', { query: 'overrun > 2' }),
      page('work_order', [fields(['reference'], { when: 'is_late = true and status = open' })]),
      custom('Tile', tile, { rows: { open: { from: 'task', query: 'overrun > 0', sort: 'overrun desc', show: ['subject'] } } }),
    ];
    export const feature = defineFeature({ id: 'f', resources: { task: {
      actions: { finish: action('Finish', { set: { done: true }, when: 'overrun > 0 and done = false' }) },
      notify: [{ on: 'insert', to: 'subject', title: 'New task', when: 'overrun > 1' }] } } });
    export const app = defineApp({ name: 'x', views: { v: listView('V', 'task') }, nav: ['v'], home: 'v', features: [feature], resources: { work_order: {
      actions: { close: action('Close', { set: { status: 'closed' }, when: 'status = open and is_late = true' }) },
      notify: [{ on: 'update', to: 'reference', title: 'Late', when: 'age > 3' }],
      machine: { column: 'status', states: { open: { on: { close: { to: 'closed', when: 'is_late = true' } } }, closed: {} } } } } });

    // @ts-expect-error A compare is a query over the metric's table.
    export const badCompare = metric('Late', 'work_order', { compare: 'is_lat = true' });
    // @ts-expect-error A target's measure is read against its own table.
    export const badTarget = metric('Late', 'work_order', { target: { from: 'task', measure: 'sum overrn' } });
    // @ts-expect-error A measure's path is walked to the column it lands on.
    export const badPath = metric('Over', 'task', { whose: 'order_id', measure: 'sum order_id.ag' });
    // @ts-expect-error Every term of a computed measure is read, past the first operator too.
    export const badTerm = metric('Share', 'task', { measure: 'sum overrun / sum estimate * sum overrn' });
    // @ts-expect-error A rollup's column is one of its rows' own.
    export const badRollup = sum('task', 'overrn');
    // @ts-expect-error A sum reads numbers.
    export const textRollup = sum('task', 'subject');
    // @ts-expect-error A rollup reads a column of its own rows, not a path.
    export const pathRollup = sum('task', 'order_id.age');
    // @ts-expect-error A section's when is read against the page's base.
    export const badSection = page('work_order', [fields(['reference'], { when: 'is_lat = true' })]);
    // @ts-expect-error A custom section's rows are read against their own table.
    export const badRows = custom('Tile', tile, { rows: { open: { from: 'task', query: 'overun > 0', show: ['subject'] } } });
    export const badAction = defineFeature({ id: 'g', resources: { task: {
      // @ts-expect-error A fixed action's when, against the block's table.
      actions: { finish: action('Finish', { set: { done: true }, when: 'overrn > 0' }) } } } });
    export const badNotify = defineFeature({ id: 'h', resources: { work_order: {
      // @ts-expect-error A notify rule's when, the whole condition and not its first word.
      notify: [{ on: 'update', to: 'reference', title: 'Late', when: 'is_late = true and ag > 3' }] } } });
    export const badVerb = defineFeature({ id: 'i', resources: { work_order: {
      // @ts-expect-error A machine verb's when.
      machine: { column: 'status', states: { open: { on: { close: { to: 'closed', when: 'status = shut' } } }, closed: {} } } } } });
  `;
  assert.equal(check(source), '');

  const messages = check(`import { action, defineFeature, sum } from '@mistriwork/mistri/app';
    export const a = sum('task', 'subject');
    export const b = defineFeature({ id: 'g', resources: { task: { actions: { finish: action('Finish', { set: { done: true }, when: 'overrn > 0' }) } } } });
  `);
  assert.match(messages, /subject is text; a sum reads numbers/);
  assert.match(messages, /`overrn` is not a column of task/);
});
