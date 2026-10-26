import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  INVITATION_HTTP_HEADER as contextHeader,
  type InvitationAcceptanceResult,
  type InvitationAttempt,
  type InvitationIssuerIntent,
  type InvitationIssuerSession,
  type InvitationPair,
  type InvitationPreview,
  type InvitationRecipientSession,
  type InvitationResult,
  type InvitationTarget,
} from '../shared/tenantInvitations.js';
import {
  captureAccountIdentity,
  establishSessionIdentity,
  establishTenantSelection,
  lockSessionIdentity,
  requireTenantSelection,
  sessionIdentity,
} from '../../../kit/src/client/sessionIdentity.js';
import {
  executeInvitation,
  hasInvitationSession,
  hasUnresolvedInvitations,
  listInvitations,
  listInvitationTargets,
  openInvitationIssuer,
  openInvitationRecipient,
  parseInvitationTokenId,
  previewInvitation,
  statusInvitation,
  TenantInvitationsController,
} from './tenantInvitations.js';

const invitationId = '11111111-1111-4111-8111-111111111111',
  membershipId = '22222222-2222-4222-8222-222222222222';
const newInvitationId = '33333333-3333-4333-8333-333333333333',
  newMembershipId = '44444444-4444-4444-8444-444444444444';
const key = '55555555-5555-4555-8555-555555555555';
const token = `twi1.${invitationId}.${'A'.repeat(43)}`,
  newToken = `twi1.${newInvitationId}.${'A'.repeat(43)}`;
