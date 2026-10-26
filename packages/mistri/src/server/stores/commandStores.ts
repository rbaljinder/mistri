/**
 * The command journal and a public placement's, made over the StoreHost a
 * dialect adapter lends (../storeHost.ts). The adapter runs a journal
 * transaction — BEGIN, the schema epoch, the scope, the drain, COMMIT and
 * the outcome — and knows no journal; the journals here own their tables,
 * the SQL that attests them and the receipt a command writes, as the App
 * stores beside them (appStores.ts) own theirs.
 *
 * What a caller is handed is what the adapter classes answered before: the
 * same capture of each scope, owner and admission before any I/O, the same
 * refusals, and the same transaction underneath. A facade (an App's
 * resources, a tenant's source) answers the same calls itself, so a source
 * is asked through commandsOf, which hands back a native adapter's journal
 * capabilities and anything else as it is.
 *
 * Made once per adapter, on first ask, as the App stores are.
 */
import type { DatabaseSync } from 'node:sqlite';
import { Refusal, type Adapter, type WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import type { MysqlAdapter } from '@mistriwork/engine/adapters/mysql.js';
import type { PostgresAdapter, PostgresTransactionVerifier } from '@mistriwork/engine/adapters/postgres.js';
import { isRuntimeRelation } from '@mistriwork/engine/adapters/postgresValues.js';
import type { SqliteAdapter } from '@mistriwork/engine/adapters/sqlite.js';
import {
  storeHostOf,
  writeViewOf,
  type PostgresStoreHost,
  type PostgresTransactionJournal,
  type SqliteStoreHost,
  type SqliteTransactionJournal,
  type StoreMeta,
} from '@mistriwork/engine/adapters/storeHost.js';
import { sameTables } from '@mistriwork/engine/adapters/scoped/scopedTransaction.js';
import type { SqliteScopeCatalog } from '@mistriwork/engine/adapters/scoped/sqliteScopeCatalog.js';
import { captureRowScope, type RowScope } from '@mistriwork/engine/shared/rowScope.js';
import { isRuntimeTable } from '@mistriwork/engine/shared/runtimeTables.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import {
  assertSqliteCommandJournal,
  captureCommandJournalMember,
  COMMAND_JOURNAL_TABLES,
  CommandTransactionFailure,
  createSqliteCommandJournal,
  JOURNAL_VERSION as SQLITE_JOURNAL_VERSION,
} from '../../adapters/commands/commandJournal.js';
import type {
  CommandJournal,
  CommandJournalAppScope,
  CommandJournalPlatform,
  CommandJournalTenant,
  StoredCommandReceipt,
} from '../../adapters/commands/commandJournalTypes.js';
import {
  assertPostgresCommandJournal,
  createPostgresCommandJournal,
  JOURNAL_VERSION as POSTGRES_JOURNAL_VERSION,
  postgresCommandLookupAhead,
} from '../../adapters/commands/postgresCommandJournal.js';
import { capturePostgresCommandVerifier } from '../../adapters/commands/postgresCommandTransaction.js';
import {
  admitPostgresPublicPlacement,
  admitSqlitePublicPlacement,
  capturePublicPlacementAdmission,
  capturePublicPlacementOwner,
  capturePublicPlacementScope,
  publicPlacementRecords,
} from '../../adapters/commands/publicPlacementTransaction.js';
import {
  createPostgresPublicPlacementJournal,
  createSqlitePublicPlacementJournal,
  readSqlitePublicPlacementReceipt,
  recoverPostgresPublicPlacementReceipt,
} from '../../adapters/commands/publicPlacementJournal.js';
import { assertSqlitePublicPlacementJournal, pinPostgresPublicPlacementJournal } from '../../adapters/commands/publicPlacementSchema.js';
import type { PublicPlacementAdmission, PublicPlacementOwner, PublicPlacementRun } from '../../adapters/commands/publicPlacementTypes.js';

type Owner = CommandJournalTenant | CommandJournalPlatform | CommandJournalAppScope;
type CommandRun<T> = (records: WriteTransaction, journal: CommandJournal) => Promise<T>;
type ScopedCommandRun<T> = (records: WriteTransaction, journal: CommandJournal, catalog: DatabaseSchema) => Promise<T>;

/* The journal's meta row, read in the message that reads the schema epoch: its layout is attested once per epoch. */
const SQLITE_JOURNAL: StoreMeta = Object.freeze({ name: 'command', table: COMMAND_JOURNAL_TABLES.meta, version: SQLITE_JOURNAL_VERSION });
const POSTGRES_JOURNAL: StoreMeta = Object.freeze({
  name: 'command',
  table: COMMAND_JOURNAL_TABLES.meta,
  version: POSTGRES_JOURNAL_VERSION,
});

