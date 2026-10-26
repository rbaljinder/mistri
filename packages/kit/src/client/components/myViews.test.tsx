/**
 * Saved views as the server keeps them: read through /api/filters, written
 * whole after a fresh read, and whose they are said by the server.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setPublicVisitor } from '../../../../mistri/src/client/publicVisitor.js';

type View = { name: string; query: string };
const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
let server: { filters: Record<string, unknown>; store?: string } = { filters: {}, store: 'shared' };
let readFails = false;

vi.mock('../core.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    state: { activeConnection: 'crm' },
    api: async (path: string, body?: Record<string, unknown>) => {
      calls.push({ path, body });
      if (path === '/api/filters') {
        if (readFails) throw new Error('offline');
        return structuredClone(server);
      }
      if (path === '/api/filters/save') {
        const filters = { ...server.filters };
        if (body!.filters) filters[String(body!.list)] = body!.filters;
        else delete filters[String(body!.list)];
        server = { ...server, filters };
        return { ok: true };
      }
      return {};
    },
  };
});

const { fetchSavedViews, renamedView, savedViewsKey, useSavedViews, withView, withoutView, writeSavedViews } = await import('./myViews.js');
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

beforeEach(bridgeShell);

beforeEach(() => {
  calls.length = 0;
  readFails = false;
  server = { filters: {}, store: 'shared' };
});
afterEach(() => {
  cleanup();
  setPublicVisitor(false);
});

test('the server says whose list it is, and a reply that does not say offers no store', async () => {
  server = { filters: { tasks: [{ name: 'Mine', query: 'owner_id = 3' }] }, store: 'account' };
  expect(await fetchSavedViews()).toEqual({ filters: server.filters, store: 'account' });
  server = { filters: {} };
  expect((await fetchSavedViews()).store).toBe('none');
  server = { filters: {}, store: 'everyone' };
  expect((await fetchSavedViews()).store).toBe('none');
});

test('a write reads the current list first, writes it back whole, and only then trusts the cache', async () => {
  const qc = client();
  // A stale cache: another tab has saved since.
  qc.setQueryData(savedViewsKey(), { filters: {}, store: 'shared' });
  server = { filters: { tasks: [{ name: 'Theirs', query: 'a = 1' }], deals: [{ name: 'Big', query: 'amount > 9' }] }, store: 'shared' };
  await writeSavedViews(qc, 'tasks', (views) => withView(views, ' Mine ', 'b = 2'));
  expect(calls.map((c) => c.path)).toEqual(['/api/filters', '/api/filters/save']);
  expect(calls[1].body).toEqual({
    list: 'tasks',
    filters: [
      { name: 'Theirs', query: 'a = 1' },
      { name: 'Mine', query: 'b = 2' },
    ],
  });
  expect(qc.getQueryData(savedViewsKey())).toEqual({ filters: server.filters, store: 'shared' });
});

test('the last view removed removes the list; a failed read changes nothing; no store refuses', async () => {
  const qc = client();
  server = { filters: { tasks: [{ name: 'Mine', query: 'b = 2' }] }, store: 'account' };
  await writeSavedViews(qc, 'tasks', (views) => withoutView(views, 'Mine'));
  expect(calls.at(-1)!.body).toEqual({ list: 'tasks', filters: null });
  expect(server.filters).toEqual({});

  readFails = true;
  calls.length = 0;
  await expect(writeSavedViews(qc, 'tasks', (views) => withView(views, 'x', 'y'))).rejects.toThrow(/nothing was changed/);
  expect(calls.some((c) => c.path === '/api/filters/save')).toBe(false);

  readFails = false;
  server = { filters: {}, store: 'none' };
  await expect(writeSavedViews(qc, 'tasks', (views) => withView(views, 'x', 'y'))).rejects.toThrow(/cannot be saved/);
  expect(calls.some((c) => c.path === '/api/filters/save')).toBe(false);
});

test('a signed-out visitor is asked nothing, offered no store, and cannot save', async () => {
  setPublicVisitor(true);
  server = { filters: { tasks: [{ name: 'Shared', query: 'a = 1' }] }, store: 'shared' };
  expect(await fetchSavedViews()).toEqual({ filters: {}, store: 'none' });
  await expect(writeSavedViews(client(), 'tasks', (views) => withView(views, 'x', 'y'))).rejects.toThrow(/cannot be saved/);
  function Names() {
    const { views, store } = useSavedViews('tasks');
    return <p>{`${store ?? 'unknown'}: ${views.length}`}</p>;
  }
  render(
    <QueryClientProvider client={client()}>
      <Names />
    </QueryClientProvider>,
  );
  expect(await screen.findByText('none: 0')).toBeInTheDocument();
  // No read at all: a 401 here would put the sign-in screen over the browsing.
  expect(calls).toEqual([]);
});

test('a repeated name replaces the older view; a rename keeps its place and takes a name over', () => {
  const views: View[] = [
    { name: 'A', query: 'a = 1' },
    { name: 'B', query: 'b = 1' },
  ];
  expect(withView(views, 'A', 'a = 2')).toEqual([
    { name: 'B', query: 'b = 1' },
    { name: 'A', query: 'a = 2' },
  ]);
  expect(renamedView(views, 'A', ' First ')).toEqual([
    { name: 'First', query: 'a = 1' },
    { name: 'B', query: 'b = 1' },
  ]);
  expect(renamedView(views, 'A', 'B')).toEqual([{ name: 'B', query: 'a = 1' }]);
  expect(withoutView(views, 'B')).toEqual([{ name: 'A', query: 'a = 1' }]);
});

test("a list reads its own views and whose they are, through the connection's cache", async () => {
  server = {
    filters: { tasks: [{ name: 'Mine', query: 'owner_id = 3' }, { name: 3 }], deals: [{ name: 'Big', query: 'x' }] },
    store: 'account',
  };
  function Names() {
    const { views, store } = useSavedViews('tasks');
    return <p>{`${store ?? 'unknown'}: ${views.map((v) => v.name).join(', ')}`}</p>;
  }
  render(
    <QueryClientProvider client={client()}>
      <Names />
    </QueryClientProvider>,
  );
  expect(await screen.findByText('account: Mine')).toBeInTheDocument();
  expect(savedViewsKey()).toEqual(['filters', 'crm']);
});
