import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { test, type TestContext } from 'node:test';
import { createTenantInvitationHttp, isTenantInvitationHttpRequest } from '../packages/mistri/src/server/tenant/tenantInvitationHttp.js';
import { TenantInvitationFailure, type TenantInvitations } from '../packages/mistri/src/server/tenant/tenantInvitationOperations.js';
import {
  INVITATION_HTTP_HEADER as contextHeader,
  INVITATION_HTTP_ROOT as root,
  type InvitationAcceptanceResult,
  type InvitationAttempt,
} from '../packages/mistri/src/shared/tenantInvitations.js';
import { TENANT_HTTP_HEADERS as headers } from '../packages/mistri/src/shared/tenantContext.js';

// Deliberately fake service: these checks prove the transport contract only.
// Genuine native authentication and the real host's auth drain need integration tests.
const appId = 'invitation-app',
  accountId = 'native-account',
  context = 'invitation-context';
const invitationId = '11111111-1111-4111-8111-111111111111';
const membershipId = '22222222-2222-4222-8222-222222222222';
const recipient = { appId, accountId, context: 'new-recipient-context', expiresAt: 60_000 };
const issuer = {
  ...recipient,
  context: 'new-issuer-context',
  maxMembershipLifetimeMs: 100_000,
  maxRedemptionLifetimeMs: 50_000,
  maxPendingPerTenant: 10,
};
const accept: InvitationAttempt = {
  idempotencyKey: 'accept-key',
  intent: {
    operation: 'acceptInvitation',
    tenantId: 'north',
    expectedTenantVersion: '1',
    invitationId,
    expectedInvitationVersion: '1',
    membershipId,
    expectedMembershipVersion: '1',
  },
};
const issue: InvitationAttempt = {
  idempotencyKey: 'issue-key',
  intent: {
    operation: 'issueInvitation',
    tenantId: 'north',
    expectedTenantVersion: '1',
    accountId: 'recipient',
    roles: ['reader'],
    redeemUntil: 40_000,
    validUntil: 50_000,
  },
};
const result: InvitationAcceptanceResult = {
  receiptId: 'receipt',
  requestId: 'request',
  completedAt: '2026-09-08T00:00:00.000Z',
  replayed: false,
  invitationId,
  tenantId: 'north',
  membershipId,
  membershipVersion: '2',
  roles: ['reader'],
  validUntil: 50_000,
  status: 'accepted',
};
const preview = {
  intent: accept.intent as Extract<InvitationAttempt['intent'], { operation: 'acceptInvitation' }>,
  roles: ['reader'],
  redeemUntil: 40_000,
  validUntil: 50_000,
};
type Answer = { status: number; headers: Record<string, string | number>; body: any; text: string };
type RequestOptions = {
  operation?: string;
  path?: string;
  method?: string;
  body?: unknown;
  rawBody?: Buffer | string;
  headers?: Record<string, string | undefined>;
  extraHeaders?: string[];
  hold?: boolean;
  writeHead?: () => void;
};

