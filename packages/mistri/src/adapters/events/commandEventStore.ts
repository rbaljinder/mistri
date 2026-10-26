import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isProxy } from 'node:util/types';
import type { CommandAudit, CommandJournalTenant, StoredCommandReceipt } from '../commands/commandJournalTypes.js';
import type {
  CommandEventBatch,
  CommandEventEnvelope,
  CommandEventManifest,
  CommandEventOwner,
  CommandEventRuntimeContext,
} from './commandEventTypes.js';
import {
  assertSqliteCommandEventStore,
  captureCommandEventStoreBinding,
  COMMAND_EVENT_TABLES as tables,
  CommandEventStoreUnavailable,
  hasSqliteCommandEventStore,
  type CommandEventStoreBinding,
} from './commandEventSchema.js';
import { canonicalCommandJson } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { COMMAND_JOURNAL_TABLES } from '../commands/commandJournalSchema.js';
import { captureCommandEventBatch, captureCommandEventManifest } from './commandEventCapture.js';
import { commandEventsAppended } from './commandEventSignal.js';

const fail = (): never => {
  throw new CommandEventStoreUnavailable();
};
const canonical = (input: unknown, maximum = 1_048_576): string => canonicalCommandJson(input, maximum);
const uuid = (input: unknown): input is string =>
  typeof input === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input);
const digest = (manifest: CommandEventManifest, events: readonly CommandEventEnvelope[]): string =>
  createHash('sha256').update(canonical({ manifest, events })).digest('hex');
const TENANT = /^[a-z0-9][a-z0-9_-]{0,127}$/;

/** Capture without evaluating hooks: the source binding, the scope, a tenant
 * exactly when the scope is 'tenant', and the actor. */
function owner(input: CommandEventOwner): CommandEventOwner {
  if (!input || typeof input !== 'object' || Array.isArray(input) || isProxy(input)) return fail();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype) return fail();
  const read = (name: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (!descriptor?.enumerable || !('value' in descriptor)) return fail();
    return descriptor.value;
  };
  const scope = read('scope');
  const names =
    scope === 'tenant'
      ? ['scope', 'appId', 'storeId', 'sourceId', 'tenantId', 'actorId']
      : scope === 'app'
        ? ['scope', 'appId', 'storeId', 'sourceId', 'actorId']
        : fail();
  const keys = Reflect.ownKeys(input);
  if (keys.length !== names.length || keys.some((key) => typeof key !== 'string' || !names.includes(key))) return fail();
  const source = captureCommandEventStoreBinding({
    appId: read('appId'),
    storeId: read('storeId'),
    sourceId: read('sourceId'),
  } as CommandEventStoreBinding);
  const actorId = read('actorId');
  if (
    typeof actorId !== 'string' ||
    !actorId.length ||
    actorId !== actorId.trim() ||
    Buffer.byteLength(actorId, 'utf8') > 512 ||
    /\p{Cc}|[\uD800-\uDFFF]/u.test(actorId)
  )
    return fail();
  if (scope === 'app') return Object.freeze({ scope, ...source, actorId });
  const tenantId = read('tenantId');
  if (typeof tenantId !== 'string' || !TENANT.test(tenantId)) return fail();
  return Object.freeze({ scope: 'tenant' as const, ...source, tenantId, actorId });
}
/** The owner a tenant-bound journal writes its batches as. Membership,
 * roles and deployment stay in the private audit: a renewed grant must not
 * reidentify a committed event. */
export function tenantCommandEventOwner(tenant: CommandJournalTenant): CommandEventOwner {
  return owner({
    scope: 'tenant',
    appId: tenant.appId,
    storeId: tenant.storeId,
    sourceId: tenant.sourceId,
    tenantId: tenant.tenantId,
    actorId: tenant.actorId,
  });
}

/** Called only by the journal with its validated receipt/audit and captured
 * source owner. No authored event or request supplies these envelope fields. */
function context(input: CommandEventOwner, receipt: StoredCommandReceipt, audit: CommandAudit): CommandEventRuntimeContext {
  const captured = owner(input);
  if (captured.appId !== receipt.appId || captured.actorId !== receipt.actorId) return fail();
  return Object.freeze({
    appId: captured.appId,
    storeId: captured.storeId,
    sourceId: captured.sourceId,
    scope: captured.scope,
    ...(captured.scope === 'tenant' ? { tenantId: captured.tenantId } : {}),
    actorId: captured.actorId,
    commandId: receipt.commandId,
    commandVersion: receipt.commandVersion,
    resource: audit.target,
    key: Object.freeze(JSON.parse(audit.keyJson)),
    receiptId: receipt.id,
    requestId: receipt.requestId,
    occurredAt: receipt.completedAt,
    correlationId: receipt.requestId,
    causation: Object.freeze({ kind: 'command' as const, receiptId: receipt.id }),
  });
}
function verify(db: DatabaseSync, source: CommandEventOwner): void {
  if (!db.isTransaction) return fail();
  assertSqliteCommandEventStore(db, { appId: source.appId, storeId: source.storeId, sourceId: source.sourceId });
}
function envelope(
  runtime: CommandEventRuntimeContext,
  manifest: CommandEventManifest,
  batch: CommandEventBatch,
  ordinal: number,
  eventId: string,
): CommandEventEnvelope {
  const declaration = manifest[ordinal],
    payload = batch[ordinal];
  if (!declaration || !payload || payload.name !== declaration.name || payload.version !== declaration.version || !uuid(eventId))
    return fail();
  return Object.freeze({
    ...runtime,
    envelopeVersion: 2,
    eventId,
    ordinal,
    name: declaration.name,
    version: declaration.version,
    payloadJson: payload.payloadJson,
  });
}

