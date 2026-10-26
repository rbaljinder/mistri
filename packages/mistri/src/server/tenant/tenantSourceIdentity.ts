import { createHash, randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { captureTenantData, denyTenant, tenantIdentifier, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { assertTenantOwnership, type TenantOwnershipSnapshot } from './tenantOwnership.js';
import type { TenantReadSource } from './tenantReadSource.js';
import type { TenantStoreBinding } from './tenantStore.js';
import type { TenantWriteSource } from './tenantWriteSource.js';

/** Private factory evidence, not a credential or a backup/restore attestation.
 * A matching path never permits replacement of a live source's pinned file. */
export interface TenantSourceIdentity extends TenantStoreBinding {
  /** The SQLite file's canonical path, or a PostgreSQL source's locator. */
  readonly canonicalPath: string;
}

/* A PostgreSQL source has no file. Its locator is a digest of the resolved
   connection URL under a per-process salt: equal for sources this process
   opened on the same URL, and never a credential, host or database name
   that an identity or a history-partition key could carry anywhere. */
const locatorSalt = randomBytes(32);
export function postgresTenantLocator(url: string): string {
  tenantIdentifier(url, 32_768);
  if (!/^postgres(ql)?:\/\//i.test(url)) return denyTenant();
  return `postgres:${createHash('sha256').update(locatorSalt).update(url).digest('hex')}`;
}
export const isPostgresTenantLocator = (value: string): boolean => /^postgres:[0-9a-f]{64}$/.test(value);
type Source = TenantReadSource | TenantWriteSource;
const identities = new WeakMap<
  Source,
  {
    readonly kind: 'read' | 'write';
    readonly identity: TenantSourceIdentity;
    readonly ownership: TenantOwnershipSnapshot;
  }
>();

/* Which kind of source an object is comes from the two source modules, each
   of which hands its own genuineness check here when it loads: they register
   identities with this module, so an import the other way would be a loop. */
const probes: { read?: (source: unknown) => unknown; write?: (source: unknown) => unknown } = {};
export function provideTenantSourceProbe(kind: 'read' | 'write', probe: (source: never) => unknown): void {
  probes[kind] = probe as (source: unknown) => unknown;
}

/** Factory-only registration, after attestation and before publication. Existing
 * genuine-source admission prevents this private export from branding fakes;
 * one-shot registration prevents rebinding an already published instance. */
export function registerTenantSourceIdentity(source: Source, input: TenantSourceIdentity): void {
  if (identities.has(source)) return denyTenant();
  let kind: 'read' | 'write';
  try {
    probes.read!(source);
    kind = 'read';
  } catch {
    try {
      probes.write!(source);
      kind = 'write';
    } catch {
      return denyTenant();
    }
  }
  const identity = captureTenantData(input);
  tenantRecord(identity, ['canonicalPath', 'appId', 'source', 'storeId']);
  tenantIdentifier(identity.canonicalPath, 32_768);
  if (!isAbsolute(identity.canonicalPath) && !isPostgresTenantLocator(identity.canonicalPath)) return denyTenant();
  tenantIdentifier(identity.appId);
  tenantIdentifier(identity.storeId);
  tenantRecord(identity.source, ['id', 'connection']);
  tenantIdentifier(identity.source.id);
  tenantIdentifier(identity.source.connection, 1024);
  const ownership = source.ownership;
  if (
    identity.appId !== ownership.appId ||
    identity.source.id !== ownership.source.id ||
    identity.source.connection !== ownership.source.connection
  )
    return denyTenant();
  identities.set(source, Object.freeze({ kind, identity, ownership }));
}

/** WeakMap access never inspects unknown objects, including revoked proxies.
 * Identity remains descriptive after close; source methods enforce lifetime. */
export function getTenantSourceIdentity(source: Source): TenantSourceIdentity {
  return identities.get(source)?.identity ?? denyTenant();
}

export function assertTenantSourcePair(read: TenantReadSource, write: TenantWriteSource): TenantSourceIdentity {
  const a = identities.get(read),
    b = identities.get(write);
  if (a?.kind !== 'read' || b?.kind !== 'write') return denyTenant();
  const left = a.identity,
    right = b.identity;
  if (
    left.canonicalPath !== right.canonicalPath ||
    left.storeId !== right.storeId ||
    left.appId !== right.appId ||
    left.source.id !== right.source.id ||
    left.source.connection !== right.source.connection
  )
    return denyTenant();
  assertTenantOwnership(a.ownership, b.ownership);
  return left;
}
