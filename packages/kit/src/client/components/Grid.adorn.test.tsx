/** A grid's `adornCell`: an empty cell draws what the host returns in place of its empty mark; a filled cell never asks. */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { cleanup, render, screen } from '@testing-library/react';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';
import { columnKind, labelColumn as sharedLabel, primaryKey as sharedPk } from '../../../../engine/src/shared/schema.js';

const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const lead: TableMeta = {
  id: 'lead',
  name: 'lead',
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [col('id', 'INTEGER', { primaryKey: true, nullable: false }), col('name', 'TEXT'), col('owner', 'TEXT')] as TableMeta['columns'],
};

vi.mock('../core.js', () => ({
  state: { activeConnection: 'demo', schema: { tables: [lead], foreignKeys: [] } },
  api: async () => ({}),
  findTable: () => lead,
  refsTo: () => [],
  keyOf: (_t: TableMeta, row: Record<string, unknown>) => ({ id: row.id }),
  rowLabel: (_t: TableMeta, row: Record<string, unknown>) => String(row.name),
  openRecord: () => {},
  peekRecord: () => {},
  go: () => {},
  currentEntry: () => ({ kind: 'table', table: 'lead', query: 'lead' }),
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
  viewportSize: () => ({ width: 1000, height: 800 }),
}));
vi.mock('../thmenu.js', () => ({ openFilterMenu: () => {}, sortBy: () => {} }));
beforeEach(bridgeShell);
afterEach(cleanup);

const { Grid } = await import('./Grid.js');
const data = {
  table: 'lead',
  columns: ['id', 'name', 'owner'],
  rows: [
    { id: 1, name: 'Stone', owner: null },
    { id: 2, name: 'Marsh', owner: 'Ada' },
  ],
  total: 2,
  ms: 1,
};

test('an empty cell draws what adornCell returns in place of its empty mark', () => {
  const asked: Array<[unknown, string]> = [];
  const adornCell = (row: Record<string, unknown>, column: string) => {
    asked.push([row.id, column]);
    return column === 'owner' ? <span data-testid="mark">Ada, likely</span> : undefined;
  };
  render(<Grid table={lead} data={data} interactive={false} adornCell={adornCell} />);
  const mark = screen.getByTestId('mark');
  expect(mark.closest('td')!.textContent).toBe('Ada, likely');
  expect(mark.closest('tr')).toHaveTextContent('Stone');
  // Only the one empty cell is asked; the filled owner is not.
  expect(asked).toEqual([[1, 'owner']]);
  expect(screen.getAllByTestId('mark')).toHaveLength(1);
  expect(screen.getByText('Ada', { selector: 'td *, td' })).toBeInTheDocument();
});

test('an empty cell the host has nothing for keeps its empty mark', () => {
  render(<Grid table={lead} data={data} interactive={false} adornCell={() => undefined} />);
  expect(screen.getByText('—')).toBeInTheDocument();
});
