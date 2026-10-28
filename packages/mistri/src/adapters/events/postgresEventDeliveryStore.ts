/**
 * One destination's delivery store on PostgreSQL: the same namespace, rows,
 * history and rules as the SQLite store (shared through
 * eventDeliveryRules.ts and eventDeliverySource.ts), behind the same
 * contract, for several hosts sharing one database.
 *
 * What is different, and why:
 *
 * - Discovery walks event batches by the id of the transaction that wrote
 *   them. PostgreSQL assigns ids at insert, not at commit, so a high-water
 *   mark over any id would skip a transaction that committed late. Each
 *   destination keeps a cursor and moves it only past transactions no
 *   snapshot can still be waiting on (`pg_snapshot_xmin`), never past a
 *   batch it has not seen; the anti-join against receipt markers runs only
 *   over the unsettled window above it, not over the whole history.
 * - Claims take the next due row `FOR UPDATE SKIP LOCKED`: two hosts never
 *   lease the same delivery, and neither waits on the other's row.
 * - "Now" is the database's clock in each transaction, as in the job store,
 *   so hosts whose clocks disagree do not halt each other on the floor.
 * - Attestation compares a catalog description with the one pinned below,
 *   with the event store's and the journal's, in every transaction. The
 *   whole-history marker count the SQLite store checks is not repeated:
 *   foreign keys hold the association, and each row is verified against
 *   the receipt it belongs to when it is read.
 */
