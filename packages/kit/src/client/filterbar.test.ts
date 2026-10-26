import { expect, test, vi } from 'vitest';
import { parseAppConfig, type AppListView } from '../../../mistri/src/shared/app.js';

vi.mock('./core.js', () => ({
  columnKind: () => 'text',
  findTable: () => undefined,
  labelColumn: () => undefined,
  looksLikeDateColumn: () => false,
  quote: (value: string) => value,
  state: {},
  toast: () => {},
}));
vi.mock('./prompt.js', () => ({ promptFor: vi.fn() }));

const { listViewFragment } = await import('./filterbar.js');

test('Copy app entry copies a list view the App parser reads, captions on the resource', () => {
  const fragment = listViewFragment(
    { table: 'work_order', query: 'work_order status = open sort due_on desc show reference, customer_id.name as Customer' },
    'work_order',
  );
  const view = fragment.views['work-order'];
  expect(view).toMatchObject({ kind: 'list', from: 'work_order', show: ['reference', 'customer_id.name'] });
  // The question is a segment of the resource, named by the first tab; All comes after it.
  expect('tabs' in view && view.tabs).toEqual([{ segment: 'filtered', sort: 'due_on desc' }, { label: 'All' }]);
  expect(fragment.resources).toEqual({
    work_order: { labels: { 'customer_id.name': 'Customer' }, segments: { filtered: 'status = open' } },
  });

  const app = parseAppConfig({ name: 'Copied', ...fragment, home: 'work-order', nav: ['work-order'] }, 'copied');
  expect(app.views['work-order']).toMatchObject({ table: 'work_order', show: ['reference', 'customer_id.name'] });
  expect(app.resources?.work_order.labels).toEqual({ 'customer_id.name': 'Customer' });
  // The tab asks by the segment's name, its sort kept after it.
  const list = app.views['work-order'] as AppListView;
  expect(list.tabs?.[0]).toMatchObject({ segment: 'filtered' });
  expect(list.tabs?.[0].query).toBe('filtered sort due_on desc');
});

test("a sort alone is the copied list's own sort, with no tab", () => {
  const fragment = listViewFragment({ table: 'customer', query: 'customer sort name' }, 'customer');
  expect(fragment).toEqual({ views: { customer: { kind: 'list', from: 'customer', sort: 'name' } }, resources: { customer: {} } });
  expect(() => parseAppConfig({ name: 'Copied', ...fragment, home: 'customer', nav: ['customer'] }, 'copied')).not.toThrow();
});

test('a plain list copies as a bare list view over its declared resource', () => {
  const fragment = listViewFragment({ table: 'customer', query: 'customer' }, 'customer');
  expect(fragment).toEqual({ views: { customer: { kind: 'list', from: 'customer' } }, resources: { customer: {} } });
  expect(() => parseAppConfig({ name: 'Copied', ...fragment, home: 'customer', nav: ['customer'] }, 'copied')).not.toThrow();
});
