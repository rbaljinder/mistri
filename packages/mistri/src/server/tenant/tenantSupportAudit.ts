/**
 * The support audit on SQLite: the durable, chained record of a support
 * session inside a dealer's tenant, in the business file beside the tenant
 * store and the administration journal, under the reserved
 * `__mistri_support_` prefix. Names, shapes, validation and the MAC chain
 * are engine-neutral (tenantSupportAuditContract.ts); this file owns the
 * SQLite layout, its attestation and the owner-only composition.
 *
 * It lives in the business file on purpose: an audited write must commit in
 * the business write's own transaction, on the same writer and fence, so the
 * write and its record are all-or-nothing. That sharing is what
 * tenantWriteKindSupport.ts does, and the read ledger and the log routes are
 * in place; what is still missing is a request that reaches the sink. Here:
 * provisioning, attestation, open, append and verification.
 *
 * Every use attests the layout, the binding and the key id, which is cheap.
 * The whole-table structural checks (every session opened at seq 0, no
 * orphaned entry) run where a whole store is vouched for — provisioning and
 * maintenance verification — and an append verifies its own session's whole
 * chain first, so it never extends a chain that was altered.
 */
import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { isPromise, isProxy } from 'node:util/types';
import type { TransactionOperations } from '@mistriwork/engine/adapters/adapter.js';
import { captureTenantData, denyTenant } from '@mistriwork/engine/server/evidence.js';
import { assertSqliteTenantStore } from './tenantStore.js';
import { layoutRefusal, sqliteLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import { denyAgain, denyLayout, type TenantStoreBinding } from './tenantStoreContract.js';
import { identifier } from './tenantAdministrationJournalValidation.js';
import {
  auditKeyDiffers,
  captureSupportAuditHeader,
  SUPPORT_AUDIT_KEY_DIFFERS,
  type SupportAuditOwner,
} from './tenantSupportAuditContract.js';
import { auditTextProjection, captureAuditText } from './sqliteSupportAuditText.js';
import { SUPPORT_LOG_VISITS } from '../../shared/tenantSupportLog.js';
import {
  ENTRY_COLUMNS,
  ENTRY_SELECT,
  SESSION_COLUMNS,
  SESSION_SELECT,
  SUPPORT_AUDIT_PREFIX,
  SUPPORT_AUDIT_TABLES,
  type SupportLogRows,
  SUPPORT_AUDIT_VERSION,
  SUPPORT_DETAIL_BYTES,
  SUPPORT_END_REASONS,
  SUPPORT_ENTRY_KINDS,
  SUPPORT_KEY_BYTES,
  SUPPORT_NAME_BYTES,
  SUPPORT_REASON_BYTES,
  entryValues,
  keyId,
  planSupportAppend,
  planSupportOpen,
  sessionValues,
  supportAuditBinding as binding,
  supportAuditKey,
  verifySupportSession,
  type SupportAudit,
  type SupportAuditKey,
  type SupportAuditReport,
  type SupportEntry,
  type SupportEntryRow,
  type SupportSession,
  type SupportSessionRow,
} from './tenantSupportAuditContract.js';

const prefix = SUPPORT_AUDIT_PREFIX;
const tables = SUPPORT_AUDIT_TABLES;
const text = (name: string, maximum = 256) =>
  `${name} TEXT COLLATE BINARY NOT NULL CHECK (typeof(${name}) = 'text' AND length(CAST(${name} AS BLOB)) BETWEEN 1 AND ${maximum})`;
const optional = (name: string, maximum = 256) =>
  `${name} TEXT COLLATE BINARY CHECK (${name} IS NULL OR (typeof(${name}) = 'text' AND length(CAST(${name} AS BLOB)) BETWEEN 1 AND ${maximum}))`;
const counter = (name: string) => `${name} INTEGER NOT NULL CHECK (typeof(${name}) = 'integer' AND ${name} BETWEEN 0 AND 9007199254740991)`;
const digest = (name: string) =>
  `${name} TEXT COLLATE BINARY NOT NULL CHECK (typeof(${name}) = 'text' AND length(${name}) = 64 AND ${name} NOT GLOB '*[^0-9a-f]*')`;
const oneOf = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');
const definitions = new Map<string, string>([
  [
    tables.meta,
    `CREATE TABLE "${tables.meta}" (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = ${SUPPORT_AUDIT_VERSION}),
  ${text('app_id', 1024)},
  ${text('source_id')},
  ${text('store_id', 1024)},
  ${text('key_id', 16)}
)`,
  ],
  [
    tables.session,
    `CREATE TABLE "${tables.session}" (
  ${text('id', 1024)} PRIMARY KEY,
  ${text('tenant_id', 128)},
  ${text('account_id', 1024)},
  ${text('operator_name', SUPPORT_NAME_BYTES)},
  ${text('dealer_role')},
  ${text('parent_membership_id', 1024)},
  ${text('parent_membership_version', 64)},
  ${text('platform_version', 64)},
  ${text('reason', SUPPORT_REASON_BYTES)},
  ${text('opened_at', 32)},
  ${counter('valid_until')},
  ${text('native_session_id', 1024)},
  ${text('deployment')},
  ${text('policy_id')},
  ${text('policy_version')},
  ${text('open_receipt_id', 1024)},
  ${optional('ended_at', 32)},
  end_reason TEXT COLLATE BINARY CHECK (end_reason IS NULL OR end_reason IN (${oneOf(SUPPORT_END_REASONS)})),
  ${counter('head_seq')},
  ${digest('head_mac')},
  CHECK ((ended_at IS NULL) = (end_reason IS NULL))
)`,
  ],
  [
    tables.entry,
    `CREATE TABLE "${tables.entry}" (
  ${text('session_id', 1024)} REFERENCES "${tables.session}" (id) ON DELETE RESTRICT,
  ${counter('seq')},
  kind TEXT COLLATE BINARY NOT NULL CHECK (kind IN (${oneOf(SUPPORT_ENTRY_KINDS)})),
  ${text('at', 32)},
  ${text('request_id', 1024)},
  ${text('actor_id', 1024)},
  ${text('tenant_id', 128)},
  ${text('tenant_version', 64)},
  realm TEXT COLLATE BINARY NOT NULL CHECK (realm = 'tenant'),
  ${text('support_membership_version', 64)},
  ${text('parent_membership_version', 64)},
  ${text('platform_version', 64)},
  ${optional('resource')},
  ${optional('operation', 64)},
  key_json TEXT CHECK (key_json IS NULL OR (json_valid(key_json) AND length(CAST(key_json AS BLOB)) <= ${SUPPORT_KEY_BYTES})),
  detail_json TEXT NOT NULL CHECK (json_valid(detail_json) AND length(CAST(detail_json AS BLOB)) <= ${SUPPORT_DETAIL_BYTES.read}),
  ${optional('command_receipt_id', 1024)},
  ${digest('prev_mac')},
  ${digest('mac')},
  PRIMARY KEY (session_id, seq)
)`,
  ],
]);

/* A dealer's log is read by its tenant, newest first (readSqliteSupportLog):
   the one index this layout creates beyond its keys. */
const indexes = new Map<string, string>([
  [`${tables.session}_tenant`, `CREATE INDEX "${tables.session}_tenant" ON "${tables.session}" (tenant_id, opened_at, id)`],
]);

interface CatalogEntry {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}
const namedText = (names: readonly string[]) => names.map((name) => [name, name] as const);
const catalogText = namedText(['type', 'name', 'tbl_name', 'sql']);
const metaText = namedText(['app_id', 'source_id', 'store_id', 'key_id']);
const idText = namedText(['id']);
const camelText = (names: readonly string[], numeric: readonly string[]) =>
  names
    .filter((name) => !numeric.includes(name))
    .map((name) => [name, name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())] as const);
