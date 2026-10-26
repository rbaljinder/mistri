import {
  INVITATION_EMAIL_PRINCIPAL,
  INVITATION_HTTP_HEADER,
  INVITATION_HTTP_ROOT,
  INVITATION_ISSUER_OPERATIONS,
  type InvitationAcceptanceIntent,
  type InvitationAcceptanceResult,
  type InvitationAttempt,
  type InvitationExecutionReply,
  type InvitationIntent,
  type InvitationIssuerIntent,
  type InvitationIssuerSession,
  type InvitationListPage,
  type InvitationPair,
  type InvitationPreview,
  type InvitationRecipientSession,
  type InvitationResult,
  type InvitationTarget,
  type InvitationTargetPage,
} from '../shared/tenantInvitations.js';
import type { AdministrationTenantImage } from '../shared/tenantAdministration.js';
import {
  assertAccountCurrent,
  captureAccountIdentity,
  sessionIdentity,
  subscribeSessionIdentity,
  type SessionIdentitySnapshot,
} from '@mistriwork/kit/client/sessionIdentity.js';
import { say } from './copy/tenancy/tenantInvitations.js';
import { isTenantName } from './tenantNames.js';
import { invitationAdmitted as admitted, invitationUnresolved as unresolved } from './tenantAccountState.js';
import { fetchServer } from '@mistriwork/kit/client/transport.js';
export { hasInvitationSession, hasUnresolvedInvitations } from './tenantAccountState.js';

class TenantInvitationError extends Error {
  constructor(readonly outcome: 'not_applied' | 'unknown') {
    super(outcome === 'unknown' ? say('theInvitationChangeIsUnconfirmed') : say('invitationAccessCouldNotBeVerified'));
  }
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function exact(v: unknown, keys: readonly string[], optional: readonly string[] = []): v is Record<string, unknown> {
  return (
    object(v) &&
    keys.every((k) => Object.hasOwn(v, k)) &&
    Reflect.ownKeys(v).every(
      (k) => typeof k === 'string' && (keys.includes(k) || optional.includes(k)) && 'value' in Object.getOwnPropertyDescriptor(v, k)!,
    )
  );
}
const id = (v: unknown, max = 256): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= max &&
  v.trim() === v &&
  !/[\p{Cc}\uD800-\uDFFF]/u.test(v) &&
  new TextEncoder().encode(v).length <= max;
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const tenantSelector = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(v);
const version = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,127}$/.test(v);
const time = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const positive = (v: unknown): v is number => time(v) && v > 0;
const roles = (v: unknown, minimum = 0): v is string[] =>
  Array.isArray(v) && v.length >= minimum && v.length <= 256 && v.every((r) => id(r)) && new Set(v).size === v.length;
const sameRoles = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((r) => b.includes(r));
function frozen<T>(v: T): T {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(frozen);
    Object.freeze(v);
  }
  return v;
}
function requireValid(valid: unknown): asserts valid {
  if (!valid) throw new Error(say('invalidInvitationResponse'));
}

/** Syntax only. The last base64url character must have zero padding bits; no digest or authority is derived here. */
export function parseInvitationTokenId(token: unknown): string | null {
  if (
    typeof token !== 'string' ||
    token.length !== 85 ||
    token.slice(0, 5) !== 'twi1.' ||
    token[41] !== '.' ||
    !uuid(token.slice(5, 41)) ||
    !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(token.slice(42))
  )
    return null;
  return token.slice(5, 41);
}
function tenant(v: unknown): v is AdministrationTenantImage {
  return (
    exact(v, ['tenantId', 'status', 'version']) &&
    tenantSelector(v.tenantId) &&
    version(v.version) &&
    ['active', 'suspended', 'closed'].includes(v.status as string)
  );
}
const intentCommon = ['operation', 'tenantId', 'expectedTenantVersion'];
const intentPair = ['invitationId', 'expectedInvitationVersion', 'membershipId', 'expectedMembershipVersion'];
const intentTerms = ['roles', 'redeemUntil', 'validUntil'];
/** A recipient's step: accepting an account invitation, or claiming an email one. */
export const recipientStep = (intent: InvitationIntent | undefined): boolean =>
  intent?.operation === 'acceptInvitation' || intent?.operation === 'claimInvitation';
/* An address as the server keeps it: lower-cased, with an @ and a dot after it.
   The server's own check is narrower and decides; this only keeps a typo local. */
const emailAddress = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= 254 && v === v.toLowerCase() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
/** The principal an issuance reserves for: the account, or the address's `email:` principal. */
const issuePrincipal = (intent: Record<string, unknown>) =>
  typeof intent.email === 'string' ? `${INVITATION_EMAIL_PRINCIPAL}${intent.email}` : intent.accountId;
