import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { api } from './core.js';
import { establishSessionIdentity, sessionIdentity } from './sessionIdentity.js';
import { configureSessionLifecycle } from './sessionLifecycle.js';
import { firstPaintItem, firstPaintRead, rereadFirstPaint } from './firstPaint.js';
import { FIRST_PAINT_ELEMENT, itemKey, readKey } from '../../../engine/src/shared/firstPaint.js';

const owner = (id = 'alice') => ({ signedIn: true, accountId: id, appId: 'loans' });
const reply = (body: unknown, id = 'alice') => new Response(JSON.stringify(body), { status: 200, headers: { 'x-mistri-account': id } });

/** The page as the server sent it: its data block, read once. */
function page(reads: Record<string, { body: unknown; account?: string }>, items: Record<string, unknown> = {}) {
  document.getElementById(FIRST_PAINT_ELEMENT)?.remove();
  const block = document.createElement('script');
  block.type = 'application/json';
  block.id = FIRST_PAINT_ELEMENT;
  block.textContent = JSON.stringify({ reads, items });
  document.body.append(block);
  rereadFirstPaint();
}

beforeEach(() => {
  configureSessionLifecycle({ onLock: vi.fn() });
  establishSessionIdentity(owner());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
  rereadFirstPaint();
});

test('a read the page carries is answered from it once, and the next one is asked', async () => {
  page({ [readKey('GET', '/api/schema')]: { body: { tables: ['carried'] }, account: 'alice' } });
  const fetch = vi.fn().mockResolvedValue(reply({ tables: ['fetched'] }));
  vi.stubGlobal('fetch', fetch);
  expect(await api('/api/schema')).toEqual({ tables: ['carried'] });
  expect(fetch).not.toHaveBeenCalled();
  expect(document.getElementById(FIRST_PAINT_ELEMENT)).toBeNull();
  expect(await api('/api/schema')).toEqual({ tables: ['fetched'] });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('a POST is matched by its whole body, the App selector with it, whatever the order of its keys', async () => {
  page({ [readKey('POST', '/api/run', { app: 'loans', limit: 20, q: 'loan' })]: { body: { rows: [1] }, account: 'alice' } });
  const fetch = vi.fn().mockResolvedValue(reply({ rows: [2] }));
  vi.stubGlobal('fetch', fetch);
  expect(await api('/api/run', { q: 'loan', limit: 50, app: 'loans' } as never)).toEqual({ rows: [2] });
  expect(await api('/api/run', { q: 'loan', limit: 20, app: 'loans' } as never)).toEqual({ rows: [1] });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('an answer carried for another account is refused as a reply for another account is', async () => {
  page({ [readKey('GET', '/api/schema')]: { body: { tables: [] }, account: 'bob' } });
  vi.stubGlobal('fetch', vi.fn());
  await expect(api('/api/schema')).rejects.toThrow('different or unverified account');
  expect(sessionIdentity().mode).toBe('locked');
});

test('a write forgets what the page carried: the page was the data before it', async () => {
  page({ [readKey('GET', '/api/schema')]: { body: { tables: ['carried'] }, account: 'alice' } });
  const fetch = vi.fn().mockImplementation(async () => reply({ tables: ['fetched'], ok: true }));
  vi.stubGlobal('fetch', fetch);
  await api('/api/update', { table: 'loan', key: { id: 1 }, values: { status: 'paid' } } as never);
  expect(await api('/api/schema')).toEqual({ tables: ['fetched'], ok: true });
});

test('what the page carried is its first moments only', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  page({ [readKey('GET', '/api/schema')]: { body: { tables: ['carried'] }, account: 'alice' } });
  expect(firstPaintRead('GET', '/api/runtime')).toBeUndefined();
  vi.setSystemTime(Date.now() + 16_000);
  expect(firstPaintRead('GET', '/api/schema')).toBeUndefined();
});

test("a session that changes after the first answer is not the page's reader", async () => {
  page({ [readKey('GET', '/api/app')]: { body: {}, account: 'alice' }, [readKey('GET', '/api/schema')]: { body: {}, account: 'alice' } });
  expect(firstPaintRead('GET', '/api/app')).toBeDefined();
  establishSessionIdentity(owner('bob'));
  expect(firstPaintRead('GET', '/api/schema')).toBeUndefined();
});

test('a block that does not read carries nothing, and is gone', () => {
  const block = document.createElement('script');
  block.type = 'application/json';
  block.id = FIRST_PAINT_ELEMENT;
  block.textContent = '{"reads": ';
  document.body.append(block);
  rereadFirstPaint();
  expect(firstPaintRead('GET', '/api/schema')).toBeUndefined();
  expect(document.getElementById(FIRST_PAINT_ELEMENT)).toBeNull();
});

test('a batch item is answered by itself, on its own connection, once', () => {
  page({}, { [itemKey('breakdown', 'loans', { text: 'loan count', limit: 1 })]: { body: { rows: [{ count: 3 }] }, account: 'alice' } });
  expect(firstPaintItem('breakdown', 'other', { text: 'loan count', limit: 1 })).toBeUndefined();
  expect(firstPaintItem('breakdown', 'loans', { limit: 1, text: 'loan count' })).toEqual({ rows: [{ count: 3 }] });
  expect(firstPaintItem('breakdown', 'loans', { text: 'loan count', limit: 1 })).toBeUndefined();
});

test("a room's query takes the carried answer as its first, and asks the server when it is asked again", async () => {
  page({
    [readKey('POST', '/api/run', { app: 'loans', q: 'loan', limit: 20, offset: 0, exactCount: false })]: {
      body: { rows: ['carried'] },
      account: 'alice',
    },
  });
  const fetch = vi.fn().mockResolvedValue(reply({ rows: ['fetched'] }));
  vi.stubGlobal('fetch', fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const options = {
    queryKey: ['run', 'loans', 'loan'],
    queryFn: () => api('/api/run', { app: 'loans', q: 'loan', limit: 20, offset: 0, exactCount: false } as never),
  };
  expect(await client.fetchQuery(options)).toEqual({ rows: ['carried'] });
  expect(fetch).not.toHaveBeenCalled();
  await client.refetchQueries({ queryKey: options.queryKey });
  expect(fetch).toHaveBeenCalledTimes(1);
  client.clear();
});

test('a batch item is refused when boot fetched a different account before its first use', () => {
  const key = itemKey('count', 'loans', { q: 'loan' });
  page({}, { [key]: { body: { count: 3 }, account: 'alice' } });
  establishSessionIdentity(owner('bob'));
  expect(firstPaintItem('count', 'loans', { q: 'loan' })).toBeUndefined();
});
