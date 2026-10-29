/**
 * The engine-neutral half of the tenant store: names, the binding, the change
 * and record shapes, and the validation both engines apply to them. Moved here
 * unchanged from the SQLite store so the PostgreSQL store (tenantStorePostgres.ts)
 * applies the same rules to the same inputs instead of a copy that could drift.
 * Nothing here opens, reads or writes a database.
 */
import { isPromise } from 'node:util/types';
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import {
  captureTenantData,
  databaseUnanswered,
  denyTenant,
  denyTenantFor,
  isCapturedTenantData,
  refusalCause,
  tenantIdentifier,
  tenantRecord,
} from '@mistriwork/engine/server/evidence.js';
import {
  parseTenantSelector,
  TenantMembershipLapsed,
  type TenantMembershipEvidence,
  type TenantMembershipLookup,
  type TenantMembershipRecord,
} from './tenantMembership.js';
import type { PlatformMembershipEvidence } from './tenantPlatform.js';

/** Private store authority, on either engine. Never inferred from a request or provisioned on App open. */
export interface TenantStoreBinding {
  readonly appId: string;
  readonly source: { readonly id: string; readonly connection: string };
  /** Stable data namespace, not a session/deployment epoch or filesystem path. */
  readonly storeId: string;
}
/** What a public intake submission is admitted under, on either engine: no
 * membership, only the anchor row it lands beneath (a tenant's, or
 * `@platform`), that row's version, and the admission window. */
export interface IntakeAnchorEvidence {
  readonly tenantId: string;
  readonly tenantVersion: string;
  /** `@platform`'s version at resolution: a tenant's submission fences it too. */
  readonly platformVersion: string;
  readonly verifiedAt: number;
  readonly validUntil: number;
}
/** Private account discovery, not a tenant selector or membership credential. */
export type TenantMembershipListLookup = Omit<TenantMembershipLookup, 'tenantId'>;
export const TENANT_STORE_PREFIX = '__mistri_tenant_';
/**
 * A tenant-side store whose layout is not the version this build expects, said
 * as the recorded cause of a denial (layoutRefusal.ts): a caller still hears
 * only that the tenant context could not be verified; the operator a startup
 * refusal reports to hears which way the layout differs.
 */
export class TenantStoreLayoutDiffers extends Refusal {
  constructor(message: string) {
    super(message);
    this.name = 'TenantStoreLayoutDiffers';
  }
}
/** Deny, recording which way the layout differs where the version row says. */
export const denyLayout = (message: string | undefined): never =>
  denyTenant(message === undefined ? undefined : new TenantStoreLayoutDiffers(message));
/** Deny again from a catch, keeping the reason the inner denial recorded where it is one an operator should hear (looked for down the chain of denials). */
export const denyAgain = (error: unknown): never => {
  for (let cause = refusalCause(error), depth = 0; cause !== undefined && depth < 4; cause = refusalCause(cause), depth++)
    if (cause instanceof TenantStoreOfAnotherApp || cause instanceof TenantStoreLayoutDiffers) return denyTenantFor(cause);
  // A store the database did not answer (busy, locked, gone) is unavailable, never a denial.
  if (databaseUnanswered(error)) return denyTenantFor(error);
  return denyTenant();
};

/**
 * A second tenant App on a database that holds another's store. The store's
 * tables have fixed names and one row binding them to one App: its tenants,
 * their memberships and the platform row are that App's, and a second App
 * reading them would admit the same people to the same tenants under its own
 * roles. One database holds one tenant App, so this is refused, never shared,
 * and said: at provisioning, and as the recorded cause of a startup refusal.
 */
export class TenantStoreOfAnotherApp extends Refusal {
  constructor(bound: string, asked: string) {
    super(
      `This database's tenant store belongs to the tenant App "${bound}", not "${asked}". A database holds one tenant App: ` +
        "its tenants, their memberships and the platform row are one App's, and a second App would admit the same people to the " +
        'same tenants under its own roles. Give each tenant App its own database.',
    );
    this.name = 'TenantStoreOfAnotherApp';
  }
}
const prefix = TENANT_STORE_PREFIX;
export const TENANT_TABLES = Object.freeze({ meta: `${prefix}meta`, tenant: `${prefix}tenant`, membership: `${prefix}membership` });
export function binding(input: TenantStoreBinding): TenantStoreBinding {
  const value = captureTenantData(input);
  tenantRecord(value, ['appId', 'source', 'storeId']);
  tenantIdentifier(value.appId);
  tenantIdentifier(value.storeId);
  tenantRecord(value.source, ['id', 'connection']);
  tenantIdentifier(value.source.id);
  tenantIdentifier(value.source.connection, 1024);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.source.id)) return denyTenant();
  return value;
}
export function revision(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 128 || !/^[1-9][0-9]*$/.test(value)) denyTenant();
}
export function nextRevision(value: string): string {
  revision(value);
  const next = String(BigInt(value) + 1n);
  revision(next);
  return next;
}
export function roles(value: unknown): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.length > 256 || new Set(value).size !== value.length) return denyTenant();
  for (const role of value) tenantIdentifier(role);
}
export function time(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) denyTenant();
}
export function lookup(input: TenantMembershipLookup, owner: TenantStoreBinding): TenantMembershipLookup {
  const value = captureTenantData(input);
  tenantRecord(value, ['appId', 'accountId', 'tenantId', 'source', 'deployment']);
  tenantRecord(value.source, ['id', 'connection']);
  tenantIdentifier(value.accountId, 1024);
  tenantIdentifier(value.deployment);
  parseTenantSelector([value.tenantId]);
  if (value.appId !== owner.appId || value.source.id !== owner.source.id || value.source.connection !== owner.source.connection)
    return denyTenant();
  return value;
}
export function membershipRecord(
  owner: TenantStoreBinding,
  accountId: string,
  tenantId: string,
  row: Record<string, unknown>,
): TenantMembershipRecord {
  parseTenantSelector([tenantId]);
  revision(row.tenant_version);
  revision(row.version);
  tenantIdentifier(row.id, 1024);
  time(row.valid_until);
  if (
    !['active', 'suspended', 'closed'].includes(row.tenant_status as string) ||
    !['active', 'invited'].includes(row.status as string) ||
    typeof row.roles_json !== 'string'
  )
    return denyTenant();
  const granted: unknown = JSON.parse(row.roles_json);
  roles(granted);
  return captureTenantData({
    appId: owner.appId,
    accountId,
    tenantId,
    tenantStatus: row.tenant_status as TenantMembershipRecord['tenantStatus'],
    tenantVersion: row.tenant_version,
    membershipId: row.id,
    membershipVersion: row.version,
    status: row.status as TenantMembershipRecord['status'],
    roles: granted,
    validUntil: row.valid_until,
  });
}
/* The lookup each captured evidence was checked into, by the binding it was checked against. A membership is read
   back at the fences of every request on one evidence; that evidence and the binding are captures (frozen, plain
   data, evidence.ts), and nothing here reads the clock, so checking the pair again could only pass and build an
   equal lookup. Anything that is not a capture is checked every time, as before. */
