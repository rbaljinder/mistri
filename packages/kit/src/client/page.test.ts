import { beforeEach, expect, test, vi } from 'vitest';
import type { PageDef } from '../../../engine/src/shared/page.js';
import { setAppRequestScope } from './requestIdentity.js';

const state = { activeConnection: 'a', schema: {} };
const api = vi.fn<(path: string) => Promise<{ pages?: PageDef[]; page?: PageDef }>>();
const savedPages = vi.fn<() => PageDef[]>();
const findTable = vi.fn();
/* The App served on this connection, as far as the page resolver reads it: each resource's page. */
let served: { resources: Record<string, { page?: string }> } | null = null;
vi.mock('./core.js', () => ({ state, api, findTable }));
vi.mock('./savedPages.js', () => ({ savedPages, whenSavedPagesChange: vi.fn() }));
vi.mock('./requestIdentity.js', () => {
  let app = false;
  return {
    appRequestScope: () => app,
    setAppRequestScope: (value: boolean) => {
      app = value;
    },
  };
});

let registry: typeof import('./page.js');
const page = (id: string, name = id, base = 'customer'): PageDef => ({ id, name, base, source: 'config', sections: [] });
function deferred() {
  let resolve!: (value: { pages?: PageDef[]; page?: PageDef }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ pages?: PageDef[]; page?: PageDef }>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  state.activeConnection = 'a';
  state.schema = {};
  served = null;
  setAppRequestScope(false);
  savedPages.mockReturnValue([]);
  api.mockResolvedValue({ pages: [] });
  registry = await import('./page.js');
  /* The resolver reads the App through the shell's answers (shellMode.ts), in the module graph just reset. */
  (await import('./shellMode.js')).installShell({ app: () => served as never });
});

test('concurrent readers share a load, keep saved pages first and filter independently', async () => {
  const reply = deferred();
  api.mockReturnValueOnce(reply.promise);
  savedPages.mockReturnValue([page('saved')]);
  const all = registry.pagesFor();
  const invoices = registry.pagesFor('invoice');
  expect(api).toHaveBeenCalledTimes(1);
  reply.resolve({ pages: [page('configured'), page('invoice', 'Invoice', 'invoice')] });
  expect((await all).map((p) => p.id)).toEqual(['saved', 'configured', 'invoice']);
  expect((await invoices).map((p) => p.id)).toEqual(['invoice']);
  savedPages.mockReturnValue([page('newly-saved')]);
  expect((await registry.pagesFor())[0].id).toBe('newly-saved');
  expect(api).toHaveBeenCalledTimes(1);
});

test('an empty response is cached and a rejected load can be retried', async () => {
  api.mockRejectedValueOnce(new Error('Offline'));
  await expect(registry.pagesFor()).rejects.toThrow('Offline');
  expect(await registry.pagesFor()).toEqual([]);
  expect(await registry.pagesFor()).toEqual([]);
  expect(api).toHaveBeenCalledTimes(2);
});

test('late responses cannot acquire the new connection or mix in its saved pages', async () => {
  const reply = deferred();
  api.mockReturnValueOnce(reply.promise);
  const old = expect(registry.pagesFor()).rejects.toThrow('changed while loading');
  state.activeConnection = 'b';
  savedPages.mockReturnValue([page('saved-b')]);
  api.mockResolvedValueOnce({ pages: [page('config-b')] });
  expect((await registry.pagesFor()).map((p) => p.id)).toEqual(['saved-b', 'config-b']);
  reply.resolve({ pages: [page('config-a')] });
  await old;
  expect((await registry.pagesFor()).map((p) => p.id)).toEqual(['saved-b', 'config-b']);
});

test('invalidation retires a pending load even when the replacement finishes first', async () => {
  const reply = deferred();
  api.mockReturnValueOnce(reply.promise);
  const old = expect(registry.pagesFor()).rejects.toThrow('changed while loading');
  const changed = vi.fn();
  registry.whenPagesChange(changed);
  registry.forgetPages();
  expect(changed).toHaveBeenCalledOnce();
  api.mockResolvedValueOnce({ pages: [page('new')] });
  expect(await registry.pagesFor()).toEqual([page('new')]);
  reply.resolve({ pages: [page('old')] });
  await old;
  expect(await registry.pagesFor()).toEqual([page('new')]);
});

test('a replaced schema retires a pending load on the same connection', async () => {
  const reply = deferred();
  api.mockReturnValueOnce(reply.promise);
  const old = expect(registry.pagesFor()).rejects.toThrow('changed while loading');
  state.schema = {};
  reply.resolve({ pages: [page('old')] });
  await old;
  expect(await registry.pagesFor()).toEqual([]);
});

test("tokens never use another connection's configured names", async () => {
  api.mockResolvedValueOnce({ pages: [page('config:1', 'Overview')] });
  await registry.pagesFor();
  expect(registry.pageToken('config:1')).toBe('overview');
  state.activeConnection = 'b';
  expect(registry.pageToken('config:1')).toBe('config:1');
  expect(api).toHaveBeenCalledTimes(1);
});