function intentShape(v: unknown): v is InvitationIntent {
  if (!object(v)) return false;
  const issue = v.operation === 'issueInvitation',
    reissue = v.operation === 'reissueInvitation';
  const byEmail = issue && Object.hasOwn(v, 'email');
  return (
    (issue || reissue || v.operation === 'revokeInvitation' || v.operation === 'acceptInvitation' || v.operation === 'claimInvitation') &&
    exact(v, [...intentCommon, ...(issue ? [byEmail ? 'email' : 'accountId'] : intentPair), ...(issue || reissue ? intentTerms : [])]) &&
    tenantSelector(v.tenantId) &&
    version(v.expectedTenantVersion) &&
    (issue
      ? byEmail
        ? emailAddress(v.email)
        : id(v.accountId, 1024) && !(v.accountId as string).startsWith(INVITATION_EMAIL_PRINCIPAL)
      : uuid(v.invitationId) && uuid(v.membershipId) && version(v.expectedInvitationVersion) && version(v.expectedMembershipVersion)) &&
    (!(issue || reissue) || (roles(v.roles, 1) && positive(v.redeemUntil) && positive(v.validUntil) && v.redeemUntil <= v.validUntil))
  );
}
function pair(v: unknown): v is InvitationPair {
  if (!exact(v, ['invitation', 'membership'])) return false;
  const i = v.invitation,
    m = v.membership;
  return (
    exact(i, [
      'invitationId',
      'version',
      'tenantId',
      'membershipId',
      'accountId',
      'inviterId',
      'roles',
      'expectedTenantVersion',
      'policyId',
      'policyVersion',
      'issuanceOperation',
      'createdAt',
      'redeemUntil',
      'validUntil',
      'status',
    ]) &&
    uuid(i.invitationId) &&
    uuid(i.membershipId) &&
    tenantSelector(i.tenantId) &&
    id(i.accountId, 1024) &&
    id(i.inviterId, 1024) &&
    version(i.version) &&
    version(i.expectedTenantVersion) &&
    id(i.policyId) &&
    id(i.policyVersion) &&
    roles(i.roles, 1) &&
    time(i.createdAt) &&
    positive(i.redeemUntil) &&
    positive(i.validUntil) &&
    i.createdAt < i.redeemUntil &&
    i.redeemUntil <= i.validUntil &&
    ['issueInvitation', 'reissueInvitation'].includes(i.issuanceOperation as string) &&
    ['pending', 'accepted', 'revoked'].includes(i.status as string) &&
    exact(m, ['membershipId', 'tenantId', 'accountId', 'status', 'version', 'roles', 'validUntil']) &&
    m.membershipId === i.membershipId &&
    m.tenantId === i.tenantId &&
    m.accountId === i.accountId &&
    m.validUntil === i.validUntil &&
    version(m.version) &&
    roles(m.roles, 1) &&
    sameRoles(m.roles, i.roles) &&
    m.status === ({ pending: 'invited', accepted: 'active', revoked: 'revoked' } as Record<string, string>)[i.status as string]
  );
}
function transitioned(before: InvitationPair, after: InvitationPair): boolean {
  return (['invitation', 'membership'] as const).every((key) =>
    Object.entries(before[key]).every(([field, value]) => {
      const updated = (after[key] as unknown as Record<string, unknown>)[field];
      return field === 'version'
        ? updated === String(BigInt(value as string) + 1n)
        : field === 'status'
          ? updated === 'revoked'
          : field === 'roles'
            ? sameRoles(value as string[], updated as string[])
            : updated === value;
    }),
  );
}
const receiptFields = ['receiptId', 'requestId', 'completedAt', 'replayed'];
function receipt(v: Record<string, unknown>): boolean {
  return (
    id(v.receiptId, 1024) &&
    id(v.requestId, 1024) &&
    typeof v.replayed === 'boolean' &&
    typeof v.completedAt === 'string' &&
    v.completedAt.length <= 32 &&
    Number.isFinite(Date.parse(v.completedAt)) &&
    new Date(v.completedAt).toISOString() === v.completedAt
  );
}
function result(
  v: unknown,
  attempt: InvitationAttempt,
  owner: SessionIdentitySnapshot,
  preview?: InvitationPreview | null,
): InvitationResult | InvitationAcceptanceResult {
  const intent = attempt.intent;
  if (intent.operation === 'acceptInvitation' || intent.operation === 'claimInvitation') {
    // A claim's membership is the account's new one; an acceptance's is the reservation, one version on.
    const claimed = intent.operation === 'claimInvitation';
    requireValid(
      exact(v, [...receiptFields, 'invitationId', 'tenantId', 'membershipId', 'membershipVersion', 'roles', 'validUntil', 'status']) &&
        receipt(v) &&
        v.invitationId === intent.invitationId &&
        v.tenantId === intent.tenantId &&
        (claimed
          ? uuid(v.membershipId) && v.membershipId !== intent.membershipId && v.membershipVersion === '1'
          : v.membershipId === intent.membershipId &&
            version(v.membershipVersion) &&
            v.membershipVersion === String(BigInt(intent.expectedMembershipVersion) + 1n)) &&
        roles(v.roles, 1) &&
        positive(v.validUntil) &&
        v.status === 'accepted' &&
        (!preview || (sameRoles(v.roles as string[], preview.roles) && v.validUntil === preview.validUntil)),
    );
    return frozen(v as unknown as InvitationAcceptanceResult);
  }
  requireValid(exact(v, [...receiptFields, 'change']) && receipt(v));
  const c = v.change;
  requireValid(
    exact(c, ['operation', 'tenant', 'before', 'after'], intent.operation === 'reissueInvitation' ? ['revoked'] : []) &&
      c.operation === intent.operation &&
      tenant(c.tenant) &&
      c.tenant.tenantId === intent.tenantId &&
      c.tenant.version === intent.expectedTenantVersion &&
      pair(c.after) &&
      (c.before === null || pair(c.before)),
  );
  const after = c.after as InvitationPair,
    before = c.before as InvitationPair | null;
  requireValid(after.invitation.tenantId === intent.tenantId && (!before || before.invitation.tenantId === intent.tenantId));
  if (intent.operation === 'issueInvitation' || intent.operation === 'reissueInvitation') {
    const i = after.invitation;
    requireValid(
      (c.tenant as AdministrationTenantImage).status === 'active' &&
        i.status === 'pending' &&
        i.version === '1' &&
        after.membership.version === '1' &&
        i.expectedTenantVersion === intent.expectedTenantVersion &&
        i.issuanceOperation === intent.operation &&
        i.inviterId === owner.accountId &&
        sameRoles(i.roles, intent.roles) &&
        i.redeemUntil === intent.redeemUntil &&
        i.validUntil === intent.validUntil,
    );
  }
  if (intent.operation === 'issueInvitation') requireValid(before === null && after.invitation.accountId === issuePrincipal(intent));
  else {
    requireValid(
      before &&
        before.invitation.status === 'pending' &&
        before.invitation.invitationId === intent.invitationId &&
        before.invitation.version === intent.expectedInvitationVersion &&
        before.membership.membershipId === intent.membershipId &&
        before.membership.version === intent.expectedMembershipVersion,
    );
    if (intent.operation === 'revokeInvitation') requireValid(transitioned(before, after));
    else
      requireValid(
        pair(c.revoked) &&
          transitioned(before, c.revoked) &&
          after.invitation.invitationId !== intent.invitationId &&
          after.membership.membershipId !== intent.membershipId &&
          after.invitation.accountId === before.invitation.accountId,
      );
  }
  return frozen(v as unknown as InvitationResult);
}