const revision = '9007199254740993';
let issuer: InvitationIssuerSession, recipient: InvitationRecipientSession, target: InvitationTarget;
let issue: Extract<InvitationIssuerIntent, { operation: 'issueInvitation' }>;
let preview: InvitationPreview, original: InvitationPair;
let completedAt: string;
let fetcher: ReturnType<typeof vi.fn>;
type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
const mutable = <T>(value: T): Mutable<T> => structuredClone(value) as Mutable<T>;
const controllers: TenantInvitationsController[] = [];
function controller(callback?: (result: InvitationAcceptanceResult) => void | Promise<void>) {
  const c = new TenantInvitationsController(captureAccountIdentity(), callback);
  controllers.push(c);
  return c;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function response(data: unknown, context = issuer.context, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'x-mistri-account': 'operator', 'x-mistri-app': 'app', [contextHeader]: context },
  });
}
function refusal(outcome = 'not_applied', extra = {}) {
  return new Response(
    JSON.stringify({ code: 'tenant_invitation_unavailable', error: 'The invitation operation could not be confirmed.', outcome, ...extra }),
    { status: 403 },
  );
}
function acceptance(replayed = false): InvitationAcceptanceResult {
  return {
    receiptId: 'receipt',
    requestId: 'request',
    completedAt,
    replayed,
    invitationId,
    tenantId: 'north',
    membershipId,
    membershipVersion: '9007199254740994',
    roles: [...preview.roles],
    validUntil: preview.validUntil,
    status: 'accepted',
  };
}
function revoked(): InvitationPair {
  return {
    invitation: { ...original.invitation, version: '9007199254740994', status: 'revoked' },
    membership: { ...original.membership, version: '9007199254740994', status: 'revoked' },
  };
}
function issuerResult(intent: InvitationIssuerIntent = issue, replayed = false): InvitationResult {
  const fresh: InvitationPair = {
    invitation: {
      ...original.invitation,
      invitationId: newInvitationId,
      membershipId: newMembershipId,
      version: '1',
      issuanceOperation: intent.operation === 'reissueInvitation' ? 'reissueInvitation' : 'issueInvitation',
      ...('roles' in intent ? { roles: intent.roles, redeemUntil: intent.redeemUntil, validUntil: intent.validUntil } : {}),
    },
    membership: {
      ...original.membership,
      membershipId: newMembershipId,
      version: '1',
      ...('roles' in intent ? { roles: intent.roles, validUntil: intent.validUntil } : {}),
    },
  };
  return {
    receiptId: 'receipt',
    requestId: 'request',
    completedAt,
    replayed,
    change: {
      operation: intent.operation,
      tenant: target.tenant!,
      before: intent.operation === 'issueInvitation' ? null : original,
      after: intent.operation === 'revokeInvitation' ? revoked() : fresh,
      ...(intent.operation === 'reissueInvitation' ? { revoked: revoked() } : {}),
    },
  };
}
function manage(operation: 'revokeInvitation' | 'reissueInvitation'): InvitationIssuerIntent {
  return operation === 'reissueInvitation'
    ? { ...preview.intent, operation, roles: ['editor'], redeemUntil: issue.redeemUntil, validUntil: issue.validUntil }
    : { ...preview.intent, operation };
}
function list(operation = 'revokeInvitation') {
  return {
    tenant: target.tenant,
    operation,
    roles: operation === 'reissueInvitation' ? ['reader', 'editor'] : ['reader'],
    items: [original],
    next: null,
  };
}
async function ready(c = controller()) {
  await c.openIssuer();
  await c.loadTargets();
  c.select('north');
  return c;
}
async function unknown(recipientOperation = false) {
  const c = controller();
  if (recipientOperation) await c.previewToken(token);
  else {
    await ready(c);
    expect(c.prepare(issue)).toBe(true);
  }
  fetcher.mockRejectedValueOnce(new Error('Lost acknowledgement'));
  await c.execute();
  expect(c.snapshot().phase).toBe('unknown');
  return c;
}
beforeEach(() => {
  lockSessionIdentity();
  establishSessionIdentity({ signedIn: true, accountId: 'operator', appId: 'app' });
  requireTenantSelection();
  const now = Date.now();
  completedAt = new Date(now).toISOString();
  recipient = { appId: 'app', accountId: 'operator', context: 'recipient-context', expiresAt: now + 300_000 };
  issuer = {
    ...recipient,
    context: 'issuer-context',
    maxMembershipLifetimeMs: 86_400_000,
    maxRedemptionLifetimeMs: 3_600_000,
    maxPendingPerTenant: 100,
  };
  target = {
    tenantId: 'north',
    tenant: { tenantId: 'north', version: revision, status: 'active' },
    capabilities: [
      { operation: 'issueInvitation', roles: ['reader'] },
      { operation: 'reissueInvitation', roles: ['reader', 'editor'] },
      { operation: 'revokeInvitation', roles: ['reader'] },
    ],
  };
  issue = {
    operation: 'issueInvitation',
    tenantId: 'north',
    expectedTenantVersion: revision,
    accountId: 'recipient',
    roles: ['reader'],
    redeemUntil: now + 60_000,
    validUntil: now + 600_000,
  };
  original = {
    invitation: {
      invitationId,
      membershipId,
      tenantId: 'north',
      accountId: 'recipient',
      inviterId: 'operator',
      version: revision,
      roles: ['reader'],
      expectedTenantVersion: revision,
      policyId: 'policy',
      policyVersion: 'v1',
      issuanceOperation: 'issueInvitation',
      createdAt: now - 1000,
      redeemUntil: issue.redeemUntil,
      validUntil: issue.validUntil,
      status: 'pending',
    },
    membership: {
      membershipId,
      tenantId: 'north',
      accountId: 'recipient',
      version: revision,
      roles: ['reader'],
      validUntil: issue.validUntil,
      status: 'invited',
    },
  };
  preview = {
    intent: {
      operation: 'acceptInvitation',
      tenantId: 'north',
      expectedTenantVersion: revision,
      invitationId,
      expectedInvitationVersion: revision,
      membershipId,
      expectedMembershipVersion: revision,
    },
    roles: ['reader'],
    redeemUntil: issue.redeemUntil,
    validUntil: issue.validUntil,
  };
  fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const route = new URL(url, 'http://app.test').pathname.split('/').pop();
    if (route === 'open-issuer') return response({ session: issuer });
    if (route === 'open-recipient') return response({ session: recipient }, recipient.context);
    if (route === 'targets') return response({ page: { items: [target], next: null } });
    if (route === 'list') return response({ page: list(new URL(url, 'http://app.test').searchParams.get('operation')!) });
    if (route === 'preview') return response({ preview }, recipient.context);
    const attempt = JSON.parse(init.body as string) as InvitationAttempt;
    const result =
      attempt.intent.operation === 'acceptInvitation' || attempt.intent.operation === 'claimInvitation'
        ? acceptance(route === 'status')
        : issuerResult(attempt.intent, route === 'status');
    const context = attempt.intent.operation === 'acceptInvitation' ? recipient.context : issuer.context;
    if (route === 'status') return response({ status: 'completed', outcome: 'applied', result }, context);
    return response(
      {
        outcome: 'applied',
        result,
        ...(attempt.intent.operation === 'issueInvitation' || attempt.intent.operation === 'reissueInvitation' ? { token: newToken } : {}),
      },
      context,
    );
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  controllers.splice(0).forEach((c) => c.retire());
  lockSessionIdentity();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('issuer and recipient admission use only native ownership, canonical routes, and distinct context assertions', async () => {
  expect(await openInvitationIssuer(sessionIdentity())).toEqual(issuer);
  expect(await openInvitationRecipient(sessionIdentity(), invitationId)).toEqual(recipient);
  for (const [url, init] of fetcher.mock.calls) {
    expect(url).toMatch(/^\/api\/tenant\/invitations\/open-(issuer|recipient)\?app=app$/);
    expect(init).toMatchObject({ method: 'POST', cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
    expect(init.headers).toEqual({ 'x-mistri-account': 'operator', 'x-mistri-app': 'app', 'content-type': 'application/json' });
  }
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ invitationId });
  expect(sessionIdentity().tenant).toBeUndefined();
});

test('null admission requires exact body, owner headers and no context assertion', async () => {
  const good = response({ session: null });
  good.headers.delete(contextHeader);
  fetcher
    .mockResolvedValueOnce(good)
    .mockResolvedValueOnce(response({ session: null }))
    .mockResolvedValueOnce(response({ session: issuer, token }));
  expect(await openInvitationIssuer(sessionIdentity())).toBeNull();
  await expect(openInvitationIssuer(sessionIdentity())).rejects.toMatchObject({ outcome: 'not_applied' });
  await expect(openInvitationIssuer(sessionIdentity())).rejects.toMatchObject({ outcome: 'not_applied' });
});

test.each(['x-mistri-account', 'x-mistri-app', contextHeader, 'x-mistri-context'])(
  'mismatched/unexpected %s response ownership leaves execution unknown',
  async (header) => {
    const wrong = response({ outcome: 'applied', result: issuerResult(), token: newToken });
    wrong.headers.set(header, 'foreign');
    fetcher.mockResolvedValueOnce(wrong);
    await expect(executeInvitation(sessionIdentity(), issuer, { idempotencyKey: key, intent: issue })).rejects.toMatchObject({
      outcome: 'unknown',
    });
  },
);

test('account is rechecked after a held bounded response body; same-account relogin cannot adopt it', async () => {
  const held = deferred<void>();
  const stream = new ReadableStream<Uint8Array>({
    async start(c) {
      await held.promise;
      c.enqueue(new TextEncoder().encode(JSON.stringify({ outcome: 'applied', result: issuerResult(), token: newToken })));
      c.close();
    },
  });
  fetcher.mockResolvedValueOnce(new Response(stream, { headers: response({}).headers }));
  const pending = executeInvitation(sessionIdentity(), issuer, { idempotencyKey: key, intent: issue });
  await Promise.resolve();
  lockSessionIdentity();
  establishSessionIdentity({ signedIn: true, accountId: 'operator', appId: 'app' });
  held.resolve();
  await expect(pending).rejects.toMatchObject({ outcome: 'unknown' });
});

test.each(['length', 'stream', 'utf8'])('bounded reader refuses invalid %s without accepting a mutation result', async (kind) => {
  let reply: Response;
  if (kind === 'length') {
    reply = response({});
    reply.headers.set('content-length', '4194305');
  } else
    reply = new Response(kind === 'stream' ? new Uint8Array(4_194_305).fill(32) : new Uint8Array([0xc3, 0x28]), {
      headers: response({}).headers,
    });
  fetcher.mockResolvedValueOnce(reply);
  await expect(executeInvitation(sessionIdentity(), issuer, { idempotencyKey: key, intent: issue })).rejects.toMatchObject({
    outcome: 'unknown',
  });
});

test('strict bounded pages preserve exact decimal revisions and operation-specific ceilings', async () => {
  const page = await listInvitationTargets(sessionIdentity(), issuer, 'earlier');
  expect(page.items[0].tenant?.version).toBe(revision);
  await listInvitations(sessionIdentity(), issuer, 'north', 'reissueInvitation', invitationId);
  const [url, init] = fetcher.mock.calls[1];
  expect(Object.fromEntries(new URL(url, 'http://app.test').searchParams)).toEqual({
    app: 'app',
    tenantId: 'north',
    operation: 'reissueInvitation',
    after: invitationId,
    limit: '20',
  });
  expect(init.headers).toEqual({ 'x-mistri-account': 'operator', 'x-mistri-app': 'app', [contextHeader]: issuer.context });
  expect(Object.isFrozen(page.items[0].capabilities)).toBe(true);
});

test('a valid server-sized invitation page above one MiB remains readable', async () => {
  const ceiling = Array.from({ length: 256 }, (_, index) => `${'r'.repeat(200)}${index}`);
  const items = Array.from({ length: 11 }, (_, index) => {
    const suffix = String(index).padStart(12, '0');
    const invitationId = `11111111-1111-4111-8111-${suffix}`,
      membershipId = `22222222-2222-4222-8222-${suffix}`;
    const accountId = `recipient-${index}`;
    return {
      invitation: { ...original.invitation, invitationId, membershipId, accountId, roles: ceiling },
      membership: { ...original.membership, membershipId, accountId, roles: ceiling },
    };
  });
  const body = { page: { ...list(), roles: ceiling, items } };
  const bytes = new TextEncoder().encode(JSON.stringify(body)).length;
  expect(bytes).toBeGreaterThan(1_048_576);
  expect(bytes).toBeLessThan(2_000_000);
  fetcher.mockResolvedValueOnce(response(body));
  const page = await listInvitations(sessionIdentity(), issuer, 'north', 'revokeInvitation');
  expect(page.items).toHaveLength(11);
  expect(page.roles).toEqual(ceiling);
});

test.each(['oversized', 'duplicate', 'secret', 'foreign', 'ceiling', 'version', 'pair'])(
  'rejects malformed invitation listing: %s',
  async (kind) => {
    const p = mutable(list());
    if (kind === 'oversized') p.items = Array(21).fill(original);
    if (kind === 'duplicate') p.items.push(mutable(original));
    if (kind === 'secret') Object.assign(p.items[0].invitation, { digest: 'secret' });
    if (kind === 'foreign') p.items[0].invitation.tenantId = 'south';
    if (kind === 'ceiling') p.roles = ['editor'];
    if (kind === 'version') p.items[0].invitation.version = '01';
    if (kind === 'pair') p.items[0].membership.accountId = 'other';
    fetcher.mockResolvedValueOnce(response({ page: p }));
    await expect(listInvitations(sessionIdentity(), issuer, 'north', 'revokeInvitation')).rejects.toMatchObject({ outcome: 'not_applied' });
  },
);

test.each([
  `${token} `,
  ` ${token}`,
  token.replace('twi1', 'TWI1'),
  token.slice(0, -1) + 'B',
  token + '=',
  token.replace(invitationId, invitationId.replace('-4111-', '-1111-')),
  'https://example.test/?token=' + token,
])('rejects noncanonical token without dispatch: %s', async (malformed) => {
  expect(parseInvitationTokenId(malformed)).toBeNull();
  const c = controller();
  await c.previewToken(malformed);
  expect(fetcher).not.toHaveBeenCalled();
  expect(c.snapshot().attempt).toBeNull();
});

test('canonical token parsing accepts every legal final sextet without crypto hashing', () => {
  for (const last of 'AEIMQUYcgkosw048') expect(parseInvitationTokenId(token.slice(0, -1) + last)).toBe(invitationId);
});

test('preview sends token in POST body only, binds context to its ID and freezes a token-free acceptance attempt', async () => {
  const c = controller();
  await c.previewToken(token);
  const view = c.snapshot();
  expect(view).toMatchObject({ phase: 'review', preview, recipientSession: recipient, handoffToken: null });
  expect(view.attempt?.intent).toEqual(preview.intent);
  expect(Object.isFrozen(view.attempt?.intent)).toBe(true);
  expect(JSON.stringify(view)).not.toContain(token);
  expect(JSON.stringify(c)).not.toContain(token);
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    '/api/tenant/invitations/open-recipient?app=app',
    '/api/tenant/invitations/preview?app=app',
  ]);
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ token });
  expect(fetcher.mock.calls[1][1].headers[contextHeader]).toBe(recipient.context);
});

