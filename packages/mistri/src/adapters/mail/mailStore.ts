/**
 * A tenant App's mail store, beside its job store in the tenant source: what
 * the platform keeps of mail that the App never sees, and of the links it
 * signs.
 *
 * - The log: every inbound message the webhook was handed, and what became
 *   of it — `applied`, `replayed`, or one the App never saw: `dropped` (an
 *   auto-reply, a list, a loop, a sender past its rate) or `unrouted`. An
 *   operator reads why a message did not arrive here, never in the App's
 *   rows, which only ever hold what it was given. Kept ninety days.
 * - The links: one row per signed link, by its nonce. A link opens only
 *   while its row is there and not revoked, so revoking is a row, and a
 *   leaked link stops working without rotating the secret every other link
 *   is signed with. Removed a day after it expires.
 *
 * Under the reserved runtime prefix, so no App lists, reads or writes it.
 * Provisioned with the jobs module's stores (provisionStores with a tenant
 * App's `jobs`, when the module declares mail) and attested
 * at enrollment, never created by a server that starts.
 *
 * Version 2 adds the version row `mistri migrate stores` reads
 * (storeLayouts.ts); version 1, as 0.8 provisioned it, kept none, and its
 * two tables are its marker. `migrate stores up` adds the row, and nothing
 * else changes.
 */
import { lstatSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describePostgresRelations } from '../commands/postgresRelations.js';
import { withPostgresMaintenanceTransaction } from '../commands/postgresCommandJournalSchema.js';
import { layoutRefusal, postgresLayoutVersion, sqliteLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import { RUNTIME_STORE_POOL } from '@mistriwork/engine/adapters/connectionBudget.js';
import { sharedPgConnections, type PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { runtimeName, runtimeSchema, runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';

const MAIL_PREFIX = '__mistri_mail_';
const MAIL_STORE_VERSION = 1;
const MAIL_TABLES = Object.freeze({
  meta: `${MAIL_PREFIX}meta`,
  log: `${MAIL_PREFIX}log`,
  link: `${MAIL_PREFIX}link`,
});
const t = MAIL_TABLES;
const MAIL_OUTCOMES = Object.freeze(['applied', 'replayed', 'refused', 'dropped', 'unrouted']);
const outcomes = MAIL_OUTCOMES.map((value) => `'${value}'`).join(',');
const LOG_DAYS = 90;
const DAY = 86_400_000;

/** The version row, on its own: what version 2 added to version 1 (the upgrade step runs these too). */
const MAIL_META_SQLITE = [
  `CREATE TABLE "${t.meta}" (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = ${MAIL_STORE_VERSION})
)`,
  `INSERT INTO "${t.meta}" (singleton, version) VALUES (1, ${MAIL_STORE_VERSION})`,
];
const MAIL_META_POSTGRES = [
  `CREATE TABLE ${runtimeTable('postgres', t.meta)} (
  singleton integer PRIMARY KEY CHECK (singleton = 1),
  version integer NOT NULL CHECK (version = ${MAIL_STORE_VERSION})
)`,
  `INSERT INTO ${runtimeTable('postgres', t.meta)} (singleton, version) VALUES (1, ${MAIL_STORE_VERSION})`,
];

const SQLITE = [
  ...MAIL_META_SQLITE,
  `CREATE TABLE "${t.log}" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  tenant_id TEXT,
  recipient TEXT NOT NULL,
  sender TEXT,
  message_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN (${outcomes})),
  reason TEXT
)`,
  `CREATE INDEX "${t.log}_at" ON "${t.log}" (at)`,
  `CREATE TABLE "${t.link}" (
  nonce TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  key_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
)`,
  `CREATE INDEX "${t.link}_record" ON "${t.link}" (tenant_id, resource, key_json)`,
  `CREATE INDEX "${t.link}_expires" ON "${t.link}" (expires_at)`,
];
const POSTGRES = [
  ...MAIL_META_POSTGRES,
  `CREATE TABLE ${runtimeTable('postgres', t.log)} (
  id bigserial PRIMARY KEY,
  at bigint NOT NULL,
  tenant_id text,
  recipient text NOT NULL,
  sender text,
  message_id text,
  outcome text NOT NULL CHECK (outcome IN (${outcomes})),
  reason text
)`,
  `CREATE INDEX "${t.log}_at" ON ${runtimeTable('postgres', t.log)} (at)`,
  `CREATE TABLE ${runtimeTable('postgres', t.link)} (
  nonce text PRIMARY KEY,
  tenant_id text NOT NULL,
  resource text NOT NULL,
  key_json text NOT NULL,
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  revoked_at bigint
)`,
  `CREATE INDEX "${t.link}_record" ON ${runtimeTable('postgres', t.link)} (tenant_id, resource, key_json)`,
  `CREATE INDEX "${t.link}_expires" ON ${runtimeTable('postgres', t.link)} (expires_at)`,
];

class MailStoreUnavailable extends Error {
  constructor(message = 'The mail store is unavailable.') {
    super(message);
    this.name = 'MailStoreUnavailable';
  }
}
const unavailable = (): never => {
  throw new MailStoreUnavailable();
};

/** One line of the log. */
export interface MailLogEntry {
  at: number;
  tenantId: string | null;
  recipient: string;
  sender: string | null;
  messageId: string | null;
  outcome: (typeof MAIL_OUTCOMES)[number];
  reason: string | null;
}

/** A signed link's row. */
interface MailLink {
  nonce: string;
  tenantId: string;
  resource: string;
  keyJson: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
}

/** Which links a revocation ends: one by its nonce, or every link to one record. */
type MailLinkSelector = Readonly<{ tenantId: string; nonce: string }> | Readonly<{ tenantId: string; resource: string; keyJson: string }>;

export interface MailStore {
  log(entry: MailLogEntry): Promise<void>;
  issueLink(link: Omit<MailLink, 'revokedAt'>): Promise<void>;
  link(nonce: string): Promise<MailLink | undefined>;
  revoke(selector: MailLinkSelector, at: number): Promise<number>;
  close(): Promise<void>;
}

/* ---------- SQLite ---------- */

function sqliteCatalog(db: DatabaseSync): string[] {
  return db
    .prepare(`SELECT name FROM main.sqlite_master WHERE lower(name) LIKE '${MAIL_PREFIX}%' ESCAPE '\\' ORDER BY name`)
    .all()
    .map((row) => String(row.name));
}
/** The data tables' catalog: the two tables and their indexes. */
const MAIL_TABLES_SQLITE = [`${t.link}`, `${t.link}_expires`, `${t.link}_record`, `${t.log}`, `${t.log}_at`].sort();
const EXPECTED = [...MAIL_TABLES_SQLITE, t.meta].sort();

/** The store is there, as provisioned: its tables, their indexes and its version row, nothing more. */
export function assertSqliteMailStore(db: DatabaseSync): void {
  let found: string[];
  try {
    found = sqliteCatalog(db);
  } catch {
    return unavailable();
  }
  const version = sqliteLayoutVersion(db, t.meta);
  if (JSON.stringify(found) !== JSON.stringify(EXPECTED) || version !== MAIL_STORE_VERSION) {
    const refusal = layoutRefusal('The mail store', version, MAIL_STORE_VERSION);
    throw refusal ? new MailStoreUnavailable(refusal) : new MailStoreUnavailable();
  }
}

function openFile(existingPath: string): DatabaseSync {
  if (typeof existingPath !== 'string' || !lstatSync(existingPath).isFile()) return unavailable();
  const db = new DatabaseSync(realpathSync(existingPath));
  db.exec('PRAGMA busy_timeout=2000');
  return db;
}

/** Explicit provisioning, idempotent: an existing store is left as it is. */
export function provisionSqliteMailStore(existingPath: string): {
  provisioned: boolean;
} {
  const db = openFile(existingPath);
  try {
    db.exec('BEGIN IMMEDIATE');
    const provisioned = !sqliteCatalog(db).length;
    if (provisioned) for (const ddl of SQLITE) db.exec(ddl);
    assertSqliteMailStore(db);
    db.exec('COMMIT');
    return { provisioned };
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error instanceof MailStoreUnavailable ? error : new MailStoreUnavailable();
  } finally {
    db.close();
  }
}

const linkOf = (row: Record<string, unknown>): MailLink => ({
  nonce: String(row.nonce),
  tenantId: String(row.tenant_id),
  resource: String(row.resource),
  keyJson: String(row.key_json),
  createdAt: Number(row.created_at),
  expiresAt: Number(row.expires_at),
  revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : Number(row.revoked_at),
});

function openSqliteMailStore(existingPath: string): MailStore {
  const db = openFile(existingPath);
  assertSqliteMailStore(db);
  let closed = false;
  const write = <T>(run: () => T): T => {
    if (closed) return unavailable();
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = run();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  };
  return Object.freeze({
    async log(entry: MailLogEntry) {
      write(() => {
        db.prepare(
          `INSERT INTO "${t.log}" (at, tenant_id, recipient, sender, message_id, outcome, reason) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          entry.at,
          entry.tenantId,
          entry.recipient.slice(0, 320),
          entry.sender?.slice(0, 320) ?? null,
          entry.messageId?.slice(0, 512) ?? null,
          entry.outcome,
          entry.reason?.slice(0, 500) ?? null,
        );
        db.prepare(`DELETE FROM "${t.log}" WHERE id IN (SELECT id FROM "${t.log}" WHERE at < ? LIMIT 100)`).run(entry.at - LOG_DAYS * DAY);
      });
    },
    async issueLink(link: Omit<MailLink, 'revokedAt'>) {
      write(() => {
        db.prepare(`INSERT INTO "${t.link}" (nonce, tenant_id, resource, key_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
          link.nonce,
          link.tenantId,
          link.resource,
          link.keyJson,
          link.createdAt,
          link.expiresAt,
        );
        db.prepare(`DELETE FROM "${t.link}" WHERE nonce IN (SELECT nonce FROM "${t.link}" WHERE expires_at < ? LIMIT 100)`).run(
          link.createdAt - DAY,
        );
      });
    },
    async link(nonce: string) {
      if (closed) return unavailable();
      const row = db.prepare(`SELECT * FROM "${t.link}" WHERE nonce = ?`).get(nonce);
      return row ? linkOf(row) : undefined;
    },
    async revoke(selector: MailLinkSelector, at: number) {
      return write(() =>
        Number(
          ('nonce' in selector
            ? db
                .prepare(`UPDATE "${t.link}" SET revoked_at = ? WHERE tenant_id = ? AND nonce = ? AND revoked_at IS NULL`)
                .run(at, selector.tenantId, selector.nonce)
            : db
                .prepare(
                  `UPDATE "${t.link}" SET revoked_at = ? WHERE tenant_id = ? AND resource = ? AND key_json = ? AND revoked_at IS NULL`,
                )
                .run(at, selector.tenantId, selector.resource, selector.keyJson)
          ).changes,
        ),
      );
    },
    async close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  });
}

/* ---------- PostgreSQL ---------- */

/** The data relations: the two tables and the log's id sequence. */
const MAIL_TABLES_POSTGRES = [
  `${runtimeSchema('postgres')}.${runtimeName('postgres', t.link)}`,
  `${runtimeSchema('postgres')}.${runtimeName('postgres', t.log)}`,
  `${runtimeSchema('postgres')}.${runtimeName('postgres', t.log)}_id_seq`,
];

/** The store is there, as provisioned: its tables, the log's id sequence and its version row, nothing more under the prefix. */
export async function assertPostgresMailStore(client: PgQuery): Promise<void> {
  let found: string[];
  try {
    found = (await describePostgresRelations(client, MAIL_PREFIX)).map((relation) => `${relation.schema}.${relation.name}`).sort();
  } catch {
    return unavailable();
  }
  const version = await postgresLayoutVersion(client, runtimeTable('postgres', t.meta));
  if (
    JSON.stringify(found) !==
      JSON.stringify([...MAIL_TABLES_POSTGRES, `${runtimeSchema('postgres')}.${runtimeName('postgres', t.meta)}`].sort()) ||
    version !== MAIL_STORE_VERSION
  ) {
    const refusal = layoutRefusal('The mail store', version, MAIL_STORE_VERSION);
    throw refusal ? new MailStoreUnavailable(refusal) : new MailStoreUnavailable();
  }
}

/** Explicit provisioning under the shared migration lock, idempotent. */
export async function migratePostgresMailStore(url: string): Promise<{ provisioned: boolean }> {
  return withPostgresMaintenanceTransaction(url, async (client) => {
    const provisioned = !(await describePostgresRelations(client, MAIL_PREFIX)).length;
    if (provisioned) for (const ddl of POSTGRES) await client.query(ddl);
    await assertPostgresMailStore(client);
    return { provisioned };
  });
}

async function openPostgresMailStore(url: string): Promise<MailStore> {
  const pg = sharedPgConnections(url, RUNTIME_STORE_POOL);
  try {
    await pg.withWriteClient((client) => assertPostgresMailStore(client));
  } catch (error) {
    await pg.close().catch(() => {});
    throw error;
  }
  const query = (text: string, values: unknown[]) => pg.withWriteClient((client) => client.query(text, values));
  return Object.freeze({
    async log(entry: MailLogEntry) {
      await query(
        `WITH old AS (DELETE FROM ${runtimeTable('postgres', t.log)} WHERE id IN (SELECT id FROM ${runtimeTable('postgres', t.log)} WHERE at < $8 LIMIT 100))
         INSERT INTO ${runtimeTable('postgres', t.log)} (at, tenant_id, recipient, sender, message_id, outcome, reason) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          entry.at,
          entry.tenantId,
          entry.recipient.slice(0, 320),
          entry.sender?.slice(0, 320) ?? null,
          entry.messageId?.slice(0, 512) ?? null,
          entry.outcome,
          entry.reason?.slice(0, 500) ?? null,
          entry.at - LOG_DAYS * DAY,
        ],
      );
    },
    async issueLink(link: Omit<MailLink, 'revokedAt'>) {
      await query(
        `WITH old AS (DELETE FROM ${runtimeTable('postgres', t.link)} WHERE nonce IN (SELECT nonce FROM ${runtimeTable('postgres', t.link)} WHERE expires_at < $7 LIMIT 100))
         INSERT INTO ${runtimeTable('postgres', t.link)} (nonce, tenant_id, resource, key_json, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [link.nonce, link.tenantId, link.resource, link.keyJson, link.createdAt, link.expiresAt, link.createdAt - DAY],
      );
    },
    async link(nonce: string) {
      const found = await query(`SELECT * FROM ${runtimeTable('postgres', t.link)} WHERE nonce = $1`, [nonce]);
      return found.rows[0] ? linkOf(found.rows[0] as Record<string, unknown>) : undefined;
    },
    async revoke(selector: MailLinkSelector, at: number) {
      const done =
        'nonce' in selector
          ? await query(
              `UPDATE ${runtimeTable('postgres', t.link)} SET revoked_at = $1 WHERE tenant_id = $2 AND nonce = $3 AND revoked_at IS NULL`,
              [at, selector.tenantId, selector.nonce],
            )
          : await query(
              `UPDATE ${runtimeTable('postgres', t.link)} SET revoked_at = $1 WHERE tenant_id = $2 AND resource = $3 AND key_json = $4 AND revoked_at IS NULL`,
              [at, selector.tenantId, selector.resource, selector.keyJson],
            );
      return done.rowCount ?? 0;
    },
    close: () => pg.close(),
  });
}

/** The store over a tenant source's target, as the job store is opened. */
export function openMailStore(target: Readonly<{ sqlite: string }> | Readonly<{ postgres: string }>): Promise<MailStore> {
  return 'sqlite' in target ? Promise.resolve(openSqliteMailStore(target.sqlite)) : openPostgresMailStore(target.postgres);
}
