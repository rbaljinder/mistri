/**
 * What a dashboard section does when it has nothing, and what check says of a record page that draws a run of empty
 * lists: it is left out with `empty: 'hide'`; a rows section may say so in
 * place with guidance; `'collapse'` is a record page's related lists, and `false` is now `'hide'`.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseAppConfig, type AppDashboardView } from '../packages/mistri/src/shared/app.js';
import { appAdvisories, type LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

function app(sections: object[]) {
  return parseAppConfig(
    {
      name: 'Sales',
      resources: { deal: {} },
      views: { deals: { kind: 'list', from: 'deal' }, board: { kind: 'dashboard', label: 'Board', sections } },
      home: 'board',
      nav: ['board', 'deals'],
    },
    'empty',
  );
}

describe("a dashboard section's `empty`", () => {
  test("'hide' is kept on a breakdown, rows, chart, matrix and board", () => {
    const parsed = app([
      { kind: 'breakdown', from: 'deal', by: 'status', empty: 'hide' },
      { kind: 'rows', from: 'deal', empty: 'hide' },
      { kind: 'chart', from: 'deal', by: 'status', shape: 'donut', empty: 'hide' },
      { kind: 'matrix', from: 'deal', by: 'status, region', empty: 'hide' },
    ]);
    const kept = (parsed.views.board as unknown as AppDashboardView).sections.map((s) => (s as { emptyMode?: string }).emptyMode);
    assert.deepEqual(kept, ['hide', 'hide', 'hide', 'hide']);
  });

  test("`empty: false` is refused with what replaces it, and 'collapse' with where it belongs", () => {
    assert.throws(() => app([{ kind: 'breakdown', from: 'deal', by: 'status', empty: false }]), /now "empty: 'hide'"/);
    assert.throws(() => app([{ kind: 'rows', from: 'deal', empty: 'collapse' }]), /only a record page's related lists/);
  });

  test('guidance belongs to a rows section; any other section takes only hide', () => {
    assert.throws(() => app([{ kind: 'breakdown', from: 'deal', by: 'status', empty: { title: 'None' } }]), /takes "empty: 'hide'"/);
  });

  test('a metric has no `empty`', () => {
    assert.throws(() => app([{ kind: 'metric', from: 'deal', measure: 'count', empty: 'hide' }]), /empty/);
  });
});

/* A list's tab could not say what it says while empty, and a dashboard's embed of a list could not either: check
   refused `empty` on both, so an embed over an empty tab drew a bare "No deals right now". */
describe("an embedded list's and a tab's `empty`", () => {
  const listEmpty = { title: 'No deals yet', description: 'Deals you log land here.' };
  const openEmpty = { title: 'Nothing open', description: 'Every deal is closed.' };
  function embedding(section: object, list: object = {}) {
    const parsed = parseAppConfig(
      {
        name: 'Sales',
        resources: {
          deal: { segments: { open: { query: 'status = open', label: 'Open' }, won: { query: 'status = won', label: 'Won' } } },
        },
        views: {
          deals: {
            kind: 'list',
            from: 'deal',
            empty: listEmpty,
            tabs: [{ segment: 'open', empty: openEmpty }, 'won'],
            ...list,
          },
          board: { kind: 'dashboard', label: 'Board', sections: [{ kind: 'view', view: 'deals', ...section }] },
        },
        home: 'board',
        nav: ['board', 'deals'],
      },
      'empty',
    );
    return parsed;
  }
  const first = (parsed: ReturnType<typeof embedding>) =>
    (parsed.views.board as unknown as AppDashboardView).sections[0] as { empty?: object; emptyMode?: string };

  test('a tab keeps its own guidance', () => {
    const tabs = (embedding({}).views.deals as { tabs?: Array<{ empty?: object }> }).tabs!;
    assert.deepEqual(tabs[0].empty, openEmpty);
    assert.equal(tabs[1].empty, undefined);
  });

  test("an embed says its own guidance, else its tab's, else on the first tab the list's", () => {
    assert.deepEqual(first(embedding({ empty: { title: 'Quiet week' } })).empty, { title: 'Quiet week' });
    assert.deepEqual(first(embedding({})).empty, openEmpty);
    assert.deepEqual(first(embedding({}, { tabs: ['open'] })).empty, listEmpty);
    assert.equal(first(embedding({ listTab: 'won' })).empty, undefined);
    const hidden = first(embedding({ empty: 'hide' }));
    assert.equal(hidden.emptyMode, 'hide');
    assert.equal(hidden.empty, undefined);
  });

  test("a board embed takes only hide, and a tab's guidance is checked as a list's", () => {
    const board = { board: { by: 'status', primary: 'name' }, tabs: undefined };
    assert.throws(() => embedding({ empty: { title: 'None' } }, board), /takes "empty: 'hide'"/);
    assert.equal(first(embedding({ empty: 'hide' }, board)).emptyMode, 'hide');
    assert.throws(() => embedding({}, { tabs: [{ segment: 'open', empty: { description: 'No title' } }] }), /title/);
  });
});

describe('[empty-run]', () => {
  const schema = { label: 'Sales', dialect: 'sqlite', readAt: '', foreignKeys: [], tables: [] } as unknown as DatabaseSchema;
  const lists = (n: number, extra: object = {}) =>
    Array.from({ length: n }, (_, i) => ({ kind: 'list', from: `child${i}`, whose: 'deal_id', ...extra }));
  const advice = (page: object) =>
    appAdvisories(
      {
        path: 'sales.ts',
        app: parseAppConfig(
          { name: 'Sales', resources: { deal: {} }, views: { deals: { kind: 'list', from: 'deal' } }, home: 'deals', nav: ['deals'] },
          'run',
        ),
        pages: parsePagesConfig({ pages: [{ id: 'deal', label: 'Deal', base: 'deal', ...page }] }, 'pages'),
        sources: {},
      } as unknown as LoadedApp,
      schema,
    ).filter((line) => /empty-run/.test(line));

  test('three related lists in a row that say nothing of empty are advised, two are not', () => {
    assert.equal(advice({ sections: lists(3) }).length, 1);
    assert.equal(advice({ sections: lists(2) }).length, 0);
  });

  test("a page's empty, a list's own, or a strip of tabs settles it", () => {
    assert.equal(advice({ empty: 'collapse', sections: lists(4) }).length, 0);
    assert.equal(advice({ sections: lists(4, { empty: 'hide' }) }).length, 0);
    assert.equal(advice({ listTabs: true, sections: lists(4) }).length, 0);
  });

  test("a current() card takes the advice's own words: empty: 'hide' loads and settles the run", () => {
    const cards = (extra: object = {}) =>
      Array.from({ length: 3 }, (_, i) => ({ kind: 'current', from: `child${i}`, whose: 'deal_id', ...extra }));
    assert.equal(advice({ sections: cards() }).length, 1);
    assert.match(advice({ sections: cards() })[0], /empty: 'hide'/);
    assert.equal(advice({ sections: cards({ empty: 'hide' }) }).length, 0);
    assert.throws(() => advice({ sections: cards({ empty: 'collapse' }) }), /current\(\) card/);
  });
});