test.each(['invitation', 'extra', 'roles', 'expired'])('preview refuses malformed or mismatched %s', async (kind) => {
  const p = mutable(preview);
  if (kind === 'invitation') p.intent = { ...p.intent, invitationId: newInvitationId };
  if (kind === 'extra') Object.assign(p, { token });
  if (kind === 'roles') p.roles = ['reader', 'reader'];
  if (kind === 'expired') p.redeemUntil = Date.now();
  fetcher.mockResolvedValueOnce(response({ preview: p }, recipient.context));
  await expect(previewInvitation(sessionIdentity(), recipient, token)).rejects.toMatchObject({ outcome: 'not_applied' });
});

test('prepare freezes exactly one UUID and validates target, operation role ceiling, versions and terms', async () => {
  const c = await ready(),
    random = vi.spyOn(crypto, 'randomUUID');
  for (const patch of [
    { roles: ['editor'] },
    { roles: [] },
    { roles: ['reader', 'reader'] },
    { tenantId: 'other' },
    { expectedTenantVersion: '9007199254740992' },
    { redeemUntil: Date.now() },
    { redeemUntil: issue.validUntil + 1 },
    { validUntil: Date.now() + issuer.maxMembershipLifetimeMs + 10_000 },
    { redeemUntil: Date.now() + issuer.maxRedemptionLifetimeMs + 10_000 },
    { token },
    { accountId: '' },
  ])
    expect(c.prepare({ ...issue, ...patch } as InvitationIssuerIntent)).toBe(false);
  expect(random).not.toHaveBeenCalled();
  const draft = structuredClone(issue);
  expect(c.prepare(draft)).toBe(true);
  const attempt = c.snapshot().attempt;
  (draft.roles as string[]).push('editor');
  expect(attempt?.intent).toEqual(issue);
  expect(Object.isFrozen(attempt)).toBe(true);
  expect(random).toHaveBeenCalledTimes(1);
  expect(c.prepare(issue)).toBe(false);
  await c.loadTargets();
  await c.previewToken(token);
  c.select('north');
  expect(c.snapshot().attempt).toBe(attempt);
  expect(random).toHaveBeenCalledTimes(1);
  c.cancelReview();
  expect(c.snapshot().phase).toBe('idle');
});