import { asBackgroundWork } from '@mistriwork/engine/adapters/writeLanes.js';
import { randomUUID } from 'node:crypto';
import { COMMAND_JOURNAL_TABLES as journal } from '../commands/commandJournal.js';
import {
  describePostgresRelations,
  withPostgresMaintenanceTransaction,
  type PostgresRelationDescription,
} from '../commands/postgresCommandJournal.js';
import type { PgQuery, PgWriteClientSource } from '@mistriwork/engine/adapters/postgresPool.js';
import { foldRelations, layoutTrust, type LayoutTrust } from '../commands/postgresRelations.js';
import { canonicalCommandJson } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { COMMAND_EVENT_TABLES as eventTables } from './commandEventSchema.js';
import { NOTIFY_COMMAND_EVENTS } from './postgresCommandEventWake.js';
import type { CommandEventEnvelope } from './commandEventTypes.js';
import type { EventDeliveryStore } from './eventDeliveryContract.js';
import {
  assertDeliveryRedrivable,
  captureDeliveryCompletion,
  captureDeliveryEventId,
  captureDeliveryInspect,
  captureDeliveryPrune,
  DELIVERY_MAX_CLOCK,
  deliveryAttemptInspection,
  deliveryBackoff,
  deliveryStateAfter,
  inspectDeliveryRow,
  verifyDeliveryHistory,
  type DeliveryRow,
} from './eventDeliveryRules.js';
import { EVENT_DELIVERY_PREFIX, EVENT_DELIVERY_TABLES as t } from './eventDeliverySchema.js';
import { layoutRefusal, postgresLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import { EVENT_DELIVERY_RECEIPT_BOUNDS, eventDeliveryReceiptContext, eventDeliveryRouteFor, firstTargetOf } from './eventDeliverySource.js';
import { COMPLETED_AT } from '../commands/postgresCommandJournalSchema.js';
import {
  captureEventDeliveryPolicy,
  captureEventOperator,
  deliveryFail,
  deliveryInteger,
  deliveryStanding,
  deliveryRefuse,
  deliveryText,
  EventDeliveryRefusal,
  EventDeliveryUnavailable,
  EVENT_DELIVERY_ATTEMPT_OUTCOMES,
  EVENT_DELIVERY_CODES,
  EVENT_DELIVERY_HISTORY_LIMIT,
  EVENT_DELIVERY_OPEN,
  EVENT_DELIVERY_REDRIVE_LIMIT,
  EVENT_DELIVERY_STATES,
  type EventDeliveryCode,
  type EventDeliveryOutcome,
  type EventDeliveryPolicy,
} from './eventDeliveryTypes.js';
import { assertPostgresCommandEventStore, assertPostgresCommandEvents } from './postgresCommandEventStore.js';
import { runtimeName, runtimeSchema, runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';

const q = (name: string) => runtimeTable('postgres', name);
// Index and constraint names are PostgreSQL's own, so they take the table names' Postgres spelling.
const PG_PREFIX = runtimeName('postgres', EVENT_DELIVERY_PREFIX);
const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');
const OPEN = list(EVENT_DELIVERY_OPEN);

/* A CHECK that evaluates to NULL passes, so every conditional column is
   tested with IS [NOT] NULL first. A destination's cursor starts below
   every transaction id, so a new destination takes the store from its start. */
/* PostgreSQL: a meta row per App, as the event store beneath
   keeps one (postgresCommandEventStore.ts), each with the App's source
   binding and its own clock floor. A destination's policy names its App's
   source, discovery reads only that App's batches, and the sixteen
   destinations are per App. SQLite keeps one App per file. */
const POSTGRES_EVENT_DELIVERY_STORE_VERSION = 1;
const VERSION = POSTGRES_EVENT_DELIVERY_STORE_VERSION;
const META_DDL = `CREATE TABLE ${q(t.meta)} (
  app_id text COLLATE "C" PRIMARY KEY CHECK (octet_length(app_id) BETWEEN 1 AND 128),
  version integer NOT NULL CHECK (version = ${VERSION}),
  binding_json text COLLATE "C" NOT NULL CHECK (octet_length(binding_json) BETWEEN 1 AND 2048),
  last_clock bigint NOT NULL CHECK (last_clock >= 0)
)`;
const EVENT_DELIVERY_POSTGRES_DEFINITIONS: readonly string[] = [
  META_DDL,
  `CREATE TABLE ${q(t.destination)} (
  id text COLLATE "C" PRIMARY KEY CHECK (octet_length(id) BETWEEN 1 AND 128),
  policy_json text COLLATE "C" NOT NULL CHECK (octet_length(policy_json) BETWEEN 1 AND 65536),
  scanned_count bigint NOT NULL CHECK (scanned_count >= 0),
  cursor_xact xid8 NOT NULL
)`,
  `CREATE TABLE ${q(t.receipt)} (
  destination_id text COLLATE "C" NOT NULL REFERENCES ${q(t.destination)} (id) ON DELETE RESTRICT,
  receipt_id text COLLATE "C" NOT NULL REFERENCES ${q(journal.receipt)} (id) ON DELETE RESTRICT,
  event_count integer NOT NULL CHECK (event_count BETWEEN 0 AND 32),
  pruned_at bigint CHECK (pruned_at IS NULL OR (pruned_at >= 0 AND event_count > 0)),
  PRIMARY KEY (destination_id, receipt_id)
)`,
  `CREATE TABLE ${q(t.delivery)} (
  destination_id text COLLATE "C" NOT NULL REFERENCES ${q(t.destination)} (id) ON DELETE RESTRICT,
  event_id text COLLATE "C" NOT NULL REFERENCES ${q(eventTables.event)} (event_id) ON DELETE RESTRICT,
  receipt_id text COLLATE "C" NOT NULL REFERENCES ${q(journal.receipt)} (id) ON DELETE RESTRICT,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 31),
  state text COLLATE "C" NOT NULL CHECK (state IN (${list(EVENT_DELIVERY_STATES)})),
  attempts integer NOT NULL CHECK (attempts BETWEEN 0 AND ${EVENT_DELIVERY_HISTORY_LIMIT}),
  redrives integer NOT NULL CHECK (redrives BETWEEN 0 AND ${EVENT_DELIVERY_REDRIVE_LIMIT}),
  attempt_limit integer NOT NULL CHECK (attempt_limit BETWEEN 1 AND ${EVENT_DELIVERY_HISTORY_LIMIT}),
  next_at bigint NOT NULL CHECK (next_at >= 0),
  token text COLLATE "C",
  lease_until bigint,
  last_code text COLLATE "C" CHECK (last_code IN (${list(EVENT_DELIVERY_CODES)})),
  PRIMARY KEY (destination_id, event_id),
  -- Named: the name PostgreSQL would choose depends on the prefix's length (cut at 63 bytes).
  CONSTRAINT "${PG_PREFIX}delivery_destination_id_receipt_id_ord_key" UNIQUE (destination_id, receipt_id, ordinal),
  CHECK (attempts <= attempt_limit),
  CHECK ((state = 'leased' AND token IS NOT NULL AND octet_length(token) = 36 AND lease_until IS NOT NULL AND lease_until >= 0 AND attempts > 0)
    OR (state <> 'leased' AND token IS NULL AND lease_until IS NULL)),
  CHECK ((state = 'pending' AND attempts = 0 AND last_code IS NULL) OR (state <> 'pending' AND attempts > 0))
)`,
  `CREATE TABLE ${q(t.attempt)} (
  destination_id text COLLATE "C" NOT NULL,
  event_id text COLLATE "C" NOT NULL,
  attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND ${EVENT_DELIVERY_HISTORY_LIMIT}),
  token text COLLATE "C" UNIQUE CHECK (token IS NULL OR octet_length(token) = 36),
  started_at bigint NOT NULL CHECK (started_at >= 0),
  deadline bigint,
  outcome text COLLATE "C" NOT NULL CHECK (outcome IN (${list(EVENT_DELIVERY_ATTEMPT_OUTCOMES)})),
  code text COLLATE "C" CHECK (code IN (${list(EVENT_DELIVERY_CODES)})),
  finished_at bigint,
  operator text COLLATE "C" CHECK (operator IS NULL OR octet_length(operator) BETWEEN 1 AND 128),
  PRIMARY KEY (destination_id, event_id, attempt),
  FOREIGN KEY (destination_id, event_id) REFERENCES ${q(t.delivery)} (destination_id, event_id) ON DELETE RESTRICT,
  CHECK ((outcome = 'redriven' AND token IS NULL AND deadline IS NULL AND code IS NOT NULL AND code = 'redriven'
      AND finished_at IS NOT NULL AND finished_at = started_at AND operator IS NOT NULL)
    OR (outcome <> 'redriven' AND token IS NOT NULL AND deadline IS NOT NULL AND deadline > started_at AND operator IS NULL
      AND ((outcome = 'leased' AND code IS NULL AND finished_at IS NULL)
        OR (outcome <> 'leased' AND code IS NOT NULL AND code <> 'redriven' AND finished_at IS NOT NULL AND finished_at >= started_at))))
)`,
  `CREATE INDEX "${PG_PREFIX}ready" ON ${q(t.delivery)} (destination_id, state, next_at)`,
  `CREATE INDEX "${PG_PREFIX}live" ON ${q(t.receipt)} (destination_id) WHERE pruned_at IS NULL AND event_count > 0`,
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
    'delivery_attempt',
    [
      column('destination_id', 'text', true, 'C'),
      column('event_id', 'text', true, 'C'),
      column('attempt', 'integer', true, null),
      column('token', 'text', false, 'C'),
      column('started_at', 'bigint', true, null),
      column('deadline', 'bigint', false, null),
      column('outcome', 'text', true, 'C'),
      column('code', 'text', false, 'C'),
      column('finished_at', 'bigint', false, null),
      column('operator', 'text', false, 'C'),
    ],
    [
      "CHECK ((((outcome = 'redriven'::text) AND (token IS NULL) AND (deadline IS NULL) AND (code IS NOT NULL) AND (code = 'redriven'::text) AND (finished_at IS NOT NULL) AND (finished_at = started_at) AND (operator IS NOT NULL)) OR ((outcome <> 'redriven'::text) AND (token IS NOT NULL) AND (deadline IS NOT NULL) AND (deadline > started_at) AND (operator IS NULL) AND (((outcome = 'leased'::text) AND (code IS NULL) AND (finished_at IS NULL)) OR ((outcome <> 'leased'::text) AND (code IS NOT NULL) AND (code <> 'redriven'::text) AND (finished_at IS NOT NULL) AND (finished_at >= started_at))))))",
      'CHECK (((attempt >= 1) AND (attempt <= 67)))',
      'CHECK (((operator IS NULL) OR ((octet_length(operator) >= 1) AND (octet_length(operator) <= 128))))',
      'CHECK (((token IS NULL) OR (octet_length(token) = 36)))',
      "CHECK ((code = ANY (ARRAY['accepted'::text, 'rejected'::text, 'transport'::text, 'timeout'::text, 'shutdown'::text, 'lease_expired'::text, 'redriven'::text])))",
      "CHECK ((outcome = ANY (ARRAY['leased'::text, 'accepted'::text, 'rejected'::text, 'unknown'::text, 'redriven'::text])))",
      'CHECK ((started_at >= 0))',
      'FOREIGN KEY (destination_id, event_id) REFERENCES delivery_delivery(destination_id, event_id) ON DELETE RESTRICT',
      'PRIMARY KEY (destination_id, event_id, attempt)',
      'UNIQUE (token)',
    ],
    [
      `CREATE UNIQUE INDEX delivery_attempt_pkey ON ${runtimeSchema('postgres')}.delivery_attempt USING btree (destination_id, event_id, attempt)`,
      `CREATE UNIQUE INDEX delivery_attempt_token_key ON ${runtimeSchema('postgres')}.delivery_attempt USING btree (token)`,
    ],
  ),
  relation(
    'delivery_delivery',
    [
      column('destination_id', 'text', true, 'C'),
      column('event_id', 'text', true, 'C'),
      column('receipt_id', 'text', true, 'C'),
      column('ordinal', 'integer', true, null),
      column('state', 'text', true, 'C'),
      column('attempts', 'integer', true, null),
      column('redrives', 'integer', true, null),
      column('attempt_limit', 'integer', true, null),
      column('next_at', 'bigint', true, null),
      column('token', 'text', false, 'C'),
      column('lease_until', 'bigint', false, null),
      column('last_code', 'text', false, 'C'),
    ],
    [
      "CHECK ((((state = 'leased'::text) AND (token IS NOT NULL) AND (octet_length(token) = 36) AND (lease_until IS NOT NULL) AND (lease_until >= 0) AND (attempts > 0)) OR ((state <> 'leased'::text) AND (token IS NULL) AND (lease_until IS NULL))))",
      "CHECK ((((state = 'pending'::text) AND (attempts = 0) AND (last_code IS NULL)) OR ((state <> 'pending'::text) AND (attempts > 0))))",
      'CHECK (((attempt_limit >= 1) AND (attempt_limit <= 67)))',
      'CHECK (((attempts >= 0) AND (attempts <= 67)))',
      'CHECK (((ordinal >= 0) AND (ordinal <= 31)))',
      'CHECK (((redrives >= 0) AND (redrives <= 3)))',
      'CHECK ((attempts <= attempt_limit))',
      "CHECK ((last_code = ANY (ARRAY['accepted'::text, 'rejected'::text, 'transport'::text, 'timeout'::text, 'shutdown'::text, 'lease_expired'::text, 'redriven'::text])))",
      'CHECK ((next_at >= 0))',
      "CHECK ((state = ANY (ARRAY['pending'::text, 'leased'::text, 'retry'::text, 'unknown'::text, 'delivered'::text, 'failed'::text])))",
      'FOREIGN KEY (destination_id) REFERENCES delivery_destination(id) ON DELETE RESTRICT',
      'FOREIGN KEY (event_id) REFERENCES event_event(event_id) ON DELETE RESTRICT',
      'FOREIGN KEY (receipt_id) REFERENCES command_receipt(id) ON DELETE RESTRICT',
      'PRIMARY KEY (destination_id, event_id)',
      'UNIQUE (destination_id, receipt_id, ordinal)',
    ],
    [
      `CREATE INDEX delivery_ready ON ${runtimeSchema('postgres')}.delivery_delivery USING btree (destination_id, state, next_at)`,
      `CREATE UNIQUE INDEX delivery_delivery_destination_id_receipt_id_ord_key ON ${runtimeSchema('postgres')}.delivery_delivery USING btree (destination_id, receipt_id, ordinal)`,
      `CREATE UNIQUE INDEX delivery_delivery_pkey ON ${runtimeSchema('postgres')}.delivery_delivery USING btree (destination_id, event_id)`,
    ],
  ),
  relation(
    'delivery_destination',
    [
      column('id', 'text', true, 'C'),
      column('policy_json', 'text', true, 'C'),
      column('scanned_count', 'bigint', true, null),
      column('cursor_xact', 'xid8', true, null),
    ],
    [
      'CHECK (((octet_length(id) >= 1) AND (octet_length(id) <= 128)))',
      'CHECK (((octet_length(policy_json) >= 1) AND (octet_length(policy_json) <= 65536)))',
      'CHECK ((scanned_count >= 0))',
      'PRIMARY KEY (id)',
    ],
    [`CREATE UNIQUE INDEX delivery_destination_pkey ON ${runtimeSchema('postgres')}.delivery_destination USING btree (id)`],
  ),
  relation(
    'delivery_meta',
    [
      column('app_id', 'text', true, 'C'),
      column('version', 'integer', true, null),
      column('binding_json', 'text', true, 'C'),
      column('last_clock', 'bigint', true, null),
    ],
    [
      'CHECK (((octet_length(app_id) >= 1) AND (octet_length(app_id) <= 128)))',
      'CHECK (((octet_length(binding_json) >= 1) AND (octet_length(binding_json) <= 2048)))',
      'CHECK ((last_clock >= 0))',
      'CHECK ((version = 1))',
      'PRIMARY KEY (app_id)',
    ],
    [`CREATE UNIQUE INDEX delivery_meta_pkey ON ${runtimeSchema('postgres')}.delivery_meta USING btree (app_id)`],
  ),
  relation(
    'delivery_receipt',
    [
      column('destination_id', 'text', true, 'C'),
      column('receipt_id', 'text', true, 'C'),
      column('event_count', 'integer', true, null),
      column('pruned_at', 'bigint', false, null),
    ],
    [
      'CHECK (((event_count >= 0) AND (event_count <= 32)))',
      'CHECK (((pruned_at IS NULL) OR ((pruned_at >= 0) AND (event_count > 0))))',
      'FOREIGN KEY (destination_id) REFERENCES delivery_destination(id) ON DELETE RESTRICT',
      'FOREIGN KEY (receipt_id) REFERENCES command_receipt(id) ON DELETE RESTRICT',
      'PRIMARY KEY (destination_id, receipt_id)',
    ],
    [
      `CREATE INDEX delivery_live ON ${runtimeSchema('postgres')}.delivery_receipt USING btree (destination_id) WHERE ((pruned_at IS NULL) AND (event_count > 0))`,
      `CREATE UNIQUE INDEX delivery_receipt_pkey ON ${runtimeSchema('postgres')}.delivery_receipt USING btree (destination_id, receipt_id)`,
    ],
  ),
];

const BIGINTS = new Set([
  'next_at',
  'lease_until',
  'started_at',
  'deadline',
  'finished_at',
  'last_clock',
  'scanned_count',
  'pruned_at',
  'now',
]);
/** pg returns bigint as text. A value past 2^53 is damage here, never a number to round. */
function normal(row: Record<string, unknown>): DeliveryRow {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] =
      BIGINTS.has(key) && typeof value === 'string'
        ? /^(0|[1-9][0-9]{0,15})$/.test(value) && Number.isSafeInteger(Number(value))
          ? Number(value)
          : Number.NaN
        : value;
  }
  return out;
}
const read = async (client: PgQuery, text: string, values: unknown[] = []): Promise<DeliveryRow[]> =>
  (await client.query(text, values)).rows.map(normal);
