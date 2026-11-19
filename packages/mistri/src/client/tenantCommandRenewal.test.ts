import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { TENANT_HTTP_HEADERS as names, type TenantContextReply } from '../shared/tenantContext.js';
import type { AppCommandAction } from '../shared/app.js';
import {
  captureTenantLease,
  establishSessionIdentity,
  establishTenantSelection,
  lockSessionIdentity,
  requireTenantSelection,
  tenantLeaseActive,
} from '../../../kit/src/client/sessionIdentity.js';
import { installShell, resetShell } from '../../../kit/src/client/shellMode.js';
import { setAppRequestScope } from '../../../kit/src/client/requestIdentity.js';
import { isTenantMutationPath, tenantMutationApi, tenantReadApi } from './tenantTransport.js';
import { startTenantRenewal } from './tenantRenewal.js';
import { sendCommand } from './commandSend.js';
import { commandOperations, type CommandOwner } from './commandState.js';

/* A field report (#84): a page running a command in a loop, with the lease renewed now and then, saw a run refused
   409 tenant_lease_stale, every read after it refused too, and run() never settle; only a reload recovered. Here the
   server is a small model of tenantContexts.ts: it holds one revision, a renewal moves it the moment it arrives, and a
   request carrying any other revision is refused at the door, before anything runs. */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const within = <T>(work: Promise<T>, ms = 2000): Promise<T> =>
  Promise.race([work, sleep(ms).then(() => Promise.reject(new Error(`did not settle within ${ms} ms`)))]);

const base = {
  appId: 'atlas',
  accountId: 'alice',
  tenantId: 'north',
  tabId: 'tab-one',
  context: 'context-north',
};
const action = { kind: 'command', label: 'Advance', command: { name: 'advance', version: 1, input: [] } } as unknown as AppCommandAction;
const owner = (id: number): CommandOwner => ({ connection: 'atlas', target: 'item', command: 'advance', commandVersion: 1, key: { id } });

let server: { revision: number; expiresAt: number; renewing?: () => void; sent: { path: string; revision: string | null }[] };
const replyHeaders = (revision: number) => ({
  [names.app]: base.appId,
  [names.account]: base.accountId,
  [names.tenant]: base.tenantId,
  [names.tab]: base.tabId,
  [names.context]: base.context,
  [names.revision]: String(revision),
});
async function serve(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const path = new URL(String(input), 'http://mistri.invalid').pathname;
  const carried = new Headers(init?.headers).get(names.revision);
  server.sent.push({ path, revision: carried });
  if (path === '/api/tenant/context/renew') {
    const { expectedRevision } = JSON.parse(String(init?.body));
    if (expectedRevision !== server.revision)
      return Response.json({ code: 'tenant_lease_stale', error: 'Renew required' }, { status: 409 });
    // The server moves the moment the renewal arrives; its answer takes a while to come back.
    server.revision++;
    server.expiresAt = Date.now() + 60_000;
    const reply: TenantContextReply = { ...base, revision: server.revision, expiresAt: server.expiresAt };
    await sleep(15);
    return Response.json(reply, { headers: replyHeaders(reply.revision) });
  }
  // Something the page asked, on its way while a renewal starts: it reaches the server after the renewal did.
  const renewing = server.renewing;
  server.renewing = undefined;
  if (renewing) {
    renewing();
    await sleep(5);
  }
  if (carried !== String(server.revision))
    return Response.json({ code: 'tenant_lease_stale', error: 'Renew required', outcome: 'not_applied' }, { status: 409 });
  const at = replyHeaders(server.revision);
  if (path === '/api/commands/prepare') return Response.json({ expectedVersion: 3 }, { headers: at });
  if (path === '/api/commands/execute') {
    const { key } = JSON.parse(String(init?.body));
    return Response.json(
      {
        status: 'applied',
        command: 'advance',
        commandVersion: 1,
        resource: 'item',
        key,
        receiptId: `receipt-${key.id}`,
        result: { id: key.id },
      },
      { headers: at },
    );
  }
  if (path === '/api/schema') return Response.json({ tables: [] }, { headers: at });
  return Response.json({ error: 'Not found' }, { status: 404 });
}

let renewal: ReturnType<typeof startTenantRenewal>;
beforeEach(() => {
  server = { revision: 1, expiresAt: Date.now() + 60_000, sent: [] };
  vi.stubGlobal('fetch', vi.fn(serve));
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  setAppRequestScope(true);
  installShell({
    tenant: {
      read: (path: string, body?: Record<string, unknown>, connection?: string | null, headers?: Record<string, string>) =>
        tenantReadApi(path, body, connection, undefined, headers),
      mutate: tenantMutationApi,
      isMutation: isTenantMutationPath,
    },
  } as never);
  establishSessionIdentity({ signedIn: true, appId: 'atlas', accountId: 'alice' });
  requireTenantSelection();
  establishTenantSelection({ ...base, revision: 1, expiresAt: server.expiresAt });
  renewal = startTenantRenewal({ timeoutMs: 1000, retryMs: 50 });
});
afterEach(() => {
  renewal.stop();
  lockSessionIdentity();
  resetShell();
  setAppRequestScope(false);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const run = (id: number) =>
  sendCommand(action, owner(id), {}, { headless: true, refresh: () => {} }).then((sent) => {
    if ('refused' in sent) return { refused: sent.refused };
    const { phase, outcome, message } = sent.operation as { phase: string; outcome?: string; message?: string };
    commandOperations.forget(owner(id));
    return { phase, outcome, message };
  });

test('a renewal that lands between a command’s prepare and its execute leaves every run settled and the page reading', async () => {
  for (let id = 1; id <= 6; id++) {
    // Odd runs: the renewal lands while the prepare is on its way; even runs: while the execute is.
    let asked = 0;
    const startRenewal = () => void renewal.check().catch(() => {});
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input), 'http://mistri.invalid').pathname;
      if (path.startsWith('/api/commands/') && ++asked === (id % 2 ? 1 : 2)) server.renewing = startRenewal;
      return original(input, init);
    });
    expect(await within(run(id))).toMatchObject({ phase: 'success' });
    vi.mocked(fetch).mockImplementation(original);
    expect(tenantLeaseActive()).toBe(true);
    expect(await within(tenantReadApi('/api/schema'))).toEqual({ tables: [] });
  }
  expect(captureTenantLease()?.revision).toBe(7);
  // Each run was refused once at the door and sent once more under the renewed lease: three command requests a run.
  expect(server.sent.filter(({ path }) => path.startsWith('/api/commands/'))).toHaveLength(18);
});
