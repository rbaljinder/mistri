/**
 * A tenant App's capability link as a principal, the model half: the evidence one request at a link's door runs
 * under, the one row it reaches, the anchors it fences and its journal provenance. The runtime is tenantLinks.ts.
 *
 * A link is public intake's idea narrowed to one key. Intake is a principal whose tenant comes from a stored row
 * (its address) rather than a membership; a link's tenant comes from its own row in the tenant's journal, minted by
 * a member's command on one record. Its holder has no account, no membership and no role: the link is the grant, for
 * that record of that tenant and nothing else, while the link stays live and the tenant stays active.
 */
import type { CommandJournalTenant, CommandLinkRow } from '../../adapters/commands/commandJournalTypes.js';
import { holdPostgresLink, holdSqliteLink, LINK_ID, type HeldLink } from '../../adapters/commands/commandLinks.js';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import type { DatabaseSync } from 'node:sqlite';
import { snapshotRowScope, type RowScope, type RowScopeFilter } from '@mistriwork/engine/shared/rowScope.js';
import { captureTenantData, denyTenant, tenantIdentifier, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { linkRowKey } from '../../shared/appLinks.js';
import { narrowRowsToApiScope } from '../api/apiRowScope.js';
import { parseTenantSelector } from './tenantMembership.js';
import { PLATFORM_TENANT_ID } from './tenantPlatform.js';
import type { TenantOwnershipSnapshot } from './tenantOwnership.js';
import { revision, time, type IntakeAnchorEvidence, type TenantStoreBinding } from './tenantStoreContract.js';

/** One link request's admission evidence: the link as it was resolved, and the anchors' versions then. Not a
 * credential; the writer fences the anchors and the link row again. */
export interface TenantLinkEvidence {
  readonly realm: 'link';
  readonly appId: string;
  readonly source: { readonly id: string; readonly connection: string };
  readonly deployment: string;
  /** The link's id: the actor is `link:<id>`. */
  readonly linkId: string;
  /** The declaration it was minted under (`resources.<resource>.links.<name>`). */
  readonly name: string;
  readonly resource: string;
  /** The one record's key, as the journal keeps it (shared/appLinks.ts linkRowKey). */
  readonly rowKey: string;
  /** The tenant the link was minted in, as its row names it. */
  readonly tenantId: string;
  readonly tenantVersion: string;
  readonly platformVersion: string;
  readonly verifiedAt: number;
  readonly validUntil: number;
}
export const LINK_EVIDENCE_KEYS: readonly string[] = Object.freeze([
  'realm',
  'appId',
  'source',
  'deployment',
  'linkId',
  'name',
  'resource',
  'rowKey',
  'tenantId',
  'tenantVersion',
  'platformVersion',
  'verifiedAt',
  'validUntil',
]);

const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= max && !/\p{Cc}/u.test(value);

/** Validate evidence against the ownership it runs on; anything else is refused. */
export function captureLinkEvidence(value: unknown, owned: Pick<TenantOwnershipSnapshot, 'appId' | 'source'>): TenantLinkEvidence {
  const evidence = captureTenantData(value);
  tenantRecord(evidence, LINK_EVIDENCE_KEYS);
  if (LINK_EVIDENCE_KEYS.some((key) => !Object.hasOwn(evidence, key))) return denyTenant();
  tenantRecord(evidence.source, ['id', 'connection']);
  if (
    evidence.realm !== 'link' ||
    evidence.appId !== owned.appId ||
    evidence.source.id !== owned.source.id ||
    evidence.source.connection !== owned.source.connection ||
    typeof evidence.linkId !== 'string' ||
    !LINK_ID.test(evidence.linkId) ||
    !text(evidence.name, 128) ||
    !text(evidence.resource, 256) ||
    !text(evidence.rowKey, 2048) ||
    !linkRowKey(evidence.rowKey as string)
  )
    return denyTenant();
  tenantIdentifier(evidence.deployment);
  // A tenant's, always: `@platform` fails the selector, and a link is never minted outside a tenant here.
  parseTenantSelector([evidence.tenantId as string]);
  revision(evidence.tenantVersion);
  revision(evidence.platformVersion);
  time(evidence.verifiedAt);
  time(evidence.validUntil);
  if ((evidence.validUntil as number) <= (evidence.verifiedAt as number)) return denyTenant();
  return evidence as unknown as TenantLinkEvidence;
}

/**
 * The link's scope: its one record, within its tenant, and only where the footprint asks for its resource. Every
 * other table reads nothing, as a link's holder in an App without tenants sees nothing else (api/apiRowScope.ts
 * linkRowScope). No row policy is asked: a policy written for people would widen a key to one row by accident.
 */
export function composeLinkScope(owned: TenantOwnershipSnapshot, evidence: TenantLinkEvidence, footprint: RowScope): RowScope {
  try {
    const value = captureLinkEvidence(evidence, owned);
    const rows = snapshotRowScope(owned.schema, footprint);
    const rule = owned.ownership[value.resource];
    const key = linkRowKey(value.rowKey);
    if (!rule || rule.kind !== 'tenant' || !key) return denyTenant();
    const result: Record<string, boolean | RowScopeFilter> = Object.create(null);
    for (const id of Object.keys(owned.ownership)) result[id] = false;
    if (rows[value.resource] === true)
      // Byte-exact on SQLite, as the tenant read scope is.
      result[value.resource] = {
        groups: [[{ column: rule.column, op: '=', value: value.tenantId }]],
        ...(owned.schema.dialect === 'sqlite' ? { binary: [rule.column] } : {}),
      };
    let scope: RowScope = snapshotRowScope(owned.schema, result);
    for (const [column, part] of Object.entries(key))
      scope = narrowRowsToApiScope(scope, { key: value.resource, rows: { [value.resource]: column } }, part, owned.schema);
    return snapshotRowScope(owned.schema, scope);
  } catch {
    return denyTenant();
  }
}

/** The anchors the writer fences, in public intake's terms, which fence the same rows: the tenant and `@platform`. */
export function linkAnchor(evidence: TenantLinkEvidence): IntakeAnchorEvidence {
  return {
    tenantId: evidence.tenantId,
    tenantVersion: evidence.tenantVersion,
    platformVersion: evidence.platformVersion,
    verifiedAt: evidence.verifiedAt,
    validUntil: evidence.validUntil,
  };
}

/** A link read's fence, as the writer's anchor fence is for a write: the tenant and `@platform` are still active
 * at the versions resolution read, and the request's window is open. */
export function assertLinkReadCurrent(
  evidence: TenantLinkEvidence,
  found: Readonly<{ tenantVersion: string | null; platformVersion: string | null }>,
  instant: number,
): void {
  if (
    found.tenantVersion !== evidence.tenantVersion ||
    found.platformVersion !== evidence.platformVersion ||
    instant < evidence.verifiedAt ||
    instant >= evidence.validUntil
  )
    denyTenant();
}

/** Which link a request at the shared door names: its id, nothing else; the App and store are the source's own. */
export interface TenantLinkLookup {
  readonly id: string;
}
/** The link as one snapshot found it, with its tenant's anchors then: no credential, nobody admitted yet. */
export interface TenantLinkResolution {
  readonly link: CommandLinkRow;
  readonly tenantVersion: string;
  readonly platformVersion: string;
}
export function captureLinkLookup(lookup: unknown): TenantLinkLookup {
  const value = captureTenantData(lookup);
  tenantRecord(value, ['id']);
  if (typeof value.id !== 'string' || !LINK_ID.test(value.id)) return denyTenant();
  return { id: value.id };
}
/**
 * The link's placement: live, minted in a tenant (never the App-wide realm's `''`), that tenant and `@platform`
 * active. Anything else is null, whatever the reason, so no link is answered differently from a missing one.
 */
export function linkResolution(row: CommandLinkRow | undefined, anchor: (id: string) => string | null): TenantLinkResolution | null {
  if (!row || row.tenant === '' || row.tenant === PLATFORM_TENANT_ID) return null;
  try {
    parseTenantSelector([row.tenant]);
  } catch {
    return null;
  }
  const platformVersion = anchor(PLATFORM_TENANT_ID);
  const tenantVersion = platformVersion === null ? null : anchor(row.tenant);
  return platformVersion === null || tenantVersion === null ? null : Object.freeze({ link: row, tenantVersion, platformVersion });
}
/** A read's fence on the link row itself: the same link, still live, as the evidence was taken from. */
export function assertLinkRowCurrent(row: CommandLinkRow | undefined, evidence: TenantLinkEvidence): void {
  if (
    !row ||
    row.id !== evidence.linkId ||
    row.tenant !== evidence.tenantId ||
    row.resource !== evidence.resource ||
    row.rowKey !== evidence.rowKey ||
    row.name !== evidence.name
  )
    denyTenant();
}

const held = (owner: TenantStoreBinding, evidence: TenantLinkEvidence): HeldLink => ({
  id: evidence.linkId,
  app: owner.appId,
  tenant: evidence.tenantId,
  resource: evidence.resource,
  rowKey: evidence.rowKey,
  name: evidence.name,
});

/** Inside BEGIN IMMEDIATE, after the anchors: the link row as resolved, still live (not revoked, not expired). */
export function assertSqliteLinkLive(db: DatabaseSync, owner: TenantStoreBinding, evidence: TenantLinkEvidence, now: number): void {
  if (!holdSqliteLink(db, held(owner, evidence), now)) denyTenant();
}

/* After the anchors, so the lock order is always tenant, `@platform`, link: a revoke takes only the link row, so no
   cycle can form, and one that committed first is seen here and refuses this. */
export async function assertPostgresLinkHeld(
  client: PgQuery,
  owner: TenantStoreBinding,
  evidence: TenantLinkEvidence,
  now: number,
): Promise<void> {
  if (!(await holdPostgresLink(client, held(owner, evidence), now))) denyTenant();
}

/** The receipt's provenance: the link in the membership's place, at revision 0, with no roles, in its tenant's realm. */
export function linkJournalOwner(owner: TenantStoreBinding, evidence: TenantLinkEvidence): CommandJournalTenant {
  const actor = `link:${evidence.linkId}`;
  return {
    appId: owner.appId,
    storeId: owner.storeId,
    sourceId: owner.source.id,
    actorId: actor,
    membershipId: actor,
    membershipVersion: '0',
    roles: [],
    deployment: evidence.deployment,
    tenantId: evidence.tenantId,
    tenantVersion: evidence.tenantVersion,
  };
}