function fixture(
  t: TestContext,
  overrides: Partial<TenantInvitations> = {},
  enabled = true,
  names?: (tenants: readonly string[]) => Promise<Readonly<Record<string, string>>>,
) {
  const calls: { method: keyof TenantInvitations; request: IncomingMessage; input: unknown }[] = [];
  const defaults: TenantInvitations = {
    openIssuer: async () => issuer,
    openRecipient: async () => recipient,
    preview: async () => preview,
    execute: async () => ({ result }),
    status: async () => result,
    targets: async () => ({ items: [], next: null }),
    list: async (_req, input) => ({ tenant: null, operation: input.operation, roles: ['reader'], items: [], next: null }),
    ...overrides,
  };
  const service = Object.fromEntries(
    Object.entries(defaults).map(([name, method]) => [
      name,
      async (request: IncomingMessage, input: never) => {
        calls.push({ method: name as keyof TenantInvitations, request, input });
        return method(request, input);
      },
    ]),
  ) as unknown as TenantInvitations;
  let active = true;
  const bound = { host: '127.0.0.1', port: 4711 };
  const handle = createTenantInvitationHttp({
    appId,
    invitations: enabled ? service : undefined,
    bound,
    assertActive: () => {
      if (!active) throw new Error('PRIVATE_RETIRED');
    },
    ...(names ? { names } : {}),
  });
  const begin = (options: RequestOptions = {}) => {
    const operation = options.operation ?? 'open-issuer';
    const req = new IncomingMessage(new Socket());
    req.url = options.path ?? `${root}/${operation}?app=${appId}`;
    req.method = options.method ?? (['targets', 'list'].includes(operation) ? 'GET' : 'POST');
    const body = options.rawBody ?? (req.method === 'GET' ? '' : JSON.stringify(options.body ?? {}));
    const values: Record<string, string | undefined> = {
      host: '127.0.0.1:4711',
      origin: 'http://127.0.0.1:4711',
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      [headers.app]: appId,
      [headers.account]: accountId,
      ...(operation.startsWith('open-') ? {} : { [contextHeader]: context }),
      ...options.headers,
    };
    req.rawHeaders = [
      ...Object.entries(values)
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .flat(),
      ...(options.extraHeaders ?? []),
    ];
    req.headers = Object.fromEntries(
      Array.from({ length: req.rawHeaders.length / 2 }, (_, index) => [
        req.rawHeaders[index * 2].toLowerCase(),
        req.rawHeaders[index * 2 + 1],
      ]),
    );
    // Stand in for the host's request-error listener; the transport removes its own.
    req.on('error', () => {});
    const res = new ServerResponse(req);
    const answer: Answer = { status: 0, headers: {}, body: undefined, text: '' };
    t.mock.method(res, 'writeHead', (status: number, responseHeaders: Record<string, string | number>) => {
      options.writeHead?.();
      answer.status = status;
      answer.headers = responseHeaders;
      return res;
    });
    t.mock.method(res, 'end', (chunk?: string) => {
      answer.text = chunk ?? '';
      answer.body = chunk ? JSON.parse(chunk) : undefined;
      return res;
    });
    const done = handle(req, res);
    const send = (chunk: string | Buffer = body) => {
      req.push(chunk);
      req.complete = true;
      req.push(null);
    };
    if (!options.hold) send();
    t.after(() => {
      req.destroy();
      res.destroy();
    });
    return { req, res, done, send, answer };
  };
  return {
    calls,
    bound,
    begin,
    retire: () => {
      active = false;
    },
    call: async (options: RequestOptions = {}) => {
      const request = begin(options);
      await request.done;
      return request.answer;
    },
  };
}
function denied(answer: Answer, outcome: 'not_applied' | 'unknown' = 'not_applied') {
  assert.ok(answer.status >= 400, answer.text);
  assert.deepEqual(answer.body, {
    error: 'The invitation operation could not be confirmed.',
    code: 'tenant_invitation_unavailable',
    outcome,
  });
  assert.equal(answer.headers['cache-control'], 'no-store');
  assert.equal(answer.headers[contextHeader], undefined);
  assert.doesNotMatch(answer.text, /PRIVATE_|SECRET/);
}
function owned(answer: Answer, expectedContext: string | undefined = context) {
  assert.equal(answer.status, 200, answer.text);
  assert.equal(answer.headers[headers.app], appId);
  assert.equal(answer.headers[headers.account], accountId);
  assert.equal(answer.headers[contextHeader], expectedContext);
  assert.equal(answer.headers['cache-control'], 'no-store');
  assert.equal(answer.headers['x-content-type-options'], 'nosniff');
  assert.equal(answer.headers['content-length'], Buffer.byteLength(answer.text));
}

test('issuer/recipient opens and preview use distinct exact envelopes and newly minted response ownership', async (t) => {
  const f = fixture(t);
  const opened = await f.call();
  owned(opened, issuer.context);
  assert.deepEqual(opened.body, { session: issuer });
  assert.deepEqual(f.calls[0].input, { expectedAccount: accountId });
  const recipientOpen = await f.call({ operation: 'open-recipient', body: { invitationId } });
  owned(recipientOpen, recipient.context);
  assert.deepEqual(recipientOpen.body, { session: recipient });
  assert.deepEqual(f.calls[1].input, { expectedAccount: accountId, invitationId });
  const inspected = await f.call({ operation: 'preview', body: { token: 'SYNTHETIC_SECRET' } });
  owned(inspected);
  assert.deepEqual(inspected.body, { preview });
  assert.doesNotMatch(inspected.text, /SECRET/);
  assert.deepEqual(f.calls[2].input, { expectedAccount: accountId, context, token: 'SYNTHETIC_SECRET' });
  const absent = fixture(t, { openIssuer: async () => null });
  const answer = await absent.call();
  assert.equal(answer.status, 200);
  assert.equal(answer.headers[contextHeader], undefined);
  assert.deepEqual(answer.body, { session: null });
});