test.each(['revokeInvitation', 'reissueInvitation'] as const)(
  '%s requires the matching authorized list and exact pair versions',
  async (operation) => {
    const c = await ready(),
      intent = manage(operation);
    expect(c.prepare(intent)).toBe(false);
    await c.loadInvitations(operation);
    expect(c.prepare({ ...intent, expectedInvitationVersion: '1' } as InvitationIssuerIntent)).toBe(false);
    expect(c.prepare({ ...intent, expectedMembershipVersion: '1' } as InvitationIssuerIntent)).toBe(false);
    expect(c.prepare({ ...intent, membershipId: newMembershipId } as InvitationIssuerIntent)).toBe(false);
    expect(c.prepare(intent)).toBe(true);
    await c.execute();
    expect(c.snapshot().result).toEqual(issuerResult(intent));
    expect(c.snapshot().handoffToken).toBe(operation === 'reissueInvitation' ? newToken : null);
  },
);

test('prepare uses the listing tenant revision; a changed target requires the exact fresh version', async () => {
  const c = await ready();
  const p = list();
  p.tenant = { ...target.tenant!, version: '9007199254740994' };
  fetcher.mockResolvedValueOnce(response({ page: p }));
  await c.loadInvitations('revokeInvitation');
  expect(c.prepare(manage('revokeInvitation'))).toBe(false);
  expect(c.prepare({ ...manage('revokeInvitation'), expectedTenantVersion: p.tenant.version })).toBe(true);
});