const safe = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const canonical = (value: readonly PostgresRelationDescription[]) => canonicalCommandJson(foldRelations(value), 1_048_576);

/** Exact layout, the source it is bound to, and this destination's own
 * immutable policy. Also attests the event store and the journal beneath.
 * A tenant enrollment attests it in its read snapshot too. */
export async function assertPostgresEventDeliveryStore(
  client: PgQuery,
  input: EventDeliveryPolicy,
  allowNewDestination = false,
  trust?: LayoutTrust,
): Promise<void> {
  try {
    const policy = captureEventDeliveryPolicy(input);
    await assertPostgresCommandEventStore(client, policy.source, trust);
    const described = async () => {
      if (canonical(await describePostgresRelations(client, EVENT_DELIVERY_PREFIX)) !== canonical(LAYOUT))
        return deliveryFail(layoutRefusal('The event delivery store', await postgresLayoutVersion(client, q(t.meta)), VERSION));
    };
    await (trust ? trust.through(EVENT_DELIVERY_PREFIX, described) : described());
    const meta = await read(client, `SELECT version, binding_json, last_clock FROM ${q(t.meta)} WHERE app_id = $1`, [policy.source.appId]);
    if (
      meta.length !== 1 ||
      meta[0].version !== VERSION ||
      meta[0].binding_json !== canonicalCommandJson(policy.source) ||
      !safe(meta[0].last_clock)
    )
      return deliveryFail(layoutRefusal('The event delivery store', meta.length === 1 ? meta[0].version : undefined, VERSION));
    const destination = await read(client, `SELECT policy_json, scanned_count FROM ${q(t.destination)} WHERE id = $1`, [
      policy.destinationId,
    ]);
    if (!destination.length && allowNewDestination) return;
    if (
      destination.length !== 1 ||
      destination[0].policy_json !== canonicalCommandJson(policy, 65_536) ||
      !safe(destination[0].scanned_count)
    )
      return deliveryFail();
  } catch (error) {
    if (error instanceof EventDeliveryUnavailable) throw error;
    return deliveryFail();
  }
}

