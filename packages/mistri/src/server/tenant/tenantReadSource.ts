import {
  postgresSandboxSession,
  sandboxRows,
  sandboxStorePresent,
  sqliteSandboxSession,
  type SandboxRecord,
} from './tenantSandboxStore.js';
import { realpathSync, statSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  ANSI_STYLE,
  Refusal,
  Serial,
  TransactionOperations,
  TransactionOutcomeUnknown,
  type ScopedReads,
  type WriteTransaction,
} from '@mistriwork/engine/adapters/adapter.js';
import { PostgresAdapter, type PostgresReadSnapshot } from '@mistriwork/engine/adapters/postgres.js';
import { MAX_REPLICAS, ReplicaSet, ReplicaUnavailable, replicaFailure } from '@mistriwork/engine/adapters/replicas.js';
import { StatementStopped } from '@mistriwork/engine/adapters/statementControl.js';
import { createScopedReads } from '@mistriwork/engine/adapters/scoped/scopedReads.js';
import { sqliteParams, toJsonSafe, withBytes } from '@mistriwork/engine/adapters/sqlite.js';
import { readSqliteReadCatalog } from '@mistriwork/engine/adapters/scoped/sqliteScopeCatalog.js';
import { assertScopeCatalog, captureScopeCatalog, mapScopeCatalog } from '@mistriwork/engine/shared/scopeCatalog.js';
import type { RowScope } from '@mistriwork/engine/shared/rowScope.js';
import { mapAppScopedReads } from '../app/appResources.js';
import { captureTenantData, denyTenant, denyTenantFor, TenantContextError } from '@mistriwork/engine/server/evidence.js';
import {
  parseTenantSelector,
  type TenantMembershipEvidence,
  type TenantMembershipLookup,
  type TenantMembershipRecord,
} from './tenantMembership.js';
import { assertTenantOwnership, captureTenantOwnership, type TenantOwnershipSnapshot } from './tenantOwnership.js';
import type { PlatformMembershipEvidence, PlatformMembershipLookup, PlatformMembershipRecord } from './tenantPlatform.js';
import { composePlatformReadScope, composePublicReadScope, composeTenantReadScope } from './tenantReadScope.js';
import {
  assertPublicResolved,
  capturePublicEvidence,
  capturePublicLookup,
  publicLookupOf,
  publicResolution,
  publicTenantOf,
  type TenantPublicEvidence,
  type TenantPublicLookup,
  type TenantPublicResolution,
} from './tenantPublicRead.js';
import { assertSupportEvidenceObserved, supportAsMember } from './tenantSupportMembership.js';
import type { SupportMembershipEvidence } from './tenantSupportLease.js';
import { observeSqliteSupportMembership } from './tenantSupportMembershipSqlite.js';
import { observePostgresSupportMembership } from './tenantSupportMembershipPostgres.js';
import { postgresTenantLocator, provideTenantSourceProbe, registerTenantSourceIdentity } from './tenantSourceIdentity.js';
import {
  assertSqlitePlatformMembershipSnapshot,
  assertSqliteTenantMembershipSnapshot,
  assertSqliteTenantStore,
  readSqlitePlatformMembershipSnapshot,
  readSqliteTenantMembershipSnapshot,
  readSqliteTenantMembershipsSnapshot,
  type TenantMembershipListLookup,
  type TenantStoreBinding,
} from './tenantStore.js';
import {
  assertPostgresPlatformMembershipSnapshot,
  assertPostgresTenantMembershipSnapshot,
  assertPostgresTenantStore,
  attestedPostgresTenantStore,
  readPostgresPlatformMembership,
  readPostgresTenantMembership,
  readPostgresTenantMemberships,
} from './tenantStorePostgres.js';
import {
  attestPostgresTenantRelations,
  pinPostgresTenantRelationsStatement,
  postgresCatalogFingerprintOf,
  tenantCatalogTrust,
} from './tenantPostgresCatalog.js';
import { postgresCatalogDigestStatement } from '@mistriwork/engine/adapters/postgresCatalogDigest.js';
import { schemaMoved } from '@mistriwork/engine/adapters/postgresSchemaEpoch.js';
import { SYSTEM_SCHEMAS } from '@mistriwork/engine/adapters/postgresCatalog.js';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import {
  captureAddressesLookup,
  captureIntakeLookup,
  heldAddress,
  intakeAddressQuery,
  intakeTenantOf,
  tenantAddressQuery,
  tenantOwnAddress,
  type TenantAddresses,
  type TenantAddressesLookup,
  type TenantIntakeLookup,
  type TenantIntakeResolution,
} from './tenantIntakeModel.js';
import { PLATFORM_TENANT_ID } from './tenantPlatform.js';
import { readSqliteActiveTenants, readSqliteIntakeAnchor } from './tenantStore.js';
import { dueTimersPlan, type DueTimer, type DueTimersQuery } from './tenantDueTimers.js';
import { TENANT_NAMES_MAX, tenantNamePlan, tenantNamesOf, tenantNamesQuery } from './tenantNames.js';
import { readPostgresActiveTenants, readPostgresIntakeAnchor } from './tenantStorePostgres.js';
import {
  assertActivityQuery,
  assertHistoryQuery,
  type RecordActivityQuery,
  type RecordHistoryQuery,
  type StoredRecordChange,
} from '../../adapters/history/recordHistory.js';
import { readSqliteRecordActivity, readSqliteRecordHistory } from '../../adapters/history/sqliteRecordHistory.js';
import { readPostgresRecordActivity, readPostgresRecordHistory } from '../../adapters/history/postgresRecordHistory.js';
import { assertInboxQuery, type InboxQuery, type StoredNotice } from '../../adapters/inbox/inbox.js';
import {
  assertBrandingLogoQuery,
  assertBrandingQuery,
  type BrandingLogoQuery,
  type BrandingQuery,
  type StoredBranding,
  type StoredBrandingLogo,
} from '../../adapters/branding/branding.js';
import { readSqliteBranding, readSqliteBrandingLogo } from '../../adapters/branding/sqliteBranding.js';
import { readPostgresBranding, readPostgresBrandingLogo } from '../../adapters/branding/postgresBranding.js';
import { readSqliteInbox } from '../../adapters/inbox/sqliteInbox.js';
import { readPostgresInbox } from '../../adapters/inbox/postgresInbox.js';

/** Private pinned source, not a public credential or session/deployment issuer. */
/** A discovery's tenants, as a sandbox lookup takes them: tenant ids, at most a discovery's worth. */
function sandboxLookup(tenants: unknown): readonly string[] {
  if (!Array.isArray(tenants) || tenants.length > 256) return denyTenant();
  return Object.freeze(tenants.map((id) => parseTenantSelector([id])));
}