test('execute handoff and token-free exact status have conservative absent/completed envelopes', async (t) => {
  const f = fixture(t, {
    execute: async (_req, input) => ({ result, ...(input.intent.operation === 'issueInvitation' ? { token: 'SYNTHETIC_SECRET' } : {}) }),
  });
  const issued = await f.call({ operation: 'execute', body: issue });
  owned(issued);
  assert.deepEqual(issued.body, { outcome: 'applied', result, token: 'SYNTHETIC_SECRET' });
  const accepted = await f.call({ operation: 'execute', body: { ...accept, token: 'SYNTHETIC_SECRET' } });
  owned(accepted);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[1].input)), {
    ...accept,
    expectedAccount: accountId,
    context,
    token: 'SYNTHETIC_SECRET',
  });
  const status = await f.call({ operation: 'status', body: accept });
  owned(status);
  assert.deepEqual(status.body, { status: 'completed', outcome: 'applied', result });
  assert.equal(Object.hasOwn(f.calls[2].input as object, 'token'), false);
  assert.doesNotMatch(status.text, /token|SECRET/);
  const absent = fixture(t, { status: async () => null });
  const missing = await absent.call({ operation: 'status', body: accept });
  owned(missing);
  assert.deepEqual(missing.body, { status: 'not_found', outcome: 'unknown', result: null });
  // Historical acceptance execution may omit the token; fresh authority belongs to the service.
  owned(await fixture(t).call({ operation: 'execute', body: accept }));
});

test('bounded targets and operation-specific lists forward only parsed selectors', async (t) => {
  const f = fixture(t);
  const targets = await f.call({ operation: 'targets', path: `${root}/targets?app=${appId}&after=north&limit=100` });
  owned(targets);
  assert.deepEqual(targets.body, { page: { items: [], next: null } });
  assert.deepEqual(f.calls[0].input, { expectedAccount: accountId, context, after: 'north', limit: 100 });
  for (const operation of ['revokeInvitation', 'reissueInvitation']) {
    const listed = await f.call({ operation: 'list', path: `${root}/list?app=${appId}&tenantId=north&operation=${operation}&limit=1` });
    owned(listed);
    assert.equal(listed.body.page.operation, operation);
    assert.deepEqual(f.calls.at(-1)!.input, { expectedAccount: accountId, context, tenantId: 'north', operation, limit: 1 });
  }
});

test('aliases are claimed by the classifier and refused without service dispatch', async (t) => {
  const f = fixture(t);
  for (const path of [
    root,
    `${root}/`,
    `${root}/unknown`,
    `${root}/open-issuer/`,
    `${root}//open-issuer`,
    `${root}/%6fpen-issuer`,
    `${root}/%256fpen-issuer`,
    '/api//tenant/invitations/open-issuer',
    '/API/tenant/invitations/open-issuer',
    '/api/tenant%2finvitations/open-issuer',
    '/api/tenant%252finvitations/open-issuer',
    '/api\\tenant\\invitations\\open-issuer',
    `${root}/../invitations/open-issuer`,
    `${root}/../bootstrap`,
    `${root}/%`,
    `${root}/open-issuer#token=SECRET`,
    `//localhost${root}/open-issuer`,
  ]) {
    const req = { url: `${path}?app=${appId}` } as IncomingMessage;
    assert.equal(isTenantInvitationHttpRequest(req), true, path);
    denied(await f.call({ path: req.url }));
  }
  for (const path of ['/api/tenant/bootstrap', '/api/tenant/administration/open', '/app/invitations']) {
    assert.equal(isTenantInvitationHttpRequest({ url: path } as IncomingMessage), false);
  }
  for (const path of [`${root}/status/`, `${root}/%73tatus`, '/API/tenant/invitations/status', `${root}//status`]) {
    denied(await f.call({ operation: 'status', path: `${path}?app=${appId}`, body: accept }), 'unknown');
  }
  assert.equal(f.calls.length, 0);
});

