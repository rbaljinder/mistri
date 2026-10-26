/**
 * A record's place in the list it was opened from: "22 of 23", a step
 * within the page and across its edge, a list that has no total, a late
 * page that must not pull the walk back, and the keys standing aside for a
 * text field, a dialog and a modifier.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { RecordTrail } from '../recordTrail.js';

const went: Array<[Record<string, unknown>, string]> = [];
const reads: Array<Record<string, unknown>> = [];
let page: Array<Record<string, unknown>> = [];
let gate: Promise<void> | null = null;
let here: unknown;
vi.mock('../core.js', () => ({
  api: async (_path: string, body: Record<string, unknown>) => {
    reads.push(body);
    await gate;
    return { rows: page };
  },
  currentEntry: () => here,
  findTable: (id: string) => (id === 'invoice' ? { id: 'invoice', name: 'invoice' } : undefined),
  go: (entry: Record<string, unknown>, how: string) => {
    went.push([entry, how]);
  },
  keyOf: (_table: unknown, row: Record<string, unknown>) => ({ id: row.id }),
  rowLabel: (_table: unknown, row: Record<string, unknown>) => `#${row.id}`,
}));

const { RecordTrailNav } = await import('./RecordTrailNav.js');

const records = (...ids: number[]) => ids.map((id) => ({ key: { id }, label: `#${id}` }));
function draw(trail?: Omit<RecordTrail, 'table'>) {
  const full = trail && { table: 'invoice', ...trail };
  const entry = {
    kind: 'row',
    table: 'invoice',
    key: full ? full.records[full.index].key : { id: 1 },
    label: 'here',
    ...(full ? { trail: full } : {}),
  };
  here = entry;
  render(<RecordTrailNav entry={entry} />);
  return entry;
}
const at = () => document.querySelector('.record-trail-at');

afterEach(() => {
  cleanup();
  went.length = 0;
  reads.length = 0;
  page = [];
  gate = null;
  here = undefined;
  document.body.replaceChildren();
});

test('draws nothing where the record was not opened from a list', () => {
  draw();
  expect(document.querySelector('.record-trail')).toBeNull();
});

test('says where the record sits and steps within the page, replacing the record in the walk', async () => {
  const user = userEvent.setup();
  draw({ records: records(1, 2, 3), index: 1, list: { query: 'invoice paid = true', offset: 20, limit: 3, total: 23 } });
  expect(screen.getByRole('navigation', { name: 'Records in this list' })).toBeInTheDocument();
  expect(at()).toHaveTextContent('22 of 23');
  expect(at()).toHaveAttribute('aria-live', 'polite');
  fireEvent.keyDown(document.body, { key: 'j' });
  await waitFor(() => expect(went).toHaveLength(1));
  expect(went[0][1]).toBe('replace');
  expect(went[0][0]).toMatchObject({ kind: 'row', table: 'invoice', key: { id: 3 }, label: '#3', trail: { index: 2 } });
  await user.click(screen.getByRole('button', { name: 'Previous record' }));
  await waitFor(() => expect(went).toHaveLength(2));
  expect(went[1][0]).toMatchObject({ key: { id: 1 }, trail: { index: 0 } });
  expect(reads).toEqual([]);
});

test('the last record of the list has no next, however it was reached', () => {
  draw({ records: records(22, 23), index: 1, list: { query: 'invoice', offset: 21, limit: 2, total: 23 } });
  expect(at()).toHaveTextContent('23 of 23');
  expect(screen.getByRole('button', { name: 'Next record' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Previous record' })).toBeEnabled();
});

test('crossing the edge of a page reads the next page of the same question, and the one before', async () => {
  page = [{ id: 3 }, { id: 4 }];
  draw({ records: records(1, 2), index: 1, list: { query: 'invoice', offset: 0, limit: 2, total: 5 } });
  fireEvent.keyDown(document.body, { key: 'j' });
  await waitFor(() => expect(went).toHaveLength(1));
  expect(reads).toEqual([{ q: 'invoice', limit: 2, offset: 2, count: 'none' }]);
  expect(went[0][0]).toMatchObject({ key: { id: 3 }, trail: { index: 0, list: { offset: 2, limit: 2, total: 5 } } });
  cleanup();
  went.length = 0;
  reads.length = 0;
  page = [{ id: 1 }, { id: 2 }];
  draw({ records: records(3, 4), index: 0, list: { query: 'invoice', offset: 2, limit: 2, total: 5 } });
  fireEvent.keyDown(document.body, { key: 'k' });
  await waitFor(() => expect(went).toHaveLength(1));
  expect(reads).toEqual([{ q: 'invoice', limit: 2, offset: 0, count: 'none' }]);
  expect(went[0][0]).toMatchObject({ key: { id: 2 }, trail: { index: 1, list: { offset: 0 } } });
});

test('a list with no total says only the place; a full page means more, and an empty one is the end', async () => {
  page = [{ id: 3 }, { id: 4 }];
  draw({ records: records(1, 2), index: 1, list: { query: 'invoice', offset: 0, limit: 2 } });
  expect(at()?.textContent).toBe('2');
  expect(screen.getByRole('button', { name: 'Next record' })).toBeEnabled();
  fireEvent.keyDown(document.body, { key: 'j' });
  await waitFor(() => expect(went).toHaveLength(1));
  expect(went[0][0]).toMatchObject({ key: { id: 3 }, trail: { index: 0, list: { offset: 2 } } });
  cleanup();
  went.length = 0;
  reads.length = 0;
  page = [];
  draw({ records: records(3, 4), index: 1, list: { query: 'invoice', offset: 2, limit: 2 } });
  fireEvent.keyDown(document.body, { key: 'j' });
  await waitFor(() => expect(reads).toHaveLength(1));
  await act(async () => {});
  expect(went).toEqual([]);
  cleanup();
  draw({ records: records(5), index: 0, list: { query: 'invoice', offset: 4, limit: 2 } });
  expect(screen.getByRole('button', { name: 'Next record' })).toBeDisabled();
});

test('a page that arrives after the reader has moved on does not pull the walk back', async () => {
  let release!: () => void;
  gate = new Promise((resolve) => {
    release = resolve;
  });
  page = [{ id: 3 }];
  draw({ records: records(1, 2), index: 1, list: { query: 'invoice', offset: 0, limit: 2, total: 3 } });
  fireEvent.keyDown(document.body, { key: 'j' });
  await waitFor(() => expect(document.querySelector('.record-trail')).toHaveAttribute('aria-busy', 'true'));
  here = { kind: 'table', table: 'invoice' };
  await act(async () => {
    release();
    await gate;
  });
  expect(went).toEqual([]);
  expect(document.querySelector('.record-trail')).not.toHaveAttribute('aria-busy');
});

test('the keys stand aside for a text field, a dialog over the page and a modifier', async () => {
  draw({ records: records(1, 2, 3), index: 1, list: { query: 'invoice', offset: 0, limit: 3, total: 3 } });
  const field = document.body.appendChild(document.createElement('input'));
  field.focus();
  fireEvent.keyDown(field, { key: 'j' });
  const dialog = document.body.appendChild(document.createElement('div'));
  dialog.setAttribute('role', 'dialog');
  dialog.appendChild(document.createElement('button')).focus();
  fireEvent.keyDown(document.activeElement!, { key: 'k' });
  (document.activeElement as HTMLElement).blur();
  fireEvent.keyDown(document.body, { key: 'j', metaKey: true });
  await act(async () => {});
  expect(went).toEqual([]);
  fireEvent.keyDown(document.body, { key: 'j' });
  await waitFor(() => expect(went).toHaveLength(1));
});
