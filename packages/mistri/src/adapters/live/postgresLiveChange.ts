/**
 * Live sync's store on PostgreSQL: the SQLite layout in the runtime schema,
 * without the prefix, with two differences that are the point of it here.
 *
 * The change table is UNLOGGED: it is a fifteen-minute cache of what changed,
 * and losing it in a crash costs each subscriber one `reset`, never a wrong
 * answer, while a logged table would put a WAL record for every write
 * transaction of the App on the replicas' backlog.
 *
 * Ids are handed out at insert and commits land in any order, so an id is
 * not a commit order: a reader that moved past id 11 would never see id 10
 * committing a moment later. Each row keeps its transaction id (`xact`), and
 * a reader reads only rows below a horizon no transaction that could still
 * write one is under, in (xact, id) order, as the App API's event feed does
 * (server/api/apiEventFeed.ts), so a position in that order is never passed
 * by a late row. Both read below the database's horizon, not the snapshot's
 * xmin, which is the server's: a write transaction held open in any database
 * on it would hold every change here back for as long as it ran. The
 * database's (`POSTGRES_DATABASE_HORIZON`) is the oldest transaction still
 * running that is not known to be another database's, since only a session
 * connected here can write the table.
 *
 * The append's transaction also runs `pg_notify` on one channel with an empty
 * payload, delivered only if it commits: any role that may connect may LISTEN,
 * so nothing goes in it.
 */
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import { layoutRefusal, postgresLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { beforeCommit } from '@mistriwork/engine/adapters/postgresTransactionHandle.js';
import { canonicalCommandJson } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { describePostgresRelations, type PostgresRelationDescription } from '../commands/postgresRelations.js';
import { withPostgresMaintenanceTransaction } from '@mistriwork/engine/adapters/postgresMaintenance.js';
import {
  LIVE_CHANGE_INDEX,
  LIVE_CHANGE_LIMITS,
  LIVE_CHANGE_PREFIX,
  LIVE_CHANGE_TABLES,
  LIVE_CHANGE_VERSION,
  LiveChangeUnavailable,
  NOTIFY_LIVE,
  assertLiveChangeRow,
  parseLiveEntries,
  type LiveChangeRow,
  type StoredLiveChange,
} from './liveChange.js';
import { postgresRuntimeNames, runtimeSchema, runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';

const { meta, change } = postgresRuntimeNames(LIVE_CHANGE_TABLES);
const q = (name: string) => runtimeTable('postgres', name);
const layoutMessage = async (client: PgQuery) =>
  layoutRefusal('The live sync store', await postgresLayoutVersion(client, q(meta)), LIVE_CHANGE_VERSION);

const definitions: readonly string[] = [
  `CREATE TABLE ${q(meta)} (
  singleton integer PRIMARY KEY CHECK (singleton = 1),
  version integer NOT NULL CHECK (version = ${LIVE_CHANGE_VERSION})
)`,
  `CREATE UNLOGGED TABLE ${q(change)} (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  xact xid8 NOT NULL DEFAULT pg_current_xact_id(),
  at bigint NOT NULL,
  actor text COLLATE "C" NOT NULL CHECK (length(actor) <= ${LIVE_CHANGE_LIMITS.actor}),
  tenant text COLLATE "C" CHECK (length(tenant) <= ${LIVE_CHANGE_LIMITS.tenant}),
  entries jsonb NOT NULL CHECK (octet_length(entries::text) <= ${LIVE_CHANGE_LIMITS.entries})
)`,
  `CREATE INDEX "${LIVE_CHANGE_INDEX}" ON ${q(change)} (xact, id)`,
];

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const column = (
  name: string,
  type: string,
  collation: string | null = null,
  notnull = true,
  fallback: string | null = null,
): PostgresRelationDescription['columns'][number] => ({
  name,
  type,
  notnull,
  collation,
  default: fallback,
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

/* What the DDL above reads back as, pinned so the attestation is of this layout and not of whatever is there. */
const LAYOUT: readonly PostgresRelationDescription[] = [
  table(
    change,
    [
      column('id', 'bigint'),
      column('xact', 'xid8', null, true, 'pg_current_xact_id()'),
      column('at', 'bigint'),
      column('actor', 'text', 'C'),
      column('tenant', 'text', 'C', false),
      column('entries', 'jsonb'),
    ],
    [
      `CHECK ((length(actor) <= ${LIVE_CHANGE_LIMITS.actor}))`,
      `CHECK ((length(tenant) <= ${LIVE_CHANGE_LIMITS.tenant}))`,
      `CHECK ((octet_length((entries)::text) <= ${LIVE_CHANGE_LIMITS.entries}))`,
      'PRIMARY KEY (id)',
    ],
    [
      `CREATE INDEX ${LIVE_CHANGE_INDEX} ON ${runtimeSchema('postgres')}.${change} USING btree (xact, id)`,
      `CREATE UNIQUE INDEX ${change}_pkey ON ${runtimeSchema('postgres')}.${change} USING btree (id)`,
    ],
  ),
  table(
    meta,
    [column('singleton', 'integer'), column('version', 'integer')],
    ['CHECK ((singleton = 1))', `CHECK ((version = ${LIVE_CHANGE_VERSION}))`, 'PRIMARY KEY (singleton)'],
    [`CREATE UNIQUE INDEX ${meta}_pkey ON ${runtimeSchema('postgres')}.${meta} USING btree (singleton)`],
  ),
];

const canonical = (value: unknown) => canonicalCommandJson(value, 1_048_576);

/** Whether the reserved relations are exactly this version's layout, the change table unlogged. */
export async function postgresLiveChangeReady(client: PgQuery): Promise<boolean> {
  try {
    const actual = (await describePostgresRelations(client, LIVE_CHANGE_PREFIX)).filter(
      (relation) => !(relation.kind === 'S' && relation.schema === runtimeSchema('postgres') && relation.name === `${change}_id_seq`),
    );
    if (canonical(actual) !== canonical(LAYOUT)) return false;
    const persistence = (
      await client.query(
        `SELECT c.relpersistence::text AS persistence FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = '${runtimeSchema('postgres')}' AND c.relname = $1`,
        [change],
      )
    ).rows;
    if (persistence.length !== 1 || persistence[0].persistence !== 'u') return false;
    const rows = (await client.query(`SELECT singleton, version FROM ${q(meta)}`)).rows;
    return rows.length === 1 && rows[0].singleton === 1 && rows[0].version === LIVE_CHANGE_VERSION;
  } catch {
    return false;
  }
}

/** Explicit maintenance, under the shared migration lock: creates this version
 * where no store exists, changes nothing where it does, refuses anything else. */
export async function provisionPostgresLiveChange(url: string): Promise<{ version: typeof LIVE_CHANGE_VERSION; provisioned: boolean }> {
  if (typeof url !== 'string' || !/^postgres(ql)?:\/\//i.test(url)) throw new Refusal('Live sync provisioning requires a postgres:// URL.');
  return withPostgresMaintenanceTransaction(url, async (client) => {
    let provisioned = false;
    if (!(await describePostgresRelations(client, LIVE_CHANGE_PREFIX)).length) {
      for (const ddl of definitions) await client.query(ddl);
      await client.query(`INSERT INTO ${q(meta)} (singleton, version) VALUES (1, $1)`, [LIVE_CHANGE_VERSION]);
      provisioned = true;
    }
    if (!(await postgresLiveChangeReady(client))) throw new LiveChangeUnavailable(await layoutMessage(client));
    return { version: LIVE_CHANGE_VERSION, provisioned };
  });
}

/** One row and its announcement, on the business write's leased client, inside its transaction. */
export async function appendPostgresLiveChange(client: PgQuery, row: LiveChangeRow): Promise<void> {
  const entries = assertLiveChangeRow(row);
  const append = {
    text: `INSERT INTO ${q(change)} (at, actor, tenant, entries) VALUES ($1, $2, $3, $4::jsonb)`,
    values: [row.at, row.actor, row.tenant, entries],
  };
  // Nothing reads either answer: on a writer that pipelines they leave with the COMMIT.
  if (beforeCommit(client, [append, NOTIFY_LIVE])) return;
  await client.query(append.text, append.values);
  await client.query(NOTIFY_LIVE);
}

/**
 * The horizon, as a scalar subquery: the snapshot's xmax, lowered to the
 * oldest transaction it saw running that may be this database's. A
 * transaction's database never changes, so `pg_stat_activity` naming another
 * one for its id (read before or after the snapshot, either way) is proof it
 * can write no row here; a prepared transaction, or one no session shows, is
 * taken to be this database's. `backend_xid` and `datid` are shown to every
 * role. The 32-bit id an activity row shows matches the snapshot's 64-bit one
 * modulo 2^32, which is unique among transactions running at once.
 */
export const POSTGRES_DATABASE_HORIZON = `(SELECT least(
    pg_snapshot_xmax(pg_current_snapshot()),
    (SELECT min(running) FROM pg_snapshot_xip(pg_current_snapshot()) AS running
      WHERE running::xid::text NOT IN (
        SELECT backend_xid::text FROM pg_stat_activity
        WHERE backend_xid IS NOT NULL AND datid IS DISTINCT FROM (SELECT oid FROM pg_database WHERE datname = current_database())))))`;

/** A reader's place in commit order: the transaction id and the row id, as text. `0/0` is before every row. */
interface PostgresLivePosition {
  readonly xact: string;
  readonly id: string;
}
export const POSTGRES_LIVE_START: PostgresLivePosition = Object.freeze({
  xact: '0',
  id: '0',
});

/** The newest settled position: where a new subscriber starts, so it is told only of what follows. */
export async function postgresLiveHead(client: PgQuery): Promise<PostgresLivePosition> {
  const row = (
    await client.query(
      `SELECT xact::text AS xact, id::text AS id FROM ${q(change)}
      WHERE xact < ${POSTGRES_DATABASE_HORIZON} ORDER BY xact DESC, id DESC LIMIT 1`,
    )
  ).rows[0] as { xact: string; id: string } | undefined;
  return row ? Object.freeze({ xact: row.xact, id: row.id }) : POSTGRES_LIVE_START;
}

/** Settled rows past `from`, oldest first, at most `limit`, each with its position. */
export async function readPostgresLiveChanges(
  client: PgQuery,
  from: PostgresLivePosition,
  limit: number,
): Promise<Array<{ change: StoredLiveChange; position: PostgresLivePosition }>> {
  const rows = (
    await client.query(
      `SELECT id::text AS id, xact::text AS xact, at::text AS at, actor, tenant, entries::text AS entries FROM ${q(change)}
      WHERE xact < ${POSTGRES_DATABASE_HORIZON} AND (xact, id) > ($1::xid8, $2::bigint)
      ORDER BY xact, id LIMIT $3`,
      [from.xact, from.id, limit],
    )
  ).rows as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    change: Object.freeze({
      id: String(row.id),
      at: Number(row.at),
      actor: String(row.actor),
      tenant: typeof row.tenant === 'string' ? row.tenant : null,
      entries: parseLiveEntries(row.entries),
    }),
    position: Object.freeze({ xact: String(row.xact), id: String(row.id) }),
  }));
}

/**
 * Whether a committed row past `from` is left once every row that could be
 * read has been: an older transaction that may be this database's held it
 * above the horizon. Its commit was announced already, and the end of the
 * transaction holding it back announces nothing, so the reader looks again
 * on its own. The horizon is not asked again here: this statement's snapshot
 * is not the read's, and a transaction the read saw running (another
 * database's, ended before its session was read) may be gone by now, so this
 * would call settled a row the read held back, and no one would look again.
 */
export async function postgresLiveUnsettled(client: PgQuery, from: PostgresLivePosition): Promise<boolean> {
  const row = (
    await client.query(
      `SELECT EXISTS (SELECT 1 FROM ${q(change)}
      WHERE (xact, id) > ($1::xid8, $2::bigint)) AS waiting`,
      [from.xact, from.id],
    )
  ).rows[0] as { waiting?: boolean } | undefined;
  return row?.waiting === true;
}

/** Where a subscriber's cursor (a row id) stands, or undefined once the row is pruned or lost in a crash. */
export async function locatePostgresLiveCursor(client: PgQuery, id: string): Promise<PostgresLivePosition | undefined> {
  if (id === '0') return undefined;
  const row = (await client.query(`SELECT xact::text AS xact FROM ${q(change)} WHERE id = $1::bigint`, [id])).rows[0] as
    | { xact: string }
    | undefined;
  return row ? Object.freeze({ xact: row.xact, id }) : undefined;
}

/** Rows older than `before` (ms), the newest always kept, by whichever process holds the lock this minute. */
export async function prunePostgresLiveChanges(client: PgQuery, before: number): Promise<number> {
  await client.query('BEGIN');
  try {
    const held = (await client.query(`SELECT pg_try_advisory_xact_lock(hashtext($1)) AS held`, [change])).rows[0]?.held;
    let pruned = 0;
    if (held) {
      const result = await client.query(`DELETE FROM ${q(change)} WHERE at < $1 AND id < (SELECT max(id) FROM ${q(change)})`, [before]);
      pruned = Number(result.rowCount ?? 0);
    }
    await client.query('COMMIT');
    return pruned;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
