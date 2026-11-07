import { expect, test } from 'vitest';
import { directorySections, filterDirectory } from './directoryModel.js';
import type { ShownApp } from './appRooms.js';

/* Thirteen places: the menu's top level, two groups (one inside another), a link elsewhere, and a room nav does not name. */
const views = Object.fromEntries(
  ['today', 'units', 'leases', 'residents', 'viewings', 'ledger', 'payments', 'repairs', 'parts', 'deliveries', 'listings', 'archive'].map(
    (key) => [key, { table: key, label: key.charAt(0).toUpperCase() + key.slice(1) }],
  ),
);
const app = {
  views,
  resources: {},
  ui: {},
  nav: [
    { view: 'today', label: 'Today' },
    { view: 'listings', label: 'Listings' },
    {
      group: 'leasing',
      label: 'Leasing',
      children: [
        { view: 'units', label: 'Units' },
        { view: 'leases', label: 'Leases' },
      ],
    },
    {
      group: 'books',
      label: 'Books',
      children: [
        { view: 'ledger', label: 'Ledger' },
        { group: 'in', label: 'Money in', children: [{ view: 'payments', label: 'Payments' }] },
      ],
    },
    { label: 'Help desk', to: { app: 'help', kind: 'home' } },
  ],
} as unknown as ShownApp;

test('every place, grouped as the menu groups it: the top level first, a nested group read into its parent, then the rest', () => {
  const sections = directorySections(app, () => '/help');
  expect(sections.map((section) => [section.label, section.lines.map((line) => line.label)])).toEqual([
    [undefined, ['Today', 'Listings', 'Help desk']],
    ['Leasing', ['Units', 'Leases']],
    ['Books', ['Ledger', 'Payments']],
    ['More', ['Residents', 'Viewings', 'Repairs', 'Parts', 'Deliveries', 'Archive']],
  ]);
  expect(sections[0]!.lines.map((line) => line.kind)).toEqual(['list', 'list', 'link']);
  expect(sections[0]!.lines[2]!.href).toBe('/help');
});

test('the filter is the palette’s matcher: a name, a prefix, initials, or the group a place is under', () => {
  const sections = directorySections(app, () => '/help');
  const names = (query: string) =>
    filterDirectory(sections, query).map((section) => [section.label, section.lines.map((line) => line.label)]);
  expect(names('pay')).toEqual([['Books', ['Payments']]]);
  // The group's word keeps its rows, at half weight: "Leases" outranks nothing it should not.
  expect(names('leasing')).toEqual([['Leasing', ['Units', 'Leases']]]);
  expect(names('del')).toEqual([['More', ['Deliveries']]]);
  expect(names('zzz')).toEqual([]);
  expect(filterDirectory(sections, '  ')).toEqual(sections);
});