const sessionText = camelText(SESSION_COLUMNS, ['valid_until', 'head_seq']);
const entryText = camelText(ENTRY_COLUMNS, ['seq']);
function exactRows(rows: Record<string, unknown>[], fields: Parameters<typeof captureAuditText>[1]) {
  return rows.map((row) => {
    const value = captureAuditText(row, fields);
    if (!value.exact) return denyTenant();
    return value.row;
  });
}
function catalog(db: DatabaseSync, schema: 'main' | 'temp'): CatalogEntry[] {
  return exactRows(
    db
      .prepare(`SELECT type, name, tbl_name, sql, ${auditTextProjection(catalogText)} FROM ${schema}.sqlite_schema
    WHERE substr(name, 1, ?) = ? COLLATE NOCASE OR substr(tbl_name, 1, ?) = ? COLLATE NOCASE`)
      .all(prefix.length, prefix, prefix.length, prefix),
    catalogText,
  ) as unknown as CatalogEntry[];
}
function attest(db: DatabaseSync, owner: TenantStoreBinding, key: SupportAuditKey): void {
  assertSqliteTenantStore(db, owner);
  const entries = catalog(db, 'main');
  // Only the tables, their automatic key indexes and the named ones above: a
  // trigger, view or other index under the prefix is something this layout did not create.
  if (
    catalog(db, 'temp').length ||
    entries.filter((entry) => entry.type === 'table').length !== definitions.size ||
    entries.filter((entry) => entry.type === 'index' && entry.sql !== null).length !== indexes.size ||
    entries.some((entry) =>
      entry.type === 'table'
        ? definitions.get(entry.name) !== entry.sql
        : entry.type !== 'index' || (entry.sql === null ? !definitions.has(entry.tbl_name) : indexes.get(entry.name) !== entry.sql),
    )
  )
    return denyLayout(layoutRefusal('The support audit', sqliteLayoutVersion(db, tables.meta), SUPPORT_AUDIT_VERSION));
  const rows = exactRows(
    db
      .prepare(`SELECT singleton, version, app_id, source_id, store_id, key_id,
    ${auditTextProjection(metaText)} FROM main."${tables.meta}"`)
      .all(),
    metaText,
  );
  if (
    rows.length !== 1 ||
    rows[0].singleton !== 1 ||
    rows[0].version !== SUPPORT_AUDIT_VERSION ||
    rows[0].app_id !== owner.appId ||
    rows[0].source_id !== owner.source.id ||
    rows[0].store_id !== owner.storeId ||
    rows[0].key_id !== keyId(key)
  )
    denyLayout(
      auditKeyDiffers(rows[0], owner, key, SUPPORT_AUDIT_VERSION)
        ? SUPPORT_AUDIT_KEY_DIFFERS
        : layoutRefusal('The support audit', rows.length === 1 ? rows[0].version : undefined, SUPPORT_AUDIT_VERSION),
    );
}
/* The sessions whose rows no longer hang together: an entry whose session is
   gone, or a session with no opening entry. A chain that is merely edited is
   found by verification; these are what a deleted row leaves behind. */