// Bound bytes before JSON parsing, including chunked replies without Content-Length.
async function readResponse(response: Response): Promise<unknown> {
  // The server bounds page items at 2,000,000 bytes, before the role ceiling
  // and response envelope. Bound the whole response without rejecting its pages.
  const maximum = 4_194_304,
    length = response.headers.get('content-length');
  requireValid(length === null || (/^[0-9]+$/.test(length) && Number(length) <= maximum));
  requireValid(response.body);
  const reader = response.body.getReader(),
    decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let size = 0,
    text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      requireValid(size <= maximum);
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* Cancellation does not settle a mutation. */
    }
    reader.releaseLock();
  }
}
type Route = 'open-issuer' | 'open-recipient' | 'targets' | 'list' | 'preview' | 'execute' | 'status';
async function request(
  owner: SessionIdentitySnapshot,
  session: InvitationRecipientSession | null,
  route: Route,
  body?: unknown,
  query: Record<string, string> = {},
): Promise<{ data: Record<string, unknown>; context: string | null }> {
  let dispatched = false;
  try {
    assertAccountCurrent(owner);
    requireValid(owner.mode === 'authenticated' && id(owner.accountId, 1024) && id(owner.appId));
    const open = route.startsWith('open-'),
      post = route !== 'targets' && route !== 'list';
    requireValid(
      open ||
        (session &&
          session.appId === owner.appId &&
          session.accountId === owner.accountId &&
          id(session.context) &&
          session.expiresAt > Date.now()),
    );
    const init: RequestInit = {
      method: post ? 'POST' : 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        'x-mistri-account': owner.accountId!,
        'x-mistri-app': owner.appId!,
        ...(!open && session ? { [INVITATION_HTTP_HEADER]: session.context } : {}),
        ...(post ? { 'content-type': 'application/json' } : {}),
      },
      ...(post ? { body: JSON.stringify(body ?? {}) } : {}),
    };
    dispatched = true;
    const response = await fetchServer(`${INVITATION_HTTP_ROOT}/${route}?${new URLSearchParams({ app: owner.appId!, ...query })}`, init);
    const verify = () => {
      assertAccountCurrent(owner);
      const account = response.headers.get('x-mistri-account'),
        app = response.headers.get('x-mistri-app');
      const context = response.headers.get(INVITATION_HTTP_HEADER);
      requireValid(
        !(
          ((response.ok || account !== null) && account !== owner.accountId) ||
          ((response.ok || app !== null) && app !== owner.appId) ||
          (!open && (response.ok || context !== null) && context !== session!.context)
        ),
      );
      for (const name of response.headers.keys())
        requireValid(!name.startsWith('x-mistri-') || ['x-mistri-account', 'x-mistri-app', INVITATION_HTTP_HEADER].includes(name));
    };
    verify();
    const data = await readResponse(response);
    verify();
    requireValid(object(data));
    if (!response.ok) {
      if (
        route === 'execute' &&
        exact(data, ['error', 'code', 'outcome']) &&
        id(data.error, 1024) &&
        data.code === 'tenant_invitation_unavailable' &&
        data.outcome === 'not_applied'
      )
        throw new TenantInvitationError('not_applied');
      throw new Error();
    }
    return { data, context: response.headers.get(INVITATION_HTTP_HEADER) };
  } catch (error) {
    if (route !== 'status' && error instanceof TenantInvitationError) throw error;
    throw new TenantInvitationError(route === 'status' || (route === 'execute' && dispatched) ? 'unknown' : 'not_applied');
  }
}
async function openSession(
  owner: SessionIdentitySnapshot,
  invitationId?: string,
): Promise<InvitationIssuerSession | InvitationRecipientSession | null> {
  try {
    requireValid(invitationId === undefined || uuid(invitationId));
    const { data, context } = await request(
      owner,
      null,
      invitationId === undefined ? 'open-issuer' : 'open-recipient',
      invitationId === undefined ? {} : { invitationId },
    );
    requireValid(exact(data, ['session']));
    if (data.session === null && context === null) return null;
    const s = data.session,
      issuer = invitationId === undefined;
    requireValid(
      exact(s, [
        'appId',
        'accountId',
        'context',
        'expiresAt',
        ...(issuer ? ['maxMembershipLifetimeMs', 'maxRedemptionLifetimeMs', 'maxPendingPerTenant'] : []),
      ]) &&
        s.appId === owner.appId &&
        s.accountId === owner.accountId &&
        id(s.context) &&
        s.context === context &&
        positive(s.expiresAt) &&
        s.expiresAt > Date.now() &&
        (!issuer || (positive(s.maxMembershipLifetimeMs) && positive(s.maxRedemptionLifetimeMs) && positive(s.maxPendingPerTenant))),
    );
    return frozen(s as unknown as InvitationIssuerSession | InvitationRecipientSession);
  } catch {
    throw new TenantInvitationError('not_applied');
  }
}
export const openInvitationIssuer = (owner: SessionIdentitySnapshot): Promise<InvitationIssuerSession | null> =>
  openSession(owner) as Promise<InvitationIssuerSession | null>;