export interface TenantReadSource {
  readonly ownership: TenantOwnershipSnapshot;
  readMembership(lookup: TenantMembershipLookup): Promise<TenantMembershipRecord | null>;
  readMemberships(lookup: TenantMembershipListLookup): Promise<readonly TenantMembershipRecord[]>;
  assertCurrent(evidence: TenantMembershipEvidence): Promise<void>;
  scopeReads(evidence: TenantMembershipEvidence, rows: RowScope): Promise<ScopedReads>;
  /** The reader `scopeReads` binds, composed by the same rule, without the
   * snapshot `scopeReads` checks the membership in first. Nothing is read
   * until an operation runs, and every operation revalidates the evidence in
   * its own snapshot before its SQL, so no row is read on evidence that
   * snapshot did not find current. For an owner that also revalidates before
   * it releases anything (tenantReadRuntime.ts). */
  bindReads(evidence: TenantMembershipEvidence, rows: RowScope): Promise<ScopedReads>;
  /** Several reads in one snapshot: the evidence revalidated once at its start,
   * then every operation `work` asks for on that same snapshot, one after
   * another, and none once it has returned. The snapshot is the fence each of
   * `bindReads`' operations has, shared: what they read is one state, and it is
   * the state the membership was found current in. For an answer that is only
   * advice — which commands a record offers — and that its command asks again
   * when it runs (tenantCommandAvailability.ts). */
  withReads<T>(evidence: TenantMembershipEvidence, rows: RowScope, work: (reads: ScopedReads) => T | Promise<T>): Promise<T>;
  /** The platform realm's twins: its membership, its revalidation, and reads
   * under the platform scope (across tenants, unnamed tables denied). */
  readPlatformMembership(lookup: PlatformMembershipLookup): Promise<PlatformMembershipRecord | null>;
  assertPlatformCurrent(evidence: PlatformMembershipEvidence): Promise<void>;
  scopePlatformReads(evidence: PlatformMembershipEvidence, rows: RowScope): Promise<ScopedReads>;
  /** `scopePlatformReads` without its snapshot, as `bindReads` is `scopeReads`
   * without one: every operation revalidates the platform membership in its
   * own snapshot before its SQL, for an owner that fences again before it
   * releases anything (tenantPlatformReadRuntime.ts). */
  bindPlatformReads(evidence: PlatformMembershipEvidence, rows: RowScope): Promise<ScopedReads>;
  /** `withReads` for the platform realm, under the platform scope. */
  withPlatformReads<T>(evidence: PlatformMembershipEvidence, rows: RowScope, work: (reads: ScopedReads) => T | Promise<T>): Promise<T>;
  /** A support session's twins ("enter as dealer"): its revalidation, and reads
   * under the dealer's own scope. The fence is the support row itself, with its
   * parent platform membership, `@platform` and the dealer — never a member
   * membership, which an operator inside a dealer does not have. The scope is
   * the dealer's, composed by the same rule a member's is, so a session can
   * never read more than that one rule allows. */
  assertSupportCurrent(evidence: SupportMembershipEvidence): Promise<void>;
  scopeSupportReads(evidence: SupportMembershipEvidence, rows: RowScope): Promise<ScopedReads>;
  /** Public intake's resolution, in one snapshot: the active tenant whose
   * profile row alone holds the address, else the platform when it is active.
   * Reads the profile by the policy's column only; admits nobody. */
  resolveIntake(lookup: TenantIntakeLookup): Promise<TenantIntakeResolution>;
  /** A visitor's placement, in one snapshot: the active tenant whose profile
   * row alone holds the address (or the mapped host's tenant, when active),
   * with `@platform` active too; else null, whatever the reason, so no
   * address is answered differently from another. Admits nobody. */
  resolvePublic(lookup: TenantPublicLookup): Promise<TenantPublicResolution | null>;
  /** A visitor's placement re-resolved in a snapshot of its own: the release fence. */
  assertPublicCurrent(evidence: TenantPublicEvidence): Promise<void>;
  /** Reads under a visitor's scope (tenantPublicRead.ts composePublicReadScope),
   * as `bindReads` is a member's: every operation re-resolves the address in
   * its own snapshot and requires the same tenant at the same versions before
   * its SQL, so a rotated address or a suspended tenant reads nothing more. */
  bindPublicReads(evidence: TenantPublicEvidence, rows: RowScope): Promise<ScopedReads>;
  /** What these tenants are called: each one's profile row said by the App's
   * template for that resource (tenantNames.ts), for the ids a caller already
   * holds. Reads the profile's key and the name's columns only; admits nobody. */
  readTenantNames(lookup: TenantNamesLookup): Promise<Readonly<Record<string, string>>>;
  /** A tenant's own intake and public addresses, by the policy's columns, in
   * one snapshot: each only when its profile row holds one of an
   * address's shape that resolves back to this tenant alone. For the tenant's
   * own lease to show; admits nobody. */
  readTenantAddresses(lookup: TenantAddressesLookup): Promise<TenantAddresses>;
  /** A job attempt's anchors, in one snapshot: the named tenant's row and
   * `@platform`, each its version while active, else null. With no tenant
   * (the platform's own time job), `@platform` alone. Admits nobody. */
  readServiceAnchors(tenantId: string | null): Promise<Readonly<{ tenantVersion: string | null; platformVersion: string | null }>>;
  /** The tenants active now, by id: whom a job at times per tenant runs for.
   * Each attempt is admitted again on its own tenant's row. Admits nobody. */
  readActiveTenants(): Promise<readonly string[]>;
  /** A machine timer's due records across the active tenants, a page at a
   * time, each with the tenant its owner column names, read off the row here
   * (tenantDueTimers.ts). A plan, as readActiveTenants is: each run is
   * admitted again on its own tenant's row. Admits nobody. */
  readDueTimers(query: DueTimersQuery): Promise<readonly DueTimer[]>;
  /** The sandboxes whose dev clock reads ahead (tenantSandboxClock.ts), none where the store was never
   * provisioned: which tenants' timers the sweep also reads on their own clock. A live tenant has no row
   * there, so none is ever among them. Admits nobody. */
  readSandboxClocks(): Promise<readonly SandboxRecord[]>;
  /** Which of these tenants are sandboxes, for discovery to mark them to their members: none where the
   * store was never provisioned. Admits nobody. */
  readSandboxes(tenants: readonly string[]): Promise<ReadonlySet<string>>;
  /** One record's stored history, by its store key — a tenant-owned record's
   * carries its owner (adapters/history/recordHistory.ts). Admits nobody: the
   * caller has read the record in the reader's own context first. */
  readRecordHistory(query: RecordHistoryQuery): Promise<StoredRecordChange[]>;
  /** A dashboard feed's stored rows (recordActivity.ts). Admits nobody: the
   * caller names the context's own tenant in `owners`, or none for the
   * platform realm, and reads each record the rows name in that context. */
  readRecordActivity(query: RecordActivityQuery): Promise<StoredRecordChange[]>;
  /** One person's notices in one inbox (tenantInbox.ts). Admits nobody: the caller names the lease's own inbox. */
  readInbox(query: InboxQuery): Promise<StoredNotice[]>;
  /** One tenant's saved branding in one App, or null (adapters/branding). */
  readBranding(query: BrandingQuery): Promise<StoredBranding | null>;
  /** One logo of an App by the hash of its bytes. */
  readBrandingLogo(query: BrandingLogoQuery): Promise<StoredBrandingLogo | null>;
  close(): Promise<void>;
}

/** The tenant an address names, when that tenant is active, else the platform.
 * The platform's own row first: while it is not active nothing is taken,
 * whatever the address, so no address is answered differently from another. */
function intakeResolution(tenantId: string | undefined, anchor: (id: string) => string | null): TenantIntakeResolution {
  const platform = anchor(PLATFORM_TENANT_ID);
  if (platform === null) return denyTenant();
  const version = tenantId === undefined ? null : anchor(tenantId);
  return tenantId !== undefined && version !== null
    ? { tenantId, tenantVersion: version, platformVersion: platform }
    : { tenantId: PLATFORM_TENANT_ID, tenantVersion: platform, platformVersion: platform };
}

/** The profile's record-name template, as the App's catalog serves it, and the tenants to name. */
interface TenantNamesLookup {
  readonly template: string | undefined;
  readonly tenants: readonly string[];
}
/** The lookup's plan and its ids, or undefined when there is nothing to read. */
function namesLookup(owned: TenantOwnershipSnapshot, lookup: TenantNamesLookup) {
  const value = captureTenantData(lookup);
  if (
    !Array.isArray(value.tenants) ||
    value.tenants.length > TENANT_NAMES_MAX ||
    (value.template !== undefined && typeof value.template !== 'string')
  )
    return denyTenant();
  const tenants = [...new Set(value.tenants.filter((id) => id !== PLATFORM_TENANT_ID))];
  for (const id of tenants) parseTenantSelector([id]);
  const plan = tenantNamePlan(owned, value.template);
  return plan && tenants.length ? { plan, tenants } : undefined;
}

const sources = new WeakSet<TenantReadSource>();

/** Only frozen factory objects can supply source authority. WeakSet lookup does
 * not inspect properties, so lookalikes, getters and proxies never execute. */
export function captureTenantReadSource(input: TenantReadSource): TenantReadSource {
  if (!sources.has(input)) return denyTenant();
  return input;
}
provideTenantSourceProbe('read', captureTenantReadSource);

