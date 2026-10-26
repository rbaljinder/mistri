import { realpathSync, statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { isPromise } from 'node:util/types';
import {
  ANSI_STYLE,
  Serial,
  TransactionOperations,
  TransactionOutcomeUnknown,
  type TellRequest,
  type WriteTransaction,
} from '@mistriwork/engine/adapters/adapter.js';
import { WriteLanes } from '@mistriwork/engine/adapters/writeLanes.js';
import { renamedWriteAhead, withWriteAhead, writeAhead } from '@mistriwork/engine/adapters/writeAhead.js';
import { commandsOf } from '../stores/commandStores.js';
import { SqliteAdapter } from '@mistriwork/engine/adapters/sqlite.js';
import { PostgresAdapter, type PostgresTransactionVerifier } from '@mistriwork/engine/adapters/postgres.js';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import type { PostgresScopeCatalog } from '@mistriwork/engine/adapters/scoped/postgresScopeCatalog.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import {
  assertSqliteCommandJournal,
  COMMAND_JOURNAL_TABLES,
  CommandTransactionFailure,
  type CommandJournal,
} from '../../adapters/commands/commandJournal.js';
import { q as postgresJournalTable } from '../../adapters/commands/postgresCommandJournalSchema.js';
import {
  readSqliteReadCatalog,
  readSqliteScopeCatalog,
  type SqliteScopeCatalog,
} from '@mistriwork/engine/adapters/scoped/sqliteScopeCatalog.js';
import type { RowScope } from '@mistriwork/engine/shared/rowScope.js';
import { mapScopeCatalog } from '@mistriwork/engine/shared/scopeCatalog.js';
import { captureTenantData, denyTenant } from '@mistriwork/engine/server/evidence.js';
import {
  assertTenantOwnership,
  captureTenantOwnership,
  tenantKeyRefusal,
  tenantUniqueRefusal,
  type TenantOwnershipSnapshot,
} from './tenantOwnership.js';
import { postgresTenantLocator, provideTenantSourceProbe, registerTenantSourceIdentity } from './tenantSourceIdentity.js';
import { assertSqliteTenantStore, type TenantStoreBinding } from './tenantStore.js';
import { assertPostgresTenantStore } from './tenantStorePostgres.js';
import { transactionOf, transactionRollbacks } from '@mistriwork/engine/adapters/postgresTransactionHandle.js';
import {
  assertPostgresTenantUniqueKeys,
  attestPostgresTenantRelations,
  pinPostgresTenantRelations,
  pinPostgresTenantRelationsStatement,
} from './tenantPostgresCatalog.js';
import {
  TenantWriteFailure,
  tenantWriteFailed,
  type TenantWriteAudit,
  type TenantWriteEvidence,
  type TenantWriteKind,
  type TenantWriteOperation,
  type TenantWriteRun,
  type TenantWriteSink,
} from './tenantWriteKindContract.js';
import { tenantWriteMethods, type TenantWriteMethods } from './tenantWriteKinds.js';
import { WriterRetargeted, writerLifecycle } from './tenantWriterLifecycle.js';
import type { RecordHistoryBinding } from '../../adapters/history/recordHistory.js';
import { bindTenantRecordHistoryStore } from './tenantRecordHistoryStore.js';
import { bindTenantLive, unbindTenantLive } from './tenantLive.js';
import { appStoresOf } from '../stores/appStores.js';
import { assertInboxMark, type InboxMark, type NoticeBinding } from '../../adapters/inbox/inbox.js';
import type { InboxMailStore } from '../../adapters/inbox/inboxMail.js';
import { bindTenantInboxStore } from './tenantInbox.js';
import { bindTenantBrandingStore } from './tenantBrandingStore.js';
import { assertBrandingWrite, type BrandingWrite } from '../../adapters/branding/branding.js';

export { TenantIntakeMoved, TenantWriteFailure } from './tenantWriteKindContract.js';

/** Private writer authority, not an accepted credential or a request issuer.
 * Its transaction methods are its kinds' (tenantWriteKind*.ts): each takes
 * only its own realm's evidence. */
