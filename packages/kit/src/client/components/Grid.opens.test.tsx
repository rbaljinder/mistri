/**
 * A join table's list opens the record each row is about (a view's `opens`): a row of Watching, a list of
 * `ticket_watcher`, opens the ticket being watched, by its name, and not the watcher row.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';
import { columnKind, labelColumn as sharedLabel, primaryKey as sharedPk } from '../../../../engine/src/shared/schema.js';

const opened = vi.hoisted(() => [] as unknown[][]);
const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const watcher: TableMeta = {
  id: 'ticket_watcher',
  name: 'ticket_watcher',
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [
    col('id', 'INTEGER', { primaryKey: true, nullable: false }),
    col('ticket_id', 'INTEGER', { references: { table: 'ticket', column: 'id' } }),
    col('ticket_id.number', 'TEXT'),
  ] as TableMeta['columns'],
};

vi.mock('../core.js', () => ({
  state: { activeConnection: 'desk', schema: { tables: [watcher], foreignKeys: [] } },
  api: async () => ({}),
  findTable: () => watcher,
  refsTo: () => [],
  keyOf: (_t: TableMeta, row: Record<string, unknown>) => ({ id: row.id }),
  rowLabel: (_t: TableMeta, row: Record<string, unknown>) => `Watcher ${String(row.id)}`,
  openRecord: (...args: unknown[]) => opened.push(args),
  peekRecord: () => {},
  go: () => {},
  currentEntry: () => ({ kind: 'table', table: 'ticket_watcher', query: 'ticket_watcher' }),
  prefersPages: () => true,
  emptyWord: () => '—',
  columnDisplay: () => null,
  columnLabel: () => null,
  columnKind,
  labelColumn: sharedLabel,
  primaryKey: sharedPk,
  loadJson: () => ({}),
  saveJson: () => {},
  viewportBox: (n: Element) => n.getBoundingClientRect(),
}));
vi.mock('../thmenu.js', () => ({ openFilterMenu: () => {}, sortBy: () => {} }));

const { Grid } = await import('./Grid.js');
const { RowOpensContext, rowOpensTarget } = await import('./rowOpens.js');

afterEach(() => {
  cleanup();
  opened.length = 0;
});

const data = {
  table: 'ticket_watcher',
  columns: ['id', 'ticket_id', 'ticket_id.number'],
  rows: [
    { id: 1, ticket_id: 9, 'ticket_id.number': 'INC0009' },
    { id: 2, ticket_id: null, 'ticket_id.number': null },
  ],
};

test('a row opens the record its reference names, by its name, with no neighbors to step to', () => {
  const view = render(
    <RowOpensContext.Provider value={{ column: 'ticket_id', label: 'ticket_id.number' }}>
      <Grid table={watcher} data={data} />
    </RowOpensContext.Provider>,
  );
  const rows = view.container.querySelectorAll('tbody tr');
  fireEvent.click(rows[0].querySelector('td:last-child')!);
  expect(opened).toEqual([['ticket', { id: 9 }, 'INC0009', 'push']]);
  // It is not the watcher's page a press begins to read.
  expect(rows[0].getAttribute('data-opens')).toBeNull();
});

test('without opens, the row opens itself', () => {
  const view = render(<Grid table={watcher} data={data} />);
  fireEvent.click(view.container.querySelector('tbody tr td:last-child')!);
  expect(opened[0]?.slice(0, 3)).toEqual(['ticket_watcher', { id: 1 }, 'Watcher 1']);
});

test('an empty reference opens nothing, rather than the row', () => {
  expect(rowOpensTarget(watcher, data.rows[1], { column: 'ticket_id' })).toBeNull();
  expect(rowOpensTarget(watcher, { id: 3, ticket_id: 4 }, { column: 'ticket_id' })).toEqual({
    table: 'ticket',
    key: { id: 4 },
    label: '4',
  });
});
