import { PLATFORM_TENANT_ID, type TenantContextOwner, type TenantContextReply } from '@mistriwork/engine/shared/sessionLease.js';
import { say } from './copy/shell/sessionIdentity.js';

type SessionIdentityMode = 'unknown' | 'anonymous' | 'authenticated' | 'locked';

export interface SessionIdentitySnapshot {
  readonly mode: SessionIdentityMode;
  readonly epoch: number;
  readonly accountId: string | null;
  readonly appId: string | null;
  /** Present only after a genuine private tenant host advertised the protocol. */
  readonly tenantRequired?: true;
  readonly tenant?: Readonly<TenantContextOwner>;
}

class SessionIdentityError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid-identity' | 'unavailable' | 'changed' | 'response-owner',
  ) {
    super(message);
    this.name = 'SessionIdentityError';
  }
}

const PREFERENCES = new Set([
  'mistri.theme',
  'mistri.visual-theme',
  'mistri.density',
  'mistri.typography',
  'mistri.page-size',
  'mistri.related-rows',
  'mistri.sidebar-hidden',
  'mistri.tour.v1',
  'mistri.startup.v1',
]);

let identity: SessionIdentitySnapshot = Object.freeze({ mode: 'unknown', epoch: 0, accountId: null, appId: null });
// Business selections replace the data owner, not the native login. Account-only
// operations keep this root until actual sign-out/lock/account replacement.
const accountOwners = new WeakMap<SessionIdentitySnapshot, SessionIdentitySnapshot>();
export const captureAccountIdentity = (snapshot = identity): SessionIdentitySnapshot => accountOwners.get(snapshot) ?? snapshot;
export function assertAccountCurrent(snapshot: SessionIdentitySnapshot): void {
  if (captureAccountIdentity(snapshot) !== captureAccountIdentity() || identity.mode !== 'authenticated')
    throw new SessionIdentityError(say('thisOperationBelongsToAPrevious'), 'changed');
}
const listeners = new Set<() => void>();
export function subscribeSessionIdentity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Browser isolation only; the server remains responsible for authorization. */
export const sessionIdentity = (): SessionIdentitySnapshot => identity;
export const captureSessionIdentity = (): SessionIdentitySnapshot => identity;

interface TenantLeaseState {
  readonly reply: TenantContextReply;
  suspended: boolean;
  observedAt: number;
}
const leases = new WeakMap<SessionIdentitySnapshot, TenantLeaseState>();
const leaseListeners = new Set<() => void>();
function leaseChanged(): void {
  for (const listener of [...leaseListeners]) {
    try {
      listener();
    } catch {
      /* Observers cannot veto lease adoption or suspension. */
    }
  }
}
export function subscribeTenantLease(listener: () => void): () => void {
  leaseListeners.add(listener);
  return () => {
    leaseListeners.delete(listener);
  };
}
/** Includes expired receipts for exact renewal recovery, never data admission. */
export function captureTenantLease(owner = captureSessionIdentity()): TenantContextReply | undefined {
  return owner === identity ? leases.get(owner)?.reply : undefined;
}
export function tenantLeaseActive(owner = captureSessionIdentity()): boolean {
  const state = owner === identity ? leases.get(owner) : undefined;
  if (!state || state.suspended) return false;
  const now = Date.now();
  if (owner !== identity) return false;
  if (!Number.isFinite(now) || now < state.observedAt || now >= state.reply.expiresAt) {
    suspendTenantLease(owner);
    return false;
  }
  state.observedAt = now;
  return true;
}
export function suspendTenantLease(owner = captureSessionIdentity()): void {
  const state = owner === identity ? leases.get(owner) : undefined;
  if (!state || state.suspended) return;
  state.suspended = true;
  leaseChanged();
}
const ownerFields = ['appId', 'accountId', 'tenantId', 'tabId', 'context'] as const;
// A platform realm's lease carries `realm` exactly when it names the reserved id.
function validLease(value: TenantContextReply): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => [...ownerFields, 'revision', 'expiresAt', 'realm'].includes(key)) &&
    (value.realm === 'platform') === (value.tenantId === PLATFORM_TENANT_ID) &&
    (!('realm' in value) || value.realm === 'platform') &&
    ownerFields.every((key) => identifier(value[key]) && value[key].length <= 1024 && !/\p{Cc}/u.test(value[key])) &&
    Number.isSafeInteger(value.revision) &&
    value.revision > 0 &&
    Number.isFinite(value.expiresAt) &&
    value.expiresAt > 0
  );
}
export function acceptTenantRenewal(owner: SessionIdentitySnapshot, expectedRevision: number, reply: TenantContextReply): void {
  const state = owner === identity ? leases.get(owner) : undefined;
  const now = Date.now();
  if (
    !state ||
    owner !== identity ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 1 ||
    state.reply.revision !== expectedRevision ||
    !validLease(reply) ||
    reply.revision !== expectedRevision + 1 ||
    !ownerFields.every((key) => reply[key] === state.reply[key]) ||
    !Number.isFinite(now) ||
    now < state.observedAt
  )
    throw new SessionIdentityError(say('theTenantRenewalCould'), 'invalid-identity');
  leases.set(owner, { reply: Object.freeze({ ...reply }), suspended: reply.expiresAt <= now, observedAt: now });
  leaseChanged();
}

function transition(mode: SessionIdentityMode, accountId: string | null, appId: string | null): SessionIdentitySnapshot {
  if (identity.mode !== mode || identity.accountId !== accountId || identity.appId !== appId) {
    identity = Object.freeze({ mode, accountId, appId, epoch: identity.epoch + 1 });
    for (const listener of listeners) listener();
  }
  return identity;
}

