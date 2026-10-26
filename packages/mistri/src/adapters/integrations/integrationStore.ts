/**
 * The integrations store, beside an App's records in its commands' source:
 * what core keeps so that no integration package ever has to.
 *
 * - secret: each integration's secrets, per tenant ('' for an App without
 *   tenants), sealed by the server (integrationSecrets.ts) before they reach
 *   a row. A row holds ciphertext alone; its name and who saved it are what
 *   the settings screen shows.
 * - call: one row per action call, by the key it was sent with. A call made
 *   again with the same key (a retry, a replayed command) is answered from
 *   here and never reaches the provider twice.
 * - seen: a verified inbound delivery (a defineInbound endpoint's, or an
 *   integration's webhook lowered onto one), while its window is open: the
 *   same delivery again is a replay and is refused.
 * - consent: a recipient's opt-out (or opt-in again) on a channel, per
 *   tenant, by a digest of the address: core checks it before every send.
 * - message: every channel message and what became of it — sent, held for
 *   quiet hours, suppressed, failed: the inbox record an operator reads. A
 *   notice sent on a channel is queued here by the write that tells it, in
 *   that write's transaction (`queued`, with the consent and zone the record
 *   said), and decided and sent after it commits, as a command's message is.
 *   Version 2 keeps who made the write (`actor_kind`: an account, a service,
 *   a public visitor, or one who proved the address), which decides whether
 *   an email to an address a visitor typed may go, and an index by recipient
 *   that the email channel's caps count sent rows through.
 *
 * Under the reserved runtime prefix, so no App lists, reads or writes it.
 * Provisioned explicitly (provisionStores in @mistriwork/mistri/maintenance, `only:
 * ['integrations']` or with a jobs module that lists integrations) and attested at
 * open; never created by a server that starts.
 */
import { lstatSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describePostgresRelations } from '../commands/postgresRelations.js';
import { withPostgresMaintenanceTransaction } from '../commands/postgresCommandJournalSchema.js';
import { layoutRefusal, postgresLayoutVersion, sqliteLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import { PgConnectionManager, type PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { beforeCommit } from '@mistriwork/engine/adapters/postgresTransactionHandle.js';
import { runtimeName, runtimeSchema, runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';

const INTEGRATION_PREFIX = '__mistri_integration_';
const INTEGRATION_VERSION = 1;
const t = Object.freeze({
  meta: `${INTEGRATION_PREFIX}meta`,
  secret: `${INTEGRATION_PREFIX}secret`,
  call: `${INTEGRATION_PREFIX}call`,
  seen: `${INTEGRATION_PREFIX}seen`,
  consent: `${INTEGRATION_PREFIX}consent`,
  message: `${INTEGRATION_PREFIX}message`,
});
const CALL_STATES = ['done', 'refused'] as const;
const CONSENT_STATES = ['out', 'in'] as const;
const MESSAGE_STATES = ['sent', 'held', 'suppressed', 'failed'] as const;
/** Who made the write that queued a notice: a signed-in account, the platform or a service, a public visitor, or a visitor
    who proved the address in the form (`link.email.verified`). A command's message keeps none. */
const ACTOR_KINDS = ['account', 'service', 'public', 'proven'] as const;
type ActorKind = (typeof ACTOR_KINDS)[number];
const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');
/* Messages and calls are kept ninety days: long enough to answer "did it go?", short enough not to become an archive. */
const KEEP_MS = 90 * 86_400_000;

/* Who made the write, and the index the email caps count by. */
const ACTOR_KIND_SQLITE = `actor_kind TEXT CHECK (actor_kind IN (${list(ACTOR_KINDS)}))`;
const ACTOR_KIND_POSTGRES = `actor_kind text CHECK (actor_kind IN (${list(ACTOR_KINDS)}))`;
const SQLITE_RECIPIENT_INDEX = `CREATE INDEX "${t.message}_recipient" ON "${t.message}" (app, channel, recipient, at)`;
const POSTGRES_RECIPIENT_INDEX = `CREATE INDEX "${t.message}_recipient" ON ${runtimeTable('postgres', t.message)} (app, channel, recipient, at)`;
const SQLITE_META = `CREATE TABLE "${t.meta}" (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = ${INTEGRATION_VERSION})
)`;
const POSTGRES_META = `CREATE TABLE ${runtimeTable('postgres', t.meta)} (
  singleton integer PRIMARY KEY CHECK (singleton = 1),
  version integer NOT NULL CHECK (version = ${INTEGRATION_VERSION})
)`;

const SQLITE = [
  SQLITE_META,
  `CREATE TABLE "${t.secret}" (
  app TEXT NOT NULL,
  tenant TEXT NOT NULL,
  integration TEXT NOT NULL,
  name TEXT NOT NULL,
  sealed TEXT NOT NULL,
  saved_by TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  PRIMARY KEY (app, tenant, integration, name)
)`,
  `CREATE TABLE "${t.call}" (
  app TEXT NOT NULL,
  key TEXT NOT NULL,
  tenant TEXT NOT NULL,
  integration TEXT NOT NULL,
  action TEXT NOT NULL,
  command TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (${list(CALL_STATES)})),
  result_json TEXT,
  reason TEXT,
  attempts INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (app, key)
)`,
  `CREATE INDEX "${t.call}_at" ON "${t.call}" (at)`,
  `CREATE TABLE "${t.seen}" (
  app TEXT NOT NULL,
  key TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (app, key)
)`,
  `CREATE INDEX "${t.seen}_expires" ON "${t.seen}" (expires_at)`,
  `CREATE TABLE "${t.consent}" (
  app TEXT NOT NULL,
  tenant TEXT NOT NULL,
  channel TEXT NOT NULL,
  holder TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (${list(CONSENT_STATES)})),
  source TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (app, tenant, channel, holder)
)`,
  `CREATE TABLE "${t.message}" (
  app TEXT NOT NULL,
  key TEXT NOT NULL,
  tenant TEXT NOT NULL,
  channel TEXT NOT NULL,
  recipient TEXT NOT NULL,
  text TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (${list(MESSAGE_STATES)})),
  reason TEXT,
  provider_id TEXT,
  due_at INTEGER,
  consent INTEGER CHECK (consent IN (0, 1)),
  timezone TEXT,
  attempts INTEGER NOT NULL,
  at INTEGER NOT NULL, ${ACTOR_KIND_SQLITE},
  PRIMARY KEY (app, key)
)`,
  `CREATE INDEX "${t.message}_due" ON "${t.message}" (app, state, due_at)`,
  `CREATE INDEX "${t.message}_at" ON "${t.message}" (at)`,
  SQLITE_RECIPIENT_INDEX,
];
const POSTGRES = [
  POSTGRES_META,
  `CREATE TABLE ${runtimeTable('postgres', t.secret)} (
  app text NOT NULL,
  tenant text NOT NULL,
  integration text NOT NULL,
  name text NOT NULL,
  sealed text NOT NULL,
  saved_by text NOT NULL,
  saved_at bigint NOT NULL,
  PRIMARY KEY (app, tenant, integration, name)
)`,
  `CREATE TABLE ${runtimeTable('postgres', t.call)} (
  app text NOT NULL,
  key text NOT NULL,
  tenant text NOT NULL,
  integration text NOT NULL,
  action text NOT NULL,
  command text NOT NULL,
  state text NOT NULL CHECK (state IN (${list(CALL_STATES)})),
  result_json text,
  reason text,
  attempts integer NOT NULL,
  at bigint NOT NULL,
  PRIMARY KEY (app, key)
)`,
  `CREATE INDEX "${t.call}_at" ON ${runtimeTable('postgres', t.call)} (at)`,
  `CREATE TABLE ${runtimeTable('postgres', t.seen)} (
  app text NOT NULL,
  key text NOT NULL,
  expires_at bigint NOT NULL,
  PRIMARY KEY (app, key)
)`,
  `CREATE INDEX "${t.seen}_expires" ON ${runtimeTable('postgres', t.seen)} (expires_at)`,
  `CREATE TABLE ${runtimeTable('postgres', t.consent)} (
  app text NOT NULL,
  tenant text NOT NULL,
  channel text NOT NULL,
  holder text NOT NULL,
  state text NOT NULL CHECK (state IN (${list(CONSENT_STATES)})),
  source text NOT NULL,
  at bigint NOT NULL,
  PRIMARY KEY (app, tenant, channel, holder)
)`,
  `CREATE TABLE ${runtimeTable('postgres', t.message)} (
  app text NOT NULL,
  key text NOT NULL,
  tenant text NOT NULL,
  channel text NOT NULL,
  recipient text NOT NULL,
  text text NOT NULL,
  state text NOT NULL CHECK (state IN (${list(MESSAGE_STATES)})),
  reason text,
  provider_id text,
  due_at bigint,
  consent integer CHECK (consent IN (0, 1)),
  timezone text,
  attempts integer NOT NULL,
  at bigint NOT NULL,
  ${ACTOR_KIND_POSTGRES},
  PRIMARY KEY (app, key)
)`,
  `CREATE INDEX "${t.message}_due" ON ${runtimeTable('postgres', t.message)} (app, state, due_at)`,
  `CREATE INDEX "${t.message}_at" ON ${runtimeTable('postgres', t.message)} (at)`,
  POSTGRES_RECIPIENT_INDEX,
];

class IntegrationStoreUnavailable extends Error {
  constructor(message = 'The integrations store is unavailable.') {
    super(message);
    this.name = 'IntegrationStoreUnavailable';
  }
}
const unavailable = (message?: string): never => {
  throw new IntegrationStoreUnavailable(message);
};

interface StoredSecret {
  readonly integration: string;
  readonly name: string;
  readonly sealed: string;
  readonly savedBy: string;
  readonly savedAt: number;
}
interface CallRow {
  readonly app: string;
  readonly key: string;
  readonly tenant: string;
  readonly integration: string;
  readonly action: string;
  readonly command: string;
  readonly state: (typeof CALL_STATES)[number];
  readonly resultJson: string | null;
  readonly reason: string | null;
  readonly attempts: number;
  readonly at: number;
}
interface ConsentRow {
  readonly app: string;
  readonly tenant: string;
  readonly channel: string;
  readonly holder: string;
  readonly state: (typeof CONSENT_STATES)[number];
  readonly source: string;
  readonly at: number;
}
export interface MessageRow {
  readonly app: string;
  readonly key: string;
  readonly tenant: string;
  readonly channel: string;
  readonly recipient: string;
  readonly text: string;
  readonly state: (typeof MESSAGE_STATES)[number];
  readonly reason: string | null;
  readonly providerId: string | null;
  readonly dueAt: number | null;
  /** A queued notice's: whether the App holds the recipient's consent, and the zone their quiet hours are read in. */
  readonly consent?: boolean | null;
  readonly timezone?: string | null;
  /** A queued notice's: who made the write that queued it. */
  readonly actorKind?: ActorKind | null;
  readonly attempts: number;
  readonly at: number;
}

/** What `notify ... via` queues, in the transaction of the write that tells it: decided and sent once it commits. */
export interface QueuedChannelNotice {
  readonly app: string;
  readonly key: string;
  readonly tenant: string;
  readonly channel: string;
  readonly recipient: string;
  readonly text: string;
  readonly consent: boolean;
  readonly timezone: string | null;
  readonly actorKind: ActorKind;
  readonly at: number;
}
/** The reason a queued notice is held under until the sender has decided it (integrationChannels.ts). */
export const QUEUED = 'queued';

export interface IntegrationStore {
  /** One tenant's sealed secrets for one integration, or every integration's when `integration` is left out. */
  secrets(app: string, tenant: string, integration?: string): Promise<readonly StoredSecret[]>;
  /** Save a sealed secret, or remove it with `sealed: null`. */
  saveSecret(
    row: Readonly<{
      app: string;
      tenant: string;
      integration: string;
      name: string;
      sealed: string | null;
      savedBy: string;
      at: number;
    }>,
  ): Promise<void>;
  call(app: string, key: string): Promise<CallRow | undefined>;
  recordCall(row: CallRow): Promise<void>;
  /** Record a delivery's key until `expiresAt`: true the first time, false when it is already there (a replay). */
  firstSeen(app: string, key: string, at: number, expiresAt: number): Promise<boolean>;
  /** Let a delivery's key go again: its first answer told the sender to retry, so the same bytes are not a replay. */
  forgetSeen(app: string, key: string): Promise<void>;
  consent(app: string, tenant: string, channel: string, holder: string): Promise<ConsentRow | undefined>;
  /** Newest wins: a row older than the one held (a provider's late resend of an old opt-out) changes nothing. */
  setConsent(row: ConsentRow): Promise<void>;
  message(app: string, key: string): Promise<MessageRow | undefined>;
  putMessage(row: MessageRow): Promise<void>;
  /** Held messages whose quiet hours are over, oldest first: one channel's, or every channel's. */
  due(app: string, now: number, limit: number, channel?: string): Promise<readonly MessageRow[]>;
  /** How many messages one tenant's writes sent on a channel since a moment, to one recipient or to anyone: what the email
      caps count. A tenant's caps are its own, as its consent is: one tenant's mail never spends another's. */
  sentSince(app: string, tenant: string, channel: string, since: number, recipient?: string): Promise<number>;
  /** One tenant's latest messages, newest first: what the settings screen and an operator read. */
  messages(app: string, tenant: string, limit: number): Promise<readonly MessageRow[]>;
  close(): Promise<void>;
}

const num = (value: unknown) => Number(value);
const nullable = (value: unknown) => (value === null || value === undefined ? null : String(value));
const secretOf = (row: Record<string, unknown>): StoredSecret => ({
  integration: String(row.integration),
  name: String(row.name),
  sealed: String(row.sealed),
  savedBy: String(row.saved_by),
  savedAt: num(row.saved_at),
});
const callOf = (row: Record<string, unknown>): CallRow => ({
  app: String(row.app),
  key: String(row.key),
  tenant: String(row.tenant),
  integration: String(row.integration),
  action: String(row.action),
  command: String(row.command),
  state: String(row.state) as CallRow['state'],
  resultJson: nullable(row.result_json),
  reason: nullable(row.reason),
  attempts: num(row.attempts),
  at: num(row.at),
});
const consentOf = (row: Record<string, unknown>): ConsentRow => ({
  app: String(row.app),
  tenant: String(row.tenant),
  channel: String(row.channel),
  holder: String(row.holder),
  state: String(row.state) as ConsentRow['state'],
  source: String(row.source),
  at: num(row.at),
});
const messageOf = (row: Record<string, unknown>): MessageRow => ({
  app: String(row.app),
  key: String(row.key),
  tenant: String(row.tenant),
  channel: String(row.channel),
  recipient: String(row.recipient),
  text: String(row.text),
  state: String(row.state) as MessageRow['state'],
  reason: nullable(row.reason),
  providerId: nullable(row.provider_id),
  dueAt: row.due_at === null || row.due_at === undefined ? null : num(row.due_at),
  consent: row.consent === null || row.consent === undefined ? null : num(row.consent) === 1,
  timezone: nullable(row.timezone),
  ...(row.actor_kind === null || row.actor_kind === undefined ? {} : { actorKind: String(row.actor_kind) as ActorKind }),
  attempts: num(row.attempts),
  at: num(row.at),
});
const clip = (value: string | null, most: number) => (value === null ? null : value.slice(0, most));

/* ---------- SQLite ---------- */

function sqliteCatalog(db: DatabaseSync): Array<{ type: string; name: string; sql: string | null }> {
  return db
    .prepare(
      `SELECT type, name, sql FROM main.sqlite_schema
    WHERE substr(name, 1, ?) = ? COLLATE NOCASE OR substr(tbl_name, 1, ?) = ? COLLATE NOCASE ORDER BY name`,
    )
    .all(INTEGRATION_PREFIX.length, INTEGRATION_PREFIX, INTEGRATION_PREFIX.length, INTEGRATION_PREFIX) as Array<{
    type: string;
    name: string;
    sql: string | null;
  }>;
}

/** Exactly this version's tables and indexes, as written (SQLite keeps each statement's text), and its version row. */
function sqliteIntegrationsReady(db: DatabaseSync): boolean {
  const written = new Set(SQLITE);
  const entries = sqliteCatalog(db);
  const own = entries.filter((entry) => entry.sql !== null);
  if (own.length !== written.size || own.some((entry) => !written.has(entry.sql!.replace(/^CREATE (TABLE|INDEX) main\./, 'CREATE $1 '))))
    return false;
  if (entries.some((entry) => entry.sql === null && entry.type !== 'index')) return false;
  const rows = db.prepare(`SELECT singleton, version FROM main."${t.meta}"`).all();
  return rows.length === 1 && rows[0].singleton === 1 && rows[0].version === INTEGRATION_VERSION;
}

/** The same, refused as the store being unavailable: what enrollment attests. */
export function assertSqliteIntegrations(db: DatabaseSync): void {
  let ready = false;
  try {
    ready = sqliteIntegrationsReady(db);
  } catch {
    ready = false;
  }
  if (!ready)
    unavailable(
      layoutRefusal('The integrations store', sqliteLayoutVersion(db, t.meta), INTEGRATION_VERSION) ??
        "The integrations store is not provisioned on this source. Run provisionStores({ sqlite: path }, { only: ['integrations'] }) from @mistriwork/mistri/maintenance with the server stopped.",
    );
}

function openFile(existingPath: string): DatabaseSync {
  if (typeof existingPath !== 'string' || !lstatSync(existingPath).isFile()) return unavailable();
  const db = new DatabaseSync(realpathSync(existingPath));
  db.exec('PRAGMA busy_timeout=5000');
  return db;
}

/**
 * Explicit maintenance, idempotent: a file without the store gets this
 * version; the same layout again changes nothing; anything else under the
 * prefix is refused unchanged.
 */
export function provisionSqliteIntegrations(existingPath: string): {
  version: number;
  provisioned: boolean;
} {
  const db = openFile(existingPath);
  try {
    db.exec('BEGIN IMMEDIATE');
    const provisioned = !sqliteCatalog(db).length;
    if (provisioned) {
      for (const ddl of SQLITE) db.exec(ddl);
      db.prepare(`INSERT INTO "${t.meta}" (singleton, version) VALUES (1, ?)`).run(INTEGRATION_VERSION);
    }
    assertSqliteIntegrations(db);
    db.exec('COMMIT');
    return { version: INTEGRATION_VERSION, provisioned };
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error instanceof IntegrationStoreUnavailable ? error : new IntegrationStoreUnavailable();
  } finally {
    db.close();
  }
}

function openSqliteIntegrationStore(existingPath: string): IntegrationStore {
  const db = openFile(existingPath);
  try {
    assertSqliteIntegrations(db);
  } catch (error) {
    db.close();
    throw error;
  }
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
  const read = <T>(run: () => T): T => (closed ? unavailable() : run());
  return Object.freeze<IntegrationStore>({
    async secrets(app, tenant, integration) {
      return read(() =>
        (integration === undefined
          ? db.prepare(`SELECT * FROM "${t.secret}" WHERE app = ? AND tenant = ? ORDER BY integration, name`).all(app, tenant)
          : db
              .prepare(`SELECT * FROM "${t.secret}" WHERE app = ? AND tenant = ? AND integration = ? ORDER BY name`)
              .all(app, tenant, integration)
        ).map((row) => secretOf(row as Record<string, unknown>)),
      );
    },
    async saveSecret(row) {
      write(() => {
        if (row.sealed === null)
          db.prepare(`DELETE FROM "${t.secret}" WHERE app = ? AND tenant = ? AND integration = ? AND name = ?`).run(
            row.app,
            row.tenant,
            row.integration,
            row.name,
          );
        else
          db.prepare(
            `INSERT INTO "${t.secret}" (app, tenant, integration, name, sealed, saved_by, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (app, tenant, integration, name) DO UPDATE SET sealed = excluded.sealed, saved_by = excluded.saved_by, saved_at = excluded.saved_at`,
          ).run(row.app, row.tenant, row.integration, row.name, row.sealed, row.savedBy.slice(0, 200), row.at);
      });
    },
    async call(app, key) {
      return read(() => {
        const row = db.prepare(`SELECT * FROM "${t.call}" WHERE app = ? AND key = ?`).get(app, key);
        return row ? callOf(row as Record<string, unknown>) : undefined;
      });
    },
    async recordCall(row) {
      write(() => {
        db.prepare(
          `INSERT INTO "${t.call}" (app, key, tenant, integration, action, command, state, result_json, reason, attempts, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (app, key) DO UPDATE SET state = excluded.state, result_json = excluded.result_json, reason = excluded.reason,
             attempts = excluded.attempts, at = excluded.at`,
        ).run(
          row.app,
          row.key,
          row.tenant,
          row.integration,
          row.action,
          row.command,
          row.state,
          row.resultJson,
          clip(row.reason, 500),
          row.attempts,
          row.at,
        );
        db.prepare(`DELETE FROM "${t.call}" WHERE rowid IN (SELECT rowid FROM "${t.call}" WHERE at < ? LIMIT 100)`).run(row.at - KEEP_MS);
      });
    },
    async firstSeen(app, key, at, expiresAt) {
      return write(() => {
        db.prepare(`DELETE FROM "${t.seen}" WHERE rowid IN (SELECT rowid FROM "${t.seen}" WHERE expires_at < ? LIMIT 100)`).run(at);
        return (
          db.prepare(`INSERT INTO "${t.seen}" (app, key, expires_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`).run(app, key, expiresAt)
            .changes === 1
        );
      });
    },
    async forgetSeen(app, key) {
      write(() => {
        db.prepare(`DELETE FROM "${t.seen}" WHERE app = ? AND key = ?`).run(app, key);
      });
    },
    async consent(app, tenant, channel, holder) {
      return read(() => {
        const row = db
          .prepare(`SELECT * FROM "${t.consent}" WHERE app = ? AND tenant = ? AND channel = ? AND holder = ?`)
          .get(app, tenant, channel, holder);
        return row ? consentOf(row as Record<string, unknown>) : undefined;
      });
    },
    async setConsent(row) {
      write(() => {
        db.prepare(
          `INSERT INTO "${t.consent}" AS held (app, tenant, channel, holder, state, source, at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (app, tenant, channel, holder) DO UPDATE SET state = excluded.state, source = excluded.source, at = excluded.at
           WHERE held.at <= excluded.at`,
        ).run(row.app, row.tenant, row.channel, row.holder, row.state, row.source.slice(0, 200), row.at);
      });
    },
    async message(app, key) {
      return read(() => {
        const row = db.prepare(`SELECT * FROM "${t.message}" WHERE app = ? AND key = ?`).get(app, key);
        return row ? messageOf(row as Record<string, unknown>) : undefined;
      });
    },
    async putMessage(row) {
      write(() => {
        db.prepare(
          `INSERT INTO "${t.message}" (app, key, tenant, channel, recipient, text, state, reason, provider_id, due_at, attempts, at, consent, timezone)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (app, key) DO UPDATE SET state = excluded.state, reason = excluded.reason, provider_id = excluded.provider_id,
             due_at = excluded.due_at, attempts = excluded.attempts, at = excluded.at`,
        ).run(
          row.app,
          row.key,
          row.tenant,
          row.channel,
          row.recipient.slice(0, 320),
          row.text.slice(0, 2000),
          row.state,
          clip(row.reason, 500),
          clip(row.providerId, 200),
          row.dueAt,
          row.attempts,
          row.at,
          row.consent === undefined || row.consent === null ? null : Number(row.consent),
          row.timezone ?? null,
        );
        db.prepare(
          `DELETE FROM "${t.message}" WHERE rowid IN (SELECT rowid FROM "${t.message}" WHERE at < ? AND state <> 'held' LIMIT 100)`,
        ).run(row.at - KEEP_MS);
      });
    },
    async due(app, now, limit, channel) {
      return read(() =>
        (channel === undefined
          ? db
              .prepare(`SELECT * FROM "${t.message}" WHERE app = ? AND state = 'held' AND due_at <= ? ORDER BY due_at LIMIT ?`)
              .all(app, now, limit)
          : db
              .prepare(
                `SELECT * FROM "${t.message}" WHERE app = ? AND state = 'held' AND due_at <= ? AND channel = ? ORDER BY due_at LIMIT ?`,
              )
              .all(app, now, channel, limit)
        ).map((row) => messageOf(row as Record<string, unknown>)),
      );
    },
    async sentSince(app, tenant, channel, since, recipient) {
      return read(() => {
        const row =
          recipient === undefined
            ? db
                .prepare(
                  `SELECT count(*) AS n FROM "${t.message}" WHERE app = ? AND tenant = ? AND channel = ? AND state = 'sent' AND at >= ?`,
                )
                .get(app, tenant, channel, since)
            : db
                .prepare(
                  `SELECT count(*) AS n FROM "${t.message}" WHERE app = ? AND tenant = ? AND channel = ? AND recipient = ? AND state = 'sent' AND at >= ?`,
                )
                .get(app, tenant, channel, recipient, since);
        return num(row?.n ?? 0);
      });
    },
    async messages(app, tenant, limit) {
      return read(() =>
        db
          .prepare(`SELECT * FROM "${t.message}" WHERE app = ? AND tenant = ? ORDER BY at DESC LIMIT ?`)
          .all(app, tenant, limit)
          .map((row) => messageOf(row as Record<string, unknown>)),
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

/* The tables by their names in the runtime schema; the indexes keep the names the DDL gives them. */
const POSTGRES_RELATIONS = [
  runtimeName('postgres', t.call),
  `${t.call}_at`,
  runtimeName('postgres', t.consent),
  runtimeName('postgres', t.message),
  `${t.message}_at`,
  `${t.message}_due`,
  `${t.message}_recipient`,
  runtimeName('postgres', t.meta),
  runtimeName('postgres', t.secret),
  runtimeName('postgres', t.seen),
  `${t.seen}_expires`,
];

/** The store is there, as provisioned: its tables, nothing more under the prefix, and its version row. */
export async function assertPostgresIntegrations(client: PgQuery): Promise<void> {
  let ready = false;
  try {
    const relations = await describePostgresRelations(client, INTEGRATION_PREFIX);
    const tables = relations.map((relation) => `${relation.schema}.${relation.name}`).sort();
    const indexes = relations.flatMap((relation) =>
      relation.indexes.map((index) => /^CREATE (?:UNIQUE )?INDEX (\S+)/.exec(index)?.[1] ?? ''),
    );
    const found = [
      ...tables.map((name) => name.replace(`${runtimeSchema('postgres')}.`, '')),
      ...indexes.filter((name) => !name.endsWith('_pkey')),
    ].sort();
    const rows = (await client.query(`SELECT singleton, version FROM ${runtimeTable('postgres', t.meta)}`)).rows as Array<
      Record<string, unknown>
    >;
    ready =
      tables.every((name) => name.startsWith(`${runtimeSchema('postgres')}.`)) &&
      JSON.stringify(found) === JSON.stringify([...POSTGRES_RELATIONS].sort()) &&
      rows.length === 1 &&
      Number(rows[0].version) === INTEGRATION_VERSION;
  } catch {
    ready = false;
  }
  if (!ready)
    unavailable(
      layoutRefusal('The integrations store', await postgresLayoutVersion(client, runtimeTable('postgres', t.meta)), INTEGRATION_VERSION) ??
        "The integrations store is not provisioned on this database. Run provisionStores({ postgres: url }, { only: ['integrations'] }) from @mistriwork/mistri/maintenance with the server stopped.",
    );
}

/** Explicit provisioning under the shared migration lock, idempotent. */
export async function provisionPostgresIntegrations(url: string): Promise<{ version: number; provisioned: boolean }> {
  return withPostgresMaintenanceTransaction(url, async (client) => {
    const provisioned = !(await describePostgresRelations(client, INTEGRATION_PREFIX)).length;
    if (provisioned) {
      for (const ddl of POSTGRES) await client.query(ddl);
      await client.query(`INSERT INTO ${runtimeTable('postgres', t.meta)} (singleton, version) VALUES (1, $1)`, [INTEGRATION_VERSION]);
    }
    await assertPostgresIntegrations(client);
    return { version: INTEGRATION_VERSION, provisioned };
  });
}

async function openPostgresIntegrationStore(url: string): Promise<IntegrationStore> {
  const pg = new PgConnectionManager(url);
  try {
    await pg.withWriteClient((client) => assertPostgresIntegrations(client));
  } catch (error) {
    await pg.close().catch(() => {});
    throw error;
  }
  const query = async (text: string, values: unknown[]) =>
    (await pg.withWriteClient((client) => client.query(text, values))).rows as Array<Record<string, unknown>>;
  const table = (name: string) => runtimeTable('postgres', name);
  return Object.freeze<IntegrationStore>({
    async secrets(app, tenant, integration) {
      const rows =
        integration === undefined
          ? await query(`SELECT * FROM ${table(t.secret)} WHERE app = $1 AND tenant = $2 ORDER BY integration, name`, [app, tenant])
          : await query(`SELECT * FROM ${table(t.secret)} WHERE app = $1 AND tenant = $2 AND integration = $3 ORDER BY name`, [
              app,
              tenant,
              integration,
            ]);
      return rows.map(secretOf);
    },
    async saveSecret(row) {
      if (row.sealed === null)
        await query(`DELETE FROM ${table(t.secret)} WHERE app = $1 AND tenant = $2 AND integration = $3 AND name = $4`, [
          row.app,
          row.tenant,
          row.integration,
          row.name,
        ]);
      else
        await query(
          `INSERT INTO ${table(t.secret)} (app, tenant, integration, name, sealed, saved_by, saved_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (app, tenant, integration, name) DO UPDATE SET sealed = excluded.sealed, saved_by = excluded.saved_by, saved_at = excluded.saved_at`,
          [row.app, row.tenant, row.integration, row.name, row.sealed, row.savedBy.slice(0, 200), row.at],
        );
    },
    async call(app, key) {
      const [row] = await query(`SELECT * FROM ${table(t.call)} WHERE app = $1 AND key = $2`, [app, key]);
      return row ? callOf(row) : undefined;
    },
    async recordCall(row) {
      await query(
        `WITH old AS (DELETE FROM ${table(t.call)} WHERE ctid IN (SELECT ctid FROM ${table(t.call)} WHERE at < $12 LIMIT 100))
         INSERT INTO ${table(t.call)} (app, key, tenant, integration, action, command, state, result_json, reason, attempts, at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (app, key) DO UPDATE SET state = excluded.state, result_json = excluded.result_json, reason = excluded.reason,
           attempts = excluded.attempts, at = excluded.at`,
        [
          row.app,
          row.key,
          row.tenant,
          row.integration,
          row.action,
          row.command,
          row.state,
          row.resultJson,
          clip(row.reason, 500),
          row.attempts,
          row.at,
          row.at - KEEP_MS,
        ],
      );
    },
    async firstSeen(app, key, at, expiresAt) {
      await query(`DELETE FROM ${table(t.seen)} WHERE ctid IN (SELECT ctid FROM ${table(t.seen)} WHERE expires_at < $1 LIMIT 100)`, [at]);
      return (
        (
          await query(`INSERT INTO ${table(t.seen)} (app, key, expires_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING key`, [
            app,
            key,
            expiresAt,
          ])
        ).length === 1
      );
    },
    async forgetSeen(app, key) {
      await query(`DELETE FROM ${table(t.seen)} WHERE app = $1 AND key = $2`, [app, key]);
    },
    async consent(app, tenant, channel, holder) {
      const [row] = await query(`SELECT * FROM ${table(t.consent)} WHERE app = $1 AND tenant = $2 AND channel = $3 AND holder = $4`, [
        app,
        tenant,
        channel,
        holder,
      ]);
      return row ? consentOf(row) : undefined;
    },
    async setConsent(row) {
      await query(
        `INSERT INTO ${table(t.consent)} AS held (app, tenant, channel, holder, state, source, at) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (app, tenant, channel, holder) DO UPDATE SET state = excluded.state, source = excluded.source, at = excluded.at
         WHERE held.at <= excluded.at`,
        [row.app, row.tenant, row.channel, row.holder, row.state, row.source.slice(0, 200), row.at],
      );
    },
    async message(app, key) {
      const [row] = await query(`SELECT * FROM ${table(t.message)} WHERE app = $1 AND key = $2`, [app, key]);
      return row ? messageOf(row) : undefined;
    },
    async putMessage(row) {
      await query(
        `WITH old AS (DELETE FROM ${table(t.message)} WHERE ctid IN (SELECT ctid FROM ${table(t.message)} WHERE at < $13 AND state <> 'held' LIMIT 100))
         INSERT INTO ${table(t.message)} (app, key, tenant, channel, recipient, text, state, reason, provider_id, due_at, attempts, at, consent, timezone)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $14, $15)
         ON CONFLICT (app, key) DO UPDATE SET state = excluded.state, reason = excluded.reason, provider_id = excluded.provider_id,
           due_at = excluded.due_at, attempts = excluded.attempts, at = excluded.at`,
        [
          row.app,
          row.key,
          row.tenant,
          row.channel,
          row.recipient.slice(0, 320),
          row.text.slice(0, 2000),
          row.state,
          clip(row.reason, 500),
          clip(row.providerId, 200),
          row.dueAt,
          row.attempts,
          row.at,
          row.at - KEEP_MS,
          row.consent === undefined || row.consent === null ? null : Number(row.consent),
          row.timezone ?? null,
        ],
      );
    },
    async due(app, now, limit, channel) {
      return (
        channel === undefined
          ? await query(`SELECT * FROM ${table(t.message)} WHERE app = $1 AND state = 'held' AND due_at <= $2 ORDER BY due_at LIMIT $3`, [
              app,
              now,
              limit,
            ])
          : await query(
              `SELECT * FROM ${table(t.message)} WHERE app = $1 AND state = 'held' AND due_at <= $2 AND channel = $3 ORDER BY due_at LIMIT $4`,
              [app, now, channel, limit],
            )
      ).map(messageOf);
    },
    async sentSince(app, tenant, channel, since, recipient) {
      const [row] =
        recipient === undefined
          ? await query(
              `SELECT count(*) AS n FROM ${table(t.message)} WHERE app = $1 AND tenant = $2 AND channel = $3 AND state = 'sent' AND at >= $4`,
              [app, tenant, channel, since],
            )
          : await query(
              `SELECT count(*) AS n FROM ${table(t.message)} WHERE app = $1 AND tenant = $2 AND channel = $3 AND recipient = $4 AND state = 'sent' AND at >= $5`,
              [app, tenant, channel, recipient, since],
            );
      return num(row?.n ?? 0);
    },
    async messages(app, tenant, limit) {
      return (
        await query(`SELECT * FROM ${table(t.message)} WHERE app = $1 AND tenant = $2 ORDER BY at DESC LIMIT $3`, [app, tenant, limit])
      ).map(messageOf);
    },
    close: () => pg.close(),
  });
}

/* ---------- a notice told via a channel, queued in its write's transaction ---------- */

const queuedValues = (row: QueuedChannelNotice): Array<string | number | null> => [
  row.app,
  row.key,
  row.tenant,
  row.channel,
  row.recipient.slice(0, 320),
  row.text.slice(0, 2000),
  'held',
  QUEUED,
  row.at,
  row.consent ? 1 : 0,
  row.timezone?.slice(0, 64) ?? null,
  row.actorKind,
  row.at,
];

/** Queue a notice on the write's own SQLite handle: it commits or rolls back with the write. */
export function queueSqliteChannelNotice(db: DatabaseSync, row: QueuedChannelNotice): void {
  db.prepare(
    `INSERT INTO "${t.message}" (app, key, tenant, channel, recipient, text, state, reason, due_at, consent, timezone, actor_kind, attempts, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?) ON CONFLICT (app, key) DO NOTHING`,
  ).run(...queuedValues(row));
}

/** The same on the write's PostgreSQL client. */
export async function queuePostgresChannelNotice(client: PgQuery, row: QueuedChannelNotice): Promise<void> {
  const queued = {
    text: `INSERT INTO ${runtimeTable('postgres', t.message)} (app, key, tenant, channel, recipient, text, state, reason, due_at, consent, timezone, actor_kind, attempts, at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 0, $13) ON CONFLICT (app, key) DO NOTHING`,
    values: queuedValues(row),
  };
  // Nothing reads the answer: on a writer that pipelines it leaves with the COMMIT (beforeCommit).
  if (beforeCommit(client, [queued])) return;
  await client.query(queued.text, queued.values);
}

/** The store over a source's target: its SQLite file or its PostgreSQL database. */
export function openIntegrationStore(target: Readonly<{ sqlite: string }> | Readonly<{ postgres: string }>): Promise<IntegrationStore> {
  return 'sqlite' in target ? Promise.resolve(openSqliteIntegrationStore(target.sqlite)) : openPostgresIntegrationStore(target.postgres);
}