/** Explicit maintenance, under the shared migration lock, on a database
 * whose event store is already provisioned: creates the namespace where
 * there is none, and adds this destination (at most sixteen). An existing
 * destination must carry the same policy. Several hosts may keep running. */
export async function provisionPostgresEventDeliveryStore(
  url: string,
  input: EventDeliveryPolicy,
): Promise<{ version: 1; provisioned: boolean; destinationAdded: boolean }> {
  const policy = captureEventDeliveryPolicy(input);
  try {
    return await withPostgresMaintenanceTransaction(url, async (client) => {
      await assertPostgresCommandEventStore(client, policy.source);
      if (!(await describePostgresRelations(client, EVENT_DELIVERY_PREFIX)).length) {
        for (const ddl of EVENT_DELIVERY_POSTGRES_DEFINITIONS) await client.query(ddl);
      }
      const provisioned =
        (
          await client.query(
            `INSERT INTO ${q(t.meta)} (app_id, version, binding_json, last_clock) VALUES ($1, $2, $3, 0)
        ON CONFLICT (app_id) DO NOTHING`,
            [policy.source.appId, VERSION, canonicalCommandJson(policy.source)],
          )
        ).rowCount === 1;
      await assertPostgresEventDeliveryStore(client, policy, true);
      const present = (await client.query(`SELECT 1 FROM ${q(t.destination)} WHERE id = $1`, [policy.destinationId])).rows.length > 0;
      if (!present) {
        // Sixteen per App: another App's destinations on this database are not this one's to count.
        const count = Number(
          (
            await client.query(
              `SELECT count(*)::int AS n FROM ${q(t.destination)}
          WHERE (policy_json::json -> 'source' ->> 'appId') = $1`,
              [policy.source.appId],
            )
          ).rows[0].n,
        );
        if (!Number.isSafeInteger(count) || count >= 16) return deliveryFail();
        await client.query(`INSERT INTO ${q(t.destination)} (id, policy_json, scanned_count, cursor_xact) VALUES ($1, $2, 0, '0'::xid8)`, [
          policy.destinationId,
          canonicalCommandJson(policy, 65_536),
        ]);
      }
      await assertPostgresEventDeliveryStore(client, policy);
      return { version: VERSION as 1, provisioned, destinationAdded: !present };
    });
  } catch {
    return deliveryFail();
  }
}