/** Lock once, including callbacks that captured an otherwise identical account. */
export function lockSessionIdentity(): SessionIdentitySnapshot {
  return transition('locked', null, null);
}

const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value === value.trim();

/** Retire every captured operation/storage owner before requesting a selection.
 * This is browser isolation, never server authorization or a tenant credential. */
export function requireTenantSelection(): SessionIdentitySnapshot {
  if (identity.mode !== 'authenticated') throw new SessionIdentityError(say('signInBeforeChoosing'), 'unavailable');
  const accountOwner = captureAccountIdentity();
  identity = Object.freeze({
    mode: identity.mode,
    accountId: identity.accountId,
    appId: identity.appId,
    epoch: identity.epoch + 1,
    tenantRequired: true,
  });
  accountOwners.set(identity, accountOwner);
  for (const listener of listeners) listener();
  return identity;
}

export function establishTenantSelection(value: TenantContextReply, expected = captureSessionIdentity()): SessionIdentitySnapshot {
  assertSessionCurrent(expected);
  const now = Date.now();
  if (
    !identity.tenantRequired ||
    !validLease(value) ||
    value.appId !== identity.appId ||
    value.accountId !== identity.accountId ||
    !Number.isFinite(now) ||
    value.expiresAt <= now
  )
    throw new SessionIdentityError(say('theTenantSelectionCould'), 'invalid-identity');
  const tenant = Object.freeze({
    appId: value.appId,
    accountId: value.accountId,
    tenantId: value.tenantId,
    tabId: value.tabId,
    context: value.context,
    ...(value.realm === 'platform' ? { realm: 'platform' as const } : {}),
  });
  const accountOwner = captureAccountIdentity();
  identity = Object.freeze({ ...identity, epoch: identity.epoch + 1, tenant });
  accountOwners.set(identity, accountOwner);
  leases.set(identity, { reply: Object.freeze({ ...value }), suspended: false, observedAt: now });
  for (const listener of listeners) listener();
  leaseChanged();
  return identity;
}

/** Accept only the server's stable account identifier, never its display name. */
export function establishSessionIdentity(whoami: unknown): SessionIdentitySnapshot {
  const invalid = (): never => {
    lockSessionIdentity();
    throw new SessionIdentityError(say('theServerDidNotProvide'), 'invalid-identity');
  };
  if (!whoami || typeof whoami !== 'object' || Array.isArray(whoami)) return invalid();
  const value = whoami as Record<string, unknown>;
  if (value.signedIn === true) {
    if (!identifier(value.accountId) || !identifier(value.appId)) return invalid();
    return transition('authenticated', value.accountId, value.appId);
  }
  if (value.signedIn !== false || value.accountId != null || (value.appId != null && !identifier(value.appId))) return invalid();
  return transition('anonymous', null, typeof value.appId === 'string' ? value.appId : null);
}

function assertEpoch(snapshot: SessionIdentitySnapshot): void {
  if (
    snapshot.epoch !== identity.epoch ||
    snapshot.mode !== identity.mode ||
    snapshot.accountId !== identity.accountId ||
    snapshot.appId !== identity.appId
  ) {
    throw new SessionIdentityError(say('thisOperationBelongsToA'), 'changed');
  }
}

/** Omit the second argument before dispatch; supply the response header after it. */
export function assertSessionCurrent(snapshot: SessionIdentitySnapshot, responseAccountId?: string | null): void {
  assertEpoch(snapshot);
  if (identity.mode === 'unknown' || identity.mode === 'locked') {
    throw new SessionIdentityError(say('theSessionIsUnavailable'), 'unavailable');
  }
  if (identity.mode === 'authenticated' && arguments.length > 1 && responseAccountId !== identity.accountId) {
    throw new SessionIdentityError(say('theResponseBelongsToADifferent'), 'response-owner');
  }
}

/** No authenticated fallback to unscoped keys, whose account ownership is unknown. */
export function sessionStorageKey(key: string): string | null {
  if (PREFERENCES.has(key)) return key;
  if (identity.mode === 'unknown' || identity.mode === 'locked') return null;
  if (identity.mode === 'anonymous') return key;
  if (identity.tenantRequired) {
    if (!identity.tenant || !tenantLeaseActive()) return null;
    // No fallback to account-wide state. Context generations also isolate
    // separate tabs and same-account new logins from old retained private data.
    const owner = identity.tenant;
    return `mistri.tenant.v1:${encodeURIComponent(JSON.stringify([owner.appId, owner.accountId, owner.tenantId, owner.tabId, owner.context]))}:${key}`;
  }
  return `mistri.account.v1:${encodeURIComponent(JSON.stringify([identity.appId, identity.accountId]))}:${key}`;
}

type ScopedStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** A delayed editor cannot resolve its storage namespace using a newer account. */
export function captureScopedStorage(storage: () => ScopedStorage): ScopedStorage {
  const captured = captureSessionIdentity();
  const keyFor = (key: string) => {
    assertEpoch(captured);
    return sessionStorageKey(key);
  };
  const writableKey = (key: string) => {
    const mapped = keyFor(key);
    if (mapped === null) throw new SessionIdentityError(say('sessionStorageIsUnavailable'), 'unavailable');
    return mapped;
  };
  return {
    getItem(key) {
      const mapped = keyFor(key);
      return mapped === null ? null : storage().getItem(mapped);
    },
    setItem(key, value) {
      const mapped = writableKey(key);
      storage().setItem(mapped, value);
    },
    removeItem(key) {
      const mapped = writableKey(key);
      storage().removeItem(mapped);
    },
  };
}
