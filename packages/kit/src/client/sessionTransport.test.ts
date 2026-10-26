import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { api, toast } from './core.js';
import { establishSessionIdentity, lockSessionIdentity, sessionIdentity } from './sessionIdentity.js';
import { configureSessionLifecycle } from './sessionLifecycle.js';

const owner = (id = 'alice') => ({ signedIn: true, accountId: id, appId: 'loans' });
const reply = (id = 'alice', status = 200) =>
  new Response(JSON.stringify({ rows: ['private'] }), {
    status,
    headers: { 'x-mistri-account': id },
  });
beforeEach(() => {
  configureSessionLifecycle({ onLock: vi.fn() });
  establishSessionIdentity(owner());
});
afterEach(() => vi.unstubAllGlobals());

test('noncanonical API aliases refuse before fetch can normalize them to another operation', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  // Exercise hostile/untyped callers as well as the compile-time path checks.
  const raw = (path: string, body: Record<string, unknown>): Promise<unknown> => Reflect.apply(api, undefined, [path, body]);
  for (const path of [
    '/api/update#x',
    '/api/query?x=1#fragment',
    '/api/other/../update',
    'https://example.test/api/update',
    '/api/./update',
    '/api/%2e/update',
  ]) {
    await expect(raw(path, { q: 'item' })).rejects.toThrow('canonical API path');
  }
  expect(fetch).not.toHaveBeenCalled();
});

test('authenticated transport requires the verified response owner', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply()));
  expect(await api('/api/schema')).toEqual({ rows: ['private'] });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply('bob')));
  await expect(api('/api/schema')).rejects.toThrow('different or unverified account');
  expect(sessionIdentity().mode).toBe('locked');
});

test('missing owner and expiry lock without retrying a mutation', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));
  vi.stubGlobal('fetch', fetch);
  await expect(api('/api/update', { table: 'item', key: { id: 1 }, values: { value: 1 } })).rejects.toThrow('expired');
  expect(fetch).toHaveBeenCalledTimes(1);
  await expect(api('/api/schema')).rejects.toThrow('unavailable');
  expect(fetch).toHaveBeenCalledTimes(1);
  establishSessionIdentity(owner());
  fetch.mockResolvedValue(new Response('{}'));
  await expect(api('/api/schema')).rejects.toThrow('unverified account');
});

test('late previous-account response cannot publish or lock a newer account', async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  const pending = api('/api/schema');
  lockSessionIdentity();
  establishSessionIdentity(owner('bob'));
  finish(reply('alice', 401));
  await expect(pending).rejects.toThrow('previous session');
  expect(sessionIdentity().accountId).toBe('bob');
});

test('session change during JSON decoding also rejects the result', async () => {
  let finish!: (value: unknown) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'x-mistri-account': 'alice' }),
      json: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    }),
  );
  const pending = api('/api/schema');
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  lockSessionIdentity();
  finish({ rows: ['private'] });
  await expect(pending).rejects.toThrow('previous session');
});

test('late save feedback cannot recreate a toast after the session locks', () => {
  document.body.replaceChildren();
  lockSessionIdentity();
  expect(() => toast('A private record was saved')).not.toThrow();
  expect(document.body.textContent).toBe('');
});

test('a write the stock refused answers 422 with its envelope, which the form reads as any refused write', async () => {
  const refused = {
    errors: [
      { code: 'consumes_refused', message: 'Only 2 of Gasket left', fields: [{ field: 'quantity', message: 'Only 2 of Gasket left' }] },
    ],
    outcome: 'rejected',
  };
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify(refused), { status: 422, headers: { 'x-mistri-account': 'alice' } })),
  );
  await expect(api('/api/insert', { table: 'work_order_part', values: { part_id: 2, quantity: 3 } })).resolves.toEqual(refused);
  // Any other 422 is still a failure: only the write envelope is an answer.
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: 'No.', code: 'invalid_input' }), { status: 422, headers: { 'x-mistri-account': 'alice' } }),
      ),
  );
  await expect(api('/api/insert', { table: 'work_order_part', values: {} })).rejects.toMatchObject({ status: 422, message: 'No.' });
});

test('HTTP command failures retain safe code, message and outcome alongside the legacy error wrapper', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'The record changed.', code: 'stale_record', message: 'The record changed.', outcome: 'not_applied' }),
        {
          status: 409,
          headers: { 'x-mistri-account': 'alice' },
        },
      ),
    ),
  );
  await expect(api('/api/commands/execute', { command: 'assignReviewer' })).rejects.toMatchObject({
    message: 'The record changed.',
    status: 409,
    code: 'stale_record',
    outcome: 'not_applied',
  });
});