function broken(db: DatabaseSync): string[] {
  return exactRows(
    db
      .prepare(`SELECT id, ${auditTextProjection(idText)} FROM (SELECT DISTINCT e.session_id AS id FROM main."${tables.entry}" e
      LEFT JOIN main."${tables.session}" s ON s.id = e.session_id WHERE s.id IS NULL
    UNION SELECT s.id FROM main."${tables.session}" s WHERE NOT EXISTS
      (SELECT 1 FROM main."${tables.entry}" e WHERE e.session_id = s.id AND e.seq = 0 AND e.kind = 'open')
    ) ORDER BY id`)
      .all(),
    idText,
  ).map((row) => {
    if (typeof row.id !== 'string') return denyTenant();
    return row.id;
  });
}
function readSession(db: DatabaseSync, id: string): { session: SupportSessionRow; entries: SupportEntryRow[]; exact: boolean } | null {
  const session = db
    .prepare(`SELECT ${SESSION_SELECT}, ${auditTextProjection(sessionText)} FROM main."${tables.session}" WHERE id = ?`)
    .get(id);
  if (!session) return null;
  const captured = captureAuditText(session, sessionText);
  const entries = db
    .prepare(`SELECT ${ENTRY_SELECT}, ${auditTextProjection(entryText)} FROM main."${tables.entry}" WHERE session_id = ? ORDER BY seq`)
    .all(id)
    .map((row) => captureAuditText(row, entryText));
  return {
    session: captured.row as unknown as SupportSessionRow,
    entries: entries.map((entry) => entry.row as unknown as SupportEntryRow),
    exact: captured.exact && entries.every((entry) => entry.exact),
  };
}

/**
 * Every session recorded against one tenant, newest first, with the entries
 * those sessions own. Stored history only: it verifies no chain, opens no
 * transaction of its own and admits nobody, so its caller must already hold
 * whatever proves who may read it.
 *
 * `tenantId` is the filter the dealer's log rests on, and it is applied in SQL
 * on the stored column. Another dealer's session is therefore never loaded at
 * all, rather than loaded and filtered out afterwards where a later mistake
 * could let it through.
 */
export function readSqliteSupportLog(db: DatabaseSync, tenantId: string | null): SupportLogRows {
  const where = tenantId === null ? '' : ' WHERE tenant_id = ?';
  const parameters = (tenantId === null ? [] : [tenantId]) as never[];
  // The newest visits, and one more to say whether older ones exist.
  const found = db
    .prepare(
      `SELECT ${SESSION_SELECT}, ${auditTextProjection(sessionText)} FROM main."${tables.session}"${where}` +
        ' ORDER BY opened_at DESC, id DESC LIMIT ?',
    )
    .all(...parameters, (SUPPORT_LOG_VISITS + 1) as never)
    .map((row) => captureAuditText(row, sessionText).row as unknown as SupportSessionRow);
  const sessions = found.slice(0, SUPPORT_LOG_VISITS);
  // Those visits' own entries, by their key; still filtered on the tenant.
  const entries = sessions.length
    ? db
        .prepare(
          `SELECT ${ENTRY_SELECT}, ${auditTextProjection(entryText)} FROM main."${tables.entry}"` +
            `${where ? `${where} AND` : ' WHERE'} session_id IN (${sessions.map(() => '?').join(', ')}) ORDER BY session_id, seq`,
        )
        .all(...parameters, ...(sessions.map((session) => session.id) as never[]))
        .map((row) => captureAuditText(row, entryText).row as unknown as SupportEntryRow)
    : [];
  return { sessions, entries, more: found.length > SUPPORT_LOG_VISITS };
}