/** A batch's reads in the shape a command's records take, for the one caller
 * that asks a command's questions without its transaction (availability): it
 * reads, and every way of writing refuses. */
export function advisoryRecords(reads: ScopedReads): WriteTransaction {
  const refuse = async (): Promise<never> => {
    throw new Refusal('Availability reads; it never writes.');
  };
  return Object.freeze<WriteTransaction>({
    query: (request) => reads.query(request),
    count: (table, filter) => reads.count(table, filter),
    insert: refuse,
    update: refuse,
    remove: refuse,
  });
}

/** The reader a batch is handed (`withReads`): each operation's arguments
 * captured, run one after another on the batch's snapshot, and refused once
 * the batch has returned. A database failure is mapped where it happens, so
 * what `work` itself throws stays its own; `own` hears which that was. */
async function readBatch<T>(
  bound: ScopedReads,
  active: () => void,
  work: (reads: ScopedReads) => T | Promise<T>,
  own: (error: unknown) => void,
): Promise<T> {
  const operations = new TransactionOperations();
  let open = true;
  const run = <A extends unknown[], R>(args: A, call: (...captured: A) => Promise<R>): Promise<R> => {
    let captured: A;
    try {
      if (!open) throw new TenantContextError();
      active();
      captured = captureTenantData(args);
    } catch {
      return Promise.reject(new TenantContextError());
    }
    return operations.run(async () => {
      try {
        const result = await call(...captured);
        active();
        return result;
      } catch (error) {
        return denyTenantFor(error);
      }
    });
  };
  const reads = Object.freeze<ScopedReads>({
    query: (request) => run([request] as [typeof request], (value) => bound.query(value)),
    count: (table, filter, limit) =>
      run([table, filter, limit] as [typeof table, typeof filter, typeof limit], (id, value, boundLimit) =>
        bound.count(id, value, boundLimit),
      ),
    runView: (view, offset) =>
      run([view, offset] as [typeof view, typeof offset], (value, boundOffset) => bound.runView(value, boundOffset)),
    countView: (view, limit) =>
      run([view, limit] as [typeof view, typeof limit], (value, boundLimit) => bound.countView(value, boundLimit)),
    runBreakdown: (breakdown, offset) =>
      run([breakdown, offset] as [typeof breakdown, typeof offset], (value, boundOffset) => bound.runBreakdown(value, boundOffset)),
    countBreakdown: (breakdown, limit) =>
      run([breakdown, limit] as [typeof breakdown, typeof limit], (value, boundLimit) => bound.countBreakdown(value, boundLimit)),
  });
  let result: T;
  try {
    result = await work(reads);
  } catch (error) {
    open = false;
    own(error);
    await operations.finish().catch(() => {});
    throw error;
  }
  open = false;
  await operations.finish();
  return result;
}

/** Opens once, read-only. Every operation owns a serialized read snapshot on
 * that exact handle; no registry lookup, request-time migration or writer exists. */
