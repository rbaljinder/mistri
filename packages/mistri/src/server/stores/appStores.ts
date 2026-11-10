/**
 * The App stores a dialect adapter's database holds — the notification
 * inbox, branding, the record history, the read audit — made over the StoreHost the adapter
 * lends (../storeHost.ts). The adapter is the engine's and has no store
 * methods; the App framework asks here instead.
 *
 * Made once per adapter, on first ask: what one is depends only on the
 * adapter, which is why asking again hands back the same.
 */
import type { PostgresAdapter } from '@mistriwork/engine/adapters/postgres.js';
import type { SqliteAdapter } from '@mistriwork/engine/adapters/sqlite.js';
import { storeHostOf, type PostgresStoreHost, type SqliteStoreHost, type StoreMeta } from '@mistriwork/engine/adapters/storeHost.js';
import { storeDef } from '../storeLayouts.js';
import { INBOX_TABLES } from '../../adapters/inbox/inboxTables.js';
import { INBOX_VERSION, type InboxMark, type InboxQuery, type StoredNotice } from '../../adapters/inbox/inbox.js';
import type { InboxMailStore } from '../../adapters/inbox/inboxMail.js';
import { markPostgresInboxRead, postgresInboxMail, readPostgresInbox } from '../../adapters/inbox/postgresInbox.js';
import { markSqliteInboxRead, readSqliteInbox, sqliteInboxMail } from '../../adapters/inbox/sqliteInbox.js';
import { BRANDING_TABLES, BRANDING_VERSION, type BrandingWrite } from '../../adapters/branding/branding.js';
import { writePostgresBranding } from '../../adapters/branding/postgresBranding.js';
import { writeSqliteBranding } from '../../adapters/branding/sqliteBranding.js';
import {
  RECORD_HISTORY_TABLES,
  RECORD_HISTORY_VERSION,
  type RecordActivityQuery,
  type RecordHistoryQuery,
  type StoredRecordChange,
} from '../../adapters/history/recordHistory.js';
import { readPostgresRecordActivity, readPostgresRecordHistory } from '../../adapters/history/postgresRecordHistory.js';
import { readSqliteRecordActivity, readSqliteRecordHistory } from '../../adapters/history/sqliteRecordHistory.js';
import {
  READ_AUDIT_TABLES,
  READ_AUDIT_VERSION,
  type ReadAuditQuery,
  type ReadAuditRow,
  assertReadAuditRow,
  type StoredReadAudit,
} from '../../adapters/readAudit/readAudit.js';
import { groupCommit } from '../../adapters/readAudit/groupCommit.js';
import { appendPostgresReadAudits, readPostgresReadAudit } from '../../adapters/readAudit/postgresReadAudit.js';
import { appendSqliteReadAudits, readSqliteReadAudit } from '../../adapters/readAudit/sqliteReadAudit.js';

/* The meta rows the host's epoch read names; `name` keys the attestation as the adapters always did. */
const INBOX: StoreMeta = Object.freeze({ name: 'inbox', table: INBOX_TABLES.meta, version: INBOX_VERSION });
const BRANDING: StoreMeta = Object.freeze({ name: 'branding', table: BRANDING_TABLES.meta, version: BRANDING_VERSION });
/* Whether a database holds each store is the store list's to say (server/storeLayouts.ts). */
const INBOX_ATTEST = storeDef('inbox').attest!,
  BRANDING_ATTEST = storeDef('branding').attest!,
  HISTORY_ATTEST = storeDef('record-history').attest!;
const HISTORY: StoreMeta = Object.freeze({ name: 'history', table: RECORD_HISTORY_TABLES.meta, version: RECORD_HISTORY_VERSION });
const READ_AUDIT: StoreMeta = Object.freeze({ name: 'read-audit', table: READ_AUDIT_TABLES.meta, version: READ_AUDIT_VERSION });
const READ_AUDIT_ATTEST = storeDef('read-audit').attest!;

