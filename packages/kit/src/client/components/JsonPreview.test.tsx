/**
 * A JSON document in the result grid and in a field: the grid says it in
 * one line and opens the whole document over itself — on a click or on the
 * cursor's Enter — without opening the row under it; a field lays it out
 * inline, and a compact field says the line.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';
import { columnKind, labelColumn as sharedLabel, primaryKey as sharedPk } from '../../../../engine/src/shared/schema.js';

const opened: unknown[] = [];
const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const event: TableMeta = {
  id: 'event',
  name: 'event',
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [
    col('id', 'integer', { primaryKey: true, nullable: false }),
    col('payload', 'jsonb'),
    col('raw', 'JSON'),
  ] as TableMeta['columns'],
};

vi.mock('../core.js', () => ({
  state: { activeConnection: 'demo', schema: { tables: [event], foreignKeys: [] } },
  api: async () => ({}),
  findTable: () => event,
  refsTo: () => [],
  refsFrom: () => [],
  keyOf: (_table: TableMeta, row: Record<string, unknown>) => (row.id === undefined ? null : { id: row.id }),
  rowLabel: (_table: TableMeta, row: Record<string, unknown>) => String(row.id),
  openRecord: (...args: unknown[]) => opened.push(args),
  go: () => {},
  tableView: (table: string, query: string) => ({ kind: 'table', table, query }),
  quote: (v: unknown) => String(v),
  currentEntry: () => ({ kind: 'table', table: 'event', query: 'event' }),
  prefersPages: () => false,
  emptyWord: () => 'null',
  formatLocale: () => 'en-US',
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
const { Value } = await import('./Value.js');

const rows = [
  { id: 1, payload: { kind: 'signup', user: { id: 7, name: 'Ada' }, tags: ['new'] }, raw: '[{"sku":"A","qty":2},{"sku":"B","qty":1}]' },
  { id: 2, payload: null, raw: 'not json' },
];
const draw = () => render(<Grid table={event} data={{ columns: ['id', 'payload', 'raw'], rows }} />);

afterEach(() => {
  cleanup();
  opened.length = 0;
});

describe('in the grid', () => {
  test('a document is one line that says its shape; JSON text in a JSON column is read, other text is not', () => {
    draw();
    expect(screen.getByRole('button', { name: '{ kind, user, tags }' })).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('button', { name: '[2 items]' })).toBeInTheDocument();
    expect(screen.getByText('not json').tagName).toBe('TD');
    expect(document.body.textContent).not.toContain('[object Object]');
  });

  test('a click opens the whole document over the grid, and neither that click nor one inside opens the row', async () => {
    draw();
    await userEvent.click(screen.getByRole('button', { name: '{ kind, user, tags }' }));
    const dialog = await screen.findByRole('dialog', { name: 'payload (JSON)' });
    expect(within(dialog).getByText('signup')).toBeInTheDocument();
    expect(within(dialog).getByText('jsonb')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByText('signup'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Raw' }));
    expect(opened).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test("Enter on a document's cell opens the document; Enter on any other cell still opens the row", async () => {
    draw();
    const table = screen.getByRole('grid');
    act(() => table.focus());
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toHaveClass('json-cell');
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: 'payload (JSON)' })).toBeInTheDocument();
    expect(opened).toEqual([]);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();

    act(() => table.focus());
    await userEvent.keyboard('{ArrowLeft}{Enter}');
    expect(opened).toHaveLength(1);
  });
});

describe('in a field', () => {
  test('a document is laid out inline; a compact field says the one line', () => {
    const payload = col('payload', 'jsonb') as TableMeta['columns'][number];
    const { container } = render(
      <>
        <Value col={payload} value={rows[0].payload} />
        <Value col={payload} value={rows[0].payload} compact />
      </>,
    );
    expect(container.querySelectorAll('.json-view')).toHaveLength(1);
    expect(screen.getByText('signup')).toBeInTheDocument();
    expect(screen.getByText('{ kind, user, tags }')).toHaveClass('json-preview-text');
  });

  test('a scalar in a JSON column is said as the scalar it is', () => {
    render(<Value col={col('payload', 'jsonb') as TableMeta['columns'][number]} value="plain words" />);
    expect(screen.getByText('plain words')).toBeInTheDocument();
    expect(document.querySelector('.json-view')).toBeNull();
  });
});
