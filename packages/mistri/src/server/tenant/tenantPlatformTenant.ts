/**
 * A platform command that acts in one named tenant (`defineCommand({ realm:
 * 'platform', tenant: '<input field>' })`), the model half: the evidence its
 * transaction runs under, the scope it writes within and the anchors it fences.
 *
 * The evidence is a platform membership's, unchanged, beside the tenant the
 * request named and that tenant's row version as the runtime read it before
 * the transaction. It is a realm of its own so that no other kind's rules
 * apply to it by accident: a platform member's evidence never places a
 * tenant's row, and this one places rows with exactly one tenant. The scope is
 * the platform policy's rows, with every tenant table narrowed to that one
 * tenant; there is no ambient cross-tenant write, because nothing else of any
 * tenant is in it.
 */
import { snapshotRowScope, type RowScope, type RowScopeFilter } from '@mistriwork/engine/shared/rowScope.js';
import { captureTenantData, denyTenant, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { parseTenantSelector } from './tenantMembership.js';
import type { TenantOwnershipSnapshot } from './tenantOwnership.js';
import { PLATFORM_EVIDENCE_KEYS, type PlatformMembershipEvidence } from './tenantPlatform.js';
import { composePlatformReadScope } from './tenantReadScope.js';
import { revision, type IntakeAnchorEvidence } from './tenantStoreContract.js';

export interface PlatformTenantEvidence extends Omit<PlatformMembershipEvidence, 'realm'> {
  readonly realm: 'platform-tenant';
  /** The tenant the request named: never `@platform`, which fails the selector. */
  readonly tenantId: string;
  /** That tenant's row version while active, as the runtime read it before the transaction. */
  readonly tenantVersion: string;
}
export const PLATFORM_TENANT_EVIDENCE_KEYS: readonly string[] = Object.freeze([...PLATFORM_EVIDENCE_KEYS, 'tenantId', 'tenantVersion']);

/** Validate the evidence's own shape and the tenant it names; the platform membership's fields are checked by its fence. */
export function capturePlatformTenantEvidence(value: unknown): PlatformTenantEvidence {
  const evidence = captureTenantData(value);
  tenantRecord(evidence, PLATFORM_TENANT_EVIDENCE_KEYS);
  if (PLATFORM_TENANT_EVIDENCE_KEYS.some((key) => !Object.hasOwn(evidence, key)) || evidence.realm !== 'platform-tenant')
    return denyTenant();
  parseTenantSelector([evidence.tenantId as string]);
  revision(evidence.tenantVersion);
  return evidence as unknown as PlatformTenantEvidence;
}

/** The platform membership the evidence carries, as its own fence and journal read it. */
export function platformOf(evidence: PlatformTenantEvidence): PlatformMembershipEvidence {
  const { realm: _realm, tenantId: _tenantId, tenantVersion: _tenantVersion, ...member } = evidence;
  return Object.freeze({ ...member, realm: 'platform' as const });
}

/** The tenant's row at the version the runtime read, and `@platform` at the membership's: public intake's anchor fence, on the same rows. */
export function platformTenantAnchor(evidence: PlatformTenantEvidence): IntakeAnchorEvidence {
  return {
    tenantId: evidence.tenantId,
    tenantVersion: evidence.tenantVersion,
    platformVersion: evidence.platformVersion,
    verifiedAt: evidence.verifiedAt,
    validUntil: evidence.validUntil,
  };
}

/** The platform policy's rows, each tenant table narrowed to the named tenant's:
 * ANDed onto every one of the policy's groups, never in place of them. Byte-exact
 * on SQLite, as the tenant read scope is. */
export function composePlatformTenantScope(owned: TenantOwnershipSnapshot, evidence: PlatformTenantEvidence, rows: RowScope): RowScope {
  try {
    const value = capturePlatformTenantEvidence(evidence);
    const platform = composePlatformReadScope(owned, platformOf(value), rows);
    const sqlite = owned.schema.dialect === 'sqlite';
    const result: Record<string, boolean | RowScopeFilter> = Object.create(null);
    for (const [id, rule] of Object.entries(owned.ownership)) {
      const scope = platform[id] ?? false;
      if (rule.kind !== 'tenant' || scope === false) {
        result[id] = scope;
        continue;
      }
      const mine = { column: rule.column, op: '=' as const, value: value.tenantId };
      const binary = [...new Set([...(scope === true ? [] : (scope.binary ?? [])), ...(sqlite ? [rule.column] : [])])];
      result[id] = {
        groups: scope === true ? [[mine]] : scope.groups.map((group) => [...group, mine]),
        ...(binary.length ? { binary } : {}),
      };
    }
    return snapshotRowScope(owned.schema, result);
  } catch (error) {
    return denyTenant(error);
  }
}
