/**
 * What a keystroke costs the grid under it.
 *
 * A list's search box lives in the room that draws the grid, so every
 * character typed redraws the room — and once redrew every cell on the page:
 * typing "acme" over 250 rows was 3,764 component renders, and a keystroke on
 * a phone-class CPU took 88 ms where 20 rows took 24. A redraw that changes
 * nothing in the rows must now draw no cell at all, however many there are.
 * Cells are counted where each one reads its value (jsonModel's
 * `jsonValueOf`, once per drawn cell).
 */
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';
import { columnKind, labelColumn as sharedLabel, primaryKey as sharedPk } from '../../../../engine/src/shared/schema.js';

const counted = { cells: 0 };
vi.mock('./jsonModel.js', async (actual) => {
  const real = await actual<typeof import('./jsonModel.js')>();
  return {
    ...real,
    jsonValueOf: (...args: Parameters<typeof real.jsonValueOf>) => {
      counted.cells += 1;
      return real.jsonValueOf(...args);
    },
  };
});

const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const lead: TableMeta = {
  id: 'lead',
  name: 'lead',
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [
    col('id', 'INTEGER', { primaryKey: true, nullable: false }),
    col('name', 'TEXT'),
    col('stage', 'TEXT'),
    col('value', 'NUMERIC'),
  ] as TableMeta['columns'],
};
const rules: Record<string, unknown> = { stage: { tones: { open: 'info', won: 'good' } }, value: { format: 'money', currency: 'USD' } };

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
  columnDisplay: (_table: string, name: string) => rules[name] ?? null,
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

afterEach(cleanup);

/** A room: a search box the reader types in, above a grid of `count` rows. */
function Room({ count, onRowClick }: { count: number; onRowClick?: boolean }) {
  const [typed, setTyped] = useState('');
  const [data] = useState(() => ({
    table: 'lead',
    columns: ['id', 'name', 'stage', 'value'],
    rows: Array.from({ length: count }, (_, i) => ({ id: i + 1, name: `Lead ${i + 1}`, stage: i % 2 ? 'open' : 'won', value: 1000 + i })),
  }));
  return (
    <>
      <input aria-label="Search" value={typed} onChange={(e) => setTyped(e.target.value)} />
      {/* A caller that hands a fresh callback on every paint, as rooms do. */}
      <Grid table={lead} data={data} onRowClick={onRowClick ? () => {} : undefined} interactive={false} />
    </>
  );
}

async function cellsPerKeystroke(count: number, onRowClick = false): Promise<number> {
  const view = render(<Room count={count} onRowClick={onRowClick} />);
  expect(view.container.querySelectorAll('tbody tr')).toHaveLength(count);
  const box = view.getByRole('textbox', { name: 'Search' }) as HTMLInputElement;
  counted.cells = 0;
  for (const text of ['a', 'ac', 'acm', 'acme']) {
    await act(async () => {
      fireEvent.change(box, { target: { value: text } });
    });
  }
  // The room did redraw: the box is controlled, and says what was typed.
  expect(box.value).toBe('acme');
  const perKey = counted.cells / 4;
  view.unmount();
  return perKey;
}

test('typing above a grid redraws no cell, at 20 rows or 250', async () => {
  expect(await cellsPerKeystroke(20)).toBe(0);
  expect(await cellsPerKeystroke(250)).toBe(0);
  // A caller's fresh row callback on every paint changes nothing either.
  expect(await cellsPerKeystroke(250, true)).toBe(0);
});

test('a refetch that changed one row redraws that row, not the page', async () => {
  function Changing({ count }: { count: number }) {
    const [rows, setRows] = useState(() =>
      Array.from({ length: count }, (_, i) => ({ id: i + 1, name: `Lead ${i + 1}`, stage: 'open', value: i })),
    );
    return (
      <>
        <button type="button" onClick={() => setRows((was) => was.map((row, i) => (i === 3 ? { ...row, stage: 'won' } : row)))}>
          Win
        </button>
        <Grid table={lead} data={{ table: 'lead', columns: ['id', 'name', 'stage', 'value'], rows }} interactive={false} />
      </>
    );
  }
  const cost = async (count: number) => {
    const view = render(<Changing count={count} />);
    counted.cells = 0;
    await act(async () => {
      view.getByRole('button', { name: 'Win' }).click();
    });
    expect(view.container.querySelectorAll('tbody tr')[3].textContent).toContain('won');
    view.unmount();
    return counted.cells;
  };
  /* Column sizing re-reads a fixed sample of the rows; past that, the one
     changed cell. The same at 50 rows as at 250. */
  const fifty = await cost(50);
  expect(await cost(250)).toBe(fifty);
  expect(fifty).toBeLessThan(250);
});

test('a sorted response with fresh row objects does not redraw unchanged plain cells', async () => {
  function Sorting({ count }: { count: number }) {
    const [rows, setRows] = useState(() =>
      Array.from({ length: count }, (_, i) => ({ id: i + 1, name: `Lead ${i + 1}`, stage: 'open', value: i })),
    );
    return (
      <>
        <button type="button" onClick={() => setRows((was) => [...was].reverse().map((row) => ({ ...row })))}>
          Sort
        </button>
        <Grid table={lead} data={{ table: 'lead', columns: ['id', 'name', 'stage', 'value'], rows }} interactive={false} />
      </>
    );
  }
  const cost = async (count: number) => {
    const view = render(<Sorting count={count} />);
    counted.cells = 0;
    await act(async () => {
      view.getByRole('button', { name: 'Sort' }).click();
    });
    expect(view.container.querySelector('tbody tr')?.textContent).toContain(`Lead ${count}`);
    const drawn = counted.cells;
    view.unmount();
    return drawn;
  };
  // Sizing inspects its bounded sample; changed identities alone must not
  // redraw every value. Custom renderers and editors still receive the row.
  const fifty = await cost(50);
  expect(await cost(250)).toBe(fifty);
  expect(fifty).toBeLessThan(250);
});

test('a lead icon stands before the value, in the tone its tone column gives the row, and in the accent where the rule names none', () => {
  const was = { name: rules.name, stage: rules.stage };
  rules.name = { icon: { mark: 'phone', toneOf: 'stage' } };
  rules.stage = { tone: { failed: 'bad' } };
  try {
    const data = {
      table: 'lead',
      columns: ['id', 'name', 'stage'],
      rows: [
        { id: 1, name: 'Lead 1', stage: 'failed' },
        { id: 2, name: 'Lead 2', stage: 'open' },
      ],
    };
    const { container } = render(<Grid table={lead} data={data} interactive={false} />);
    const rows = [...container.querySelectorAll('tbody tr')];
    const marks = rows.map((row) => row.querySelector('.lead-icon'));
    expect(marks.every(Boolean)).toBe(true);
    // The mark comes before the value, which stays the text.
    const lead1 = rows[0].querySelector('.cell-lead')!;
    expect(lead1.firstElementChild).toBe(marks[0]);
    expect(lead1.textContent).toBe('Lead 1');
    expect(marks[0]).toHaveClass('tone-bad');
    expect(marks[1]!.className).not.toMatch(/tone-/);
  } finally {
    rules.name = was.name;
    rules.stage = was.stage;
  }
});