export function openSqliteTenantReadSource(
  existingPath: string,
  ownership: TenantOwnershipSnapshot,
  store: TenantStoreBinding,
  now: () => number = Date.now,
): TenantReadSource {
  let opened: DatabaseSync | undefined;
  try {
    const captured = captureTenantOwnership(ownership);
    // Ordinary SQLite catalogs omit engine internals. Apply exactly that
    // normalization to both sides, never private/business dependency filtering.
    const owned = captureTenantOwnership({
      ...captured,
      physicalSchema: mapScopeCatalog(
        captured.physicalSchema,
        new Map(captured.physicalSchema.tables.filter((table) => !/^sqlite_/i.test(table.id)).map((table) => [table.id, table.id])),
      ),
    });
    const owner = captureTenantData(store);
    if (
      owner.appId !== owned.appId ||
      owner.source.id !== owned.source.id ||
      owner.source.connection !== owned.source.connection ||
      typeof now !== 'function' ||
      typeof existingPath !== 'string' ||
      !statSync(existingPath).isFile()
    )
      return denyTenant();
    const canonicalPath = realpathSync(existingPath);
    const db = (opened = new DatabaseSync(canonicalPath, { readOnly: true, enableForeignKeyConstraints: true }));
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000');
    const physicalIds = new Map(Object.entries(owned.resources).map(([logical, physical]) => [physical, logical]));
    const logicalIds = new Map(Object.entries(owned.resources));
    const toPhysical = (id: string): string => logicalIds.get(id) ?? denyTenant();
    const toLogical = (id: string): string => physicalIds.get(id) ?? denyTenant();
    const physicalSchema = mapScopeCatalog(owned.physicalSchema, new Map([...physicalIds.keys()].map((id) => [id, id])));
    const allTrue: RowScope = Object.freeze(Object.fromEntries([...logicalIds.keys()].map((id) => [id, true])));
    let definitions: Map<string, string> | undefined;
    const assertCatalog = () => {
      const actual = readSqliteReadCatalog(db);
      if ([...physicalIds.keys()].some((id) => !actual.readable.has(id))) return denyTenant();
      assertTenantOwnership(owned, { ...owned, physicalSchema: actual.schema });
      // Catalog authority intentionally omits collations. Pin actual mapped DDL
      // too: changing a policy column to NOCASE/RTRIM must not widen its filter.
      const ddl = new Map<string, string>();
      for (const row of db.prepare("SELECT name, sql FROM main.sqlite_schema WHERE type = 'table'").all()) {
        if (typeof row.name === 'string' && physicalIds.has(row.name)) {
          if (typeof row.sql !== 'string') return denyTenant();
          ddl.set(row.name, row.sql);
        }
      }
      if (ddl.size !== physicalIds.size || (definitions && [...definitions].some(([id, sql]) => ddl.get(id) !== sql))) return denyTenant();
      definitions ??= ddl;
    };

    // Construction must fail before publishing a capability, and close its
    // owned handle even when either catalog or durable store evidence refuses.
    db.exec('BEGIN');
    assertCatalog();
    assertSqliteTenantStore(db, owner);
    db.exec('COMMIT');

    const queue = new Serial();
    let closing = false;
    let closed: Promise<void> | undefined;
    const active = () => {
      if (closing) denyTenant();
    };
    const close = (): Promise<void> => {
      if (!closed) {
        closing = true;
        closed = queue.run(async () => {
          try {
            db.close();
          } catch {
            return denyTenant();
          }
        });
      }
      return closed;
    };
    const snapshot = async <T>(work: () => T | Promise<T>): Promise<T> => {
      active();
      if (db.isTransaction) return denyTenant();
      db.exec('BEGIN');
      try {
        assertCatalog();
        const result = await work();
        active();
        db.exec('COMMIT');
        return result;
      } finally {
        if (db.isTransaction) {
          try {
            db.exec('ROLLBACK');
          } catch {
            void close().catch(() => {});
          }
        }
      }
    };
    // Snapshot all arguments before the first queue wait. Failures are local to
    // this read; the serialized source still drains subsequent accepted work.
    const invoke = <A, R>(input: A, work: (captured: A) => R | Promise<R>): Promise<R> => {
      let value: A;
      try {
        active();
        value = captureTenantData(input);
      } catch {
        return Promise.reject(new TenantContextError());
      }
      return queue.run(async () => {
        try {
          const result = await snapshot(() => work(value));
          active();
          return result;
        }
        // A refusal inside stays one; a database that failed to answer —
        // busy, gone, a statement that could not run — is a fault.
        catch (error) {
          return denyTenantFor(error);
        }
      });
    };
    const current = (evidence: TenantMembershipEvidence) => {
      assertSqliteTenantMembershipSnapshot(db, owner, evidence, () => {
        const instant = now();
        active();
        return instant;
      });
      // A trusted clock can retire the source synchronously. Never run SQL or
      // return a newly bound reader after that retirement.
      active();
    };
    const currentPlatform = (evidence: PlatformMembershipEvidence) => {
      assertSqlitePlatformMembershipSnapshot(db, owner, evidence, () => {
        const instant = now();
        active();
        return instant;
      });
      active();
    };
    /* A support session's fence: the support row itself, observed with its
       parent platform membership, `@platform` and the dealer. An operator inside
       a dealer holds no member membership there, so the member check above would
       refuse it; this runs inside the same snapshot, which `snapshot()` has
       already opened as a transaction. */
    const currentSupport = (evidence: SupportMembershipEvidence) => {
      const instant = now();
      active();
      assertSupportEvidenceObserved(
        observeSqliteSupportMembership(db, owner, {
          supportId: evidence.supportId,
          accountId: evidence.accountId,
          tenantId: evidence.tenantId,
          at: instant,
        }),
        evidence,
        instant,
      );
      active();
    };
    /* A visitor's placement in this snapshot: the address read by the policy's
       column, byte for byte, then both anchors. Never a refusal of its own: null. */
    const resolvePublicIn = (lookup: TenantPublicLookup): TenantPublicResolution | null => {
      const value = capturePublicLookup(lookup, owner),
        sql = intakeAddressQuery(owned, value.column);
      const tenantId = value.address === null ? (value.tenant as string) : publicTenantOf(db.prepare(sql).all(value.address));
      return publicResolution(tenantId, (id) => readSqliteIntakeAnchor(db, owner, id));
    };
    const currentPublic = (evidence: TenantPublicEvidence) => {
      const value = capturePublicEvidence(evidence, owned);
      const resolved = resolvePublicIn(publicLookupOf(value));
      const instant = now();
      active();
      assertPublicResolved(value, resolved, instant);
      active();
    };
    // One compiled reader per admitted scope. Every call first revalidates the
    // principal it was bound for, tenant or platform, in its own snapshot.
    const scoped = (scope: RowScope): ScopedReads => {
      const physicalScope = Object.fromEntries(Object.entries(scope).map(([id, rule]) => [toPhysical(id), rule]));
      return mapAppScopedReads(
        createScopedReads(physicalSchema, physicalScope, ANSI_STYLE, async (sql, hint) => {
          const started = performance.now();
          const statement = db.prepare(sql.text);
          statement.setReadBigInts(true);
          const rows = statement.all(...sqliteParams(sql.params)) as Record<string, unknown>[];
          return {
            columns: statement.columns().map((column) => column.name),
            rows: rows.map(hint?.binary ? withBytes : toJsonSafe),
            ms: Math.round(performance.now() - started),
            sql,
          };
        }),
        { schema: owned.schema, toPhysical, toLogical },
      );
    };
    const bind = (scope: RowScope, revalidate: () => void): ScopedReads => {
      const reads = scoped(scope);
      const run = <A extends unknown[], R>(args: A, work: (...args: A) => Promise<R>) =>
        invoke(args, (capturedArgs) => {
          revalidate();
          return work(...capturedArgs);
        });
      return Object.freeze({
        query: (request) => run([request], reads.query),
        count: (table, filter, limit) => run([table, filter, limit], reads.count),
        runView: (view, offset) => run([view, offset], reads.runView),
        // The bound reaches the statement: never counted past it.
        countView: (view, limit) => run([view, limit], reads.countView),
        runBreakdown: (breakdown, offset) => run([breakdown, offset], reads.runBreakdown),
        countBreakdown: (breakdown, limit) => run([breakdown, limit], reads.countBreakdown),
      } satisfies ScopedReads);
    };
    /* A batch is one queued snapshot: its reads run inside it, on the handle
       directly, never through the queue it already holds. */
    const batch = <C, T>(input: C, open: (captured: C) => RowScope, work: (reads: ScopedReads) => T | Promise<T>): Promise<T> => {
      if (typeof work !== 'function') return Promise.reject(new TenantContextError());
      let own: { error: unknown } | undefined;
      return invoke(input, (captured) =>
        readBatch(scoped(open(captured)), active, work, (error) => {
          own = { error };
        }),
      ).catch((error: unknown) => {
        throw own ? own.error : error;
      });
    };
    // Arguments captured now, as `invoke` captures them; no snapshot is opened.
    const bindLater = <A>(input: A, make: (captured: A) => ScopedReads): Promise<ScopedReads> => {
      try {
        active();
        return Promise.resolve(make(captureTenantData(input)));
      } catch {
        return Promise.reject(new TenantContextError());
      }
    };
    const source: TenantReadSource = Object.freeze({
      ownership: owned,
      readMembership: (lookup: TenantMembershipLookup) => invoke(lookup, (query) => readSqliteTenantMembershipSnapshot(db, owner, query)),
      readMemberships: (lookup: TenantMembershipListLookup) =>
        invoke(lookup, (query) =>
          readSqliteTenantMembershipsSnapshot(db, owner, query, () => {
            const instant = now();
            active();
            return instant;
          }),
        ),
      assertCurrent: (evidence: TenantMembershipEvidence) => invoke(evidence, current),
      scopeReads: (evidence: TenantMembershipEvidence, rows: RowScope) =>
        invoke({ evidence, rows }, (captured) => {
          current(captured.evidence);
          return bind(composeTenantReadScope(owned, captured.evidence, captured.rows, allTrue), () => current(captured.evidence));
        }),
      bindReads: (evidence: TenantMembershipEvidence, rows: RowScope) =>
        bindLater({ evidence, rows }, (captured) =>
          bind(composeTenantReadScope(owned, captured.evidence, captured.rows, allTrue), () => current(captured.evidence)),
        ),
      withReads: <T>(evidence: TenantMembershipEvidence, rows: RowScope, work: (reads: ScopedReads) => T | Promise<T>) =>
        batch(
          { evidence, rows },
          (captured) => {
            current(captured.evidence);
            return composeTenantReadScope(owned, captured.evidence, captured.rows, allTrue);
          },
          work,
        ),
      readPlatformMembership: (lookup: PlatformMembershipLookup) =>
        invoke(lookup, (query) => readSqlitePlatformMembershipSnapshot(db, owner, query)),
      assertPlatformCurrent: (evidence: PlatformMembershipEvidence) => invoke(evidence, currentPlatform),
      // The source recomposes the platform scope itself: whatever a runtime
      // passes, a table the platform policy does not name stays denied.
      scopePlatformReads: (evidence: PlatformMembershipEvidence, rows: RowScope) =>
        invoke({ evidence, rows }, (captured) => {
          currentPlatform(captured.evidence);
          return bind(composePlatformReadScope(owned, captured.evidence, captured.rows), () => currentPlatform(captured.evidence));
        }),
      bindPlatformReads: (evidence: PlatformMembershipEvidence, rows: RowScope) =>
        bindLater({ evidence, rows }, (captured) =>
          bind(composePlatformReadScope(owned, captured.evidence, captured.rows), () => currentPlatform(captured.evidence)),
        ),
      withPlatformReads: <T>(evidence: PlatformMembershipEvidence, rows: RowScope, work: (reads: ScopedReads) => T | Promise<T>) =>
        batch(
          { evidence, rows },
          (captured) => {
            currentPlatform(captured.evidence);
            return composePlatformReadScope(owned, captured.evidence, captured.rows);
          },
          work,
        ),
      assertSupportCurrent: (evidence: SupportMembershipEvidence) => invoke(evidence, currentSupport),
      /* The source recomposes the dealer's scope itself, as above — and through
         composeTenantReadScope on a member view of the support evidence, not a
         rule of its own. One policy rule then governs a dealer's rows for its
         own members and for an operator inside it; a second rule could disagree
         with the first, and that disagreement would show up as a session
         reading rows the policy meant to withhold rather than as a failing
         test. The fence is still the support row (currentSupport). */
      scopeSupportReads: (evidence: SupportMembershipEvidence, rows: RowScope) =>
        invoke({ evidence, rows }, (captured) => {
          currentSupport(captured.evidence);
          return bind(composeTenantReadScope(owned, supportAsMember(captured.evidence), captured.rows, allTrue), () =>
            currentSupport(captured.evidence),
          );
        }),
      resolvePublic: (lookup: TenantPublicLookup) => invoke(lookup, resolvePublicIn),
      assertPublicCurrent: (evidence: TenantPublicEvidence) => invoke(evidence, currentPublic),
      // The source recomposes the visitor's scope itself: the tenant predicate is never the caller's.
      bindPublicReads: (evidence: TenantPublicEvidence, rows: RowScope) =>
        bindLater({ evidence, rows }, (captured) =>
          bind(composePublicReadScope(owned, captured.evidence, captured.rows), () => currentPublic(captured.evidence)),
        ),
      resolveIntake: (lookup: TenantIntakeLookup) =>
        invoke(lookup, (query) => {
          const value = captureIntakeLookup(query, owner),
            sql = intakeAddressQuery(owned, value.column);
          const tenantId = value.address === null ? undefined : intakeTenantOf(db.prepare(sql).all(value.address));
          return intakeResolution(tenantId, (id) => readSqliteIntakeAnchor(db, owner, id));
        }),
      readTenantNames: (lookup: TenantNamesLookup) =>
        invoke(lookup, (query) => {
          const asked = namesLookup(owned, query);
          if (!asked) return Object.freeze({});
          const rows = db.prepare(tenantNamesQuery(owned, asked.plan, asked.tenants.length)).all(...asked.tenants);
          return tenantNamesOf(asked.plan, rows as Record<string, unknown>[], asked.tenants);
        }),
      readTenantAddresses: (lookup: TenantAddressesLookup) =>
        invoke(lookup, (query) => {
          const { tenantId, columns } = captureAddressesLookup(owned, query);
          const found: Record<string, string> = {};
          for (const [kind, column] of Object.entries(columns)) {
            if (column === undefined) continue;
            const address = heldAddress(db.prepare(tenantAddressQuery(owned, column)).all(tenantId) as Record<string, unknown>[]);
            const own = address && tenantOwnAddress(tenantId, address, db.prepare(intakeAddressQuery(owned, column)).all(address));
            if (own) found[kind] = own;
          }
          return Object.freeze(found) as TenantAddresses;
        }),
      // Always a tenant's: `@platform` fails the selector.
      readServiceAnchors: (tenantId: string | null) =>
        invoke(tenantId, (id) =>
          Object.freeze({
            tenantVersion: id === null ? null : readSqliteIntakeAnchor(db, owner, parseTenantSelector([id])),
            platformVersion: readSqliteIntakeAnchor(db, owner, PLATFORM_TENANT_ID),
          }),
        ),
      readActiveTenants: () => invoke(null, () => readSqliteActiveTenants(db, owner)),
      readSandboxClocks: () =>
        invoke(null, async () => {
          const rows = sqliteSandboxSession(db);
          return (await sandboxStorePresent(rows)) ? sandboxRows(rows, owner.appId).clocks() : Object.freeze([]);
        }),
      readSandboxes: (tenants: readonly string[]) =>
        invoke(sandboxLookup(tenants), async (asked) => {
          const rows = sqliteSandboxSession(db);
          return (await sandboxStorePresent(rows)) ? sandboxRows(rows, owner.appId).among(asked) : new Set<string>();
        }),
      readDueTimers: (query: DueTimersQuery) =>
        invoke(query, (value) => {
          const plan = dueTimersPlan(owned, value);
          const active = plan.tenants ? readSqliteActiveTenants(db, owner) : [];
          if (plan.tenants && !active.length) return Object.freeze([]);
          return plan.decode(db.prepare(plan.sql).all(...(plan.params(active) as SQLInputValue[])) as Record<string, unknown>[]);
        }),
      readRecordHistory: (query: RecordHistoryQuery) =>
        invoke(query, (value) => {
          assertHistoryQuery(value);
          return readSqliteRecordHistory(db, value);
        }),
      readRecordActivity: (query: RecordActivityQuery) =>
        invoke(query, (value) => {
          assertActivityQuery(value);
          return readSqliteRecordActivity(db, value);
        }),
      readInbox: (query: InboxQuery) =>
        invoke(query, (value) => {
          assertInboxQuery(value);
          return readSqliteInbox(db, value);
        }),
      readBranding: (query: BrandingQuery) =>
        invoke(query, (value) => {
          assertBrandingQuery(value);
          return readSqliteBranding(db, value);
        }),
      readBrandingLogo: (query: BrandingLogoQuery) =>
        invoke(query, (value) => {
          assertBrandingLogoQuery(value);
          return readSqliteBrandingLogo(db, value);
        }),
      close,
    });
    sources.add(source);
    registerTenantSourceIdentity(source, { ...owner, canonicalPath });
    return source;
  } catch {
    try {
      opened?.close();
    } catch {
      /* Construction never publishes its handle. */
    }
    return denyTenant();
  }
}

