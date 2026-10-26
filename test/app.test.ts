/**
 * The app layer: a directory of config that curates the UI.
 *
 * Three seams, tested in the order a mistake would meet them: the manifest
 * grammar (parseAppConfig refuses what it cannot honour, with the file
 * named), the loader (an app's pages are config pages, scoped with the app,
 * and never allowed to shadow the config file's), and the one endpoint the
 * client reads (`/api/app`, whose `null` is an answer). The endpoint runs
 * over a real socket like http.test.ts, because a payload only proven
 * against a hand-built request is a payload nobody has proved is wired in.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseAppConfig,
  previousPeriodQuery,
  resolveDisplay,
  resolveResources,
  resolveViews,
  viewOrder,
  withoutWindowPhrase,
  withRollups,
  zonedNow,
  appAllowsWrite,
  appCeilingWarnings,
  resolveAppAccess,
  writeScopeRefusal,
  type AppDashboardView,
  type AppDef,
  type AppListView,
  type ResolvedListView,
} from '../packages/mistri/src/shared/app.js';
import { servedApp } from '../packages/mistri/src/shared/appPayload.js';
import { appPayload, loadApp, mergeAppPages, type LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { createApp } from './support/createApp.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { makeDemoDatabase, seedDemoDatabase } from './make-demo-db.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import type { PageDef } from '../packages/engine/src/shared/page.js';

const WHERE = 'test/app.json';

/** Just enough schema for the nav to resolve against. */
const col = (name: string) => ({ name, type: 'text', nullable: true, primaryKey: false });

const SCHEMA: DatabaseSchema = {
  label: 'demo',
  dialect: 'sqlite',
  readAt: '',
  tables: [
    {
      name: 'work_order',
      schema: '',
      id: 'work_order',
      columns: [col('reference'), col('status'), col('customer_id'), { ...col('opened_on'), type: 'date' }],
      isView: false,
    },
    { name: 'customer', schema: '', id: 'customer', columns: [{ ...col('id'), primaryKey: true }, col('name')], isView: false },
  ],
  foreignKeys: [
    { name: 'fk_wo_customer', from: { table: 'work_order', columns: ['customer_id'] }, to: { table: 'customer', columns: ['id'] } },
  ],
};

/** A view shows the App's declared resources: a block for each table a one-view App names, beside the blocks a test declares. */
const declaring = (tables: unknown[], resources: unknown) =>
  resources !== undefined && (typeof resources !== 'object' || resources === null || Array.isArray(resources))
    ? resources
    : {
        ...Object.fromEntries(
          tables.filter((table): table is string => typeof table === 'string' && table.trim() !== '').map((table) => [table.trim(), {}]),
        ),
        ...(resources as object | undefined),
      };
const tablesOf = (sections: unknown) =>
  (Array.isArray(sections) ? sections : []).map((section) =>
    section && typeof section === 'object' ? (section as Record<string, unknown>).from : undefined,
  );
