import { lstatSync, realpathSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { layoutRefusal, sqliteLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import { canonicalCommandJson } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { registerPrune } from '../retention/pruner.js';
import { attestEventDeliverySource } from './eventDeliverySource.js';
import {
  captureEventDeliveryPolicy,
  deliveryFail,
  EventDeliveryUnavailable,
  EVENT_DELIVERY_ATTEMPT_OUTCOMES,
  EVENT_DELIVERY_CODES,
  EVENT_DELIVERY_HISTORY_LIMIT,
  EVENT_DELIVERY_REDRIVE_LIMIT,
  EVENT_DELIVERY_STATES,
  type EventDeliveryPolicy,
} from './eventDeliveryTypes.js';

export const EVENT_DELIVERY_PREFIX = '__mistri_delivery_';
const prefix = EVENT_DELIVERY_PREFIX;
export const EVENT_DELIVERY_TABLES = Object.freeze({
  meta: `${prefix}meta`,
  destination: `${prefix}destination`,
  receipt: `${prefix}receipt`,
  delivery: `${prefix}delivery`,
  attempt: `${prefix}attempt`,
});
const t = EVENT_DELIVERY_TABLES;

/* The tries of a delivery that arrived, forgotten together (verifyDeliveryHistory
   accepts a delivered row with none). A delivery still pending, in flight,
   retrying, unknown or failed keeps every try: it awaits a redrive or an
   operator's reading. */
registerPrune({
  id: 'delivery-attempts',
  window: 'attempts',
  table: t.attempt,
  time: 'finished_at',
  group: ['destination_id', 'event_id'],
  clock: 'epoch-ms',
  where: (table) =>
    `outcome <> 'leased' AND (destination_id, event_id) IN (SELECT destination_id, event_id FROM ${table(t.delivery)} WHERE state = 'delivered')`,
});
const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(',');
const string = (name: string, max: number) =>
  `${name} TEXT COLLATE BINARY NOT NULL CHECK (typeof(${name})='text' AND instr(${name},char(0))=0 AND length(CAST(${name} AS BLOB)) BETWEEN 1 AND ${max})`;
const integer = (name: string, max = Number.MAX_SAFE_INTEGER) =>
  `${name} INTEGER NOT NULL CHECK (typeof(${name})='integer' AND ${name} BETWEEN 0 AND ${max})`;
/* A receipt marker is kept for good once its receipt is discovered, so a
   pruned receipt is never taken up again; `pruned_at` says its delivery
   rows are gone. A redrive is a history row of its own, with an operator
   and no lease. */
const definitions = new Map([
  [
    t.meta,
    `CREATE TABLE "${t.meta}" (
  singleton INTEGER PRIMARY KEY CHECK (singleton=1),
  version INTEGER NOT NULL CHECK (version=1),
  ${string('binding_json', 2048)},
  ${integer('last_clock')}
)`,
  ],
  [
    t.destination,
    `CREATE TABLE "${t.destination}" (
  ${string('id', 128)} PRIMARY KEY,
  ${string('policy_json', 65536)},
  ${integer('scanned_count')}
)`,
  ],
  [
    t.receipt,
    `CREATE TABLE "${t.receipt}" (
  ${string('destination_id', 128)} REFERENCES "${t.destination}" (id) ON DELETE RESTRICT,
  ${string('receipt_id', 128)} REFERENCES "__mistri_command_receipt" (id) ON DELETE RESTRICT,
  ${integer('event_count', 32)},
  pruned_at INTEGER CHECK (pruned_at IS NULL OR (typeof(pruned_at)='integer' AND pruned_at>=0 AND event_count>0)),
  PRIMARY KEY (destination_id,receipt_id)
)`,
  ],
  [
    t.delivery,
    `CREATE TABLE "${t.delivery}" (
  ${string('destination_id', 128)} REFERENCES "${t.destination}" (id) ON DELETE RESTRICT,
  ${string('event_id', 36)} REFERENCES "__mistri_event_event" (event_id) ON DELETE RESTRICT,
  ${string('receipt_id', 128)} REFERENCES "__mistri_command_receipt" (id) ON DELETE RESTRICT,
  ${integer('ordinal', 31)},
  state TEXT NOT NULL CHECK (state IN (${list(EVENT_DELIVERY_STATES)})),
  ${integer('attempts', EVENT_DELIVERY_HISTORY_LIMIT)},
  ${integer('redrives', EVENT_DELIVERY_REDRIVE_LIMIT)},
  attempt_limit INTEGER NOT NULL CHECK (typeof(attempt_limit)='integer' AND attempt_limit BETWEEN 1 AND ${EVENT_DELIVERY_HISTORY_LIMIT}),
  ${integer('next_at')},
  token TEXT,
  lease_until INTEGER,
  last_code TEXT CHECK (last_code IN (${list(EVENT_DELIVERY_CODES)})),
  PRIMARY KEY (destination_id,event_id),
  UNIQUE (destination_id,receipt_id,ordinal),
  CHECK (attempts<=attempt_limit),
  CHECK ((state='leased' AND typeof(token)='text' AND length(token)=36 AND typeof(lease_until)='integer' AND lease_until>=0 AND attempts>0)
    OR (state<>'leased' AND token IS NULL AND lease_until IS NULL)),
  CHECK ((state='pending' AND attempts=0 AND last_code IS NULL) OR (state<>'pending' AND attempts>0))
)`,
  ],
  [
    t.attempt,
    `CREATE TABLE "${t.attempt}" (
  ${string('destination_id', 128)},
  ${string('event_id', 36)},
  attempt INTEGER NOT NULL CHECK (typeof(attempt)='integer' AND attempt BETWEEN 1 AND ${EVENT_DELIVERY_HISTORY_LIMIT}),
  token TEXT UNIQUE CHECK (token IS NULL OR (typeof(token)='text' AND length(token)=36)),
  ${integer('started_at')},
  deadline INTEGER CHECK (deadline IS NULL OR typeof(deadline)='integer'),
  outcome TEXT NOT NULL CHECK (outcome IN (${list(EVENT_DELIVERY_ATTEMPT_OUTCOMES)})),
  code TEXT CHECK (code IN (${list(EVENT_DELIVERY_CODES)})),
  finished_at INTEGER,
  operator TEXT CHECK (operator IS NULL OR (typeof(operator)='text' AND instr(operator,char(0))=0 AND length(CAST(operator AS BLOB)) BETWEEN 1 AND 128)),
  PRIMARY KEY (destination_id,event_id,attempt),
  FOREIGN KEY (destination_id,event_id) REFERENCES "${t.delivery}" (destination_id,event_id) ON DELETE RESTRICT,
  CHECK ((outcome='redriven' AND token IS NULL AND deadline IS NULL AND code IS 'redriven' AND typeof(finished_at)='integer'
      AND finished_at=started_at AND operator IS NOT NULL)
    OR (outcome<>'redriven' AND typeof(token)='text' AND typeof(deadline)='integer' AND deadline>started_at AND operator IS NULL
      AND ((outcome='leased' AND code IS NULL AND finished_at IS NULL)
        OR (outcome<>'leased' AND code IS NOT NULL AND code<>'redriven' AND typeof(finished_at)='integer' AND finished_at>=started_at))))
)`,
  ],
  [`${prefix}ready`, `CREATE INDEX "${prefix}ready" ON "${t.delivery}" (destination_id,state,next_at)`],
]);
type Catalog = { type: string; name: string; tbl_name: string; sql: string | null };
function catalog(db: DatabaseSync, schema: 'main' | 'temp'): Catalog[] {
  return db
    .prepare(`SELECT type,name,tbl_name,sql FROM ${schema}.sqlite_schema
    WHERE substr(name,1,?)=? COLLATE NOCASE OR substr(tbl_name,1,?)=? COLLATE NOCASE`)
    .all(prefix.length, prefix, prefix.length, prefix) as unknown as Catalog[];
}
const SQLITE_EVENT_DELIVERY_VERSION = 1;
export function assertSqliteEventDeliveryStore(db: DatabaseSync, policy: EventDeliveryPolicy, allowNewDestination = false): void {
  try {
    attestEventDeliverySource(db, policy.source);
    const entries = catalog(db, 'main');
    if (
      catalog(db, 'temp').length ||
      entries.filter((entry) => entry.sql !== null).length !== definitions.size ||
      entries.some((entry) =>
        entry.sql === null ? entry.type !== 'index' || !definitions.has(entry.tbl_name) : definitions.get(entry.name) !== entry.sql,
      )
    )
      return deliveryFail(layoutRefusal('The event delivery store', sqliteLayoutVersion(db, t.meta), SQLITE_EVENT_DELIVERY_VERSION));
    const meta = db
      .prepare(`SELECT singleton,version,binding_json,last_clock FROM main."${t.meta}"
      WHERE typeof(binding_json)='text' AND instr(binding_json,char(0))=0 AND length(CAST(binding_json AS BLOB))<=2048`)
      .all();
    if (
      meta.length !== 1 ||
      meta[0].singleton !== 1 ||
      meta[0].version !== SQLITE_EVENT_DELIVERY_VERSION ||
      meta[0].binding_json !== canonicalCommandJson(policy.source) ||
      typeof meta[0].last_clock !== 'number' ||
      !Number.isSafeInteger(meta[0].last_clock) ||
      meta[0].last_clock < 0
    )
      return deliveryFail(
        layoutRefusal('The event delivery store', meta.length === 1 ? meta[0].version : undefined, SQLITE_EVENT_DELIVERY_VERSION),
      );
    const destination = db
      .prepare(`SELECT policy_json,scanned_count FROM main."${t.destination}"
      WHERE id=? AND typeof(policy_json)='text' AND instr(policy_json,char(0))=0 AND length(CAST(policy_json AS BLOB))<=65536`)
      .get(policy.destinationId);
    if (!destination && allowNewDestination && !db.prepare(`SELECT 1 FROM main."${t.destination}" WHERE id=?`).get(policy.destinationId))
      return;
    if (
      !destination ||
      destination.policy_json !== canonicalCommandJson(policy, 65_536) ||
      typeof destination.scanned_count !== 'number' ||
      !Number.isSafeInteger(destination.scanned_count) ||
      destination.scanned_count < 0
    )
      return deliveryFail();
    // A kept marker has every delivery row of its receipt, or, once pruned, none.
    const count = db.prepare(`SELECT count(*) AS n FROM main."${t.receipt}" WHERE destination_id=?`).get(policy.destinationId)!.n;
    if (
      count !== destination.scanned_count ||
      db
        .prepare(`SELECT 1 FROM main."${t.receipt}" r
      WHERE r.destination_id=? AND (NOT EXISTS (SELECT 1 FROM main."__mistri_command_receipt" source WHERE source.id=r.receipt_id)
        OR (CASE WHEN r.pruned_at IS NULL THEN r.event_count ELSE 0 END)
          <>(SELECT count(*) FROM main."${t.delivery}" d WHERE d.destination_id=r.destination_id AND d.receipt_id=r.receipt_id)) LIMIT 1`)
        .get(policy.destinationId)
    )
      return deliveryFail();
  } catch (error) {
    if (error instanceof EventDeliveryUnavailable) throw error;
    return deliveryFail();
  }
}

/** Pins the existing physical file for this private lifetime. Refuses symlinks,
 * replacement and unlink; never falls back to a new/in-memory database. */
export function openEventDeliveryFile(existingPath: string): { db: DatabaseSync; verifyFile(): void } {
  let db: DatabaseSync | undefined;
  try {
    if (typeof existingPath !== 'string' || !lstatSync(existingPath).isFile()) return deliveryFail();
    const path = realpathSync(existingPath),
      before = statSync(path);
    const verifyFile = () => {
      try {
        const after = lstatSync(existingPath);
        if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || realpathSync(existingPath) !== path) deliveryFail();
      } catch {
        deliveryFail();
      }
    };
    db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    verifyFile();
    db.exec('PRAGMA busy_timeout=50');
    return { db, verifyFile };
  } catch {
    try {
      db?.close();
    } catch {
      /* Discard failed acquisition. */
    }
    return deliveryFail();
  }
}

/** Only explicit maintenance on a stopped existing source. The caller owns
 * stopping other users; SQLite's writer lock is not proof of process shutdown.
 * No repair, source provisioning, startup hook or public activation. */
export function provisionSqliteEventDeliveryStore(
  existingPath: string,
  input: EventDeliveryPolicy,
  maintenance: { readonly stopped: true },
): { version: 1; provisioned: boolean; destinationAdded: boolean } {
  const policy = captureEventDeliveryPolicy(input);
  if (canonicalCommandJson(maintenance) !== '{"stopped":true}') return deliveryFail();
  const file = openEventDeliveryFile(existingPath),
    db = file.db;
  try {
    db.exec('BEGIN IMMEDIATE');
    attestEventDeliverySource(db, policy.source);
    const provisioned = !catalog(db, 'main').length && !catalog(db, 'temp').length;
    if (provisioned) {
      for (const ddl of definitions.values())
        db.exec(ddl.replace('CREATE TABLE ', 'CREATE TABLE main.').replace('CREATE INDEX ', 'CREATE INDEX main.'));
      db.prepare(`INSERT INTO main."${t.meta}" VALUES (1,1,?,0)`).run(canonicalCommandJson(policy.source));
    }
    assertSqliteEventDeliveryStore(db, policy, true);
    // Existing namespace may only be extended with a new, bounded destination;
    // full attestation below precedes commit and rolls back collision attempts.
    const present = db.prepare(`SELECT 1 FROM main."${t.destination}" WHERE id=?`).get(policy.destinationId);
    if (!present) {
      const count = db.prepare(`SELECT count(*) AS n FROM main."${t.destination}"`).get()!.n;
      if (typeof count !== 'number' || count >= 16) return deliveryFail();
      db.prepare(`INSERT INTO main."${t.destination}" VALUES (?,?,0)`).run(policy.destinationId, canonicalCommandJson(policy, 65_536));
    }
    assertSqliteEventDeliveryStore(db, policy);
    file.verifyFile();
    db.exec('COMMIT');
    return { version: 1, provisioned, destinationAdded: !present };
  } catch {
    try {
      if (db.isTransaction) db.exec('ROLLBACK');
    } catch {
      /* Never reuse the handle. */
    }
    return deliveryFail();
  } finally {
    db.close();
  }
}
