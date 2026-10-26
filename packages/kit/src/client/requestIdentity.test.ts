import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { appRequestScope, ownedBy, scopeApiRequest, setAppRequestScope, setPublicPlacement } from './requestIdentity.js';
import { installShell, resetShell } from './shellMode.js';

beforeEach(() => setAppRequestScope(false));
afterEach(() => {
  setAppRequestScope(false);
  setPublicPlacement(null);
  resetShell();
  vi.unstubAllGlobals();
});

test('DB browser reads and writes keep explicit connection ownership without duplicate query selectors', () => {
  expect(ownedBy('production')).toEqual({ conn: 'production' });
  expect(ownedBy(undefined)).toEqual({});
  expect(scopeApiRequest('/api/schema', undefined, 'production')).toEqual({ url: '/api/schema?conn=production', payload: undefined });
  expect(scopeApiRequest('/api/schema?conn=staging', undefined, 'production').url).toBe('/api/schema?conn=staging');
  expect(scopeApiRequest('/api/query', { table: 'public.ticket' }, 'production').payload).toEqual({
    table: 'public.ticket',
    conn: 'production',
  });
  expect(scopeApiRequest('/api/connections/select', { id: 'staging' }, 'production')).toEqual({
    url: '/api/connections/select',
    payload: { id: 'staging' },
  });
});

test('App reads, writes and captured async owners use only app selectors', () => {
  setAppRequestScope(true);
  expect(scopeApiRequest('/api/schema', undefined, 'atlas').url).toBe('/api/schema?app=atlas');
  expect(scopeApiRequest('/api/schema?app=finance', undefined, 'atlas').url).toBe('/api/schema?app=finance');
  expect(scopeApiRequest('/api/pages?kind=record&app=finance', undefined, 'atlas').url).toBe('/api/pages?kind=record&app=finance');
  const body = { ...ownedBy('finance'), table: 'inventory.ticket', values: { name: 'conn=primary' } };
  expect(scopeApiRequest('/api/update', body, 'atlas').payload).toEqual({
    app: 'finance',
    table: 'inventory.ticket',
    values: { name: 'conn=primary' },
  });
  expect(body).toEqual({ app: 'finance', table: 'inventory.ticket', values: { name: 'conn=primary' } });
  expect(scopeApiRequest('/api/revert', { confirm: true }, 'atlas').payload).toEqual({ confirm: true, app: 'atlas' });
});

test('App ownership remains strict for missing, conflicting and invalid selectors', () => {
  setAppRequestScope(true);
  expect(() => scopeApiRequest('/api/query?app=atlas', { app: 'finance' }, 'atlas')).toThrow('two different applications');
  // As the server refuses it: an App request never names a connection.
  expect(() => scopeApiRequest('/api/query', { conn: 'atlas' }, 'atlas')).toThrow('identify an app, not a connection');
  expect(() => scopeApiRequest('/api/pages?conn=atlas', undefined, 'atlas')).toThrow('identify an app, not a connection');
  expect(() => scopeApiRequest('/api/query?app=atlas&app=finance', undefined, 'atlas')).toThrow('two different applications');
  expect(() => scopeApiRequest('/api/query', { app: 12 }, 'atlas')).toThrow('Invalid app');
  expect(() => scopeApiRequest('/api/query?app=', undefined, 'atlas')).toThrow('Invalid app');
  expect(() => scopeApiRequest('/api/connections', undefined, 'atlas')).toThrow('unavailable to applications');
  expect(() => scopeApiRequest('/api/connections/select', { id: 'production' }, 'atlas')).toThrow('unavailable to applications');
  setAppRequestScope(null);
  expect(() => scopeApiRequest('/api/schema', undefined, 'atlas')).toThrow('runtime is unavailable');
  expect(() => scopeApiRequest('/api/connections', undefined, 'atlas')).toThrow('unavailable to applications');
  expect(scopeApiRequest('/api/runtime?conn=old', undefined, 'atlas').url).toBe('/api/runtime');
});

test('command routing keeps App identity out of the immutable fingerprint envelope', () => {
  setAppRequestScope(true);
  const envelope = {
    command: 'assignReviewer',
    commandVersion: 1,
    key: { id: '9007199254740993' },
    expectedVersion: 3,
    idempotencyKey: 'same-key',
    input: { reviewer: 7 },
  };
  for (const endpoint of ['execute', 'status']) {
    expect(scopeApiRequest(`/api/commands/${endpoint}`, { ...envelope, app: 'loans' }, 'loans')).toEqual({
      url: `/api/commands/${endpoint}?app=loans`,
      payload: envelope,
    });
  }
  expect(
    scopeApiRequest('/api/commands/prepare', { app: 'loans', command: 'assignReviewer', commandVersion: 1, key: { id: 1 } }, 'loans'),
  ).toEqual({ url: '/api/commands/prepare?app=loans', payload: { command: 'assignReviewer', commandVersion: 1, key: { id: 1 } } });
  expect(() => scopeApiRequest('/api/commands/execute?app=other', { ...envelope, app: 'loans' }, 'loans')).toThrow(
    'two different applications',
  );
});

test('real API transport sends App identity without needing response connection metadata', async () => {
  const { api, state } = await import('./core.js');
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rows: [{ name: 'Saved' }] }) });
  vi.stubGlobal('fetch', fetch);
  setAppRequestScope(true);
  state.activeConnection = 'atlas';
  await api('/api/query', { table: 'inventory.ticket', ...ownedBy('finance') });
  expect(fetch).toHaveBeenCalledWith(
    '/api/query',
    expect.objectContaining({
      body: JSON.stringify({ table: 'inventory.ticket', app: 'finance' }),
      method: 'POST',
    }),
  );
  expect(await api('/api/schema')).toEqual({ rows: [{ name: 'Saved' }] });
  expect(fetch.mock.calls.at(-1)?.[0]).toBe('/api/schema?app=atlas');
  expect(appRequestScope()).toBe(true);
});

test('a tenant visitor’s public address rides on its reads alone, never on a write or another route', async () => {
  setAppRequestScope(true);
  const via = 'north-public-AAAAAAAAAAAAAAAA';
  /* Which requests are a visitor's reads is the App surface's answer (surfaceShell.js); the Workbench names none. */
  setPublicPlacement(via);
  expect(scopeApiRequest('/api/query', { table: 'listing' }, 'lot').url).toBe('/api/query');
  setPublicPlacement(null);
  installShell((await import('../../../mistri/src/client/surfaceShell.js')).surfaceShell);
  // Who-am-I may ask with it before it is kept; once only.
  expect(scopeApiRequest(`/api/whoami?app=lot&via=${via}`, undefined, 'lot').url).toBe(`/api/whoami?app=lot&via=${via}`);
  expect(() => scopeApiRequest(`/api/whoami?via=${via}&via=${via}`, undefined, 'lot')).toThrow();
  expect(scopeApiRequest('/api/query', { table: 'listing' }, 'lot').url).toBe('/api/query');
  setPublicPlacement(via);
  expect(scopeApiRequest('/api/query', { table: 'listing' }, 'lot').url).toBe(`/api/query?via=${via}`);
  expect(scopeApiRequest('/api/schema', undefined, 'lot').url).toBe(`/api/schema?app=lot&via=${via}`);
  expect(scopeApiRequest('/api/runtime', undefined, 'lot').url).toBe(`/api/runtime?via=${via}`);
  expect(scopeApiRequest('/api/insert', { table: 'listing' }, 'lot').url).toBe('/api/insert');
  expect(scopeApiRequest('/api/commands/execute', { command: 'x' }, 'lot').url).toBe('/api/commands/execute?app=lot');
});
