/**
 * Notifications on PostgreSQL: the SQLite layout, in the runtime schema
 * without the prefix, attested the way the record history's is — the catalog
 * description (columns, types, collations, constraints, indexes, and no
 * trigger, rule or policy) compared with the one provisioning produces; the
 * identity column's own sequence is left out of it.
 *
 * The append runs on the business write's leased client inside its
 * transaction; a person's read on a reader; marking read on a writer, and
 * only ever the rows that are theirs.
 */
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import { layoutRefusal, postgresLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { beforeCommit } from '@mistriwork/engine/adapters/postgresTransactionHandle.js';
import { canonicalCommandJson } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import {
  describePostgresRelations,
  withPostgresMaintenanceTransaction,
  type PostgresRelationDescription,
} from '../commands/postgresCommandJournal.js';
import {
  INBOX_INDEX,
  INBOX_LIMITS,
  INBOX_PREFIX,
  INBOX_TABLES,
  INBOX_VERSION,
  InboxUnavailable,
  assertInboxMark,
  assertInboxQuery,
  assertNoticeRow,
  storedNotice,
  type InboxMark,
  type InboxQuery,
  type NoticeRow,
  type StoredNotice,
} from './inbox.js';
import { inboxMailStore, type InboxMailStore } from './inboxMail.js';
import { postgresRuntimeNames, runtimeSchema, runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';

const { meta, notice, mail, optout } = postgresRuntimeNames(INBOX_TABLES);
const q = (name: string) => runtimeTable('postgres', name);
/** Why the layout was refused, when the version row says: a newer or an older store (see layoutRefusal.ts). */
const layoutMessage = async (client: PgQuery) =>
  layoutRefusal('The notification store', await postgresLayoutVersion(client, q(meta)), INBOX_VERSION);

const definitions: readonly string[] = [
  `CREATE TABLE ${q(meta)} (
  singleton integer PRIMARY KEY CHECK (singleton = 1),
  version integer NOT NULL CHECK (version = ${INBOX_VERSION})
)`,
  `CREATE TABLE ${q(notice)} (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  app text COLLATE "C" NOT NULL CHECK (octet_length(app) <= ${INBOX_LIMITS.app}),
  recipient text COLLATE "C" NOT NULL CHECK (octet_length(recipient) <= ${INBOX_LIMITS.recipient}),
  at text NOT NULL,
  resource text COLLATE "C" NOT NULL CHECK (octet_length(resource) <= ${INBOX_LIMITS.resource}),
  key_json text COLLATE "C" NOT NULL CHECK (octet_length(key_json) <= ${INBOX_LIMITS.key} AND key_json::json IS NOT NULL),
  title text NOT NULL CHECK (octet_length(title) <= ${INBOX_LIMITS.title}),
  uses_json text NOT NULL CHECK (octet_length(uses_json) <= ${INBOX_LIMITS.uses} AND uses_json::json IS NOT NULL),
  actor text COLLATE "C" NOT NULL,
  actor_name text NOT NULL,
  action text NOT NULL,
  read_at text
)`,
  `CREATE INDEX "${INBOX_INDEX}" ON ${q(notice)} (app, recipient, id)`,
  `CREATE TABLE ${q(mail)} (
  notice bigint PRIMARY KEY,
  state text COLLATE "C" NOT NULL,
  attempts integer NOT NULL,
  due_at text COLLATE "C" NOT NULL,
  last_error text
)`,
  `CREATE TABLE ${q(optout)} (
  holder text COLLATE "C" PRIMARY KEY,
  at text NOT NULL
)`,
];

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const column = (
  name: string,
  type: string,
  collation: string | null = null,
  notnull = true,
): PostgresRelationDescription['columns'][number] => ({
  name,
  type,
  notnull,
  collation,
  default: null,
});
const table = (
  name: string,
  columns: PostgresRelationDescription['columns'],
  constraints: string[],
  indexes: string[],
): PostgresRelationDescription => ({
  schema: runtimeSchema('postgres'),
  name,
  kind: 'r',
  rls: false,
  columns,
  constraints: [...constraints].sort(byCodeUnit),
  indexes: [...indexes].sort(byCodeUnit),
  triggers: 0,
  rules: 0,
  policies: 0,
});

/* What the DDL above reads back as, pinned so the attestation is of this
   layout. The catalog reads relations back in name order, so the pin is kept
   in it too: the mail and opt-out tables sort before and after the others. */
const LAYOUT: readonly PostgresRelationDescription[] = [
  table(
    meta,
    [column('singleton', 'integer'), column('version', 'integer')],
    ['CHECK ((singleton = 1))', `CHECK ((version = ${INBOX_VERSION}))`, 'PRIMARY KEY (singleton)'],
    [`CREATE UNIQUE INDEX ${meta}_pkey ON ${runtimeSchema('postgres')}.${meta} USING btree (singleton)`],
  ),
  table(
    notice,
    [
      column('id', 'bigint'),
      column('app', 'text', 'C'),
      column('recipient', 'text', 'C'),
      column('at', 'text', 'default'),
      column('resource', 'text', 'C'),
      column('key_json', 'text', 'C'),
      column('title', 'text', 'default'),
      column('uses_json', 'text', 'default'),
      column('actor', 'text', 'C'),
      column('actor_name', 'text', 'default'),
      column('action', 'text', 'default'),
      column('read_at', 'text', 'default', false),
    ],
    [
      `CHECK ((octet_length(app) <= ${INBOX_LIMITS.app}))`,
      `CHECK ((octet_length(recipient) <= ${INBOX_LIMITS.recipient}))`,
      `CHECK ((octet_length(resource) <= ${INBOX_LIMITS.resource}))`,
      `CHECK (((octet_length(key_json) <= ${INBOX_LIMITS.key}) AND ((key_json)::json IS NOT NULL)))`,
      `CHECK ((octet_length(title) <= ${INBOX_LIMITS.title}))`,
      `CHECK (((octet_length(uses_json) <= ${INBOX_LIMITS.uses}) AND ((uses_json)::json IS NOT NULL)))`,
      'PRIMARY KEY (id)',
    ],
    [
      `CREATE INDEX ${INBOX_INDEX} ON ${runtimeSchema('postgres')}.${notice} USING btree (app, recipient, id)`,
      `CREATE UNIQUE INDEX ${notice}_pkey ON ${runtimeSchema('postgres')}.${notice} USING btree (id)`,
    ],
  ),
  table(
    mail,
    [
      column('notice', 'bigint'),
      column('state', 'text', 'C'),
      column('attempts', 'integer'),
      column('due_at', 'text', 'C'),
      column('last_error', 'text', 'default', false),
    ],
    ['PRIMARY KEY (notice)'],
    [`CREATE UNIQUE INDEX ${mail}_pkey ON ${runtimeSchema('postgres')}.${mail} USING btree (notice)`],
  ),
  table(
    optout,
    [column('holder', 'text', 'C'), column('at', 'text', 'default')],
    ['PRIMARY KEY (holder)'],
    [`CREATE UNIQUE INDEX ${optout}_pkey ON ${runtimeSchema('postgres')}.${optout} USING btree (holder)`],
  ),
].sort((a, b) => byCodeUnit(a.name, b.name));

const canonical = (value: unknown) => canonicalCommandJson(value, 1_048_576);

/** Whether the reserved relations are exactly this version's layout. */
export async function postgresInboxReady(client: PgQuery): Promise<boolean> {
  try {
    const actual = (await describePostgresRelations(client, INBOX_PREFIX)).filter(
      (relation) => !(relation.kind === 'S' && relation.schema === runtimeSchema('postgres') && relation.name === `${notice}_id_seq`),
    );
    if (canonical(actual) !== canonical(LAYOUT)) return false;
    const rows = (await client.query(`SELECT singleton, version FROM ${q(meta)}`)).rows;
    return rows.length === 1 && rows[0].singleton === 1 && rows[0].version === INBOX_VERSION;
  } catch {
    return false;
  }
}

/** Explicit maintenance, under the shared migration lock: creates this version
 * where no store exists, changes nothing where it does, refuses anything else. */
export async function provisionPostgresInbox(url: string): Promise<{ version: typeof INBOX_VERSION; provisioned: boolean }> {
  if (typeof url !== 'string' || !/^postgres(ql)?:\/\//i.test(url))
    throw new Refusal('Notification store provisioning requires a postgres:// URL.');
  return withPostgresMaintenanceTransaction(url, async (client) => {
    let provisioned = false;
    if (!(await describePostgresRelations(client, INBOX_PREFIX)).length) {
      for (const ddl of definitions) await client.query(ddl);
      await client.query(`INSERT INTO ${q(meta)} (singleton, version) VALUES (1, $1)`, [INBOX_VERSION]);
      provisioned = true;
    }
    if (!(await postgresInboxReady(client))) throw new InboxUnavailable(await layoutMessage(client));
    return { version: INBOX_VERSION, provisioned };
  });
}

/** One notice, on the business write's leased client, inside its transaction — and its place in the outbox when it is emailed too. */
export async function appendPostgresNotice(client: PgQuery, row: NoticeRow): Promise<void> {
  const uses = assertNoticeRow(row);
  const values = [row.app, row.recipient, row.at, row.resource, row.key, row.title, uses, row.actor, row.actorName, row.action];
  const insert = `INSERT INTO ${q(notice)} (app, recipient, at, resource, key_json, title, uses_json, actor, actor_name, action)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;
  /* The notice and its mail in one statement, which nothing reads an answer of:
     on a writer that pipelines it leaves with the COMMIT (beforeCommit). */
  const append = row.email
    ? {
        text: `WITH n AS (${insert} RETURNING id)
    INSERT INTO ${q(mail)} (notice, state, attempts, due_at, last_error) SELECT n.id, 'queued', 0, $3, NULL FROM n`,
        values,
      }
    : { text: insert, values };
  if (beforeCommit(client, [append])) return;
  await client.query(append.text, append.values);
}

/** One person's notices in one App, newest first. */
/* `attested`: the adapter holds an attestation under the schema epoch it just read (postgres.ts, storeAttested). */
export async function readPostgresInbox(client: PgQuery, query: InboxQuery, attested = false): Promise<StoredNotice[]> {
  assertInboxQuery(query);
  if (!attested && !(await postgresInboxReady(client))) throw new InboxUnavailable(await layoutMessage(client));
  const params: unknown[] = [query.app, query.recipient, query.limit];
  if (query.before !== undefined) params.push(query.before);
  const result = await client.query(
    `SELECT id::text AS id, app, recipient, at, resource, key_json, title, uses_json, actor, actor_name, action, read_at
    FROM ${q(notice)} WHERE app = $1 AND recipient = $2
      ${query.unread ? 'AND read_at IS NULL' : ''} ${query.before === undefined ? '' : 'AND id < $4'}
    ORDER BY id DESC LIMIT $3`,
    params,
  );
  return (result.rows as Array<Record<string, unknown>>).map(storedNotice);
}

/** Mark one person's notices read — the ids given, or all of them — and never anyone else's. */
export async function markPostgresInboxRead(client: PgQuery, mark: InboxMark, attested = false): Promise<number> {
  assertInboxMark(mark);
  if (!attested && !(await postgresInboxReady(client))) throw new InboxUnavailable(await layoutMessage(client));
  const ids = mark.ids ?? [];
  const result = await client.query(
    `UPDATE ${q(notice)} SET read_at = $1 WHERE app = $2 AND recipient = $3 AND read_at IS NULL
    ${ids.length ? 'AND id = ANY($4::bigint[])' : ''}`,
    [mark.at, mark.app, mark.recipient, ...(ids.length ? [ids] : [])],
  );
  return Number(result.rowCount ?? 0);
}

/** The outbox on a writer, one statement shape for every engine (inboxMail.ts). */
export function postgresInboxMail(through: <T>(work: (client: PgQuery) => Promise<T>) => Promise<T>): InboxMailStore {
  const numbered = (sql: string) => {
    let n = 0;
    return sql.replace(/\?/g, () => `$${++n}`);
  };
  return inboxMailStore(q, (work) =>
    through((client) =>
      work({
        all: async (sql, params) => (await client.query(numbered(sql), [...params])).rows as Array<Record<string, unknown>>,
        run: async (sql, params) => Number((await client.query(numbered(sql), [...params])).rowCount ?? 0),
      }),
    ),
  );
}