test('lost execute preserves original attempt across every mutation guard, repeated execute and explicit status miss', async () => {
  const c = await unknown(),
    attempt = c.snapshot().attempt,
    count = fetcher.mock.calls.length;
  expect(hasUnresolvedInvitations()).toBe(true);
  expect(c.locked()).toBe(true);
  await c.execute();
  await c.previewToken(token);
  await c.loadTargets();
  await c.loadInvitations('revokeInvitation');
  c.select('north');
  c.cancelReview();
  c.clearSecret();
  c.clearOperation();
  expect(c.prepare(issue)).toBe(false);
  expect(c.snapshot().attempt).toBe(attempt);
  expect(fetcher).toHaveBeenCalledTimes(count);
  fetcher.mockResolvedValueOnce(response({ status: 'not_found', outcome: 'unknown', result: null }));
  await c.check();
  expect(c.snapshot().phase).toBe('unknown');
  expect(c.snapshot().attempt).toBe(attempt);
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual(attempt);
});

test('double execute/check each dispatch once even while replies are held', async () => {
  const c = await ready();
  c.prepare(issue);
  const held = deferred<Response>();
  fetcher.mockImplementationOnce(() => held.promise);
  const first = c.execute(),
    attempt = c.snapshot().attempt;
  await c.execute();
  expect(c.snapshot().phase).toBe('executing');
  expect(hasUnresolvedInvitations()).toBe(true);
  held.reject(new Error('lost'));
  await first;
  const status = deferred<Response>();
  fetcher.mockImplementationOnce(() => status.promise);
  const checking = c.check();
  await c.check();
  expect(c.snapshot().phase).toBe('checking');
  status.resolve(response({ status: 'not_found', outcome: 'unknown', result: null }));
  await checking;
  expect(c.snapshot().attempt).toBe(attempt);
  expect(fetcher.mock.calls.filter(([url]) => url.includes('/execute?'))).toHaveLength(1);
  expect(fetcher.mock.calls.filter(([url]) => url.includes('/status?'))).toHaveLength(1);
});

test('only an exact fresh execute refusal settles; status refusal never does', async () => {
  const attempt = { idempotencyKey: key, intent: issue };
  fetcher.mockResolvedValueOnce(refusal()).mockResolvedValueOnce(refusal()).mockResolvedValueOnce(refusal('not_applied', { token }));
  await expect(executeInvitation(sessionIdentity(), issuer, attempt)).rejects.toMatchObject({ outcome: 'not_applied' });
  await expect(statusInvitation(sessionIdentity(), issuer, attempt)).rejects.toMatchObject({ outcome: 'unknown' });
  await expect(executeInvitation(sessionIdentity(), issuer, attempt)).rejects.toMatchObject({ outcome: 'unknown' });
  const c = await unknown();
  fetcher.mockResolvedValueOnce(refusal());
  await c.check();
  expect(c.snapshot().phase).toBe('unknown');
});

test.each(['not_found_applied', 'completed_null', 'token', 'not_applied'])('status malformed %s retains uncertainty', async (kind) => {
  const data =
    kind === 'not_found_applied'
      ? { status: 'not_found', outcome: 'applied', result: null }
      : kind === 'completed_null'
        ? { status: 'completed', outcome: 'applied', result: null }
        : kind === 'token'
          ? { status: 'completed', outcome: 'applied', result: issuerResult(issue, true), token: newToken }
          : { status: 'not_found', outcome: 'not_applied', result: null };
  const c = await unknown(),
    attempt = c.snapshot().attempt;
  fetcher.mockResolvedValueOnce(response(data));
  await c.check();
  expect(c.snapshot().phase).toBe('unknown');
  expect(c.snapshot().attempt).toBe(attempt);
});

