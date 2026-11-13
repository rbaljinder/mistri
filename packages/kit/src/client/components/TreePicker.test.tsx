/**
 * A reference drawn as the hierarchy its parent column makes (`tree: 'parent_id'`): it opens on the records with no
 * parent, each with a caret only where it has children — one breakdown a level, never a read per record — and a
 * branch's children are read when it is opened. The keyboard is the combobox's over a tree: Down and Up move, Right
 * opens and steps in, Left folds and steps out, Home and End, Enter chooses, Escape closes this layer only. Typing
 * searches every level, each match said with its path; the choice is said with its path under the box.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { checkPatterns } from '@mistriwork/ui/conformance.js';
import { TreePicker, type TreeAsk, type TreeValue } from './TreePicker.js';

/* Three levels: Hardware › Laptops › Batteries, and two roots. */
const rows = [
  { id: 1, name: 'Hardware', parent_id: null },
  { id: 2, name: 'Software', parent_id: null },
  { id: 3, name: 'Laptops', parent_id: 1 },
  { id: 4, name: 'Printers', parent_id: 1 },
  { id: 5, name: 'Batteries', parent_id: 3 },
  { id: 6, name: 'Screens', parent_id: 3 },
  { id: 7, name: 'Email', parent_id: 2 },
  { id: 8, name: 'Batteries', parent_id: 4 },
];
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
const listOf = (text: string) => text.split(',').map((part) => Number(part.trim()));

/* The reads the picker makes, answered from the rows above as the server would, and kept to be counted. */
const asked: Array<{ path: string; text: string }> = [];
const ask: TreeAsk = async (path, body) => {
  const text = String(body.q ?? body.text);
  asked.push({ path, text });
  let m: RegExpMatchArray | null;
  if (path === '/api/breakdown' && (m = text.match(/parent_id in \(([^)]*)\) count as children by parent_id$/))) {
    const parents = listOf(m[1]);
    return {
      rows: parents.flatMap((parent) => {
        const children = rows.filter((row) => row.parent_id === parent).length;
        return children ? [{ parent_id: parent, children }] : [];
      }),
    };
  }
  if ((m = text.match(/^category parent_id is empty show/))) return { rows: rows.filter((row) => row.parent_id === null).sort(byName) };
  if ((m = text.match(/^category parent_id = (\d+) show/)))
    return { rows: rows.filter((row) => row.parent_id === Number(m![1])).sort(byName) };
  if ((m = text.match(/^category name contains "([^"]*)" show/)))
    return { rows: rows.filter((row) => row.name.toLowerCase().includes(m![1].toLowerCase())).sort(byName) };
  if ((m = text.match(/^category id in \(([^)]*)\) show/))) return { rows: rows.filter((row) => listOf(m![1]).includes(row.id)) };
  if ((m = text.match(/^category id = (\d+) show/))) return { rows: rows.filter((row) => row.id === Number(m![1])) };
  return { errors: [{ message: `unexpected: ${text}` }] };
};

afterEach(() => {
  cleanup();
  asked.length = 0;
  picked.mockClear();
});

const picked = vi.fn();
function Field({ start = '' }: { start?: TreeValue | '' }) {
  const [value, setValue] = useState<TreeValue | ''>(start);
  return (
    <TreePicker
      from="category"
      by="id"
      labelColumn="name"
      parent="parent_id"
      ask={ask}
      scope="demo"
      value={value}
      ariaLabel="Category"
      onChange={(next, label) => {
        picked(next, label);
        setValue(next);
      }}
    />
  );
}
const draw = (start?: TreeValue | '') =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Field start={start} />
    </QueryClientProvider>,
  );

const box = () => screen.getByRole('combobox', { name: 'Category' });
const items = () =>
  screen.queryAllByRole('treeitem').map((item) => `${'  '.repeat(Number(item.getAttribute('aria-level')) - 1)}${item.textContent}`);
const lit = () => document.getElementById(box().getAttribute('aria-activedescendant') ?? '')?.textContent;
const press = (key: string) => fireEvent.keyDown(box(), { key });

test('opens on the records with no parent, a caret only where there are children, read in one breakdown', async () => {
  draw();
  fireEvent.click(box());
  await waitFor(() => expect(items()).toEqual(['Hardware', 'Software']));
  expect(box().getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('tree', { name: 'Category' })).toBeTruthy();
  await waitFor(() => expect(asked.filter((read) => read.path === '/api/breakdown')).toHaveLength(1));
  // Both tops have children: one breakdown says so for the level, and no read is made per record.
  expect(asked).toEqual([
    { path: '/api/run', text: 'category parent_id is empty show id, name, parent_id sort name' },
    { path: '/api/breakdown', text: 'category parent_id in (1, 2) count as children by parent_id' },
  ]);
  expect(screen.getAllByRole('treeitem').map((item) => item.getAttribute('aria-expanded'))).toEqual(['false', 'false']);
});

