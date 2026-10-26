import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { isPromise } from 'node:util/types';
import type { TransactionOperations } from '@mistriwork/engine/adapters/adapter.js';
import {
  captureTenantData,
  denyTenant,
  denyTenantFor,
  refusalCause,
  tenantIdentifier,
  tenantRecord,
} from '@mistriwork/engine/server/evidence.js';
import { layoutRefusal, sqliteLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import {
  parseTenantSelector,
  type TenantMembershipEvidence,
  type TenantMembershipLookup,
  type TenantMembershipRecord,
} from './tenantMembership.js';
import {
  assertCurrentPlatformRecord,
  platformEvidenceQuery,
  platformLookup,
  platformMembershipRecord,
  PLATFORM_TENANT_ID,
  type PlatformMembershipEvidence,
  type PlatformMembershipLookup,
  type PlatformMembershipRecord,
} from './tenantPlatform.js';
import {
  assertCurrentRecord,
  binding,
  clock,
  evidenceQuery,
  lookup,
  membershipRecord,
  nextRevision,
  revision,
  roles,
  time,
  TENANT_STORE_PREFIX,
  TENANT_TABLES,
  TenantStoreLayoutDiffers,
  TenantStoreOfAnotherApp,
  denyAgain,
  denyLayout,
  type IntakeAnchorEvidence,
  type MembershipChange,
  type PlatformChange,
  type PlatformMembershipChange,
  type TenantChange,
  type TenantMembershipGuard,
  type TenantMembershipListLookup,
  type TenantStoreAdministration,
  type TenantStoreBinding,
} from './tenantStoreContract.js';

/* The names, shapes and validation are engine-neutral (tenantStoreContract.ts)
   and re-exported here so every existing importer keeps its path. */
export { TENANT_TABLES } from './tenantStoreContract.js';
export type {
  MembershipChange,
  PlatformChange,
  PlatformMembershipChange,
  TenantChange,
  TenantMembershipGuard,
  TenantMembershipListLookup,
  TenantStoreAdministration,
  TenantStoreBinding,
} from './tenantStoreContract.js';

/* Store v2.
   A tenant row says its `kind`. One reserved platform row (`@platform`, the
   only id that fails parseTenantSelector) anchors the platform realm's
   memberships with the same revisions, terminal states, live index and
   foreign key as a tenant's; suspending it stops the whole realm.
   A membership says its `kind` too. A `support` membership is the short-lived
   tenant membership a platform member holds while entered as a dealer: it
   names its parent platform membership and the versions it was opened
   against, is never invited, and an account holds at most one live. This
   slice creates none — the columns exist now so the store is reseeded once —
   and every member read (admission, discovery, rosters) takes `member` rows
   only, so a support row can never admit through `?tenant=`. */
const prefix = TENANT_STORE_PREFIX;
const liveIndex = `${prefix}live_membership`;
const liveSupportIndex = `${prefix}live_support`;
const platformIndex = `${prefix}platform`;
const definitions = new Map<string, string>([
  [
    TENANT_TABLES.meta,
    `CREATE TABLE "${TENANT_TABLES.meta}" (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = 1),
  app_id TEXT COLLATE BINARY NOT NULL,
  source_id TEXT COLLATE BINARY NOT NULL,
  store_id TEXT COLLATE BINARY NOT NULL
)`,
  ],
  [
    TENANT_TABLES.tenant,
    `CREATE TABLE "${TENANT_TABLES.tenant}" (
  id TEXT COLLATE BINARY PRIMARY KEY NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'closed')),
  version TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('tenant', 'platform')),
  CHECK ((kind = 'platform') = (id = '${PLATFORM_TENANT_ID}'))
)`,
  ],
  [
    TENANT_TABLES.membership,
    `CREATE TABLE "${TENANT_TABLES.membership}" (
  id TEXT COLLATE BINARY PRIMARY KEY NOT NULL,
  tenant_id TEXT COLLATE BINARY NOT NULL REFERENCES "${TENANT_TABLES.tenant}" (id) ON DELETE RESTRICT,
  account_id TEXT COLLATE BINARY NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'invited')),
  version TEXT NOT NULL,
  roles_json TEXT NOT NULL CHECK (json_valid(roles_json) AND length(CAST(roles_json AS BLOB)) <= 262144),
  valid_until INTEGER NOT NULL CHECK (valid_until >= 0 AND valid_until <= 9007199254740991),
  kind TEXT NOT NULL CHECK (kind IN ('member', 'support')),
  parent_id TEXT COLLATE BINARY REFERENCES "${TENANT_TABLES.membership}" (id) ON DELETE RESTRICT,
  parent_version TEXT,
  platform_version TEXT,
  CHECK ((kind = 'support') = (parent_id IS NOT NULL AND parent_version IS NOT NULL AND platform_version IS NOT NULL)),
  CHECK (kind = 'member' OR status IN ('active', 'revoked'))
)`,
  ],
  [
    liveIndex,
    `CREATE UNIQUE INDEX "${liveIndex}" ON "${TENANT_TABLES.membership}" (tenant_id, account_id) WHERE status != 'revoked' AND kind = 'member'`,
  ],
  [
    liveSupportIndex,
    `CREATE UNIQUE INDEX "${liveSupportIndex}" ON "${TENANT_TABLES.membership}" (account_id) WHERE kind = 'support' AND status = 'active'`,
  ],
  [platformIndex, `CREATE UNIQUE INDEX "${platformIndex}" ON "${TENANT_TABLES.tenant}" (kind) WHERE kind = 'platform'`],
]);

interface CatalogEntry {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}
function catalog(db: DatabaseSync, schema: 'main' | 'temp'): CatalogEntry[] {
  return db
    .prepare(`SELECT type, name, tbl_name, sql FROM ${schema}.sqlite_schema
    WHERE substr(name, 1, ?) = ? COLLATE NOCASE OR substr(tbl_name, 1, ?) = ? COLLATE NOCASE`)
    .all(prefix.length, prefix, prefix.length, prefix) as unknown as CatalogEntry[];
}
const SQLITE_TENANT_STORE_VERSION = 1;
function attest(db: DatabaseSync, owner: TenantStoreBinding): void {
  const entries = catalog(db, 'main');
  if (
    catalog(db, 'temp').length ||
    db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1 ||
    definitions.size !== entries.filter((entry) => entry.sql !== null).length ||
    entries.some((entry) =>
      entry.sql === null
        ? entry.type !== 'index' || !Object.values(TENANT_TABLES).some((name) => name === entry.tbl_name)
        : definitions.get(entry.name) !== entry.sql,
    )
  )
    return denyLayout(layoutRefusal('The tenant store', sqliteLayoutVersion(db, TENANT_TABLES.meta), SQLITE_TENANT_STORE_VERSION));
  const rows = db.prepare(`SELECT singleton, version, app_id, source_id, store_id FROM main."${TENANT_TABLES.meta}"`).all();
  if (rows.length === 1 && typeof rows[0].app_id === 'string' && rows[0].app_id !== owner.appId)
    denyTenantFor(new TenantStoreOfAnotherApp(rows[0].app_id, owner.appId));
  if (
    rows.length !== 1 ||
    rows[0].singleton !== 1 ||
    rows[0].version !== SQLITE_TENANT_STORE_VERSION ||
    rows[0].app_id !== owner.appId ||
    rows[0].source_id !== owner.source.id ||
    rows[0].store_id !== owner.storeId
  )
    denyLayout(layoutRefusal('The tenant store', rows.length === 1 ? rows[0].version : undefined, SQLITE_TENANT_STORE_VERSION));
}
export function assertSqliteTenantStore(db: DatabaseSync, input: TenantStoreBinding): void {
  try {
    attest(db, binding(input));
  } catch (error) {
    // Another App's store, or a layout from another mistri, stays the recorded cause, for the operator a startup refusal reports it to.
    denyAgain(error);
  }
}

/** Explicit maintenance on an existing file only. A mismatch never adopts or repairs a store. */
export function provisionSqliteTenantStore(existingPath: string, input: TenantStoreBinding): { version: 1; provisioned: boolean } {
  const owner = binding(input);
  let db: DatabaseSync | undefined;
  try {
    if (typeof existingPath !== 'string' || !statSync(existingPath).isFile()) return denyTenant();
    db = new DatabaseSync(existingPath);
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    const provisioned = catalog(db, 'main').length === 0;
    if (provisioned) {
      for (const ddl of definitions.values())
        db.exec(
          ddl.startsWith('CREATE TABLE ')
            ? ddl.replace('CREATE TABLE ', 'CREATE TABLE main.')
            : ddl.replace('CREATE UNIQUE INDEX ', 'CREATE UNIQUE INDEX main.'),
        );
      db.prepare(`INSERT INTO main."${TENANT_TABLES.meta}" VALUES (1, 1, ?, ?, ?)`).run(owner.appId, owner.source.id, owner.storeId);
    }
    attest(db, owner);
    db.exec('COMMIT');
    return { version: 1, provisioned };
  } catch (error) {
    try {
      if (db?.isTransaction) db.exec('ROLLBACK');
    } catch {
      /* No data capability is returned. */
    }
    // Maintenance is the operator's: another App's store is said, every other mismatch stays a denial.
    const cause = refusalCause(error);
    if (cause instanceof TenantStoreOfAnotherApp || cause instanceof TenantStoreLayoutDiffers) throw cause;
    return denyTenant();
  } finally {
    db?.close();
  }
}

function read(db: DatabaseSync, owner: TenantStoreBinding, query: TenantMembershipLookup): TenantMembershipRecord | null {
  const row = db
    .prepare(`SELECT t.status AS tenant_status, t.version AS tenant_version,
      m.id, m.status, m.version, m.roles_json, m.valid_until
    FROM main."${TENANT_TABLES.tenant}" AS t JOIN main."${TENANT_TABLES.membership}" AS m ON m.tenant_id = t.id
    WHERE t.id = ? COLLATE BINARY AND t.kind = 'tenant' AND m.account_id = ? COLLATE BINARY AND m.kind = 'member'
      AND m.status != 'revoked'`)
    .get(query.tenantId, query.accountId);
  if (!row) return null;
  return membershipRecord(owner, query.accountId, query.tenantId, row);
}
function readPlatform(db: DatabaseSync, owner: TenantStoreBinding, query: PlatformMembershipLookup): PlatformMembershipRecord | null {
  const row = db
    .prepare(`SELECT t.status AS platform_status, t.version AS platform_version,
      m.id, m.status, m.version, m.roles_json, m.valid_until
    FROM main."${TENANT_TABLES.tenant}" AS t JOIN main."${TENANT_TABLES.membership}" AS m ON m.tenant_id = t.id
    WHERE t.id = ? COLLATE BINARY AND t.kind = 'platform' AND m.account_id = ? COLLATE BINARY AND m.kind = 'member'
      AND m.status != 'revoked'`)
    .get(PLATFORM_TENANT_ID, query.accountId);
  if (!row) return null;
  return platformMembershipRecord(owner, query.accountId, row);
}

/** Complete bounded discovery inside the caller's owned snapshot. Filtering
 * precedes the bound; overflow refuses instead of returning a partial list.
 * Tenants and members only: the platform row is never a tenant to choose. */
export function readSqliteTenantMembershipsSnapshot(
  db: DatabaseSync,
  input: TenantStoreBinding,
  inputLookup: TenantMembershipListLookup,
  now: () => number = Date.now,
): readonly TenantMembershipRecord[] {
  try {
    const owner = binding(input),
      query = captureTenantData(inputLookup);
    tenantRecord(query, ['appId', 'accountId', 'source', 'deployment']);
    // Reuse the single-membership namespace and account validation, without
    // admitting an authored tenant selector into account discovery.
    lookup({ ...query, tenantId: 'discovery' }, owner);
    if (!db.isTransaction) return denyTenant();
    const instant = clock(now);
    attest(db, owner);
    const rows = db
      .prepare(`SELECT t.id AS tenant_id, t.status AS tenant_status, t.version AS tenant_version,
        m.id, m.status, m.version, m.roles_json, m.valid_until
      FROM main."${TENANT_TABLES.tenant}" AS t JOIN main."${TENANT_TABLES.membership}" AS m ON m.tenant_id = t.id
      WHERE m.account_id = ? COLLATE BINARY AND t.kind = 'tenant' AND m.kind = 'member'
        AND t.status = 'active' AND m.status = 'active' AND m.valid_until > ?
      ORDER BY t.id COLLATE BINARY LIMIT 257`)
      .all(query.accountId, instant);
    if (rows.length > 256) return denyTenant();
    const result = rows.map((row) => {
      if (typeof row.tenant_id !== 'string') return denyTenant();
      return membershipRecord(owner, query.accountId, row.tenant_id, row);
    });
    const completed = clock(now);
    if (completed < instant || result.some((record) => completed >= record.validUntil)) return denyTenant();
    return captureTenantData(result);
  } catch (error) {
    return denyAgain(error);
  }
}

/** Private reuse by an owner that already holds a read snapshot on this exact
 * handle. Unlike the standalone reader this neither starts nor ends a transaction. */
export function readSqliteTenantMembershipSnapshot(
  db: DatabaseSync,
  input: TenantStoreBinding,
  inputLookup: TenantMembershipLookup,
): TenantMembershipRecord | null {
  try {
    const owner = binding(input),
      query = lookup(inputLookup, owner);
    if (!db.isTransaction) return denyTenant();
    attest(db, owner);
    return read(db, owner, query);
    // A refusal stays one; a database that failed to answer is a fault.
  } catch (error) {
    return denyTenantFor(error);
  }
}

/** One owned read snapshot covers both schema/namespace attestation and membership. */
export function readSqliteTenantMembership(
  db: DatabaseSync,
  input: TenantStoreBinding,
  inputLookup: TenantMembershipLookup,
): TenantMembershipRecord | null {
  let began = false;
  try {
    const owner = binding(input),
      query = lookup(inputLookup, owner);
    if (db.isTransaction) return denyTenant();
    db.exec('BEGIN');
    began = true;
    const result = readSqliteTenantMembershipSnapshot(db, owner, query);
    db.exec('COMMIT');
    began = false;
    return result;
  } catch (error) {
    try {
      if (began) db.exec('ROLLBACK');
    } catch {
      /* The host owns disposal of a failed reader. */
    }
    return denyAgain(error);
  }
}

/** Snapshot-local read revalidation only; never acquires a writer or grants a
 * credential. The source owner supplies the live snapshot and owns its lifetime. */
export function assertSqliteTenantMembershipSnapshot(
  db: DatabaseSync,
  input: TenantStoreBinding,
  evidence: TenantMembershipEvidence,
  now: () => number = Date.now,
): void {
  try {
    const owner = binding(input),
      value = captureTenantData(evidence);
    const query = evidenceQuery(value, owner);
    if (!db.isTransaction) return denyTenant();
    const instant = clock(now);
    const current = readSqliteTenantMembershipSnapshot(db, owner, query);
    assertCurrentRecord(value, current, instant);
  } catch (error) {
    return denyTenantFor(error);
  }
}

/** The platform twin of readSqliteTenantMembershipSnapshot, inside the caller's snapshot. */
export function readSqlitePlatformMembershipSnapshot(
  db: DatabaseSync,
  input: TenantStoreBinding,
  inputLookup: PlatformMembershipLookup,
): PlatformMembershipRecord | null {
  try {
    const owner = binding(input),
      query = platformLookup(inputLookup, owner);
    if (!db.isTransaction) return denyTenant();
    attest(db, owner);
    return readPlatform(db, owner, query);
  } catch (error) {
    return denyAgain(error);
  }
}

/** One owned read snapshot for a platform membership, as for a tenant's. */
export function readSqlitePlatformMembership(
  db: DatabaseSync,
  input: TenantStoreBinding,
  inputLookup: PlatformMembershipLookup,
): PlatformMembershipRecord | null {
  let began = false;
  try {
    const owner = binding(input),
      query = platformLookup(inputLookup, owner);
    if (db.isTransaction) return denyTenant();
    db.exec('BEGIN');
    began = true;
    const result = readSqlitePlatformMembershipSnapshot(db, owner, query);
    db.exec('COMMIT');
    began = false;
    return result;
  } catch (error) {
    try {
      if (began) db.exec('ROLLBACK');
    } catch {
      /* The host owns disposal of a failed reader. */
    }
    return denyAgain(error);
  }
}

/** Snapshot-local platform revalidation: the same membership, the same
 * platform row version, both still active. */
export function assertSqlitePlatformMembershipSnapshot(
  db: DatabaseSync,
  input: TenantStoreBinding,
  evidence: PlatformMembershipEvidence,
  now: () => number = Date.now,
): void {
  try {
    const owner = binding(input),
      value = captureTenantData(evidence);
    const query = platformEvidenceQuery(value, owner);
    if (!db.isTransaction) return denyTenant();
    const instant = clock(now);
    const current = readSqlitePlatformMembershipSnapshot(db, owner, query);
    assertCurrentPlatformRecord(value, current, instant);
  } catch (error) {
    return denyAgain(error);
  }
}

/* ---------- public intake ---------- */

/** A tenant's row, or `@platform` for the platform's own triage, when active. */
function intakeAnchor(db: DatabaseSync, tenantId: string): string | null {
  const platform = tenantId === PLATFORM_TENANT_ID;
  if (!platform) parseTenantSelector([tenantId]);
  const row = db
    .prepare(`SELECT status, version FROM main."${TENANT_TABLES.tenant}" WHERE id = ? COLLATE BINARY AND kind = ?`)
    .get(tenantId, platform ? 'platform' : 'tenant');
  if (!row || row.status !== 'active') return null;
  revision(row.version);
  return row.version;
}

/** The anchor's current version inside the caller's snapshot, or null when it
 * is missing, suspended or closed: resolution then falls back to the platform. */
export function readSqliteIntakeAnchor(db: DatabaseSync, input: TenantStoreBinding, tenantId: string): string | null {
  try {
    const owner = binding(input);
    if (!db.isTransaction) return denyTenant();
    attest(db, owner);
    return intakeAnchor(db, tenantId);
  } catch (error) {
    return denyAgain(error);
  }
}

/** The tenants active inside the caller's snapshot, by id, in byte order:
 * whom a job at times per tenant runs for. Each run is admitted again on its
 * own tenant's row, so this list is a plan, never authority. */
export function readSqliteActiveTenants(db: DatabaseSync, input: TenantStoreBinding): readonly string[] {
  try {
    const owner = binding(input);
    if (!db.isTransaction) return denyTenant();
    attest(db, owner);
    const rows = db
      .prepare(`SELECT id FROM main."${TENANT_TABLES.tenant}" WHERE kind = 'tenant' AND status = 'active' ORDER BY id COLLATE BINARY`)
      .all();
    return Object.freeze(rows.map((row) => parseTenantSelector([row.id as string])));
  } catch (error) {
    return denyAgain(error);
  }
}

/** The writer's intake fence: inside BEGIN IMMEDIATE, the anchor — and, for a
 * tenant's submission, `@platform` too — is still active at the version
 * resolution read, within the admission window. */
export function assertSqliteIntakeAnchorSnapshot(
  db: DatabaseSync,
  input: TenantStoreBinding,
  evidence: IntakeAnchorEvidence,
  now: () => number = Date.now,
): void {
  try {
    const owner = binding(input),
      value = captureTenantData(evidence);
    if (!db.isTransaction) return denyTenant();
    revision(value.tenantVersion);
    revision(value.platformVersion);
    time(value.verifiedAt);
    time(value.validUntil);
    const platform = value.tenantId === PLATFORM_TENANT_ID;
    if (platform && value.platformVersion !== value.tenantVersion) denyTenant();
    const instant = clock(now);
    attest(db, owner);
    if (
      intakeAnchor(db, value.tenantId) !== value.tenantVersion ||
      (!platform && intakeAnchor(db, PLATFORM_TENANT_ID) !== value.platformVersion) ||
      instant < value.verifiedAt ||
      instant >= value.validUntil
    )
      denyTenant();
  } catch (error) {
    return denyAgain(error);
  }
}

/** Runs only inside a host-owned transaction, never silently starts/autocommits.
 * A no-op UPDATE acquires the SQLite writer fence even for BEGIN DEFERRED.
 * Attestation precedes it, so no hidden trigger can perform business work. */
function fence(db: DatabaseSync, owner: TenantStoreBinding): void {
  if (!db.isTransaction) return denyTenant();
  attest(db, owner);
  if (db.prepare(`UPDATE main."${TENANT_TABLES.meta}" SET version = version WHERE singleton = 1`).run().changes !== 1) denyTenant();
}
function queued<T>(operations: TransactionOperations, input: T, work: (captured: T) => void): Promise<void> {
  let captured: T,
    invalid = false;
  try {
    captured = captureTenantData(input);
  } catch {
    invalid = true;
  }
  return operations.run(async () => {
    try {
      if (invalid) return denyTenant();
      work(captured!);
    } catch {
      return denyTenant();
    }
  });
}

/** Trusted maintenance capability, separate from business records and commands.
 * The owner must drain operations before COMMIT/ROLLBACK and discard the facade. */
export function createSqliteTenantAdministration(
  db: DatabaseSync,
  operations: TransactionOperations,
  input: TenantStoreBinding,
  assertActive?: () => void,
): TenantStoreAdministration {
  const owner = binding(input);
  if (assertActive !== undefined && typeof assertActive !== 'function') return denyTenant();
  const active = () => {
    if (!assertActive) return;
    const result = assertActive();
    if (isPromise(result)) void Promise.prototype.then.call(result, undefined, () => {});
    if (result !== undefined) denyTenant();
  };
  // One anchor row, a tenant's or the platform's: the same version protocol.
  const putAnchor = (id: string, kind: 'tenant' | 'platform', status: string, expectedVersion: string | null) => {
    if (!['active', 'suspended', 'closed'].includes(status)) return denyTenant();
    if (expectedVersion !== null) revision(expectedVersion);
    fence(db, owner);
    const previous = db.prepare(`SELECT status, version, kind FROM main."${TENANT_TABLES.tenant}" WHERE id = ? COLLATE BINARY`).get(id);
    if (expectedVersion === null) {
      if (previous || status !== 'active') return denyTenant();
      db.prepare(`INSERT INTO main."${TENANT_TABLES.tenant}" (id, status, version, kind) VALUES (?, ?, '1', ?)`).run(id, status, kind);
    } else {
      if (!previous || previous.kind !== kind || previous.status === 'closed' || previous.version !== expectedVersion) return denyTenant();
      db.prepare(`UPDATE main."${TENANT_TABLES.tenant}" SET status = ?, version = ? WHERE id = ? COLLATE BINARY AND kind = ?`).run(
        status,
        nextRevision(expectedVersion),
        id,
        kind,
      );
    }
  };
  // One ordinary membership, in a tenant or in the platform realm: the same
  // protocol. Support memberships are the support owner's
  // (tenantSupportTransaction.ts); none are written here.
  const putMember = (anchorId: string, kind: 'tenant' | 'platform', value: Omit<MembershipChange, 'tenantId'>) => {
    tenantIdentifier(value.accountId, 1024);
    tenantIdentifier(value.membershipId, 1024);
    roles(value.roles);
    time(value.validUntil);
    if (!['active', 'revoked', 'invited'].includes(value.status)) return denyTenant();
    if (value.expectedVersion !== null) revision(value.expectedVersion);
    fence(db, owner);
    const anchor = db
      .prepare(`SELECT status FROM main."${TENANT_TABLES.tenant}" WHERE id = ? COLLATE BINARY AND kind = ?`)
      .get(anchorId, kind);
    if (!anchor || (anchor.status !== 'active' && value.status !== 'revoked')) return denyTenant();
    const previous = db
      .prepare(`SELECT tenant_id, account_id, status, version FROM main."${TENANT_TABLES.membership}"
      WHERE id = ? COLLATE BINARY AND kind = 'member'`)
      .get(value.membershipId);
    const json = JSON.stringify(value.roles);
    if (value.expectedVersion === null) {
      if (previous || value.status === 'revoked') return denyTenant();
      db.prepare(`INSERT INTO main."${TENANT_TABLES.membership}" (id, tenant_id, account_id, status, version, roles_json, valid_until, kind)
        VALUES (?, ?, ?, ?, '1', ?, ?, 'member')`).run(value.membershipId, anchorId, value.accountId, value.status, json, value.validUntil);
    } else {
      if (
        !previous ||
        previous.status === 'revoked' ||
        previous.tenant_id !== anchorId ||
        previous.account_id !== value.accountId ||
        previous.version !== value.expectedVersion ||
        (previous.status === 'active' && value.status === 'invited')
      )
        return denyTenant();
      db.prepare(`UPDATE main."${TENANT_TABLES.membership}" SET status = ?, version = ?, roles_json = ?, valid_until = ?
        WHERE id = ? COLLATE BINARY AND kind = 'member'`).run(
        value.status,
        nextRevision(value.expectedVersion),
        json,
        value.validUntil,
        value.membershipId,
      );
    }
  };
  return Object.freeze({
    putTenant(change: TenantChange): Promise<void> {
      return queued(operations, change, (value) => {
        active();
        tenantRecord(value, ['tenantId', 'status', 'expectedVersion']);
        parseTenantSelector([value.tenantId]);
        putAnchor(value.tenantId, 'tenant', value.status, value.expectedVersion);
        active();
      });
    },
    putMembership(change: MembershipChange): Promise<void> {
      return queued(operations, change, (value) => {
        active();
        tenantRecord(value, ['tenantId', 'accountId', 'membershipId', 'status', 'roles', 'validUntil', 'expectedVersion']);
        parseTenantSelector([value.tenantId]);
        putMember(value.tenantId, 'tenant', value);
        active();
      });
    },
    putPlatform(change: PlatformChange): Promise<void> {
      return queued(operations, change, (value) => {
        active();
        tenantRecord(value, ['status', 'expectedVersion']);
        putAnchor(PLATFORM_TENANT_ID, 'platform', value.status, value.expectedVersion);
        active();
      });
    },
    putPlatformMembership(change: PlatformMembershipChange): Promise<void> {
      return queued(operations, change, (value) => {
        active();
        tenantRecord(value, ['accountId', 'membershipId', 'status', 'roles', 'validUntil', 'expectedVersion']);
        putMember(PLATFORM_TENANT_ID, 'platform', value);
        active();
      });
    },
  });
}

/** Private same-writer revalidation, NOT a credential verifier or transaction
 * owner. Evidence must come from the owning live issuer. The runtime must also
 * enforce session/deployment lifetime, tenant row ceilings and write footprints. */
export function createSqliteTenantMembershipGuard(
  db: DatabaseSync,
  operations: TransactionOperations,
  input: TenantStoreBinding,
  now: () => number = Date.now,
): TenantMembershipGuard {
  const owner = binding(input);
  if (typeof now !== 'function') return denyTenant();
  return Object.freeze({
    assertCurrent(evidence: TenantMembershipEvidence): Promise<void> {
      return queued(operations, evidence, (value) => {
        const query = evidenceQuery(value, owner);
        fence(db, owner);
        const instant = clock(now);
        // Recheck after host code, then read the current image, not a pre-clock one.
        fence(db, owner);
        const current = read(db, owner, query);
        assertCurrentRecord(value, current, instant);
      });
    },
    assertPlatformCurrent(evidence: PlatformMembershipEvidence): Promise<void> {
      return queued(operations, evidence, (value) => {
        const query = platformEvidenceQuery(value, owner);
        fence(db, owner);
        const instant = clock(now);
        fence(db, owner);
        assertCurrentPlatformRecord(value, readPlatform(db, owner, query), instant);
      });
    },
  });
}