test.each(['foreignId', 'tenant', 'membership', 'roles', 'expiry', 'extra', 'audit', 'token'])(
  'recipient result rejects %s fields or mismatched own outcome',
  async (kind) => {
    const result = acceptance();
    if (kind === 'foreignId') Object.assign(result, { invitationId: newInvitationId });
    if (kind === 'tenant') Object.assign(result, { tenantId: 'south' });
    if (kind === 'membership') Object.assign(result, { membershipVersion: '2' });
    if (kind === 'roles') Object.assign(result, { roles: ['editor'] });
    if (kind === 'expiry') Object.assign(result, { validUntil: preview.validUntil + 1 });
    if (kind === 'extra') Object.assign(result, { inviterId: 'operator' });
    if (kind === 'audit') Object.assign(result, { change: issuerResult().change });
    fetcher.mockResolvedValueOnce(response({ outcome: 'applied', result, ...(kind === 'token' ? { token } : {}) }, recipient.context));
    await expect(
      executeInvitation(sessionIdentity(), recipient, { idempotencyKey: key, intent: preview.intent }, token, preview),
    ).rejects.toMatchObject({ outcome: 'unknown' });
  },
);

test.each(['inviter', 'account', 'roles', 'version', 'secret', 'handoff', 'extra', 'replayToken'])(
  'issuer result rejects mismatched or secret-bearing %s',
  async (kind) => {
    const result = mutable(issuerResult());
    if (kind === 'inviter') result.change.after.invitation.inviterId = 'foreign';
    if (kind === 'account') {
      result.change.after.invitation.accountId = 'foreign';
      result.change.after.membership.accountId = 'foreign';
    }
    if (kind === 'roles') {
      result.change.after.invitation.roles = ['editor'];
      result.change.after.membership.roles = ['editor'];
    }
    if (kind === 'version') result.change.tenant.version = '1';
    if (kind === 'secret') Object.assign(result.change.after.invitation, { digest: 'hash' });
    if (kind === 'extra') Object.assign(result, { token });
    if (kind === 'replayToken') result.replayed = true;
    fetcher.mockResolvedValueOnce(response({ outcome: 'applied', result, token: kind === 'handoff' ? token : newToken }));
    await expect(executeInvitation(sessionIdentity(), issuer, { idempotencyKey: key, intent: issue })).rejects.toMatchObject({
      outcome: 'unknown',
    });
  },
);

test('revoke/reissue receipts validate complete immutable transitions, not just IDs', async () => {
  const intent = manage('revokeInvitation'),
    result = mutable(issuerResult(intent));
  result.change.after.invitation.policyVersion = 'changed';
  fetcher.mockResolvedValueOnce(response({ outcome: 'applied', result }));
  await expect(executeInvitation(sessionIdentity(), issuer, { idempotencyKey: key, intent })).rejects.toMatchObject({ outcome: 'unknown' });
  const reissue = manage('reissueInvitation'),
    changed = mutable(issuerResult(reissue));
  changed.change.revoked!.membership.version = '1';
  fetcher.mockResolvedValueOnce(response({ outcome: 'applied', result: changed, token: newToken }));
  await expect(executeInvitation(sessionIdentity(), issuer, { idempotencyKey: key, intent: reissue })).rejects.toMatchObject({
    outcome: 'unknown',
  });
});

test('successful handoff stays in memory until close or next operation; recovered issuance explicitly requires reissue', async () => {
  const c = await ready();
  c.prepare(issue);
  await c.execute();
  expect(c.snapshot().handoffToken).toBe(newToken);
  c.clearSecret();
  expect(c.snapshot().handoffToken).toBeNull();
  expect(c.snapshot().result).not.toBeNull();
  const lost = await unknown();
  await lost.check();
  expect(lost.snapshot()).toMatchObject({ phase: 'idle', attempt: null, handoffToken: null });
  expect(lost.snapshot().message).toContain('explicitly reissue');
  expect(fetcher.mock.calls.filter(([url]) => url.includes('/execute?'))).toHaveLength(2);
});

test('acceptance signals discovery once after acknowledgement without choosing a tenant, even if callback rejects', async () => {
  const callback = vi.fn(async () => {
      throw new Error('Discovery offline');
    }),
    c = controller(callback);
  await c.previewToken(token);
  const attempt = c.snapshot().attempt;
  await c.execute();
  await c.execute();
  await c.check();
  expect(c.snapshot()).toMatchObject({ phase: 'idle', result: acceptance(), attempt: null, handoffToken: null });
  expect(callback).toHaveBeenCalledTimes(1);
  expect(sessionIdentity().tenant).toBeUndefined();
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({ ...attempt, token });
  expect(JSON.stringify(c)).not.toContain(token);
});

