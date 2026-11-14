import { act, useState } from 'react';
import { afterEach, expect, test } from 'vitest';
import { type Column, DataTable } from '../src/DataTable';
import { EditableText } from '../src/EditableText';
import { clear, draw, focus, key } from './testing';

afterEach(clear);

const settle = () => act(() => new Promise<void>((done) => setTimeout(done, 0)));
const press = (part: Element) => act(() => part.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
const box = () => document.querySelector<HTMLInputElement>('[data-slot="editable-input"]');
/* Types into the box the way a browser does: the element's own setter, then the event the behavior hears. */
const type = (text: string) =>
  act(() => {
    const input = box()!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
const value = () => document.querySelector<HTMLElement>('[data-slot="editable-value"]')!;

/* ---------- one value of a record ---------- */

function Email({ refuse, heard }: { refuse?: string; heard: string[] }) {
  const [email, setEmail] = useState('andre@example.test');
  return (
    <EditableText
      label="Email"
      value={email}
      check={(text) => (text.includes('@') ? undefined : 'That is not an email address.')}
      onSave={(text) => {
        heard.push(text);
        if (refuse) throw new Error(refuse);
        setEmail(text);
      }}
    />
  );
}

test('a value is a button that says what it is, and Enter opens a box in its place', () => {
  draw(<Email heard={[]} />);
  expect([value().getAttribute('role'), value().getAttribute('aria-label')]).toEqual([
    'button',
    'Email: andre@example.test. Press to edit',
  ]);
  focus(value());
  key(value(), 'Enter');
  expect([box()?.value, box()?.getAttribute('aria-label'), value().getAttribute('role')]).toEqual(['andre@example.test', 'Email', null]);
});

test('a text that fails its check never leaves the box, and Escape puts the value back', () => {
  const heard: string[] = [];
  draw(<Email heard={heard} />);
  press(value());
  type('not an address');
  key(box()!, 'Enter');
  expect([box()?.getAttribute('aria-invalid'), document.querySelector('[role="alert"]')?.textContent]).toEqual([
    'true',
    'That is not an email address.',
  ]);
  key(box()!, 'Escape');
  expect([box(), heard, value().textContent]).toEqual([null, [], 'andre@example.test']);
});

test('what is typed is kept on Enter, and nothing is asked when nothing changed', async () => {
  const heard: string[] = [];
  draw(<Email heard={heard} />);
  press(value());
  key(box()!, 'Enter');
  expect(heard).toEqual([]);
  press(value());
  type('andre@lintel.example');
  key(box()!, 'Enter');
  await settle();
  expect([heard, value().textContent]).toEqual([['andre@lintel.example'], 'andre@lintel.example']);
});

test('a save that is refused says why and holds on to what was typed', async () => {
  draw(<Email heard={[]} refuse="That address is on another lease." />);
  press(value());
  type('andre@taken.test');
  key(box()!, 'Enter');
  await settle();
  expect([value().hasAttribute('data-failed'), value().textContent]).toEqual([true, 'andre@taken.testThat address is on another lease.']);
  // The next press takes up from what was typed, and Escape gives the old value back.
  press(value());
  expect(box()?.value).toBe('andre@taken.test');
  key(box()!, 'Escape');
  expect(value().textContent).toBe('andre@example.test');
});

/* ---------- a table's cells ---------- */

type Home = { code: string; rent: number };
const COLUMNS: Column<Home>[] = [
  { id: 'code', header: 'Code', primary: true, cell: (home) => home.code },
  {
    id: 'rent',
    header: 'Rent',
    cell: (home) => `$${home.rent}`,
    edit: { text: (home) => String(home.rent), check: (text) => (/^\d+$/.test(text) ? undefined : 'A whole number.') },
  },
];
function Homes({ heard, opened }: { heard: string[]; opened: string[] }) {
  const [rows, setRows] = useState<Home[]>([
    { code: 'AC-101', rent: 1285 },
    { code: 'AC-102', rent: 1495 },
  ]);
  return (
    <DataTable
      label="Homes"
      columns={COLUMNS}
      rows={rows}
      rowKey={(home) => home.code}
      rowName={(home) => home.code}
      onOpen={(home) => opened.push(home.code)}
      onCellEdit={(home, column, text) => {
        heard.push(`${home.code} ${column} ${text}`);
        setRows((now) => now.map((each) => (each.code === home.code ? { ...each, rent: Number(text) } : each)));
      }}
    />
  );
}
const cells = () => [...document.querySelectorAll<HTMLElement>('tbody [data-slot="editable-value"]')];

test('a press on a cell that can be changed starts on the cell and does not open its row', async () => {
  const heard: string[] = [];
  const opened: string[] = [];
  draw(<Homes heard={heard} opened={opened} />);
  press(cells()[0]!);
  expect([box()?.value, box()?.getAttribute('aria-label'), opened]).toEqual(['1285', 'Rent, AC-101', []]);
  type('1300');
  key(box()!, 'Enter');
  await settle();
  expect([heard, cells()[0]!.textContent]).toEqual([['AC-101 rent 1300'], '$1300']);
});

test('Tab keeps a cell and goes on to the next one that can be changed', async () => {
  const heard: string[] = [];
  draw(<Homes heard={heard} opened={[]} />);
  press(cells()[0]!);
  type('1300');
  key(box()!, 'Tab');
  await settle();
  expect([heard, box()?.getAttribute('aria-label'), box()?.value]).toEqual([['AC-101 rent 1300'], 'Rent, AC-102', '1495']);
});

test('F2 from a row starts on its first cell that can be changed', () => {
  draw(<Homes heard={[]} opened={[]} />);
  const row = document.querySelectorAll<HTMLElement>('tbody tr')[1]!;
  focus(row);
  key(row, 'F2');
  expect(box()?.getAttribute('aria-label')).toBe('Rent, AC-102');
});
