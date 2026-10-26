/**
 * A tenant App's service principal, the model half: the evidence one job
 * attempt runs under, the scope it writes within, the anchors it fences and
 * its journal provenance. No source, request or handler is opened or run
 * here; the runtime is tenantJobs.ts, and the sources call into this.
 *
 * A service principal is declared by the server's jobs module: a name and the
 * App roles it holds. It has no account and no membership. The realm it acts
 * in is its command's: a tenant command runs as the service in the tenant
 * whose event started the job, a platform command as the platform's service.
 * Either way that tenant bounds it: its scope is the tenant's rows and, in the
 * platform realm, the platform's own, so no other tenant's row is ever in it.
 */
import type { CommandJournalPlatform, CommandJournalTenant } from '../../adapters/commands/commandJournalTypes.js';
import { snapshotRowScope, type RowScope, type RowScopeFilter } from '@mistriwork/engine/shared/rowScope.js';
import { captureTenantData, denyTenant, tenantIdentifier, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { parseTenantSelector } from './tenantMembership.js';
import type { TenantOwnershipSnapshot } from './tenantOwnership.js';
import { PLATFORM_TENANT_ID } from './tenantPlatform.js';
import { revision, roles, time, type IntakeAnchorEvidence, type TenantStoreBinding } from './tenantStoreContract.js';

/** One job attempt's admission evidence: no account and no membership, only
 * who the service is, where it acts and the anchors' versions when its
 * attempt started. Not a credential; the writer fences the anchors again. */
export interface TenantServiceEvidence {
  readonly realm: 'service';
  readonly appId: string;
  readonly source: { readonly id: string; readonly connection: string };
  readonly deployment: string;
  /** The jobs module's principal: the actor is `service:<principal>`. */
  readonly principal: string;
  /** The command's realm: a tenant's rows, or the platform's and that tenant's. */
  readonly place: 'tenant' | 'platform';
  /** The tenant whose event started the job, as its verified envelope names it,
   * or the tenant a job at times runs for. Null only in the platform realm, for
   * a job at times that runs once on the platform: it then reaches no tenant's
   * rows at all. */
  readonly tenantId: string | null;
  /** The tenant row's version when the attempt started. Null in the platform
   * realm, whose command fences `@platform` alone. */
  readonly tenantVersion: string | null;
  /** `@platform`'s version when the attempt started. */
  readonly platformVersion: string;
  /** The roles the jobs module declares for the principal. */
  readonly roles: readonly string[];
  readonly verifiedAt: number;
  readonly validUntil: number;
}
export const SERVICE_EVIDENCE_KEYS: readonly string[] = Object.freeze([
  'realm',
  'appId',
  'source',
  'deployment',
  'principal',
  'place',
  'tenantId',
  'tenantVersion',
  'platformVersion',
  'roles',
  'verifiedAt',
  'validUntil',
]);
/** A jobs module's principal name, as defineJobs admits it. */
export const SERVICE_PRINCIPAL = /^[a-z][a-z0-9-]{0,62}$/;

/** Validate evidence against the ownership it runs on; anything else is refused. */
export function captureServiceEvidence(value: unknown, owned: Pick<TenantOwnershipSnapshot, 'appId' | 'source'>): TenantServiceEvidence {
  const evidence = captureTenantData(value);
  tenantRecord(evidence, SERVICE_EVIDENCE_KEYS);
  if (SERVICE_EVIDENCE_KEYS.some((key) => !Object.hasOwn(evidence, key))) return denyTenant();
  tenantRecord(evidence.source, ['id', 'connection']);
  if (
    evidence.realm !== 'service' ||
    evidence.appId !== owned.appId ||
    evidence.source.id !== owned.source.id ||
    evidence.source.connection !== owned.source.connection ||
    typeof evidence.principal !== 'string' ||
    !SERVICE_PRINCIPAL.test(evidence.principal) ||
    (evidence.place !== 'tenant' && evidence.place !== 'platform')
  )
    return denyTenant();
  tenantIdentifier(evidence.deployment);
  // A tenant's, always: `@platform` fails the selector. None only for the platform realm's own time job.
  if (evidence.tenantId === null) {
    if (evidence.place !== 'platform') denyTenant();
  } else parseTenantSelector([evidence.tenantId as string]);
  if (evidence.place === 'tenant') revision(evidence.tenantVersion);
  else if (evidence.tenantVersion !== null) denyTenant();
  revision(evidence.platformVersion);
  roles(evidence.roles);
  time(evidence.verifiedAt);
  time(evidence.validUntil);
  if (!(evidence.roles as readonly string[]).length || (evidence.validUntil as number) <= (evidence.verifiedAt as number))
    return denyTenant();
  return evidence as unknown as TenantServiceEvidence;
}

/** The service's scope: its command's footprint (`true` entries), within its
 * place. The event's tenant's rows by the ownership predicate and global
 * rows; in the platform realm the platform's own rows too. The App's row
 * policies take a member's evidence and are not consulted: a service has
 * none, and the footprint and the tenant bound it instead. */
export function composeServiceScope(owned: TenantOwnershipSnapshot, evidence: TenantServiceEvidence, footprint: RowScope): RowScope {
  try {
    const value = captureServiceEvidence(evidence, owned);
    const rows = snapshotRowScope(owned.schema, footprint);
    const result: Record<string, boolean | RowScopeFilter> = Object.create(null);
    for (const [id, rule] of Object.entries(owned.ownership)) {
      if (rows[id] !== true) {
        result[id] = false;
        continue;
      }
      if (rule.kind === 'global') result[id] = true;
      // No tenant: the platform realm's own time job reaches no tenant's row.
      else if (rule.kind === 'tenant' && value.tenantId === null) result[id] = false;
      else if (rule.kind === 'tenant') {
        // Byte-exact on SQLite, as the tenant read scope is; PostgreSQL's
        // ownership columns are attested deterministic already.
        result[id] = {
          groups: [[{ column: rule.column, op: '=', value: value.tenantId! }]],
          ...(owned.schema.dialect === 'sqlite' ? { binary: [rule.column] } : {}),
        };
      } else result[id] = value.place === 'platform';
    }
    return snapshotRowScope(owned.schema, result);
  } catch {
    return denyTenant();
  }
}

/** The anchors the writer fences, in public intake's terms, which fence the
 * same rows: the event's tenant and `@platform` for a tenant command,
 * `@platform` alone for a platform command. */
export function serviceAnchor(evidence: TenantServiceEvidence): IntakeAnchorEvidence {
  return evidence.place === 'tenant'
    ? {
        tenantId: evidence.tenantId!,
        tenantVersion: evidence.tenantVersion!,
        platformVersion: evidence.platformVersion,
        verifiedAt: evidence.verifiedAt,
        validUntil: evidence.validUntil,
      }
    : {
        tenantId: PLATFORM_TENANT_ID,
        tenantVersion: evidence.platformVersion,
        platformVersion: evidence.platformVersion,
        verifiedAt: evidence.verifiedAt,
        validUntil: evidence.validUntil,
      };
}

/** The receipt's provenance: the service principal in the membership's place,
 * at revision 0, with the roles it holds — in the event's tenant's realm, or
 * the platform's, whose receipts name no tenant. */
export function serviceJournalOwner(
  owner: TenantStoreBinding,
  evidence: TenantServiceEvidence,
): CommandJournalTenant | CommandJournalPlatform {
  const actor = `service:${evidence.principal}`;
  const common = {
    appId: owner.appId,
    storeId: owner.storeId,
    sourceId: owner.source.id,
    actorId: actor,
    membershipId: actor,
    membershipVersion: '0',
    roles: [...evidence.roles],
    deployment: evidence.deployment,
  };
  return evidence.place === 'platform'
    ? { realm: 'platform', ...common, platformVersion: evidence.platformVersion }
    : { ...common, tenantId: evidence.tenantId!, tenantVersion: evidence.tenantVersion! };
}