export const openInvitationRecipient = (owner: SessionIdentitySnapshot, invitationId: string): Promise<InvitationRecipientSession | null> =>
  openSession(owner, invitationId);
function page(v: unknown): v is Record<string, unknown> & { items: unknown[]; next: string | null } {
  return object(v) && Array.isArray(v.items) && v.items.length <= 20 && (v.next === null || id(v.next, 128));
}
export async function listInvitationTargets(
  owner: SessionIdentitySnapshot,
  session: InvitationIssuerSession,
  after?: string,
): Promise<InvitationTargetPage> {
  try {
    requireValid(after === undefined || id(after, 128));
    const { data } = await request(owner, session, 'targets', undefined, { limit: '20', ...(after === undefined ? {} : { after }) });
    const p = data.page;
    requireValid(
      exact(data, ['page']) &&
        exact(p, ['items', 'next']) &&
        page(p) &&
        p.items.every(
          (t) =>
            exact(t, ['tenantId', 'tenant', 'capabilities'], ['name']) &&
            tenantSelector(t.tenantId) &&
            (t.name === undefined || isTenantName(t.name)) &&
            (t.tenant === null || (tenant(t.tenant) && t.tenant.tenantId === t.tenantId)) &&
            Array.isArray(t.capabilities) &&
            t.capabilities.length <= 3 &&
            t.capabilities.every(
              (c) => exact(c, ['operation', 'roles']) && INVITATION_ISSUER_OPERATIONS.includes(c.operation as never) && roles(c.roles),
            ) &&
            new Set(t.capabilities.map((c) => c.operation)).size === t.capabilities.length,
        ) &&
        new Set(p.items.map((t) => (t as InvitationTarget).tenantId)).size === p.items.length,
    );
    return frozen(p as unknown as InvitationTargetPage);
  } catch {
    throw new TenantInvitationError('not_applied');
  }
}
export async function listInvitations(
  owner: SessionIdentitySnapshot,
  session: InvitationIssuerSession,
  tenantId: string,
  operation: 'revokeInvitation' | 'reissueInvitation',
  after?: string,
): Promise<InvitationListPage> {
  try {
    requireValid(
      tenantSelector(tenantId) && ['revokeInvitation', 'reissueInvitation'].includes(operation) && (after === undefined || id(after, 128)),
    );
    const { data } = await request(owner, session, 'list', undefined, {
      tenantId,
      operation,
      limit: '20',
      ...(after === undefined ? {} : { after }),
    });
    const p = data.page;
    requireValid(
      exact(data, ['page']) &&
        exact(p, ['tenant', 'operation', 'roles', 'items', 'next']) &&
        page(p) &&
        p.operation === operation &&
        roles(p.roles) &&
        (p.tenant === null || (tenant(p.tenant) && p.tenant.tenantId === tenantId)) &&
        (p.tenant !== null || p.items.length === 0) &&
        p.items.every(
          (i) =>
            pair(i) &&
            i.invitation.tenantId === tenantId &&
            i.invitation.status === 'pending' &&
            i.invitation.roles.every((r) => (p.roles as string[]).includes(r)),
        ) &&
        new Set(p.items.map((i) => (i as InvitationPair).invitation.invitationId)).size === p.items.length &&
        new Set(p.items.map((i) => (i as InvitationPair).membership.membershipId)).size === p.items.length,
    );
    return frozen(p as unknown as InvitationListPage);
  } catch {
    throw new TenantInvitationError('not_applied');
  }
}
export async function previewInvitation(
  owner: SessionIdentitySnapshot,
  session: InvitationRecipientSession,
  token: string,
): Promise<InvitationPreview> {
  try {
    const invitationId = parseInvitationTokenId(token);
    requireValid(invitationId);
    const { data } = await request(owner, session, 'preview', { token });
    const p = data.preview;
    requireValid(
      exact(data, ['preview']) &&
        exact(p, ['intent', 'roles', 'redeemUntil', 'validUntil']) &&
        intentShape(p.intent) &&
        recipientStep(p.intent) &&
        (p.intent as InvitationAcceptanceIntent).invitationId === invitationId &&
        roles(p.roles, 1) &&
        positive(p.redeemUntil) &&
        positive(p.validUntil) &&
        p.redeemUntil > Date.now() &&
        p.redeemUntil <= p.validUntil,
    );
    return frozen(p as unknown as InvitationPreview);
  } catch {
    throw new TenantInvitationError('not_applied');
  }
}
function validAttempt(attempt: InvitationAttempt) {
  requireValid(exact(attempt, ['idempotencyKey', 'intent']) && uuid(attempt.idempotencyKey) && intentShape(attempt.intent));
}
export async function executeInvitation(
  owner: SessionIdentitySnapshot,
  session: InvitationRecipientSession,
  attempt: InvitationAttempt,
  token?: string,
  preview?: InvitationPreview | null,
): Promise<InvitationExecutionReply> {
  try {
    validAttempt(attempt);
    requireValid(
      recipientStep(attempt.intent)
        ? parseInvitationTokenId(token) === (attempt.intent as InvitationAcceptanceIntent).invitationId
        : token === undefined,
    );
  } catch {
    throw new TenantInvitationError('not_applied');
  }
  const { data } = await request(owner, session, 'execute', { ...attempt, ...(token === undefined ? {} : { token }) });
  try {
    const issuance = attempt.intent.operation === 'issueInvitation' || attempt.intent.operation === 'reissueInvitation';
    requireValid(exact(data, ['outcome', 'result'], issuance ? ['token'] : []) && data.outcome === 'applied');
    const parsed = result(data.result, attempt, owner, preview);
    requireValid(
      !Object.hasOwn(data, 'token') ||
        ('change' in parsed && !parsed.replayed && parseInvitationTokenId(data.token) === parsed.change.after.invitation.invitationId),
    );
    return frozen({ result: parsed, ...(Object.hasOwn(data, 'token') ? { token: data.token as string } : {}) });
  } catch {
    throw new TenantInvitationError('unknown');
  }
}
export async function statusInvitation(
  owner: SessionIdentitySnapshot,
  session: InvitationRecipientSession,
  attempt: InvitationAttempt,
  preview?: InvitationPreview | null,
): Promise<InvitationResult | InvitationAcceptanceResult | null> {
  try {
    validAttempt(attempt);
    const { data } = await request(owner, session, 'status', attempt);
    requireValid(exact(data, ['status', 'outcome', 'result']));
    if (data.status === 'not_found' && data.outcome === 'unknown' && data.result === null) return null;
    requireValid(data.status === 'completed' && data.outcome === 'applied');
    return result(data.result, attempt, owner, preview);
  } catch {
    throw new TenantInvitationError('unknown');
  }
}

