import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { TENANT_HTTP_HEADERS as names, type TenantContextReply } from '../shared/tenantContext.js';

let session: typeof import('../../../kit/src/client/sessionIdentity.js');
let transport: typeof import('./tenantTransport.js');
const lock = vi.fn();
const proof = (tenantId = 'north', context = 'context-north'): TenantContextReply => ({
  appId: 'atlas',
  accountId: 'alice',
  tenantId,
  tabId: 'tab-one',
  context,
  revision: 1,
  expiresAt: Date.now() + 60000,
});
const headers = (owner: TenantContextReply) => ({
  [names.app]: owner.appId,
  [names.account]: owner.accountId,
  [names.tenant]: owner.tenantId,
  [names.tab]: owner.tabId,
  [names.context]: owner.context,
  [names.revision]: String(owner.revision),
});
const response = (body: unknown, owner: TenantContextReply | null = proof(), status = 200) =>
  new Response(JSON.stringify(body), { status, headers: owner ? headers(owner) : {} });
const update = () => ({ table: 'item', key: { id: '9007199254740993' }, values: { name: 'New name' }, expected: { name: 'Old name' } });
const applied = () => ({ affected: 1, applied: { name: 'New name' }, undoId: '439b72e9-3346-4a63-9989-d14bcb4b8c67' });
const command = () => ({
  command: 'advance',
  commandVersion: 1,
  key: { id: 'same' },
  expectedVersion: 0,
  idempotencyKey: 'attempt-exact-001',
  input: { reviewer: 'reader-1' },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const fetchReply = (reply: Response) => {
  const fetcher = vi.fn().mockResolvedValue(reply);
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
};
const freshSouth = () => {
  session.requireTenantSelection();
  return session.establishTenantSelection(proof('south', 'context-south'));
};

beforeEach(async () => {
  vi.resetModules();
  lock.mockReset();
  session = await import('../../../kit/src/client/sessionIdentity.js');
  transport = await import('./tenantTransport.js');
  const lifecycle = await import('../../../kit/src/client/sessionLifecycle.js');
  lifecycle.configureSessionLifecycle({ onLock: lock });
  session.establishSessionIdentity({ signedIn: true, appId: 'atlas', accountId: 'alice' });
  session.requireTenantSelection();
  session.establishTenantSelection(proof());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('mutation dispatch captures the selected owner, exact nested body and opaque history ID without retry', async () => {
  const body = update(),
    expected = structuredClone(body),
    result = applied();
  const fetcher = fetchReply(response(result));
  const pending = transport.tenantMutationApi('/api/update', body, 'atlas');
  body.key.id = 'different';
  body.values.name = 'Mutated later';
  body.expected.name = 'Mutated later';
  expect(await pending).toEqual(result);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe('/api/update?app=atlas&tenant=north');
  expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store' });
  expect(new Headers(init.headers).get(names.app)).toBe('atlas');
  expect(new Headers(init.headers).get(names.account)).toBe('alice');
  expect(new Headers(init.headers).get(names.tab)).toBe('tab-one');
  expect(new Headers(init.headers).get(names.context)).toBe('context-north');
  expect(new Headers(init.headers).get(names.revision)).toBe('1');
  expect(new Headers(init.headers).has(names.tenant)).toBe(false);
  expect(JSON.parse(init.body)).toEqual(expected);
  expect(lock).not.toHaveBeenCalled();
});

test.each([
  [
    '/api/insert',
    { table: 'item', values: { id: '9007199254740993', enabled: false, name: null, amount: 0 } },
    { key: { id: '9007199254740993' }, applied: { enabled: false, name: null, amount: 0 }, undoId: 'opaque-insert-undo' },
  ],
  /* A New form's lines ride with its save (form.lines). */
  [
    '/api/insert',
    { table: 'item', values: { name: 'With lines' }, lines: { item_line: [{ values: { qty: 2 } }] } },
    { key: { id: 'lined' }, applied: { name: 'With lines' }, undoId: 'opaque-insert-undo' },
  ],
  ['/api/delete', { table: 'item', key: { id: 'same' } }, { impact: [], deleted: false }],
  ['/api/delete', { table: 'item', key: { id: 'same' }, confirm: true }, { deleted: true, affected: 1, undoId: 'opaque-delete-undo' }],
  [
    '/api/revert',
    { limit: 7 },
    {
      reverted: false,
      writes: [{ id: 'opaque-history-token', summary: 'Updated item' }],
      next: { id: 'opaque-history-token', summary: 'Updated item' },
    },
  ],
  [
    '/api/revert',
    { confirm: true, expectedId: '439b72e9-3346-4a63-9989-d14bcb4b8c67' },
    { reverted: true, undone: { id: '439b72e9-3346-4a63-9989-d14bcb4b8c67', summary: 'Updated item' } },
  ],
  ['/api/commands/prepare', { command: 'advance', commandVersion: 1, key: { id: 'same' } }, { eligible: true, expectedVersion: 0 }],
  [
    '/api/commands/execute',
    command(),
    {
      status: 'applied',
      command: 'advance',
      commandVersion: 1,
      resource: 'item',
      key: { id: 'same' },
      receiptId: 'opaque-command-receipt',
      result: { id: 'same' },
    },
  ],
  ['/api/commands/status', command(), { status: 'not_found', outcome: 'unknown' }],
] as const)('allowed %s preserves its existing body and owned result', async (path, body, result) => {
  const fetcher = fetchReply(response(result));
  expect(await transport.tenantMutationApi(path, structuredClone(body))).toEqual(result);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(body);
});

/* A signed-in form's command names no record: its envelope's key is empty, and
   the lease's tenant still owns the request. A key that is not one still refuses. */
test('a command that names no record is sent with its empty key, and an unusable one still is not', async () => {
  const keyless = { ...command(), key: {} };
  const fetcher = fetchReply(response({ status: 'succeeded', receiptId: 'opaque-form-receipt', result: { id: 'new' } }));
  expect(await transport.tenantMutationApi('/api/commands/execute', structuredClone(keyless))).toMatchObject({ status: 'succeeded' });
  expect(fetcher.mock.calls[0][0]).toBe('/api/commands/execute?app=atlas&tenant=north');
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(keyless);
  for (const key of [[], null, 'id', { id: null }, { '': 'x' }]) {
    const refused = vi.fn();
    vi.stubGlobal('fetch', refused);
    await expect(transport.tenantMutationApi('/api/commands/execute', { ...command(), key })).rejects.toMatchObject({
      outcome: 'not_applied',
    });
    expect(refused).not.toHaveBeenCalled();
  }
});

test('matching ordinary App transport claims are stripped but not forwarded as alternate authority', async () => {
  const fetcher = fetchReply(response(applied()));
  await transport.tenantMutationApi('/api/update?app=atlas', { ...update(), app: 'atlas' }, 'atlas');
  expect(fetcher.mock.calls[0][0]).toBe('/api/update?app=atlas&tenant=north');
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(update());
});

test.each([
  '/api/sql',
  '/api/query',
  '/api/export',
  '/api/pages/save',
  '/api/connections',
  '/api/tenant/context/switch',
  '/api/commands/unknown',
  '/api/update/',
  '/api/../api/update',
  '/api/%75pdate',
  '/api/update#ignored',
  'https://example.test/api/update',
  '//example.test/api/update',
  '/api\\update',
  '/api/update?tenant=north',
  '/api/update?tenant=south',
  '/api/update?app=other',
  '/api/update?app=atlas&app=atlas',
  '/api/update?x=1',
])('unsupported, aliased or competing route %s fails locally as not_applied', async (path) => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await expect(transport.tenantMutationApi(path, update(), 'atlas')).rejects.toMatchObject({ outcome: 'not_applied' });
  expect(fetcher).not.toHaveBeenCalled();
  expect(lock).not.toHaveBeenCalled();
});

test.each([
  { app: 'other' },
  { conn: 'other' },
  { tenant: 'north' },
  { tenantId: 'north' },
  { tabId: 'tab-one' },
  { expectedContext: 'context-north' },
  { accountId: 'alice' },
  { unknown: true },
])('competing or unknown body fields %j cannot reach fetch', async (extra) => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await expect(transport.tenantMutationApi('/api/update', { ...update(), ...extra })).rejects.toMatchObject({ outcome: 'not_applied' });
  expect(fetcher).not.toHaveBeenCalled();
});

test.each([
  ['/api/insert', { table: 'item', values: {}, expected: {} }],
  ['/api/delete', { table: 'item', key: { id: 'same' }, values: {} }],
  ['/api/revert', { confirm: true, expectedId: 'opaque', table: 'item' }],
  ['/api/commands/prepare', { command: 'advance', commandVersion: 1, key: {}, input: {} }],
  ['/api/commands/execute', { ...command(), receiptOwner: { tenantId: 'north' } }],
  ['/api/commands/status', { ...command(), roles: ['admin'] }],
] as const)('%s enforces its own server body field allowlist', async (path, body) => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await expect(transport.tenantMutationApi(path, body)).rejects.toMatchObject({ outcome: 'not_applied' });
  expect(fetcher).not.toHaveBeenCalled();
});

test.each([null, [], 'payload', 1, undefined])('malformed top-level body %j cannot dispatch', async (body) => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await expect(transport.tenantMutationApi('/api/update', body as unknown as Record<string, unknown>)).rejects.toMatchObject({
    outcome: 'not_applied',
  });
  expect(fetcher).not.toHaveBeenCalled();
});

