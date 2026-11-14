// The SQLite tenant read source: one file, opened read-only beside the App's writer, answering the same interface as
// the PostgreSQL source (tenantReadSourceShared.ts) for development and the single-file deployments.
import { sandboxRows, sandboxStorePresent, sqliteSandboxSession } from './tenantSandboxStore.js';
import { realpathSync, statSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { ANSI_STYLE, Serial, type AggregateRequest, type ScopedReads } from '@mistriwork/engine/adapters/adapter.js';
import { createScopedReads } from '@mistriwork/engine/adapters/scoped/scopedReads.js';
import { schemaFingerprint, sqliteParams, toJsonSafe, withBytes } from '@mistriwork/engine/adapters/sqlite.js';
import { readSqliteReadCatalog } from '@mistriwork/engine/adapters/scoped/sqliteScopeCatalog.js';
import { mapScopeCatalog } from '@mistriwork/engine/shared/scopeCatalog.js';
import { snapshotRowScope, type RowScope } from '@mistriwork/engine/shared/rowScope.js';
import { mapAppScopedReads } from '../app/appResources.js';
import { captureTenantData, denyTenant, denyTenantFor, TenantContextError } from '@mistriwork/engine/server/evidence.js';
import { parseTenantSelector, type TenantMembershipEvidence, type TenantMembershipLookup } from './tenantMembership.js';
import { assertTenantOwnership, captureTenantOwnership, type TenantOwnershipSnapshot } from './tenantOwnership.js';
import type { PlatformMembershipEvidence, PlatformMembershipLookup } from './tenantPlatform.js';
import { assertServiceReadCurrent, captureServiceEvidence, composeServiceScope, type TenantServiceEvidence } from './tenantServiceModel.js';
import { AppAccessDenied } from '../app/appAccess.js';
import { composePlatformReadScope, composePublicReadScope, composeTenantReadScope, physicalRowScope } from './tenantReadScope.js';
import {
  assertPublicResolved,
  capturePublicEvidence,
  capturePublicLookup,
  intakeVisitor,
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
import { registerTenantSourceIdentity } from './tenantSourceIdentity.js';
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
  captureAddressesLookup,
  captureIntakeEvidence,
  captureIntakeLookup,
  captureIntakeTenantLookup,
  heldAddress,
  intakeAddressQuery,
  intakePlace,
  intakeTenantOf,
  tenantAddressQuery,
  tenantOwnAddress,
  type TenantAddresses,
  type TenantAddressesLookup,
  type TenantProfileLookup,
  captureProfileLookup,
  activeTenantsZone,
  activeWithColumn,
  heldProfile,
  type ActiveTenant,
  type ActiveTenantsQuery,
  tenantProfileColumnQuery,
  tenantProfileQuery,
  type TenantIntakeEvidence,
  type TenantIntakeLookup,
  type TenantIntakeTenantLookup,
} from './tenantIntakeModel.js';
import { PLATFORM_TENANT_ID } from './tenantPlatform.js';
import { findSqliteLink, readSqliteLink } from '../../adapters/commands/commandLinks.js';
import {
  assertLinkReadCurrent,
  assertLinkRowCurrent,
  captureLinkEvidence,
  captureLinkLookup,
  composeLinkScope,
  linkResolution,
  type TenantLinkEvidence,
  type TenantLinkLookup,
} from './tenantLinkModel.js';
import { readSqliteActiveTenants, readSqliteIntakeAnchor } from './tenantStore.js';
import { dueTimersPlan, type DueTimersQuery } from './tenantDueTimers.js';
import { tenantNamesOf, tenantNamesQuery } from './tenantNames.js';
import {
  assertActivityQuery,
  assertHistoryQuery,
  type RecordActivityQuery,
  type RecordHistoryQuery,
} from '../../adapters/history/recordHistory.js';
import { readSqliteRecordActivity, readSqliteRecordHistory } from '../../adapters/history/sqliteRecordHistory.js';
import { assertInboxQuery, type InboxQuery } from '../../adapters/inbox/inbox.js';

import {
  assertBrandingLogoQuery,
  assertBrandingQuery,
  type BrandingLogoQuery,
  type BrandingQuery,
} from '../../adapters/branding/branding.js';
import { readSqliteBranding, readSqliteBrandingLogo } from '../../adapters/branding/sqliteBranding.js';
import { readSqliteInbox, sqliteInboxMail } from '../../adapters/inbox/sqliteInbox.js';
import {
  type EmailSwitchQuery,
  assertEmailSwitchQuery,
  sandboxLookup,
  intakeResolution,
  intakeResolutionByTenant,
  type TenantNamesLookup,
  namesLookup,
  sources,
  refusedBefore,
  readBatch,
  type TenantReadSource,
} from './tenantReadSourceShared.js';

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
    // A snapshot, so every read's composition with it is kept (tenantReadScope.ts).
    const allTrue: RowScope = snapshotRowScope(owned.schema, Object.fromEntries([...logicalIds.keys()].map((id) => [id, true])));
    let definitions: Map<string, string> | undefined;
    const attestCatalog = () => {
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
    /* A field report measured a whole catalog scan inside every read. Any DDL
       on either schema moves its schema_version, so while the pair is the one
       the last full pass judged, nothing it judged can have changed: the scan
       is skipped. Read first, inside the read transaction, it names the
       snapshot the read sees. A refused pass records nothing, so it refuses
       again on every read until the schema moves back to a passing shape. */
    const fingerprint = schemaFingerprint(db);
    let attested: string | undefined;
    const assertCatalog = () => {
      const seen = fingerprint();
      if (seen === attested) return;
      attested = undefined;
      attestCatalog();
      attested = seen;
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
      if (closing) denyTenant('This tenant read source has closed.');
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
      } catch (error) {
        return refusedBefore(error);
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
    // A service's anchors as this snapshot finds them, against the versions its attempt read.
    const currentService = (evidence: TenantServiceEvidence) => {
      const found = {
        tenantVersion: readSqliteIntakeAnchor(db, owner, evidence.tenantId!),
        platformVersion: readSqliteIntakeAnchor(db, owner, PLATFORM_TENANT_ID),
      };
      const instant = now();
      active();
      assertServiceReadCurrent(evidence, found, instant);
      active();
    };
    // A link's anchors and its row as this snapshot finds them, against the versions its request read.
    const currentLink = (evidence: TenantLinkEvidence) => {
      const found = {
        tenantVersion: readSqliteIntakeAnchor(db, owner, evidence.tenantId),
        platformVersion: readSqliteIntakeAnchor(db, owner, PLATFORM_TENANT_ID),
      };
      const instant = now();
      active();
      assertLinkReadCurrent(evidence, found, instant);
      assertLinkRowCurrent(readSqliteLink(db, owner.appId, evidence.tenantId, evidence.linkId, instant), evidence);
      active();
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
      const physicalScope = physicalRowScope(scope, toPhysical);
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
        // Revalidated and bounded by the tenant's rows as `count` is.
        ...(reads.aggregate ? { aggregate: (request: AggregateRequest) => run([request], reads.aggregate!) } : {}),
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
      } catch (error) {
        return refusedBefore(error);
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
      /* One handle, read in turn: every snapshot is already this one connection's, so there is nothing to share. */
      together: async <T>(_evidence: TenantMembershipEvidence, work: () => Promise<T>): Promise<T> => {
        if (typeof work !== 'function') return Promise.reject(new TenantContextError());
        active();
        return work();
      },
      togetherFenced: async <T>(_evidence: TenantMembershipEvidence, work: () => Promise<T>): Promise<{ value: T; fenced: boolean }> => {
        if (typeof work !== 'function') return Promise.reject(new TenantContextError());
        active();
        return { value: await work(), fenced: false };
      },
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
      bindIntakeReads: (evidence: TenantIntakeEvidence, rows: RowScope) =>
        bindLater({ evidence, rows }, (captured) => {
          const value = captureIntakeEvidence(captured.evidence, owned);
          if (intakePlace(value) !== 'tenant') throw new AppAccessDenied();
          const visitor = intakeVisitor(value);
          return bind(composePublicReadScope(owned, visitor, captured.rows), () => currentPublic(visitor));
        }),
      // The source recomposes the service's scope itself, as it does a visitor's.
      bindServiceReads: (evidence: TenantServiceEvidence, rows: RowScope) =>
        bindLater({ evidence, rows }, (captured) => {
          const value = captureServiceEvidence(captured.evidence, owned);
          if (value.place !== 'tenant') throw new AppAccessDenied();
          return bind(composeServiceScope(owned, value, captured.rows), () => currentService(value));
        }),
      // The source recomposes the link's scope itself: its one record, never a caller's predicate.
      bindLinkReads: (evidence: TenantLinkEvidence, rows: RowScope) =>
        bindLater({ evidence, rows }, (captured) => {
          const value = captureLinkEvidence(captured.evidence, owned);
          return bind(composeLinkScope(owned, value, captured.rows), () => currentLink(value));
        }),
      resolveLink: (lookup: TenantLinkLookup) =>
        invoke(lookup, (query) => {
          const { id } = captureLinkLookup(query);
          let row;
          try {
            row = findSqliteLink(db, owner.appId, id, now());
          } catch {
            // A store no command has written to yet has no link table: no link, as any other miss.
            return null;
          }
          return linkResolution(row, (tenant) => readSqliteIntakeAnchor(db, owner, tenant));
        }),
      resolveIntake: (lookup: TenantIntakeLookup) =>
        invoke(lookup, (query) => {
          const value = captureIntakeLookup(query, owner),
            sql = intakeAddressQuery(owned, value.column);
          const tenantId = value.address === null ? undefined : intakeTenantOf(db.prepare(sql).all(value.address));
          return intakeResolution(tenantId, (id) => readSqliteIntakeAnchor(db, owner, id));
        }),
      resolveIntakeByTenant: (lookup: TenantIntakeTenantLookup) =>
        invoke(lookup, (query) => {
          const value = captureIntakeTenantLookup(query, owner);
          return intakeResolutionByTenant(value.tenantId, (id) => readSqliteIntakeAnchor(db, owner, id));
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
      readTenantProfile: (lookup: TenantProfileLookup) =>
        invoke(lookup, (query) => {
          const { tenantId, columns } = captureProfileLookup(owned, query);
          return heldProfile(owned, columns, db.prepare(tenantProfileQuery(owned, columns)).all(tenantId) as Record<string, unknown>[]);
        }),
      readServiceAnchors: (tenantId: string | null) =>
        invoke(tenantId, (id) =>
          Object.freeze({
            tenantVersion: id === null ? null : readSqliteIntakeAnchor(db, owner, parseTenantSelector([id])),
            platformVersion: readSqliteIntakeAnchor(db, owner, PLATFORM_TENANT_ID),
          }),
        ),
      readActiveTenants: (options?: ActiveTenantsQuery) =>
        invoke(options ?? {}, (query): readonly ActiveTenant[] => {
          const zone = activeTenantsZone(owned, query);
          const active = readSqliteActiveTenants(db, owner);
          if (zone === undefined) return Object.freeze(active.map((id) => Object.freeze({ id })));
          const rows = db.prepare(tenantProfileColumnQuery(owned, zone)).all() as Record<string, unknown>[];
          return activeWithColumn(owned, zone, active, rows);
        }),
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
      readEmailOff: (query: EmailSwitchQuery) =>
        invoke(query, (value) => {
          assertEmailSwitchQuery(value);
          return sqliteInboxMail(async (work) => work(db)).emailOff(value.app, value.recipient);
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