export interface TenantWriteSource extends TenantWriteMethods {
  readonly ownership: TenantOwnershipSnapshot;
  /** Mark one person's notices read in one inbox, on the writer's queue: the
   * mark names its inbox and recipient, and the store touches nothing else
   * (tenantInbox.ts says whose inbox a lease reads). */
  markInboxRead(mark: InboxMark): Promise<number>;
  /** The outbox and the email switches beside the inbox, each statement on the
   * writer's queue: the host's notice sender (tenantNoticeMail.ts) and a
   * person's own switch, which names its inbox from the lease. */
  readonly inboxMail: InboxMailStore;
  /** Save one tenant's branding and the logo it names, on the writer's queue
   * and in one transaction; returns the new revision (adapters/branding). */
  writeBranding(write: BrandingWrite): Promise<number>;
  close(): Promise<void>;
}
/** One record a committed transaction wrote: its logical table and its key. */
interface TenantCommittedWrite {
  readonly table: string;
  readonly key: Readonly<Record<string, string | number>>;
}
type CommitObserver = (writes: readonly TenantCommittedWrite[]) => void;
const commitObservers = new Map<string, Set<CommitObserver>>();
/** The adapter's outbox, each call queued behind the writer's transactions and refused once it closes. */
function queuedInboxMail(
  store: () => InboxMailStore,
  run: <T>(work: () => Promise<T>) => Promise<T>,
  closed: () => boolean,
): InboxMailStore {
  // The store is asked for at each call: a writer reopened after an uncertain write is a new adapter.
  const queued =
    <K extends keyof InboxMailStore>(name: K) =>
    (...args: Parameters<InboxMailStore[K]>): ReturnType<InboxMailStore[K]> => {
      if (closed())
        return Promise.reject(tenantWriteFailed('not_applied', new Error('The tenant writer is closed.'))) as ReturnType<InboxMailStore[K]>;
      const captured = captureTenantData(args) as Parameters<InboxMailStore[K]>;
      return run(() => (store()[name] as (...args: unknown[]) => Promise<unknown>)(...captured)) as ReturnType<InboxMailStore[K]>;
    };
  return Object.freeze<InboxMailStore>({
    claimMail: queued('claimMail'),
    dueInboxes: queued('dueInboxes'),
    settleMail: queued('settleMail'),
    emailOff: queued('emailOff'),
    setEmailOff: queued('setEmailOff'),
  });
}

/** Each adapter's outbox, asked for once per adapter. */
function mailOf(current: () => SqliteAdapter | PostgresAdapter): () => InboxMailStore {
  const stores = new WeakMap<object, InboxMailStore>();
  return () => {
    const adapter = current();
    let store = stores.get(adapter);
    if (!store) stores.set(adapter, (store = appStoresOf(adapter).inboxMail()));
    return store;
  };
}
const observerKey = (owner: { readonly appId: string; readonly source: { readonly id: string } }) =>
  JSON.stringify([owner.appId, owner.source.id]);

/**
 * Be told, after COMMIT, which records each transaction of this App's tenant
 * source wrote — a member's edit, a command, a job, an intake — whichever
 * route and realm it came from. For copies that follow the database, never
 * for authority: a search index (tenantSearch.ts) re-reads each record and
 * takes nothing from here but where to look. An observer that throws is
 * ignored; the write has already happened. Returns the way to stop.
 */
export function observeTenantCommits(
  owner: { readonly appId: string; readonly source: { readonly id: string } },
  observer: CommitObserver,
): () => void {
  const key = observerKey(owner);
  const set = commitObservers.get(key) ?? new Set<CommitObserver>();
  commitObservers.set(key, set);
  set.add(observer);
  return () => {
    set.delete(observer);
    if (!set.size) commitObservers.delete(key);
  };
}
function committed(owner: { readonly appId: string; readonly source: { readonly id: string } }, writes: TenantCommittedWrite[]) {
  const observers = writes.length ? commitObservers.get(observerKey(owner)) : undefined;
  if (!observers) return;
  const frozen = Object.freeze(writes.map((write) => Object.freeze({ table: write.table, key: Object.freeze({ ...write.key }) })));
  for (const observer of observers) {
    try {
      observer(frozen);
    } catch {
      /* A copy that cannot follow is the observer's to report. */
    }
  }
}
/* The records one transaction's operations name, in the order they ran. */
function recording(records: WriteTransaction, wrote: TenantCommittedWrite[]): WriteTransaction {
  return Object.freeze<WriteTransaction>({
    query: (request) => records.query(request),
    count: (table, filter) => records.count(table, filter),
    insert: async (request) => {
      const result = await records.insert(request);
      wrote.push({ table: request.table, key: result.key });
      return result;
    },
    update: async (request) => {
      const result = await records.update(request);
      wrote.push({ table: request.table, key: request.key });
      return result;
    },
    remove: async (request) => {
      const result = await records.remove(request);
      wrote.push({ table: request.table, key: request.key });
      return result;
    },
    // A notice writes no record of the App's, so nothing follows it.
    ...(records.tell ? { tell: records.tell.bind(records) } : {}),
  });
}

const sources = new WeakSet<TenantWriteSource>();
export function captureTenantWriteSource(input: TenantWriteSource): TenantWriteSource {
  if (!sources.has(input)) throw new TenantWriteFailure('not_applied');
  return input;
}
provideTenantSourceProbe('write', captureTenantWriteSource);
/** A command's footprint as the request runtime names it, captured: distinct
 * resources of this ownership, or nothing at all. An ordinary write has none. */
function footprintOf(owned: TenantOwnershipSnapshot, command: boolean, footprint: unknown): readonly string[] | undefined {
  if (footprint === undefined) return undefined;
  const tables = captureTenantData(footprint);
  if (
    !command ||
    !Array.isArray(tables) ||
    !tables.length ||
    tables.length > 256 ||
    new Set(tables).size !== tables.length ||
    tables.some((table) => typeof table !== 'string' || !Object.hasOwn(owned.ownership, table))
  )
    return denyTenant();
  return Object.freeze([...(tables as string[])]);
}

function synchronous(value: unknown): void {
  if (isPromise(value)) void Promise.prototype.then.call(value, undefined, () => {});
  if (value !== undefined) denyTenant();
}

