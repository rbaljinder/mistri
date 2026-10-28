/**
 * Public intake on a tenant App, the model half: shapes, the address rule,
 * the profile key, the scope a submission writes under and its journal
 * provenance. No source, request or handler is opened or run here; the
 * runtime is tenantIntake.ts, and the sources call into this.
 *
 * A tenant's public intake address is an unguessable string the platform
 * keeps in a column of its profile table (`auth.tenancy.profile`, named by the
 * policy's `intake.address`), written only by platform commands. It is a
 * routing address, not a secret or a credential: the tenant publishes it, and
 * all it lets anyone do is submit to that tenant, which is what it was
 * published for. What it rules out is choosing a tenant: nothing a visitor
 * types — a dealer code, a tenant id, a field — decides ownership.
 */
import type { CommandJournalPlatform, CommandJournalTenant } from '../../adapters/commands/commandJournalTypes.js';
import { isPublicForm, type AppDef, type AppFormView } from '../../shared/app.js';
import { snapshotRowScope, type RowScope, type RowScopeFilter } from '@mistriwork/engine/shared/rowScope.js';
import { captureTenantData, denyTenant, tenantIdentifier, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { parseTenantSelector } from './tenantMembership.js';
import type { TenantOwnershipSnapshot } from './tenantOwnership.js';
import { PLATFORM_TENANT_ID } from './tenantPlatform.js';
import { revision, time, type TenantStoreBinding } from './tenantStoreContract.js';

/** Admission-time evidence of one public submission: no account and no
 * membership, only where it lands and the window it was admitted for. Not a
 * credential; the writer fences its anchor again before anything commits. */
export interface TenantIntakeEvidence {
  readonly realm: 'intake';
  readonly appId: string;
  readonly source: { readonly id: string; readonly connection: string };
  readonly deployment: string;
  /** The public form's view key: the principal is `public:<form>`. */
  readonly form: string;
  /** The tenant the address resolved to, or `@platform` for the platform's triage. */
  readonly tenantId: string;
  /** The anchor row's version at resolution. */
  readonly tenantVersion: string;
  /** `@platform`'s version at resolution; the tenant version itself for triage. */
  readonly platformVersion: string;
  /** The policy's profile column, and the address resolution matched in it
   * (null for none): the writer requires the tenant's row to hold it still. */
  readonly column: string;
  readonly address: string | null;
  readonly verifiedAt: number;
  readonly validUntil: number;
  /** A step or the submit of a form saved on every step: the one submission
   * that may change rows it did not insert — its own draft's, found by the
   * applicant's token inside this place and fenced to it (forms/savedForms.ts). */
  readonly drafting: boolean;
}
export const INTAKE_EVIDENCE_KEYS: readonly string[] = Object.freeze([
  'realm',
  'appId',
  'source',
  'deployment',
  'form',
  'tenantId',
  'tenantVersion',
  'platformVersion',
  'column',
  'address',
  'verifiedAt',
  'validUntil',
  'drafting',
]);
/** Where a submission lands, as its handler is told: the tenant's own rows, or the platform's. */
type IntakePlace = 'tenant' | 'platform';

/** The resolver's question: which anchor does this address name now? */
export interface TenantIntakeLookup {
  readonly appId: string;
  readonly source: { readonly id: string; readonly connection: string };
  readonly deployment: string;
  /** The profile column holding each tenant's address: the policy's, never a request's. */
  readonly column: string;
  /** The address as the request carried it, already shape-checked, or null for none. */
  readonly address: string | null;
}
export interface TenantIntakeResolution {
  readonly tenantId: string;
  readonly tenantVersion: string;
  readonly platformVersion: string;
}

/* At least 22 base64url characters: 128 bits when the platform generates it at
   random, as it should. Shape only — anything else is simply not an address,
   and lands with the platform like an unknown one. */
const ADDRESS = /^[A-Za-z0-9_-]{22,128}$/;
const FORM = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** An intake address, or undefined for anything that is not one. Never a refusal. */
export function intakeAddress(value: unknown): string | undefined {
  return typeof value === 'string' && ADDRESS.test(value) ? value : undefined;
}

export function intakePlace(evidence: Pick<TenantIntakeEvidence, 'tenantId'>): IntakePlace {
  return evidence.tenantId === PLATFORM_TENANT_ID ? 'platform' : 'tenant';
}

/** Validate evidence against the ownership it runs on; anything else is refused. */
export function captureIntakeEvidence(value: unknown, owned: Pick<TenantOwnershipSnapshot, 'appId' | 'source'>): TenantIntakeEvidence {
  const evidence = captureTenantData(value);
  tenantRecord(evidence, INTAKE_EVIDENCE_KEYS);
  tenantRecord(evidence.source, ['id', 'connection']);
  if (
    evidence.realm !== 'intake' ||
    evidence.appId !== owned.appId ||
    evidence.source.id !== owned.source.id ||
    evidence.source.connection !== owned.source.connection ||
    typeof evidence.form !== 'string' ||
    !FORM.test(evidence.form)
  )
    return denyTenant();
  tenantIdentifier(evidence.deployment);
  if (evidence.tenantId !== PLATFORM_TENANT_ID) parseTenantSelector([evidence.tenantId as string]);
  revision(evidence.tenantVersion);
  revision(evidence.platformVersion);
  time(evidence.verifiedAt);
  time(evidence.validUntil);
  tenantIdentifier(evidence.column);
  if (
    (evidence.validUntil as number) <= (evidence.verifiedAt as number) ||
    typeof evidence.drafting !== 'boolean' ||
    (evidence.address !== null && intakeAddress(evidence.address) === undefined)
  )
    return denyTenant();
  // Triage is anchored on the platform alone; a tenant's placement always came from an address.
  if (evidence.tenantId === PLATFORM_TENANT_ID ? evidence.platformVersion !== evidence.tenantVersion : evidence.address === null)
    return denyTenant();
  return evidence as unknown as TenantIntakeEvidence;
}

/** The source-side lookup: bound to the store's App and source, never a request's. */
export function captureIntakeLookup(value: unknown, owner: Pick<TenantStoreBinding, 'appId' | 'source'>): TenantIntakeLookup {
  const lookup = captureTenantData(value);
  tenantRecord(lookup, ['appId', 'source', 'deployment', 'column', 'address']);
  tenantRecord(lookup.source, ['id', 'connection']);
  if (lookup.appId !== owner.appId || lookup.source.id !== owner.source.id || lookup.source.connection !== owner.source.connection)
    return denyTenant();
  tenantIdentifier(lookup.deployment);
  tenantIdentifier(lookup.column);
  if (lookup.address !== null && intakeAddress(lookup.address) === undefined) return denyTenant();
  return lookup as unknown as TenantIntakeLookup;
}

/** The one tenant an address lookup's rows name, or undefined: none, two
 * (an address two rows share names nobody) or a value no tenant could have. */
export function intakeTenantOf(rows: readonly Record<string, unknown>[]): string | undefined {
  if (rows.length !== 1 || typeof rows[0].tenant !== 'string') return undefined;
  try {
    return parseTenantSelector([rows[0].tenant]);
  } catch {
    return undefined;
  }
}

/** The profile's tenant key: the column every tenant row's ownership column
 * references, or its single primary key when nothing references it yet. */
export function intakeProfileKey(owned: TenantOwnershipSnapshot): string {
  const profile = owned.profile ?? denyTenant();
  const table = owned.schema.tables.find((candidate) => candidate.id === profile) ?? denyTenant();
  const referenced = new Set<string>();
  for (const fk of owned.schema.foreignKeys) {
    const rule = owned.ownership[fk.from.table];
    if (fk.to.table === profile && rule?.kind === 'tenant' && fk.from.columns.length === 1 && fk.from.columns[0] === rule.column) {
      referenced.add(fk.to.columns[0]);
    }
  }
  for (const source of owned.schema.tables)
    for (const column of source.columns) {
      const rule = owned.ownership[source.id];
      if (column.references?.table === profile && rule?.kind === 'tenant' && column.name === rule.column)
        referenced.add(column.references.column);
    }
  if (referenced.size > 1) return denyTenant();
  const primary = table.columns.filter((column) => column.primaryKey);
  const key = referenced.size ? [...referenced][0] : primary.length === 1 ? primary[0].name : denyTenant();
  if (!table.columns.some((column) => column.name === key)) return denyTenant();
  return key;
}

/** The address column: text on the profile, and neither its key nor any key
 * — an address that were the tenant id would be the tenant id, guessable. */
export function assertIntakeColumn(owned: TenantOwnershipSnapshot, name: string): void {
  tenantIdentifier(name);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return denyTenant();
  const profile = owned.profile ?? denyTenant();
  const table = owned.schema.tables.find((candidate) => candidate.id === profile) ?? denyTenant();
  const column = table.columns.find((candidate) => candidate.name === name) ?? denyTenant();
  const text = owned.schema.dialect === 'postgres' ? /^(text|character varying(\(\d+\))?|varchar(\(\d+\))?)$/i : /CHAR|CLOB|TEXT/i;
  if (
    column.primaryKey ||
    column.references ||
    !text.test(column.type) ||
    name === intakeProfileKey(owned) ||
    owned.schema.foreignKeys.some((fk) => fk.to.table === profile && fk.to.columns.includes(name))
  )
    return denyTenant();
}

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;
/** The address lookup on the profile table, in its engine's spelling: the
 * profile's tenant key of every row whose column holds the address, byte for
 * byte, two at most. The reader runs it to resolve and the writer to fence
 * (`FOR SHARE` on PostgreSQL). One parameter, the address. */
export function intakeAddressQuery(owned: TenantOwnershipSnapshot, column: string): string {
  assertIntakeColumn(owned, column);
  const key = intakeProfileKey(owned),
    physical = owned.resources[owned.profile ?? denyTenant()] ?? denyTenant();
  if (owned.schema.dialect !== 'postgres') {
    return `SELECT ${quoted(key)} AS tenant FROM main.${quoted(physical)} WHERE ${quoted(column)} = ? COLLATE BINARY LIMIT 2`;
  }
  const dot = physical.indexOf('.');
  if (dot < 1) return denyTenant();
  // COLLATE "C": the column is attested text, so equality is byte-exact whatever the database default.
  return `SELECT ${quoted(key)}::text AS tenant FROM ${quoted(physical.slice(0, dot))}.${quoted(physical.slice(dot + 1))}
    WHERE ${quoted(column)} COLLATE "C" = $1 LIMIT 2`;
}

/** One tenant's own address in the policy's column, read off its profile row
 * by the tenant key, in its engine's spelling. One parameter, the
 * tenant id; two rows at most, so a doubled key is seen rather than chosen. */
export function tenantAddressQuery(owned: TenantOwnershipSnapshot, column: string): string {
  assertIntakeColumn(owned, column);
  const key = intakeProfileKey(owned),
    physical = owned.resources[owned.profile ?? denyTenant()] ?? denyTenant();
  if (owned.schema.dialect !== 'postgres')
    return `SELECT ${quoted(column)} AS address FROM main.${quoted(physical)} WHERE ${quoted(key)} = ? LIMIT 2`;
  const dot = physical.indexOf('.');
  if (dot < 1) return denyTenant();
  return `SELECT ${quoted(column)}::text AS address FROM ${quoted(physical.slice(0, dot))}.${quoted(physical.slice(dot + 1))}
    WHERE ${quoted(key)} = $1 LIMIT 2`;
}

/** PostgreSQL's `tenantAddressQuery` and the address's resolution (`intakeAddressQuery`) in one statement: a row
 * per profile row the tenant key finds (two at most, as there), each with how many rows its value resolves to (two at
 * most) and the least of their tenant keys. The tenant's address was a round trip, and its resolution another that
 * waited on it, in front of every entry that shows one; the two are one snapshot either way, so asking them together
 * changes nothing they say. `heldAddress` still reads the rows and `tenantOwnAddress` the resolution, which names one
 * tenant only where it found exactly one row. One parameter, the tenant id. */
export function tenantOwnAddressQuery(owned: TenantOwnershipSnapshot, column: string): string {
  assertIntakeColumn(owned, column);
  if (owned.schema.dialect !== 'postgres') return denyTenant();
  const key = intakeProfileKey(owned),
    physical = owned.resources[owned.profile ?? denyTenant()] ?? denyTenant();
  const dot = physical.indexOf('.');
  if (dot < 1) return denyTenant();
  const table = `${quoted(physical.slice(0, dot))}.${quoted(physical.slice(dot + 1))}`;
  return `SELECT held.address, resolved.tenant, resolved.found FROM (
      SELECT ${quoted(column)}::text AS address FROM ${table} WHERE ${quoted(key)} = $1 LIMIT 2
    ) held LEFT JOIN LATERAL (
      SELECT min(hit.tenant) AS tenant, count(*)::int AS found FROM (
        SELECT ${quoted(key)}::text AS tenant FROM ${table} WHERE ${quoted(column)} COLLATE "C" = held.address LIMIT 2
      ) hit
    ) resolved ON true`;
}
/** The resolution `tenantOwnAddressQuery` carried on the held row, in `intakeAddressQuery`'s rows: one where it
 * found exactly one, none otherwise — `intakeTenantOf` names a tenant only for one row. */
export function ownAddressResolution(rows: readonly Record<string, unknown>[]): readonly Record<string, unknown>[] {
  return rows.length === 1 && rows[0].found === 1 ? [{ tenant: rows[0].tenant }] : [];
}

/** Which of a tenant's addresses to read, by the policy's columns, each optional. */
export interface TenantAddressesLookup {
  readonly tenantId: string;
  readonly columns: { readonly intake?: string; readonly public?: string };
}
export type TenantAddresses = Readonly<{ intake?: string; public?: string }>;
/** The lookup, checked: a tenant (never the platform), and known address columns. */
export function captureAddressesLookup(owned: TenantOwnershipSnapshot, lookup: TenantAddressesLookup): TenantAddressesLookup {
  const value = captureTenantData(lookup);
  tenantRecord(value, ['tenantId', 'columns']);
  tenantRecord(value.columns, ['intake', 'public']);
  const tenantId = parseTenantSelector([value.tenantId]);
  if (tenantId === PLATFORM_TENANT_ID) return denyTenant();
  for (const column of Object.values(value.columns)) if (column !== undefined) assertIntakeColumn(owned, column as string);
  return value as TenantAddressesLookup;
}
/** The value a tenant's profile row holds, when it is of an address's shape:
 * one row, never a doubled key. Its resolution (intakeAddressQuery) must still
 * name this tenant alone for it to be the tenant's own (tenantOwnAddress). */
export function heldAddress(rows: readonly Record<string, unknown>[]): string | undefined {
  return rows.length === 1 ? intakeAddress(rows[0].address) : undefined;
}
/** The address a tenant may be shown as its own: the one its profile row
 * holds, resolving back to this tenant alone. A doubled, malformed or shared
 * address is no one's, so it is left out rather than refused. */
export function tenantOwnAddress(
  tenantId: string,
  address: string | undefined,
  resolved: readonly Record<string, unknown>[],
): string | undefined {
  return address !== undefined && intakeTenantOf(resolved) === tenantId ? address : undefined;
}

/** The writer's address fence: a tenant's submission still names the one
 * profile row that holds its address; triage names none. */
export function assertIntakeHeld(evidence: TenantIntakeEvidence, rows: readonly Record<string, unknown>[] | undefined): void {
  if (intakePlace(evidence) === 'tenant' && intakeTenantOf(rows ?? []) !== evidence.tenantId) denyTenant();
}

/** The submission's scope: the command's footprint (`true` entries), within
 * what its place may touch. In a tenant, that tenant's rows by the ownership
 * predicate, and global rows; with the platform, the platform's own rows. */
export function composeIntakeScope(owned: TenantOwnershipSnapshot, evidence: TenantIntakeEvidence, footprint: RowScope): RowScope {
  try {
    const value = captureIntakeEvidence(evidence, owned),
      place = intakePlace(value);
    const rows = snapshotRowScope(owned.schema, footprint);
    const result: Record<string, boolean | RowScopeFilter> = Object.create(null);
    for (const [id, rule] of Object.entries(owned.ownership)) {
      if (rows[id] !== true) {
        result[id] = false;
        continue;
      }
      if (place === 'platform') {
        result[id] = rule.kind === 'platform';
        continue;
      }
      if (rule.kind === 'global') result[id] = true;
      else if (rule.kind === 'tenant') {
        // Byte-exact on SQLite, as the tenant read scope is; PostgreSQL's
        // ownership columns are attested deterministic already.
        result[id] = {
          groups: [[{ column: rule.column, op: '=', value: value.tenantId }]],
          ...(owned.schema.dialect === 'sqlite' ? { binary: [rule.column] } : {}),
        };
      } else result[id] = false;
    }
    return snapshotRowScope(owned.schema, result);
  } catch {
    return denyTenant();
  }
}

/** The receipt's provenance: the public principal in the membership's place,
 * at revision 0, with no role — in the tenant's realm, or the platform's. */
export function intakeJournalOwner(
  owner: TenantStoreBinding,
  evidence: TenantIntakeEvidence,
): CommandJournalTenant | CommandJournalPlatform {
  const actor = `public:${evidence.form}`;
  const common = {
    appId: owner.appId,
    storeId: owner.storeId,
    sourceId: owner.source.id,
    actorId: actor,
    membershipId: actor,
    membershipVersion: '0',
    roles: [],
    deployment: evidence.deployment,
  };
  return intakePlace(evidence) === 'platform'
    ? { realm: 'platform', ...common, platformVersion: evidence.tenantVersion }
    : { ...common, tenantId: evidence.tenantId, tenantVersion: evidence.tenantVersion };
}

/** The public forms of an App, by view key. */
export function tenantPublicForms(app: Pick<AppDef, 'views'>): ReadonlyMap<string, AppFormView> {
  return new Map(Object.entries(app.views).filter((entry): entry is [string, AppFormView] => isPublicForm(entry[1])));
}