test('scope headers are required, singular and isolated from administration/business assertions', async (t) => {
  const f = fixture(t);
  for (const name of [headers.app, headers.account]) {
    for (const value of [undefined, '', ' ', 'a,b']) denied(await f.call({ headers: { [name]: value } }));
  }
  denied(await f.call({ headers: { [headers.app]: 'another-app' } }));
  for (const name of [
    headers.context,
    headers.tab,
    headers.tenant,
    headers.revision,
    'x-mistri-administration-context',
    'x-mistri-conn',
    'x-mistri-unknown',
  ]) {
    denied(await f.call({ headers: { [name]: 'PRIVATE_AUTHORITY' } }));
  }
  for (const name of ['host', 'origin', 'content-type', 'cookie', headers.app, headers.account]) {
    denied(await f.call({ headers: name === 'cookie' ? { cookie: 'session' } : {}, extraHeaders: [name.toUpperCase(), 'duplicate'] }));
  }
  denied(await f.call({ operation: 'targets', extraHeaders: [contextHeader.toUpperCase(), context] }));
  for (const operation of ['open-issuer', 'open-recipient']) {
    denied(await f.call({ operation, body: { invitationId }, headers: { [contextHeader]: context } }));
  }
  for (const operation of ['preview', 'execute', 'status', 'targets', 'list']) {
    denied(await f.call({ operation, headers: { [contextHeader]: undefined } }), operation === 'status' ? 'unknown' : 'not_applied');
  }
  assert.equal(f.calls.length, 0);
});

test('query extras, secret URLs, duplicated selectors and noncanonical pagination never reach the service', async (t) => {
  const f = fixture(t);
  for (const query of [
    '',
    'app=other',
    `app=${appId}&app=${appId}`,
    `app=${appId}&token=SECRET`,
    `app=${appId}&%74oken=SECRET`,
    `app=${appId}&after=a`,
    `app=${appId}&limit=1`,
    `app=${appId}&tenant=north`,
    `app=${appId}&conn=private`,
  ]) {
    denied(await f.call({ path: `${root}/open-issuer?${query}` }));
  }
  for (const query of [
    'limit=0',
    'limit=01',
    'limit=101',
    'limit=1.0',
    'limit=-1',
    'limit=1e1',
    'limit=1&limit=2',
    'after=',
    'after=a&after=b',
    `after=${'x'.repeat(129)}`,
    'after=%FF',
    'after=%',
    'token=SECRET',
  ]) {
    denied(await f.call({ operation: 'targets', path: `${root}/targets?app=${appId}&${query}` }));
  }
  for (const query of [
    '',
    '&tenantId=north',
    '&tenantId=north&operation=issueInvitation',
    '&tenantId=north&operation=revokeInvitation&tenantId=south',
    '&tenantId=&operation=revokeInvitation',
  ]) {
    denied(await f.call({ operation: 'list', path: `${root}/list?app=${appId}${query}` }));
  }
  assert.equal(f.calls.length, 0);
});

test('strict bodies and token placement refuse caller authority and malformed intent before dispatch', async (t) => {
  const f = fixture(t);
  for (const rawBody of [
    '',
    '{',
    'null',
    '[]',
    'true',
    '"text"',
    '{"app":"other"}',
    '{"__proto__":{}}',
    Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
    '\uFEFF{}',
  ]) {
    denied(await f.call({ rawBody }));
  }
  for (const body of [{}, { invitationId, token: 'SECRET' }, { invitationId, expectedAccount: 'other' }]) {
    denied(await f.call({ operation: 'open-recipient', body }));
  }
  for (const body of [{}, { token: null }, { token: '' }, { token: 'SECRET', context }, { token: 'SECRET', intent: accept.intent }]) {
    denied(await f.call({ operation: 'preview', body }));
  }
  for (const body of [
    {},
    { ...accept, expectedAccount: accountId },
    { ...accept, context },
    { ...accept, idempotencyKey: '' },
    { ...accept, idempotencyKey: 'é'.repeat(129) },
    { ...accept, intent: { ...accept.intent, token: 'SECRET' } },
    { ...accept, intent: { ...accept.intent, expectedTenantVersion: 1 } },
    { ...accept, intent: { ...accept.intent, operation: 'grantMembership' } },
  ]) {
    denied(await f.call({ operation: 'execute', body }));
    denied(await f.call({ operation: 'status', body }), 'unknown');
  }
  for (const intent of [
    issue.intent,
    { ...accept.intent, operation: 'revokeInvitation' },
    { ...accept.intent, operation: 'reissueInvitation', roles: ['reader'], redeemUntil: 40_000, validUntil: 50_000 },
  ]) {
    denied(await f.call({ operation: 'execute', body: { ...accept, intent, token: 'SECRET' } }));
  }
  denied(await f.call({ operation: 'execute', body: { ...accept, token: null } }));
  denied(await f.call({ operation: 'status', body: { ...accept, token: 'SECRET' } }), 'unknown');
  assert.equal(f.calls.length, 0);
});