/** Attest tenant-local business uniqueness; a single opaque TEXT primary ID is
 * the intentional global exception. Type/DDL cannot prove how a host generates
 * those IDs, so ID generation remains an explicit deployment responsibility. */
function assertUniqueKeys(db: DatabaseSync, ownership: TenantOwnershipSnapshot): void {
  for (const [logical, rule] of Object.entries(ownership.ownership)) {
    if (rule.kind !== 'tenant') continue;
    const id = ownership.resources[logical];
    const table = ownership.schema.tables.find((table) => table.id === logical)!;
    const primary = table.columns.filter((column) => column.primaryKey);
    const opaque =
      primary.length === 1 &&
      !primary[0].nullable &&
      !primary[0].identity &&
      !/INT/i.test(primary[0].type) &&
      /CHAR|CLOB|TEXT/i.test(primary[0].type);
    if (!primary.length || (!primary.some((column) => column.name === rule.column) && !opaque))
      return denyTenant(tenantKeyRefusal(logical, rule.column, primary));
    const indexes = db.prepare(`PRAGMA main.index_list(${ANSI_STYLE.quote(id)})`).all();
    let primarySeen = false;
    for (const index of indexes) {
      if (typeof index.name !== 'string' || ![0, 1].includes(index.unique as number)) return denyTenant();
      if (index.unique !== 1) continue;
      const keys = db
        .prepare(`PRAGMA main.index_xinfo(${ANSI_STYLE.quote(index.name)})`)
        .all()
        .filter((column) => column.key === 1);
      if (
        !keys.length ||
        keys.some(
          (column) =>
            typeof column.name !== 'string' || typeof column.coll !== 'string' || typeof column.cid !== 'number' || column.cid < 0,
        )
      )
        return denyTenant();
      const local = keys.some((column) => column.name === rule.column && column.coll === 'BINARY');
      const primaryOnly = opaque && keys.length === 1 && keys[0].name === primary[0].name && keys[0].coll === 'BINARY';
      if (!local && !primaryOnly) return denyTenant(tenantUniqueRefusal(logical, index.name as string, rule.column));
      if (index.origin === 'pk') primarySeen = true;
    }
    if (!primarySeen) denyTenant(tenantKeyRefusal(logical, rule.column, []));
  }
}

/** Explicit private writable acquisition. An empty initial verified transaction
 * pins and attests the actual writer before publication. It does not migrate or
 * change business data. The host must retire this source before file replacement,
 * restore or registry retargeting; callbacks never receive its raw handles. */