test('unknown acceptance erases credential; recovery opens only the same recipient ID and status carries the original token-free attempt', async () => {
  const c = await unknown(true),
    attempt = c.snapshot().attempt;
  expect(JSON.stringify(c)).not.toContain(token);
  expect(hasInvitationSession()).toBe(true);
  c.clearSecret();
  const fresh = { ...recipient, context: 'fresh-recipient' };
  fetcher.mockResolvedValueOnce(response({ session: fresh }, fresh.context));
  await c.recoverContext();
  expect(c.snapshot().attempt).toBe(attempt);
  expect(c.snapshot().recipientSession).toEqual(fresh);
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({ invitationId });
  fetcher.mockResolvedValueOnce(response({ status: 'completed', outcome: 'applied', result: acceptance(true) }, fresh.context));
  await c.check();
  expect(c.snapshot().phase).toBe('idle');
  const [, init] = fetcher.mock.calls.at(-1)!;
  expect(JSON.parse(init.body)).toEqual(attempt);
  expect(init.headers[contextHeader]).toBe(fresh.context);
  expect(fetcher.mock.calls.some(([url]) => url.includes('/open-issuer?'))).toBe(false);
});

test('expired contexts never auto-open; explicit issuer recovery keeps key and intent even on denial', async () => {
  const c = await unknown(),
    attempt = c.snapshot().attempt;
  vi.spyOn(Date, 'now').mockReturnValue(issuer.expiresAt);
  const count = fetcher.mock.calls.length;
  await c.openIssuer();
  await c.check();
  expect(fetcher).toHaveBeenCalledTimes(count);
  expect(c.snapshot().phase).toBe('unknown');
  fetcher.mockResolvedValueOnce(refusal());
  await c.recoverContext();
  expect(c.snapshot().attempt).toBe(attempt);
  const fresh = { ...issuer, expiresAt: issuer.expiresAt + 300_000, context: 'fresh-issuer' };
  fetcher.mockResolvedValueOnce(response({ session: fresh }, fresh.context));
  await c.recoverContext();
  expect(c.snapshot().issuerSession).toEqual(fresh);
  expect(c.snapshot().attempt).toBe(attempt);
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({});
});

test('business selection and denial preserve unknown account ownership and admitted session; native lock retires all state', async () => {
  const c = await unknown(),
    attempt = c.snapshot().attempt,
    owner = c.owner;
  establishTenantSelection({
    appId: 'app',
    accountId: 'operator',
    tenantId: 'north',
    tabId: 'tab',
    context: 'business',
    revision: 1,
    expiresAt: Date.now() + 60_000,
  });
  requireTenantSelection();
  expect(captureAccountIdentity()).toBe(owner);
  expect(c.snapshot().attempt).toBe(attempt);
  expect(hasUnresolvedInvitations()).toBe(true);
  expect(hasInvitationSession()).toBe(true);
  lockSessionIdentity();
  establishSessionIdentity({ signedIn: true, accountId: 'operator', appId: 'app' });
  expect(c.current()).toBe(false);
  expect(c.snapshot()).toMatchObject({
    phase: 'idle',
    attempt: null,
    issuerSession: null,
    recipientSession: null,
    result: null,
    handoffToken: null,
  });
  expect(hasInvitationSession()).toBe(false);
  expect(hasUnresolvedInvitations()).toBe(false);
});

test('held admission and held mutation cannot resurrect a retired controller or fire discovery', async () => {
  const first = controller(),
    held = deferred<Response>();
  fetcher.mockImplementationOnce(() => held.promise);
  const opening = first.openIssuer();
  first.retire();
  held.resolve(response({ session: issuer }));
  expect(await opening).toBeNull();
  expect(first.snapshot().issuerSession).toBeNull();
  const callback = vi.fn(),
    c = controller(callback);
  await c.previewToken(token);
  const mutation = deferred<Response>();
  fetcher.mockImplementationOnce(() => mutation.promise);
  const executing = c.execute();
  lockSessionIdentity();
  mutation.resolve(response({ outcome: 'applied', result: acceptance() }, recipient.context));
  await executing;
  expect(c.snapshot().result).toBeNull();
  expect(callback).not.toHaveBeenCalled();
});

test('slow lists cannot overwrite a newer preview and frozen attempt', async () => {
  const c = await ready(),
    held = deferred<Response>();
  fetcher.mockImplementationOnce(() => held.promise);
  const loading = c.loadInvitations('revokeInvitation');
  await c.previewToken(token);
  const attempt = c.snapshot().attempt;
  held.resolve(response({ page: list() }));
  await loading;
  expect(c.snapshot()).toMatchObject({ phase: 'review', invitations: null, preview });
  expect(c.snapshot().attempt).toBe(attempt);
});