test.each([NaN, Infinity, -Infinity, 1n, () => 'value'])('non-JSON nested mutation value refuses before dispatch: %s', async (name) => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await expect(transport.tenantMutationApi('/api/update', { ...update(), values: { name } })).rejects.toMatchObject({
    outcome: 'not_applied',
  });
  expect(fetcher).not.toHaveBeenCalled();
});

test('nested getters and toJSON hooks cannot execute during input capture', async () => {
  const getter = vi.fn(() => 'secret'),
    toJSON = vi.fn(() => ({ name: 'rewritten' })),
    fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const accessor = Object.defineProperty({}, 'name', { enumerable: true, get: getter });
  for (const values of [accessor, { name: 'safe', toJSON }]) {
    await expect(transport.tenantMutationApi('/api/update', { ...update(), values })).rejects.toMatchObject({ outcome: 'not_applied' });
  }
  expect(getter).not.toHaveBeenCalled();
  expect(toJSON).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});

test('cyclic body capture refuses before fetch', async () => {
  const body: Record<string, unknown> = update();
  body.values = body;
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await expect(transport.tenantMutationApi('/api/update', body)).rejects.toMatchObject({ outcome: 'not_applied' });
  expect(fetcher).not.toHaveBeenCalled();
});

test.each(['unselected', 'expired', 'locked', 'wrong-app'] as const)('%s cannot dispatch a tenant mutation', async (state) => {
  if (state === 'unselected') session.requireTenantSelection();
  if (state === 'expired') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120000);
  if (state === 'locked') session.lockSessionIdentity();
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await expect(transport.tenantMutationApi('/api/update', update(), state === 'wrong-app' ? 'other' : 'atlas')).rejects.toMatchObject({
    outcome: 'not_applied',
  });
  expect(fetcher).not.toHaveBeenCalled();
});