/** Shared with the PostgreSQL event store: one envelope builder and one
 * digest, so a batch written by either engine verifies under the same rule. */
export const commandEventEnvelopes = Object.freeze({ owner, context, envelope, digest, uuid, canonical });

/** Synchronous composition inside the existing command-journal queue. The
 * caller must poison/drain that queue on failure and commit the SAME writer.
 * No transaction, callback queue, publisher or automatic repair is created. */
export function appendSqliteCommandEvents(
  db: DatabaseSync,
  source: CommandEventOwner,
  receipt: StoredCommandReceipt,
  audit: CommandAudit,
  input: CommandEventBatch,
): void {
  try {
    verify(db, source);
    const batch = captureCommandEventBatch(input),
      runtime = context(source, receipt, audit);
    const manifest = captureCommandEventManifest(batch.map(({ name, version }) => ({ name, version })));
    const events = batch.map((_, ordinal) => envelope(runtime, manifest, batch, ordinal, randomUUID()));
    // The batch's manifest, count and digest are its receipt's columns: the journal wrote the row just now, without them.
    const marked = db
      .prepare(`UPDATE main."${COMMAND_JOURNAL_TABLES.receipt}" SET manifest_json=?, event_count=?, digest=?
      WHERE id=? COLLATE BINARY AND manifest_json IS NULL`)
      .run(canonical(manifest, 65_536), events.length, digest(manifest, events), receipt.id);
    if (Number(marked.changes) !== 1) return fail();
    const insert = db.prepare(`INSERT INTO main."${tables.event}" (event_id, receipt_id, ordinal, envelope_json) VALUES (?,?,?,?)`);
    for (const [ordinal, event] of events.entries()) {
      insert.run(event.eventId, receipt.id, ordinal, canonical(event, 131_072));
    }
    // Verify the persisted association before the shared journal operation can
    // acknowledge completion. This does not claim the transaction committed.
    assertSqliteCommandEvents(db, source, receipt, audit, manifest);
  } catch (error) {
    if (error instanceof CommandEventStoreUnavailable) throw error;
    return fail();
  }
  commandEventsAppended();
}

/** Private exact-receipt inspection, not a public list endpoint. Membership
 * and current result-disclosure checks remain owned by the command invocation.
 * Historical grant/deployment changes do not reidentify committed events. */
export function assertSqliteCommandEvents(
  db: DatabaseSync,
  source: CommandEventOwner,
  receipt: StoredCommandReceipt,
  audit: CommandAudit,
  expected?: CommandEventManifest,
): readonly CommandEventEnvelope[] {
  try {
    if (!db.isTransaction) return fail();
    if (expected === undefined && !hasSqliteCommandEventStore(db)) return Object.freeze([]);
    verify(db, source);
    const manifest = expected === undefined ? undefined : captureCommandEventManifest(expected);
    const batch = db
      .prepare(`SELECT id AS receipt_id, manifest_json, event_count, digest,
      (typeof(manifest_json)='text' AND instr(manifest_json,char(0))=0
       AND typeof(digest)='text' AND instr(digest,char(0))=0) AS intact_text
      FROM main."${COMMAND_JOURNAL_TABLES.receipt}" WHERE id=? COLLATE BINARY AND manifest_json IS NOT NULL`)
      .get(receipt.id);
    if (!manifest) {
      if (batch || db.prepare(`SELECT 1 FROM main."${tables.event}" WHERE receipt_id=? COLLATE BINARY LIMIT 1`).get(receipt.id))
        return fail();
      return Object.freeze([]);
    }
    if (
      !batch ||
      batch.intact_text !== 1 ||
      batch.receipt_id !== receipt.id ||
      batch.event_count !== manifest.length ||
      batch.manifest_json !== canonical(manifest, 65_536) ||
      typeof batch.digest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(batch.digest)
    )
      return fail();
    // The extra row catches cardinality tampering without reading unbounded data.
    const rows = db
      .prepare(`SELECT event_id, receipt_id, ordinal, envelope_json,
      (typeof(event_id)='text' AND instr(event_id,char(0))=0
       AND typeof(receipt_id)='text' AND instr(receipt_id,char(0))=0
       AND typeof(envelope_json)='text' AND instr(envelope_json,char(0))=0) AS intact_text
      FROM main."${tables.event}" WHERE receipt_id=? COLLATE BINARY ORDER BY ordinal LIMIT 33`)
      .all(receipt.id);
    if (rows.length !== manifest.length) return fail();
    const runtime = context(source, receipt, audit);
    const parsed = rows.map((row, ordinal) => {
      if (
        row.intact_text !== 1 ||
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