const queries = new WeakMap<TenantMembershipEvidence, { readonly owner: TenantStoreBinding; readonly query: TenantMembershipLookup }>();
export function evidenceQuery(value: TenantMembershipEvidence, owner: TenantStoreBinding): TenantMembershipLookup {
  const held = queries.get(value);
  if (held && held.owner === owner) return held.query;
  const query = checkedQuery(value, owner);
  if (isCapturedTenantData(value) && isCapturedTenantData(owner)) queries.set(value, { owner, query });
  return query;
}
function checkedQuery(value: TenantMembershipEvidence, owner: TenantStoreBinding): TenantMembershipLookup {
  tenantRecord(value, [
    'appId',
    'accountId',
    'tenantId',
    'source',
    'deployment',
    'membershipId',
    'membershipVersion',
    'tenantVersion',
    'roles',
    'verifiedAt',
    'validUntil',
  ]);
  const query = lookup(
    { appId: value.appId, accountId: value.accountId, tenantId: value.tenantId, source: value.source, deployment: value.deployment },
    owner,
  );
  tenantIdentifier(value.membershipId, 1024);
  revision(value.membershipVersion);
  revision(value.tenantVersion);
  roles(value.roles);
  time(value.verifiedAt);
  time(value.validUntil);
  return query;
}
/** The refusal, or a refusal it was recorded under, is the membership's own (TenantMembershipLapsed). */
export function membershipLapsed(error: unknown): boolean {
  for (let at = error, depth = 0; at !== null && typeof at === 'object' && depth < 16; depth++) {
    if (at instanceof TenantMembershipLapsed) return true;
    at = refusalCause(at) ?? (at as { cause?: unknown }).cause;
  }
  return false;
}
export function assertCurrentRecord(value: TenantMembershipEvidence, current: TenantMembershipRecord | null, instant: number): void {
  if (
    instant < value.verifiedAt ||
    instant >= value.validUntil ||
    !current ||
    current.tenantStatus !== 'active' ||
    current.status !== 'active' ||
    instant >= current.validUntil ||
    value.validUntil > current.validUntil ||
    current.membershipId !== value.membershipId ||
    current.membershipVersion !== value.membershipVersion ||
    current.tenantVersion !== value.tenantVersion ||
    current.roles.length !== value.roles.length ||
    current.roles.some((role) => !value.roles.includes(role))
  )
    denyTenant(new TenantMembershipLapsed());
}
export function clock(now: () => number): number {
  const instant = now();
  if (isPromise(instant)) void Promise.prototype.then.call(instant, undefined, () => {});
  time(instant);
  return instant;
}
export interface TenantChange {
  tenantId: string;
  status: 'active' | 'suspended' | 'closed';
  expectedVersion: string | null;
}
export interface MembershipChange {
  tenantId: string;
  accountId: string;
  membershipId: string;
  status: 'active' | 'revoked' | 'invited';
  roles: readonly string[];
  validUntil: number;
  expectedVersion: string | null;
}
/** The platform realm's one anchor row (`@platform`); its id is never an input. */
export interface PlatformChange {
  status: 'active' | 'suspended' | 'closed';
  expectedVersion: string | null;
}
export type PlatformMembershipChange = Omit<MembershipChange, 'tenantId'>;

/** The trusted maintenance capability both stores return: version-checked
 * tenant and membership changes on the owner's open transaction and queue.
 * Platform-membership administration is store-level maintenance only. */
export interface TenantStoreAdministration {
  putTenant(change: TenantChange): Promise<void>;
  putMembership(change: MembershipChange): Promise<void>;
  putPlatform(change: PlatformChange): Promise<void>;
  putPlatformMembership(change: PlatformMembershipChange): Promise<void>;
}
/** Same-writer revalidation both stores return; never a credential verifier. */
export interface TenantMembershipGuard {
  assertCurrent(evidence: TenantMembershipEvidence): Promise<void>;
  assertPlatformCurrent(evidence: PlatformMembershipEvidence): Promise<void>;
}