export function assertSqliteSupportAudit(db: DatabaseSync, input: TenantStoreBinding, key: SupportAuditKey): void {
  try {
    attest(db, binding(input), key);
  } catch (error) {
    denyAgain(error);
  }
}

/** Explicit existing-file maintenance, after the tenant store: creates the
 * audit once under the given key (by default `MISTRI_AUDIT_KEY`), is
 * idempotent on the exact layout, binding and key, and refuses anything
 * else unchanged. Never upgrades, repairs or adopts a partial namespace. */
export function provisionSqliteSupportAudit(
  existingPath: string,
  input: TenantStoreBinding,
  key: SupportAuditKey = supportAuditKey(),
): { version: 1; provisioned: boolean } {
  let db: DatabaseSync | undefined;
  try {
    const owner = binding(input);
    if (typeof existingPath !== 'string' || !statSync(existingPath).isFile()) return denyTenant();
    db = new DatabaseSync(existingPath);
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    assertSqliteTenantStore(db, owner);
    if (catalog(db, 'temp').length) return denyTenant();
    const provisioned = catalog(db, 'main').length === 0;
    if (provisioned) {
      for (const ddl of definitions.values()) db.exec(ddl.replace('CREATE TABLE ', 'CREATE TABLE main.'));
      for (const [name, ddl] of indexes) db.exec(ddl.replace(`CREATE INDEX "${name}"`, `CREATE INDEX main."${name}"`));
      db.prepare(
        `INSERT INTO main."${tables.meta}" (singleton, version, app_id, source_id, store_id, key_id) VALUES (1, ?, ?, ?, ?, ?)`,
      ).run(SUPPORT_AUDIT_VERSION, owner.appId, owner.source.id, owner.storeId, keyId(key));
    }
    attest(db, owner, key);
    if (broken(db).length) return denyTenant();
    db.exec('COMMIT');
    return { version: 1, provisioned };
  } catch (error) {
    try {
      if (db?.isTransaction) db.exec('ROLLBACK');
    } catch {
      /* The local handle is discarded. */
    }
    // A layout or key the store refuses keeps its reason (denyAgain); anything else stays the fixed sentence.
    return denyAgain(error);
  } finally {
    try {
      db?.close();
    } catch {
      denyTenant();
    }
  }
}

/** Maintenance: verify every session's chain on a read-only handle. Refuses a
 * store that is not this layout, binding and key; reports, rather than
 * refuses, the sessions whose rows were altered, by id. */
export function verifySqliteSupportAudit(
  existingPath: string,
  input: TenantStoreBinding,
  key: SupportAuditKey = supportAuditKey(),
): SupportAuditReport {
  let db: DatabaseSync | undefined;
  try {
    const owner = binding(input);
    if (typeof existingPath !== 'string' || !statSync(existingPath).isFile()) return denyTenant();
    db = new DatabaseSync(existingPath, { readOnly: true });
    db.exec('BEGIN');
    attest(db, owner, key);
    const failed = new Set(broken(db));
    const ids = exactRows(
      db.prepare(`SELECT id, ${auditTextProjection(idText)} FROM main."${tables.session}" ORDER BY id`).all(),
      idText,
    ).map((row) => {
      if (typeof row.id !== 'string') return denyTenant();
      return row.id;
    });
    for (const id of ids) {
      const read = readSession(db, id)!;
      if (!read.exact || !verifySupportSession(key, owner, read.session, read.entries)) failed.add(id);
    }
    const entries = Number((db.prepare(`SELECT count(*) AS n FROM main."${tables.entry}"`).get() as { n: number }).n);
    db.exec('COMMIT');
    return { version: 1, sessions: ids.length, entries, failed: [...failed].sort() };
  } catch {
    try {
      if (db?.isTransaction) db.exec('ROLLBACK');
    } catch {
      /* The local handle is discarded. */
    }
    return denyTenant();
  } finally {
    try {
      db?.close();
    } catch {
      denyTenant();
    }
  }
}

