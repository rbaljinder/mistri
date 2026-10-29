/** The Connections screen: the list with its states, filtered and walked from the keyboard, each row's actions. */
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { Connection } from './ConnectionManager.js';

const toasts: string[] = [];
const calls: Array<[string, unknown]> = [];
const state = { activeConnection: 'prod' };
const list: Connection[] = [
  {
    id: 'prod',
    name: 'prod',
    detail: 'db.example.org/shop',
    dialect: 'postgres',
    source: 'config',
    secret: 'keychain',
    connected: true,
    tables: 12,
  },
  { id: 'old', name: 'old', detail: '/tmp/old.db', dialect: 'sqlite', source: 'session', error: 'unable to open database file' },
  { id: 'cat', name: 'catalog', detail: 'cat.example.org/cat', dialect: 'postgres', source: 'config', rows: false },
];
const api = vi.fn(async (path: string, body?: unknown): Promise<{ connections: typeof list; active: string }> => {
  calls.push([path, body]);
  return { connections: list, active: 'prod' };
});
vi.mock('../../../../kit/src/client/core.js', () => ({
  state,
  toast: (m: string) => toasts.push(m),
  trapFocus: () => () => {},
  api,
}));
const { ConnectionManager } = await import('./ConnectionManager.js');

function draw() {
  const props = {
    onClose: vi.fn(),
    onOpen: vi.fn(),
    onAdd: vi.fn(),
    onEdit: vi.fn(),
    onRemove: vi.fn(),
    onSaveFile: vi.fn(),
    onIntrospect: vi.fn(async (conn: Connection) => {
      await api('/api/connections/refresh', { id: conn.id });
    }),
  };
  render(
    <div className="conn-manager">
      <ConnectionManager {...props} />
    </div>,
  );
  return props;
}

afterEach(() => {
  cleanup();
  toasts.length = 0;
  calls.length = 0;
  api.mockClear();
  state.activeConnection = 'prod';
});

test('lists every connection with its state, marks the current one, and a row click opens another', async () => {
  const user = userEvent.setup();
  const props = draw();
  const rows = await screen.findAllByRole('option');
  expect(rows).toHaveLength(3);
  expect(rows[0]).toHaveClass('active');
  expect(rows[0]).toHaveTextContent('current');
  expect(rows[0].querySelector('.conn-status')).toHaveTextContent('12 tables');
  expect(rows[1]).toHaveClass('failed');
  expect(rows[1].querySelector('.conn-error')).toHaveTextContent('unable to open database file');
  expect(rows[2].querySelector('.shape-only')).toBeInTheDocument();
  expect(document.querySelector('.conn-count')).toHaveTextContent('3 connections');
  await user.click(rows[2]);
  expect(props.onClose).toHaveBeenCalledTimes(1);
  expect(props.onOpen).toHaveBeenCalledWith(list[2]);
  /* The current one only closes the screen. */
  await user.click(rows[0]);
  expect(props.onOpen).toHaveBeenCalledTimes(1);
});

test('the filter narrows and counts, arrows walk, Enter opens; actions do not open the row', async () => {
  const user = userEvent.setup();
  const props = draw();
  await screen.findAllByRole('option');
  const filter = screen.getByRole('searchbox', { name: 'Filter connections' });
  await user.type(filter, 'example');
  expect(screen.getAllByRole('option')).toHaveLength(2);
  expect(document.querySelector('.conn-count')).toHaveTextContent('2 of 3');
  fireEvent.keyDown(filter, { key: 'ArrowDown' });
  fireEvent.keyDown(filter, { key: 'ArrowDown' });
  expect(screen.getAllByRole('option')[1]).toHaveClass('cursor');
  fireEvent.keyDown(filter, { key: 'Enter' });
  expect(props.onOpen).toHaveBeenCalledWith(list[2]);
  await user.click(screen.getByTitle('Edit catalog'));
  expect(props.onEdit).toHaveBeenCalledWith(list[2], expect.any(Function));
  expect(props.onOpen).toHaveBeenCalledTimes(1);
  await user.click(screen.getByTitle('Remove catalog'));
  expect(props.onRemove).toHaveBeenCalledWith(list[2], expect.any(Function));
  await user.clear(filter);
  await user.type(filter, 'zzz');
  expect(screen.getByText('Nothing matches "zzz".')).toBeInTheDocument();
});

test('introspect re-reads one schema and refreshes the list from the server', async () => {
  const user = userEvent.setup();
  draw();
  await screen.findAllByRole('option');
  await user.click(screen.getAllByTitle('Read this database’s schema again')[0]);
  await vi.waitFor(() => expect(calls).toHaveLength(3));
  expect(calls.map(([p]) => p)).toEqual(['/api/connections', '/api/connections/refresh', '/api/connections']);
});

test('a server default from another tab never changes the current connection', async () => {
  api.mockResolvedValueOnce({ connections: list, active: 'cat' });
  draw();
  const rows = await screen.findAllByRole('option');
  expect(state.activeConnection).toBe('prod');
  expect(rows[0]).toHaveClass('active');
});

test('a late list cannot replace a newer refresh or update an unmounted manager', async () => {
  const props = draw();
  await screen.findAllByRole('option');
  fireEvent.click(screen.getByTitle('Edit prod'));
  const refresh = props.onEdit.mock.calls[0][1] as () => Promise<void>;
  let resolve!: (value: { connections: typeof list; active: string }) => void;
  api.mockImplementationOnce(
    () =>
      new Promise((yes) => {
        resolve = yes;
      }),
  );
  const old = refresh();
  api.mockResolvedValueOnce({ connections: [list[2]], active: 'cat' });
  await act(() => refresh());
  await act(async () => {
    resolve({ connections: list, active: 'prod' });
    await old;
  });
  expect(screen.getAllByRole('option')).toHaveLength(1);
  cleanup();
  const count = api.mock.calls.length;
  await refresh();
  expect(api).toHaveBeenCalledTimes(count);
});

test('keyboard activation of an action does not open its containing connection row', async () => {
  const user = userEvent.setup();
  const props = draw();
  await screen.findAllByRole('option');
  screen.getByTitle('Edit catalog').focus();
  await user.keyboard('{Enter}');
  expect(props.onEdit).toHaveBeenCalledTimes(1);
  expect(props.onOpen).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
});
