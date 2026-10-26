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
});