test('lookup retains saved precedence, slug disambiguation and table fallback', async () => {
  savedPages.mockReturnValue([page('saved', 'Overview')]);
  api.mockResolvedValue({ pages: [page('other', 'Overview', 'invoice')] });
  expect((await registry.pageById('saved')).id).toBe('saved');
  expect(api).not.toHaveBeenCalled();
  expect((await registry.pageById('overview', 'invoice')).id).toBe('other');
  expect(registry.pageToken('saved')).toBe('saved');
  findTable.mockReturnValue({ id: 'customer' });
  api.mockResolvedValueOnce({ page: page('suggested:customer') });
  expect((await registry.pageById('customer')).id).toBe('suggested:customer');
  expect(api).toHaveBeenLastCalledWith('/api/pages/suggested?table=customer');
});

test('obsolete lookups do not start a suggested request on the new connection', async () => {
  const reply = deferred();
  api.mockReturnValueOnce(reply.promise);
  const old = expect(registry.pageById('missing', 'customer')).rejects.toThrow('changed while loading');
  state.activeConnection = 'b';
  reply.resolve({ pages: [] });
  await old;
  expect(api).toHaveBeenCalledTimes(1);
  expect(findTable).not.toHaveBeenCalled();
});

test('suggested pages are also discarded after invalidation', async () => {
  const reply = deferred();
  api.mockReturnValueOnce(reply.promise);
  const old = expect(registry.pageById('suggested:customer')).rejects.toThrow('changed while loading');
  registry.forgetPages();
  reply.resolve({ page: page('suggested:customer') });
  await old;
});

test('App authored pages win; browser-saved precedence belongs only to Workbench', async () => {
  const resolve = registry.recordPageId;
  const broken = { ...page('broken'), error: 'No column "x".' } as PageDef;
  api.mockResolvedValue({ pages: [page('first'), page('named'), broken, page('invoice', 'Invoice', 'invoice')] });
  expect(await resolve('customer')).toBe('first');
  served = { resources: { customer: { page: 'named' } } };
  expect(await resolve('customer')).toBe('named');
  /* Only its own base's pages: a page of another table is never the answer. */
  served = { resources: { customer: { page: 'invoice' } } };
  expect(await resolve('customer')).toBe('first');
  /* A broken authored page is a failure, not permission to invent another layout. */
  served = { resources: { customer: { page: 'broken' } } };
  await expect(resolve('customer')).rejects.toThrow('No column "x".');
  served = { resources: { customer: { page: 'named' } } };
  savedPages.mockReturnValue([page('mine')]);
  expect(await resolve('customer')).toBe('named');
  served = null;
  expect(await resolve('customer')).toBe('mine');
  savedPages.mockReturnValue([]);
  /* A name Object.prototype lends is no resource. */
  served = { resources: {} };
  api.mockResolvedValue({ pages: [] });
  expect(await resolve('constructor')).toBe('suggested:constructor');
});

test.each(['payload', 'listener'] as const)('App %s excludes malformed saved pages from every registry entry point', async (boundary) => {
  if (boundary === 'payload') served = { resources: {} };
  else setAppRequestScope(true);
  savedPages.mockImplementation(() => {
    throw new Error('Malformed browser mirror');
  });
  api.mockResolvedValue({ pages: [page('authored', 'Overview')] });
  expect(await registry.pagesFor('customer')).toEqual([page('authored', 'Overview')]);
  expect(await registry.recordPageId('customer')).toBe('authored');
  expect((await registry.pageById('authored')).id).toBe('authored');
  expect((await registry.pageById('overview')).id).toBe('authored');
  expect(registry.pageToken('authored')).toBe('overview');
  await expect(registry.pageById('saved:old', 'customer')).rejects.toThrow('There is no page');
  expect(savedPages).not.toHaveBeenCalled();
});

test('saved ids and slugs cannot shadow an authored App page', async () => {
  served = { resources: {} };
  savedPages.mockReturnValue([page('authored', 'Hijacked'), page('saved:old', 'Overview')]);
  api.mockResolvedValue({ pages: [page('authored', 'Overview')] });
  expect((await registry.pageById('authored')).name).toBe('Overview');
  expect((await registry.pageById('overview')).id).toBe('authored');
  expect(registry.pageToken('authored')).toBe('overview');
  expect(savedPages).not.toHaveBeenCalled();
});

test('App suggestions are used only when no authored page exists, including legacy suggested links', async () => {
  served = { resources: {} };
  api.mockResolvedValue({ pages: [page('authored')] });
  expect((await registry.pageById('suggested:customer')).id).toBe('authored');
  expect(api).not.toHaveBeenCalledWith('/api/pages/suggested?table=customer');
  registry.forgetPages();
  api.mockResolvedValueOnce({ pages: [] }).mockResolvedValueOnce({ page: page('suggested:customer') });
  expect((await registry.pageById('suggested:customer')).id).toBe('suggested:customer');
  expect(api).toHaveBeenLastCalledWith('/api/pages/suggested?table=customer');
});

test('App page lookup errors propagate and a retry can recover the authored page', async () => {
  served = { resources: {} };
  const resolve = registry.recordPageId;
  api.mockRejectedValueOnce(new Error('Offline'));
  await expect(resolve('customer')).rejects.toThrow('Offline');
  api.mockResolvedValueOnce({ pages: [page('authored')] });
  expect(await resolve('customer')).toBe('authored');
});
