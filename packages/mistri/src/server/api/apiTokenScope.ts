/** Private record/scope data only: not credential verification or admission. */
import { snapshot } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import type { AppDef } from '../../shared/appModel.js';

type Subject = Readonly<{ kind: 'account' | 'service'; id: string }>;
/** A tenant App's token names the one tenant membership it acts through, at the
 * version it was issued against: any later change to that membership (roles,
 * status, a reissue) leaves the token without authority rather than following it. */
type TokenTenantBinding = Readonly<{ tenantId: string; membershipId: string; membershipVersion: string }>;
export interface TokenRecord {
  id: string;
  appId: string;
  subject: Subject;
  label: string;
  roles: readonly string[];
  operations?: readonly string[];
  tenant?: TokenTenantBinding;
  createdAt: number;
  createdBy: string;
  expiresAt: number;
  revokedAt?: number;
  revokedBy?: string;
  lastUsedAt?: number;
}
const refuse = (): never => {
  throw new TypeError('API token record or scope is unavailable.');
};
const record = (raw: unknown, required: string[], optional: string[] = []): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return refuse();
  const value = raw as Record<string, unknown>;
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => ![...required, ...optional].includes(key)))
    return refuse();
  return value;
};
const text = (value: unknown, max = 256): string =>
  typeof value === 'string' &&
  value.length > 0 &&
  !/\p{Cs}/u.test(value) &&
  value === value.trim() &&
  Buffer.byteLength(value, 'utf8') <= max &&
  !/\p{Cc}/u.test(value)
    ? value
    : refuse();
// Match the current native account observer's 1024 UTF16-unit identifier
// boundary. Well-formed BMP text can take three UTF8 bytes per unit; never
// normalize or truncate a native subject/actor to fit a credential record.
const accountId = (value: unknown): string => {
  const id = text(value, 3072);
  return id.length <= 1024 ? id : refuse();
};
const instant = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000 ? value : refuse();
const names = (value: unknown, max: number): readonly string[] => {
  if (!Array.isArray(value) || value.length > max) return refuse();
  const list = Array.from(value, (value) => text(value));
  if (new Set(list).size !== list.length) return refuse();
  return Object.freeze(list);
};
const subject = (raw: unknown): Subject => {
  const value = record(raw, ['kind', 'id']),
    id = value.kind === 'account' ? accountId(value.id) : text(value.id);
  if (!['account', 'service'].includes(String(value.kind))) return refuse();
  // Same service-name grammar as existing command service principals.
  if (value.kind === 'service' && !/^[a-z][a-z0-9-]{0,62}(?![\s\S])/.test(id)) return refuse();
  return Object.freeze({ kind: value.kind as Subject['kind'], id });
};
/** The tenant store's own grammars: its selector, a membership ID of at most
 * 1024 units and a canonical positive revision. Never normalized to fit. */
const tenantBinding = (raw: unknown): TokenTenantBinding => {
  const value = record(raw, ['tenantId', 'membershipId', 'membershipVersion']);
  if (typeof value.tenantId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}(?![\s\S])/.test(value.tenantId)) return refuse();
  if (typeof value.membershipVersion !== 'string' || !/^[1-9][0-9]{0,127}(?![\s\S])/.test(value.membershipVersion)) return refuse();
  return Object.freeze({
    tenantId: value.tenantId,
    membershipId: accountId(value.membershipId),
    membershipVersion: value.membershipVersion,
  });
};

/** Issuance input for a tenant App: the binding read natively from the business
 * store, and the roles that membership holds, which bound the token's roles. */
export function captureTenantIssue(raw: unknown): Readonly<{ binding: TokenTenantBinding; roles: readonly string[] }> {
  const value = record(raw, ['tenantId', 'membershipId', 'membershipVersion', 'roles']);
  const binding = tenantBinding({ tenantId: value.tenantId, membershipId: value.membershipId, membershipVersion: value.membershipVersion });
  return Object.freeze({ binding, roles: names(value.roles, 256) });
}

/** Authorization facts only, not a deployed storage migration. Credential
 * secret/digest fields are deliberately not part of this input contract. */
export function captureApiTokenRecord(raw: unknown): Readonly<TokenRecord> {
  const value = record(
    snapshot(raw, 131072).value,
    ['id', 'appId', 'subject', 'label', 'roles', 'createdAt', 'createdBy', 'expiresAt'],
    ['operations', 'tenant', 'revokedAt', 'revokedBy', 'lastUsedAt'],
  );
  const createdAt = instant(value.createdAt),
    expiresAt = instant(value.expiresAt);
  if (expiresAt <= createdAt) return refuse();
  if (Object.hasOwn(value, 'revokedAt') !== Object.hasOwn(value, 'revokedBy')) return refuse();
  const roles = names(value.roles, 128);
  if (!roles.length) return refuse();
  const revokedAt = Object.hasOwn(value, 'revokedAt') ? instant(value.revokedAt) : undefined;
  const lastUsedAt = Object.hasOwn(value, 'lastUsedAt') ? instant(value.lastUsedAt) : undefined;
  if ((revokedAt !== undefined && revokedAt < createdAt) || (lastUsedAt !== undefined && lastUsedAt < createdAt)) return refuse();
  return Object.freeze({
    id: text(value.id),
    appId: text(value.appId),
    subject: subject(value.subject),
    label: text(value.label, 512),
    roles,
    createdAt,
    createdBy: accountId(value.createdBy),
    expiresAt,
    ...(Object.hasOwn(value, 'operations') ? { operations: names(value.operations, 1024) } : {}),
    ...(Object.hasOwn(value, 'tenant') ? { tenant: tenantBinding(value.tenant) } : {}),
    ...(revokedAt === undefined ? {} : { revokedAt, revokedBy: accountId(value.revokedBy) }),
    ...(lastUsedAt === undefined ? {} : { lastUsedAt }),
  });
}