/**
 * The PostgreSQL counterpart of openSqliteTenantReadSource: the same source
 * contract on a dedicated read pool. Every operation is one REPEATABLE READ,
 * READ ONLY snapshot on one leased reader (`PostgresAdapter.readSnapshot`),
 * where SQLite uses a deferred BEGIN on its read-only handle. Each snapshot
 * first locks the mapped relations ACCESS SHARE — PostgreSQL
 * takes the snapshot at the first query after them — then attests the whole
 * catalog, the pinned pg_catalog description and the store, and only then
 * reads. That attestation is repeated in full when a digest of the catalog
 * rows it reads has moved since it last passed, and otherwise stands on the
 * digest (adapters/postgresCatalogDigest.ts); the digest itself is read at
 * most once per `trustFor`, and a snapshot begun within it takes the LOCK
 * alone. Membership is revalidated in that
 * same snapshot, unlocked, every time: nothing it did not show is released.
 * PostgreSQL snapshots are independent leases from the reader pool; close
 * drains them before ending that pool.
 *
 * `replicas` are the source's read replicas. A snapshot taken where the
 * request tolerates lag (adapters/replicas.ts) runs on one of them under
 * exactly this contract — the same LOCK and digest prologue, the same full
 * catalog and store attestation on its first use and whenever its digest
 * moves, the same relation description (which must match the primary's,
 * row scopes and all), and the same membership revalidation, against the
 * replica's own rows. The scope is compiled into the SQL, so no session
 * state has to be set up there. A replica that cannot answer — unreachable,
 * a catalog that does not attest, a member it has not seen yet — hands the
 * read to the primary, which stays the authority: a revocation reaches a
 * replica's reads after its replication lag, and every write and command
 * revalidates on the primary.
 */