interface InvitationView {
  readonly issuerSession: InvitationIssuerSession | null;
  readonly recipientSession: InvitationRecipientSession | null;
  readonly targets: InvitationTargetPage | null;
  readonly target: InvitationTarget | null;
  readonly invitations: InvitationListPage | null;
  readonly preview: InvitationPreview | null;
  readonly phase: 'idle' | 'review' | 'executing' | 'unknown' | 'checking';
  readonly loading: boolean;
  readonly attempt: InvitationAttempt | null;
  readonly result: InvitationResult | InvitationAcceptanceResult | null;
  readonly handoffToken: string | null;
  readonly message: string;
}
const empty = (): InvitationView =>
  frozen({
    issuerSession: null,
    recipientSession: null,
    targets: null,
    target: null,
    invitations: null,
    preview: null,
    phase: 'idle',
    loading: false,
    attempt: null,
    result: null,
    handoffToken: null,
    message: '',
  });

/** One native account root across business selection and dialog lifetimes. The shell owns exit guards. */
export class TenantInvitationsController {
  readonly owner: SessionIdentitySnapshot;
  private value = empty();
  private listeners = new Set<() => void>();
  private retired = false;
  private generation = 0;
  private opening?: Promise<InvitationIssuerSession | null>;
  private unsubscribe: () => void;
  #inputToken: string | null = null;
  private recipientId: string | null = null;
  constructor(
    owner = captureAccountIdentity(),
    private readonly onAccepted?: (result: InvitationAcceptanceResult) => void | Promise<void>,
  ) {
    this.owner = captureAccountIdentity(owner);
    this.unsubscribe = subscribeSessionIdentity(() => {
      if (!this.current()) this.retire();
    });
  }
  snapshot = (): InvitationView => this.value;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  current = (): boolean => !this.retired && this.owner === captureAccountIdentity() && sessionIdentity().mode === 'authenticated';
  locked = (): boolean => ['executing', 'unknown', 'checking'].includes(this.value.phase);
  private editable(): boolean {
    return this.current() && this.value.phase === 'idle';
  }
  private live(ticket: number, attempt?: InvitationAttempt): boolean {
    return this.current() && ticket === this.generation && (!attempt || this.value.attempt === attempt);
  }
  private publish(patch: Partial<InvitationView>) {
    if (!this.current()) return;
    this.value = frozen({ ...this.value, ...patch });
    if (this.value.issuerSession || this.value.recipientSession) admitted.add(this);
    else admitted.delete(this);
    if (this.locked()) unresolved.add(this);
    else unresolved.delete(this);
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* Observers cannot change operation outcomes. */
      }
    }
  }
  retire(): void {
    if (this.retired) return;
    this.retired = true;
    this.generation++;
    this.unsubscribe();
    unresolved.delete(this);
    admitted.delete(this);
    this.opening = undefined;
    this.#inputToken = null;
    this.recipientId = null;
    this.value = empty();
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* Retirement must clear every secret. */
      }
    }
    this.listeners.clear();
  }
  openIssuer(): Promise<InvitationIssuerSession | null> {
    if (!this.current()) return Promise.resolve(null);
    if (this.opening) return this.opening;
    if (this.value.issuerSession) return Promise.resolve(this.value.issuerSession);
    if (!this.editable() || this.value.loading) return Promise.resolve(null);
    const ticket = ++this.generation;
    this.publish({ loading: true, message: '' });
    if (!this.live(ticket)) return Promise.resolve(null);
    const pending = openInvitationIssuer(this.owner)
      .then((session) => {
        if (!this.live(ticket)) return null;
        this.publish({ issuerSession: session });
        return session;
      })
      .catch(() => {
        if (this.live(ticket)) this.publish({ message: say('invitationIssuerAccessCould') });
        return null;
      })
      .finally(() => {
        if (this.live(ticket)) this.publish({ loading: false });
        if (this.opening === pending) this.opening = undefined;
      });
    this.opening = pending;
    return pending;
  }
  async loadTargets(after?: string): Promise<void> {
    const session = this.value.issuerSession;
    if (!this.editable() || !session) return;
    const ticket = ++this.generation;
    this.#inputToken = null;
    this.recipientId = null;
    this.publish({
      targets: null,
      target: null,
      invitations: null,
      preview: null,
      recipientSession: null,
      handoffToken: null,
      result: null,
      loading: true,
      message: '',
    });
    try {
      const targets = await listInvitationTargets(this.owner, session, after);
      if (this.live(ticket)) this.publish({ targets });
    } catch {
      if (this.live(ticket)) this.publish({ message: say('theAuthorizedInvitationTargets') });
    } finally {
      if (this.live(ticket)) this.publish({ loading: false });
    }
  }
  select(tenantId: string): void {
    if (!this.editable()) return;
    const target = this.value.targets?.items.find((t) => t.tenantId === tenantId);
    if (!target) return;
    this.generation++;
    this.#inputToken = null;
    this.recipientId = null;
    this.publish({
      target,
      invitations: null,
      preview: null,
      recipientSession: null,
      result: null,
      handoffToken: null,
      loading: false,
      message: '',
    });
  }
  async loadInvitations(operation: 'revokeInvitation' | 'reissueInvitation', after?: string): Promise<void> {
    const { issuerSession: session, target } = this.value,
      capability = target?.capabilities.find((c) => c.operation === operation);
    if (!this.editable() || !session || !target || !capability) return;
    const ticket = ++this.generation;
    this.publish({ invitations: null, loading: true, handoffToken: null, result: null, message: '' });
    try {
      const invitations = await listInvitations(this.owner, session, target.tenantId, operation, after);
      requireValid(sameRoles(invitations.roles, capability.roles));
      if (this.live(ticket)) this.publish({ invitations });
    } catch {
      if (this.live(ticket)) this.publish({ message: say('theAuthorizedInvitationList') });
    } finally {
      if (this.live(ticket)) this.publish({ loading: false });
    }
  }
  prepare(input: InvitationIssuerIntent): boolean {
    const { issuerSession: session, target, invitations } = this.value;
    if (!this.editable() || this.value.loading || !session || session.expiresAt <= Date.now() || !target) return false;
    try {
      requireValid(intentShape(input) && INVITATION_ISSUER_OPERATIONS.includes(input.operation));
      const intent = structuredClone(input),
        capability = target.capabilities.find((c) => c.operation === intent.operation);
      const currentTenant = intent.operation === 'issueInvitation' ? target.tenant : invitations?.tenant;
      requireValid(
        capability &&
          intent.tenantId === target.tenantId &&
          currentTenant &&
          currentTenant.version === intent.expectedTenantVersion &&
          (intent.operation === 'revokeInvitation' || currentTenant.status === 'active'),
      );
      if (intent.operation !== 'issueInvitation') {
        const old = invitations?.items.find((p) => p.invitation.invitationId === intent.invitationId);
        requireValid(
          invitations?.operation === intent.operation &&
            sameRoles(invitations.roles, capability.roles) &&
            old &&
            old.invitation.status === 'pending' &&
            old.invitation.version === intent.expectedInvitationVersion &&
            old.membership.membershipId === intent.membershipId &&
            old.membership.version === intent.expectedMembershipVersion &&
            old.invitation.roles.every((r) => capability.roles.includes(r)),
        );
      }
      if ('roles' in intent) {
        const now = Date.now();
        requireValid(
          intent.roles.every((r) => capability.roles.includes(r)) &&
            intent.redeemUntil > now &&
            intent.redeemUntil - now <= session.maxRedemptionLifetimeMs &&
            intent.validUntil - now <= session.maxMembershipLifetimeMs,
        );
      }
      const attempt = frozen({ idempotencyKey: crypto.randomUUID(), intent });
      this.generation++;
      this.#inputToken = null;
      this.recipientId = null;
      this.publish({ attempt, phase: 'review', preview: null, recipientSession: null, handoffToken: null, result: null, message: '' });
      return true;
    } catch {
      return false;
    }
  }
  async previewToken(token: string): Promise<void> {
    if (!this.editable()) return;
    const ticket = ++this.generation,
      invitationId = parseInvitationTokenId(token);
    this.#inputToken = null;
    this.recipientId = invitationId;
    this.publish({
      preview: null,
      recipientSession: null,
      target: null,
      invitations: null,
      result: null,
      handoffToken: null,
      loading: !!invitationId,
      message: '',
    });
    if (!this.live(ticket)) return;
    if (!invitationId) {
      this.publish({ message: say('enterAnInvitationToken') });
      return;
    }
    this.#inputToken = token;
    // The private field is the only retained input across the context-open await.
    token = '';
    try {
      const session = await openInvitationRecipient(this.owner, invitationId);
      if (!this.live(ticket)) return;
      requireValid(session && this.#inputToken);
      this.publish({ recipientSession: session });
      if (!this.live(ticket)) return;
      const preview = await previewInvitation(this.owner, session, this.#inputToken);
      if (!this.live(ticket)) return;
      requireValid(this.#inputToken);
      const attempt: InvitationAttempt = frozen({ idempotencyKey: crypto.randomUUID(), intent: structuredClone(preview.intent) });
      this.publish({ preview, attempt, phase: 'review', loading: false });
    } catch {
      if (this.live(ticket)) {
        this.#inputToken = null;
        this.publish({ message: say('theInvitationCouldNotBeReviewed') });
      }
    } finally {
      if (this.live(ticket)) this.publish({ loading: false });
    }
  }
  cancelReview(): void {
    if (this.value.phase === 'review') this.clearOperation();
  }
  clearSecret(): void {
    this.#inputToken = null;
    if (!this.current()) return;
    if (!this.locked()) {
      this.generation++;
      this.opening = undefined;
      if (recipientStep(this.value.attempt?.intent)) {
        this.publish({ attempt: null, phase: 'idle', preview: null });
      }
      this.publish({ loading: false });
    }
    this.publish({ handoffToken: null });
  }
  clearOperation(): void {
    if (!this.current() || this.locked()) return;
    this.generation++;
    this.opening = undefined;
    this.#inputToken = null;
    this.recipientId = null;
    this.publish({
      invitations: null,
      recipientSession: null,
      preview: null,
      attempt: null,
      result: null,
      handoffToken: null,
      phase: 'idle',
      loading: false,
      message: '',
    });
  }
  private complete(reply: InvitationExecutionReply): void {
    this.#inputToken = null;
    const accepted = !('change' in reply.result),
      lostHandoff = !accepted && reply.result.change.operation !== 'revokeInvitation' && !reply.token;
    this.publish({
      phase: 'idle',
      attempt: null,
      result: reply.result,
      handoffToken: reply.token ?? null,
      targets: null,
      target: null,
      invitations: null,
      message: accepted
        ? say('invitationAcceptanceConfirmedRefresh')
        : lostHandoff
          ? say('issuanceConfirmedTheOriginal')
          : say('invitationChangeConfirmedRefresh'),
    });
    if (accepted && this.current() && this.onAccepted) {
      // Discovery failure cannot relabel an acknowledged acceptance as unknown.
      try {
        void Promise.resolve(this.onAccepted(reply.result as InvitationAcceptanceResult)).catch(() => {});
      } catch {
        /* Receipt stays confirmed. */
      }
    }
  }
  async execute(): Promise<void> {
    const { attempt, phase, preview } = this.value;
    if (!this.current() || phase !== 'review' || this.value.loading || !attempt) return;
    const recipient = recipientStep(attempt.intent);
    const session = recipient ? this.value.recipientSession : this.value.issuerSession;
    if (!session || session.expiresAt <= Date.now()) {
      this.publish({ message: say('refreshInvitationAccessExplicitly') });
      return;
    }
    if (recipient && (!this.#inputToken || !preview || preview.redeemUntil <= Date.now())) {
      this.clearOperation();
      this.publish({ message: say('reviewTheInvitationAgain') });
      return;
    }
    const ticket = ++this.generation;
    this.publish({ phase: 'executing', message: '' });
    if (!this.live(ticket, attempt)) return;
    const pending = executeInvitation(this.owner, session, attempt, recipient ? this.#inputToken! : undefined, preview);
    this.#inputToken = null;
    try {
      const reply = await pending;
      if (this.live(ticket, attempt)) this.complete(reply);
    } catch (error) {
      if (!this.live(ticket, attempt)) return;
      this.publish(
        error instanceof TenantInvitationError && error.outcome === 'not_applied'
          ? {
              phase: 'idle',
              attempt: null,
              preview: null,
              targets: null,
              target: null,
              invitations: null,
              message: say('theChangeWasNotApplied'),
            }
          : { phase: 'unknown', message: say('theChangeIsUnconfirmedCheckThisExact') },
      );
    }
  }
  async check(): Promise<void> {
    const { attempt, phase, preview } = this.value;
    const session = recipientStep(attempt?.intent) ? this.value.recipientSession : this.value.issuerSession;
    if (!this.current() || phase !== 'unknown' || this.value.loading || !attempt || !session) return;
    const ticket = ++this.generation;
    this.publish({ phase: 'checking', message: '' });
    if (!this.live(ticket, attempt)) return;
    try {
      const found = await statusInvitation(this.owner, session, attempt, preview);
      if (!this.live(ticket, attempt)) return;
      if (found) this.complete({ result: found });
      else this.publish({ phase: 'unknown', message: say('common.noReceiptWasFound') });
    } catch {
      if (this.live(ticket, attempt)) this.publish({ phase: 'unknown', message: say('common.statusCouldNotBeVerified') });
    }
  }
  async recoverContext(): Promise<void> {
    const { phase, attempt } = this.value;
    if (!this.current() || this.value.loading || phase === 'executing' || phase === 'checking') return;
    const recipient = attempt ? recipientStep(attempt.intent) : !!this.recipientId;
    const invitationId = recipient ? ((attempt?.intent as InvitationAcceptanceIntent | undefined)?.invitationId ?? this.recipientId) : null;
    if (recipient ? !invitationId : !this.value.issuerSession) return;
    const ticket = ++this.generation;
    this.publish({ loading: true, targets: null, target: null, invitations: null });
    if (!this.live(ticket)) return;
    try {
      const session = recipient ? await openInvitationRecipient(this.owner, invitationId!) : await openInvitationIssuer(this.owner);
      requireValid(session);
      if (this.live(ticket))
        this.publish({
          ...(recipient ? { recipientSession: session } : { issuerSession: session as InvitationIssuerSession }),
          message: attempt ? say('accessRefreshedTheOriginal') : say('accessRefreshedLoadTheCurrent'),
        });
    } catch {
      if (this.live(ticket)) this.publish({ message: say('common.accessCouldNotBeRefreshed') });
    } finally {
      if (this.live(ticket)) this.publish({ loading: false });
    }
  }
}