test('method, host/origin, encoding and bounded known/chunked bodies fail closed', async (t) => {
  const f = fixture(t);
  for (const operation of ['open-issuer', 'execute', 'status', 'targets']) {
    const outcome = operation === 'status' ? 'unknown' : 'not_applied';
    for (const extra of [
      { host: 'hostile.example' },
      { origin: 'https://hostile.example' },
      { origin: 'null' },
      { origin: 'http://user@127.0.0.1:4711' },
      { origin: 'http://127.0.0.1:4711/path' },
      { origin: 'ftp://127.0.0.1:4711' },
      { 'sec-fetch-site': 'cross-site' },
      { 'content-encoding': 'identity' },
    ]) {
      denied(await f.call({ operation, body: accept, headers: extra }), outcome);
    }
    const wrongMethod = await f.call({ operation, method: operation === 'targets' ? 'POST' : 'GET' });
    denied(wrongMethod, outcome);
    assert.equal(wrongMethod.status, 405);
  }
  denied(await f.call({ headers: { 'content-type': 'text/plain' } }));
  denied(await f.call({ operation: 'targets', headers: { 'content-length': '1' } }));
  denied(await f.call({ operation: 'targets', headers: { 'transfer-encoding': 'chunked' } }));
  for (const operation of ['open-issuer', 'status']) {
    for (const chunked of [false, true]) {
      const answer = await f.call({
        operation,
        rawBody: ' '.repeat(65_537),
        headers: chunked ? { 'content-length': undefined, 'transfer-encoding': 'chunked' } : {},
      });
      denied(answer, operation === 'status' ? 'unknown' : 'not_applied');
      assert.equal(answer.status, 413);
    }
  }
  assert.equal(f.calls.length, 0);
  owned(await f.call({ rawBody: '{}'.padEnd(65_536, ' ') }), issuer.context);
});

test('only exact safe service failure descriptors can settle an execute as not_applied', async (t) => {
  let accessed = 0;
  const accessor = new TenantInvitationFailure('not_applied');
  Object.defineProperty(accessor, 'outcome', {
    get() {
      accessed++;
      throw new Error('PRIVATE_GETTER');
    },
  });
  class DerivedFailure extends TenantInvitationFailure {}
  const proxy = new Proxy(new TenantInvitationFailure('not_applied'), {
    getPrototypeOf() {
      accessed++;
      throw new Error('PRIVATE_PROXY');
    },
    get() {
      accessed++;
      throw new Error('PRIVATE_PROXY');
    },
  });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const error of [
    new Error('PRIVATE_DATABASE'),
    { outcome: 'not_applied', code: 'tenant_invitation_unavailable' },
    new DerivedFailure('not_applied'),
    accessor,
    proxy,
    revoked.proxy,
    null,
    'PRIVATE_STRING',
    Object.assign(new TenantInvitationFailure('not_applied'), { outcome: 'applied' }),
  ]) {
    const f = fixture(t, {
      execute: async () => {
        throw error;
      },
      status: async () => {
        throw error;
      },
    });
    denied(await f.call({ operation: 'execute', body: accept }), 'unknown');
    denied(await f.call({ operation: 'status', body: accept }), 'unknown');
  }
  assert.equal(accessed, 0);
  for (const outcome of ['not_applied', 'unknown'] as const) {
    const f = fixture(t, {
      execute: async () => {
        throw new TenantInvitationFailure(outcome);
      },
      status: async () => {
        throw new TenantInvitationFailure(outcome);
      },
    });
    denied(await f.call({ operation: 'execute', body: accept }), outcome);
    denied(await f.call({ operation: 'status', body: accept }), 'unknown');
  }
});

