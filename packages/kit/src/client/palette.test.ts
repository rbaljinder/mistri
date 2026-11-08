/**
 * What the palette lists in an App: its rooms under the menu's words, then the rooms nav does not name. A free-form
 * page is a room as a view is; a record's tab page needs a record to be drawn on, so it is not a place to go.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { installShell, resetShell } from './shellMode.js';

const went: unknown[] = [];
vi.mock('./menu.js', () => ({ detailOf: () => undefined, menuItems: () => [], menuMode: () => 'app', whenMenuChanges: () => () => {} }));
vi.mock('./core.js', async (actual) => ({
  ...(await actual<object>()),
  go: (...args: unknown[]) => went.push(args),
}));

const { entries } = await import('./palette.js');

afterEach(() => {
  resetShell();
  went.length = 0;
});

test("a free-form page is listed and opened as a view is; a record's tab page is not listed", () => {
  const page = { reads: ['account'], commands: [], params: [] };
  installShell({
    inApp: () => true,
    app: () =>
      ({
        views: {
          accounts: { table: 'account', label: 'Accounts' },
          forecast: { label: 'Forecast', sections: [], page },
          'accounts-pipeline': {
            label: 'Pipeline',
            sections: [],
            page: { ...page, record: { view: 'accounts', table: 'account', tab: 'pipeline' } },
          },
        },
        nav: [
          {
            group: 'sales',
            label: 'Sales',
            children: [
              { view: 'accounts', label: 'Accounts' },
              { view: 'forecast', label: 'Forecast' },
            ],
          },
        ],
        resources: {},
      }) as never,
  });
  const pages = entries().filter((item) => item.kind === 'page');
  expect(pages.map((item) => [item.label, (item as { room?: string }).room, item.detail])).toEqual([
    ['Accounts', 'accounts', 'Sales'],
    ['Forecast', 'forecast', 'Sales'],
  ]);
  pages[1].run();
  expect(went).toHaveLength(1);
  expect(went[0]).toMatchObject([{ kind: 'page', pageId: 'dash-forecast', label: 'Forecast' }, 'reset']);
});