/** A one-view App with the view in nav: most of this file judges one list or one dashboard. */
const listApp = (view: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  parseAppConfig(
    {
      name: 'x',
      views: { v: { kind: 'list', ...view } },
      home: 'v',
      nav: ['v'],
      ...extra,
      resources: declaring([view.from], extra.resources),
    },
    WHERE,
  );
const dashApp = (view: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  parseAppConfig(
    {
      name: 'x',
      views: { d: { kind: 'dashboard', label: 'B', ...view } },
      home: 'd',
      nav: ['d'],
      ...extra,
      resources: declaring([view.from, ...tablesOf(view.sections)], extra.resources),
    },
    WHERE,
  );

/** The App's rooms, and the same rooms resolved against a catalog, in the menu's order. */
const roomsOf = (app: AppDef) => viewOrder(app).map((key) => app.views[key]);
const resolvedViews = (app: AppDef, schema: DatabaseSchema) => {
  const views = resolveViews(app, withRollups(app, schema));
  return viewOrder({ views, nav: app.nav }).map((key) => views[key]);
};

/** Every problem the App's resources have on a catalog: their actions and New forms, judged once, on the resource. */
const resourceProblems = (app: AppDef, schema: DatabaseSchema = SCHEMA) => resolveResources(app, schema).problems.join('\n');

/** Every App names its home; a test about something else gets this one list, named as the home. */
const START = { resources: { work_order: {} }, views: { start: { kind: 'list', from: 'work_order' } }, home: 'start' };
const withStart = (manifest: unknown) =>
  manifest && typeof manifest === 'object' && !('home' in manifest) && !('views' in manifest)
    ? { ...START, ...manifest, resources: { ...START.resources, ...(manifest as { resources?: object }).resources } }
    : manifest;

describe('parseAppConfig', () => {
  test('the minimal manifest: a name, and a home among its views', () => {
    assert.throws(() => parseAppConfig({ name: 'Field Ops' }, WHERE), /the App "Field Ops" has no "home"/);
    const app = parseAppConfig(
      { name: 'Field Ops', resources: { work_order: {} }, views: { orders: { kind: 'list', from: 'work_order' } }, home: 'orders' },
      WHERE,
    );
    assert.equal(app.name, 'Field Ops');
    assert.equal(app.id, 'field-ops', 'an unstated id is a slug of the name: the address the docs give');
    assert.deepEqual([Object.keys(app.views), app.nav], [['orders'], []], 'no nav: the home is the one room, and no menu lists it');
    assert.equal(app.connection, undefined);
  });

  test('a given id wins over the slug', () => {
    assert.equal(parseAppConfig({ ...START, name: 'Field Ops', id: 'fieldops' }, WHERE).id, 'fieldops');
  });

  test('no name is refused with the file named', () => {
    assert.throws(() => parseAppConfig({ ...START }, WHERE), /test\/app\.json has no "name"/);
    assert.throws(() => parseAppConfig({ ...START, name: '   ' }, WHERE), /has no "name"/);
  });

  test('a manifest that is not an object is refused', () => {
    assert.throws(() => parseAppConfig([], WHERE), /is not an object/);
    assert.throws(() => parseAppConfig('x', WHERE), /is not an object/);
  });

  test('a connection that is not a string is refused', () => {
    assert.throws(() => parseAppConfig({ ...START, name: 'x', connection: 1 }, WHERE), /"connection"/);
  });

  test('resource mappings preserve logical names and validate physical targets', () => {
    assert.deepEqual(
      parseAppConfig({ ...START, name: 'x', resources: { ...START.resources, incident: { physical: ' public.incident ' } } }, WHERE)
        .resources,
      { work_order: {}, incident: { physical: 'public.incident' } },
    );
    for (const resources of [
      null,
      [],
      'incident',
      { 'public.incident': { physical: 'public.incident' } },
      { incident: { physical: '' } },
      { incident: { physical: 1 } },
    ]) {
      assert.throws(() => parseAppConfig({ ...START, name: 'x', resources }, WHERE), /resources/);
    }
    assert.throws(
      () => parseAppConfig({ ...START, name: 'x', resources: { incident: 'public.incident' } }, WHERE),
      /resources "incident" is not an object\. A resource block is/,
    );
  });

  test('list pages: show and tabs are parsed, trimmed, and refused by shape', () => {
    const app = listApp(
      {
        from: 'work_order',
        show: [' reference ', 'customer_id'],
        tabs: [' open ', { label: 'All' }],
      },
      { resources: { work_order: { labels: { customer_id: ' Customer ' }, segments: { open: 'status = open' } } } },
    );
    const entry = roomsOf(app)[0] as AppListView;
    assert.deepEqual(entry.show, ['reference', 'customer_id']);
    /* The caption is the resource's, trimmed, wherever the column shows. */
    assert.deepEqual(app.resources?.work_order.labels, { customer_id: 'Customer' });
    // A segment tab reads as its name, whose conditions are the resource's (appSegments.ts).
    assert.deepEqual(entry.tabs, [
      { label: 'Open', query: 'open', segment: 'open', slug: 'open' },
      { label: 'All', query: undefined },
    ]);

    // The pre-rename spelling is refused, with the word that replaced it on offer.
    assert.throws(
      () => listApp({ from: 'a', columns: ['reference'] }),
      /has no "columns"\. "columns" belongs inside a page section \(fields\)\. It takes: .*show/,
    );
    assert.throws(() => listApp({ from: 'a', show: 'reference' }), /"show" that is not a list/);
    assert.throws(() => listApp({ from: 'a', show: ['reference', 7] }), /"show" entry 2 is not a column name/);
    // A caption is the resource's, so a show entry is a string, never an object.
    assert.throws(() => listApp({ from: 'a', show: [{ label: 'X' }] }), /"show" entry 1 is not a column name or a label path/);
    assert.throws(() => listApp({ from: 'a', show: [{ column: 'x' }] }), /"show" entry 1 is not a column name or a label path/);
    assert.deepEqual((listApp({ from: 'a', filters: [' status ', 'is_urgent'] }).views.v as AppListView).filters, ['status', 'is_urgent']);
    // An empty list is a decision — no quick filters — and parses as itself.
    assert.deepEqual((listApp({ from: 'a', filters: [] }).views.v as AppListView).filters, []);
    assert.throws(() => listApp({ from: 'a', filters: 'status' }), /"filters" that are not a list/);
    assert.throws(() => listApp({ from: 'a', tabs: 'open' }), /"tabs" that are not an array/);
    assert.throws(() => listApp({ from: 'a', tabs: [{ sort: 'x' }] }), /views "v", tab 1 has no "label"/);
    assert.throws(() => listApp({ from: 'a', tabs: [{ label: 'Open', query: 4 }] }), /tab 1 writes its own "query"/);
    assert.throws(
      () => listApp({ from: 'a', tabs: [{ label: 'Open', query: 'x = 1' }] }),
      /tab 1 writes its own "query"\. A tab names a segment/,
    );
  });

  test('split list/detail presentation is bounded, normalized, and data-only', () => {
    /* The split is a key of the list view — `split: {}` — beside
       `presentation` (the checklist, the queue, the calendar, cards) and `board`, so a view says how its
       rows are drawn in one place. The list beside the record is the view's
       own; the split says the detail's fields, in the view's grammar, and the
       list's page size, and the resource's caption rides through beside the paths. */
    const app = listApp(
      {
        from: 'work_order',
        show: ['reference', 'status'],
        query: 'status = open',
        filterBar: 'none',
        split: { limit: 25, detail: [' reference ', 'status'] },
      },
      { resources: { work_order: { labels: { status: ' State ' } } } },
    );
    const entry = roomsOf(app)[0] as AppListView;
    assert.deepEqual(entry.presentation, { kind: 'split', limit: 25, detail: ['reference', 'status'] });
    assert.deepEqual([entry.show, entry.query, entry.filterBar], [['reference', 'status'], 'status = open', 'none']);
    assert.deepEqual(app.resources?.work_order.labels, { status: 'State' });
    // A split that says nothing draws the view's list beside the record's own fields.
    assert.deepEqual((roomsOf(listApp({ from: 'work_order', split: {} }))[0] as AppListView).presentation, { kind: 'split' });
    for (const split of [
      { detail: 'record' },
      { detail: { show: ['name'] } },
      { limit: 0 },
      { limit: 201 },
      { detail: Array.from({ length: 65 }, () => 'name') },
      { detail: ['name', 'name'] },
    ]) {
      assert.throws(() => listApp({ from: 'work_order', split }), /split/);
    }
    assert.throws(
      () => listApp({ from: 'work_order', split: { list: { show: ['reference'] } } }),
      /"split" has no "list"\. It takes: detail, limit, row\./,
    );
    /* A split is the view's own key: the raw presentation of that kind is refused, and so is a second way to draw. */
    assert.throws(() => listApp({ from: 'work_order', presentation: { kind: 'split' } }), /A split is a key of the list view/);
    assert.throws(
      () => listApp({ from: 'work_order', split: {}, board: { by: 'status', primary: 'reference' } }),
      /"board" and "split"\. A list draws its rows one way/,
    );
  });

  test('a theme is a whitelist of tokens, refused key by key', () => {
    const app = parseAppConfig({ ...START, name: 'x', ui: { theme: { accent: ' #4f46e5 ' } } }, WHERE);
    assert.deepEqual(app.ui.theme, { accent: '#4f46e5' });
    assert.throws(() => parseAppConfig({ ...START, name: 'x', ui: { theme: 'indigo' } }, WHERE), /"ui\.theme" is not an object/);
    assert.throws(
      () => parseAppConfig({ ...START, name: 'x', ui: { theme: { background: 'red' } } }, WHERE),
      /"ui\.theme" has no "background"\. It takes: preset, palette, accent, radius, font/,
    );
    assert.throws(
      () => parseAppConfig({ ...START, name: 'x', ui: { theme: { accent: 7 } } }, WHERE),
      /"ui\.theme\.accent" is not a colour/,
    );
    /* A colour for each ground, worn as written: a brand whose dark accent is its own. */
    assert.deepEqual(
      parseAppConfig({ ...START, name: 'x', ui: { theme: { accent: { light: '#1f5e3b', dark: '#86d0a0' } } } }, WHERE).ui.theme,
      { accent: { light: '#1f5e3b', dark: '#86d0a0' } },
    );
    assert.throws(
      () => parseAppConfig({ ...START, name: 'x', ui: { theme: { accent: { light: '#1f5e3b' } } } }, WHERE),
      /"ui\.theme\.accent" is \{ light, dark \}, a colour for each ground; its "dark" is not a colour/,
    );
    /* The two non-colour tokens name what they want instead — the error is
       the documentation for whichever key someone reached for. */
    assert.throws(
      () => parseAppConfig({ ...START, name: 'x', ui: { theme: { radius: 7 } } }, WHERE),
      /"ui\.theme\.radius" is not a CSS length like "10px"/,
    );
    assert.throws(
      () => parseAppConfig({ ...START, name: 'x', ui: { theme: { font: false } } }, WHERE),
      /"ui\.theme\.font" is not a CSS font stack/,
    );
    assert.deepEqual(parseAppConfig({ ...START, name: 'x', ui: { theme: { radius: '8px', font: 'Inter, sans-serif' } } }, WHERE).ui.theme, {
      radius: '8px',
      font: 'Inter, sans-serif',
    });
  });

  test('nav entries are checked one by one, and named by position', () => {
    assert.throws(() => parseAppConfig({ name: 'x', nav: 'tables' }, WHERE), /"nav" must be an array/);
    assert.throws(() => parseAppConfig({ name: 'x', nav: [{}] }, WHERE), /nav entry 1 is not a view id, a \{ label, to \} or a navGroup\./);
    const views = { a: { kind: 'list', from: 'a' }, b: { kind: 'list', from: 'b' } };
    const resources = { a: {}, b: {} };
    assert.throws(() => parseAppConfig({ name: 'x', resources, views, nav: ['a', { to: 'b', label: 7 }] }, WHERE), /nav entry 2/);
    assert.throws(
      () => parseAppConfig({ name: 'x', resources, views, nav: [{ id: 'g', label: '  ', children: ['a', 'b'] }] }, WHERE),
      /nav entry 1 needs a non-empty group "label"/,
    );
  });
});

describe('nav modules', () => {
  test('an entry with a query is a destination of its own, judged composed with its tabs', () => {
    const app = parseAppConfig(
      {
        name: 'x',
        resources: { work_order: { segments: { for_acme: { query: 'customer_id = 1', label: 'For Acme' } } } },
        views: {
          orders: { kind: 'list', label: 'Work orders', from: 'work_order' },
          open: {
            kind: 'list',
            label: 'Open orders',
            from: 'work_order',
            query: 'status = open',
            tabs: [{ label: 'All' }, 'for_acme'],
          },
        },
        home: 'orders',
        nav: ['orders', 'open'],
      },
      WHERE,
    );
    const [plain, moduleEntry] = resolvedViews(app, SCHEMA) as ResolvedListView[];
    assert.equal(plain.error, undefined);
    assert.equal(moduleEntry.error, undefined);
    assert.equal(moduleEntry.query, 'status = open');

    /* A bad standing query is the entry's startup error, not a dead menu row. */
    const bad = listApp({ label: 'Open', from: 'work_order', query: 'staus = open' });
    assert.match((resolvedViews(bad, SCHEMA)[0] as { error?: string }).error ?? '', /This view's query:/);

    /* And a tab that cannot compose with it is named too. */
    const badTab = listApp(
      { label: 'Open', from: 'work_order', query: 'status = open', tabs: ['ghost'] },
      { resources: { work_order: { segments: { ghost: 'ghost = 1' } } } },
    );
    assert.match((resolvedViews(badTab, SCHEMA)[0] as { error?: string }).error ?? '', /Tab "Ghost"/);

    assert.throws(() => listApp({ from: 't', query: '  ' }), /"query" that is not a non-empty string/);
  });

  test("how rows open is the entry's word, and only the words on offer", () => {
    const app = listApp({ from: 'work_order', open: 'drawer' });
    const entry = resolvedViews(app, SCHEMA)[0] as ResolvedListView;
    assert.equal(entry.open, 'drawer');
    assert.equal((resolvedViews(listApp({ from: 'work_order', open: 'modal' }), SCHEMA)[0] as ResolvedListView).open, 'modal');
    assert.throws(() => listApp({ from: 't', open: 'sheet' }), /"open" of "sheet"\. Use "page", "drawer" or "modal"/);
    // The New form's word is the list's: the one it replaced is refused by name.
    assert.throws(() => listApp({ from: 't', open: 'peek' }), /"open" of "peek", which is now "drawer"/);
  });
});

describe('dashboards in the nav', () => {
  test("an entry with sections and no table is a screen of the app's own", () => {
    const app = parseAppConfig(
      {
        name: 'x',
        resources: { work_order: {} },
        views: {
          'ops-board': {
            kind: 'dashboard',
            label: 'Ops board',
            sections: [
              { kind: 'metric', from: 'work_order', query: 'status = open', title: 'Open' },
              { kind: 'breakdown', from: 'work_order', by: 'status' },
              { kind: 'rows', from: 'work_order', show: ['reference', 'customer_id.name'], sort: 'reference', limit: 5 },
            ],
          },
        },
        home: 'ops-board',
        nav: [{ id: 'ops', label: 'Ops', children: ['ops-board'] }],
      },
      WHERE,
    );
    const dash = roomsOf(app)[0] as AppDashboardView;
    assert.deepEqual(Object.keys(app.views), ['ops-board'], 'a dashboard is keyed by its view key');
    assert.equal(dash.sections.length, 3);

    assert.throws(() => dashApp({ label: undefined, sections: [{ kind: 'metric', from: 't' }] }), /dashboard and has no "label"/);
    assert.throws(() => dashApp({ label: 'D', sections: [{ kind: 'pie', table: 't' }] }), /unknown kind "pie"/);
    assert.throws(() => dashApp({ label: 'D', sections: [{ kind: 'breakdown', from: 't' }] }), /has no "by"/);
    assert.throws(
      () => dashApp({ label: 'D', sections: [{ kind: 'rows', from: 't', compare: 'x' }] }),
      /"compare", which only a metric carries/,
    );
  });

  test('a chart is a breakdown drawn differently, and says so when it cannot be', () => {
    const app = dashApp({
      label: 'Board',
      sections: [
        { kind: 'chart', from: 'work_order', by: 'month opened_on' },
        { kind: 'chart', from: 'work_order', by: 'status', shape: 'donut' },
      ],
    });
    const dash = roomsOf(app)[0] as AppDashboardView;
    assert.equal(dash.sections[1].shape, 'donut');
    const resolved = resolvedViews(app, SCHEMA)[0] as AppDashboardView;
    assert.equal(resolved.error, undefined);

    assert.throws(() => dashApp({ label: 'D', sections: [{ kind: 'chart', from: 't' }] }), /has no "by"/);
    assert.throws(
      () => dashApp({ label: 'D', sections: [{ kind: 'chart', from: 't', by: 'x', shape: 'pie' }] }),
      /"shape" of "pie"\. Use "line", "bar", "donut", "stacked", "scatter", "heatmap", "waterfall" or "treemap"/,
    );
    /* The further shapes: a scatter places a dot by two measures, a heat map crosses two keys, the rest group by one. */
    const shapes = roomsOf(
      dashApp({
        label: 'F',
        sections: [
          { kind: 'chart', from: 'work_order', by: 'site', shape: 'scatter', x: 'count', measure: 'sum cost' },
          { kind: 'chart', from: 'work_order', by: 'weekday opened_on, hour opened_on', shape: 'heatmap' },
          { kind: 'chart', from: 'work_order', by: 'month opened_on', shape: 'waterfall', measure: 'sum cost', target: 900 },
          { kind: 'chart', from: 'work_order', by: 'site', shape: 'treemap' },
        ],
      }),
    )[0] as AppDashboardView;
    assert.deepEqual(
      shapes.sections.map((section) => [section.shape, section.x]),
      [
        ['scatter', 'count'],
        ['heatmap', undefined],
        ['waterfall', undefined],
        ['treemap', undefined],
      ],
    );
    const chart = (extra: Record<string, unknown>) => () =>
      dashApp({ label: 'D', sections: [{ kind: 'chart', from: 't', by: 'x', ...extra }] });
    assert.throws(chart({ shape: 'scatter' }), /is a scatter and needs an "x"/);
    assert.throws(chart({ x: 'count' }), /has an "x", which places a scatter's dots across/);
    assert.throws(chart({ shape: 'heatmap' }), /is a heat map and needs a two-key "by"/);
    /* A funnel is its own section now: a chart no longer draws one, and says where it went. */
    assert.throws(chart({ shape: 'funnel' }), /shape: 'funnel', which is now funnel\(title, from, stages\)/);
    assert.throws(chart({ shape: 'treemap', target: 3 }), /is a treemap, which has no scale to rule a "target" on/);
    /* Stacked bars cross two keys, as a matrix does; a target is a number, and a donut has no scale for one. */
    const stacked = roomsOf(
      dashApp({
        label: 'S',
        sections: [
          { kind: 'chart', from: 'work_order', by: 'status, month opened_on', shape: 'stacked', target: 40 },
          { kind: 'metric', from: 'work_order', target: 12 },
        ],
      }),
    )[0] as AppDashboardView;
    assert.deepEqual([stacked.sections[0].shape, stacked.sections[0].target, stacked.sections[1].target], ['stacked', 40, 12]);
    assert.throws(
      () => dashApp({ label: 'D', sections: [{ kind: 'chart', from: 't', by: 'status', shape: 'stacked' }] }),
      /is a stacked chart and needs a two-key "by"/,
    );
    assert.throws(
      () => dashApp({ label: 'D', sections: [{ kind: 'chart', from: 't', by: 'x', target: '40' }] }),
      /"target" that is not a number/,
    );
    assert.throws(
      () => dashApp({ label: 'D', sections: [{ kind: 'chart', from: 't', by: 'x', shape: 'donut', target: 4 }] }),
      /is a donut, which has no scale to draw a "target" on/,
    );
    assert.throws(() => dashApp({ label: 'D', sections: [{ kind: 'breakdown', from: 't', by: 'x', target: 4 }] }), /"target"/);
    assert.throws(
      () => dashApp({ label: 'D', sections: [{ kind: 'rows', from: 't', shape: 'line' }] }),
      /"shape", which only a breakdown or chart carries/,
    );

    /* The bucket is judged by the real grammar: a month of a text column
       is refused at startup with the reason, not at render with a spinner. */
    const badBucket = dashApp({ label: 'B', sections: [{ kind: 'chart', from: 'work_order', by: 'month status' }] });
    assert.ok((resolvedViews(badBucket, SCHEMA)[0] as { error?: string }).error, 'a month of a text column carries a reason');
  });

  test('a note is the author speaking: text required, and nothing to resolve', () => {
    const app = dashApp({
      label: 'Board',
      sections: [
        { kind: 'note', title: 'How to read this', text: 'Top row is today.\n\nQuestions → #ops.' },
        { kind: 'breakdown', from: 'work_order', by: 'status' },
      ],
    });
    const dash = roomsOf(app)[0] as AppDashboardView;
    assert.equal(dash.sections[0].text, 'Top row is today.\n\nQuestions → #ops.');
    const resolved = resolvedViews(app, SCHEMA)[0] as AppDashboardView;
    assert.equal(resolved.error, undefined);

    assert.throws(() => dashApp({ label: 'B', sections: [{ kind: 'note' }] }), /is a note and has no "text"/);
    assert.throws(
      () => dashApp({ label: 'B', sections: [{ kind: 'metric', from: 't', text: 'hi' }] }),
      /"text", which only a note carries/,
    );
  });

  test('spark and threshold tones are judged at the edges they can fail at', () => {
    assert.throws(
      () => dashApp({ label: 'B', sections: [{ kind: 'rows', from: 't', spark: true }] }),
      /"spark", which only a metric carries/,
    );
    const noClock = dashApp({ label: 'B', sections: [{ kind: 'metric', from: 'work_order', spark: true }] });
    assert.match((resolvedViews(noClock, SCHEMA)[0] as { error?: string }).error ?? '', /"spark" needs "over"/);

    const app = parseAppConfig(
      { ...START, name: 'x', resources: { work_order: { display: { status: { tone: { '>= 5': 'bad', open: 'info' } } } } } },
      WHERE,
    );
    assert.equal(app.resources?.work_order.display?.status.tone?.['>= 5'], 'bad');
    assert.throws(
      () => parseAppConfig({ ...START, name: 'x', resources: { t: { display: { c: { tone: { '>= high': 'bad' } } } } } }, WHERE),
      /tone key ">= high" that is not a comparison/,
    );
  });

  test('pick-filters: a column that reaches no section is refused at startup', () => {
    const good = dashApp({ label: 'B', filters: ['status'], sections: [{ kind: 'breakdown', from: 'work_order', by: 'status' }] });
    const resolved = resolvedViews(good, SCHEMA)[0] as AppDashboardView;
    assert.equal(resolved.error, undefined);
    assert.deepEqual(resolved.filters, ['status']);

    const bad = dashApp({ label: 'B', filters: ['ghost_col'], sections: [{ kind: 'breakdown', from: 'work_order', by: 'status' }] });
    assert.match((resolvedViews(bad, SCHEMA)[0] as { error?: string }).error ?? '', /Filter "ghost_col"/);

    assert.throws(
      () => dashApp({ label: 'B', filters: 'status', sections: [{ kind: 'metric', from: 't' }] }),
      /"filters" that are not a list of column names/,
    );
  });

  test('a matrix crosses exactly two keys, and says so by count', () => {
    const good = dashApp({ label: 'B', sections: [{ kind: 'matrix', from: 'work_order', by: 'status, month opened_on' }] });
    assert.equal((resolvedViews(good, SCHEMA)[0] as { error?: string }).error, undefined);

    assert.throws(() => dashApp({ label: 'B', sections: [{ kind: 'matrix', from: 't', by: 'status' }] }), /needs a two-key "by"/);
    const three = dashApp({ label: 'B', sections: [{ kind: 'matrix', from: 'work_order', by: 'status, customer_id, month opened_on' }] });
    assert.match((resolvedViews(three, SCHEMA)[0] as { error?: string }).error ?? '', /exactly two keys; .* has 3/);
  });

  test('the time window: `over` opts a section in, and every phrase is judged at startup', () => {
    const app = dashApp({
      label: 'Board',
      sections: [
        { kind: 'metric', from: 'work_order', over: 'opened_on' },
        { kind: 'breakdown', from: 'work_order', by: 'status' },
      ],
    });
    const resolved = resolvedViews(app, SCHEMA)[0] as AppDashboardView;
    assert.equal(resolved.error, undefined);
    /* Defaults are served filled in — the client never re-declares them. */
    assert.deepEqual(resolved.windows, ['last 30 days', 'last 90 days', 'last 12 months']);
    assert.equal((resolved as { refresh?: unknown }).refresh, undefined);

    /* No `over` anywhere: no window control to serve. */
    const still = dashApp({ label: 'B', sections: [{ kind: 'breakdown', from: 'work_order', by: 'status' }] });
    assert.equal((resolvedViews(still, SCHEMA)[0] as AppDashboardView).windows, undefined);

    /* A window over a column the grammar cannot ask that of is a startup
       error naming the section, not a dead control. */
    const bad = dashApp({ label: 'B', sections: [{ kind: 'metric', from: 'work_order', over: 'status' }] });
    assert.ok((resolvedViews(bad, SCHEMA)[0] as { error?: string }).error, 'a window over a text column carries a reason');

    assert.throws(
      () => dashApp({ label: 'B', windows: [], sections: [{ kind: 'metric', from: 't' }] }),
      /"windows" that are not a list of phrases/,
    );
    assert.throws(
      () => dashApp({ label: 'B', refresh: '30 seconds', sections: [{ kind: 'metric', from: 't' }] }),
      /"refresh", which is gone: a dashboard follows changes as they happen/,
    );
  });

  test('resolution judges every section in the grammar it will run in', () => {
    const good = dashApp({
      label: 'Board',
      sections: [
        { kind: 'metric', from: 'work_order', query: 'status = open', compare: 'status = open' },
        { kind: 'breakdown', from: 'work_order', query: 'status != done', by: 'status' },
        { kind: 'rows', from: 'work_order', show: ['customer_id.name'] },
      ],
    });
    const resolved = resolvedViews(good, SCHEMA)[0] as AppDashboardView;
    assert.equal(resolved.error, undefined);
    assert.equal(resolved.sections[0].table, 'work_order');

    const badTable = dashApp({ label: 'B', sections: [{ kind: 'metric', from: 'ghost' }] });
    assert.match((resolvedViews(badTable, SCHEMA)[0] as { error?: string }).error ?? '', /no table "ghost"/);

    const badShow = dashApp({ label: 'B', sections: [{ kind: 'rows', from: 'work_order', show: ['refrence'] }] });
    assert.match((resolvedViews(badShow, SCHEMA)[0] as { error?: string }).error ?? '', /refrence/);
  });
});

describe('nothing is silently skipped', () => {
  /* An unknown key used to vanish — `lable`, `qeury`, `navigation` parsed
     to an emptier app with no word said. For a manifest an agent wrote,
     with no editor to squiggle it, that was the worst failure the format
     had. Every level now names the key and lists what it takes. */
  const dash = (section: Record<string, unknown>) => dashApp({ label: 'B', sections: [section] });

  test('at the top, the list view, the dashboard, the tab, the section and the show entry', () => {
    assert.throws(
      () => parseAppConfig({ ...START, name: 'x', navigation: [] }, WHERE),
      /has no "navigation"\. It takes: id, name, connection, sources, resources, unions, auth, views, pages, features, home, nav, ui/,
    );
    assert.throws(
      () => listApp({ from: 't', lable: 'T' }),
      /views "v" has no "lable"\. Did you mean "label"\? It takes: kind, from, label, path, icon, query/,
    );
    assert.throws(
      () => dashApp({ sections: [{ kind: 'note', text: 'hi' }], descripton: 'x' }),
      /views "d" has no "descripton"\. Did you mean "description"\? It takes: kind, label, path, heading, description, icon, from, sections/,
    );
    assert.throws(
      () => listApp({ from: 't', tabs: [{ label: 'A', sorts: 'x' }] }),
      /tab 1 has no "sorts"\. Did you mean "sort"\? It takes: label, query, segment, sort/,
    );
    assert.throws(
      () => dashApp({ sections: [{ kind: 'metric', title: 'A', from: 't', measur: 'count' }] }),
      /section 1 \(a metric\) has no "measur"/,
    );
    // A show entry is a string; an object is refused by shape, whatever its keys.
    assert.throws(() => listApp({ from: 't', show: [{ column: 'a', lable: 'A' }] }), /"show" entry 1 is not a column name or a label path/);
  });

  test('a section takes the keys of its kind, and nothing another kind reads', () => {
    assert.throws(() => dash({ kind: 'metric', from: 't', show: ['a'] }), /has "show", which only a rows section carries/);
    assert.throws(
      () => dash({ kind: 'note', text: 'hi', over: 'opened_on' }),
      /has "over", which only a metric or breakdown or chart or funnel or matrix or rows section or board carries/,
    );
    assert.throws(
      () => dash({ kind: 'rows', from: 't', by: 'status' }),
      /has "by", which only a breakdown or chart or matrix or board carries/,
    );
    assert.throws(
      () => dash({ kind: 'breakdown', from: 't', by: 'status', bye: 'x' }),
      /\(a breakdown\) has no "bye"\. Did you mean "by"\? It takes: kind, area, title, icon, from, query, segment, measure, by, shape, notes, over, windows, limit, width/,
    );
    // And the keys a kind does read still pass, every one of them.
    assert.doesNotThrow(() =>
      dash({ kind: 'rows', from: 't', title: 'L', query: 'a = 1', show: ['a'], sort: 'a', limit: 5, over: 'd', width: 'half' }),
    );
    assert.doesNotThrow(() => dash({ kind: 'chart', from: 't', by: 'month d', shape: 'line', measure: 'count', limit: 12 }));
  });

  test('annotations pass: $schema and _comment at any level', () => {
    assert.doesNotThrow(() =>
      parseAppConfig(
        {
          $schema: 'x',
          _comment: ['kept'],
          name: 'x',
          resources: { t: {} },
          views: {
            t: { kind: 'list', from: 't', _note: 'a', tabs: [{ label: 'A', _why: 'b' }] },
            b: { kind: 'dashboard', label: 'B', _todo: 'c', sections: [{ kind: 'note', text: 'hi', _x: 1 }] },
          },
          home: 't',
          nav: ['t', 'b'],
        },
        WHERE,
      ),
    );
  });

  test('better says which way is good news; without a delta it parses, and the check warns (test/app-authoring-report.test.ts)', () => {
    const dash = (section: Record<string, unknown>) => dashApp({ label: 'B', sections: [section] });
    assert.doesNotThrow(() => dash({ kind: 'metric', from: 't', query: 'd = last 7 days', compare: 'previous period', better: 'up' }));
    assert.throws(
      () => dash({ kind: 'metric', from: 't', compare: 'x = 1', better: 'sideways' }),
      /"better" of "sideways"\. Use "up" or "down"/,
    );
    assert.doesNotThrow(() => dash({ kind: 'metric', from: 't', better: 'up' }));
    assert.throws(() => dash({ kind: 'rows', from: 't', better: 'up' }), /has "better", which only a metric carries/);
    assert.throws(() => dash({ kind: 'metric', title: 'A', from: 't', better: 'left' }), /"better" of "left"/);
  });

  test('"*" is every other value, and neutral is the pill that says nothing', () => {
    const app = parseAppConfig(
      { ...START, name: 'x', resources: { work_order: { display: { status: { tone: { open: 'warn', '*': 'neutral' } } } } } },
      WHERE,
    );
    assert.deepEqual(app.resources?.work_order.display?.status.tone, { open: 'warn', '*': 'neutral' });
    assert.throws(
      () => parseAppConfig({ ...START, name: 'x', resources: { work_order: { display: { status: { tone: { '*': 'grey' } } } } } }, WHERE),
      /Use good, warn, bad, info, neutral/,
    );
  });

  test("a dashboard's id is its view key: one address, placed in nav once, held to the slug", () => {
    /* Keys cannot collide, so two slugged labels cannot clash; what is left
       to refuse is one view placed twice. */
    const views = {
      'ops-board': { kind: 'dashboard', label: 'Ops board', sections: [{ kind: 'note', text: 'a' }] },
      'ops-two': { kind: 'dashboard', label: 'Ops-Board', sections: [{ kind: 'note', text: 'b' }] },
    };
    assert.throws(
      () => parseAppConfig({ name: 'x', views, nav: ['ops-board', { id: 'two', label: 'Two', children: ['ops-board'] }] }, WHERE),
      /names the view "ops-board" a second time/,
    );
    const app = parseAppConfig({ name: 'x', views, home: 'ops-board', nav: ['ops-board', 'ops-two'] }, WHERE);
    assert.deepEqual(viewOrder(app), ['ops-board', 'ops-two']);
    assert.throws(
      () => parseAppConfig({ name: 'x', views: { 'Not This': views['ops-board'] }, nav: ['Not This'] }, WHERE),
      /a view key is its address, and must be lowercase letters, digits and hyphens/,
    );
  });

  test("a windowed section serves its query without the author's window, and marks a derived compare", () => {
    /* The reader's window replaces the author's phrase on the same column
       rather than intersecting it, and a "previous period" compare can be
       re-derived against whatever the reader picks. */
    const app = dashApp({
      label: 'B',
      sections: [
        {
          kind: 'metric',
          from: 'work_order',
          query: 'status = open and opened_on = last 90 days',
          compare: 'previous period',
          over: 'opened_on',
        },
        { kind: 'metric', from: 'work_order', query: 'status = open', over: 'opened_on' },
        { kind: 'metric', from: 'work_order', query: 'opened_on = last 7 days', compare: 'status = done', over: 'opened_on' },
      ],
    });
    const [dash] = resolvedViews(app, SCHEMA) as Array<{
      sections: Array<{ windowBase?: string; comparePeriod?: boolean; compare?: string }>;
      error?: string;
    }>;
    assert.equal(dash.error, undefined);
    assert.equal(dash.sections[0].windowBase, 'status = open');
    assert.equal(dash.sections[0].comparePeriod, true);
    assert.equal(dash.sections[0].compare, 'status = open and opened_on = previous 90 days');
    assert.equal(dash.sections[1].windowBase, undefined, 'no phrase to remove');
    assert.equal(dash.sections[2].windowBase, '', 'the phrase was the whole query');
    assert.equal(dash.sections[2].comparePeriod, undefined, "a hand-written compare is the author's");
    assert.equal(withoutWindowPhrase('a = 1 and d = last 3 months and b = 2', 'd'), 'a = 1 and b = 2');
    assert.equal(withoutWindowPhrase('d = last 3 months and e = last 2 days', 'd'), 'e = last 2 days');
    assert.equal(withoutWindowPhrase('e = last 2 days', 'd'), undefined);
  });
});

describe('locale, timezone and currency', () => {
  test('are validated by the platform that will use them, and served', () => {
    const app = parseAppConfig({ ...START, name: 'x', ui: { locale: 'en-AU', timezone: 'Australia/Sydney', currency: 'aud' } }, WHERE);
    assert.equal(app.ui.locale, 'en-AU');
    assert.equal(app.ui.timezone, 'Australia/Sydney');
    assert.equal(app.ui.currency, 'AUD');
    assert.throws(
      () => parseAppConfig({ ...START, name: 'x', ui: { locale: 'not a tag!' } }, WHERE),
      /"ui\.locale" of "not a tag!", which is not a language tag/,
    );
    assert.throws(
      () => parseAppConfig({ ...START, name: 'x', ui: { timezone: 'Mars/Olympus' } }, WHERE),
      /"ui\.timezone" of "Mars\/Olympus", which is not an IANA zone/,
    );
    assert.throws(
      () => parseAppConfig({ ...START, name: 'x', ui: { currency: 'dollars' } }, WHERE),
      /"ui\.currency" that is not a three-letter code/,
    );
  });

  test('zonedNow is the wall clock of the zone', () => {
    /* 2026-03-01T23:30Z is already the 2nd in Sydney (+11) and still the 1st
       in Los Angeles (-8). The returned Date's *local* fields read the zone's
       calendar, which is what dateWindow computes "today" from. */
    const at = new Date('2026-03-01T23:30:00Z');
    assert.equal(zonedNow('Australia/Sydney', at).getDate(), 2);
    assert.equal(zonedNow('America/Los_Angeles', at).getDate(), 1);
    assert.equal(zonedNow('Australia/Sydney', at).getHours(), 10);
    assert.equal(zonedNow(undefined, at), at, "no zone is the server's own clock");
  });

  test('every problem on a dashboard is reported, not the first', () => {
    const app = dashApp({
      label: 'B',
      sections: [
        { kind: 'metric', from: 'nope_one' },
        { kind: 'metric', from: 'work_order', measure: 'sum nothing' },
        { kind: 'note', text: 'fine' },
        { kind: 'rows', from: 'work_order', show: ['ghost'] },
      ],
    });
    const [dash] = resolvedViews(app, SCHEMA) as Array<{ error?: string; errors?: string[] }>;
    assert.equal(dash.errors?.length, 3, JSON.stringify(dash.errors));
    assert.match(dash.error ?? '', /no table "nope_one".*\(and 2 more\)/);
    assert.match(dash.errors![1], /nothing/);
    assert.match(dash.errors![2], /ghost/);
  });
});

describe('the write scope', () => {
  test('comes from the resource ceilings, and resolves names to ids with the unknown named', () => {
    const writes = { work_order: { access: 'write' }, ghost: { access: 'write' } };
    const readOnly = parseAppConfig({ ...START, name: 'x', resources: { work_order: {} } }, WHERE);
    assert.deepEqual(resolveAppAccess(readOnly, SCHEMA, []).writable, new Set());
    assert.deepEqual(parseAppConfig({ ...START, name: 'x', resources: writes }, WHERE).resources, writes);
    assert.throws(
      () => parseAppConfig({ ...START, name: 'x', resources: { work_order: { access: 'yes' } } }, WHERE),
      /"access" of "yes"\. A resource reads by default; say "write"/,
    );
    assert.throws(() => parseAppConfig({ ...START, name: 'x', writable: ['work_order'] }, WHERE), /has no "writable"\. It takes: /);
    const scoped = parseAppConfig({ ...START, name: 'x', resources: writes }, WHERE);
    assert.deepEqual(resolveAppAccess(scoped, SCHEMA, []).writable, new Set(['work_order']));
    assert.match(appCeilingWarnings(scoped, SCHEMA)[0], /resources "ghost" has access 'write', and this connection has no table "ghost"/);
  });

  test('appAllowsWrite: no App defers, an App writes only its declared resources, and nothing tableless', () => {
    const open = parseAppConfig({ ...START, name: 'x' }, WHERE);
    const shut = parseAppConfig({ ...START, name: 'x', resources: { work_order: {} } }, WHERE);
    const some = parseAppConfig({ ...START, name: 'x', resources: { work_order: { access: 'write' } } }, WHERE);
    assert.equal(appAllowsWrite(undefined, SCHEMA, 'customer'), true);
    assert.equal(appAllowsWrite(open, SCHEMA, 'work_order'), false, 'a resource reads by default');
    assert.equal(appAllowsWrite(open, SCHEMA, 'customer'), false, 'a table the App does not declare');
    assert.equal(appAllowsWrite(open, SCHEMA, undefined), false);
    assert.equal(appAllowsWrite(shut, SCHEMA, 'customer'), false);
    assert.equal(appAllowsWrite(some, SCHEMA, 'work_order'), true);
    assert.equal(appAllowsWrite(some, SCHEMA, 'customer'), false);
    assert.equal(appAllowsWrite(some, SCHEMA, undefined), false, 'raw SQL and graphs name no table');
    assert.match(writeScopeRefusal(some, 'customer'), /does not write "customer"\. Resources with access 'write': work_order/);
    assert.match(writeScopeRefusal(shut, 'customer'), /is read-only: it writes nothing/);
  });
});

describe('actions and the curated form', () => {
  /* The New form and the actions are the resource's; the list view over it carries them. */
  const nav = (block: Record<string, unknown>) =>
    parseAppConfig(
      {
        name: 'x',
        resources: { work_order: block },
        views: { orders: { kind: 'list', from: 'work_order' } },
        home: 'orders',
        nav: ['orders'],
      },
      WHERE,
    );

  test('an action is a label and a set; when and confirm are optional; shapes are refused by name', () => {
    const app = nav({ actions: { close: { label: 'Close', set: { status: 'closed' }, when: 'status = open', confirm: true } } });
    assert.deepEqual(app.resources?.work_order.actions, [
      { id: 'close', label: 'Close', set: { status: 'closed' }, when: 'status = open', confirm: true },
    ]);
    assert.throws(() => nav({ actions: { a: { set: { status: 'x' } } } }), /action "a" has no "label"/);
    assert.throws(() => nav({ actions: { a: { label: 'A' } } }), /action "a" has no "set"/);
    assert.throws(() => nav({ actions: { a: { label: 'A', set: { status: { deep: 1 } } } } }), /sets "status" to something that is not/);
    assert.throws(
      () => nav({ actions: { a: { label: 'A', set: { status: 'x' }, wehn: 'a = 1' } } }),
      /action "a" has no "wehn"\. Did you mean "when"\? It takes: label, command, set, when, confirm, bulk, header, reason, inputs/,
    );
    assert.throws(() => nav({ actions: { label: 'A' } }), /action "label" is not an object/);
  });

  test('resolution judges the set columns and the when against the table, on the resource', () => {
    assert.match(
      resourceProblems(nav({ actions: { a: { label: 'A', set: { nope: 1 } } } })),
      /resources "work_order", action "a": "work_order" has no column "nope"/,
    );
    assert.match(resourceProblems(nav({ actions: { a: { label: 'A', set: { status: 'x' }, when: 'ghost = 1' } } })), /action "a", when:/);
    const good = nav({ actions: { a: { label: 'A', set: { status: 'x' }, when: 'status = open' } } });
    assert.equal(resourceProblems(good), '');
    assert.equal(resolveResources(good, SCHEMA).resources.work_order.actions?.length, 1, 'served on the resource');
    assert.equal(resolvedViews(good, SCHEMA)[0].error, undefined);
  });

  test('a form names the columns it asks for and the values it fills; a starved required column is refused', () => {
    const app = nav({ form: { show: ['status'], defaults: { priority: 1 } } });
    assert.deepEqual(app.resources?.work_order.form, { show: ['status'], defaults: { priority: 1 } });
    assert.throws(() => nav({ form: { show: 'status' } }), /"form": invalid form declaration/);
    assert.throws(() => nav({ form: { when: [] } }), /"form": invalid form declaration/);
    assert.match(resourceProblems(nav({ form: { show: ['ghost'] } })), /Form: "work_order" has no column "ghost"/);
    /* Every NOT NULL column with no default must be asked for or filled. */
    const required = SCHEMA.tables
      .find((t) => t.id === 'work_order')!
      .columns.filter((c) => !c.nullable && c.default === undefined && !(c.primaryKey && /int/i.test(c.type ?? '')))
      .map((c) => c.name);
    if (required.length) {
      assert.match(resourceProblems(nav({ form: { show: [] } })), new RegExp(`Form: "work_order" requires "${required[0]}"`));
      assert.equal(resourceProblems(nav({ form: { show: required } })), '');
    }
  });

  test('a null form default cannot satisfy NOT NULL, even when the database has a default', () => {
    const schema = {
      ...SCHEMA,
      tables: SCHEMA.tables.map((t) =>
        t.id === 'work_order'
          ? { ...t, columns: t.columns.map((c) => (c.name === 'status' ? { ...c, nullable: false, default: "'new'" } : c)) }
          : t,
      ),
    };
    assert.match(resourceProblems(nav({ form: { defaults: { status: null } } }), schema), /cannot default to null \(NOT NULL\)/);
    assert.equal(resourceProblems(nav({ form: { defaults: { reference: null } } }), schema), '');
  });

  test('forms require manual integer keys and cannot supply defaults for ALWAYS identities', () => {
    const items = { views: { items: { kind: 'list', from: 'item' } }, home: 'items', nav: ['items'] };
    const app = parseAppConfig({ name: 'Identity forms', resources: { item: { form: { show: ['name'] } } }, ...items }, WHERE);
    const manual = {
      ...SCHEMA,
      tables: [
        {
          id: 'item',
          name: 'item',
          schema: '',
          isView: false,
          columns: [
            { name: 'id', type: 'integer', primaryKey: true, nullable: false },
            { name: 'name', type: 'text', primaryKey: false, nullable: false },
          ],
        },
      ],
    };
    const resolve = (schema: DatabaseSchema, config = app) => resolveResources(config, schema).problems[0];
    assert.match(resolve(manual) ?? '', /requires "id"/);
    const assigned: DatabaseSchema = {
      ...manual,
      tables: [{ ...manual.tables[0], columns: [{ ...manual.tables[0].columns[0], identity: 'always' }, manual.tables[0].columns[1]] }],
    };
    assert.equal(resolve(assigned), undefined);
    const overriding = parseAppConfig(
      { name: 'Bad identity form', resources: { item: { form: { show: ['name'], defaults: { id: 42 } } } }, ...items },
      WHERE,
    );
    assert.match(resolve(assigned, overriding) ?? '', /always assigned by the database/);
  });
});

describe('the DSL kindnesses', () => {
  test("a dashboard-level table is every section's default, and its own still wins", () => {
    const app = dashApp({
      label: 'Board',
      from: 'work_order',
      sections: [
        { kind: 'metric', title: 'Open', query: 'status = open' },
        { kind: 'breakdown', by: 'status' },
        { kind: 'metric', title: 'Elsewhere', from: 'customer' },
        { kind: 'note', text: 'hello' },
      ],
    });
    const dash = roomsOf(app)[0] as AppDashboardView;
    assert.equal(dash.sections[0].table, 'work_order');
    assert.equal(dash.sections[1].table, 'work_order');
    assert.equal(dash.sections[2].table, 'customer');
    assert.equal(dash.sections[3].table, undefined);
    /* And the filled sections resolve exactly as if written out. */
    const [resolved] = resolvedViews(app, SCHEMA);
    assert.equal((resolved as { error?: string }).error, undefined);

    assert.throws(
      () => dashApp({ label: 'D', sections: [{ kind: 'metric' }] }),
      /has no "from" — name one, or set a dashboard-level "from"/,
    );
  });

  test('a board is lanes from one bare column, and every other spelling is refused', () => {
    assert.throws(() => dashApp({ label: 'D', sections: [{ kind: 'board', from: 'work_order' }] }), /is a board and has no "by"/);
    assert.throws(
      () => dashApp({ label: 'D', sections: [{ kind: 'board', from: 'work_order', by: 'month opened_on' }] }),
      /a board's lanes come from a bare column/,
    );
    const app = dashApp({
      label: 'D',
      sections: [{ kind: 'board', from: 'work_order', by: 'status', primary: 'reference', lines: ['customer_id.name'] }],
    });
    const [ok] = resolvedViews(app, SCHEMA) as Array<{ error?: string }>;
    assert.equal(ok.error, undefined);
    const bad = dashApp({ label: 'D', sections: [{ kind: 'board', from: 'work_order', by: 'nope' }] });
    const [refused] = resolvedViews(bad, SCHEMA) as Array<{ error?: string }>;
    assert.match(refused.error ?? '', /no column "nope" — a board's lanes/);
  });

  test('board lanes are an optional ordered subset of exact unique values', () => {
    const lanes = ['in progress', 'open', ' open '];
    const app = dashApp({
      label: 'D',
      sections: [
        { kind: 'board', from: 'work_order', by: 'status', lanes },
        { kind: 'board', from: 'work_order', by: 'status' },
      ],
    });
    const dash = roomsOf(app)[0] as AppDashboardView;
    assert.deepEqual(dash.sections[0].lanes, lanes);
    assert.notEqual(dash.sections[0].lanes, lanes, 'the parsed app owns its array');
    assert.equal(Object.hasOwn(dash.sections[1], 'lanes'), false);
    const resolved = resolvedViews(app, SCHEMA)[0] as AppDashboardView;
    assert.equal(resolved.error, undefined, 'unconstrained columns accept explicit values');
    assert.deepEqual(resolved.sections[0].lanes, lanes);
    assert.equal(Object.hasOwn(resolved.sections[1], 'lanes'), false);
  });

  test('board lanes reject invalid shape, bounds, duplicates and use on other sections', () => {
    const parse = (lanes: unknown, kind = 'board') =>
      dashApp({ label: 'D', sections: [{ kind, from: 'work_order', by: 'status', lanes }] });
    for (const lanes of [null, 'open', {}, [], [''], [' \t\n'], [1], ['open', false], Array.from({ length: 9 }, (_, i) => `lane${i}`)]) {
      assert.throws(() => parse(lanes), /"lanes".*1 to 8 nonblank strings/);
    }
    assert.throws(() => parse(['open', 'open']), /duplicate "lanes"/);
    assert.doesNotThrow(() => parse(Array.from({ length: 8 }, (_, i) => `lane${i}`)));
    assert.doesNotThrow(() => parse(['open']));
    assert.throws(() => parse(['open'], 'chart'), /"lanes", which only a board carries/);
  });

  test('board lanes must match declared enum vocabulary exactly', () => {
    const schema = structuredClone(SCHEMA);
    schema.tables[0].columns.find((column) => column.name === 'status')!.allowed = ['open', 'in progress', 'done'];
    const resolve = (lanes: string[]) =>
      resolvedViews(
        dashApp({ label: 'D', sections: [{ kind: 'board', title: 'Work queue', from: 'work_order', by: 'status', lanes }] }),
        schema,
      )[0] as AppDashboardView;
    const good = resolve(['in progress', 'open']);
    assert.equal(good.error, undefined);
    assert.deepEqual(good.sections[0].lanes, ['in progress', 'open']);
    assert.match(
      resolve(['missing', 'OPEN', ' open ']).error ?? '',
      /Section "Work queue": "work_order.status" has unknown lane values "missing", "OPEN", " open "/,
    );
    assert.equal(schema.tables[0].columns.find((column) => column.name === 'status')!.allowed?.length, 3);
  });

  test("a metric over a clock compares with the period before unasked; a compare by hand is still the author's", () => {
    const app = dashApp({
      label: 'B',
      windows: ['last 30 days'],
      sections: [
        { kind: 'metric', title: 'Follows', from: 'work_order', over: 'opened_on' },
        { kind: 'metric', title: 'Own', from: 'work_order', over: 'opened_on', query: 'opened_on = last 90 days' },
        // Two windows of its own: the change is the author's to write, and the figure stands without one, unrefused.
        {
          kind: 'metric',
          title: 'Two',
          from: 'work_order',
          over: 'opened_on',
          query: 'opened_on = last 30 days and opened_on = last 90 days',
        },
        { kind: 'metric', title: 'Hand', from: 'work_order', over: 'opened_on', compare: 'status = open' },
        { kind: 'metric', title: 'No clock', from: 'work_order', query: 'status = open' },
      ],
    });
    const [dash] = resolvedViews(app, SCHEMA) as Array<{
      sections: Array<{ compare?: string; comparePeriod?: boolean }>;
      error?: string;
    }>;
    assert.equal(dash.error, undefined);
    const [follows, own, two, hand, none] = dash.sections;
    assert.deepEqual([follows.compare, follows.comparePeriod], [undefined, true]);
    assert.equal(own.compare, 'opened_on = previous 90 days');
    assert.equal(two.compare, undefined);
    assert.deepEqual([hand.compare, hand.comparePeriod], ['status = open', undefined]);
    assert.deepEqual([none.compare, none.comparePeriod], [undefined, undefined]);
  });

  test('compare "previous period" derives the shifted window, and ambiguity refuses', () => {
    const one = previousPeriodQuery('status = open and opened_on = last 30 days');
    assert.deepEqual(one, { query: 'status = open and opened_on = previous 30 days' });
    const singular = previousPeriodQuery('opened_on = last 1 day');
    assert.deepEqual(singular, { query: 'opened_on = previous 1 day' });
    assert.match(
      (previousPeriodQuery('status = open') as { error: string }).error,
      /has no dates to compare.*"over".*the compare query in full/s,
    );
    assert.match((previousPeriodQuery('opened_on = last 30 days and opened_on = last 90 days') as { error: string }).error, /it has 2/);

    /* Through the real resolver: the metric the client receives carries
       the derived query, so the browser never learns the phrase. */
    const app = dashApp({
      label: 'B',
      sections: [{ kind: 'metric', from: 'work_order', query: 'opened_on = last 90 days', compare: 'previous period' }],
    });
    const [dash] = resolvedViews(app, SCHEMA) as Array<{ sections: Array<{ compare?: string }>; error?: string }>;
    assert.equal(dash.error, undefined);
    assert.equal(dash.sections[0].compare, 'opened_on = previous 90 days');

    const bad = dashApp({
      label: 'B',
      sections: [{ kind: 'metric', from: 'work_order', query: 'status = open', compare: 'previous period' }],
    });
    const [badDash] = resolvedViews(bad, SCHEMA) as Array<{ error?: string }>;
    assert.match(badDash.error ?? '', /"previous period" has no dates to compare/);

    /* With no window of its own but a date column to be windowed by, the
       metric follows the reader's pick: served with nothing to compare yet,
       marked so the client derives `previous N` from the window picked. */
    const follows = dashApp({
      label: 'B',
      windows: ['last 30 days'],
      sections: [
        {
          kind: 'metric',
          title: 'Open',
          from: 'work_order',
          query: 'status = open',
          compare: 'previous period',
          over: 'opened_on',
          windows: ['last 7 days'],
        },
        { kind: 'metric', from: 'work_order', compare: 'previous period', over: 'opened_on' },
      ],
    });
    const [followDash] = resolvedViews(follows, SCHEMA) as Array<{
      sections: Array<{ compare?: string; comparePeriod?: boolean; windowBase?: string }>;
      error?: string;
    }>;
    assert.equal(followDash.error, undefined);
    for (const section of followDash.sections) {
      assert.equal(section.compare, undefined, 'no compare until a window is picked');
      assert.equal(section.comparePeriod, true);
    }
    /* Two windows of its own still refuse: the author means something the rule does not know. */
    const two = dashApp({
      label: 'B',
      sections: [
        {
          kind: 'metric',
          from: 'work_order',
          over: 'opened_on',
          compare: 'previous period',
          query: 'opened_on = last 30 days and opened_on = last 90 days',
        },
      ],
    });
    assert.match((resolvedViews(two, SCHEMA) as Array<{ error?: string }>)[0].error ?? '', /it has 2/);

    /* The home dashboard's metrics speak the same phrase. */
    const home = parseAppConfig(
      {
        name: 'x',
        resources: { work_order: {} },
        views: {
          home: {
            kind: 'dashboard',
            label: 'Home',
            sections: [
              { kind: 'metric', title: 'Recent', from: 'work_order', query: 'opened_on = last 7 days', compare: 'previous period' },
            ],
          },
        },
        home: 'home',
        nav: ['home'],
      },
      WHERE,
    );
    const [card] = resolvedViews(home, SCHEMA) as Array<{ sections: Array<{ compare?: string }>; error?: string }>;
    assert.equal(card.error, undefined);
    assert.equal(card.sections[0].compare, 'opened_on = previous 7 days');
  });

  test('a rows section says what belongs in it while it has no row', () => {
    const home = parseAppConfig(
      {
        ...START,
        name: 'x',
        resources: { work_order: {} },
        views: {
          home: {
            kind: 'dashboard',
            label: 'Home',
            sections: [
              {
                kind: 'rows',
                title: 'Waiting',
                from: 'work_order',
                empty: { title: 'Nothing is waiting', description: 'Booked work shows here.' },
              },
            ],
          },
        },
        home: 'home',
        nav: ['home'],
      },
      WHERE,
    );
    const [card] = resolvedViews(home, SCHEMA) as Array<{ sections: Array<{ empty?: unknown }>; error?: string }>;
    assert.equal(card.error, undefined);
    assert.deepEqual(card.sections[0].empty, { title: 'Nothing is waiting', description: 'Booked work shows here.' });
  });

  test('a yes/no rule keyed by anything but true and false is named', () => {
    const flagged = {
      ...SCHEMA,
      tables: SCHEMA.tables.map((t) =>
        t.id === 'work_order' ? { ...t, columns: [...t.columns, { ...col('urgent'), type: 'INTEGER', flag: true as const }] } : t,
      ),
    };
    const warned = (rule: Record<string, unknown>) =>
      resolveDisplay(parseAppConfig({ ...START, name: 'x', resources: { work_order: { display: { urgent: rule } } } }, WHERE), flagged)
        .warnings;
    assert.deepEqual(warned({ values: { true: 'Urgent', false: 'Routine' }, tone: { true: 'bad', '*': 'neutral' } }), []);
    assert.match(
      warned({ values: { 1: 'Urgent', 0: 'Routine' } })[0] ?? '',
      /\[boolean-keys\]: "urgent" is yes or no, and its values keys "0", "1" are never matched/,
    );
    assert.match(warned({ tone: { yes: 'bad' } })[0] ?? '', /its tone key "yes" is never matched/);
  });

  test('a tone threshold standing after a looser one is named as unreachable', () => {
    const warned = (tone: Record<string, string>) =>
      resolveDisplay(parseAppConfig({ ...START, name: 'x', resources: { work_order: { display: { status: { tone } } } } }, WHERE), SCHEMA)
        .warnings;
    /* The bug this repo shipped itself: 5 satisfies >= 4 first, so bad never wins. */
    assert.match(warned({ '>= 4': 'warn', '>= 5': 'bad' })[0] ?? '', /tone ">= 5" can never win — .*">= 4" is satisfied first/);
    assert.deepEqual(warned({ '>= 5': 'bad', '>= 4': 'warn' }), []);
    assert.match(warned({ '<= 2': 'good', '< 1': 'bad' })[0] ?? '', /"< 1" can never win/);
    /* An integer key ("5") floats to the front of JS key order, so it
       always tries first and cannot be shadowed; a decimal keeps its
       written place and can be. */
    assert.match(warned({ '> 3': 'warn', '4.5': 'bad' })[0] ?? '', /"4\.5" can never win/);
    assert.deepEqual(warned({ '>= 4': 'warn', '5': 'bad' }), []);
    /* Opposite directions never cover; plain value keys never shadow. */
    assert.deepEqual(warned({ '>= 4': 'warn', '<= 1': 'bad' }), []);
    assert.deepEqual(warned({ open: 'info', '>= 4': 'warn' }), []);
  });
});

describe('the home dashboard', () => {
  /* A 0.3 home card is a metric section of the dashboard root `home` names. */
  /* `ghost` is declared and absent from the schema: resolution names it. */
  const homeApp = (...cards: Record<string, unknown>[]) =>
    parseAppConfig(
      {
        name: 'x',
        resources: { work_order: {}, ghost: {}, t: {} },
        views: { home: { kind: 'dashboard', label: 'Home', sections: cards.map((card) => ({ kind: 'metric', ...card })) } },
        home: 'home',
        nav: ['home'],
      },
      WHERE,
    );
  const dashOf = (app: ReturnType<typeof homeApp>) => roomsOf(app)[0] as AppDashboardView;
  const errorOf = (app: ReturnType<typeof homeApp>) => (resolvedViews(app, SCHEMA)[0] as { error?: string }).error;

  test('a card is a titled metric over a table, in the language; shapes are refused by name', () => {
    const app = homeApp({ title: ' Open ', from: ' work_order ', query: 'status = open', measure: 'count' });
    const [metric] = dashOf(app).sections;
    assert.deepEqual(
      { title: metric.title, table: metric.table, query: metric.query, measure: metric.measure, compare: metric.compare },
      { title: 'Open', table: 'work_order', query: 'status = open', measure: 'count', compare: undefined },
    );
    assert.throws(() => parseAppConfig({ name: 'x', home: {} }, WHERE), /"home" is not a view id or a non-empty list of rules/);
    assert.throws(
      () => parseAppConfig({ name: 'x', home: [{ label: 'L', table: 't' }] }, WHERE),
      /"home", rule 1 has no "label"\. It takes: view, signedOut, roles, realm\./,
    );
    assert.throws(() => homeApp({ title: 'L' }), /section 1 has no "from"/);
    assert.throws(() => homeApp({ title: 'L', from: 't', measure: 7 }), /"measure" that is not a non-empty string/);
  });

  test('resolution judges the card in the grammar its number will run in', () => {
    assert.equal(errorOf(homeApp({ title: 'Open', from: 'work_order', query: 'status = open' })), undefined);
    assert.match(errorOf(homeApp({ title: 'L', from: 'ghost' })) ?? '', /no table "ghost"/);
    assert.ok(errorOf(homeApp({ title: 'L', from: 'work_order', query: 'staus = open' })), 'a typo in the query carries a reason');
  });

  test('a compare window rides the card and is judged in the same grammar', () => {
    const app = homeApp({ title: 'Open', from: 'work_order', query: 'status = open', compare: 'status = on_hold' });
    assert.equal(dashOf(app).sections[0].compare, 'status = on_hold');
    assert.equal(errorOf(app), undefined);
    assert.match(errorOf(homeApp({ title: 'Open', from: 'work_order', compare: 'staus = open' })) ?? '', /compare:/);
  });
});

describe('display rules and the export switch', () => {
  test('rules parse by name, and every wrong shape is refused with the key named', () => {
    const app = parseAppConfig(
      {
        ...START,
        name: 'x',
        resources: {
          work_order: { display: { status: { tone: { open: 'info', cancelled: 'bad' } } } },
          customer: { display: { name: { format: 'number' } } },
        },
        ui: { export: false },
      },
      WHERE,
    );
    assert.equal(app.resources?.work_order.display?.status.tone?.open, 'info');
    assert.equal(app.ui.export, false);

    assert.throws(
      () => parseAppConfig({ ...START, name: 'x', resources: { t: { display: [] } } }, WHERE),
      /"display" that is not an object/,
    );
    assert.throws(
      () => parseAppConfig({ ...START, name: 'x', resources: { t: { display: { 'work_order.status': {} } } } }, WHERE),
      /display "work_order\.status": display is keyed by the resource's own column/,
    );
    assert.throws(
      () => parseAppConfig({ ...START, name: 'x', resources: { t: { display: { c: { format: 'pie' } } } } }, WHERE),
      /Use money, percent, number/,
    );
    assert.throws(
      () => parseAppConfig({ ...START, name: 'x', resources: { t: { display: { c: { tone: { open: 'green' } } } } } }, WHERE),
      /Use good, warn, bad, info/,
    );
    assert.throws(
      () => parseAppConfig({ ...START, name: 'x', resources: { t: { display: { c: { bar: true } } } } }, WHERE),
      /"bar: true" with no scale/,
    );
    assert.throws(
      () => parseAppConfig({ ...START, name: 'x', resources: { t: { display: { c: { format: 'percent', currency: 'USD' } } } } }, WHERE),
      /"currency", which only format "money" carries/,
    );
    assert.throws(
      () => parseAppConfig({ ...START, name: 'x', resources: { t: { display: { c: { glow: true } } } } }, WHERE),
      /has no "glow"/,
    );
    assert.throws(() => parseAppConfig({ ...START, name: 'x', ui: { export: 'no' } }, WHERE), /"ui\.export" is not true or false/);
    assert.equal(parseAppConfig({ ...START, name: 'x', ui: { shell: { placement: 'top' } } }, WHERE).ui.shell?.placement, 'top');
    assert.equal(parseAppConfig({ ...START, name: 'x', ui: { shell: { counts: true } } }, WHERE).ui.shell?.counts, true);
    assert.throws(
      () => parseAppConfig({ ...START, name: 'x', ui: { shell: { placement: 'floating' } } }, WHERE),
      /ui\.shell\.placement must be one of: side, top/,
    );
  });

  test('resolution re-addresses keys to table ids and names every rule that cannot match', () => {
    const app = parseAppConfig(
      {
        ...START,
        name: 'x',
        resources: {
          ghost: { display: { total: { format: 'money' } } },
          work_order: { display: { status: { tone: { open: 'info' } }, priority: { format: 'number' } } },
        },
      },
      WHERE,
    );
    const { display, warnings } = resolveDisplay(app, SCHEMA);
    assert.deepEqual(Object.keys(display), ['work_order.status']);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /no table "ghost"/);
    assert.match(warnings[1], /"work_order" has no column "priority"/);
  });
});

describe('resolveNav', () => {
  test('labels default to the table name, spoken; a written label wins', () => {
    /* Served humanised: the sidebar read `work_order` beside a breadcrumb
       that had already said "Work order". */
    const app = parseAppConfig(
      {
        name: 'x',
        resources: { work_order: {}, customer: {} },
        views: { orders: { kind: 'list', from: 'work_order' }, customers: { kind: 'list', from: 'customer', label: 'Customers' } },
        home: 'orders',
        nav: ['orders', { id: 'directory', label: 'Directory', children: ['customers'] }],
      },
      WHERE,
    );
    const views = resolvedViews(app, SCHEMA);
    assert.deepEqual(views[0], { table: 'work_order', label: 'Work order' });
    assert.deepEqual(views[1], { table: 'customer', label: 'Customers' });
    /* The group is nav's, served as the tree it was written as. */
    assert.deepEqual(servedApp(app, SCHEMA).nav, [
      { view: 'orders', label: 'Work order' },
      { group: 'directory', label: 'Directory', children: [{ view: 'customers', label: 'Customers' }] },
    ]);
  });

  test('columns and tabs ride through resolution untouched', () => {
    const app = parseAppConfig(
      {
        name: 'x',
        resources: { work_order: { segments: { open: 'status = open' } } },
        views: { v: { kind: 'list', from: 'work_order', show: ['reference'], tabs: ['open'] } },
        home: 'v',
        nav: ['v'],
      },
      WHERE,
    );
    const [entry] = resolvedViews(app, SCHEMA) as ResolvedListView[];
    assert.deepEqual(entry.show, ['reference']);
    assert.deepEqual(entry.tabs, [{ label: 'Open', query: 'open', segment: 'open', slug: 'open' }]);
    assert.equal(entry.error, undefined);
  });

  test('authored split presentation rides through resolution for the client list spec', () => {
    const app = parseAppConfig(
      {
        name: 'x',
        resources: { work_order: { labels: { reference: 'Ref' } } },
        views: {
          v: {
            kind: 'list',
            from: 'work_order',
            show: ['reference'],
            query: 'status = open',
            filterBar: 'none',
            split: { limit: 25, detail: ['reference', 'status'] },
          },
        },
        home: 'v',
        nav: ['v'],
      },
      WHERE,
    );
    const [entry] = resolvedViews(app, SCHEMA) as ResolvedListView[];
    /* The caption is the resource's, served on it for every surface to read. */
    assert.deepEqual(resolveResources(app, SCHEMA).resources.work_order.labels, { reference: 'Ref' });
    assert.deepEqual(entry.presentation, { kind: 'split', limit: 25, detail: ['reference', 'status'] });
    assert.equal(entry.error, undefined);
  });

  test('a wrong column or an unparseable tab query is caught at resolution, not one refused request at a time', () => {
    /* The agent-authoring story leans on this: a typo'd app used to load
       with a clean startup and fail in the browser, query by query. */
    const typoColumn = parseAppConfig(
      {
        name: 'x',
        resources: { work_order: {} },
        views: { v: { kind: 'list', from: 'work_order', show: ['refrence'] } },
        home: 'v',
        nav: ['v'],
      },
      WHERE,
    );
    assert.match(resolvedViews(typoColumn, SCHEMA)[0].error ?? '', /show cannot be resolved.*"refrence"/);

    const typoFilter = parseAppConfig(
      {
        name: 'x',
        resources: { work_order: {} },
        views: { v: { kind: 'list', from: 'work_order', filters: ['staus'] } },
        home: 'v',
        nav: ['v'],
      },
      WHERE,
    );
    assert.match(resolvedViews(typoFilter, SCHEMA)[0].error ?? '', /no column "staus"/);

    /* The label path: a show entry may reach through a reference for the
       record's name, judged by the real path resolver. */
    const dotted = parseAppConfig(
      {
        name: 'x',
        resources: { work_order: { labels: { 'customer_id.name': 'Customer' } } },
        views: { v: { kind: 'list', from: 'work_order', show: ['customer_id.name'] } },
        home: 'v',
        nav: ['v'],
      },
      WHERE,
    );
    assert.equal(resolvedViews(dotted, SCHEMA)[0].error, undefined);

    const badTab = parseAppConfig(
      {
        name: 'x',
        resources: { work_order: { segments: { open: 'staus = open' } } },
        views: { v: { kind: 'list', from: 'work_order', tabs: ['open'] } },
        home: 'v',
        nav: ['v'],
      },
      WHERE,
    );
    assert.match(resolvedViews(badTab, SCHEMA)[0].error ?? '', /Tab "Open"/);
  });

  test('bare names resolve on a schema-qualified connection, and the resolved id is served', () => {
    /* Postgres is the product's primary target and its ids are qualified:
       a manifest written "work_order" must land on "public.work_order",
       and the client keys every lookup on what this hands back. */
    const qualified: DatabaseSchema = {
      ...SCHEMA,
      tables: SCHEMA.tables.map((t) => ({ ...t, schema: 'public', id: `public.${t.name}` })),
    };
    const app = listApp({ from: 'work_order' });
    const [entry] = resolvedViews(app, qualified) as ResolvedListView[];
    assert.equal(entry.error, undefined);
    assert.equal(entry.table, 'public.work_order');
    assert.equal(entry.label, 'Work order');
  });

  test('an unknown table keeps its place and carries its reason', () => {
    const app = parseAppConfig(
      {
        name: 'x',
        resources: { work_order: {}, ghost: {}, customer: {} },
        views: {
          orders: { kind: 'list', from: 'work_order' },
          ghost: { kind: 'list', from: 'ghost' },
          customers: { kind: 'list', from: 'customer' },
        },
        home: 'orders',
        nav: ['orders', 'ghost', 'customers'],
      },
      WHERE,
    );
    const nav = resolvedViews(app, SCHEMA) as ResolvedListView[];
    assert.equal(nav.length, 3);
    assert.equal(nav[1].table, 'ghost');
    assert.match(nav[1].error ?? '', /no table "ghost"/);
    assert.equal(nav[0].error, undefined);
    assert.equal(nav[2].error, undefined);
  });
});

describe('loadApp and mergeAppPages', () => {
  let tmp: string;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'tablewalk-app-'));
  });
  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const write = (dir: string, manifest: unknown): string => {
    const full = join(tmp, dir);
    mkdirSync(full, { recursive: true });
    writeFileSync(join(full, 'app.json'), JSON.stringify(withStart(manifest)));
    return full;
  };

  test('a directory means its app.json, and pages inherit the app connection', async () => {
    const dir = write('inherit', {
      name: 'Ops',
      connection: 'prod',
      pages: {
        order: { base: 'work_order' },
      },
    });
    const loaded = await loadApp(dir);
    assert.equal(loaded.path, join(dir, 'app.json'));
    assert.equal(loaded.pages[0].connection, 'prod');
    assert.equal(loaded.pages[0].source, 'config');
  });

  test('a pages/ folder is one page per file, scoped with the app', async () => {
    const dir = write('paged', { name: 'Ops', connection: 'prod' });
    mkdirSync(join(dir, 'pages'));
    writeFileSync(join(dir, 'pages', 'customer.json'), JSON.stringify({ base: 'customer' }));
    writeFileSync(join(dir, 'pages', 'order.json'), JSON.stringify({ base: 'work_order' }));
    const loaded = await loadApp(dir);
    // Name order, so load order belongs to the directory, not the filesystem.
    // Each file's basename is its page id.
    assert.deepEqual(
      loaded.pages.map((p) => p.id),
      ['customer', 'order'],
    );
    assert.equal(loaded.pages[0].connection, 'prod');
    assert.equal(loaded.pages[0].source, 'config');
  });

  test('a file page repeating an app.json page id is refused, both files named', async () => {
    const dir = write('paged-dupe', { name: 'Ops', pages: { customer: { base: 'customer' } } });
    mkdirSync(join(dir, 'pages'));
    writeFileSync(join(dir, 'pages', 'customer.json'), JSON.stringify({ base: 'customer' }));
    await assert.rejects(loadApp(dir), /pages[/\\]customer\.json: the page "customer" is already declared in .*app\.json/);
  });

  test('a missing path and a malformed file are refused by name', async () => {
    await assert.rejects(loadApp(join(tmp, 'nowhere')), /nowhere does not exist/);
    const dir = write('broken', {});
    writeFileSync(join(dir, 'app.json'), '{ not json');
    await assert.rejects(loadApp(dir), /broken[/\\]app\.json:/);
  });

  test('a page id the config file already owns is refused, both files named', async () => {
    const dir = write('collide', { name: 'Ops', pages: { order: { base: 'work_order' } } });
    const loaded = await loadApp(dir);
    const configPage = { ...loaded.pages[0] } as PageDef;
    assert.throws(
      () => mergeAppPages([configPage], loaded, '/etc/mistri.json'),
      /collide[/\\]app\.json: page id "order" is already defined in \/etc\/mistri\.json/,
    );
    // And with nothing to collide with, the pages simply join on.
    assert.equal(mergeAppPages([], loaded).length, 1);
  });
});