/** The receipt and first audit row, bounded in JavaScript (PostgreSQL text
 * holds no NUL), then read under the rules the SQLite reader uses. */
export async function readPostgresEventDeliveryReceipt(
  client: PgQuery,
  policy: EventDeliveryPolicy,
  receiptId: string,
): Promise<readonly CommandEventEnvelope[]> {
  deliveryText(receiptId, 128);
  const bounds = EVENT_DELIVERY_RECEIPT_BOUNDS;
  const r = (
    await client.query(
      `SELECT ${Object.keys(bounds.receipt)
        .map((name) => (name === 'completed_at' ? `${COMPLETED_AT} AS completed_at` : name))
        .join(', ')}, command_version FROM ${q(journal.receipt)}
    WHERE id = $1`,
      [receiptId],
    )
  ).rows;
  if (r.length !== 1) return deliveryFail();
  for (const [name, limit] of Object.entries(bounds.receipt)) {
    const value = r[0][name];
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > limit || (!value.length && !bounds.empty.includes(name)))
      return deliveryFail();
  }
  const a = [firstTargetOf(r[0]) ?? deliveryFail()];
  const { owner, receipt, audit } = eventDeliveryReceiptContext(policy, r[0], a[0], receiptId);
  const route = eventDeliveryRouteFor(policy, owner, receipt.commandId, receipt.commandVersion);
  if (!route) return Object.freeze([]);
  return assertPostgresCommandEvents(client, owner, receipt, audit, route.manifest);
}

export interface PostgresEventDeliveryStoreOptions {
  /** 'database' (the default) takes now from the database in each
   * transaction; 'caller' uses the `now` each call passes, as SQLite does. */
  readonly clock?: 'database' | 'caller';
}

