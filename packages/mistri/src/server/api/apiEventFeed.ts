/** The App API's event feed: `GET …/v{n}/$events?after=<cursor>&limit=<n>`.
 *
 * It reads the App's own command-event store — the facts its commands
 * committed, never pruned — oldest first, behind an opaque cursor. Only the
 * events the App names in `api.events` appear, each its own token operation
 * (`event:<name>`), and an event appears to a token only when the token's
 * roles read the record it is about: the feed never says more about a record
 * than the token's own reads could. What it says is the event's declared
 * payload with the record's resource and key, and nothing of who did it:
 * no actor, receipt or request id. */
import { DatabaseSync } from 'node:sqlite';
import { homeSourceOf, logicalResource, resolveAppAccess, type AppDef } from '../../shared/app.js';
import type { RuntimeResources } from '../app/appRuntimeResources.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { COMMAND_EVENT_TABLES, assertSqliteCommandEventStore } from '../../adapters/events/commandEventSchema.js';
import { assertPostgresCommandEventStore } from '../../adapters/events/postgresCommandEventStore.js';
import { COMMAND_JOURNAL_TABLES } from '../../adapters/commands/commandJournal.js';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { POSTGRES_DATABASE_HORIZON } from '../../adapters/live/postgresLiveChange.js';
import { appCommandEventStore } from '../commands/appCommandEvents.js';
import { getCommandEvents, type BusinessCommandRegistry } from '../commands/businessCommands.js';
import { ApiReadFailure } from './apiReadFailure.js';
import { runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';

/** What is wrong with the App's `api.events`, each with its check code. */
export function apiEventProblems(app: AppDef, registry: BusinessCommandRegistry | undefined): string[] {
  const named = app.api?.events ?? [];
  if (!named.length) return [];
  /* A row policy scopes what each reader may see; the feed serves every
     event of the App to whoever holds the token. Its events reach effects,
     jobs and workflows on the server, never a reader. */
  if (app.auth?.rows === 'policy') {
    return [
      "api.events: the event feed serves every event of the App, and a row-policy App's rows are scoped per reader [policy-events-feed]. Its commands' events reach its effects, jobs and workflows on the server; deliver them outward through an effect's webhook.",
    ];
  }
  if (app.auth?.rows !== 'all') {
    return [
      'api.events: the event feed serves an App whose roles read all rows [api-event-unsupported]. A tenant App delivers its events through webhooks.',
    ];
  }
  const emitted = new Set(
    Object.values(registry ?? {}).flatMap((command) => getCommandEvents(command)?.expectation.map((event) => event.name) ?? []),
  );
  return named
    .filter((name) => !emitted.has(name))
    .map(
      (name) =>
        `api.events: no command emits "${name}" [api-event-unknown]. ` +
        `Name an event a command declares under events, or drop it.${emitted.size ? ` Declared: ${[...emitted].sort().join(', ')}.` : ''}`,
    );
}

const EVENT_FEED_LIMIT = Object.freeze({ default: 50, max: 200, scan: 1000 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalid = (): never => {
  throw new ApiReadFailure('invalid_request');
};

/** The cursor is the last event the feed scanned, sealed only by encoding:
 * it carries no authority, and a cursor for an event that is not there is refused. */
export const encodeEventCursor = (eventId: string): string => Buffer.from(`e1:${eventId}`, 'utf8').toString('base64url');
function decodeEventCursor(raw: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(raw)) return invalid();
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  if (!text.startsWith('e1:') || !UUID.test(text.slice(3)) || encodeEventCursor(text.slice(3)) !== raw) return invalid();
  return text.slice(3);
}

/** `after` and `limit`, each at most once; nothing else. */
export function parseEventFeedQuery(rawQuery: string): {
  after?: string;
  limit: number;
} {
  const query: { after?: string; limit: number } = {
    limit: EVENT_FEED_LIMIT.default,
  };
  const seen = new Set<string>();
  for (const part of rawQuery ? rawQuery.split('&') : []) {
    const equals = part.indexOf('=');
    const name = equals < 0 ? part : part.slice(0, equals),
      value = equals < 0 ? '' : part.slice(equals + 1);
    if (seen.has(name)) return invalid();
    seen.add(name);
    if (name === 'after') query.after = decodeEventCursor(value);
    else if (name === 'limit') {
      if (!/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > EVENT_FEED_LIMIT.max) return invalid();
      query.limit = Number(value);
    } else return invalid();
  }
  return query;
}

type Envelope = Readonly<{
  eventId: string;
  name: string;
  scope: string;
  appId: string;
  storeId: string;
  resource: string;
  key: Readonly<Record<string, string | number>>;
  occurredAt: string;
  payloadJson: string;
}>;
type Row = { event_id: unknown; envelope_json: unknown };

/** Who may see which rows: the token's events, and records its roles read. */
export function eventFeedAudience(
  app: AppDef,
  schema: DatabaseSchema,
  observation: { operations: readonly string[]; roles: readonly string[] },
) {
  const named = new Set(app.api?.events ?? []);
  const granted = new Set(observation.operations.filter((id) => id.startsWith('event:')).map((id) => id.slice('event:'.length)));
  const access = resolveAppAccess(app, schema, [...observation.roles]);
  return (envelope: Envelope) => {
    if (!named.has(envelope.name) || !granted.has(envelope.name) || !access.readable.has(envelope.resource)) return false;
    /* A role that reads only some of the record's fields reads an event only
       when every field of its payload is one of those columns: the feed says
       no more of a record than the token's own reads of it could. */
    const seen = access.fields?.get(envelope.resource)?.read;
    // A grant that lists every column narrows nothing: a field grant on one table does not make the others' payloads columns.
    if (!seen || schema.tables.find((table) => table.id === envelope.resource)?.columns.every((column) => seen.has(column.name)))
      return true;
    const payload = JSON.parse(envelope.payloadJson) as unknown;
    return !!payload && typeof payload === 'object' && !Array.isArray(payload) && Object.keys(payload).every((field) => seen.has(field));
  };
}

function envelopeOf(row: Row, app: AppDef): Envelope {
  if (typeof row.event_id !== 'string' || typeof row.envelope_json !== 'string') throw new Error('Event store row is unreadable.');
  const value = JSON.parse(row.envelope_json) as Envelope;
  // An App-scope event of this App and store, and the row it was stored as.
  if (
    !value ||
    value.eventId !== row.event_id ||
    value.scope !== 'app' ||
    value.appId !== app.id ||
    value.storeId !== `app:${app.id}` ||
    typeof value.name !== 'string' ||
    typeof value.resource !== 'string' ||
    typeof value.payloadJson !== 'string' ||
    !value.key ||
    typeof value.key !== 'object'
  )
    throw new Error('Event store row is unreadable.');
  return value;
}

/** The wire item: what happened, to which record, when — and its payload. */
function item(envelope: Envelope, integers: 'decimal-string' | 'number') {
  return {
    id: envelope.eventId,
    name: envelope.name,
    occurredAt: envelope.occurredAt,
    resource: envelope.resource,
    key: Object.fromEntries(
      Object.entries(envelope.key).map(([column, value]) => [
        column,
        integers === 'decimal-string' && typeof value === 'number' ? String(value) : value,
      ]),
    ),
    payload: JSON.parse(envelope.payloadJson) as unknown,
  };
}

type Page = { items: ReturnType<typeof item>[]; next: string | null };
function page(
  rows: readonly Row[],
  app: AppDef,
  admit: (envelope: Envelope) => boolean,
  limit: number,
  integers: 'decimal-string' | 'number',
  after: string | undefined,
): Page {
  const items: ReturnType<typeof item>[] = [];
  let last = after;
  for (const row of rows) {
    const envelope = envelopeOf(row, app);
    last = envelope.eventId;
    if (admit(envelope)) items.push(item(envelope, integers));
    if (items.length >= limit) break;
  }
  // Past every row scanned, the ones this token does not see included; at the end, where it stands.
  return { items, next: last === undefined ? null : encodeEventCursor(last) };
}

/**
 * Where an App's feed reads: the source its emitting commands share, whose
 * store sits beside that source's connection (appCommandEventsFor binds it
 * there), and that connection. With several sources the emitting one need
 * not be the home one. Without a registry to say, the home source and its
 * connection, as before.
 */
export function eventFeedSource(
  app: AppDef,
  commands: BusinessCommandRegistry | undefined,
  resources: Pick<RuntimeResources, 'connectionFor'>,
  home: string,
): { sourceId: string; connection: string } {
  const emitting = Object.values(commands ?? {}).find((command) => getCommandEvents(command));
  if (!emitting) return { sourceId: homeSourceOf(app)!, connection: home };
  return {
    sourceId: emitting.source,
    connection: resources.connectionFor(logicalResource(app, emitting.source, emitting.target)),
  };
}

/** One page from an App's SQLite event store, opened read-only for this read. */
export function readSqliteEventFeed(
  file: string,
  app: AppDef,
  query: { after?: string; limit: number },
  admit: (envelope: Envelope) => boolean,
  integers: 'decimal-string' | 'number',
  sourceId: string,
): Page {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assertSqliteCommandEventStore(db, appCommandEventStore(app.id, sourceId));
    const table = `main."${COMMAND_EVENT_TABLES.event}"`;
    let position = 0;
    if (query.after !== undefined) {
      const found = db.prepare(`SELECT rowid AS position FROM ${table} WHERE event_id=? COLLATE BINARY`).get(query.after);
      if (!found) return invalid();
      position = Number(found.position);
    }
    // Commits are serialized on SQLite, so insertion order is commit order.
    const rows = db
      .prepare(`SELECT event_id, envelope_json FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT ?`)
      .all(position, EVENT_FEED_LIMIT.scan) as Row[];
    return page(rows, app, admit, query.limit, integers, query.after);
  } finally {
    db.close();
  }
}

/** One page from an App's PostgreSQL event store. Only batches whose
 * transactions every snapshot has seen finish are read, so a later page
 * never finds an older event behind its cursor. The horizon is this
 * database's, as live sync's is (postgresLiveChange.ts): a transaction held
 * open in another database on the server writes no batch here, so it does not
 * hold the feed back. */
export async function readPostgresEventFeed(
  client: PgQuery,
  app: AppDef,
  query: { after?: string; limit: number },
  admit: (envelope: Envelope) => boolean,
  integers: 'decimal-string' | 'number',
  sourceId: string,
): Promise<Page> {
  await assertPostgresCommandEventStore(client as never, appCommandEventStore(app.id, sourceId));
  // A batch's transaction id is its receipt row's (postgresCommandJournalSchema.ts).
  const event = runtimeTable('postgres', COMMAND_EVENT_TABLES.event),
    receipt = runtimeTable('postgres', COMMAND_JOURNAL_TABLES.receipt);
  const horizon = String((await client.query(`SELECT ${POSTGRES_DATABASE_HORIZON}::text AS horizon`)).rows[0].horizon);
  let from = { xact: '0', receipt: '', ordinal: -1 };
  if (query.after !== undefined) {
    const found = (
      await client.query(
        `SELECT b.xact_id::text AS xact, e.receipt_id, e.ordinal FROM ${event} e
      JOIN ${receipt} b ON b.id = e.receipt_id WHERE e.event_id = $1`,
        [query.after],
      )
    ).rows[0];
    if (!found) return invalid();
    from = {
      xact: String(found.xact),
      receipt: String(found.receipt_id),
      ordinal: Number(found.ordinal),
    };
  }
  const rows = (
    await client.query(
      `SELECT e.event_id, e.envelope_json FROM ${event} e
    JOIN ${receipt} b ON b.id = e.receipt_id
    WHERE b.xact_id < $1::xid8 AND (b.xact_id, e.receipt_id, e.ordinal) > ($2::xid8, $3, $4) AND b.app_id = $5
    ORDER BY b.xact_id, e.receipt_id, e.ordinal LIMIT $6`,
      [horizon, from.xact, from.receipt, from.ordinal, app.id, EVENT_FEED_LIMIT.scan],
    )
  ).rows as Row[];
  return page(rows, app, admit, query.limit, integers, query.after);
}