const insertSession = `INSERT INTO main."${tables.session}" (${SESSION_COLUMNS.join(', ')}) VALUES (${SESSION_COLUMNS.map(() => '?').join(', ')})`;
const insertEntry = `INSERT INTO main."${tables.entry}" (${ENTRY_COLUMNS.join(', ')}) VALUES (${ENTRY_COLUMNS.map(() => '?').join(', ')})`;

/** Owner-only composition on the existing writer and queue, as the
 * administration journal: the owner drains that queue before ending the
 * transaction, and no handle escapes. */
export function createSqliteSupportAudit(
  db: DatabaseSync,
  operations: TransactionOperations,
  input: TenantStoreBinding,
  key: SupportAuditKey,
  assertActive?: () => void,
): SupportAudit {
  return composeSqliteSupportAudit(db, operations, input, key, assertActive).audit;
}

/** Private header reader on the caller's actual writer transaction. No admission. */
export function createSqliteSupportAuditOwner(
  db: DatabaseSync,
  operations: TransactionOperations,
  input: TenantStoreBinding,
  key: SupportAuditKey,
  assertActive?: () => void,
): SupportAuditOwner {
  return composeSqliteSupportAudit(db, operations, input, key, assertActive);
}

function composeSqliteSupportAudit(
  db: DatabaseSync,
  operations: TransactionOperations,
  input: TenantStoreBinding,
  key: SupportAuditKey,
  assertActive?: () => void,
): SupportAuditOwner {
  const owner = binding(input);
  keyId(key);
  if (assertActive !== undefined && (typeof assertActive !== 'function' || isProxy(assertActive))) return denyTenant();
  const verified = () => {
    if (!db.isTransaction) return denyTenant();
    attest(db, owner, key);
    if (assertActive) {
      const result = assertActive();
      if (isPromise(result)) void Promise.prototype.then.call(result, undefined, () => {});
      if (result !== undefined) return denyTenant();
    }
    if (!db.isTransaction) return denyTenant();
  };
  const invoke = <A, R>(value: A, work: (captured: A) => R): Promise<R> => {
    let captured: A,
      invalid = false;
    try {
      captured = captureTenantData(value);
    } catch {
      invalid = true;
    }
    const pending = operations
      .run(async () => {
        try {
          if (invalid) return denyTenant();
          verified();
          const result = work(captured!);
          verified();
          return result;
        } catch (error) {
          return denyAgain(error);
        }
      })
      .catch((error) => denyAgain(error));
    void pending.catch(() => {});
    return pending;
  };
  const audit: SupportAudit = Object.freeze({
    open: (session: SupportSession, entry: SupportEntry) =>
      invoke({ session, entry }, (value) => {
        const plan = planSupportOpen(key, owner, value.session, value.entry);
        db.prepare(insertSession).run(...(sessionValues(plan.session) as never[]));
        db.prepare(insertEntry).run(...(entryValues(plan.entry) as never[]));
      }),
    append: (sessionId: string, entry: SupportEntry) =>
      invoke({ sessionId, entry }, (value) => {
        const read = typeof value.sessionId === 'string' ? readSession(db, value.sessionId) : null;
        if (!read?.exact) return denyTenant();
        const plan = planSupportAppend(key, owner, read.session, read.entries, value.entry);
        db.prepare(insertEntry).run(...(entryValues(plan.entry) as never[]));
        const moved = db
          .prepare(`UPDATE main."${tables.session}" SET head_seq = ?, head_mac = ?, ended_at = ?, end_reason = ?
        WHERE id = ? AND head_seq = ? AND head_mac = ? AND ended_at IS NULL`)
          .run(
            plan.headSeq,
            plan.headMac,
            plan.end?.endedAt ?? null,
            plan.end?.endReason ?? null,
            read.session.id,
            read.session.headSeq,
            read.session.headMac,
          );
        if (moved.changes !== 1) denyTenant();
        return { seq: plan.headSeq };
      }),
    verify: (sessionId: string) =>
      invoke(sessionId, (id) => {
        const read = typeof id === 'string' ? readSession(db, id) : null;
        return read ? read.exact && verifySupportSession(key, owner, read.session, read.entries) : null;
      }),
  });
  return Object.freeze({
    audit,
    readHeader: (sessionId: string) =>
      invoke(sessionId, (id) => {
        identifier(id, 1024);
        const read = readSession(db, id);
        if (!read) return null;
        if (!read.exact || !verifySupportSession(key, owner, read.session, read.entries)) return denyTenant();
        return captureSupportAuditHeader(owner, read.session);
      }),
  });
}