export async function openPostgresEventDeliveryStore(
  connection: PgWriteClientSource,
  input: EventDeliveryPolicy,
  options: PostgresEventDeliveryStoreOptions = {},
): Promise<EventDeliveryStore> {
  const policy = captureEventDeliveryPolicy(input),
    clock = options.clock ?? 'database';
  if (!connection || typeof connection.withWriteClient !== 'function' || (clock !== 'database' && clock !== 'caller'))
    return deliveryFail();
  const destination = policy.destinationId,
    limits = policy.limits;
  let closed = false;
  /* The layouts the poller's transactions attest, kept across them (postgresRelations.ts LayoutTrust). */
  const trust = layoutTrust();

  /** One transaction on one leased client. A coded refusal rolls back and
   * keeps the client; anything else destroys it and is unavailability.
   * `bump` moves the clock floor, which a claim does as it leases. */
  const transaction = async <T>(
    mode: 'read' | 'write',
    host: number | undefined,
    work: (client: PgQuery, now: number) => Promise<T>,
    bump = false,
  ): Promise<T> => {
    if (closed) return deliveryFail();
    if (host !== undefined) deliveryInteger(host, 0, DELIVERY_MAX_CLOCK);
    let refusal: EventDeliveryRefusal | undefined;
    try {
      const result = await asBackgroundWork(() =>
        connection.withWriteClient(async (client) => {
          /* A read verifies a row against its history in a second statement, so it
           reads one snapshot: at READ COMMITTED a host's attempt committing
           between the two made a sound row look inconsistent, and the read refused. */
          await client.query(mode === 'read' ? 'BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ' : 'BEGIN');
          try {
            await assertPostgresEventDeliveryStore(client, policy, false, trust);
            let now = 0;
            if (host !== undefined) {
              // Floor first, clock second, as in the job store.
              const floor = (await read(client, `SELECT last_clock FROM ${q(t.meta)} WHERE app_id = $1`, [policy.source.appId]))[0]
                ?.last_clock;
              now =
                clock === 'caller'
                  ? host
                  : ((await read(client, 'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now'))[0].now as number);
              if (!safe(floor) || !safe(now) || now > DELIVERY_MAX_CLOCK || now < floor) return deliveryFail();
              if (bump)
                await client.query(`UPDATE ${q(t.meta)} SET last_clock = $1 WHERE app_id = $2 AND last_clock < $1`, [
                  now,
                  policy.source.appId,
                ]);
            }
            const value = await work(client, now);
            await client.query('COMMIT');
            return value;
          } catch (error) {
            // Any failure re-attests next time: a moved table or column surfaces here first.
            trust.forget();
            try {
              await client.query('ROLLBACK');
            } catch {
              throw new EventDeliveryUnavailable();
            }
            if (error instanceof EventDeliveryRefusal) {
              refusal = error;
              return undefined as T;
            }
            throw error;
          }
        }),
      );
      if (refusal) throw refusal;
      return result;
    } catch (error) {
      if (error instanceof EventDeliveryRefusal || error instanceof EventDeliveryUnavailable) throw error;
      return deliveryFail();
    }
  };
  await transaction('read', undefined, async () => {});

  const history = (client: PgQuery, eventId: string) =>
    read(
      client,
      `SELECT * FROM ${q(t.attempt)}
    WHERE destination_id = $1 AND event_id = $2 ORDER BY attempt LIMIT ${EVENT_DELIVERY_HISTORY_LIMIT + 1}`,
      [destination, eventId],
    );
  const rowOf = async (client: PgQuery, eventId: string, lock = false) =>
    (
      await read(
        client,
        `SELECT * FROM ${q(t.delivery)}
    WHERE destination_id = $1 AND event_id = $2${lock ? ' FOR UPDATE' : ''}`,
        [destination, eventId],
      )
    )[0];
  const verifyRow = async (client: PgQuery, row: DeliveryRow): Promise<CommandEventEnvelope> => {
    inspectDeliveryRow(row);
    const events = await readPostgresEventDeliveryReceipt(client, policy, row.receipt_id as string);
    const envelope = events[row.ordinal as number];
    if (!envelope || envelope.eventId !== row.event_id) return deliveryFail();
    // Receipt order must be represented completely. Missing delivery rows are
    // corruption, never permission to skip an earlier declaration.
    const siblings = await read(
      client,
      `SELECT event_id, ordinal FROM ${q(t.delivery)}
      WHERE destination_id = $1 AND receipt_id = $2 ORDER BY ordinal LIMIT 33`,
      [destination, envelope.receiptId],
    );
    if (siblings.length !== events.length || siblings.some((sibling, i) => sibling.ordinal !== i || sibling.event_id !== events[i].eventId))
      return deliveryFail();
    verifyDeliveryHistory(policy, row, await history(client, envelope.eventId));
    return envelope;
  };
  const settle = async (
    client: PgQuery,
    row: DeliveryRow,
    outcome: EventDeliveryOutcome,
    code: EventDeliveryCode,
    now: number,
    nextAt: number,
  ) => {
    const state = deliveryStateAfter(row, outcome);
    const attempt = await client.query(
      `UPDATE ${q(t.attempt)} SET outcome = $1, code = $2, finished_at = $3
      WHERE destination_id = $4 AND event_id = $5 AND attempt = $6 AND token = $7 AND outcome = 'leased'`,
      [outcome, code, now, destination, row.event_id, row.attempts, row.token],
    );
    if (attempt.rowCount !== 1) return deliveryFail();
    const changed = await client.query(
      `UPDATE ${q(t.delivery)} SET state = $1, next_at = $2, token = NULL, lease_until = NULL, last_code = $3
      WHERE destination_id = $4 AND event_id = $5 AND state = 'leased' AND token = $6 AND attempts = $7`,
      [state, nextAt, code, destination, row.event_id, row.token, row.attempts],
    );
    if (changed.rowCount !== 1) return deliveryFail();
  };
  /* A batch is its receipt row's, and this App's when the row is: the journal is shared by every App on the database. */
  const unseen = `b.app_id = $4 AND NOT EXISTS (SELECT 1 FROM ${q(t.receipt)} seen WHERE seen.destination_id = $2 AND seen.receipt_id = b.id)`;

  const store: EventDeliveryStore = {
    policy,
    discover: () =>
      transaction('write', undefined, async (client) => {
        // Read first: every transaction below this id had finished by then, so
        // any of its batches that committed is visible to what follows.
        const horizon = String((await client.query('SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS horizon')).rows[0].horizon);
        const own = (
          await client.query(`SELECT cursor_xact::text AS cursor FROM ${q(t.destination)} WHERE id = $1 FOR UPDATE`, [destination])
        ).rows[0];
        if (!own) return deliveryFail();
        const cursor = String(own.cursor);
        let open = Number(
          (
            await client.query(
              `SELECT count(*)::int AS n FROM ${q(t.delivery)}
        WHERE destination_id = $1 AND state IN (${OPEN})`,
              [destination],
            )
          ).rows[0].n,
        );
        if (!Number.isSafeInteger(open) || open > limits.maxRetained) return deliveryFail();
        const candidates = await read(
          client,
          `SELECT b.id AS receipt_id FROM ${q(journal.receipt)} b WHERE b.xact_id >= $1::xid8 AND ${unseen}
        ORDER BY b.xact_id, b.id LIMIT $3`,
          [cursor, destination, limits.scanBatch, policy.source.appId],
        );
        let scanned = 0,
          scheduled = 0,
          pressure = false;
        for (const candidate of candidates) {
          const receiptId = candidate.receipt_id as string;
          const events = await readPostgresEventDeliveryReceipt(client, policy, receiptId);
          const existing = await read(
            client,
            `SELECT event_id, ordinal FROM ${q(t.delivery)}
          WHERE destination_id = $1 AND receipt_id = $2 ORDER BY ordinal LIMIT 33`,
            [destination, receiptId],
          );
          if (
            existing.length &&
            (existing.length !== events.length || existing.some((saved, i) => saved.event_id !== events[i].eventId || saved.ordinal !== i))
          )
            return deliveryFail();
          const additional = existing.length ? 0 : events.length;
          // A whole receipt or none of it: an ordered batch is never split.
          if (open + additional > limits.maxRetained) {
            pressure = true;
            break;
          }
          if (!existing.length)
            for (const event of events) {
              await client.query(
                `INSERT INTO ${q(t.delivery)}
            (destination_id, event_id, receipt_id, ordinal, state, attempts, redrives, attempt_limit, next_at, token, lease_until, last_code)
            VALUES ($1, $2, $3, $4, 'pending', 0, 0, $5, 0, NULL, NULL, NULL)`,
                [destination, event.eventId, event.receiptId, event.ordinal, limits.maxAttempts],
              );
            }
          open += additional;
          scheduled += additional;
          scanned++;
          await client.query(`INSERT INTO ${q(t.receipt)} (destination_id, receipt_id, event_count, pruned_at) VALUES ($1, $2, $3, NULL)`, [
            destination,
            receiptId,
            events.length,
          ]);
        }
        if (scanned)
          await client.query(`UPDATE ${q(t.destination)} SET scanned_count = scanned_count + $1 WHERE id = $2`, [scanned, destination]);
        // Past every batch this destination has seen, but never past one a
        // transaction still in flight may yet commit.
        await client.query(
          `UPDATE ${q(t.destination)} SET cursor_xact = next.xact
        FROM (SELECT LEAST($1::xid8, COALESCE((SELECT min(b.xact_id) FROM ${q(journal.receipt)} b WHERE b.xact_id >= $3::xid8 AND ${unseen}),
          $1::xid8)) AS xact) next
        WHERE id = $2 AND cursor_xact < next.xact`,
          [horizon, destination, cursor, policy.source.appId],
        );
        return { scanned, scheduled, pressure };
      }),
    claim: (now) =>
      transaction(
        'write',
        now,
        async (client, at) => {
          // Recover a bounded number of abandoned attempts, retaining ambiguity.
          const expired = await read(
            client,
            `SELECT * FROM ${q(t.delivery)} WHERE destination_id = $1
        AND state = 'leased' AND lease_until <= $2 ORDER BY lease_until, event_id LIMIT 8 FOR UPDATE SKIP LOCKED`,
            [destination, at],
          );
          for (const row of expired) {
            await verifyRow(client, row);
            await settle(client, row, 'unknown', 'lease_expired', at, (row.lease_until as number) + deliveryBackoff(policy, row));
          }
          const row = (
            await read(
              client,
              `SELECT d.* FROM ${q(t.delivery)} d WHERE d.destination_id = $1
        AND d.state IN ('pending', 'retry', 'unknown') AND d.next_at <= $2 AND d.attempts < d.attempt_limit
        AND NOT EXISTS (SELECT 1 FROM ${q(t.delivery)} prior WHERE prior.destination_id = d.destination_id
          AND prior.receipt_id = d.receipt_id AND prior.ordinal < d.ordinal AND prior.state <> 'delivered')
        ORDER BY d.next_at, d.receipt_id, d.ordinal LIMIT 1 FOR UPDATE OF d SKIP LOCKED`,
              [destination, at],
            )
          )[0];
          if (!row) {
            // Nothing due. A receipt whose delivery rows went missing would look
            // the same: refuse that instead of reporting an empty queue. Only
            // receipts still holding rows are checked, not the kept history.
            if (
              (
                await client.query(
                  `SELECT 1 FROM ${q(t.receipt)} seen WHERE seen.destination_id = $1 AND seen.pruned_at IS NULL
          AND seen.event_count > 0 AND seen.event_count <> (SELECT count(*) FROM ${q(t.delivery)} d
            WHERE d.destination_id = seen.destination_id AND d.receipt_id = seen.receipt_id) LIMIT 1`,
                  [destination],
                )
              ).rows.length
            )
              return deliveryFail();
            return undefined;
          }
          const envelope = await verifyRow(client, row),
            attempt = (row.attempts as number) + 1,
            token = randomUUID(),
            deadline = at + limits.leaseMs;
          await client.query(
            `UPDATE ${q(t.delivery)} SET state = 'leased', attempts = $1, token = $2, lease_until = $3
        WHERE destination_id = $4 AND event_id = $5`,
            [attempt, token, deadline, destination, envelope.eventId],
          );
          await client.query(
            `INSERT INTO ${q(t.attempt)} (destination_id, event_id, attempt, token, started_at, deadline, outcome, code, finished_at, operator)
        VALUES ($1, $2, $3, $4, $5, $6, 'leased', NULL, NULL, NULL)`,
            [destination, envelope.eventId, attempt, token, at, deadline],
          );
          return Object.freeze({
            destinationId: destination,
            eventId: envelope.eventId,
            attempt,
            token,
            deadline,
            envelope,
          });
        },
        true,
      ),
    complete: async (claim, outcome, code, now) => {
      captureDeliveryCompletion(outcome, code);
      return transaction('write', now, async (client, at) => {
        if (claim.destinationId !== destination) return false;
        const row = await rowOf(client, claim.eventId, true);
        if (
          !row ||
          row.state !== 'leased' ||
          row.token !== claim.token ||
          row.attempts !== claim.attempt ||
          row.lease_until !== claim.deadline ||
          at >= claim.deadline
        )
          return false;
        await verifyRow(client, row);
        await settle(client, row, outcome, code, at, outcome === 'accepted' ? at : at + deliveryBackoff(policy, row));
        return true;
      });
    },
    inspect: async (state, afterEventId = '', limit = 32) => {
      captureDeliveryInspect(state, afterEventId, limit);
      return transaction('read', undefined, async (client) => {
        const rows = await read(
          client,
          `SELECT * FROM ${q(t.delivery)} WHERE destination_id = $1 AND event_id > $2
          ${state === undefined ? '' : 'AND state = $4'} ORDER BY event_id LIMIT $3`,
          state === undefined ? [destination, afterEventId, limit] : [destination, afterEventId, limit, state],
        );
        const inspected = [];
        for (const row of rows) {
          await verifyRow(client, row);
          inspected.push(inspectDeliveryRow(row));
        }
        return Object.freeze(inspected);
      });
    },
    /* One statement, no row verified: the host's readiness and its next wake read this (jobHost.ts). */
    standing: (now) => {
      deliveryInteger(now, 0, DELIVERY_MAX_CLOCK);
      return transaction('read', undefined, async (client) => {
        const [row] = await read(
          client,
          `WITH c AS (SELECT ${clock === 'caller' ? '$2::bigint' : 'floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint'} AS at)
          SELECT c.at,
            EXISTS (SELECT 1 FROM ${q(t.delivery)} WHERE destination_id = $1 AND state = 'failed') AS failed,
            (SELECT min(next_at) FROM ${q(t.delivery)} WHERE destination_id = $1 AND state IN ('pending', 'retry', 'unknown')) AS waiting,
            least((SELECT min(next_at) FROM ${q(t.delivery)} WHERE destination_id = $1 AND state IN ('pending', 'retry', 'unknown') AND next_at > c.at),
              (SELECT min(lease_until) FROM ${q(t.delivery)} WHERE destination_id = $1 AND state = 'leased' AND lease_until > c.at)) AS next
          FROM c`,
          clock === 'caller' ? [destination, now] : [destination],
        );
        return deliveryStanding(row as Readonly<Record<string, unknown>> | undefined);
      });
    },
    attempts: async (eventId) => {
      if (typeof eventId !== 'string' || eventId.length !== 36) return deliveryFail();
      return transaction('read', undefined, async (client) =>
        Object.freeze((await history(client, eventId)).map(deliveryAttemptInspection)),
      );
    },
    redrive: async (eventId, operator, now) => {
      const who = captureEventOperator(operator),
        id = captureDeliveryEventId(eventId);
      return transaction('write', now, async (client, at) => {
        const row = await rowOf(client, id, true);
        if (!row) return deliveryRefuse('not_found');
        await verifyRow(client, row);
        assertDeliveryRedrivable(row);
        const attempt = (row.attempts as number) + 1;
        await client.query(
          `INSERT INTO ${q(t.attempt)} (destination_id, event_id, attempt, token, started_at, deadline, outcome, code, finished_at, operator)
          VALUES ($1, $2, $3, NULL, $4, NULL, 'redriven', 'redriven', $4, $5)`,
          [destination, id, attempt, at, who],
        );
        const changed = await client.query(
          `UPDATE ${q(t.delivery)} SET state = 'retry', attempts = $1, redrives = redrives + 1,
          attempt_limit = $2, next_at = $3, token = NULL, lease_until = NULL, last_code = 'redriven'
          WHERE destination_id = $4 AND event_id = $5 AND attempts = $6`,
          [attempt, attempt + limits.maxAttempts, at, destination, id, row.attempts],
        );
        if (changed.rowCount !== 1) return deliveryFail();
        const after = (await rowOf(client, id))!;
        await verifyRow(client, after);
        // Due again: a host anywhere hears it at commit (postgresCommandEventWake.ts).
        await client.query(NOTIFY_COMMAND_EVENTS);
        return inspectDeliveryRow(after);
      });
    },
    prune: async (olderThanMs, now, limit = 64) => {
      captureDeliveryPrune(olderThanMs, limit);
      return transaction('write', now, async (client, at) => {
        // Whole receipts only: every declared fact delivered, the last of
        // them long enough ago. A partly delivered receipt keeps its order.
        const receipts = await read(
          client,
          `SELECT receipt_id FROM ${q(t.delivery)} WHERE destination_id = $1 GROUP BY receipt_id
          HAVING bool_and(state = 'delivered') AND max(next_at) < $2 ORDER BY max(next_at), receipt_id LIMIT $3`,
          [destination, at - olderThanMs, limit],
        );
        let deliveries = 0;
        for (const { receipt_id: receiptId } of receipts) {
          const marker = (
            await read(
              client,
              `SELECT event_count FROM ${q(t.receipt)}
            WHERE destination_id = $1 AND receipt_id = $2 AND pruned_at IS NULL FOR UPDATE`,
              [destination, receiptId],
            )
          )[0];
          if (!marker) return deliveryFail();
          await client.query(
            `DELETE FROM ${q(t.attempt)} WHERE destination_id = $1 AND event_id IN
            (SELECT event_id FROM ${q(t.delivery)} WHERE destination_id = $1 AND receipt_id = $2)`,
            [destination, receiptId],
          );
          const gone = await client.query(
            `DELETE FROM ${q(t.delivery)} WHERE destination_id = $1 AND receipt_id = $2 AND state = 'delivered'`,
            [destination, receiptId],
          );
          if (gone.rowCount !== marker.event_count) return deliveryFail();
          deliveries += gone.rowCount ?? 0;
          await client.query(`UPDATE ${q(t.receipt)} SET pruned_at = $1 WHERE destination_id = $2 AND receipt_id = $3`, [
            at,
            destination,
            receiptId,
          ]);
        }
        return Object.freeze({
          receipts: receipts.length,
          deliveries,
          more: receipts.length === limit,
        });
      });
    },
    close: async () => {
      closed = true;
    },
  };
  return Object.freeze(store);
}