/* A command's failure says whether it might have committed: a receipt's recovery depends on it. */
const failure = (error: unknown, outcome: 'unknown' | 'not_applied') => new CommandTransactionFailure(error, outcome);

const sqliteCommandJournal = (owner?: Owner): SqliteTransactionJournal<CommandJournal> =>
  Object.freeze<SqliteTransactionJournal<CommandJournal>>({
    meta: SQLITE_JOURNAL,
    attest: assertSqliteCommandJournal,
    open: (db, operations, verified) => createSqliteCommandJournal(db, operations, owner, verified),
    failure,
  });

const postgresCommandJournal = (owner?: Owner): PostgresTransactionJournal<CommandJournal> =>
  Object.freeze<PostgresTransactionJournal<CommandJournal>>({
    meta: POSTGRES_JOURNAL,
    attest: assertPostgresCommandJournal,
    open: (client, operations) => createPostgresCommandJournal(client, operations, owner),
    failure,
    ahead: (receipt) => postgresCommandLookupAhead(owner, receipt),
  });

/* A public placement's journal is attested in every transaction (no meta row
   read with the epoch), admits its anchors after the scope catalog is read,
   and writes exactly its fixed rows. */
const sqlitePlacementJournal = (admission: PublicPlacementAdmission): SqliteTransactionJournal<CommandJournal> =>
  Object.freeze<SqliteTransactionJournal<CommandJournal>>({
    attest: assertSqlitePublicPlacementJournal,
    admit: (db, catalog, scope) => admitSqlitePublicPlacement(db, catalog, scope, admission),
    fixedRecords: publicPlacementRecords,
    open: (db, operations) => createSqlitePublicPlacementJournal(db, operations, admission),
    failure,
  });

const postgresPlacementJournal = (admission: PublicPlacementAdmission): PostgresTransactionJournal<CommandJournal> =>
  Object.freeze<PostgresTransactionJournal<CommandJournal>>({
    attest: pinPostgresPublicPlacementJournal,
    admit: (client, catalog, scope) => admitPostgresPublicPlacement(client, catalog, scope, admission),
    fixedRecords: publicPlacementRecords,
    open: (client, operations) => createPostgresPublicPlacementJournal(client, operations, admission),
    failure,
  });

/** A dialect adapter's journal capabilities: the Adapter's command members, and the owner-only verified variants. */
interface NativeCommands {
  /** Same-source records and durable command receipt/audit, after explicit migration (Adapter.commandTransaction). */
  commandTransaction<T>(run: CommandRun<T>, events?: CommandJournalAppScope): Promise<T>;
  /** Private ordinary-command owner seam, deliberately absent from Adapter. The
   * trusted owner supplies native verification, never actor/receipt scope or
   * record filtering; it runs after BEGIN and journal attestation and after
   * the operations drain, before COMMIT. */
  verifiedCommandTransaction<T>(verify: () => unknown, run: CommandRun<T>, events?: CommandJournalAppScope): Promise<T>;
  /** Scoped records, the durable journal and fresh catalog evidence in one
   * transaction (Adapter.scopeCommandTransaction). The journal is attested
   * before the catalog is read, so an unmigrated layout refuses before any
   * lock is taken. */
  scopeCommandTransaction<T>(input: RowScope, run: ScopedCommandRun<T>, events?: CommandJournalAppScope): Promise<T>;
  /** Adapter.publicPlacementCommandTransaction. */
  publicPlacementCommandTransaction<T>(input: RowScope, admission: PublicPlacementAdmission, run: PublicPlacementRun<T>): Promise<T>;
  /** Adapter.publicPlacementReceipt. */
  publicPlacementReceipt(owner: PublicPlacementOwner, submission: string): Promise<StoredCommandReceipt | undefined>;
}

/** The verified command variant, owner-only and absent from Adapter: tenant
 * provenance comes from the pinned host, never a handler, and receipts join
 * the same queue and fence as the records. */
interface SqliteCommands extends NativeCommands {
  scopeVerifiedCommandTransaction<T>(
    input: RowScope,
    /** Synchronous, and may not retain the raw handle. */
    verify: (db: DatabaseSync, catalog: SqliteScopeCatalog) => void,
    tenant: CommandJournalTenant | CommandJournalPlatform,
    run: ScopedCommandRun<T>,
    /** The outer bound the scope sits inside (scopedTransaction.ts ScopeBound), over the same tables. */
    boundInput?: RowScope,
  ): Promise<T>;
}

