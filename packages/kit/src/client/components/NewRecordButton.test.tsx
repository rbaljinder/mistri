import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';

const state = { activeConnection: 'demo', connections: [{ id: 'demo', writable: true }], canWrite: false };
const open = vi.fn();
vi.mock('../core.js', async (importActual) => ({ ...(await importActual<Record<string, unknown>>()), state, writeAllowed: () => true }));
// The real predicate, so the button is held to the rule every New entry point shares.
vi.mock('../insert.js', async (importActual) => ({
  ...(await importActual<typeof import('../insert.js')>()),
  openNewRecord: (...args: unknown[]) => open(...args),
}));
const { NewRecordButton } = await import('./NewRecordButton.js');
const table: TableMeta = { id: 'task', name: 'task', schema: '', isView: false, columns: [] };
afterEach(() => {
  cleanup();
  open.mockClear();
  state.connections[0].writable = true;
});

test('creating a record leaves the existing-record editing mode unchanged', async () => {
  const user = userEvent.setup();
  render(<NewRecordButton table={table} label="Task" />);
  await user.click(screen.getByRole('button', { name: '+ New Task' }));
  expect(open).toHaveBeenCalledWith(table, undefined);
  expect(state.canWrite).toBe(false);
});

test('read-only connections do not offer creation', () => {
  state.connections[0].writable = false;
  render(<NewRecordButton table={table} />);
  expect(screen.queryByRole('button')).toBeNull();
});

test('a table the reader\u2019s create grant leaves out offers no New', () => {
  render(<NewRecordButton table={{ ...table, insertable: false }} />);
  expect(screen.queryByRole('button')).toBeNull();
});