describe('appPayload', () => {
  const loaded = (connection?: string, view: Record<string, unknown> = { from: 'work_order' }): LoadedApp => ({
    path: 'x/app.json',
    app: parseAppConfig(
      {
        name: 'Ops',
        connection,
        resources: { [String(view.from)]: {} },
        views: { orders: { kind: 'list', ...view } },
        home: 'orders',
        nav: ['orders'],
      },
      WHERE,
    ),
    pages: [],
    sources: {},
  });

  test('no app, or an app for another connection, answers null', () => {
    assert.equal(appPayload(undefined, 'db', 'db', SCHEMA).app, null);
    assert.equal(appPayload(loaded('other'), 'db', 'mydb', SCHEMA).app, null);
  });

  test('the app matches by connection id, by name, or by not saying', () => {
    for (const conn of [undefined, 'db', 'mydb']) {
      const got = appPayload(loaded(conn), 'db', 'mydb', SCHEMA);
      assert.equal(got.connection, 'db');
      assert.equal(got.app?.name, 'Ops');
      assert.equal(got.app?.nav[0].label, 'Work order');
    }
  });

  test('the API projection keeps the authored split list spec', () => {
    const got = appPayload(loaded(undefined, { from: 'work_order', split: { limit: 20, detail: ['reference'] } }), 'db', 'mydb', SCHEMA);
    const entry = Object.values(got.app?.views ?? {})[0] as ResolvedListView;
    assert.deepEqual(entry.presentation, { kind: 'split', limit: 20, detail: ['reference'] });
  });
});