export async function openSqliteTenantWriteSource(
  existingPath: string,
  ownership: TenantOwnershipSnapshot,
  store: TenantStoreBinding,
  now: () => number = Date.now,
  audit?: TenantWriteAudit,
  history?: RecordHistoryBinding,
  notices?: NoticeBinding,
  branding = false,
): Promise<TenantWriteSource> {
  let adapter: SqliteAdapter | undefined;
  try {
    const captured = captureTenantOwnership(ownership);
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
    const opened = statSync(canonicalPath);
    const first = (adapter = new SqliteAdapter(canonicalPath, 'Private tenant writer'));
    const physical = new Map(Object.entries(owned.resources));
    const ids = new Set(physical.values());
    const toPhysical = (logical: string) => physical.get(logical) ?? denyTenant();
    const allTrue: RowScope = Object.freeze(Object.fromEntries([...physical.keys()].map((id) => [id, true])));
    let baseline: string | undefined;
    const attest = (db: DatabaseSync, _initialCatalog: SqliteScopeCatalog) => {
      if (!db.isTransaction) return denyTenant();
      const actual = readSqliteReadCatalog(db);
      if ([...ids].some((id) => !actual.readable.has(id))) return denyTenant();
      assertTenantOwnership(owned, { ...owned, physicalSchema: actual.schema });
      assertSqliteTenantStore(db, owner);
      assertUniqueKeys(db, owned);
      // Re-read eligibility as well as DDL: TEMP triggers/shadows must not become
      // invisible merely because the outer engine captured its catalog earlier.
      const writable = readSqliteScopeCatalog(db).writable;
      const definitions = db
        .prepare('SELECT type, name, tbl_name, sql FROM main.sqlite_schema ORDER BY type, name')
        .all()
        .filter((row) => typeof row.tbl_name === 'string' && ids.has(row.tbl_name));
      const state = JSON.stringify({ definitions, writable: [...ids].filter((id) => writable.has(id)).sort() });
      if (baseline !== undefined && state !== baseline) return denyTenant();
      baseline ??= state;
    };
    const empty = Object.fromEntries([...ids].map((id) => [id, false]));
    /* Attest the writer, read an uncertain command's receipt when one is
       named, and bind the App's stores: at opening, and again at each reopen. */
    const prepare = async (dbAdapter: SqliteAdapter, receipt?: string): Promise<boolean | undefined> => {
      let committed: boolean | undefined;
      await dbAdapter.scopeVerifiedTransaction(
        empty,
        (db, catalog) => {
          attest(db, catalog);
          if (receipt !== undefined && committed === undefined)
            committed = db.prepare(`SELECT 1 AS hit FROM main."${COMMAND_JOURNAL_TABLES.receipt}" WHERE id = ?`).get(receipt) !== undefined;
        },
        async () => {},
      );
      // The App's history tables, recorded beneath every scoped write from the first (tenantRecordHistoryStore.ts).
      if (history) await bindTenantRecordHistoryStore(dbAdapter, history, 'sqlite');
      // And its notify rules, which tell people in the same transactions (tenantInbox.ts).
      if (notices) await bindTenantInboxStore(dbAdapter, notices, 'sqlite');
      if (branding) await bindTenantBrandingStore(dbAdapter, 'sqlite');
      // And live sync's change row, naming each write's tenant (tenantLive.ts); a reopen binds the new handle.
      await bindTenantLive(dbAdapter, owned);
      return committed;
    };
    await prepare(first);

    const queue = new Serial();
    const life = writerLifecycle({
      owner,
      initial: first,
      drain: (work) => queue.run(work),
      release: (handle) => unbindTenantLive(handle, owned),
      reopen: async (receipt) => {
        // Never at a path that now resolves to another file: that is a restart's to decide.
        let now: ReturnType<typeof statSync>;
        try {
          now = statSync(canonicalPath);
          if (realpathSync(existingPath) !== canonicalPath) throw new WriterRetargeted();
        } catch (error) {
          throw error instanceof WriterRetargeted ? error : new Error('The tenant database is not reachable.', { cause: error });
        }
        if (now.dev !== opened.dev || now.ino !== opened.ino) throw new WriterRetargeted();
        const next = new SqliteAdapter(canonicalPath, 'Private tenant writer');
        try {
          return { handle: next, committed: await prepare(next, receipt) };
        } catch (error) {
          await next.close().catch(() => {});
          throw error;
        }
      },
    });
    const closing = life.closing;
    const close = life.close;
    /* One transaction for every kind. The kind (tenantWriteKind*.ts) says what
       its evidence means here: capture, scope, fence, journal owner and managed
       transaction. Everything else, and every outcome, is the engine's. */
    const transaction = <Evidence extends TenantWriteEvidence, T>(
      kind: TenantWriteKind<Evidence, object>,
      command: boolean,
      evidence: Evidence,
      rows: RowScope,
      run: TenantWriteRun<T>,
      assertActive?: () => void,
      operation?: TenantWriteOperation,
      footprint?: readonly string[],
    ): Promise<T> => {
      let input: { readonly evidence: Evidence; readonly rows: RowScope };
      let tables: readonly string[] | undefined;
      try {
        if (closing() || typeof run !== 'function' || (assertActive !== undefined && typeof assertActive !== 'function'))
          return denyTenant();
        input = kind.capture(evidence, rows, owned);
        tables = footprintOf(owned, command, footprint);
      } catch (error) {
        return Promise.reject(tenantWriteFailed('not_applied', error));
      }
      return queue.run(async () => {
        const dbAdapter = life.handle();
        let receipt: string | undefined;
        let entered = false,
          completed = false,
          attempted = false,
          moved = false,
          started = false;
        // Shape validation happens inside the classified failure boundary.
        // A null/absent evidence value must not throw before that boundary.
        let lastTime = input.evidence?.verifiedAt;
        const live = (): number => {
          if (closing()) return denyTenant();
          if (assertActive) synchronous(assertActive());
          const instant = now();
          if (isPromise(instant)) void Promise.prototype.then.call(instant, undefined, () => {});
          // This clock belongs to the source, not the request owner. It can
          // synchronously cancel/retire the request at the final precommit check.
          if (assertActive) synchronous(assertActive());
          if (
            closing() ||
            typeof instant !== 'number' ||
            !Number.isSafeInteger(instant) ||
            !Number.isSafeInteger(lastTime) ||
            instant < lastTime ||
            instant >= input.evidence.validUntil
          )
            return denyTenant();
          lastTime = instant;
          return instant;
        };
        try {
          live();
          const physicalScope = Object.fromEntries(
            Object.entries(kind.scope(owned, input.evidence, input.rows, allTrue)).map(([id, rule]) => [toPhysical(id), rule]),
          );
          const bound = command ? kind.bound?.(owned, input.evidence, input.rows, tables, allTrue) : undefined;
          const physicalBound = bound && Object.fromEntries(Object.entries(bound).map(([id, rule]) => [toPhysical(id), rule]));
          attempted = true;
          const fence = Object.freeze({ owner, owned, live });
          const wrote: TenantCommittedWrite[] = [];
          /* The sink is opened here because the verifier is the only place
             holding the raw handle, and it runs on a queue of its own so that
             a refused append fails this transaction at its own drain instead
             of poisoning the managed facade's queue under the handler. */
          let sink: TenantWriteSink | undefined, sinkQueue: TransactionOperations | undefined;
          const verify = (db: DatabaseSync, catalog: SqliteScopeCatalog) => {
            entered = true;
            live();
            attest(db, catalog);
            // BEGIN IMMEDIATE is already the writer fence. The kind's check
            // uses this exact handle, not a second reader/connection. Failing
            // before the handler starts, it may mean the kind's anchor moved.
            try {
              kind.sqliteFence(db, input.evidence, fence);
            } catch (error) {
              if (!started) moved = true;
              throw error;
            }
            if (command) assertSqliteCommandJournal(db);
            // Once, before the handler: the verifier also runs again before COMMIT.
            if (audit && kind.sqliteSink && !sink) {
              sinkQueue = new TransactionOperations();
              sink = kind.sqliteSink(db, input.evidence, fence, sinkQueue, audit);
            }
            live();
            attest(db, catalog);
          };
          // The receipt this attempt writes, by id: what a reopen reads to say whether an uncertain command committed.
          const noted = (journal: CommandJournal): CommandJournal =>
            Object.freeze<CommandJournal>({
              ...journal,
              commit: (stored, ...rest) => {
                receipt = stored?.id;
                return journal.commit(stored, ...rest);
              },
              ...(journal.insert
                ? {
                    insert: (
                      stored: Parameters<NonNullable<CommandJournal['insert']>>[0],
                      audit: Parameters<NonNullable<CommandJournal['insert']>>[1],
                    ) => {
                      receipt = stored?.id;
                      return journal.insert!(stored, audit);
                    },
                  }
                : {}),
            });
          const work = async (records: WriteTransaction, journal?: CommandJournal) => {
            started = true;
            const logical = Object.freeze<WriteTransaction>({
              query: (request) => records.query({ ...request, table: toPhysical(request.table) }),
              count: (table, filter) => records.count(toPhysical(table), filter),
              insert: (request) => records.insert({ ...request, table: toPhysical(request.table) }),
              update: (request) => records.update({ ...request, table: toPhysical(request.table) }),
              remove: (request) => records.remove({ ...request, table: toPhysical(request.table) }),
              ...(records.tell ? { tell: (request: TellRequest) => records.tell!({ ...request, table: toPhysical(request.table) }) } : {}),
            });
            const outcome = await kind.run(
              owned,
              input.evidence,
              recording(logical, wrote),
              journal && noted(journal),
              command,
              run,
              sink,
              operation,
            );
            // Before COMMIT: an append still in flight, or one that failed and
            // was never awaited, fails the write rather than escaping the record.
            if (sinkQueue) await sinkQueue.finish();
            return outcome;
          };
          const result = command
            ? await commandsOf(dbAdapter).scopeVerifiedCommandTransaction(
                physicalScope,
                verify,
                kind.journalOwner(owner, input.evidence),
                work,
                physicalBound,
              )
            : await dbAdapter.scopeVerifiedTransaction(physicalScope, verify, (records) => work(records));
          completed = true;
          committed(owner, wrote);
          // A late lifetime refusal after confirmed COMMIT is never reported
          // as not_applied. Public result reauthorization belongs to the future
          // write-request owner, not to the admission-only membership issuer.
          live();
          return result;
        } catch (error) {
          const unknown =
            completed ||
            error instanceof TransactionOutcomeUnknown ||
            (error instanceof CommandTransactionFailure && error.outcome === 'unknown');
          // No write may follow an uncertain one on this connection: the
          // writer closes and reopens once it is safe (writerLifecycle).
          // Confirmed ordinary rollbacks can retry.
          if (
            error instanceof TransactionOutcomeUnknown ||
            (error instanceof CommandTransactionFailure && error.outcome === 'unknown') ||
            (attempted && !entered)
          )
            life.pause(receipt);
          if (moved && !completed && kind.moved) throw kind.moved();
          throw tenantWriteFailed(unknown ? 'unknown' : 'not_applied', error);
        }
      });
    };
    const markInboxRead = (mark: InboxMark): Promise<number> => {
      try {
        if (closing()) return denyTenant();
        assertInboxMark(mark);
      } catch (error) {
        return Promise.reject(tenantWriteFailed('not_applied', error));
      }
      const captured = captureTenantData(mark);
      return queue.run(() => appStoresOf(life.handle()).markInboxRead(captured));
    };
    const writeBranding = (write: BrandingWrite): Promise<number> => {
      try {
        if (closing()) return denyTenant();
        assertBrandingWrite(write);
      } catch (error) {
        return Promise.reject(tenantWriteFailed('not_applied', error));
      }
      const captured = captureTenantData(write);
      return queue.run(() => appStoresOf(life.handle()).writeBranding(captured));
    };
    const inboxMail = queuedInboxMail(mailOf(life.handle), (work) => queue.run(work), closing);
    const source = Object.freeze<TenantWriteSource>({
      ownership: owned,
      ...tenantWriteMethods(transaction),
      markInboxRead,
      inboxMail,
      writeBranding,
      close,
    });
    sources.add(source);
    registerTenantSourceIdentity(source, { ...owner, canonicalPath });
    return source;
  } catch (error) {
    try {
      await adapter?.close();
    } catch {
      /* No writer capability is published. */
    }
    throw tenantWriteFailed(error instanceof TransactionOutcomeUnknown ? 'unknown' : 'not_applied', error);
  }
}

