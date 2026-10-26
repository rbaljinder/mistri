/**
 * What an App manifest is refused with when a key is not one its place
 * takes. A key the types declare ahead of the feature that enables it is
 * refused as not supported yet — never as a typo, and never dropped — and
 * the refusal names no internal work label. Anything else unknown gets the
 * ordinary refusal: the place, the key and the keys the place takes, with
 * the key it is a slip of, or the place that takes it, when there is one. A
 * wrong shape gets the shape's refusal. No refusal names a release or a
 * spelling to migrate from: there is one vocabulary.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LATER } from '../packages/mistri/src/shared/app.js';
import { parseTestApp } from './support/commandCatalog.js';

const WHERE = 'test/app.json';
type Fragment = Record<string, unknown>;
const LIST = { kind: 'list', from: 'task' };
const NOTE = { kind: 'note', text: 'hello' };
const PRED = { field: 'name', operator: 'eq', value: 'x' };
const REF = { id: 'go', version: 1, target: 'task', input: {} };
const FORM = {
  kind: 'form',
  label: 'Apply',
  public: true,
  command: { id: 'apply', version: 1, input: { a: { label: 'A', type: 'text', optional: true } } },
  steps: [{ id: 'one', label: 'One', fields: ['a'] }],
};
const BASE: Fragment = {
  name: 'x',
  resources: { task: { access: 'write' } },
  auth: { roles: { reader: { read: true } } },
  views: { tasks: LIST },
  home: 'tasks',
  nav: ['tasks'],
};
const parse = (app: Fragment) => parseTestApp({ ...BASE, ...app }, WHERE);
const task = (block: Fragment) => ({ resources: { task: { access: 'write', ...block } } });
const refusal = (app: Fragment): string => {
  try {
    parse(app);
  } catch (error) {
    return (error as Error).message;
  }
  assert.fail(`parsed: ${JSON.stringify(app)}`);
};
/* A work label is internal: a slice tag, a version, or a spelling to migrate from. */
const WORK_LABEL = /\bslice\b|\b[TVH]\d?\)|\b0\.[0-9]\b|spelling/;

