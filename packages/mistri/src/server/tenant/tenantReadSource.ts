import { postgresSandboxSession, sandboxRows, sandboxStorePresent } from './tenantSandboxStore.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { TransactionOutcomeUnknown, type ScopedReads } from '@mistriwork/engine/adapters/adapter.js';
import type { PostgresAdapter, PostgresReadSnapshot } from '@mistriwork/engine/adapters/postgres.js';
import { tenantAdapter, tenantBackstop } from './tenantConnections.js';
import {
  MAX_REPLICAS,
  primaryReads,
  ReplicaSet,
  ReplicaUnavailable,
  replicaFailure,
  replicaReadWanted,
} from '@mistriwork/engine/adapters/replicas.js';
import { StatementStopped } from '@mistriwork/engine/adapters/statementControl.js';
import { createScopedReads } from '@mistriwork/engine/adapters/scoped/scopedReads.js';
import { assertScopeCatalog, captureScopeCatalog, isFixedScopeCatalog, mapScopeCatalog } from '@mistriwork/engine/shared/scopeCatalog.js';
import { isRowScopeSnapshot, snapshotRowScope, type RowScope } from '@mistriwork/engine/shared/rowScope.js';
import { mapAppScopedReads } from '../app/appResources.js';
import { captureTenantData, denyTenant, denyTenantFor, TenantContextError } from '@mistriwork/engine/server/evidence.js';
import { parseTenantSelector, type TenantMembershipEvidence, type TenantMembershipLookup } from './tenantMembership.js';
import { captureTenantOwnership, type TenantOwnershipSnapshot } from './tenantOwnership.js';
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
import { observePostgresSupportMembership } from './tenantSupportMembershipPostgres.js';
import { postgresTenantLocator, registerTenantSourceIdentity } from './tenantSourceIdentity.js';
import { type TenantMembershipListLookup, type TenantStoreBinding } from './tenantStore.js';
import {
  assertPostgresPlatformMembershipSnapshot,
  assertPostgresTenantMembershipRows,
  assertPostgresTenantMembershipSnapshot,
  assertPostgresTenantStore,
  attestedPostgresTenantStore,
  postgresTenantMembershipLookupRows,
  postgresPlatformMembershipRows,
  postgresPlatformMembershipStatement,
  postgresTenantMembershipLookupStatement,
  postgresTenantMembershipsRows,
  postgresTenantMembershipsStatement,
  postgresTenantMembershipStatement,
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
import { suspectsStores } from '@mistriwork/engine/adapters/postgresTransactionHandle.js';
import {
  captureAddressesLookup,
  captureIntakeEvidence,
  captureIntakeLookup,
  captureIntakeTenantLookup,
  heldAddress,
  intakeAddressQuery,
  intakePlace,
  intakeTenantOf,
  tenantOwnAddress,
  tenantOwnAddressQuery,
  ownAddressResolution,
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
import type { TenantValue } from '@mistriwork/engine/shared/queryOperands.js';
import type { AppDef } from '../../shared/app.js';
import { PLATFORM_TENANT_ID } from './tenantPlatform.js';
import { findPostgresLink, readPostgresLink } from '../../adapters/commands/commandLinks.js';
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
import { dueTimersPlan, type DueTimersQuery } from './tenantDueTimers.js';
import { tenantNamesOf, tenantNamesQuery } from './tenantNames.js';
import { readPostgresActiveTenants, readPostgresIntakeAnchor } from './tenantStorePostgres.js';
import {
  assertActivityQuery,
  assertHistoryQuery,
  type RecordActivityQuery,
  type RecordHistoryQuery,
} from '../../adapters/history/recordHistory.js';
import { readPostgresRecordActivity, readPostgresRecordHistory } from '../../adapters/history/postgresRecordHistory.js';
import { assertInboxQuery, type InboxQuery } from '../../adapters/inbox/inbox.js';

import {
  assertBrandingLogoQuery,
  assertBrandingQuery,
  type BrandingLogoQuery,
  type BrandingQuery,
} from '../../adapters/branding/branding.js';
import { readPostgresBranding, readPostgresBrandingLogo } from '../../adapters/branding/postgresBranding.js';
import { postgresInboxMail, readPostgresInbox } from '../../adapters/inbox/postgresInbox.js';
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
export { advisoryRecords, captureTenantReadSource, type TenantReadSource } from './tenantReadSourceShared.js';
export { openSqliteTenantReadSource } from './tenantReadSourceSqlite.js';

/* A whole snapshot begun under an attestation another has replaced since: asked again with the catalog attested. */
const MOVED: unique symbol = Symbol('moved');
/* A snapshot's route for what crosses tenants by design (openPostgresTenantReadSource's `snapshot`). */
const OWNER: unique symbol = Symbol('owner');
/* Where a PostgreSQL snapshot reads: for a tenant, for none (`null`), or as the owner. */
type Route = string | null | typeof OWNER;
/** A read snapshot as the PostgreSQL source hands it to its work: begun, where `fenced` says so, with
 * this evidence's membership read in the message that began it, its rows still on their way. */
type Snapshot = PostgresReadSnapshot & {
  readonly fenced?: Readonly<{ evidence: TenantMembershipEvidence; rows: Promise<readonly Record<string, unknown>[]>; ahead: boolean }>;
  /** The rows of the statement the snapshot was begun with (`on`'s `lead`), read once its catalog had stood. */
  readonly lead?: readonly Record<string, unknown>[];
  /** For a fenced snapshot asked ahead: the reader itself, for a reserved store's read (the inbox's), sent at once
   * behind the BEGIN still in flight and answered only once the catalog has stood. `client` waits to send. */
  readonly behind?: PgQuery;
  /** The reserved stores attested on this snapshot's database under the catalog attestation it began on, where one
   * stood (`on`): absent otherwise, and every store read attests in full. */
  readonly stores?: StoreLedger;
};
interface StoreLedger {
  has(store: string): boolean;
  keep(store: string): void;
  forget(): void;
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
    /* Its readers pipeline: a snapshot's BEGIN, its membership and its read
       leave in one flight (`on`, below), where each was a round trip. */
    const reader = (opened = tenantAdapter(url, 'Private tenant reader'));
    const physicalIds = new Map(Object.entries(owned.resources).map(([logical, physical]) => [physical, logical]));
    const logicalIds = new Map(Object.entries(owned.resources));
    const toPhysical = (id: string): string => logicalIds.get(id) ?? denyTenant();
    const toLogical = (id: string): string => physicalIds.get(id) ?? denyTenant();
    const physicalSchema = mapScopeCatalog(owned.physicalSchema, new Map([...physicalIds.keys()].map((id) => [id, id])));
    // A snapshot, so every read's composition with it is kept (tenantReadScope.ts).
    const allTrue: RowScope = snapshotRowScope(owned.schema, Object.fromEntries([...logicalIds.keys()].map((id) => [id, true])));
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
    type Target = { readonly url: string; reader: PostgresAdapter; attested?: string; checked?: number; readonly owner?: true };
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
    /* Under the backstop the description attests the pinned policy too, on every pool, the owner's included: what
       the runtime role is held to is the database's to say wherever it is read from. */
    const backstop = tenantBackstop(url);
    const security = backstop ? { rowSecurity: { role: backstop.role } } : {};
    const standbys = new ReplicaSet<Target>(
      replicas.map((replica) => ({
        url: replica,
        reader: tenantAdapter(replica, 'Private tenant replica reader', true),
      })),
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
        const described = await attestPostgresTenantRelations(snapshot.client, owned, security);
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
      false,
      false,
      null,
    );
    // Asked once, at construction: row scopes inline on Postgres 12 and later (rowScope.ts).
    const style = await reader.scopeStyle();
    /* What crosses tenants by design — a public address resolved, the jobs' sweep, every tenant's names — reads on
       the owner's pool under the backstop, which the policy does not bind; on the primary alone, as a write's fence
       does. Attested in full on its first snapshot, as a renewed pool is. Opened once construction has stood. */
    const ownerTarget: Target | undefined = backstop
      ? { url, reader: tenantAdapter(url, 'Private tenant owner reader', false, 'owner'), owner: true }
      : undefined;

    let closing = false;
    let closed: Promise<void> | undefined;
    const pending = new Set<Promise<void>>();
    const active = () => {
      if (closing) denyTenant('This tenant read source has closed.');
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
            await ownerTarget?.reader.close();
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
       read, stream, job and mail pass refused until a restart. Now the reader
       is replaced, as the writer reopens after an uncertain write
       (tenantWriterLifecycle.ts): a fresh adapter at the same URL, on the
       database's shared pool (tenantConnections.ts) — the lost connection was
       destroyed, not given back — its catalog attested in full again against
       the baseline the source opened with, and the old adapter closed once the
       snapshots still on it settle — closing it under them would turn their
       wait for a connection into a refusal too. A read-only transaction has no outcome to
       reconcile; what stays refused is the request that lost its answer. */
    const lent = new Map<PostgresAdapter, number>();
    const retired = new Set<PostgresAdapter>();
    const renew = (target: Target, failed: PostgresAdapter) => {
      if (closing || target.reader !== failed) return;
      target.reader = target.owner
        ? tenantAdapter(target.url, 'Private tenant owner reader', false, 'owner')
        : tenantAdapter(target.url, target === primary ? 'Private tenant reader' : 'Private tenant replica reader', target !== primary);
      target.attested = target.checked = undefined;
      if (lent.has(failed)) retired.add(failed);
      else void failed.close().catch(() => {});
    };
    /* A reserved store's layout — the inbox's, the record history's — attested the first time this source reads it
       and not again, as the adapter keeps its own (attestedStore, postgres.ts): described in full on every read, it
       was three round trips of the five each inbox read took (a field deployment's bell asked two on every page). A
       statement that fails the way a moved store fails one forgets them all, and the next read attests in full. */
    /* Kept per pool — the primary's and each replica's, and a renewed pool starts with none — and under the catalog
       fingerprint they were attested beside: the digest walks the runtime schema the stores live in, so a store
       whose layout changed, column names kept or not, moves it, and a replica that has not replayed a store's
       migration has a fingerprint of its own. Only a snapshot begun on a standing attestation reads with them. */
    const storeLedgers = new WeakMap<PostgresAdapter, { readonly fingerprint: string; readonly stores: Set<string> }>();
    const ledgerOf = (target: Target, pool: PostgresAdapter, fingerprint: string): StoreLedger =>
      Object.freeze({
        has: (store: string) => {
          const kept = storeLedgers.get(pool);
          return target.reader === pool && target.attested === fingerprint && kept?.fingerprint === fingerprint && kept.stores.has(store);
        },
        keep: (store: string) => {
          if (target.reader !== pool || target.attested !== fingerprint) return;
          let kept = storeLedgers.get(pool);
          if (kept?.fingerprint !== fingerprint) storeLedgers.set(pool, (kept = { fingerprint, stores: new Set() }));
          kept.stores.add(store);
        },
        forget: () => void storeLedgers.delete(pool),
      });
    const attestedStore = async <T>(lease: Snapshot, store: string, read: (attested: boolean) => Promise<T>): Promise<T> => {
      const ledger = lease.stores;
      const attested = ledger?.has(store) === true;
      try {
        const result = await read(attested);
        if (!attested) ledger?.keep(store);
        return result;
      } catch (error) {
        if (suspectsStores(error)) ledger?.forget();
        throw error;
      }
    };
    const on = async <T>(
      target: Target,
      work: (snapshot: Snapshot) => Promise<T>,
      fence?: TenantMembershipEvidence,
      lead?: string,
      /* The fence's membership is the snapshot's whole question (assertCurrent): nothing else is read on it. */
      alone = false,
      /* What the row policy reads under the backstop (tenantConnections.ts): the tenant this snapshot is for, `null`
         where it reads no tenant's rows. Without a backstop nothing is sent for it. */
      tenant?: string | null,
    ): Promise<T> => {
      const pool = target.reader;
      const standing = trusted(target);
      /* Where the snapshot is a member's read, its membership rides in the
         message that begins it, after the LOCK (and the digest, where the
         attestation is due again), and the snapshot is handed over with that
         message still in flight (`ahead`), so the read the member asked
         leaves behind it: BEGIN, membership and read are one round trip
         where they were three. All of it is one snapshot, so the order they
         are read in changes nothing they say; and nothing is released before
         the BEGIN's answer has said the catalog stands — attested in full
         first, where its digest moved — and the membership holds (`current`,
         `bind`). */
      const membership = fence === undefined ? undefined : postgresTenantMembershipStatement(owner, fence);
      lent.set(pool, (lent.get(pool) ?? 0) + 1);
      try {
        /* A membership that is the snapshot's whole question — an admission's, a release fence's — on an attestation
           that stands: BEGIN, the LOCK, the membership and the COMMIT in one message (readSnapshot `whole`), one
           round trip where they were two. Its rows reach the work only once the BEGIN's answer has said the LOCK
           was taken under the attestation it was asked on; another snapshot that attested a moved catalog since
           has it asked again as below, where the catalog is attested in full first. */
        const question = membership !== undefined ? (alone ? membership : undefined) : lead;
        if (question !== undefined && standing !== undefined) {
          const answered = await pool.readSnapshot(
            async (lease): Promise<T | typeof MOVED> => {
              if (lease.prologue?.length !== 2) return denyTenant();
              if (target.attested !== standing) return MOVED;
              const rows = lease.prologue[1]!.rows;
              const result = await work(
                Object.freeze({
                  client: lease.client,
                  describe: lease.describe,
                  execute: lease.execute,
                  ...(membership !== undefined
                    ? { fenced: Object.freeze({ evidence: fence!, rows: Promise.resolve(rows), ahead: true }) }
                    : { lead: rows }),
                }),
              );
              active();
              return result;
            },
            false,
            `${pin}; ${question}`,
            false,
            true,
            tenant,
          );
          if (answered !== MOVED) return answered;
        }
        if (membership !== undefined)
          return await pool.readSnapshot(
            async (lease) => {
              const opened = lease.opened!.then(async (results) => {
                const begun = standing === undefined ? 2 : 1;
                if (results.length !== begun + 1) return denyTenant();
                const store = await assertCatalog(
                  Object.freeze({
                    client: lease.client,
                    prologue: results.slice(0, begun),
                    describe: lease.describe,
                    execute: lease.execute,
                  }),
                  target,
                  standing,
                  pool,
                );
                return { store, rows: results[begun]!.rows };
              });
              void opened.catch(() => {});
              const client: PgQuery = Object.freeze({
                query: ((...args: unknown[]) =>
                  opened.then(({ store }) => (store.query as (...values: unknown[]) => unknown)(...args))) as PgQuery['query'],
              });
              const result = await work(
                Object.freeze({
                  client,
                  describe: lease.describe,
                  execute: lease.execute,
                  ...(lease.finish ? { finish: lease.finish } : {}),
                  ...(standing === undefined
                    ? {}
                    : {
                        stores: ledgerOf(target, pool, standing),
                        behind: Object.freeze({
                          query: ((...args: unknown[]) => {
                            const sent = (lease.client.query as (...values: unknown[]) => Promise<unknown>)(...args);
                            void sent.catch(() => {});
                            return opened.then(() => sent);
                          }) as PgQuery['query'],
                        }),
                      }),
                  /* The read goes ahead only on an attestation that stands: one that is due may find the
                     catalog moved, and is made before anything is read that a moved catalog could fail. */
                  fenced: Object.freeze({ evidence: fence!, rows: opened.then(({ rows }) => rows), ahead: standing !== undefined }),
                }),
              );
              active();
              return result;
            },
            false,
            `${standing === undefined ? prologue : pin}; ${membership}`,
            true,
            false,
            tenant,
          );
        /* A membership read that is the snapshot's whole reason (discovery's, an admission's) rides in the message
           that begins it, as a member's fence does above: one round trip where BEGIN and the read were two. Its rows
           reach the work only once the catalog — and the store with it — has stood. */
        if (lead !== undefined) {
          if (fence !== undefined) return denyTenant();
          return await pool.readSnapshot(
            async (lease) => {
              const begun = standing === undefined ? 2 : 1;
              if (lease.prologue?.length !== begun + 1) return denyTenant();
              const store = await assertCatalog(
                Object.freeze({ ...lease, prologue: lease.prologue.slice(0, begun) }),
                target,
                standing,
                pool,
              );
              const rows = lease.prologue[begun]!.rows;
              const result = await work(
                Object.freeze({
                  client: store,
                  describe: lease.describe,
                  execute: lease.execute,
                  lead: rows,
                  ...(standing === undefined ? {} : { stores: ledgerOf(target, pool, standing) }),
                }),
              );
              active();
              return result;
            },
            false,
            `${standing === undefined ? prologue : pin}; ${lead}`,
            false,
            false,
            tenant,
          );
        }
        /* Any other snapshot on an attestation that stands is handed over with its BEGIN in flight (`ahead`), as a
           member's is: its first statements leave behind it, one round trip where BEGIN and they were two, and no
           answer reaches the work before the BEGIN's has said the catalog stands. A tenant's names and addresses,
           asked as a member enters, are such snapshots. */
        if (standing !== undefined)
          return await pool.readSnapshot(
            async (lease) => {
              const opened = lease.opened!.then((results) =>
                assertCatalog(
                  Object.freeze({ client: lease.client, prologue: results, describe: lease.describe, execute: lease.execute }),
                  target,
                  standing,
                  pool,
                ),
              );
              void opened.catch(() => {});
              const held = <R>(sent: Promise<R>): Promise<R> => {
                void sent.catch(() => {});
                return opened.then(() => sent);
              };
              const result = await work(
                Object.freeze({
                  client: attestedPostgresTenantStore(
                    Object.freeze({
                      query: ((...args: unknown[]) =>
                        held((lease.client.query as (...values: unknown[]) => Promise<unknown>)(...args))) as PgQuery['query'],
                    }),
                  ),
                  describe: lease.describe,
                  execute: ((...args: unknown[]) =>
                    held((lease.execute as (...values: unknown[]) => Promise<unknown>)(...args))) as Snapshot['execute'],
                  stores: ledgerOf(target, pool, standing),
                }),
              );
              await opened;
              active();
              return result;
            },
            false,
            pin,
            true,
            false,
            tenant,
          );
        return await pool.readSnapshot(
          async (lease) => {
            const store = await assertCatalog(lease, target, standing, pool);
            const result = await work(Object.freeze({ client: store, describe: lease.describe, execute: lease.execute }));
            active();
            return result;
          },
          false,
          prologue,
          false,
          false,
          tenant,
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
    const onReplica = async <T>(
      target: Target,
      work: (snapshot: Snapshot) => Promise<T>,
      fence?: TenantMembershipEvidence,
      lead?: string,
      alone = false,
      tenant?: string | null,
    ): Promise<T> => {
      try {
        return await on(target, work, fence, lead, alone, tenant);
      } catch (error) {
        if (error instanceof StatementStopped) throw error;
        // Uncertain, as the primary's can be: `on` replaced that pool, not the source.
        if (error instanceof TransactionOutcomeUnknown)
          throw new ReplicaUnavailable('down', 'The replica reader is uncertain.', { cause: error });
        throw new ReplicaUnavailable(replicaFailure(error) ?? 'retry', 'The replica could not answer this read.', { cause: error });
      }
    };
    /* `route`: the tenant the snapshot reads for, `null` for none, or OWNER for what crosses tenants by design, which
       under the backstop reads on the owner's pool, on the primary alone (tenantConnections.ts). Without a backstop
       OWNER is today's read with no tenant, and no tenant is ever sent. */
    const snapshot = async <T>(
      work: (snapshot: Snapshot) => Promise<T>,
      fence?: TenantMembershipEvidence,
      lead?: string,
      alone = false,
      route?: Route,
    ): Promise<T> => {
      active();
      if (route === OWNER && ownerTarget) return on(ownerTarget, work, fence, lead, alone, null);
      const tenant = route === OWNER ? null : route;
      return standbys.read(
        (target) => onReplica(target, work, fence, lead, alone, tenant),
        () => on(primary, work, fence, lead, alone, tenant),
      );
    };
    /* `fence`: the member evidence the work revalidates first (`current`), so the snapshot may read it as it begins. */
    const invoke = <A, R>(
      input: A,
      work: (captured: A, lease: Snapshot) => R | Promise<R>,
      fence?: (captured: A) => TenantMembershipEvidence,
      /* The statement the snapshot begins with, its rows the work's `lease.lead` (`on`). */
      lead?: (captured: A) => string,
      /* The fence's membership is all the work reads (`on`'s `alone`). */
      alone = false,
      /* Where the snapshot reads (`snapshot`'s `route`). Left out, a backstop's adapter refuses before anything is sent. */
      route?: (captured: A) => Route,
    ): Promise<R> => {
      let value: A;
      try {
        active();
        value = captureTenantData(input);
      } catch (error) {
        return refusedBefore(error);
      }
      let finish!: () => void;
      const held = new Promise<void>((resolve) => {
        finish = resolve;
      });
      pending.add(held);
      return (async () => {
        try {
          const result = await snapshot(async (lease) => work(value, lease), fence?.(value), lead?.(value), alone, route?.(value));
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
    const current = async (lease: Snapshot, evidence: TenantMembershipEvidence) => {
      /* Read as the snapshot began, where it was begun for this evidence; asked in its turn otherwise. */
      if (lease.fenced?.evidence === evidence) assertPostgresTenantMembershipRows(owner, evidence, await lease.fenced.rows, clock);
      else await assertPostgresTenantMembershipSnapshot(lease.client, owner, evidence, clock);
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
    const currentService = async (lease: PostgresReadSnapshot, evidence: TenantServiceEvidence) => {
      const found = {
        tenantVersion: await readPostgresIntakeAnchor(lease.client, owner, evidence.tenantId!),
        platformVersion: await readPostgresIntakeAnchor(lease.client, owner, PLATFORM_TENANT_ID),
      };
      assertServiceReadCurrent(evidence, found, clock());
      active();
    };
    const currentLink = async (lease: PostgresReadSnapshot, evidence: TenantLinkEvidence) => {
      const found = {
        tenantVersion: await readPostgresIntakeAnchor(lease.client, owner, evidence.tenantId),
        platformVersion: await readPostgresIntakeAnchor(lease.client, owner, PLATFORM_TENANT_ID),
      };
      const instant = clock();
      assertLinkReadCurrent(evidence, found, instant);
      assertLinkRowCurrent(await readPostgresLink(lease.client, owner.appId, evidence.tenantId, evidence.linkId, instant), evidence);
      active();
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
    /* The physical scope each composed scope maps to. A composition is a snapshot, kept by the scope and the
       evidence it was composed from (tenantReadScope.ts), so the same request shape hands the same object back;
       a snapshot cannot change, and the mapping reads nothing else that can, so its mapped twin is kept with it.
       Anything else is mapped and checked afresh, as before. */
    const physicalScopes = new WeakMap<RowScope, RowScope>();
    const scoped = (scope: RowScope) => {
      /* Checked once here against the physical catalog, so the reader bound for each operation, and each of its
         statements, finds it checked (rowScope.ts) rather than copying it again. */
      let physicalScope = physicalScopes.get(scope);
      if (!physicalScope) {
        physicalScope = snapshotRowScope(physicalSchema, physicalRowScope(scope, toPhysical));
        if (isRowScopeSnapshot(scope) && isFixedScopeCatalog(physicalSchema)) physicalScopes.set(scope, physicalScope);
      }
      return (lease: PostgresReadSnapshot) =>
        mapAppScopedReads(
          createScopedReads(physicalSchema, physicalScope, style, async (sql, hint) => lease.execute(sql, hint)),
          { schema: owned.schema, toPhysical, toLogical },
        );
    };
    /* The snapshot `together` shares, for the evidence it was asked under: opened by the first read, held while its
       work runs. Reads find it by the async context they were asked in, never by an argument, so nothing a request
       says can point a read at another's snapshot; and only a read bound for the very same evidence joins it. */
    interface Shared {
      readonly evidence: TenantMembershipEvidence;
      readonly key: string;
      open: boolean;
      lease?: Promise<Snapshot>;
      readonly running: Set<Promise<unknown>>;
      /* Resolved once `together` has ended: the snapshot is let go then. */
      readonly ended: Promise<void>;
      /* `togetherFenced`'s: the release fence rides the message that ends the snapshot, once `ended` resolved. */
      fence: boolean;
      /* Settled once the snapshot is let go: whether the release fence rode its end, and held. */
      closed?: Promise<boolean>;
    }
    const sharing = new AsyncLocalStorage<Shared>();
    /* The release fence in the message that ends the shared snapshot (PostgresReadSnapshot.finish): its COMMIT, then
       the LOCK and the membership in a fresh snapshot of their own, as assertCurrent begins one, after every read on
       this one has settled. Only on an attestation that stands, as a whole snapshot is (`on`), and heard as one: a
       membership that no longer holds refuses here. Where it cannot ride, the snapshot ends with a bare COMMIT and
       the caller fences as before. */
    const releaseFence = async (lease: Snapshot, evidence: TenantMembershipEvidence): Promise<boolean> => {
      const standing = trusted(primary);
      if (standing === undefined || primary.attested !== standing || !lease.finish) return false;
      const answers = await lease.finish(`${pin}; ${postgresTenantMembershipStatement(owner, evidence)}`);
      if (answers.length !== 2) return denyTenant();
      if (primary.attested !== standing) return false;
      assertPostgresTenantMembershipRows(owner, evidence, answers[1]!.rows, clock);
      active();
      return true;
    };
    /* The shared snapshot, on the primary: begun as any member's read begins (its membership in the BEGIN's flight
       where the attestation stands), proved once, and each read's rows held for that proof as `bind` holds them. */
    const openShared = (shared: Shared): Promise<Snapshot> =>
      new Promise<Snapshot>((resolve, reject) => {
        const held = primaryReads(() =>
          invoke(
            shared.evidence,
            async (evidence, lease): Promise<boolean> => {
              /* What the reads on it are handed: never the snapshot's end, which is its owner's. */
              const { finish: _finish, behind: _behind, ...readable } = lease;
              if (!lease.fenced?.ahead) {
                await current(lease, evidence);
                resolve(Object.freeze(readable));
                await shared.ended;
                return shared.fence && (await releaseFence(lease, evidence));
              }
              const proved = current(lease, evidence);
              void proved.catch(() => {});
              const gated = async <R>(asked: Promise<R>): Promise<R> => {
                const [read, membership] = await Promise.allSettled([asked, proved]);
                if (membership.status === 'rejected') throw membership.reason;
                if (read.status === 'rejected') throw read.reason;
                return read.value;
              };
              resolve(
                Object.freeze({
                  ...readable,
                  /* A store's read (the inbox's) asks the client: sent behind the BEGIN, and held for the proof as
                     every read is. */
                  client: Object.freeze({
                    query: ((...args: unknown[]) =>
                      gated(
                        ((lease.behind ?? lease.client).query as (...values: unknown[]) => Promise<unknown>)(...args),
                      )) as PgQuery['query'],
                  }),
                  execute: ((...args: unknown[]) =>
                    gated((lease.execute as (...values: unknown[]) => Promise<unknown>)(...args))) as Snapshot['execute'],
                }),
              );
              await shared.ended;
              await proved;
              return shared.fence && (await releaseFence(lease, evidence));
            },
            (evidence) => evidence,
            undefined,
            false,
            (evidence) => evidence.tenantId,
          ),
        );
        shared.closed = held;
        held.catch(reject);
      });
    /* One read on the shared snapshot: its arguments captured as `invoke` captures them, counted until it settles
       (the snapshot ends only after every read on it has), and its failure mapped as any snapshot's is. */
    const onShared = <A, R>(shared: Shared, input: A, work: (captured: A, lease: Snapshot) => Promise<R>): Promise<R> => {
      let value: A;
      try {
        active();
        value = captureTenantData(input);
      } catch (error) {
        return refusedBefore(error);
      }
      const operation = (async () => {
        try {
          const result = await work(value, await (shared.lease ??= openShared(shared)));
          active();
          return result;
        } catch (error) {
          if (schemaMoved(error)) primary.attested = primary.checked = undefined;
          return denyTenantFor(error);
        }
      })();
      const settled = operation.then(
        () => {},
        () => {},
      );
      shared.running.add(settled);
      void settled.then(() => shared.running.delete(settled));
      return operation;
    };
    /* A store's read the request's own context asks (its inbox: tenantHttp.ts names the lease's own): on the
       request's shared snapshot where one is open — its rows held for the membership that snapshot proves, as every
       read on it is — and on a snapshot of its own otherwise. It admits nobody either way; what it reads is named by
       the caller, and the snapshot it joins is only ever found in the async context the request itself began. */
    const inRequest = <A, R>(input: A, work: (captured: A, lease: Snapshot) => Promise<R>): Promise<R> => {
      const shared = sharing.getStore();
      if (shared?.open && !(standbys.pools.length && replicaReadWanted())) return onShared(shared, input, work);
      // A store's rows, which no policy binds: no tenant is needed to read them.
      return invoke(input, work, undefined, undefined, false, () => null);
    };
    const bind = (
      scope: RowScope,
      revalidate: (lease: Snapshot) => Promise<void>,
      fence: TenantMembershipEvidence | undefined,
      /* Where each of its snapshots reads (`snapshot`): the tenant its scope is for, or OWNER for the platform's. */
      route: Route,
    ): ScopedReads => {
      const reads = scoped(scope);
      const fenceKey = fence === undefined ? undefined : JSON.stringify(fence);
      const run = <A extends unknown[], R>(args: A, work: (bound: ScopedReads, ...args: A) => Promise<R>) => {
        /* Asked inside `together` for this same evidence: on its snapshot, which proved the membership once. One
           that wants a replica keeps to one, on a snapshot of its own (the shared one is the primary's). */
        const shared = fenceKey === undefined ? undefined : sharing.getStore();
        if (shared?.open && shared.key === fenceKey && !(standbys.pools.length && replicaReadWanted()))
          return onShared(shared, args, (capturedArgs, lease) => work(reads(lease), ...capturedArgs));
        return invoke(
          args,
          async (capturedArgs, next) => {
            if (!next.fenced?.ahead) {
              await revalidate(next);
              return work(reads(next), ...capturedArgs);
            }
            /* The membership is on its way with the BEGIN: the read is sent now, behind it in the same flight,
               and its rows wait for the membership's answer. A refusal there is the answer, whatever the read
               said; the read's own failure is heard only once the membership held. The SQL is the scope's,
               compiled from this evidence alone, so what it reads is this tenant's whatever the answer. */
            const proved = revalidate(next);
            void proved.catch(() => {});
            const answer = Promise.resolve().then(() => work(reads(next), ...capturedArgs));
            void answer.catch(() => {});
            await proved;
            return answer;
          },
          fence === undefined ? undefined : () => fence,
          undefined,
          false,
          () => route,
        );
      };
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
        // On the same snapshot, under the same fence, as `count` is.
        aggregate: (request) =>
          run([request] as [typeof request], (bound, value) =>
            bound.aggregate ? bound.aggregate(value) : Promise.reject(new TenantContextError()),
          ),
      } satisfies ScopedReads);
    };
    /* A batch is one leased snapshot, revalidated once, its reads on that lease. */
    const batch = <C, T>(
      input: C,
      open: (captured: C, lease: Snapshot) => Promise<RowScope>,
      work: (reads: ScopedReads) => T | Promise<T>,
      fence: ((captured: C) => TenantMembershipEvidence) | undefined,
      /* For a fenced batch whose membership rides with its BEGIN (`fenced.ahead`): the scope, composed from the
         evidence alone, and the revalidation, asked of the same flight rather than waited on before the reads. */
      ahead: Readonly<{ scope: (captured: C) => RowScope; proof: (captured: C, lease: Snapshot) => Promise<void> }> | undefined,
      route: (captured: C) => Route,
    ): Promise<T> => {
      if (typeof work !== 'function') return Promise.reject(new TenantContextError());
      let own: { error: unknown } | undefined;
      const heard = (error: unknown) => {
        own = { error };
      };
      return invoke(
        input,
        async (captured, lease) => {
          if (!ahead || !lease.fenced?.ahead) return readBatch(scoped(await open(captured, lease))(lease), active, work, heard);
          /* `work` reads at once, behind the BEGIN and the membership in one flight, and no read's rows reach it
             before the membership's answer has: a refusal there is every read's answer, whatever the read said,
             and the batch's, though it asked nothing at all. */
          const proved = ahead.proof(captured, lease);
          void proved.catch(() => {});
          const held = async <R>(asked: Promise<R>): Promise<R> => {
            const [read, membership] = await Promise.allSettled([asked, proved]);
            if (membership.status === 'rejected') throw membership.reason;
            if (read.status === 'rejected') throw read.reason;
            return read.value;
          };
          const gated: Snapshot = Object.freeze({
            ...lease,
            execute: ((...args: unknown[]) =>
              held((lease.execute as (...values: unknown[]) => Promise<unknown>)(...args))) as Snapshot['execute'],
          });
          const [answer, membership] = await Promise.allSettled([
            readBatch(scoped(ahead.scope(captured))(gated), active, work, heard),
            proved,
          ]);
          /* Whatever `work` made of a held read — availability turns a failed one into "temporarily unavailable" —
             a refused membership is the answer, as it was when the membership was read first. */
          if (membership.status === 'rejected') {
            own = undefined;
            throw membership.reason;
          }
          if (answer.status === 'rejected') throw answer.reason;
          return answer.value;
        },
        fence,
        undefined,
        false,
        route,
      ).catch((error: unknown) => {
        throw own ? own.error : error;
      });
    };
    // Arguments captured now, as `invoke` captures them; no snapshot is leased.
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
      /* Each read in the message that begins its snapshot (`on`'s `lead`), judged as the parameterized read judges its
         own (tenantStorePostgres.ts). */
      readMembership: (lookup: TenantMembershipLookup) =>
        invoke(
          lookup,
          (query, lease) => postgresTenantMembershipLookupRows(owner, query, lease.lead ?? denyTenant()),
          undefined,
          (query) => postgresTenantMembershipLookupStatement(owner, query),
          false,
          // The membership store's rows, which no policy binds.
          () => null,
        ),
      readMemberships: (lookup: TenantMembershipListLookup) => {
        let asked: { readonly sql: string; readonly instant: number } | undefined;
        return invoke(
          lookup,
          (query, lease) => postgresTenantMembershipsRows(owner, query, lease.lead ?? denyTenant(), asked!.instant, clock),
          undefined,
          (query) => (asked = postgresTenantMembershipsStatement(owner, query, clock)).sql,
          false,
          () => null,
        );
      },
      assertCurrent: (evidence: TenantMembershipEvidence) =>
        invoke(
          evidence,
          (value, lease) => current(lease, value),
          (value) => value,
          undefined,
          true,
          (value) => value.tenantId,
        ),
      scopeReads: (evidence: TenantMembershipEvidence, rows: RowScope) =>
        invoke(
          { evidence, rows },
          async (captured, lease) => {
            await current(lease, captured.evidence);
            return bind(
              composeTenantReadScope(owned, captured.evidence, captured.rows, allTrue),
              (next) => current(next, captured.evidence),
              captured.evidence,
              captured.evidence.tenantId,
            );
          },
          (captured) => captured.evidence,
          undefined,
          false,
          (captured) => captured.evidence.tenantId,
        ),
      bindReads: (evidence: TenantMembershipEvidence, rows: RowScope) =>
        bindLater({ evidence, rows }, (captured) =>
          bind(
            composeTenantReadScope(owned, captured.evidence, captured.rows, allTrue),
            (next) => current(next, captured.evidence),
            captured.evidence,
            captured.evidence.tenantId,
          ),
        ),
      together: async <T>(evidence: TenantMembershipEvidence, work: () => Promise<T>): Promise<T> => {
        if (typeof work !== 'function') return Promise.reject(new TenantContextError());
        /* Inside another `together` of this source: its snapshot is the one. */
        if (sharing.getStore()) return work();
        let fence: TenantMembershipEvidence;
        try {
          active();
          fence = captureTenantData(evidence);
        } catch (error) {
          return refusedBefore(error);
        }
        let end!: () => void;
        const shared: Shared = {
          evidence: fence,
          key: JSON.stringify(fence),
          open: true,
          fence: false,
          running: new Set(),
          ended: new Promise<void>((resolve) => {
            end = resolve;
          }),
        };
        try {
          return await sharing.run(shared, work);
        } finally {
          /* Asked from now on, a read takes a snapshot of its own; one already on this one is let finish first. */
          shared.open = false;
          while (shared.running.size) await Promise.allSettled([...shared.running]);
          end();
        }
      },
      togetherFenced: async <T>(evidence: TenantMembershipEvidence, work: () => Promise<T>): Promise<{ value: T; fenced: boolean }> => {
        if (typeof work !== 'function') return Promise.reject(new TenantContextError());
        /* Inside another `together` of this source: its snapshot is the one, and its owner fences. */
        if (sharing.getStore()) return { value: await work(), fenced: false };
        let fence: TenantMembershipEvidence;
        try {
          active();
          fence = captureTenantData(evidence);
        } catch (error) {
          return refusedBefore(error);
        }
        let end!: () => void;
        const shared: Shared = {
          evidence: fence,
          key: JSON.stringify(fence),
          open: true,
          fence: false,
          running: new Set(),
          ended: new Promise<void>((resolve) => {
            end = resolve;
          }),
        };
        let value: T;
        try {
          value = await sharing.run(shared, work);
          /* Only an answer is fenced: a failure lets the snapshot go with a bare COMMIT. */
          shared.fence = true;
        } finally {
          shared.open = false;
          while (shared.running.size) await Promise.allSettled([...shared.running]);
          end();
        }
        /* Never opened (nothing read), or let go without the fence: the caller fences as before. A refused
           membership, or a database that failed to answer it, is the answer. */
        const fenced = shared.lease === undefined ? false : await shared.closed!;
        return { value, fenced };
      },
      withReads: <T>(evidence: TenantMembershipEvidence, rows: RowScope, work: (reads: ScopedReads) => T | Promise<T>) =>
        batch(
          { evidence, rows },
          async (captured, lease) => {
            await current(lease, captured.evidence);
            return composeTenantReadScope(owned, captured.evidence, captured.rows, allTrue);
          },
          work,
          (captured) => captured.evidence,
          {
            scope: (captured) => composeTenantReadScope(owned, captured.evidence, captured.rows, allTrue),
            proof: (captured, lease) => current(lease, captured.evidence),
          },
          (captured) => captured.evidence.tenantId,
        ),
      /* Its statement rides in the message that begins the snapshot (`lead`), as a membership list's does. */
      readPlatformMembership: (lookup: PlatformMembershipLookup) =>
        invoke(
          lookup,
          (query, lease) => postgresPlatformMembershipRows(owner, query, lease.lead ?? denyTenant()),
          undefined,
          (query) => postgresPlatformMembershipStatement(owner, query),
          false,
          () => null,
        ),
      /* The platform's realm reads every tenant's rows its scope reaches, so it reads as the owner. */
      assertPlatformCurrent: (evidence: PlatformMembershipEvidence) =>
        invoke(
          evidence,
          (value, lease) => currentPlatform(lease, value),
          undefined,
          undefined,
          false,
          () => OWNER,
        ),
      // The source recomposes the platform scope itself, as on SQLite.
      scopePlatformReads: (evidence: PlatformMembershipEvidence, rows: RowScope) =>
        invoke(
          { evidence, rows },
          async (captured, lease) => {
            await currentPlatform(lease, captured.evidence);
            return bind(
              composePlatformReadScope(owned, captured.evidence, captured.rows),
              (next) => currentPlatform(next, captured.evidence),
              undefined,
              OWNER,
            );
          },
          undefined,
          undefined,
          false,
          () => OWNER,
        ),
      bindPlatformReads: (evidence: PlatformMembershipEvidence, rows: RowScope) =>
        bindLater({ evidence, rows }, (captured) =>
          bind(
            composePlatformReadScope(owned, captured.evidence, captured.rows),
            (next) => currentPlatform(next, captured.evidence),
            undefined,
            OWNER,
          ),
        ),
      withPlatformReads: <T>(evidence: PlatformMembershipEvidence, rows: RowScope, work: (reads: ScopedReads) => T | Promise<T>) =>
        batch(
          { evidence, rows },
          async (captured, lease) => {
            await currentPlatform(lease, captured.evidence);
            return composePlatformReadScope(owned, captured.evidence, captured.rows);
          },
          work,
          undefined,
          undefined,
          () => OWNER,
        ),
      assertSupportCurrent: (evidence: SupportMembershipEvidence) =>
        invoke(
          evidence,
          (value, lease) => currentSupport(lease, value),
          undefined,
          undefined,
          false,
          (value) => value.tenantId,
        ),
      /* The dealer's scope, composed by the same rule its own members get, on a
         member view of the support evidence — one rule, so a second cannot
         disagree and quietly widen what a session reads. Fenced on the support
         row, as on SQLite. */
      scopeSupportReads: (evidence: SupportMembershipEvidence, rows: RowScope) =>
        invoke(
          { evidence, rows },
          async (captured, lease) => {
            await currentSupport(lease, captured.evidence);
            return bind(
              composeTenantReadScope(owned, supportAsMember(captured.evidence), captured.rows, allTrue),
              (next) => currentSupport(next, captured.evidence),
              undefined,
              captured.evidence.tenantId,
            );
          },
          undefined,
          undefined,
          false,
          (captured) => captured.evidence.tenantId,
        ),
      /* An address is resolved among every tenant's, so as the owner; what the visitor then reads is that tenant's
         alone, its placement proved again under the tenant it resolved to (assertPublicCurrent, the bound reads). */
      resolvePublic: (lookup: TenantPublicLookup) =>
        invoke(
          lookup,
          (value, lease) => resolvePublicIn(lease, value),
          undefined,
          undefined,
          false,
          () => OWNER,
        ),
      assertPublicCurrent: (evidence: TenantPublicEvidence) =>
        invoke(
          evidence,
          (value, lease) => currentPublic(lease, value),
          undefined,
          undefined,
          false,
          (value) => value.tenantId,
        ),
      // The source recomposes the visitor's scope itself, as on SQLite.
      bindPublicReads: (evidence: TenantPublicEvidence, rows: RowScope) =>
        bindLater({ evidence, rows }, (captured) =>
          bind(
            composePublicReadScope(owned, captured.evidence, captured.rows),
            (next) => currentPublic(next, captured.evidence),
            undefined,
            captured.evidence.tenantId,
          ),
        ),
      bindIntakeReads: (evidence: TenantIntakeEvidence, rows: RowScope) =>
        bindLater({ evidence, rows }, (captured) => {
          const value = captureIntakeEvidence(captured.evidence, owned);
          if (intakePlace(value) !== 'tenant') throw new AppAccessDenied();
          const visitor = intakeVisitor(value);
          return bind(
            composePublicReadScope(owned, visitor, captured.rows),
            (next) => currentPublic(next, visitor),
            undefined,
            visitor.tenantId,
          );
        }),
      // The source recomposes the service's scope itself, as on SQLite.
      bindServiceReads: (evidence: TenantServiceEvidence, rows: RowScope) =>
        bindLater({ evidence, rows }, (captured) => {
          const value = captureServiceEvidence(captured.evidence, owned);
          if (value.place !== 'tenant') throw new AppAccessDenied();
          // `place` is 'tenant', so the service has its tenant.
          return bind(composeServiceScope(owned, value, captured.rows), (next) => currentService(next, value), undefined, value.tenantId);
        }),
      // The source recomposes the link's scope itself, as on SQLite.
      bindLinkReads: (evidence: TenantLinkEvidence, rows: RowScope) =>
        bindLater({ evidence, rows }, (captured) => {
          const value = captureLinkEvidence(captured.evidence, owned);
          return bind(composeLinkScope(owned, value, captured.rows), (next) => currentLink(next, value), undefined, value.tenantId);
        }),
      /* A link, an intake address and the anchors are found among every tenant's rows: as the owner. */
      resolveLink: (lookup: TenantLinkLookup) =>
        invoke(
          lookup,
          async (query, lease) => {
            const { id } = captureLinkLookup(query);
            const row = await findPostgresLink(lease.client, owner.appId, id, clock());
            if (!row) return null;
            const anchors = new Map<string, string | null>();
            for (const tenant of [PLATFORM_TENANT_ID, row.tenant])
              anchors.set(tenant, await readPostgresIntakeAnchor(lease.client, owner, tenant));
            return linkResolution(row, (tenant) => anchors.get(tenant) ?? null);
          },
          undefined,
          undefined,
          false,
          () => OWNER,
        ),
      resolveIntake: (lookup: TenantIntakeLookup) =>
        invoke(
          lookup,
          async (query, lease) => {
            const value = captureIntakeLookup(query, owner),
              sql = intakeAddressQuery(owned, value.column);
            const tenantId = value.address === null ? undefined : intakeTenantOf((await lease.client.query(sql, [value.address])).rows);
            const anchors = new Map<string, string | null>();
            for (const id of [...(tenantId === undefined ? [] : [tenantId]), PLATFORM_TENANT_ID]) {
              anchors.set(id, await readPostgresIntakeAnchor(lease.client, owner, id));
            }
            return intakeResolution(tenantId, (id) => anchors.get(id) ?? null);
          },
          undefined,
          undefined,
          false,
          () => OWNER,
        ),
      resolveIntakeByTenant: (lookup: TenantIntakeTenantLookup) =>
        invoke(
          lookup,
          async (query, lease) => {
            const value = captureIntakeTenantLookup(query, owner);
            const anchors = new Map<string, string | null>();
            for (const id of [value.tenantId, PLATFORM_TENANT_ID]) anchors.set(id, await readPostgresIntakeAnchor(lease.client, owner, id));
            return intakeResolutionByTenant(value.tenantId, (id) => anchors.get(id) ?? null);
          },
          undefined,
          undefined,
          false,
          () => OWNER,
        ),
      /* What the platform and the jobs read across tenants by design (docs/postgresql.md): as the owner. */
      readTenantNames: (lookup: TenantNamesLookup) =>
        invoke(
          lookup,
          async (query, lease) => {
            const asked = namesLookup(owned, query);
            if (!asked) return Object.freeze({});
            const { rows } = await lease.client.query(tenantNamesQuery(owned, asked.plan, asked.tenants.length), [asked.tenants]);
            return tenantNamesOf(asked.plan, rows, asked.tenants);
          },
          undefined,
          undefined,
          false,
          () => OWNER,
        ),
      readTenantAddresses: (lookup: TenantAddressesLookup) =>
        invoke(
          lookup,
          async (query, lease) => {
            const { tenantId, columns } = captureAddressesLookup(owned, query);
            const found: Record<string, string> = {};
            for (const [kind, column] of Object.entries(columns)) {
              if (column === undefined) continue;
              // The address and its resolution in one round trip (`tenantOwnAddressQuery`): an entry waits on it.
              const { rows } = await lease.client.query(tenantOwnAddressQuery(owned, column), [tenantId]);
              const address = heldAddress(rows);
              const own = address && tenantOwnAddress(tenantId, address, ownAddressResolution(rows));
              if (own) found[kind] = own;
            }
            return Object.freeze(found) as TenantAddresses;
          },
          undefined,
          undefined,
          false,
          () => OWNER,
        ),
      readTenantProfile: (lookup: TenantProfileLookup) =>
        invoke(
          lookup,
          async (query, lease) => {
            const { tenantId, columns } = captureProfileLookup(owned, query);
            return heldProfile(owned, columns, (await lease.client.query(tenantProfileQuery(owned, columns), [tenantId])).rows);
          },
          undefined,
          undefined,
          false,
          () => OWNER,
        ),
      readServiceAnchors: (tenantId: string | null) =>
        invoke(
          tenantId,
          async (id, lease) =>
            Object.freeze({
              tenantVersion: id === null ? null : await readPostgresIntakeAnchor(lease.client, owner, parseTenantSelector([id])),
              platformVersion: await readPostgresIntakeAnchor(lease.client, owner, PLATFORM_TENANT_ID),
            }),
          undefined,
          undefined,
          false,
          () => OWNER,
        ),
      readActiveTenants: (options?: ActiveTenantsQuery) =>
        invoke(
          options ?? {},
          async (query, lease): Promise<readonly ActiveTenant[]> => {
            const zone = activeTenantsZone(owned, query);
            const active = await readPostgresActiveTenants(lease.client, owner);
            if (zone === undefined) return Object.freeze(active.map((id) => Object.freeze({ id })));
            const rows = (await lease.client.query(tenantProfileColumnQuery(owned, zone))).rows as Record<string, unknown>[];
            return activeWithColumn(owned, zone, active, rows);
          },
          undefined,
          undefined,
          false,
          () => OWNER,
        ),
      readSandboxClocks: () =>
        invoke(
          null,
          async (_none, lease) => {
            const rows = postgresSandboxSession(lease.client);
            return (await sandboxStorePresent(rows)) ? sandboxRows(rows, owner.appId).clocks() : Object.freeze([]);
          },
          undefined,
          undefined,
          false,
          () => OWNER,
        ),
      readSandboxes: (tenants: readonly string[]) =>
        invoke(
          sandboxLookup(tenants),
          async (asked, lease) => {
            const rows = postgresSandboxSession(lease.client);
            return (await sandboxStorePresent(rows)) ? sandboxRows(rows, owner.appId).among(asked) : new Set<string>();
          },
          undefined,
          undefined,
          false,
          () => OWNER,
        ),
      readDueTimers: (query: DueTimersQuery) =>
        invoke(
          query,
          async (value, lease) => {
            const plan = dueTimersPlan(owned, value);
            const active = plan.tenants ? await readPostgresActiveTenants(lease.client, owner) : [];
            if (plan.tenants && !active.length) return Object.freeze([]);
            return plan.decode((await lease.client.query(plan.sql, plan.params(active))).rows);
          },
          undefined,
          undefined,
          false,
          () => OWNER,
        ),
      // The stores' own rows, which no policy binds: read as the runtime, with no tenant said.
      readRecordHistory: (query: RecordHistoryQuery) =>
        invoke(
          query,
          (value, lease) => {
            assertHistoryQuery(value);
            return attestedStore(lease, 'history', (attested) => readPostgresRecordHistory(lease.client, value, attested));
          },
          undefined,
          undefined,
          false,
          () => null,
        ),
      readRecordActivity: (query: RecordActivityQuery) =>
        invoke(
          query,
          (value, lease) => {
            assertActivityQuery(value);
            return attestedStore(lease, 'history', (attested) => readPostgresRecordActivity(lease.client, value, attested));
          },
          undefined,
          undefined,
          false,
          () => null,
        ),
      readInbox: (query: InboxQuery) =>
        inRequest(query, (value, lease) => {
          assertInboxQuery(value);
          return attestedStore(lease, 'inbox', (attested) => readPostgresInbox(lease.client, value, attested));
        }),
      readEmailOff: (query: EmailSwitchQuery) =>
        inRequest(query, (value, lease) => {
          assertEmailSwitchQuery(value);
          return postgresInboxMail((work) => work(lease.client)).emailOff(value.app, value.recipient);
        }),
      readBranding: (query: BrandingQuery) =>
        invoke(
          query,
          (value, lease) => {
            assertBrandingQuery(value);
            return attestedStore(lease, 'branding', (attested) => readPostgresBranding(lease.client, value, attested));
          },
          undefined,
          undefined,
          false,
          () => null,
        ),
      readBrandingLogo: (query: BrandingLogoQuery) =>
        invoke(
          query,
          (value, lease) => {
            assertBrandingLogoQuery(value);
            return attestedStore(lease, 'branding', (attested) => readPostgresBrandingLogo(lease.client, value, attested));
          },
          undefined,
          undefined,
          false,
          () => null,
        ),
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

const NO_PROFILE: Readonly<Record<string, TenantValue>> = Object.freeze({});
/** The tenant's shared profile columns (`auth.tenancy.shared`) for one request, read before its row scope is asked for:
 * nothing is read where the App shares none, nor in the platform realm, where no one tenant is meant. A failed read
 * fails the request; a row scope never guesses a value. */
export function readSharedProfile(
  source: Pick<TenantReadSource, 'readTenantProfile'>,
  app: AppDef,
  tenantId: string,
): Promise<Readonly<Record<string, TenantValue>>> {
  const columns = app.auth?.tenancy?.shared;
  return columns?.length && tenantId !== PLATFORM_TENANT_ID ? source.readTenantProfile({ tenantId, columns }) : Promise.resolve(NO_PROFILE);
}
