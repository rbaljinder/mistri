import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('../../../kit/src/client/page.js', () => ({ pageToken: (id: string) => id }));
let core: typeof import('../../../kit/src/client/core.js');
let url: typeof import('../../../kit/src/client/url.js');
const table = {
  id: 'customer',
  name: 'customer',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', primaryKey: true, nullable: false },
    { name: 'name', type: 'TEXT', primaryKey: false, nullable: false },
  ],
};

beforeEach(async () => {
  vi.resetModules();
  const { establishSessionIdentity } = await import('../../../kit/src/client/sessionIdentity.js');
  establishSessionIdentity({ signedIn: false });
  core = await import('../../../kit/src/client/core.js');
  url = await import('../../../kit/src/client/url.js');
  /* A tenant session's links, as the shell installs them with the tenant's flows (app.js). */
  const { installShell } = await import('../../../kit/src/client/shellMode.js');
  const { parseTenantLink, qualifyTenantLink } = await import('./tenantLink.js');
  installShell({ tenantLinks: { parse: parseTenantLink, qualify: qualifyTenantLink } });
  core.state.activeConnection = 'a';
  core.state.schema = { tables: [table], foreignKeys: [] };
  core.state.stack = [core.rowView('customer', { id: 1 }, '1')];
});

test.each([true, false])('restored labels publish only while their navigation is current (current=%s)', async (current) => {
  let respond!: (response: Response) => void;
  const fetch = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        respond = resolve;
      }),
  );
  vi.stubGlobal('fetch', fetch);
  try {
    const stack = core.state.stack;
    const entry = stack[0];
    const paint = vi.fn();
    const loading = url.resolveLabels(stack, () => table);
    if (!current) core.go(core.tableView('customer'), 'reset');
    /* The crumbs redraw from the walk's subscribers: counted from here, so only the label's redraw is. */
    const stop = core.subscribeWalk(paint);
    respond(new Response(JSON.stringify({ rows: [{ id: 1, name: 'Ada' }] }), { status: 200 }));
    await loading;
    expect(entry.label).toBe(current ? 'Ada' : '1');
    expect(paint).toHaveBeenCalledTimes(current ? 1 : 0);
    stop();
  } finally {
    vi.unstubAllGlobals();
  }
});

test('restoring history explicitly retires existing navigation permission', () => {
  const isCurrent = core.captureNavigation();
  const result = url.applyHash('/a/customer', { findTableById: () => table, selectConnection: vi.fn() });
  expect(result).toBe(true);
  expect(isCurrent()).toBe(false);
});

test('tenant links include ownership without serializing context credentials', async () => {
  const identity = await import('../../../kit/src/client/sessionIdentity.js');
  identity.establishSessionIdentity({ signedIn: true, appId: 'a', accountId: 'alice' });
  identity.requireTenantSelection();
  identity.establishTenantSelection({
    appId: 'a',
    accountId: 'alice',
    tenantId: 'north / east',
    tabId: 'private-tab',
    context: 'private-context',
    revision: 1,
    expiresAt: Date.now() + 60000,
  });
  const link = url.toHash();
  expect(link).toContain('?tenant=north+%2F+east');
  expect(link).not.toMatch(/alice|private-tab|private-context/);
});

test.each(['/a/customer/~2?tenant=south', '/a/customer/~2'])(
  'foreign/unqualified tenant history %s cannot change the walk or dispatch label reads',
  async (href) => {
    const identity = await import('../../../kit/src/client/sessionIdentity.js');
    identity.establishSessionIdentity({ signedIn: true, appId: 'a', accountId: 'alice' });
    identity.requireTenantSelection();
    identity.establishTenantSelection({
      appId: 'a',
      accountId: 'alice',
      tenantId: 'north',
      tabId: 'tab',
      context: 'context',
      revision: 1,
      expiresAt: Date.now() + 60000,
    });
    const stack = core.state.stack,
      generation = core.captureNavigation(),
      fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    try {
      expect(url.applyHash(href, { findTableById: () => table, selectConnection: vi.fn() })).toBe('tenant-selection');
      expect(core.state.stack).toBe(stack);
      expect(generation()).toBe(true);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
