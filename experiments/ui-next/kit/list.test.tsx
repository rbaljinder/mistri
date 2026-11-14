import { act } from 'react';
import { afterEach, expect, test } from 'vitest';
import type { Column } from '../src/DataTable';
import { type ListState } from '../src/listState';
import { ListView } from '../src/ListView';
import { Mark } from '../src/Mark';
import { all, clear, draw, key, labelled } from './testing';

afterEach(clear);

type Home = { code: string; building: string; rent: number; status: string };
const HOMES: Home[] = [
  { code: 'AC-101', building: 'Alder Court', rent: 1285, status: 'Occupied' },
  { code: 'AC-102', building: 'Alder Court', rent: 1495, status: 'Vacant' },
  { code: 'BH-101', building: 'Birch House', rent: 1325, status: 'Occupied' },
  { code: 'BH-102', building: 'Birch House', rent: 1535, status: 'Vacant' },
  { code: 'CM-101', building: 'Cedar Mews', rent: 1610, status: 'Occupied' },
];
const COLUMNS: Column<Home>[] = [
  { id: 'code', header: 'Code', primary: true, cell: (home) => <Mark>{home.code}</Mark>, sort: (home) => home.code },
  { id: 'building', header: 'Building', cell: (home) => <Mark>{home.building}</Mark>, sort: (home) => home.building },
  { id: 'rent', header: 'Rent', align: 'end', cell: (home) => `$${home.rent}`, sort: (home) => home.rent },
  { id: 'status', header: 'Status', cell: (home) => home.status },
];

function Roll(props: {
  initialState?: Partial<ListState>;
  heard?: (state: ListState) => void;
  onOpen?: (home: Home) => void;
  current?: string;
  pageSize?: number;
}) {
  return (
    <ListView<Home>
      title="Rent roll"
      columns={COLUMNS}
      rows={HOMES}
      rowKey={(home) => home.code}
      rowName={(home) => home.code}
      searchText={(home) => `${home.code} ${home.building}`}
      tabs={[
        { value: 'all', label: 'All' },
        { value: 'vacant', label: 'Vacant', match: (home) => home.status === 'Vacant' },
      ]}
      filters={[{ id: 'building', label: 'Building', value: (home) => home.building }]}
      bulkActions={[{ value: 'export', label: 'Export' }]}
      initialState={props.initialState}
      onStateChange={props.heard}
      onOpen={props.onOpen}
      current={props.current}
      pageSize={props.pageSize}
    />
  );
}

const codes = () => [...document.querySelectorAll('tbody tr[data-key]')].map((row) => row.getAttribute('data-key'));
const heads = () => [...document.querySelectorAll('thead [data-slot="widths-column"]')].map((head) => head.textContent?.trim());
const press = (part: Element, more: MouseEventInit = {}) =>
  act(() => part.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...more })));
const type = (box: HTMLInputElement, text: string) =>
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    set?.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });

test('a list starts from the place it is handed: its tab, its search, its order, its columns', () => {
  draw(
    <Roll initialState={{ tab: 'vacant', search: 'birch', sort: { column: 'rent', descending: true }, columns: ['code', 'building'] }} />,
  );
  expect(codes()).toEqual(['BH-102']);
  expect(all('tab').find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent).toContain('Vacant');
  expect(document.querySelector<HTMLInputElement>('[data-kind="search"] input')?.value).toBe('birch');
  expect(heads()).toEqual(['Code', 'Building']);
  // What the search matched is marked in the row that is still there.
  expect([...document.querySelectorAll('tbody mark')].map((mark) => mark.textContent)).toEqual(['Birch']);
});

test('a place that names a tab the list does not have falls back to its first', () => {
  draw(<Roll initialState={{ tab: 'gone' }} />);
  expect(codes().length).toBe(5);
});

test('every change of place is told, and the first draw is not one', () => {
  const heard: ListState[] = [];
  draw(<Roll heard={(state) => heard.push(state)} />);
  expect(heard).toEqual([]);
  type(document.querySelector<HTMLInputElement>('[data-kind="search"] input')!, 'alder');
  expect(codes()).toEqual(['AC-101', 'AC-102']);
  expect(heard.at(-1)).toMatchObject({ tab: 'all', search: 'alder', page: 1 });
  // An untouched table says nothing of its columns.
  expect(heard.at(-1)?.columns).toBeNull();
});

test('a column sorts on a press of its head, and turns round on the next', () => {
  draw(<Roll />);
  const rent = [...document.querySelectorAll<HTMLElement>('thead button')].find((button) => button.textContent?.includes('Rent'))!;
  press(rent);
  expect(codes()).toEqual(['AC-101', 'BH-101', 'AC-102', 'BH-102', 'CM-101']);
  expect(rent.closest('th')?.getAttribute('aria-sort')).toBe('ascending');
  press(rent);
  expect(codes()[0]).toBe('CM-101');
  expect(rent.closest('th')?.getAttribute('aria-sort')).toBe('descending');
});

test('a Shift-press takes the run of rows between it and the last one ticked', () => {
  draw(<Roll />);
  const boxes = () => [...document.querySelectorAll<HTMLElement>('tbody [data-cell="select"] [role="checkbox"]')];
  press(boxes()[0]!);
  press(boxes()[3]!, { shiftKey: true });
  expect([...document.querySelectorAll('tbody tr[data-selected]')].map((row) => row.getAttribute('data-key'))).toEqual([
    'AC-101',
    'AC-102',
    'BH-101',
    'BH-102',
  ]);
  expect(document.querySelector('[data-slot="bulk-count"]')?.textContent).toBe('4 selected');
  press(labelled('Clear selection'));
  expect(document.querySelector('[data-slot="bulk-bar"]')).toBeNull();
});

test('the arrows walk the rows from a row’s name, and a search with nothing in it offers the way out', () => {
  draw(<Roll onOpen={() => {}} />);
  const links = () => [...document.querySelectorAll<HTMLElement>('tbody td[data-primary] a')];
  act(() => links()[0]!.focus());
  key(links()[0]!, 'ArrowDown');
  expect(document.activeElement).toBe(links()[1]);
  key(links()[1]!, 'ArrowUp');
  expect(document.activeElement).toBe(links()[0]);
  type(document.querySelector<HTMLInputElement>('[data-kind="search"] input')!, 'zzz');
  expect(codes()).toEqual([]);
  const out = [...document.querySelectorAll<HTMLElement>('[data-slot="list-empty"] button')][0]!;
  expect(out.textContent).toBe('Clear search and filters');
  press(out);
  expect(codes().length).toBe(5);
});

test('the row a panel shows is marked, and the list turns to its page', () => {
  draw(<Roll current="CM-101" pageSize={2} onOpen={() => {}} />);
  expect(codes()).toEqual(['CM-101']);
  expect(document.querySelector('tr[data-current]')?.getAttribute('data-key')).toBe('CM-101');
});