test('a pre-aborted request is definitely not dispatched', async () => {
  const controller = new AbortController();
  controller.abort();
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await expect(transport.tenantMutationApi('/api/update', update(), 'atlas', controller.signal)).rejects.toMatchObject({
    outcome: 'not_applied',
  });
  expect(fetcher).not.toHaveBeenCalled();
});

test('abort after dispatch remains unknown and forwards the original signal without retry', async () => {
  const controller = new AbortController(),
    wire = deferred<Response>();
  const fetcher = vi.fn<typeof fetch>(() => wire.promise);
  vi.stubGlobal('fetch', fetcher);
  const pending = transport.tenantMutationApi('/api/update', update(), 'atlas', controller.signal);
  const assertion = expect(pending).rejects.toMatchObject({ outcome: 'unknown' });
  expect(fetcher.mock.calls[0][1]?.signal).toBe(controller.signal);
  controller.abort();
  wire.reject(new DOMException('Request aborted', 'AbortError'));
  await assertion;
  expect(fetcher).toHaveBeenCalledTimes(1);
});

// The realm header marks a platform lease and is no part of a tenant owner's
// proof: missing or foreign, a tenant reply is still decided by the six others.
for (const field of (Object.keys(names) as (keyof typeof names)[]).filter((field) => field !== 'realm')) {
  for (const mode of ['missing', 'wrong'] as const) {
    test(`apparent success with ${mode} ${field} ownership cannot become a definite rejection`, async () => {
      const reply = response(applied());
      if (mode === 'missing') reply.headers.delete(names[field]);
      else reply.headers.set(names[field], 'foreign');
      const fetcher = fetchReply(reply);
      await expect(transport.tenantMutationApi('/api/update', update())).rejects.toMatchObject({ outcome: 'unknown' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  }
}

test.each(['unknown', 'not_applied', 'rejected'] as const)(
  'HTTP-200 failure-only %s is preserved without owner headers, stripping result-bearing extras',
  async (outcome) => {
    const body = {
      outcome,
      error: 'The operation was not confirmed.',
      errors: [{ code: 'write_unconfirmed', message: 'Diagnostic' }],
      rows: [{ secret: 'DO_NOT_PUBLISH' }],
      applied: { secret: 'DO_NOT_PUBLISH' },
      affected: 1,
      undoId: 'DO_NOT_PUBLISH',
      receipt: { result: 'DO_NOT_PUBLISH' },
      key: { id: 'DO_NOT_PUBLISH' },
    };
    const fetcher = fetchReply(response(body, null));
    const result = await transport.tenantMutationApi('/api/update', update());
    expect(result.outcome).toBe(outcome);
    expect(result.error).toBe(body.error);
    expect(JSON.stringify(result)).not.toContain('DO_NOT_PUBLISH');
    for (const field of ['rows', 'applied', 'affected', 'undoId', 'receipt', 'key']) expect(result).not.toHaveProperty(field);
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

// The realm header marks a platform lease; a tenant owner's proof is the six
// others, and a platform reply already fails them through its `@platform` id.
for (const field of (Object.keys(names) as (keyof typeof names)[]).filter((field) => field !== 'realm')) {
  for (const mode of ['partial', 'wrong'] as const) {
    test.each(['rejected', 'not_applied'] as const)(
      `explicit %s with ${mode} ${field} ownership is unknown, not this context's refusal`,
      async (outcome) => {
        const reply = response(
          { error: 'Another context refusal', outcome },
          mode === 'partial' ? null : proof(),
          outcome === 'rejected' ? 403 : 200,
        );
        reply.headers.set(names[field], mode === 'partial' ? headers(proof())[names[field]] : 'foreign');
        const fetcher = fetchReply(reply);
        await expect(transport.tenantMutationApi('/api/update', update())).rejects.toMatchObject({ outcome: 'unknown' });
        expect(session.sessionIdentity().mode).toBe('locked');
        expect(lock).toHaveBeenCalledOnce();
        expect(fetcher).toHaveBeenCalledTimes(1);
      },
    );
  }
}

test('owned HTTP-200 command diagnostic retains its explicit outcome, not private receipt extras', async () => {
  fetchReply(
    response({
      error: 'Current state does not permit the command.',
      code: 'ineligible_state',
      outcome: 'not_applied',
      receipt: { result: 'DO_NOT_PUBLISH' },
      rows: ['DO_NOT_PUBLISH'],
    }),
  );
  const result = await transport.tenantMutationApi('/api/commands/execute', command());
  expect(result).toMatchObject({ outcome: 'not_applied', error: 'Current state does not permit the command.' });
  expect(JSON.stringify(result)).not.toContain('DO_NOT_PUBLISH');
});

for (const outcome of ['not_applied', 'rejected', 'unknown'] as const) {
  test.each([400, 401, 403, 409, 503])(`non-2xx %i preserves explicit ${outcome}, never infers a different outcome`, async (status) => {
    const fetcher = fetchReply(
      response(
        { error: 'Unavailable', code: 'forbidden', outcome, rows: ['DO_NOT_PUBLISH'], receipt: { result: 'DO_NOT_PUBLISH' } },
        null,
        status,
      ),
    );
    const pending = transport.tenantMutationApi('/api/commands/execute', command());
    await expect(pending).rejects.toMatchObject({ status, outcome });
    await pending.catch((error) => {
      expect(error).not.toHaveProperty('rows');
      expect(error).not.toHaveProperty('receipt');
      expect(JSON.stringify(error)).not.toContain('DO_NOT_PUBLISH');
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
}

test.each([400, 401, 403, 404, 409, 422, 500, 503])(
  'bare HTTP %i, including an admission-looking code, is not rollback evidence',
  async (status) => {
    const fetcher = fetchReply(response({ error: 'Unavailable', code: 'tenant_context_unavailable' }, null, status));
    await expect(transport.tenantMutationApi('/api/update', update())).rejects.toMatchObject({ outcome: 'unknown' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

test('network error that happens to carry status/outcome fields cannot masquerade as a server rejection', async () => {
  const fetcher = vi.fn().mockRejectedValue(Object.assign(new Error('Lost response'), { status: 403, outcome: 'not_applied' }));
  vi.stubGlobal('fetch', fetcher);
  await expect(transport.tenantMutationApi('/api/update', update())).rejects.toMatchObject({ outcome: 'unknown' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test.each(['invalid-json', 'null', '[]', 'false'])('unverifiable dispatched reply %s remains unknown', async (body) => {
  const fetcher = fetchReply(new Response(body, { headers: headers(proof()) }));
  await expect(transport.tenantMutationApi('/api/update', update())).rejects.toMatchObject({ outcome: 'unknown' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test.each(['success', '401', 'explicit-rejected'] as const)(
  'late %s request completion cannot publish or lock a new same-account tenant',
  async (kind) => {
    const wire = deferred<Response>(),
      fetcher = vi.fn(() => wire.promise);
    vi.stubGlobal('fetch', fetcher);
    const pending = transport.tenantMutationApi('/api/update', update());
    const assertion = expect(pending).rejects.toMatchObject({ outcome: 'unknown' });
    const owner = freshSouth();
    wire.resolve(
      kind === 'success'
        ? response(applied())
        : response(
            { error: 'Old refusal', outcome: kind === 'explicit-rejected' ? 'rejected' : 'unknown' },
            null,
            kind === '401' ? 401 : 403,
          ),
    );
    await assertion;
    expect(session.sessionIdentity()).toBe(owner);
    expect(lock).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

test.each(['success', 'rejection', 'decoder-error'] as const)('late JSON %s cannot affect a newer context', async (kind) => {
  const json = deferred<unknown>(),
    reply = response(applied());
  const decoding = vi.spyOn(reply, 'json').mockImplementation(() => json.promise);
  fetchReply(reply);
  const pending = transport.tenantMutationApi('/api/update', update());
  const assertion = expect(pending).rejects.toMatchObject({ outcome: 'unknown' });
  await vi.waitFor(() => expect(decoding).toHaveBeenCalledTimes(1));
  const owner = freshSouth();
  if (kind === 'decoder-error') json.reject(new Error('Old JSON error'));
  else json.resolve(kind === 'success' ? applied() : { error: 'Old rejection', outcome: 'rejected' });
  await assertion;
  expect(session.sessionIdentity()).toBe(owner);
  expect(lock).not.toHaveBeenCalled();
});

test.each([false, true])(
  'an oversized command is definitely unsent, without erasing earlier delivery uncertainty (%s)',
  async (previouslyUncertain) => {
    const { commandOperations } = await import('./commandState.js');
    const owner = { connection: 'atlas', target: 'item', command: 'advance', commandVersion: 1, key: { id: 'same' } };
    const operation = commandOperations.start(owner, 0, { reason: 'x'.repeat(65536) });
    const onApplied = vi.fn(),
      fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    if (previouslyUncertain)
      await commandOperations.send(
        operation,
        'execute',
        async () => {
          throw new Error('Lost earlier response');
        },
        onApplied,
      );
    await commandOperations.send(operation, 'execute', transport.tenantMutationApi, onApplied);
    expect(fetcher).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
    expect(operation.phase).toBe(previouslyUncertain ? 'unknown' : 'error');
    expect(operation.uncertain).toBe(previouslyUncertain);
    if (!previouslyUncertain) expect(operation.message).toContain('too large');
    commandOperations.forget(owner);
    expect(commandOperations.get(owner)).toBe(previouslyUncertain ? operation : undefined);
  },
);

test('mutation admitted under an older revision may finish after renewal with its original ownership', async () => {
  const owner = session.captureSessionIdentity(),
    lease = session.captureTenantLease()!,
    wire = deferred<Response>();
  const fetcher = vi.fn(() => wire.promise);
  vi.stubGlobal('fetch', fetcher);
  const pending = transport.tenantMutationApi('/api/update', update());
  session.acceptTenantRenewal(owner, 1, { ...lease, revision: 2, expiresAt: lease.expiresAt + 60000 });
  wire.resolve(response(applied(), lease));
  expect(await pending).toEqual(applied());
  expect(fetcher).toHaveBeenCalledOnce();
  expect(session.captureSessionIdentity()).toBe(owner);
});

test.each(['wire', 'decode'] as const)('renewal cannot extend mutation publication deadline during %s', async (stage) => {
  const owner = session.captureSessionIdentity(),
    lease = session.captureTenantLease()!,
    wire = deferred<Response>(),
    json = deferred<unknown>();
  const reply = response(applied(), lease),
    decoding = vi.spyOn(reply, 'json').mockImplementation(() => json.promise);
  const fetcher = vi.fn(() => wire.promise);
  vi.stubGlobal('fetch', fetcher);
  const pending = transport.tenantMutationApi('/api/update', update());
  if (stage === 'decode') {
    wire.resolve(reply);
    await vi.waitFor(() => expect(decoding).toHaveBeenCalledOnce());
  }
  session.acceptTenantRenewal(owner, 1, { ...lease, revision: 2, expiresAt: lease.expiresAt + 60000 });
  vi.spyOn(Date, 'now').mockReturnValue(lease.expiresAt);
  if (stage === 'wire') wire.resolve(reply);
  json.resolve(applied());
  await expect(pending).rejects.toMatchObject({ outcome: 'unknown' });
  expect(session.captureSessionIdentity()).toBe(owner);
  expect(session.tenantLeaseActive()).toBe(true);
  expect(lock).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledOnce();
});

test('a write the stock refused at 422 comes back as the refused write it is, not a failure', async () => {
  fetchReply(response({ errors: [{ code: 'consumes_refused', message: 'Only 2 of Gasket left' }], outcome: 'rejected' }, null, 422));
  await expect(transport.tenantMutationApi('/api/update', update())).resolves.toMatchObject({
    error: expect.any(String),
    errors: [{ code: 'consumes_refused', message: 'Only 2 of Gasket left' }],
    outcome: 'rejected',
  });
});

test.each(['tenant_lease_stale', 'tenant_lease_expired'])(
  'HTTP 409 %s preserves exact refusal/uncertainty and suspends without retry',
  async (code) => {
    const owner = session.captureSessionIdentity(),
      lease = session.captureTenantLease()!;
    const fetcher = fetchReply(response({ code, error: 'Renew required', outcome: 'not_applied' }, null, 409));
    await expect(transport.tenantMutationApi('/api/update', update())).rejects.toMatchObject({ status: 409, code, outcome: 'not_applied' });
    expect(session.captureSessionIdentity()).toBe(owner);
    expect(session.tenantLeaseActive()).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(lock).not.toHaveBeenCalled();
    session.acceptTenantRenewal(owner, 1, { ...lease, revision: 2 });
    fetcher.mockResolvedValue(response({ code, error: 'Commit not confirmed', outcome: 'unknown' }, null, 409));
    await expect(transport.tenantMutationApi('/api/update', update())).rejects.toMatchObject({ outcome: 'unknown' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(session.tenantLeaseActive()).toBe(false);
  },
);

test.each(['tenant_lease_stale', 'tenant_lease_expired', 'tenant_context_unavailable', '401', '503', 'network', 'wrong-revision'])(
  'old-revision mutation %s cannot retire or suspend a renewed owner',
  async (kind) => {
    const owner = session.captureSessionIdentity(),
      lease = session.captureTenantLease()!,
      wire = deferred<Response>();
    const fetcher = vi.fn(() => wire.promise);
    vi.stubGlobal('fetch', fetcher);
    const pending = transport.tenantMutationApi('/api/update', update());
    session.acceptTenantRenewal(owner, 1, { ...lease, revision: 2 });
    if (kind === 'network') wire.reject(new Error('Lost acknowledgement'));
    else if (kind === 'wrong-revision') wire.resolve(response(applied(), { ...lease, revision: 2 }));
    else
      wire.resolve(
        response({ code: kind, error: 'Refused', outcome: 'not_applied' }, null, kind === '401' ? 401 : kind === '503' ? 503 : 409),
      );
    await expect(pending).rejects.toMatchObject({ outcome: kind === 'network' || kind === 'wrong-revision' ? 'unknown' : 'not_applied' });
    expect(session.captureSessionIdentity()).toBe(owner);
    expect(session.tenantLeaseActive()).toBe(true);
    expect(lock).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
  },
);

test("an import's report comes back whole, refusals and all, and only when the lease owns it", async () => {
  const body = { table: 'item', csv: 'id,name\r\nx,Name', mapping: ['id', 'name'], mode: 'commit' };
  const report = {
    outcome: 'not_applied',
    rows: 1,
    ready: 0,
    refused: [{ row: 1, line: 2, problems: [{ message: 'No.' }] }],
    error: 'No row can be imported.',
  };
  const fetcher = fetchReply(response(report));
  expect(await transport.tenantMutationApi('/api/import', structuredClone(body))).toEqual(report);
  expect(fetcher.mock.calls[0][0]).toBe('/api/import?app=atlas&tenant=north');
  // Unowned, the same report is no answer at all.
  fetchReply(response(report, null));
  await expect(transport.tenantMutationApi('/api/import', structuredClone(body))).rejects.toMatchObject({ outcome: 'unknown' });
  // A body that names anything beyond the import's own fields never leaves the page.
  await expect(transport.tenantMutationApi('/api/import', { ...body, tenant_id: 'south' })).rejects.toMatchObject({
    outcome: 'not_applied',
  });
});

test("a record's history and the inbox are read on the lease, addressed to its tenant", async () => {
  for (const [path, body] of [
    ['/api/record-history', { table: 'item', key: { id: 'same' } }],
    ['/api/inbox', { limit: 20 }],
    ['/api/inbox/read', { all: true }],
  ] as const) {
    const fetcher = fetchReply(response({ entries: [] }));
    await transport.tenantReadApi(path, { ...body });
    expect(fetcher.mock.calls[0][0]).toBe(`${path}?app=atlas&tenant=north`);
    await expect(transport.tenantReadApi(path, { ...body, tenant: 'south' })).rejects.toThrow();
  }
});

test("a record's decisions are read on the lease, addressed to its tenant, and never name another", async () => {
  for (const [path, body] of [
    ['/api/record-decisions', { table: 'item', key: { id: 'same' } }],
    ['/api/record-decisions/marks', { table: 'item', keys: [{ id: 'same' }] }],
    ['/api/record-decisions/why', { id: 'row-1' }],
    ['/api/record-decisions/settle', { id: 'row-1', action: 'dismiss' }],
  ] as const) {
    const fetcher = fetchReply(response({ suggestions: [] }));
    await transport.tenantReadApi(path, { ...body });
    expect(fetcher.mock.calls[0][0]).toBe(`${path}?app=atlas&tenant=north`);
    await expect(transport.tenantReadApi(path, { ...body, tenant: 'south' })).rejects.toThrow();
    await expect(transport.tenantReadApi(path, { ...body, tenantId: 'south' })).rejects.toThrow();
  }
});