/** Private runtime capabilities over one database, for the server to project for its readers; none is on the public Adapter. */
interface AppStores {
  /** Whether the database holds the notification store at this version. */
  inboxReady(): Promise<boolean>;
  /** One person's stored notices. */
  readInbox(query: InboxQuery): Promise<StoredNotice[]>;
  /** One person's notices marked read, on a writer, in the write queue. */
  markInboxRead(mark: InboxMark): Promise<number>;
  /** The outbox and the email opt-outs, on a writer, in the write queue. */
  inboxMail(): InboxMailStore;
  /** Whether the database holds the record history store at this version. */
  recordHistoryReady(): Promise<boolean>;
  /** One record's stored history. */
  readRecordHistory(query: RecordHistoryQuery): Promise<StoredRecordChange[]>;
  /** The newest stored changes across resources, for a dashboard's activity. */
  readRecordActivity(query: RecordActivityQuery): Promise<StoredRecordChange[]>;
  /** Whether the database holds the read audit store at this version. */
  readAuditReady(): Promise<boolean>;
  /** One read, resolved once the group commit that carries it is durable: before the rows it names leave (server/readAudit.ts). */
  appendReadAudit(row: ReadAuditRow): Promise<void>;
  /** Rows written together on one writer, all or none: a group commit's flush, for a caller that gathers its own (a tenant's queue). */
  appendReadAudits(rows: readonly ReadAuditRow[]): Promise<void>;
  /** The stored reads, newest first. */
  readReadAudit(query: ReadAuditQuery): Promise<StoredReadAudit[]>;
  /** Whether the database holds the branding store at this version. */
  brandingReady?(): Promise<boolean>;
  /** One tenant's branding saved, with its logo, in one transaction on a writer. */
  writeBranding?(write: BrandingWrite): Promise<number>;
}

/* A malformed row is refused on its own, before it joins a batch whose other rows it would fail. */
function readAuditAppends(
  flush: (rows: readonly ReadAuditRow[]) => Promise<void>,
  admit: () => void = () => {},
): Pick<AppStores, 'appendReadAudit' | 'appendReadAudits'> {
  return {
    appendReadAudit: groupCommit(flush, (row) => {
      assertReadAuditRow(row);
      admit();
    }),
    appendReadAudits: flush,
  };
}

function postgresStores(host: PostgresStoreHost): AppStores {
  return {
    inboxReady: () => host.withReadClient((client) => INBOX_ATTEST.postgres!(client)),
    readInbox: (query) =>
      host.withReadClient((client) => host.attestedStore(client, INBOX, (attested) => readPostgresInbox(client, query, attested))),
    markInboxRead: (mark) =>
      host.withWriteClient((client) => host.attestedStore(client, INBOX, (attested) => markPostgresInboxRead(client, mark, attested))),
    inboxMail: () => postgresInboxMail((work) => host.withWriteClient(work)),
    recordHistoryReady: () => host.withReadClient((client) => HISTORY_ATTEST.postgres!(client)),
    readRecordHistory: (query) =>
      host.withReadClient((client) =>
        host.attestedStore(client, HISTORY, (attested) => readPostgresRecordHistory(client, query, attested)),
      ),
    readRecordActivity: (query) =>
      host.withReadClient((client) =>
        host.attestedStore(client, HISTORY, (attested) => readPostgresRecordActivity(client, query, attested)),
      ),
    readAuditReady: () => host.withReadClient((client) => READ_AUDIT_ATTEST.postgres!(client)),
    /* One writer checkout and one INSERT for each batch, not each read (groupCommit.ts). */
    ...readAuditAppends((rows) =>
      host.withWriteClient((client) =>
        host.attestedStore(client, READ_AUDIT, (attested) => appendPostgresReadAudits(client, rows, attested)),
      ),
    ),
    readReadAudit: (query) =>
      host.withReadClient((client) => host.attestedStore(client, READ_AUDIT, (attested) => readPostgresReadAudit(client, query, attested))),
    brandingReady: () => host.withReadClient((client) => BRANDING_ATTEST.postgres!(client)),
    /* The epoch is read before BEGIN: a failed read inside the transaction would abort the save with it. */
    writeBranding: (write) =>
      host.withWriteClient((client) =>
        host.attestedStore(client, BRANDING, async (attested) => {
          await client.query('BEGIN');
          try {
            const revision = await writePostgresBranding(client, write, attested);
            await client.query('COMMIT');
            return revision;
          } catch (error) {
            try {
              await client.query('ROLLBACK');
            } catch {
              /* Preserve the save's failure. */
            }
            throw error;
          }
        }),
      ),
  };
}

