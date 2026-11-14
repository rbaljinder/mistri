/**
 * A list's column chooser: a reader's own choice of what the table draws, kept in their browser per view. The first
 * column is the one a row is known by and cannot be left out, and a column the view no longer shows is forgotten.
 */
import { afterEach, expect, test } from 'vitest';
import { cleanup, render, renderHook, screen, act } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ListColumns, useListColumns } from './ListColumns.js';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const COLUMNS = [
  { name: 'code', label: 'Code' },
  { name: 'beds', label: 'Beds' },
  { name: 'status', label: 'Status' },
];

test("Columns opens the view's columns as a checklist; unticking one leaves it out, and Show all brings them back", async () => {
  const user = userEvent.setup();
  const changes: string[][] = [];
  const { rerender } = render(<ListColumns columns={COLUMNS} hidden={[]} onChange={(next) => changes.push(next)} caption="Rent roll" />);
  await user.click(screen.getByRole('button', { name: 'Columns' }));
  const boxes = await screen.findAllByRole('checkbox');
  expect(boxes).toHaveLength(3);
  // The first column names the row: it stays.
  expect(screen.getByRole('checkbox', { name: 'Code' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Show all' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('checkbox', { name: 'Beds' }));
  expect(changes.at(-1)).toEqual(['beds']);
  rerender(<ListColumns columns={COLUMNS} hidden={['beds']} onChange={(next) => changes.push(next)} caption="Rent roll" />);
  expect(screen.getByRole('checkbox', { name: 'Beds' })).not.toBeChecked();
  await user.click(screen.getByRole('checkbox', { name: 'Beds' }));
  expect(changes.at(-1)).toEqual([]);
  await user.click(screen.getByRole('button', { name: 'Show all' }));
  expect(changes.at(-1)).toEqual([]);
});

test('the choice is kept per view in the browser, and only for columns the view still offers', () => {
  const first = renderHook(() => useListColumns('units', ['code', 'beds', 'status']));
  expect(first.result.current[0]).toEqual([]);
  act(() => first.result.current[1](['beds', 'status']));
  expect(first.result.current[0]).toEqual(['beds', 'status']);
  // Another view keeps its own; the same view reads it back on its next visit.
  expect(renderHook(() => useListColumns('leases', ['code', 'beds'])).result.current[0]).toEqual([]);
  expect(renderHook(() => useListColumns('units', ['code', 'beds', 'status'])).result.current[0]).toEqual(['beds', 'status']);
  // A column the view dropped is not left out of anything, and the first never is.
  expect(renderHook(() => useListColumns('units', ['beds', 'code'])).result.current[0]).toEqual([]);
  act(() => first.result.current[1]([]));
  expect(JSON.parse(localStorage.getItem('mistri.listColumns') ?? '{}')).toEqual({});
});