/** All inputs must be freshly observed by a trusted host per request. This
 * cannot prove observation freshness, credential validity, account state or
 * checked-catalog provenance. Service scope evaluation remains unsupported
 * until a current service-subject policy source is established. */
/**
 * The account roles a token may carry. A role the App maps from an identity
 * provider's claims (`claims`) is the provider's, and counts only for a session
 * that provider opened (auth/identityRoles.ts sessionRoles); a token is no
 * such session, and would otherwise keep the role for its whole life after
 * the provider took it away. A role set by hand is the account's own.
 */
export function accountTokenRoles(app: AppDef, roles: readonly string[]): string[] {
  const declared = app.auth?.roles ?? {};
  return roles.filter((role) => !Object.hasOwn(declared, role) || (declared[role] as { claims?: unknown }).claims === undefined);
}

export function narrowApiTokenScope(
  raw: unknown,
  app: AppDef,
  observation: unknown,
  currentOperations: readonly { id: string; eligibleRoles: readonly string[] }[],
  now: number,
) {
  const token = captureApiTokenRecord(raw),
    clock = instant(now);
  const current = record(snapshot(observation, 65536).value, ['appId', 'subject', 'eligible', 'roles']);
  const observedSubject = subject(current.subject),
    currentRoles = names(current.roles, 128);
  /* An `all` or row-policy App has no membership to act through: a token
     bound to one is refused here, never widened. A row-policy App's rows are
     its deployment's to narrow for the token's account (policyApiOwner.ts). */
  if (
    !app.api ||
    (app.auth?.rows !== 'all' && app.auth?.rows !== 'policy') ||
    token.tenant !== undefined ||
    token.subject.kind !== 'account' ||
    current.appId !== app.id ||
    token.appId !== app.id ||
    current.eligible !== true ||
    token.subject.kind !== observedSubject.kind ||
    token.subject.id !== observedSubject.id ||
    clock < token.createdAt ||
    clock >= token.expiresAt ||
    token.revokedAt !== undefined
  )
    return refuse();
  const roles = token.roles.filter(
    (role) =>
      accountTokenRoles(app, currentRoles).includes(role) && app.api!.roles.includes(role) && Object.hasOwn(app.auth?.roles ?? {}, role),
  );
  if (!roles.length) return refuse();
  return scopeOf(token, app, roles, currentOperations);
}

/** A tenant App's token scope. A tenant App grants by membership, not by the
 * native account role: the token's roles narrow to the App's tenant-realm API
 * roles and its catalog's eligible operations, and the binding is returned for
 * the tenant runtime, which observes that membership — its roles and version —
 * natively on every request. An unbound token has no membership to act in. */
export function narrowTenantApiTokenScope(
  raw: unknown,
  app: AppDef,
  observation: unknown,
  currentOperations: readonly { id: string; eligibleRoles: readonly string[] }[],
  now: number,
) {
  const token = captureApiTokenRecord(raw),
    clock = instant(now);
  const current = record(snapshot(observation, 65536).value, ['appId', 'subject', 'eligible']);
  const observedSubject = subject(current.subject);
  if (
    !app.api ||
    app.auth?.rows !== 'tenant' ||
    token.tenant === undefined ||
    token.subject.kind !== 'account' ||
    current.appId !== app.id ||
    token.appId !== app.id ||
    current.eligible !== true ||
    observedSubject.kind !== 'account' ||
    token.subject.id !== observedSubject.id ||
    clock < token.createdAt ||
    clock >= token.expiresAt ||
    token.revokedAt !== undefined
  )
    return refuse();
  const roles = token.roles.filter(
    (role) =>
      app.api!.roles.includes(role) &&
      Object.hasOwn(app.auth?.roles ?? {}, role) &&
      (app.auth!.roles![role] as { realm?: string }).realm !== 'platform',
  );
  if (!roles.length) return refuse();
  return Object.freeze({ ...scopeOf(token, app, roles, currentOperations), tenant: token.tenant });
}

function scopeOf(
  token: Readonly<TokenRecord>,
  app: AppDef,
  roles: readonly string[],
  currentOperations: readonly { id: string; eligibleRoles: readonly string[] }[],
) {
  const captured = snapshot(currentOperations, 262144).value;
  if (!Array.isArray(captured) || captured.length > 1024) return refuse();
  const ids = new Set<string>(),
    operations: string[] = [];
  for (const rawOperation of captured) {
    const operation = record(rawOperation, ['id', 'eligibleRoles']),
      id = text(operation.id);
    const eligibleRoles = names(operation.eligibleRoles, 128);
    if (ids.has(id) || eligibleRoles.some((role) => !app.api!.roles.includes(role))) return refuse();
    ids.add(id);
    if (eligibleRoles.some((role) => roles.includes(role)) && (token.operations === undefined || token.operations.includes(id)))
      operations.push(id);
  }
  return Object.freeze({
    stage: 'token-scope-foundation' as const,
    credentialVerification: 'pending' as const,
    authorization: 'pending' as const,
    tokenId: token.id,
    appId: token.appId,
    subject: token.subject,
    roles: Object.freeze([...roles]),
    operations: Object.freeze(operations),
  });
}