interface PostgresCommands extends NativeCommands {
  scopeVerifiedCommandTransaction<T>(
    input: RowScope,
    verify: PostgresTransactionVerifier,
    tenant: CommandJournalTenant | CommandJournalPlatform,
    run: ScopedCommandRun<T>,
    /** The outer bound the scope sits inside (scopedTransaction.ts ScopeBound), over the same tables. */
    boundInput?: RowScope,
  ): Promise<T>;
}

function sqliteCommands(host: SqliteStoreHost): SqliteCommands {
  return {
    commandTransaction: (run, events) => host.journalTransaction(sqliteCommandJournal(events), run),
    // The host refuses a forged source, a proxied or non-function verifier and a closed adapter.
    verifiedCommandTransaction: (verify, run, events) =>
      host.journalTransaction(sqliteCommandJournal(events), run, { ordinaryVerify: verify }),
    scopeCommandTransaction: async (input, run, events) => {
      const scope = captureRowScope(input);
      if (Object.keys(scope).some(isRuntimeTable)) throw new Refusal('Reserved resources are runtime-only.');
      if (host.closed()) throw new Refusal('This adapter is closed.');
      return host.journalTransaction(sqliteCommandJournal(events), (records, journal, catalog) => run(records, journal, catalog!), {
        scope,
      });
    },
    publicPlacementCommandTransaction: async (input, inputAdmission, run) => {
      const scope = capturePublicPlacementScope(input),
        admission = capturePublicPlacementAdmission(inputAdmission);
      if (host.closed() || typeof run !== 'function' || Object.keys(scope).some(isRuntimeTable))
        throw new Refusal('Public placement is unavailable.');
      return host.journalTransaction(sqlitePlacementJournal(admission), (records, journal, catalog) => run(records, journal, catalog!), {
        scope,
      });
    },
    publicPlacementReceipt: (owner, submission) => {
      if (host.closed()) throw new Refusal('This adapter is closed.');
      host.assertWriteIdentity();
      return readSqlitePublicPlacementReceipt(host.file(), owner, submission, () => host.assertWriteIdentity());
    },
    scopeVerifiedCommandTransaction: async (input, verify, tenant, run, boundInput) => {
      const scope = captureRowScope(input),
        owner = captureCommandJournalMember(tenant),
        bound = boundInput === undefined ? undefined : captureRowScope(boundInput);
      if (
        typeof verify !== 'function' ||
        typeof run !== 'function' ||
        !owner ||
        host.closed() ||
        Object.keys(scope).some(isRuntimeTable) ||
        (bound !== undefined && !sameTables(scope, bound))
      )
        throw new Refusal('This verified command transaction is unavailable.');
      return host.journalTransaction(sqliteCommandJournal(owner), (records, journal, catalog) => run(records, journal, catalog!), {
        scope,
        verify,
        bound,
      });
    },
  };
}

function postgresCommands(host: PostgresStoreHost): PostgresCommands {
  return {
    commandTransaction: (run, events) => host.journalTransaction(postgresCommandJournal(events), run),
    verifiedCommandTransaction: async (verify, run, events) => {
      if (!host.verifiedSource()) throw new Refusal('This verified command transaction is unavailable.');
      return host.journalTransaction(postgresCommandJournal(events), run, { ordinaryVerify: capturePostgresCommandVerifier(verify) });
    },
    scopeCommandTransaction: async (input, run, events) => {
      const scope = captureRowScope(input);
      if (Object.keys(scope).some(isRuntimeRelation)) throw new Refusal('Reserved resources are runtime-only.');
      return host.journalTransaction(postgresCommandJournal(events), (records, journal, catalog) => run(records, journal, catalog!), {
        scope,
      });
    },
    publicPlacementCommandTransaction: async (input, inputAdmission, run) => {
      const scope = capturePublicPlacementScope(input),
        admission = capturePublicPlacementAdmission(inputAdmission);
      if (typeof run !== 'function' || Object.keys(scope).some(isRuntimeRelation)) throw new Refusal('Public placement is unavailable.');
      return host.journalTransaction(postgresPlacementJournal(admission), (records, journal, catalog) => run(records, journal, catalog!), {
        scope,
      });
    },
    publicPlacementReceipt: (input, submission) => {
      const owner = capturePublicPlacementOwner(input);
      return host.readSnapshot((snapshot) => recoverPostgresPublicPlacementReceipt(snapshot.client, owner, submission));
    },
    scopeVerifiedCommandTransaction: async (input, verify, tenant, run, boundInput) => {
      const scope = captureRowScope(input),
        owner = captureCommandJournalMember(tenant),
        bound = boundInput === undefined ? undefined : captureRowScope(boundInput);
      if (
        typeof verify !== 'function' ||
        typeof run !== 'function' ||
        !owner ||
        Object.keys(scope).some(isRuntimeRelation) ||
        (bound !== undefined && !sameTables(scope, bound))
      )
        throw new Refusal('This verified command transaction is unavailable.');
      return host.journalTransaction(postgresCommandJournal(owner), (records, journal, catalog) => run(records, journal, catalog!), {
        scope,
        verify,
        bound,
      });
    },
  };
}