/**
 * The PostgreSQL counterpart of openSqliteTenantWriteSource: the same managed
 * transactions, ownership injection and tenant command journal, on a
 * dedicated PostgresAdapter writer. Where the engines differ:
 *
 * - The fence. SQLite's BEGIN IMMEDIATE excludes every other writer, so a
 *   membership read on it is ordered against every revocation. Here the
 *   verifier takes the evidence's tenant row, then its membership row, FOR
 *   SHARE on the writer, held to COMMIT (`assertPostgresTenantMembershipFence`),
 *   after the scope's tables are pinned; a revocation needs the tenant row FOR
 *   UPDATE, so whichever locks it first commits first. The verifier runs before
 *   the callback and again after its operations drain, before COMMIT; that
 *   second pass checks the lifetime alone, the rows still locked.
 * - Per-operation checks. SQLite re-verifies before every operation because its
 *   verifier is a snapshot read. The held row locks make a membership re-read
 *   redundant here, so each operation checks the lifetime alone — clock, lease
 *   and close — when it executes, before it reaches the writer.
 * - Attestation reads pg_catalog (tenantPostgresCatalog.ts), not CREATE text,
 *   including tenant-local unique keys from pg_index, and pins whatever the
 *   scope catalog did not already pin before comparing.
 */
export async function openPostgresTenantWriteSource(
  url: string,
  ownership: TenantOwnershipSnapshot,
  store: TenantStoreBinding,
  now: () => number = Date.now,
  audit?: TenantWriteAudit,
  history?: RecordHistoryBinding,
  notices?: NoticeBinding,
  branding = false,
): Promise<TenantWriteSource> {
  let adapter: PostgresAdapter | undefined;
  try {
    const owned = captureTenantOwnership(ownership);
    const owner = captureTenantData(store);
    if (
      owned.physicalSchema.dialect !== 'postgres' ||
      owner.appId !== owned.appId ||
      owner.source.id !== owned.source.id ||
      owner.source.connection !== owned.source.connection ||
      typeof now !== 'function' ||
      typeof url !== 'string' ||
      !/^postgres(ql)?:\/\//i.test(url)
    )
      return denyTenant();
    const locator = postgresTenantLocator(url);
    const first = (adapter = new PostgresAdapter(url, 'Private tenant writer'));
    const physical = new Map(Object.entries(owned.resources));
    const ids = new Set(physical.values());
    const toPhysical = (logical: string) => physical.get(logical) ?? denyTenant();
    const allTrue: RowScope = Object.freeze(Object.fromEntries([...physical.keys()].map((id) => [id, true])));
    let baseline: string | undefined;
    /* Every owned relation, pinned in the message that begins each write
       transaction, before the schema epoch (or the catalog digest) is read
       there (PostgresAdapter.openWrite): the epoch then covers all of them.
       The store takes no pin: it is attested when the adapter first uses it
       (postgresStoreFence.ts). */
    const pin = pinPostgresTenantRelationsStatement([...ids]) ?? '';
    /* The epoch the last full attestation passed under. The attestation reads
       only the catalog and the store's layout (its meta row is read again by
       every fence), so in a transaction whose epoch is the same it would read
       what passed: it was read after the same pins, DDL since would have moved
       the epoch, and DDL after them waits for the transaction. Read in full on
       every write it was eight round trips a transaction, twice a command, and
       a fifth of a tenant database's statement time (a field report: the relation,
       index and role reads, thousands of runs each). */
    let standing: string | undefined;
    const attest = async (client: PgQuery, catalog: PostgresScopeCatalog, describe: () => Promise<DatabaseSchema>, epoch?: string) => {
      if (epoch !== undefined && epoch === standing) return;
      // Writable scope tables were pinned before the catalog was read. Pin the
      // rest against DDL, and describe again only then, so what is compared
      // was read after every pin.
      const unpinned = [...ids].filter((id) => !catalog.writable.has(id));
      if (unpinned.length) await pinPostgresTenantRelations(client, unpinned);
      assertTenantOwnership(owned, { ...owned, physicalSchema: unpinned.length ? await describe() : catalog.schema });
      await assertPostgresTenantStore(client, owner);
      await assertPostgresTenantUniqueKeys(client, owned);
      const state = JSON.stringify({
        definitions: await attestPostgresTenantRelations(client, owned),
        writable: [...ids].filter((id) => catalog.writable.has(id)).sort(),
      });
      if (baseline !== undefined && state !== baseline) return denyTenant();
      baseline ??= state;
      standing = epoch;
    };
    const verifier = (
      verify: (client: PgQuery, catalog: PostgresScopeCatalog, describe: () => Promise<DatabaseSchema>, epoch?: string) => Promise<void>,
      ahead?: PostgresTransactionVerifier['ahead'],
    ): PostgresTransactionVerifier => Object.assign(verify, ahead ? { pin, ahead } : { pin });
    const empty = Object.fromEntries([...ids].map((id) => [id, false]));
    // As on SQLite: at opening, and again at each reopen after an uncertain write.
    const prepare = async (dbAdapter: PostgresAdapter, receipt?: string): Promise<boolean | undefined> => {
      let committed: boolean | undefined;
      await dbAdapter.scopeVerifiedTransaction(
        empty,
        verifier(async (client, catalog, describe, epoch) => {
          await attest(client, catalog, describe, epoch);
          if (receipt !== undefined && committed === undefined)
            committed =
              (await client.query(`SELECT 1 FROM ${postgresJournalTable(COMMAND_JOURNAL_TABLES.receipt)} WHERE id = $1`, [receipt])).rows
                .length > 0;
        }),
        async () => {},
      );
      if (history) await bindTenantRecordHistoryStore(dbAdapter, history, 'postgres');
      if (notices) await bindTenantInboxStore(dbAdapter, notices, 'postgres');
      if (branding) await bindTenantBrandingStore(dbAdapter, 'postgres');
      await bindTenantLive(dbAdapter, owned, url);
      return committed;
    };
    await prepare(first);

    /* The order this source's writes run in (writeLanes.ts): in a process
       serving Apps, side by side on the adapter's writer pool — the fence
       above is row locks held to COMMIT, which order two of them across
       connections as across pods — and shutdown after all of them. */
    const queue = new WriteLanes();
    const life = writerLifecycle({
      owner,
      initial: first,
      drain: (work) => queue.run('all', work),
      release: (handle) => unbindTenantLive(handle, owned),
      /* The URL is the trusted host's and fixed; the attestation is what
         says the database behind it is still the one this source opened. */
      reopen: async (receipt) => {
        const next = new PostgresAdapter(url, 'Private tenant writer');
        /* A new pool attests in full: what the old one's attestation proved
           is not carried to it, even under an epoch that has not moved. */
        standing = undefined;
        try {
          return { handle: next, committed: await prepare(next, receipt) };
        } catch (error) {
          await next.close().catch(() => {});
          throw error;
        }
      },
    });
    const closing = life.closing;
    const close = life.close;
    const transaction = <Evidence extends TenantWriteEvidence, T>(
      kind: TenantWriteKind<Evidence, object>,
      command: boolean,
      evidence: Evidence,
      rows: RowScope,
      run: TenantWriteRun<T>,
      assertActive?: () => void,
      operation?: TenantWriteOperation,
      footprint?: readonly string[],
    ): Promise<T> => {
      let input: { readonly evidence: Evidence; readonly rows: RowScope };
      let tables: readonly string[] | undefined;
      try {
        if (closing() || typeof run !== 'function' || (assertActive !== undefined && typeof assertActive !== 'function'))
          return denyTenant();
        input = kind.capture(evidence, rows, owned);
        tables = footprintOf(owned, command, footprint);
      } catch (error) {
        return Promise.reject(tenantWriteFailed('not_applied', error));
      }
      return queue.run([], async () => {
        const dbAdapter = life.handle();
        let receipt: string | undefined;
        let fenced: { transaction: object; rollbacks: number } | undefined;
        let entered = false,
          attested = false,
          completed = false,
          attempted = false,
          moved = false,
          started = false;
        // Shape validation happens inside the classified failure boundary.
        let lastTime = input.evidence?.verifiedAt;
        const live = (): number => {
          if (closing()) return denyTenant();
          if (assertActive) synchronous(assertActive());
          const instant = now();
          if (isPromise(instant)) void Promise.prototype.then.call(instant, undefined, () => {});
          // The source's clock can synchronously retire the request owner.
          if (assertActive) synchronous(assertActive());
          if (
            closing() ||
            typeof instant !== 'number' ||
            !Number.isSafeInteger(instant) ||
            !Number.isSafeInteger(lastTime) ||
            instant < lastTime ||
            instant >= input.evidence.validUntil
          )
            return denyTenant();
          lastTime = instant;
          return instant;
        };
        try {
          live();
          const physicalScope = Object.fromEntries(
            Object.entries(kind.scope(owned, input.evidence, input.rows, allTrue)).map(([id, rule]) => [toPhysical(id), rule]),
          );
          const bound = command ? kind.bound?.(owned, input.evidence, input.rows, tables, allTrue) : undefined;
          const physicalBound = bound && Object.fromEntries(Object.entries(bound).map(([id, rule]) => [toPhysical(id), rule]));
          attempted = true;
          const fence = Object.freeze({ owner, owned, live });
          const wrote: TenantCommittedWrite[] = [];
          /* As on SQLite: opened in the verifier, which is where the client
             is, on its own queue so a refused append cannot poison the managed
             facade's. The audit's PostgreSQL layout is pinned verbatim
             (tenantSupportAuditPostgres.ts), so a column or CHECK added to it
             is a reseed, never a migration in place. */
          let sink: TenantWriteSink | undefined, sinkQueue: TransactionOperations | undefined;
          const verify = verifier(
            async (client, catalog, describe, epoch) => {
              entered = true;
              live();
              // The pins taken here hold to COMMIT, so the pre-commit pass needs
              // only the lifetime and the fence.
              if (!attested) {
                await attest(client, catalog, describe, epoch);
                attested = true;
              }
              /* A fence whose rows this transaction already holds FOR SHARE, with no
                 rollback since, would read what it read: the lifetime above is all that
                 can have moved (postgresFenceHeld). The pass before COMMIT is then local. */
              const transaction = transactionOf(client),
                rollbacks = transactionRollbacks(client);
              const held =
                kind.postgresFenceHeld === true &&
                transaction !== undefined &&
                fenced?.transaction === transaction &&
                fenced.rollbacks === rollbacks;
              if (!held)
                try {
                  await kind.postgresFence(client, input.evidence, fence);
                  if (transaction !== undefined && rollbacks !== undefined) fenced = { transaction, rollbacks };
                } catch (error) {
                  if (!started) moved = true;
                  throw error;
                }
              if (audit && kind.postgresSink && !sink) {
                sinkQueue = new TransactionOperations();
                sink = kind.postgresSink(client, input.evidence, fence, sinkQueue, audit);
              }
              live();
              /* Its first pass's fence, sent behind the BEGIN: only for a store this
               source keeps attested (an epoch a full attestation passed under),
               the one case its fence sends what the kind says it does. */
            },
            standing !== undefined && kind.postgresFenceAhead ? () => kind.postgresFenceAhead!(owner, input.evidence) : undefined,
          );
          const work = async (records: WriteTransaction, journal?: CommandJournal) => {
            started = true;
            const logical = Object.freeze<WriteTransaction>({
              query: (request) => {
                live();
                return records.query({ ...request, table: toPhysical(request.table) });
              },
              count: (table, filter) => {
                live();
                return records.count(toPhysical(table), filter);
              },
              insert: (request) => {
                live();
                return records.insert({ ...request, table: toPhysical(request.table) });
              },
              update: (request) => {
                live();
                return records.update({ ...request, table: toPhysical(request.table) });
              },
              remove: (request) => {
                live();
                return records.remove({ ...request, table: toPhysical(request.table) });
              },
              ...(records.tell
                ? {
                    tell: (request: TellRequest) => {
                      live();
                      return records.tell!({ ...request, table: toPhysical(request.table) });
                    },
                  }
                : {}),
            });
            const receipts =
              journal &&
              Object.freeze<CommandJournal>({
                find: (...args) => {
                  live();
                  return journal.find(...args);
                },
                commit: (...args) => {
                  live();
                  // What a reopen reads to say whether an uncertain command committed.
                  receipt = args[0]?.id;
                  return journal.commit(...args);
                },
                ...(journal.nextNumber
                  ? {
                      nextNumber: (...args: Parameters<NonNullable<CommandJournal['nextNumber']>>) => {
                        live();
                        return journal.nextNumber!(...args);
                      },
                    }
                  : {}),
              });
            const outcome = await kind.run(owned, input.evidence, recording(logical, wrote), receipts, command, run, sink, operation);
            // Before COMMIT, as on SQLite: a failed or unfinished append fails
            // the write instead of escaping the record.
            if (sinkQueue) await sinkQueue.finish();
            return outcome;
          };
          // What the transaction opens with, told in the App's tables, said in this source's (writeAhead.ts).
          const ahead = renamedWriteAhead(writeAhead(), (table: string) => physical.get(table));
          const result = await withWriteAhead(ahead, () =>
            command
              ? commandsOf(dbAdapter).scopeVerifiedCommandTransaction(
                  physicalScope,
                  verify,
                  kind.journalOwner(owner, input.evidence),
                  work,
                  physicalBound,
                )
              : dbAdapter.scopeVerifiedTransaction(physicalScope, verify, (records) => work(records)),
          );
          completed = true;
          committed(owner, wrote);
          // A late lifetime refusal after confirmed COMMIT is never not_applied.
          live();
          return result;
        } catch (error) {
          const unknown =
            completed ||
            error instanceof TransactionOutcomeUnknown ||
            (error instanceof CommandTransactionFailure && error.outcome === 'unknown');
          // Never let a later request reuse a failed or uncertain writer: it
          // closes and reopens once it is safe (writerLifecycle). Confirmed
          // ordinary rollbacks can retry.
          if (
            error instanceof TransactionOutcomeUnknown ||
            (error instanceof CommandTransactionFailure && error.outcome === 'unknown') ||
            (attempted && !entered)
          )
            life.pause(receipt);
          if (moved && !completed && kind.moved) throw kind.moved();
          throw tenantWriteFailed(unknown ? 'unknown' : 'not_applied', error);
        }
      });
    };
    const markInboxRead = (mark: InboxMark): Promise<number> => {
      try {
        if (closing()) return denyTenant();
        assertInboxMark(mark);
      } catch (error) {
        return Promise.reject(tenantWriteFailed('not_applied', error));
      }
      const captured = captureTenantData(mark);
      return queue.run([], () => appStoresOf(life.handle()).markInboxRead(captured));
    };
    const writeBranding = (write: BrandingWrite): Promise<number> => {
      try {
        if (closing()) return denyTenant();
        assertBrandingWrite(write);
      } catch (error) {
        return Promise.reject(tenantWriteFailed('not_applied', error));
      }
      const captured = captureTenantData(write);
      return queue.run([], () => appStoresOf(life.handle()).writeBranding(captured));
    };
    const inboxMail = queuedInboxMail(mailOf(life.handle), (work) => queue.run([], work), closing);
    const source = Object.freeze<TenantWriteSource>({
      ownership: owned,
      ...tenantWriteMethods(transaction),
      markInboxRead,
      inboxMail,
      writeBranding,
      close,
    });
    sources.add(source);
    registerTenantSourceIdentity(source, { ...owner, canonicalPath: locator });
    return source;
  } catch (error) {
    try {
      await adapter?.close();
    } catch {
      /* No writer capability is published. */
    }
    throw tenantWriteFailed(error instanceof TransactionOutcomeUnknown ? 'unknown' : 'not_applied', error);
  }
}
