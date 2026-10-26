/**
 * The command event store on PostgreSQL: the schema half of
 * commandEventSchema.ts and the store half of commandEventStore.ts, in one
 * file, asynchronous. Same tables, same columns, same bounds, same envelope
 * and digest (shared through `commandEventEnvelopes`), so a batch written
 * here verifies under exactly the rule a SQLite batch does.
 */
import { randomUUID } from 'node:crypto';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { attestOnce } from '@mistriwork/engine/adapters/postgresTransactionHandle.js';
import { layoutRefusal, postgresLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import { runtimeSchema, runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';
import { foldRelations, type LayoutTrust } from '../commands/postgresRelations.js';
import type { CommandAudit, StoredCommandReceipt } from '../commands/commandJournalTypes.js';
import { COMMAND_JOURNAL_TABLES } from '../commands/commandJournalSchema.js';
import {
  assertPostgresCommandJournal,
  describePostgresRelations,
  withPostgresMaintenanceTransaction,
  type PostgresRelationDescription,
} from '../commands/postgresCommandJournalSchema.js';
import type { CommandEventBatch, CommandEventEnvelope, CommandEventManifest, CommandEventOwner } from './commandEventTypes.js';
import {
  COMMAND_EVENT_TABLES as tables,
  CommandEventStoreUnavailable,
  captureCommandEventStoreBinding,
  type CommandEventStoreBinding,
} from './commandEventSchema.js';
import { commandEventEnvelopes as shared } from './commandEventStore.js';
import { canonicalCommandJson } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { captureCommandEventBatch, captureCommandEventManifest } from './commandEventCapture.js';
import { NOTIFY_COMMAND_EVENTS } from './postgresCommandEventWake.js';

const fail = (message?: string): never => {
  throw new CommandEventStoreUnavailable(message);
};
const prefix = 'event_';
const q = (name: string) => runtimeTable('postgres', name);
const { context, envelope, digest, uuid, canonical } = shared;

/* PostgreSQL: one event store per App, not per database. The
   meta table holds a row per App that owns a store here, keyed by the App,
   so several Apps sharing one database (a suite's intended deployment) each
   keep their own store. A batch belongs to the App of its receipt: the
   journal row already names it, and every reader filters on it. SQLite keeps
   one App per file: two Apps on one SQLite file is not a
   deployment this project targets. */
const POSTGRES_COMMAND_EVENT_STORE_VERSION = 1;
const VERSION = POSTGRES_COMMAND_EVENT_STORE_VERSION;
/** Why the layout was refused, when the version row says (see layoutRefusal.ts); several Apps keep a row each here, and it is read only where there is exactly one. */
const layoutMessage = async (client: PgQuery) =>
  layoutRefusal('The command event store', await postgresLayoutVersion(client, q(tables.meta)), VERSION);
const META_DDL = `CREATE TABLE ${q(tables.meta)} (
  app_id text COLLATE "C" PRIMARY KEY CHECK (octet_length(app_id) BETWEEN 1 AND 128),
  version integer NOT NULL CHECK (version = ${VERSION}),
  store_id text COLLATE "C" NOT NULL CHECK (octet_length(store_id) BETWEEN 1 AND 256),
  source_id text COLLATE "C" NOT NULL CHECK (octet_length(source_id) BETWEEN 1 AND 128)
)`;

/* Postgres text cannot hold NUL at all, so the SQLite `instr(…, char(0))`
   half of each bound is the engine's own rule here and is not restated. A
   batch's manifest, count, digest and transaction id are its receipt's own
   columns (postgresCommandJournalSchema.ts): the events hang off that row. */
const COMMAND_EVENT_POSTGRES_DEFINITIONS: readonly string[] = [
  META_DDL,
  `CREATE TABLE ${q(tables.event)} (
  event_id text COLLATE "C" PRIMARY KEY CHECK (octet_length(event_id) = 36),
  receipt_id text COLLATE "C" NOT NULL REFERENCES ${q(COMMAND_JOURNAL_TABLES.receipt)} (id) ON DELETE RESTRICT CHECK (octet_length(receipt_id) BETWEEN 1 AND 128),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 31),
  envelope_json text COLLATE "C" NOT NULL CHECK (octet_length(envelope_json) BETWEEN 1 AND 131072 AND json_typeof(envelope_json::json) = 'object'),
  UNIQUE (receipt_id, ordinal)
)`,
];

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const relation = (
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
const column = (name: string, type: string, notnull: boolean, collation: string | null, fallback: string | null = null) => ({
  name,
  type,
  notnull,
  collation,
  default: fallback,
});
/* Read back from a PostgreSQL 18 catalog after the DDL above ran. Pinned
   rather than derived at runtime, so attestation is of this layout and not
   of whatever is there. */
const LAYOUT: readonly PostgresRelationDescription[] = [
  relation(
    'event_event',
    [
      column('event_id', 'text', true, 'C'),
      column('receipt_id', 'text', true, 'C'),
      column('ordinal', 'integer', true, null),
      column('envelope_json', 'text', true, 'C'),
    ],
    [
      "CHECK ((((octet_length(envelope_json) >= 1) AND (octet_length(envelope_json) <= 131072)) AND (json_typeof((envelope_json)::json) = 'object'::text)))",
      'CHECK (((octet_length(receipt_id) >= 1) AND (octet_length(receipt_id) <= 128)))',
      'CHECK (((ordinal >= 0) AND (ordinal <= 31)))',
      'CHECK ((octet_length(event_id) = 36))',
      'FOREIGN KEY (receipt_id) REFERENCES command_receipt(id) ON DELETE RESTRICT',
      'PRIMARY KEY (event_id)',
      'UNIQUE (receipt_id, ordinal)',
    ],
    [
      `CREATE UNIQUE INDEX event_event_pkey ON ${runtimeSchema('postgres')}.event_event USING btree (event_id)`,
      `CREATE UNIQUE INDEX event_event_receipt_id_ordinal_key ON ${runtimeSchema('postgres')}.event_event USING btree (receipt_id, ordinal)`,
    ],
  ),
  relation(
    'event_meta',
    [
      column('app_id', 'text', true, 'C'),
      column('version', 'integer', true, null),
      column('store_id', 'text', true, 'C'),
      column('source_id', 'text', true, 'C'),
    ],
    [
      'CHECK (((octet_length(app_id) >= 1) AND (octet_length(app_id) <= 128)))',
      'CHECK (((octet_length(source_id) >= 1) AND (octet_length(source_id) <= 128)))',
      'CHECK (((octet_length(store_id) >= 1) AND (octet_length(store_id) <= 256)))',
      'CHECK ((version = 1))',
      'PRIMARY KEY (app_id)',
    ],
    [`CREATE UNIQUE INDEX event_meta_pkey ON ${runtimeSchema('postgres')}.event_meta USING btree (app_id)`],
  ),
];

/** Presence is not attestation: any collision under the prefix counts as present. */
async function hasPostgresCommandEventStore(client: PgQuery): Promise<boolean> {
  return (await describePostgresRelations(client, prefix)).length !== 0;
}

/** Structural/source attestation only; batch association is checked on reads. On a transaction handle made by an adapter,
    once per adapter and binding (attestOnce, postgresTransactionHandle.ts). */
export async function assertPostgresCommandEventStore(
  client: PgQuery,
  input: CommandEventStoreBinding,
  trust?: LayoutTrust,
): Promise<void> {
  let owner: CommandEventStoreBinding;
  try {
    owner = captureCommandEventStoreBinding(input);
  } catch {
    return fail();
  }
  return attestOnce(client, `${prefix}\u0000${owner.appId}\u0000${owner.storeId}\u0000${owner.sourceId}`, () =>
    attestEventStore(client, owner, trust),
  );
}

async function attestEventStore(client: PgQuery, owner: CommandEventStoreBinding, trust?: LayoutTrust): Promise<void> {
  try {
    await assertPostgresCommandJournal(client, trust);
    const described = async () => {
      const actual = await describePostgresRelations(client, prefix);
      if (canonicalCommandJson(foldRelations(actual), 1_048_576) !== canonicalCommandJson(foldRelations(LAYOUT), 1_048_576))
        return fail(await layoutMessage(client));
    };
    await (trust ? trust.through(prefix, described) : described());
    const rows = (await client.query(`SELECT version, app_id, store_id, source_id FROM ${q(tables.meta)} WHERE app_id = $1`, [owner.appId]))
      .rows;
    if (
      rows.length !== 1 ||
      rows[0].version !== VERSION ||
      rows[0].app_id !== owner.appId ||
      rows[0].store_id !== owner.storeId ||
      rows[0].source_id !== owner.sourceId
    )
      return fail(layoutRefusal('The command event store', rows.length === 1 ? rows[0].version : undefined, VERSION));
  } catch (error) {
    if (error instanceof CommandEventStoreUnavailable) throw error;
    return fail();
  }
}

/** Explicit maintenance; never creates a source, a journal or upgrades a
 * namespace. Creates the tables where there are none and this App's row
 * where it has none; another App's row is left alone, and a row of this App
 * bound to a different store or source is refused unchanged. */
export async function provisionPostgresCommandEventStore(
  url: string,
  input: CommandEventStoreBinding,
): Promise<{ version: 1; provisioned: boolean }> {
  try {
    const owner = captureCommandEventStoreBinding(input);
    return await withPostgresMaintenanceTransaction(url, async (client) => {
      await assertPostgresCommandJournal(client);
      if (!(await hasPostgresCommandEventStore(client))) for (const ddl of COMMAND_EVENT_POSTGRES_DEFINITIONS) await client.query(ddl);
      const provisioned =
        (
          await client.query(
            `INSERT INTO ${q(tables.meta)} (app_id, version, store_id, source_id) VALUES ($1, $4, $2, $3)
        ON CONFLICT (app_id) DO NOTHING`,
            [owner.appId, owner.storeId, owner.sourceId, VERSION],
          )
        ).rowCount === 1;
      await assertPostgresCommandEventStore(client, owner);
      return { version: VERSION as 1, provisioned };
    });
  } catch (error) {
    if (error instanceof CommandEventStoreUnavailable) throw error;
    return fail();
  }
}

/** What a receipt row carries of its event batch, and the statements that write its events after it. */
interface PostgresCommandEventRows {
  /** The receipt row's manifest_json, event_count and digest; its xact_id is the writing transaction's. */
  readonly batch: readonly [string, number, string];
  /** The events and the wake a jobs host in any process hears at commit (postgresCommandEventWake.ts), sent after the receipt row. */
  readonly statements: readonly { text: string; values?: unknown[] }[];
}

/**
 * A batch as its receipt row and the statements behind it say it: called by the
 * journal with its validated receipt and first audit and its captured source
 * owner, inside its fail-stop operation. Nothing is sent here; no authored event
 * or request supplies an envelope field.
 */
export function postgresCommandEventRows(
  source: CommandEventOwner,
  receipt: StoredCommandReceipt,
  audit: CommandAudit,
  input: CommandEventBatch,
): PostgresCommandEventRows {
  try {
    const batch = captureCommandEventBatch(input),
      runtime = context(source, receipt, audit);
    const manifest = captureCommandEventManifest(batch.map(({ name, version }) => ({ name, version })));
    const events = batch.map((_, ordinal) => envelope(runtime, manifest, batch, ordinal, randomUUID()));
    return {
      batch: [canonical(manifest, 65_536), events.length, digest(manifest, events)],
      statements: [
        {
          text: `INSERT INTO ${q(tables.event)} (event_id, receipt_id, ordinal, envelope_json)
      SELECT e.event_id, $1, e.ordinal, e.envelope_json FROM unnest($2::text[], $3::int[], $4::text[]) AS e(event_id, ordinal, envelope_json)`,
          values: [
            receipt.id,
            events.map((event) => event.eventId),
            events.map((_, ordinal) => ordinal),
            events.map((event) => canonical(event, 131_072)),
          ],
        },
        { text: NOTIFY_COMMAND_EVENTS },
      ],
    };
  } catch (error) {
    if (error instanceof CommandEventStoreUnavailable) throw error;
    return fail();
  }
}

/** Private exact-receipt inspection, not a public list endpoint. Historical
 * grant/deployment changes do not reidentify committed events. */
export async function assertPostgresCommandEvents(
  client: PgQuery,
  source: CommandEventOwner,
  receipt: StoredCommandReceipt,
  audit: CommandAudit,
  expected?: CommandEventManifest,
): Promise<readonly CommandEventEnvelope[]> {
  try {
    if (expected === undefined && !(await hasPostgresCommandEventStore(client))) return Object.freeze([]);
    await assertPostgresCommandEventStore(client, { appId: source.appId, storeId: source.storeId, sourceId: source.sourceId });
    const manifest = expected === undefined ? undefined : captureCommandEventManifest(expected);
    const batch = (
      await client.query(
        `SELECT id AS receipt_id, manifest_json, event_count, digest FROM ${q(COMMAND_JOURNAL_TABLES.receipt)}
        WHERE id = $1 AND manifest_json IS NOT NULL`,
        [receipt.id],
      )
    ).rows[0];
    if (!manifest) {
      if (batch || (await client.query(`SELECT 1 FROM ${q(tables.event)} WHERE receipt_id = $1 LIMIT 1`, [receipt.id])).rows.length)
        return fail();
      return Object.freeze([]);
    }
    if (
      !batch ||
      batch.receipt_id !== receipt.id ||
      batch.event_count !== manifest.length ||
      batch.manifest_json !== canonical(manifest, 65_536) ||
      typeof batch.digest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(batch.digest)
    )
      return fail();
    // The extra row catches cardinality tampering without reading unbounded data.
    const rows = (
      await client.query(
        `SELECT event_id, receipt_id, ordinal, envelope_json FROM ${q(tables.event)}
      WHERE receipt_id = $1 ORDER BY ordinal LIMIT 33`,
        [receipt.id],
      )
    ).rows;
    if (rows.length !== manifest.length) return fail();
    const runtime = context(source, receipt, audit);
    const parsed = rows.map((row, ordinal) => {
      if (
        row.receipt_id !== receipt.id ||
        row.ordinal !== ordinal ||
        !uuid(row.event_id) ||
        typeof row.envelope_json !== 'string' ||
        Buffer.byteLength(row.envelope_json, 'utf8') > 131_072
      )
        return fail();
      const value: unknown = JSON.parse(row.envelope_json);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
      return { row, value: value as CommandEventEnvelope };
    });
    const captured = captureCommandEventBatch(
      parsed.map(({ value }) => ({ name: value.name, version: value.version, payloadJson: value.payloadJson })),
      manifest,
    );
    const events = parsed.map(({ row, value }, ordinal) => {
      const wanted = envelope(runtime, manifest, captured, ordinal, row.event_id as string);
      if (canonical(value, 131_072) !== canonical(wanted, 131_072) || row.envelope_json !== canonical(wanted, 131_072)) return fail();
      return wanted;
    });
    if (digest(manifest, events) !== batch.digest) return fail();
    return Object.freeze(events);
  } catch (error) {
    if (error instanceof CommandEventStoreUnavailable) throw error;
    return fail();
  }
}