describe('keys declared ahead of their feature are refused as not supported yet', () => {
  const AHEAD: Array<[string, Fragment, string]> = [
    ['an action enter', task({ actions: { enter: { label: 'Enter', enter: 'tenant' } } }), LATER.T8],
  ];
  for (const [what, app, reason] of AHEAD) {
    test(what, () => {
      const message = refusal(app);
      assert.ok(message.includes(reason), `${what}: ${message}`);
      assert.doesNotMatch(message, /has no "/, `${what} is refused as a typo: ${message}`);
      assert.doesNotMatch(message, WORK_LABEL, message);
    });
  }

  test('the reasons say "not supported yet" and name no work label', () => {
    for (const text of Object.values(LATER)) {
      assert.match(text, /^is not supported yet/);
      assert.doesNotMatch(text, WORK_LABEL);
    }
  });

  test('the shipped schemas describe those keys the same way', () => {
    for (const file of [
      'mistri/schema/app.schema.json',
      'mistri/schema/page.schema.json',
      'mistri/schema/app.d.ts',
      'mistri/schema/command.d.ts',
      'engine/schema/model.d.ts',
    ]) {
      const text = readFileSync(new URL(`../packages/${file}`, import.meta.url), 'utf8');
      assert.doesNotMatch(text, /\bslice [A-Z]\d*\b|\b0\.4\b|Not accepted yet/, file);
    }
  });
});

/* The tenancy vocabulary is live: each key parses, and outside the App it
   belongs to it is refused with what it needs, never as not supported yet. */
describe('the tenancy keys say what they need where they are out of place', () => {
  const PLATFORM = 'which needs the platform realm: auth.tenancy.platform';
  const OUT_OF_PLACE: Array<[string, Fragment, string]> = [
    ['auth.tenancy', { auth: { roles: { reader: { read: true } }, tenancy: { label: 'Dealer' } } }, 'it needs "rows": "tenant"'],
    ['a resource owner', task({ owner: 'tenant' }), 'it needs "auth.rows": "tenant"'],
    ['a role realm', { auth: { roles: { reader: { read: true, realm: 'tenant' } } } }, PLATFORM],
    ['a list view realm', { views: { tasks: { ...LIST, realm: 'tenant' } } }, PLATFORM],
    [
      'a dashboard view realm',
      { views: { tasks: LIST, d: { kind: 'dashboard', label: 'D', sections: [NOTE], realm: 'tenant' } }, nav: ['tasks', 'd'] },
      PLATFORM,
    ],
    ['a navGroup realm', { nav: [{ id: 'g', label: 'G', children: ['tasks'], realm: 'tenant' }] }, PLATFORM],
    ['a page realm', { pages: { task: { base: 'task', realm: 'tenant' } } }, PLATFORM],
    ['a home rule realm', { home: [{ view: 'tasks', realm: 'tenant' }] }, PLATFORM],
    ['a command reference realm', task({ actions: { go: { label: 'Go', command: { ...REF, realm: 'tenant' } } } }), PLATFORM],
    [
      'a signed-in form realm',
      {
        auth: { roles: { reader: { read: true, commands: ['apply'] } } },
        views: { tasks: LIST, log: { kind: 'form', label: 'Log', command: FORM.command, realm: 'tenant' } },
        nav: ['tasks', 'log'],
      },
      PLATFORM,
    ],
  ];
  for (const [what, app, reason] of OUT_OF_PLACE) {
    test(what, () => {
      const message = refusal(app);
      assert.ok(message.includes(reason), `${what}: ${message}`);
      assert.doesNotMatch(message, /not supported yet/, message);
      assert.doesNotMatch(message, WORK_LABEL, message);
    });
  }
});

describe('what the App cannot express yet is refused as not supported yet, with or without nav', () => {
  const ACTIONS = { start: { label: 'Start', set: { done: true } }, stop: { label: 'Stop', set: { done: false } } };
  const SERVED = [
    { id: 'start', label: 'Start', set: { done: true } },
    { id: 'stop', label: 'Stop', set: { done: false } },
  ];
  const DASH = { kind: 'dashboard', label: 'D', sections: [NOTE] };

  /* A resource's form and actions ride the resource, whichever view shows
     it, so neither needs a list view in nav, and a queue that narrows them
     narrows only itself: these parse. */
  test('a form or actions on a resource no list view in nav or the home shows are accepted, and kept on the resource', () => {
    const withNav = parse({ ...task({ actions: ACTIONS }), views: { d: DASH }, home: 'd', nav: ['d'] });
    assert.deepEqual(withNav.resources?.task.actions, SERVED);
    const withoutNav = parse({ ...task({ form: { show: ['name'] } }), views: { d: DASH }, home: 'd', nav: undefined });
    assert.deepEqual(withoutNav.resources?.task.form, { show: ['name'] });
  });

  test("a queue that narrows its resource's actions is accepted, keeping only its selector", () => {
    const app = parse({
      ...task({ actions: ACTIONS }),
      views: { q: { ...LIST, presentation: { kind: 'queue', primary: 'name' }, actions: ['start'] } },
      home: 'q',
      nav: ['q'],
    });
    assert.deepEqual(app.resources?.task.actions, SERVED);
    assert.deepEqual((app.views.q as { actions?: string[] }).actions, ['start']);
  });

  /* What the support write trail keeps rides the resource as well: it is a
     fact about the rows, not about one writer. */
  test('a resource audit says what the support write trail keeps, in either form', () => {
    assert.deepEqual(parse(task({ audit: { redact: 'values' } })).resources?.task.audit, { redact: 'values' });
    assert.deepEqual(parse(task({ audit: { redact: ['name'] } })).resources?.task.audit, { redact: ['name'] });
    assert.match(refusal(task({ audit: { redact: [] } })), /needs a "redact"/);
    assert.match(refusal(task({ audit: { redact: ['name', 'name'] } })), /names a redacted column twice/);
    assert.match(refusal(task({ audit: { redact: 'all' } })), /needs a "redact"/);
    assert.match(refusal(task({ audit: { keep: 'values' } })), /has no "keep"/);
  });
});

describe('any other unknown key gets the ordinary refusal: the place, the key, what the place takes', () => {
  const ROOT =
    'It takes: id, name, connection, sources, resources, unions, auth, views, pages, features, home, nav, ui, branding, api, track, live, flags, audiences, experiments, analytics, assistant, retention\\.';
  const UNKNOWN: Array<[string, Fragment, RegExp]> = [
    ['a root key', { writable: true }, new RegExp(`^test/app\\.json has no "writable"\\. ${ROOT}$`)],
    [
      'a root key that lives under ui',
      { breadcrumbs: false },
      new RegExp(`^test/app\\.json has no "breadcrumbs"\\. "breadcrumbs" belongs inside "ui\\.shell"\\. ${ROOT}$`),
    ],
    [
      'a source key',
      { sources: { main: { connection: 'db', tables: 'all' } } },
      /source "main" has no "tables"\. It takes: connection, default, realm, schema, resources\.$/,
    ],
    [
      'a list view key',
      { views: { tasks: { ...LIST, list: {} } } },
      /views "tasks" has no "list"\. It takes: kind, from, label, path, icon, query, .*presentation, /,
    ],
    [
      'a card key',
      { views: { tasks: { ...LIST, presentation: { kind: 'queue', title: 'name' } } } },
      /presentation \(a queue\) has no "title"\. It takes: kind, primary, lines, properties, badge, openLabel\.$/,
    ],
    [
      'a role key',
      { auth: { roles: { reader: { read: true, writable: true } } } },
      /role "reader" has no "writable"\. It takes: label, extends, read, write, create, export, commands, actions, operations, fields, realm, claims, service, flags, experiments\.$/,
    ],
    [
      'a form key',
      task({ form: { show: ['name'], visibleWhen: { name: PRED } } }),
      /"form" has no "visibleWhen"\. It takes: show, defaults, groups, when, steps, style, description, open, fields, lines, live\.$/,
    ],
    [
      'a validation rule key',
      task({ validation: [{ must: 'name is not empty', if: PRED, message: 'm' }] }),
      /resources "task", validation has no "if"\. It takes: must, when, message\.$/,
    ],
    [
      'a page key',
      { pages: { task: { base: 'task', connection: 'db' } } },
      /pages "task" \("Task"\) has no "connection"\. "connection" belongs at the App's root\. It takes: .*listTabs/,
    ],
    ['a page id', { pages: { task: { id: 'task', name: 'Task', base: 'task' } } }, /pages "task" \("Task"\) has no "id"\. It takes: /],
    [
      'a page section key',
      { pages: { task: { base: 'task', sections: [{ kind: 'list', from: 'note', whose: 'task_id', filter: 'a = 1' }] } } },
      /section 1 has no "filter"\. It takes: .*query/,
    ],
  ];
  for (const [what, app, expected] of UNKNOWN) {
    test(what, () => {
      const message = refusal(app);
      assert.match(message, expected);
      assert.doesNotMatch(message, WORK_LABEL);
    });
  }
});

describe('an unknown key is offered the key it is a slip of, or told where it belongs', () => {
  const input = (field: Fragment) =>
    task({ actions: { go: { label: 'Go', command: { ...REF, input: { a: { label: 'A', type: 'text', ...field } } } } } });
  const HINTS: Array<[string, Fragment, RegExp]> = [
    [
      'a slip of a key the place takes',
      { views: { tasks: { ...LIST, lable: 'Tasks' } } },
      /views "tasks" has no "lable"\. Did you mean "label"\? It takes: kind, from, label, /,
    ],
    /* `lines`, not `primary`: a record header names its filled verb `primary`
       too, and a key with three homes is a common word, offered none. */
    [
      "a key the view's presentation takes",
      { views: { tasks: { ...LIST, lines: ['name'] } } },
      /views "tasks" has no "lines"\. "lines" belongs inside "presentation" \(checklist, queue, board, calendar, tree\) or inside a dashboard section \(board\)\. It takes: /,
    ],
    [
      'a key another presentation takes',
      { views: { tasks: { ...LIST, presentation: { kind: 'queue', primary: 'name', date: 'due' } } } },
      /presentation \(a queue\) has no "date"\. "date" belongs inside "presentation" \(calendar\)\. It takes: kind, primary, lines, properties, badge, openLabel\.$/,
    ],
    [
      'a key a view section takes, on a note',
      { views: { tasks: LIST, d: { kind: 'dashboard', label: 'D', sections: [{ ...NOTE, tab: 'x' }] } } },
      /section 1 \(a note\) has no "tab"\. "tab" belongs inside a dashboard section \(view\) or inside a page section\. It takes: kind, area, title, text, icon, action, width, variant, eyebrow, image\.$/,
    ],
    [
      'a key ui.theme takes, in ui.shell',
      { ui: { shell: { accent: '#000' } } },
      /ui\.shell has no "accent"\. "accent" belongs inside "ui\.theme"\. It takes: menuSearch, search, /,
    ],
    [
      'a slip in ui.shell',
      { ui: { shell: { serch: false } } },
      /ui\.shell has no "serch"\. Did you mean "search"\? It takes: menuSearch, search, /,
    ],
    [
      'a slip in ui.theme',
      { ui: { theme: { acent: '#000' } } },
      /"ui\.theme" has no "acent"\. Did you mean "accent"\? It takes: preset, palette, accent, /,
    ],
    [
      'a slip in a display rule',
      task({ display: { name: { fromat: 'money' } } }),
      /has no "fromat"\. Did you mean "format"\? It takes: format, currency, /,
    ],
    [
      'a slip in a command field',
      input({ lable: 'A' }),
      /input "a" has no "lable"\. Did you mean "label"\? It takes: type, label, help, optional, /,
    ],
    [
      'an option of another field type',
      input({ integer: true }),
      /input "a" \(a text field\) has no "integer"\. It takes: type, label, help, optional, default, when, as, input, min, max, format, pattern, message, case, mask, sensitive\.$/,
    ],
  ];
  for (const [what, app, expected] of HINTS) {
    test(what, () => {
      const message = refusal(app);
      assert.match(message, expected);
      assert.doesNotMatch(message, WORK_LABEL);
    });
  }

  test('a key no place takes, or a different word a few letters off, is offered nothing', () => {
    // A page's `name` is two edits from `base`: another word, not a slip of one.
    for (const app of [
      { views: { tasks: { ...LIST, colour: 'red' } } },
      { intake: {} },
      task({ validation: [{ must: 'name is not empty', if: PRED, message: 'm' }] }),
      { pages: { task: { name: 'Task', base: 'task' } } },
    ]) {
      const message = refusal(app);
      assert.match(message, /has no "[^"]+"\. It takes: /);
      assert.doesNotMatch(message, /Did you mean|belongs/);
    }
  });
});

describe("a wrong shape gets the shape's refusal", () => {
  const SHAPES: Array<[string, Fragment, RegExp]> = [
    [
      'a resource that is a string',
      { resources: { task: 'public.task' } },
      /resources "task" is not an object\. A resource block is \{ physical\?, access\?/,
    ],
    ['pages as a list', { pages: [{ label: 'Task', base: 'task' }] }, /"pages" must be an object of pages keyed by id\./],
    [
      'home rules without a view',
      { home: [{ label: 'Open', table: 'task' }] },
      /"home", rule 1 has no "label"\. It takes: view, signedOut, roles, realm\./,
    ],
    [
      'a nav entry that is not a reference',
      { nav: [{ table: 'task', label: 'Tasks' }] },
      /nav entry 1 is not a view id, a \{ label, to \} or a navGroup\./,
    ],
    [
      'a show entry object',
      { views: { tasks: { ...LIST, show: [{ column: 'name', label: 'Name' }] } } },
      /"show" entry 1 is not a column name or a label path\./,
    ],
    [
      'an action object on a view',
      {
        ...task({ actions: { start: { label: 'Start', set: { done: true } } } }),
        views: {
          tasks: { ...LIST, presentation: { kind: 'queue', primary: 'name' }, actions: { start: { label: 'Start', set: { done: true } } } },
        },
      },
      /views "tasks" has "actions" that are not a list of action ids\./,
    ],
    [
      'a card show on a dashboard board',
      {
        views: {
          tasks: LIST,
          d: { kind: 'dashboard', label: 'D', sections: [{ kind: 'board', from: 'task', by: 'status', show: ['name'] }] },
        },
      },
      /section 1 has "show", which only a rows section carries\./,
    ],
    [
      'an unknown operations word',
      { auth: { roles: { reader: { read: true, operations: ['audit'] } } } },
      /"operations" must be a nonempty list from "readiness", "bundle", "workflows", "jobs", "deliveries", "stores", "analytics" and "support"\./,
    ],
    [
      'open beside a split',
      { views: { tasks: { ...LIST, open: 'drawer', split: { detail: ['name'] } } } },
      /views "tasks" has "open" and a split presentation, which opens its rows in its own detail pane\. Remove "open"\./,
    ],
    /* What only a grid reads is refused beside a presentation that draws none, rather than read by nothing. */
    [
      'density beside a queue',
      { views: { tasks: { ...LIST, density: 'compact', presentation: { kind: 'queue', primary: 'name' } } } },
      /views "tasks" has "density" and a queue presentation; a row height belongs to a grid\./,
    ],
    [
      'sizing beside cards',
      { views: { tasks: { ...LIST, sizing: 'scroll', presentation: { kind: 'cards', primary: 'name' } } } },
      /views "tasks" has "sizing" and a cards presentation; column sizing belongs to a grid\./,
    ],
    [
      'a width on a dashboard board',
      {
        views: {
          tasks: LIST,
          d: { kind: 'dashboard', label: 'D', sections: [{ kind: 'board', from: 'task', by: 'status', width: 'half' }] },
        },
      },
      /section 1 has "width", which only a metric or /,
    ],
    [
      'a width on an embedded board',
      {
        views: {
          tasks: LIST,
          b: { ...LIST, board: { by: 'status', primary: 'name' } },
          d: { kind: 'dashboard', label: 'D', sections: [{ kind: 'view', view: 'b', width: 'half' }] },
        },
      },
      /section 1 embeds "b", a board, which a dashboard draws full width\. Remove "width"\./,
    ],
    /* A view's default sort is one reading of the list, beside nothing that already is one. */
    [
      'sort beside order',
      { views: { tasks: { ...LIST, sort: 'name', order: 'position' } } },
      /views "tasks" has "sort" and "order": a hand order is the list's own reading already, kept in "position"\. Keep one\./,
    ],
    [
      'sort beside a calendar',
      { views: { tasks: { ...LIST, sort: 'name', presentation: { kind: 'calendar', date: 'due', primary: 'name' } } } },
      /views "tasks" has "sort" and a calendar presentation, which orders its cards itself\./,
    ],
    [
      'a sort clause in the query',
      { views: { tasks: { ...LIST, query: 'done = false sort due' } } },
      /views "tasks" has a "query" with a sort clause \("sort due"\)\. A query holds conditions only: say it in "sort", which a tab takes too\./,
    ],
    [
      'a sort not written like the query bar',
      { views: { tasks: { ...LIST, sort: 'name; drop' } } },
      /views "tasks" has a "sort" that is not written like the query bar/,
    ],
    [
      'a dashboard table no section inherits',
      { views: { tasks: LIST, d: { kind: 'dashboard', label: 'D', from: 'task', sections: [{ kind: 'metric', from: 'task' }, NOTE] } } },
      /views "d" has a "from" that no section inherits: every section names its own "from"\. Remove it\./,
    ],
  ];
  for (const [what, app, expected] of SHAPES) {
    test(what, () => {
      const message = refusal(app);
      assert.match(message, expected);
      assert.doesNotMatch(message, WORK_LABEL);
    });
  }
});