test('the keyboard walks the tree: Right opens and steps in, Left folds and steps out, Enter chooses', async () => {
  draw();
  box().focus();
  press('ArrowDown');
  await waitFor(() => expect(items()).toEqual(['Hardware', 'Software']));
  press('ArrowDown');
  expect(lit()).toBe('Hardware');
  // Right opens the branch, read as it opens; Right again steps into it.
  press('ArrowRight');
  await waitFor(() => expect(items()).toEqual(['Hardware', '  Laptops', '  Printers', 'Software']));
  expect(lit()).toBe('Hardware');
  press('ArrowRight');
  expect(lit()).toBe('Laptops');
  press('ArrowRight');
  await waitFor(() => expect(items()).toEqual(['Hardware', '  Laptops', '    Batteries', '    Screens', '  Printers', 'Software']));
  // A leaf has no caret and Right does nothing on it.
  press('ArrowDown');
  expect(lit()).toBe('Batteries');
  await waitFor(() => expect(screen.getAllByRole('treeitem')[2].getAttribute('aria-expanded')).toBeNull());
  press('ArrowRight');
  expect(lit()).toBe('Batteries');
  // Left steps out to the parent, then folds it; End and Home go to the ends.
  press('ArrowLeft');
  expect(lit()).toBe('Laptops');
  press('ArrowLeft');
  expect(items()).toEqual(['Hardware', '  Laptops', '  Printers', 'Software']);
  press('End');
  expect(lit()).toBe('Software');
  press('Home');
  expect(lit()).toBe('Hardware');
  // Down to Laptops, open it again, and choose a battery: the box says its name and the path under it.
  press('ArrowDown');
  press('ArrowRight');
  press('ArrowDown');
  expect(lit()).toBe('Batteries');
  press('Enter');
  expect(picked).toHaveBeenLastCalledWith(5, 'Batteries');
  expect(box().getAttribute('aria-expanded')).toBe('false');
  expect((box() as HTMLInputElement).value).toBe('Batteries');
  const trail = document.getElementById(box().getAttribute('aria-describedby')!)!;
  expect(trail.textContent).toBe('Hardware›Laptops›Batteries');
});

test('typing searches every level and says each match with its path; Enter takes the lit match', async () => {
  draw();
  box().focus();
  fireEvent.change(box(), { target: { value: 'batt' } });
  await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
  expect(screen.getByRole('listbox', { name: 'Category' })).toBeTruthy();
  // Two records of one name, told apart by their paths.
  expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
    'BatteriesHardware › Laptops',
    'BatteriesHardware › Printers',
  ]);
  expect(lit()).toBe('BatteriesHardware › Laptops');
  press('ArrowDown');
  expect(lit()).toBe('BatteriesHardware › Printers');
  press('Enter');
  expect(picked).toHaveBeenLastCalledWith(8, 'Batteries');
  expect(document.querySelector('.tree-picker-trail')?.textContent).toBe('Hardware›Printers›Batteries');
  // The paths were read a level a request: the parents of both matches, then theirs.
  expect(asked.filter((read) => read.text.startsWith('category id in'))).toEqual([
    { path: '/api/run', text: 'category id in (3, 4) show id, name, parent_id' },
    { path: '/api/run', text: 'category id in (1) show id, name, parent_id' },
  ]);
});

test('a chosen record is said with its path, and the tree opens down to it, lit', async () => {
  draw(6);
  await waitFor(() => expect((box() as HTMLInputElement).value).toBe('Screens'));
  await waitFor(() => expect(document.querySelector('.tree-picker-trail')?.textContent).toBe('Hardware›Laptops›Screens'));
  fireEvent.click(box());
  await waitFor(() => expect(items()).toEqual(['Hardware', '  Laptops', '    Batteries', '    Screens', '  Printers', 'Software']));
  expect(lit()).toBe('Screens');
  expect(document.querySelector('.tree-picker-option.chosen')?.textContent).toBe('Screens');
});

test('Escape closes only the picker, and a click on a caret opens a branch without choosing it', async () => {
  draw();
  const heard = vi.fn();
  document.addEventListener('keydown', heard);
  fireEvent.click(box());
  await waitFor(() => expect(items()).toEqual(['Hardware', 'Software']));
  await act(async () => {
    fireEvent.click(document.querySelectorAll('.tree-picker-caret')[1]);
  });
  await waitFor(() => expect(items()).toEqual(['Hardware', 'Software', '  Email']));
  expect(picked).not.toHaveBeenCalled();
  press('Escape');
  expect(box().getAttribute('aria-expanded')).toBe('false');
  expect(heard).not.toHaveBeenCalled();
  document.removeEventListener('keydown', heard);
});

test('holds to the combobox pattern over its tree, and over its list of matches', async () => {
  draw();
  fireEvent.click(box());
  await waitFor(() => expect(items()).toEqual(['Hardware', 'Software']));
  expect(await checkPatterns(document.body, { act: (step) => act(step) })).toEqual([]);
  fireEvent.change(box(), { target: { value: 'batt' } });
  await waitFor(() => expect(screen.queryAllByRole('option').length).toBeGreaterThan(1));
  expect(await checkPatterns(document.body, { act: (step) => act(step) })).toEqual([]);
});