function sqliteStores(host: SqliteStoreHost): AppStores {
  return {
    inboxReady: () => INBOX_ATTEST.sqlite!(host.reader()),
    readInbox: async (query) => host.attestedStore(INBOX, (attested) => readSqliteInbox(host.reader(), query, attested)),
    markInboxRead: (mark) =>
      host.queueWrite((write) => host.attestedStore(INBOX, (attested) => markSqliteInboxRead(write, mark, attested), write)),
    inboxMail: () => sqliteInboxMail((work) => host.queueWrite(work)),
    recordHistoryReady: () => HISTORY_ATTEST.sqlite!(host.reader()),
    readRecordHistory: async (query) => host.attestedStore(HISTORY, (attested) => readSqliteRecordHistory(host.reader(), query, attested)),
    readRecordActivity: async (query) =>
      host.attestedStore(HISTORY, (attested) => readSqliteRecordActivity(host.reader(), query, attested)),
    readAuditReady: () => READ_AUDIT_ATTEST.sqlite!(host.reader()),
    // Its epoch rides in each insert itself (sqliteReadAudit.ts); a batch is one place in the write queue and one commit.
    ...readAuditAppends(
      (rows) => host.queueWrite((write) => appendSqliteReadAudits(write, rows)),
      () => host.assertIndependentWrite(),
    ),
    readReadAudit: async (query) => host.attestedStore(READ_AUDIT, (attested) => readSqliteReadAudit(host.reader(), query, attested)),
    brandingReady: () => BRANDING_ATTEST.sqlite!(host.reader()),
    writeBranding: (write) =>
      host.queueWrite((handle) => {
        handle.exec('BEGIN IMMEDIATE');
        try {
          const revision = host.attestedStore(BRANDING, (attested) => writeSqliteBranding(handle, write, attested), handle);
          handle.exec('COMMIT');
          return revision;
        } catch (error) {
          try {
            if (handle.isTransaction) handle.exec('ROLLBACK');
          } catch {
            /* Preserve the save's failure. */
          }
          throw error;
        }
      }),
  };
}

const made = new WeakMap<object, AppStores>();

/** Branding is kept on SQLite and PostgreSQL. */
type BrandedAppStores = AppStores & Required<Pick<AppStores, 'brandingReady' | 'writeBranding'>>;

/** The App stores over a constructed dialect adapter, or undefined for anything that lends none. */
export function appStoresOf(adapter: SqliteAdapter | PostgresAdapter): BrandedAppStores;
export function appStoresOf(adapter: unknown): AppStores | undefined;
export function appStoresOf(adapter: unknown): AppStores | undefined {
  const host = storeHostOf(adapter);
  if (!host) return undefined;
  let stores = made.get(adapter as object);
  if (!stores) {
    stores = Object.freeze(host.dialect === 'postgres' ? postgresStores(host) : sqliteStores(host));
    made.set(adapter as object, stores);
  }
  return stores;
}

/**
 * Where a source's App stores are read: a dialect adapter's own, or the
 * source itself when it is not one — a tenant's facade answers the same
 * calls, bound to its tenant.
 */
export const storesOf = <T>(source: T): T | AppStores => appStoresOf(source) ?? source;
