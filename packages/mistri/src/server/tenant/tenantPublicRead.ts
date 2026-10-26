/**
 * Public reads in a tenant App, the model half: the visitor's evidence, the
 * lookup that places a visitor with one tenant, and the scope it reads under.
 * No source, request or callback is opened or run here; the source resolves
 * (tenantReadSource.ts), the runtime admits (tenantPublicReadRuntime.ts).
 *
 * A visitor is placed by the tenant's public address — an unguessable string
 * the platform keeps in a column of its profile table (the policy's
 * `public.address`), held to the same rules as public intake's
 * (tenantIntakeModel.ts) — or by an operator's mapped host, which names its
 * tenant in configuration. Nothing a visitor types chooses a tenant, and an
 * address that names none, or a tenant that is not active, places nobody: the
 * visitor is answered as if the address were never there.
 *
 * What a visitor reads is that one tenant's rows of the resources
 * `auth.public` names, narrowed by the policy's `resolvePublicRows`, and
 * global rows by the same callback. A platform-owned table, and a table the
 * callback does not name, is never read; the runtime adds the tenant
 * predicate itself, so no callback can widen past its tenant.
 */
import { captureTenantData, denyTenant, tenantIdentifier, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { intakeAddress } from './tenantIntakeModel.js';
import { parseTenantSelector } from './tenantMembership.js';
import type { TenantOwnershipSnapshot } from './tenantOwnership.js';
import { PLATFORM_TENANT_ID } from './tenantPlatform.js';
import { revision, time, type TenantStoreBinding } from './tenantStoreContract.js';

/** A visitor's admission: no account and no membership, only the tenant its
 * address or host placed it with, the anchors' versions it was placed at, and
 * the window. Not a credential; every read re-resolves the address and fences
 * these versions again before its SQL. */
export interface TenantPublicEvidence {
  readonly realm: 'public';
  readonly appId: string;
  readonly source: { readonly id: string; readonly connection: string };
  readonly deployment: string;
  /** The tenant the address (or the mapped host) placed the visitor with: never `@platform`. */
  readonly tenantId: string;
  readonly tenantVersion: string;
  readonly platformVersion: string;
  /** The policy's profile column; never a request's. */
  readonly column: string;
  /** The address the visitor carried, or null on an operator's mapped host. */
  readonly address: string | null;
  readonly verifiedAt: number;
  readonly validUntil: number;
}
const PUBLIC_EVIDENCE_KEYS: readonly string[] = Object.freeze([
  'realm',
  'appId',
  'source',
  'deployment',
  'tenantId',
  'tenantVersion',
  'platformVersion',
  'column',
  'address',
  'verifiedAt',
  'validUntil',
]);

/** The resolver's question: which active tenant does this address (or this mapped host's tenant) name now? */
export interface TenantPublicLookup {
  readonly appId: string;
  readonly source: { readonly id: string; readonly connection: string };
  readonly deployment: string;
  readonly column: string;
  /** Exactly one of the two: the address a visitor carried, or the tenant a mapped host names. */
  readonly address: string | null;
  readonly tenant: string | null;
}
export interface TenantPublicResolution {
  readonly tenantId: string;
  readonly tenantVersion: string;
  readonly platformVersion: string;
}

/** A public address, or undefined for anything that is not one: the intake address's shape, at least 128 bits. */
export const publicAddress = intakeAddress;

/** Validate a lookup against the source it runs on; anything else is refused. */
export function capturePublicLookup(value: unknown, owner: Pick<TenantStoreBinding, 'appId' | 'source'>): TenantPublicLookup {
  const lookup = captureTenantData(value);
  tenantRecord(lookup, ['appId', 'source', 'deployment', 'column', 'address', 'tenant']);
  tenantRecord(lookup.source, ['id', 'connection']);
  if (lookup.appId !== owner.appId || lookup.source.id !== owner.source.id || lookup.source.connection !== owner.source.connection)
    return denyTenant();
  tenantIdentifier(lookup.deployment);
  tenantIdentifier(lookup.column);
  // One way to be placed: an address, or a host's tenant, never both and never neither.
  if ((lookup.address === null) === (lookup.tenant === null)) return denyTenant();
  if (lookup.address !== null && publicAddress(lookup.address) === undefined) return denyTenant();
  if (lookup.tenant !== null) parseTenantSelector([lookup.tenant as string]);
  return lookup as unknown as TenantPublicLookup;
}

/** Validate evidence against the ownership it runs on; anything else is refused. */
export function capturePublicEvidence(value: unknown, owned: Pick<TenantOwnershipSnapshot, 'appId' | 'source'>): TenantPublicEvidence {
  const evidence = captureTenantData(value);
  tenantRecord(evidence, PUBLIC_EVIDENCE_KEYS);
  tenantRecord(evidence.source, ['id', 'connection']);
  if (
    PUBLIC_EVIDENCE_KEYS.some((key) => !Object.hasOwn(evidence, key)) ||
    evidence.realm !== 'public' ||
    evidence.appId !== owned.appId ||
    evidence.source.id !== owned.source.id ||
    evidence.source.connection !== owned.source.connection
  )
    return denyTenant();
  tenantIdentifier(evidence.deployment);
  parseTenantSelector([evidence.tenantId as string]);
  revision(evidence.tenantVersion);
  revision(evidence.platformVersion);
  tenantIdentifier(evidence.column);
  time(evidence.verifiedAt);
  time(evidence.validUntil);
  if (
    (evidence.validUntil as number) <= (evidence.verifiedAt as number) ||
    (evidence.address !== null && publicAddress(evidence.address) === undefined)
  )
    return denyTenant();
  return evidence as unknown as TenantPublicEvidence;
}

/** The lookup that re-resolves this evidence: its own address, or its tenant when a mapped host placed it. */
export function publicLookupOf(evidence: TenantPublicEvidence): TenantPublicLookup {
  return {
    appId: evidence.appId,
    source: evidence.source,
    deployment: evidence.deployment,
    column: evidence.column,
    address: evidence.address,
    tenant: evidence.address === null ? evidence.tenantId : null,
  };
}

/** The fence every read runs before its SQL: the address still names this
 * tenant, and both anchors are still active at the versions it was placed at. */
export function assertPublicResolved(evidence: TenantPublicEvidence, resolution: TenantPublicResolution | null, instant: number): void {
  if (
    resolution === null ||
    resolution.tenantId !== evidence.tenantId ||
    resolution.tenantVersion !== evidence.tenantVersion ||
    resolution.platformVersion !== evidence.platformVersion ||
    !Number.isSafeInteger(instant) ||
    instant < evidence.verifiedAt ||
    instant >= evidence.validUntil
  )
    denyTenant();
}

/** The one tenant an address lookup's rows name, or undefined. */
export { intakeTenantOf as publicTenantOf } from './tenantIntakeModel.js';

/** Resolution from what one snapshot showed: the tenant, when it and `@platform` are both active. */
export function publicResolution(tenantId: string | undefined, anchor: (id: string) => string | null): TenantPublicResolution | null {
  if (tenantId === undefined) return null;
  const platform = anchor(PLATFORM_TENANT_ID);
  if (platform === null) return null;
  const version = anchor(tenantId);
  return version === null ? null : { tenantId, tenantVersion: version, platformVersion: platform };
}