export async function openPostgresTenantReadSource(
  url: string,
  ownership: TenantOwnershipSnapshot,
  store: TenantStoreBinding,
  now: () => number = Date.now,
  replicas: readonly string[] = [],
  trustFor: number = tenantCatalogTrust(),
): Promise<TenantReadSource> {
  let opened: PostgresAdapter | undefined;
  try {
    const owned = captureTenantOwnership(ownership);
    const owner = captureTenantData(store);
    if (
      owned.physicalSchema.dialect !== 'postgres' ||
      owner.appId !== owned.appId ||
      owner.source.id !== owned.source.id ||
      owner.source.connection !== owned.source.connection ||
      typeof now !== 'function' ||
      !Number.isSafeInteger(trustFor) ||
      trustFor < 0 ||
      typeof url !== 'string' ||
      !/^postgres(ql)?:\/\//i.test(url) ||
      !Array.isArray(replicas) ||
      replicas.length > MAX_REPLICAS ||
      replicas.some((replica) => typeof replica !== 'string' || !/^postgres(ql)?:\/\//i.test(replica))
    )
      return denyTenant();
    const locator = postgresTenantLocator(url);
    const reader = (opened = new PostgresAdapter(url, 'Private tenant reader'));
    const physicalIds = new Map(Object.entries(owned.resources).map(([logical, physical]) => [physical, logical]));
    const logicalIds = new Map(Object.entries(owned.resources));
    const toPhysical = (id: string): string => logicalIds.get(id) ?? denyTenant();
    const toLogical = (id: string): string => physicalIds.get(id) ?? denyTenant();
    const physicalSchema = mapScopeCatalog(owned.physicalSchema, new Map([...physicalIds.keys()].map((id) => [id, id])));
    const allTrue: RowScope = Object.freeze(Object.fromEntries([...logicalIds.keys()].map((id) => [id, true])));
    // The App's relations only: the store takes no pin, and is attested in the snapshot that attests the catalog.
    const pinned = [...physicalIds.keys()];
    /* What every snapshot begins with, in the message that begins it: the
       LOCK, then the digest as its first query, where PostgreSQL takes the
       snapshot. One round trip where BEGIN, LOCK and digest were three. */
    const pin = pinPostgresTenantRelationsStatement(pinned) ?? denyTenant();
    // The runtime schema stays in: the tenant store attested in this snapshot is in it, and a change there must move the digest.
    const digest = postgresCatalogDigestStatement(SYSTEM_SCHEMAS);
    const prologue = `${pin}; ${digest}`;
    let definitions: string | undefined;
    /* Each database this source reads — the primary, and each replica — with
       the digest of its catalog as the last full attestation that passed
       there saw it, read in that attestation's own snapshot
       (adapters/postgresCatalogDigest.ts). Nothing a request says reaches it. */
    type Target = { readonly url: string; reader: PostgresAdapter; attested?: string; checked?: number };
    /* The digest walks every catalog row of the database, and read in every
       snapshot it was most of the database's time under a tenant App (a field report,
       on a remote PostgreSQL: three quarters of all statement time, 27,458
       runs in the window its query insights covered). So an attestation that
       passed, or a digest that proved it still stood, stands for the snapshots
       begun within `trustFor` after it (tenantCatalogTrust, EPOCHLESS_TTL_MS unless a suite says
       otherwise), as the adapter's own catalog answers stand
       without the epoch store (postgresSchemaEpoch.ts): those snapshots take
       the LOCK alone, which still holds DDL off the pinned relations while they
       read, and the first one after the window reads the digest again. A
       statement that fails on a table or column that is not there forgets the
       attestation at once (schemaMoved). */
    const trusted = (target: Target): string | undefined => {
      const at = target.checked,
        now = Date.now();
      return target.attested !== undefined && at !== undefined && now >= at && now - at < trustFor ? target.attested : undefined;
    };
    const primary: Target = { url, reader };
    const standbys = new ReplicaSet<Target>(
      replicas.map((replica) => ({ url: replica, reader: new PostgresAdapter(replica, 'Private tenant replica reader') })),
    );
    /* Returns the store handle this snapshot's membership reads go through:
       the store is attested here with the catalog, so they need not repeat it. */
    const assertCatalog = async (
      snapshot: PostgresReadSnapshot,
      target: Target = primary,
      standing?: string,
      pool: PostgresAdapter = target.reader,
    ): Promise<PgQuery> => {
      /* Begun with the LOCK alone, on an attestation that still stands: unless another snapshot has attested since,
         which reads the digest here, after the LOCK and before any other query, where the snapshot is taken. */
      if (standing !== undefined) {
        if (snapshot.prologue?.length !== 1) return denyTenant();
        if (target.attested === standing) return attestedPostgresTenantStore(snapshot.client);
      } else if (snapshot.prologue?.length !== 2) return denyTenant();
      const fingerprint = postgresCatalogFingerprintOf(
        standing === undefined ? snapshot.prologue![1] : await snapshot.client.query(digest),
      );
      if (fingerprint !== target.attested) {
        /* `owned` was captured and recursively frozen at construction. The
         * only fresh part of the former reconstructed ownership object is
         * this snapshot's physical catalog, so re-capturing its unchanged
         * ownership, logical schema and resource mapping is redundant.
         * Catalog authority omits display names, but PostgreSQL's qualified
         * physical identity is still an admission invariant: retain that
         * canonical-ID fence before comparing the complete authority catalog. */
        const actual = captureScopeCatalog(await snapshot.describe());
        if (actual.dialect !== 'postgres' || actual.tables.some((table) => !table.schema || table.id !== `${table.schema}.${table.name}`))
          return denyTenant();
        assertScopeCatalog(owned.physicalSchema, actual);
        // Catalog authority omits collations, indexes and triggers; pin the
        // description too, as the SQLite reader pins its CREATE text.
        const described = await attestPostgresTenantRelations(snapshot.client, owned);
        if (definitions !== undefined && described !== definitions) return denyTenant();
        await assertPostgresTenantStore(snapshot.client, owner);
        definitions ??= described;
        /* Kept only for the pool it was read on: a snapshot that began on a
           pool since replaced (renew) does not hand its attestation to the
           new one, which attests in full. */
        if (target.reader === pool) target.attested = fingerprint;
      }
      if (target.reader === pool) target.checked = Date.now();
      return attestedPostgresTenantStore(snapshot.client);
    };

    // Construction must fail before publishing a capability, and close its
    // owned pool even when catalog or durable store evidence refuses.
    await reader.readSnapshot(
      async (snapshot) => {
        await assertCatalog(snapshot);
      },
      false,
      prologue,
    );
    // Asked once, at construction: row scopes inline on Postgres 12 and later (rowScope.ts).
    const style = await reader.scopeStyle();

    let closing = false;
    let closed: Promise<void> | undefined;
    const pending = new Set<Promise<void>>();
    const active = () => {
      if (closing) denyTenant();
    };
    const close = (): Promise<void> => {
      if (!closed) {
        closing = true;
        closed = (async () => {
          await Promise.allSettled([...pending]);
          try {
            await Promise.all(
              [...standbys.pools.map((standby) => standby.reader), ...retired].map((standby) => standby.close().catch(() => {})),
            );
            await primary.reader.close();
          } catch {
            return denyTenant();
          }
        })();
      }
      return closed;
    };
    /* A snapshot whose ROLLBACK could not be sent lost its connection: the
       server has ended that transaction, and the client was discarded, not
       pooled. Its request is refused as the database's fault (503), and
       nothing else is. Until rc.1 this retired the whole source, so one
       connection a pooler, failover or idle timeout ended left every sign-in,
       read, stream, job and mail pass refused until a restart. Now the pool
       is replaced, as the writer reopens after an uncertain write
       (tenantWriterLifecycle.ts): a fresh one at the same URL,
       its catalog attested in full again against the baseline the source
       opened with, and the old pool closed once the snapshots still on it
       settle — closing it under them would turn their wait for a connection
       into a refusal too. A read-only transaction has no outcome to
       reconcile; what stays refused is the request that lost its answer. */
    const lent = new Map<PostgresAdapter, number>();
    const retired = new Set<PostgresAdapter>();
    const renew = (target: Target, failed: PostgresAdapter) => {
      if (closing || target.reader !== failed) return;
      target.reader = new PostgresAdapter(target.url, target === primary ? 'Private tenant reader' : 'Private tenant replica reader');
      target.attested = target.checked = undefined;
      if (lent.has(failed)) retired.add(failed);
      else void failed.close().catch(() => {});
    };
    const on = async <T>(target: Target, work: (snapshot: PostgresReadSnapshot) => Promise<T>): Promise<T> => {
      const pool = target.reader;
      const standing = trusted(target);
      lent.set(pool, (lent.get(pool) ?? 0) + 1);
      try {
        return await pool.readSnapshot(
          async (lease) => {
            const store = await assertCatalog(lease, target, standing, pool);
            const result = await work(Object.freeze({ client: store, describe: lease.describe, execute: lease.execute }));
            active();
            return result;
          },
          false,
          standing === undefined ? prologue : pin,
        );
      } catch (error) {
        if (schemaMoved(error)) target.attested = target.checked = undefined;
        if (error instanceof TransactionOutcomeUnknown) renew(target, pool);
        throw error;
      } finally {
        const left = lent.get(pool)! - 1;
        if (left) lent.set(pool, left);
        else {
          lent.delete(pool);
          if (retired.delete(pool)) void pool.close().catch(() => {});
        }
      }
    };
    /* A replica's failure is never the answer: the primary decides. Only a
       stopped statement — the caller cancelled it — is not asked again. */
    const onReplica = async <T>(target: Target, work: (snapshot: PostgresReadSnapshot) => Promise<T>): Promise<T> => {
      try {
        return await on(target, work);
      } catch (error) {
        if (error instanceof StatementStopped) throw error;
        // Uncertain, as the primary's can be: `on` replaced that pool, not the source.
        if (error instanceof TransactionOutcomeUnknown)
          throw new ReplicaUnavailable('down', 'The replica reader is uncertain.', { cause: error });
        throw new ReplicaUnavailable(replicaFailure(error) ?? 'retry', 'The replica could not answer this read.', { cause: error });
      }
    };
    const snapshot = async <T>(work: (snapshot: PostgresReadSnapshot) => Promise<T>): Promise<T> => {
      active();
      return standbys.read(
        (target) => onReplica(target, work),
        () => on(primary, work),
      );
    };
    const invoke = <A, R>(input: A, work: (captured: A, lease: PostgresReadSnapshot) => R | Promise<R>): Promise<R> => {
      let value: A;
      try {
        active();
        value = captureTenantData(input);
      } catch {
        return Promise.reject(new TenantContextError());
      }
      let finish!: () => void;
      const held = new Promise<void>((resolve) => {
        finish = resolve;
      });
      pending.add(held);
      return (async () => {
        try {
          const result = await snapshot(async (lease) => work(value, lease));
          active();
          return result;
        }
        // A refusal inside stays one; a database that failed to answer —
        // busy, gone, a statement that could not run — is a fault.
        catch (error) {
          return denyTenantFor(error);
        } finally {
          pending.delete(held);
          finish();
        }
      })();
    };
    const clock = () => {
      const instant = now();
      active();
      return instant;
    };
    const current = async (lease: PostgresReadSnapshot, evidence: TenantMembershipEvidence) => {
      await assertPostgresTenantMembershipSnapshot(lease.client, owner, evidence, clock);
      // A trusted clock can retire the source synchronously. Never run SQL or
      // return a newly bound reader after that retirement.
      active();
    };
    const currentPlatform = async (lease: PostgresReadSnapshot, evidence: PlatformMembershipEvidence) => {
      await assertPostgresPlatformMembershipSnapshot(lease.client, owner, evidence, clock);
      active();
    };
    /* The support fence, as on SQLite: the support row with its parent, the
       platform anchor and the dealer, on this snapshot's own client — and
       without row locks, which `BEGIN READ ONLY` refuses. The snapshot is one
       consistent state, so the unlocked reads see the same rows a locked pass
       would; a revocation landing afterwards is caught by the revalidation the
       bound reader runs before its next operation. */
    const currentSupport = async (lease: PostgresReadSnapshot, evidence: SupportMembershipEvidence) => {
      const instant = clock();
      assertSupportEvidenceObserved(
        await observePostgresSupportMembership(
          lease.client,
          owner,
          { supportId: evidence.supportId, accountId: evidence.accountId, tenantId: evidence.tenantId, at: instant },
          false,
        ),
        evidence,
        instant,
      );
      active();
    };
    /* A visitor's placement on this snapshot, as on SQLite: the address by
       the policy's column, then both anchors, each unlocked in one state. */
    const resolvePublicIn = async (lease: PostgresReadSnapshot, lookup: TenantPublicLookup): Promise<TenantPublicResolution | null> => {
      const value = capturePublicLookup(lookup, owner),
        sql = intakeAddressQuery(owned, value.column);
      const tenantId =
        value.address === null ? (value.tenant as string) : publicTenantOf((await lease.client.query(sql, [value.address])).rows);
      if (tenantId === undefined) return null;
      const anchors = new Map<string, string | null>();
      for (const id of [PLATFORM_TENANT_ID, tenantId]) anchors.set(id, await readPostgresIntakeAnchor(lease.client, owner, id));
      return publicResolution(tenantId, (id) => anchors.get(id) ?? null);
    };
    const currentPublic = async (lease: PostgresReadSnapshot, evidence: TenantPublicEvidence) => {
      const value = capturePublicEvidence(evidence, owned);
      const resolved = await resolvePublicIn(lease, publicLookupOf(value));
      assertPublicResolved(value, resolved, clock());
      active();
    };
    // One compiled reader per admitted scope, tenant or platform. Each call
    // executes on the snapshot its own invocation leased, after revalidating
    // there the principal it was bound for.
    const scoped = (scope: RowScope) => {
      const physicalScope = Object.fromEntries(Object.entries(scope).map(([id, rule]) => [toPhysical(id), rule]));
      return (lease: PostgresReadSnapshot) =>
        mapAppScopedReads(
          createScopedReads(physicalSchema, physicalScope, style, async (sql, hint) => lease.execute(sql, hint)),
          { schema: owned.schema, toPhysical, toLogical },
        );
    };
    const bind = (scope: RowScope, revalidate: (lease: PostgresReadSnapshot) => Promise<void>): ScopedReads => {
      const reads = scoped(scope);
      const run = <A extends unknown[], R>(args: A, work: (bound: ScopedReads, ...args: A) => Promise<R>) =>
        invoke(args, async (capturedArgs, next) => {
          await revalidate(next);
          return work(reads(next), ...capturedArgs);
        });
      return Object.freeze({
        query: (request) => run([request] as [typeof request], (bound, value) => bound.query(value)),
        count: (table, filter, limit) =>
          run([table, filter, limit] as [typeof table, typeof filter, typeof limit], (bound, id, value, boundLimit) =>
            bound.count(id, value, boundLimit),
          ),
        runView: (view, offset) =>
          run([view, offset] as [typeof view, typeof offset], (bound, value, boundOffset) => bound.runView(value, boundOffset)),
        // The bound reaches the statement: never counted past it.
        countView: (view, limit) =>
          run([view, limit] as [typeof view, typeof limit], (bound, value, boundLimit) => bound.countView(value, boundLimit)),
        runBreakdown: (breakdown, offset) =>
          run([breakdown, offset] as [typeof breakdown, typeof offset], (bound, value, boundOffset) =>
            bound.runBreakdown(value, boundOffset),
          ),
        countBreakdown: (breakdown, limit) =>
          run([breakdown, limit] as [typeof breakdown, typeof limit], (bound, value, boundLimit) =>
            bound.countBreakdown(value, boundLimit),
          ),
      } satisfies ScopedReads);
    };
    /* A batch is one leased snapshot, revalidated once, its reads on that lease. */
    const batch = <C, T>(
      input: C,
      open: (captured: C, lease: PostgresReadSnapshot) => Promise<RowScope>,
      work: (reads: ScopedReads) => T | Promise<T>,
    ): Promise<T> => {
      if (typeof work !== 'function') return Promise.reject(new TenantContextError());
      let own: { error: unknown } | undefined;
      return invoke(input, async (captured, lease) =>
        readBatch(scoped(await open(captured, lease))(lease), active, work, (error) => {
          own = { error };
        }),
      ).catch((error: unknown) => {
        throw own ? own.error : error;
      });
    };
    // Arguments captured now, as `invoke` captures them; no snapshot is leased.
    const bindLater = <A>(input: A, make: (captured: A) => ScopedReads): Promise<ScopedReads> => {
      try {
        active();
        return Promise.resolve(make(captureTenantData(input)));
      } catch {
        return Promise.reject(new TenantContextError());
      }
    };
    const source: TenantReadSource = Object.freeze({
      ownership: owned,
      readMembership: (lookup: TenantMembershipLookup) =>
        invoke(lookup, (query, lease) => readPostgresTenantMembership(lease.client, owner, query)),
      readMemberships: (lookup: TenantMembershipListLookup) =>
        invoke(lookup, (query, lease) => readPostgresTenantMemberships(lease.client, owner, query, clock)),
      assertCurrent: (evidence: TenantMembershipEvidence) => invoke(evidence, (value, lease) => current(lease, value)),
      scopeReads: (evidence: TenantMembershipEvidence, rows: RowScope) =>
        invoke({ evidence, rows }, async (captured, lease) => {
          await current(lease, captured.evidence);
          return bind(composeTenantReadScope(owned, captured.evidence, captured.rows, allTrue), (next) => current(next, captured.evidence));
        }),
      bindReads: (evidence: TenantMembershipEvidence, rows: RowScope) =>
        bindLater({ evidence, rows }, (captured) =>
          bind(composeTenantReadScope(owned, captured.evidence, captured.rows, allTrue), (next) => current(next, captured.evidence)),
        ),
      withReads: <T>(evidence: TenantMembershipEvidence, rows: RowScope, work: (reads: ScopedReads) => T | Promise<T>) =>
        batch(
          { evidence, rows },
          async (captured, lease) => {
            await current(lease, captured.evidence);
            return composeTenantReadScope(owned, captured.evidence, captured.rows, allTrue);
          },
          work,
        ),
      readPlatformMembership: (lookup: PlatformMembershipLookup) =>
        invoke(lookup, (query, lease) => readPostgresPlatformMembership(lease.client, owner, query)),
      assertPlatformCurrent: (evidence: PlatformMembershipEvidence) => invoke(evidence, (value, lease) => currentPlatform(lease, value)),
      // The source recomposes the platform scope itself, as on SQLite.
      scopePlatformReads: (evidence: PlatformMembershipEvidence, rows: RowScope) =>
        invoke({ evidence, rows }, async (captured, lease) => {
          await currentPlatform(lease, captured.evidence);
          return bind(composePlatformReadScope(owned, captured.evidence, captured.rows), (next) =>
            currentPlatform(next, captured.evidence),
          );
        }),
      bindPlatformReads: (evidence: PlatformMembershipEvidence, rows: RowScope) =>
        bindLater({ evidence, rows }, (captured) =>
          bind(composePlatformReadScope(owned, captured.evidence, captured.rows), (next) => currentPlatform(next, captured.evidence)),
        ),
      withPlatformReads: <T>(evidence: PlatformMembershipEvidence, rows: RowScope, work: (reads: ScopedReads) => T | Promise<T>) =>
        batch(
          { evidence, rows },
          async (captured, lease) => {
            await currentPlatform(lease, captured.evidence);
            return composePlatformReadScope(owned, captured.evidence, captured.rows);
          },
          work,
        ),
      assertSupportCurrent: (evidence: SupportMembershipEvidence) => invoke(evidence, (value, lease) => currentSupport(lease, value)),
      /* The dealer's scope, composed by the same rule its own members get, on a
         member view of the support evidence — one rule, so a second cannot
         disagree and quietly widen what a session reads. Fenced on the support
         row, as on SQLite. */
      scopeSupportReads: (evidence: SupportMembershipEvidence, rows: RowScope) =>
        invoke({ evidence, rows }, async (captured, lease) => {
          await currentSupport(lease, captured.evidence);
          return bind(composeTenantReadScope(owned, supportAsMember(captured.evidence), captured.rows, allTrue), (next) =>
            currentSupport(next, captured.evidence),
          );
        }),
      resolvePublic: (lookup: TenantPublicLookup) => invoke(lookup, (value, lease) => resolvePublicIn(lease, value)),
      assertPublicCurrent: (evidence: TenantPublicEvidence) => invoke(evidence, (value, lease) => currentPublic(lease, value)),
      // The source recomposes the visitor's scope itself, as on SQLite.
      bindPublicReads: (evidence: TenantPublicEvidence, rows: RowScope) =>
        bindLater({ evidence, rows }, (captured) =>
          bind(composePublicReadScope(owned, captured.evidence, captured.rows), (next) => currentPublic(next, captured.evidence)),
        ),
      resolveIntake: (lookup: TenantIntakeLookup) =>
        invoke(lookup, async (query, lease) => {
          const value = captureIntakeLookup(query, owner),
            sql = intakeAddressQuery(owned, value.column);
          const tenantId = value.address === null ? undefined : intakeTenantOf((await lease.client.query(sql, [value.address])).rows);
          const anchors = new Map<string, string | null>();
          for (const id of [...(tenantId === undefined ? [] : [tenantId]), PLATFORM_TENANT_ID]) {
            anchors.set(id, await readPostgresIntakeAnchor(lease.client, owner, id));
          }
          return intakeResolution(tenantId, (id) => anchors.get(id) ?? null);
        }),
      readTenantNames: (lookup: TenantNamesLookup) =>
        invoke(lookup, async (query, lease) => {
          const asked = namesLookup(owned, query);
          if (!asked) return Object.freeze({});
          const { rows } = await lease.client.query(tenantNamesQuery(owned, asked.plan, asked.tenants.length), [asked.tenants]);
          return tenantNamesOf(asked.plan, rows, asked.tenants);
        }),
      readTenantAddresses: (lookup: TenantAddressesLookup) =>
        invoke(lookup, async (query, lease) => {
          const { tenantId, columns } = captureAddressesLookup(owned, query);
          const found: Record<string, string> = {};
          for (const [kind, column] of Object.entries(columns)) {
            if (column === undefined) continue;
            const address = heldAddress((await lease.client.query(tenantAddressQuery(owned, column), [tenantId])).rows);
            const own =
              address && tenantOwnAddress(tenantId, address, (await lease.client.query(intakeAddressQuery(owned, column), [address])).rows);
            if (own) found[kind] = own;
          }
          return Object.freeze(found) as TenantAddresses;
        }),
      readServiceAnchors: (tenantId: string | null) =>
        invoke(tenantId, async (id, lease) =>
          Object.freeze({
            tenantVersion: id === null ? null : await readPostgresIntakeAnchor(lease.client, owner, parseTenantSelector([id])),
            platformVersion: await readPostgresIntakeAnchor(lease.client, owner, PLATFORM_TENANT_ID),
          }),
        ),
      readActiveTenants: () => invoke(null, (_none, lease) => readPostgresActiveTenants(lease.client, owner)),
      readSandboxClocks: () =>
        invoke(null, async (_none, lease) => {
          const rows = postgresSandboxSession(lease.client);
          return (await sandboxStorePresent(rows)) ? sandboxRows(rows, owner.appId).clocks() : Object.freeze([]);
        }),
      readSandboxes: (tenants: readonly string[]) =>
        invoke(sandboxLookup(tenants), async (asked, lease) => {
          const rows = postgresSandboxSession(lease.client);
          return (await sandboxStorePresent(rows)) ? sandboxRows(rows, owner.appId).among(asked) : new Set<string>();
        }),
      readDueTimers: (query: DueTimersQuery) =>
        invoke(query, async (value, lease) => {
          const plan = dueTimersPlan(owned, value);
          const active = plan.tenants ? await readPostgresActiveTenants(lease.client, owner) : [];
          if (plan.tenants && !active.length) return Object.freeze([]);
          return plan.decode((await lease.client.query(plan.sql, plan.params(active))).rows);
        }),
      readRecordHistory: (query: RecordHistoryQuery) =>
        invoke(query, (value, lease) => {
          assertHistoryQuery(value);
          return readPostgresRecordHistory(lease.client, value);
        }),
      readRecordActivity: (query: RecordActivityQuery) =>
        invoke(query, (value, lease) => {
          assertActivityQuery(value);
          return readPostgresRecordActivity(lease.client, value);
        }),
      readInbox: (query: InboxQuery) =>
        invoke(query, (value, lease) => {
          assertInboxQuery(value);
          return readPostgresInbox(lease.client, value);
        }),
      readBranding: (query: BrandingQuery) =>
        invoke(query, (value, lease) => {
          assertBrandingQuery(value);
          return readPostgresBranding(lease.client, value);
        }),
      readBrandingLogo: (query: BrandingLogoQuery) =>
        invoke(query, (value, lease) => {
          assertBrandingLogoQuery(value);
          return readPostgresBrandingLogo(lease.client, value);
        }),
      close,
    });
    sources.add(source);
    registerTenantSourceIdentity(source, { ...owner, canonicalPath: locator });
    return source;
  } catch {
    try {
      await opened?.close();
    } catch {
      /* Construction never publishes its pool. */
    }
    return denyTenant();
  }
}