const made = new WeakMap<object, SqliteCommands | PostgresCommands>();

/** A constructed SQLite or PostgreSQL adapter's journal capabilities; undefined for anything else (MySQL keeps no journal; a facade or a proxy lends no host). */
export function nativeCommandsOf(adapter: SqliteAdapter): SqliteCommands;
export function nativeCommandsOf(adapter: PostgresAdapter): PostgresCommands;
export function nativeCommandsOf(adapter: unknown): SqliteCommands | PostgresCommands | undefined;
export function nativeCommandsOf(adapter: unknown): SqliteCommands | PostgresCommands | undefined {
  const host = storeHostOf(adapter);
  if (!host || host.dialect === 'mysql') return undefined;
  let commands = made.get(adapter as object);
  if (!commands) {
    commands = Object.freeze(host.dialect === 'postgres' ? postgresCommands(host) : sqliteCommands(host));
    made.set(adapter as object, commands);
  }
  return commands;
}

/** What a source answers for commands: the Adapter's command members. */
type CommandSource = Pick<
  Adapter,
  'commandTransaction' | 'scopeCommandTransaction' | 'publicPlacementCommandTransaction' | 'publicPlacementReceipt'
>;
const SOURCE_MEMBERS = [
  'commandTransaction',
  'scopeCommandTransaction',
  'publicPlacementCommandTransaction',
  'publicPlacementReceipt',
] as const;

/* A wrapper that narrowed an adapter's writes (writeViewOf) answers the
   ordinary and scoped journal of the adapter it wraps, its work handed the
   narrowed records and catalog — what the wrapper's own members did when
   the adapter carried the journal. Placement is not forwarded: it never was. */
function viewedCommandsOf(source: object): CommandSource | undefined {
  const view = writeViewOf(source);
  if (!view) return undefined;
  const under = commandsOf(view.over);
  const ordinary = under.commandTransaction,
    scoped = under.scopeCommandTransaction;
  return Object.freeze({
    ...(ordinary
      ? {
          commandTransaction: ((run, events) =>
            ordinary.call(under, (records, journal) => run(view.records(records), journal), events)) as Adapter['commandTransaction'],
        }
      : {}),
    ...(scoped
      ? {
          scopeCommandTransaction: ((scope, run, events) =>
            scoped.call(
              under,
              scope,
              (records, journal, catalog) => run(view.records(records), journal, view.catalog(catalog)),
              events,
            )) as Adapter['scopeCommandTransaction'],
        }
      : {}),
  });
}

/**
 * Where a source's commands are asked: a dialect adapter's own journal, or
 * the source itself when it is not one — an App's or a tenant's facade
 * answers the same calls, over the adapter it wraps. A source that keeps no
 * journal (MySQL, an HTTP source) answers none of them.
 *
 * A member set on the adapter object itself still answers in place of its
 * journal's, read when asked, as a method on the class was: what code that
 * wraps or withdraws an adapter's command capability does keeps working.
 * The owner-only verified variants never read the adapter object.
 */
export function commandsOf(adapter: SqliteAdapter): SqliteCommands;
export function commandsOf(adapter: PostgresAdapter): PostgresCommands;
export function commandsOf(adapter: MysqlAdapter): CommandSource;
export function commandsOf(source: object): CommandSource;
export function commandsOf(source: object): CommandSource {
  const native = nativeCommandsOf(source) ?? viewedCommandsOf(source);
  if (!native) return source as CommandSource;
  if (!SOURCE_MEMBERS.some((name) => name in source)) return native;
  const view: Record<string, unknown> = { ...native };
  for (const name of SOURCE_MEMBERS) {
    if (!(name in source)) continue;
    const member: unknown = Reflect.get(source, name);
    view[name] = typeof member === 'function' ? member.bind(source) : member;
  }
  return Object.freeze(view) as CommandSource;
}