test('missing service, retired binding and mismatched opened owners disclose no successful ownership', async (t) => {
  const omitted = fixture(t, {}, false);
  denied(await omitted.call());
  denied(await omitted.call({ operation: 'status', body: accept }), 'unknown');
  const retired = fixture(t);
  retired.retire();
  denied(await retired.call());
  assert.equal(retired.calls.length, 0);
  const rebound = fixture(t);
  rebound.bound.host = 'another-host';
  denied(await rebound.call());
  assert.equal(rebound.calls.length, 0);
  for (const session of [
    { ...issuer, appId: 'other' },
    { ...issuer, accountId: 'other' },
    { ...issuer, context: 'bad\nheader' },
  ]) {
    denied(await fixture(t, { openIssuer: async () => session }).call());
  }
});

test('partial body readers remain pending until the borrowing host interrupts or completes them', async (t) => {
  const f = fixture(t),
    request = f.begin({ operation: 'execute', body: accept, hold: true });
  let settled = false;
  void request.done.then(() => {
    settled = true;
  });
  request.req.push('{"idempotencyKey":');
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(f.calls.length, 0);
  f.retire();
  request.req.destroy();
  await request.done;
  denied(request.answer);
  assert.equal(f.calls.length, 0);
  assert.equal(request.req.listenerCount('data'), 0);
  assert.equal(request.req.listenerCount('aborted'), 0);
  const complete = fixture(t),
    held = complete.begin({ body: {}, hold: true });
  complete.retire();
  held.send();
  await held.done;
  denied(held.answer);
  assert.equal(complete.calls.length, 0);
});

test('body errors and aborted status readers settle safely and remove owned listeners', async (t) => {
  for (const event of ['error', 'aborted', 'close']) {
    const f = fixture(t),
      held = f.begin({ operation: 'status', hold: true });
    held.req.emit(event, new Error('PRIVATE_BODY_FAILURE'));
    await held.done;
    denied(held.answer, 'unknown');
    assert.equal(f.calls.length, 0);
    for (const name of ['data', 'end', 'aborted', 'close']) assert.equal(held.req.listenerCount(name), 0);
    assert.equal(held.req.listenerCount('error'), 1, 'the host keeps its error listener');
  }
});

test('pending execute and response failures retain unknown after the service may have applied', async (t) => {
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const dispatched = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = fixture(t, {
    execute: async () => {
      entered();
      await waiting;
      return { result };
    },
  });
  const held = f.begin({ operation: 'execute', body: accept });
  await dispatched;
  let settled = false;
  void held.done.then(() => {
    settled = true;
  });
  f.retire();
  await Promise.resolve();
  assert.equal(settled, false);
  release();
  await held.done;
  denied(held.answer, 'unknown');
  let failed = false;
  const live = fixture(t);
  denied(
    await live.call({
      operation: 'execute',
      body: accept,
      writeHead: () => {
        if (!failed) {
          failed = true;
          throw new TenantInvitationFailure('not_applied');
        }
      },
    }),
    'unknown',
  );
  assert.equal(failed, true);
  const recovered = await live.call({ operation: 'status', body: accept });
  owned(recovered);
  assert.deepEqual(recovered.body, { status: 'completed', outcome: 'applied', result });
});

test("targets say each tenant's name beside its id where it has one, and a failed lookup leaves the ids", async (t) => {
  const tenant = (tenantId: string) => ({
    tenantId,
    tenant: { tenantId, status: 'active' as const, version: '1' },
    capabilities: [{ operation: 'issueInvitation' as const, roles: ['reader'] }],
  });
  const targets = async () => ({ items: [tenant('north'), tenant('south')], next: null });
  const asked: (readonly string[])[] = [];
  const named = fixture(t, { targets }, true, async (tenants) => {
    asked.push(tenants);
    return { north: 'North Motors' };
  });
  const answer = await named.call({ operation: 'targets' });
  owned(answer);
  assert.deepEqual(asked, [['north', 'south']]);
  assert.deepEqual(
    answer.body.page.items.map((item: { tenantId: string; name?: string }) => [item.tenantId, item.name]),
    [
      ['north', 'North Motors'],
      ['south', undefined],
    ],
  );
  const failing = fixture(t, { targets }, true, async () => {
    throw new Error('PRIVATE_NAMES');
  });
  const plain = await failing.call({ operation: 'targets' });
  owned(plain);
  assert.deepEqual(plain.body.page, await targets());
});