describe('the write scope, enforced over HTTP', () => {
  let tmp: string;
  let server: Server;
  let port = 0;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'tablewalk-app-scope-'));
    const db = join(tmp, 'scoped.db');
    makeDemoDatabase(db);
    seedDemoDatabase(db, { scale: 5 });
    const dir = join(tmp, 'scoped');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'app.json'),
      JSON.stringify({
        name: 'Scoped',
        resources: { work_order: { access: 'write' }, customer: {} },
        views: { orders: { kind: 'list', from: 'work_order' } },
        home: 'orders',
        nav: ['orders'],
      }),
    );
    const loaded = await loadApp(dir);
    const registry = new Registry();
    registry.add({ name: 'rw', url: db, writable: true, source: 'config' });
    registry.setActive('rw');
    await registry.open('rw');
    server = createApp({ registry, apps: [{ app: loaded, pages: [] }], bound: { host: '127.0.0.1', port: 0 } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });
  after(() => {
    server?.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const post = async (path: string, body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  test('a table outside the list is refused with the list named; one inside passes the gate', async () => {
    const out = await post('/api/update', { table: 'customer', key: { id: 1 }, values: { name: 'x' } });
    assert.equal(out.status, 403);
    assert.match(String(out.json.error), /"Scoped" does not write "customer"\. Resources with access 'write': work_order/);
    const inside = await post('/api/update', { table: 'work_order', key: { id: 1 }, values: { status: 'open' } });
    assert.notEqual(inside.status, 403, JSON.stringify(inside.json));
    assert.equal((await post('/api/delete', { table: 'customer', key: { id: 1 } })).status, 403);
    assert.equal((await post('/api/insert', { table: 'customer', values: { name: 'x' } })).status, 403);
    // A table the App does not declare answers as one that is not there.
    const undeclared = await post('/api/update', { table: 'product', key: { id: 1 }, values: { name: 'x' } });
    assert.deepEqual([undeclared.status, undeclared.json.error], [403, 'Access to this resource is denied.']);
  });

  test('raw SQL is unavailable on an application server', async () => {
    const res = await post('/api/sql', { text: 'update customer set name = name', write: true });
    assert.equal(res.status, 403);
    assert.match(String(res.json.error), /standalone DB browser/);
  });

  test("the payload carries the resolved scope for the client's buttons", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/app?app=scoped`);
    const json = (await res.json()) as { app: { writableTables?: string[] } };
    assert.deepEqual(json.app.writableTables, ['work_order']);
  });
});

describe('GET /api/app', () => {
  let tmp: string;
  let server: Server;
  let port = 0;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'tablewalk-app-http-'));
    const db = join(tmp, 'app.db');
    makeDemoDatabase(db);
    // work_order lives in the seeded half of the demo, not the base fixture.
    seedDemoDatabase(db, { scale: 5 });

    const dir = join(tmp, 'fieldops');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'app.json'),
      JSON.stringify({
        name: 'Field Ops',
        resources: { work_order: {}, customer: {}, ghost: {} },
        views: {
          orders: { kind: 'list', from: 'work_order' },
          customers: { kind: 'list', from: 'customer', label: 'Customers' },
          ghost: { kind: 'list', from: 'ghost' },
        },
        home: 'orders',
        nav: ['orders', { id: 'directory', label: 'Directory', children: ['customers'] }, 'ghost'],
        pages: { 'work-order': { base: 'work_order' } },
      }),
    );
    const loaded = await loadApp(dir);

    const registry = new Registry();
    registry.add({ name: 'appdb', url: db, source: 'config' });
    registry.setActive('appdb');
    await registry.open('appdb');

    const bound = { host: '127.0.0.1', port: 0 };
    server = createApp({ registry, pages: mergeAppPages([], loaded), apps: [{ app: loaded, pages: [] }], bound });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
    bound.port = port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(tmp, { recursive: true, force: true });
  });

  const get = async (path: string): Promise<any> => (await fetch(`http://127.0.0.1:${port}${path}`)).json();

  test('answers the authored app identity with resolved navigation', async () => {
    const got = await get('/api/app?app=field-ops');
    assert.equal(got.appId, 'field-ops');
    assert.equal(got.connection, undefined);
    assert.equal(got.app.name, 'Field Ops');
    const { orders, customers, ghost } = got.app.views;
    // The label the author did not write comes from the schema, server-side.
    assert.deepEqual(orders, { table: 'work_order', label: 'Work order' });
    assert.deepEqual(customers, { table: 'customer', label: 'Customers' });
    assert.match(ghost.error, /no table "ghost"/);
    /* The menu is nav as written, each reference carrying its word. */
    assert.deepEqual(got.app.nav, [
      { view: 'orders', label: 'Work order' },
      { group: 'directory', label: 'Directory', children: [{ view: 'customers', label: 'Customers' }] },
      { view: 'ghost', label: 'ghost' },
    ]);
  });

  test('the app rides the ordinary pages surface, indistinguishably', async () => {
    const got = await get('/api/pages?app=field-ops');
    const page = got.pages.find((p: PageDef) => p.id === 'work-order');
    assert.ok(page, 'the app page is listed as a config page');
    assert.equal(page.source, 'config');
    assert.equal(page.error, undefined);
  });

  test('a server with no app answers null, not an error', async () => {
    const bare = createApp({
      registry: await (async () => {
        const r = new Registry();
        r.add({ name: 'appdb', url: join(tmp, 'app.db'), source: 'config' });
        r.setActive('appdb');
        await r.open('appdb');
        return r;
      })(),
      bound: { host: '127.0.0.1', port: 0 },
    });
    await new Promise<void>((resolve) => bare.listen(0, '127.0.0.1', resolve));
    const barePort = (bare.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${barePort}/api/app?conn=appdb`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { connection: 'appdb', app: null });
    } finally {
      await new Promise((resolve) => bare.close(resolve));
    }
  });
});

test('display rules take a meter, an avatar and a second line, and refuse their wrong shapes', () => {
  const app = parseAppConfig(
    {
      ...START,
      name: 'x',
      resources: {
        work_order: {
          display: {
            hours: { format: 'number', bar: 40, tone: { '>= 32': 'bad' } },
            name: { avatar: true, subtitle: 'status' },
          },
        },
      },
    },
    WHERE,
  );
  assert.deepEqual(app.resources?.work_order.display, {
    hours: { format: 'number', tone: { '>= 32': 'bad' }, bar: true, max: 40 },
    name: { avatar: true, subtitle: 'status' },
  });
  const refused = (rule: Record<string, unknown>, message: RegExp) =>
    assert.throws(() => parseAppConfig({ ...START, name: 'x', resources: { t: { display: { c: rule } } } }, WHERE), message);
  // The bar's scale is its value: one key, never a bar and a max beside it.
  refused({ format: 'number', bar: true }, /"bar: true" with no scale/);
  refused({ bar: 0 }, /"bar" that is not true \(a percent, against 100\) or the number that fills it/);
  refused({ format: 'percent', bar: 10 }, /"bar: 10" beside format "percent", which draws against 100; say bar: true/);
  refused({ bar: 5, max: 5 }, /has no "max"/);
  refused({ avatar: 'yes' }, /"avatar" that is not true, false or \{ from, whose \}/);
  refused({ subtitle: 'account.name' }, /"subtitle" that is not one of the resource's own columns/);
  refused({ sparkline: true }, /It takes: format, currency, minor, unit, tone, bar, avatar, icons, values, subtitle/);
});

test('a list view takes totals over its own numeric columns and a density, and refuses their wrong shapes', () => {
  const base = { ...START, name: 'x', resources: { work_order: {} } };
  const app = parseAppConfig(
    { ...base, views: { orders: { kind: 'list', from: 'work_order', totals: ['hours'], density: 'compact' } }, home: 'orders' },
    WHERE,
  );
  assert.deepEqual(app.views.orders, { table: 'work_order', totals: ['hours'], density: 'compact' });
  const refused = (view: Record<string, unknown>, message: RegExp) =>
    assert.throws(
      () => parseAppConfig({ ...base, views: { orders: { kind: 'list', from: 'work_order', ...view } }, home: 'orders' }, WHERE),
      message,
    );
  refused({ density: 'tight' }, /"density" of "tight". Use "comfortable" or "compact"/);
  refused({ totals: [] }, /"totals" that are not a list of the resource's own numeric columns/);
  refused({ totals: ['account.amount'] }, /"totals" that are not a list of the resource's own numeric columns/);
  refused({ totals: ['hours', 'hours'] }, /"totals" that name one column twice/);
  refused({ totals: ['hours'], presentation: { kind: 'queue', primary: 'name' } }, /a footer of totals belongs to a grid/);
});