test('slow preview cannot overwrite a newer token review', async () => {
  const c = controller();
  const held = deferred<Response>();
  fetcher.mockResolvedValueOnce(response({ session: recipient }, recipient.context)).mockImplementationOnce(() => held.promise);
  const first = c.previewToken(token);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  const other = { ...preview, intent: { ...preview.intent, invitationId: newInvitationId } };
  fetcher
    .mockResolvedValueOnce(response({ session: recipient }, recipient.context))
    .mockResolvedValueOnce(response({ preview: other }, recipient.context));
  await c.previewToken(newToken);
  const attempt = c.snapshot().attempt;
  held.resolve(response({ preview }, recipient.context));
  await first;
  expect(c.snapshot().attempt).toBe(attempt);
  expect(attempt?.intent).toEqual(other.intent);
});

test('ordinary close while opening/previewing invalidates held work and requires another review', async () => {
  const c = controller(),
    held = deferred<Response>();
  fetcher.mockImplementationOnce(() => held.promise);
  const opening = c.previewToken(token);
  c.clearSecret();
  held.resolve(response({ session: recipient }, recipient.context));
  await opening;
  expect(c.snapshot()).toMatchObject({ phase: 'idle', loading: false, attempt: null, preview: null });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await c.previewToken(token);
  c.clearSecret();
  await c.execute();
  expect(c.snapshot().attempt).toBeNull();
  expect(fetcher.mock.calls.some(([url]) => url.includes('/execute?'))).toBe(false);
});

test('a selected new target fences an older list and preparation waits for current loading', async () => {
  const c = await ready(),
    held = deferred<Response>();
  fetcher.mockImplementationOnce(() => held.promise);
  const pending = c.loadInvitations('revokeInvitation');
  expect(c.prepare(issue)).toBe(false);
  c.select('north');
  expect(c.prepare(issue)).toBe(true);
  const attempt = c.snapshot().attempt;
  held.resolve(response({ page: list() }));
  await pending;
  expect(c.snapshot().attempt).toBe(attempt);
  expect(c.snapshot().invitations).toBeNull();
});

test('no browser persistence or URL mutation is used by review, execution, recovery or close', async () => {
  const local = vi.spyOn(Storage.prototype, 'setItem'),
    history = vi.spyOn(window.history, 'pushState');
  const c = await unknown(true);
  await c.recoverContext();
  await c.check();
  c.clearSecret();
  c.clearOperation();
  expect(local).not.toHaveBeenCalled();
  expect(history).not.toHaveBeenCalled();
});

test('synchronous retirement during loading publication prevents admission and credential retention', async () => {
  const c = controller();
  c.subscribe(() => {
    if (c.snapshot().loading) c.retire();
  });
  await c.previewToken(token);
  expect(fetcher).not.toHaveBeenCalled();
  expect(c.snapshot().recipientSession).toBeNull();
  const issuerController = controller();
  issuerController.subscribe(() => {
    if (issuerController.snapshot().loading) issuerController.retire();
  });
  expect(await issuerController.openIssuer()).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});

test('closing synchronously when recipient admission arrives fences preview dispatch', async () => {
  const c = controller();
  let closed = false;
  c.subscribe(() => {
    if (!closed && c.snapshot().recipientSession) {
      closed = true;
      c.clearSecret();
    }
  });
  await c.previewToken(token);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(c.snapshot()).toMatchObject({ loading: false, attempt: null, phase: 'idle' });
});

test('native retirement clears successful issuer handoff and all receipt/list state', async () => {
  const c = await ready();
  c.prepare(issue);
  await c.execute();
  expect(c.snapshot().handoffToken).toBe(newToken);
  lockSessionIdentity();
  expect(c.snapshot()).toMatchObject({ issuerSession: null, targets: null, result: null, handoffToken: null });
  expect(hasInvitationSession()).toBe(false);
});

test('operation listing cannot claim invitation pairs without a tenant', async () => {
  fetcher.mockResolvedValueOnce(response({ page: { ...list(), tenant: null } }));
  await expect(listInvitations(sessionIdentity(), issuer, 'north', 'revokeInvitation')).rejects.toMatchObject({ outcome: 'not_applied' });
});

test('target pages reject noncanonical tenant IDs and unexpected nested fields', async () => {
  fetcher
    .mockResolvedValueOnce(response({ page: { items: [{ ...target, tenantId: 'North', tenant: null }], next: null } }))
    .mockResolvedValueOnce(
      response({
        page: { items: [{ ...target, capabilities: [{ operation: 'issueInvitation', roles: ['reader'], token }] }], next: null },
      }),
    );
  await expect(listInvitationTargets(sessionIdentity(), issuer)).rejects.toMatchObject({ outcome: 'not_applied' });
  await expect(listInvitationTargets(sessionIdentity(), issuer)).rejects.toMatchObject({ outcome: 'not_applied' });
});
