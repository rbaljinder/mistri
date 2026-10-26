import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { assertSqliteCommandEventStore, COMMAND_EVENT_TABLES as events, type CommandEventStoreBinding } from './commandEventSchema.js';
import { assertSqliteCommandEvents, tenantCommandEventOwner } from './commandEventStore.js';
import { captureCommandJournalTenant, COMMAND_JOURNAL_TABLES as tables } from '../commands/commandJournal.js';
import type { CommandAudit, StoredCommandReceipt } from '../commands/commandJournalTypes.js';
import type { CommandEventEnvelope, CommandEventOwner } from './commandEventTypes.js';
import { deliveryFail, deliveryInteger, deliveryText, type EventDeliveryPolicy, type EventDeliveryRoute } from './eventDeliveryTypes.js';

type Row = Record<string, SQLOutputValue>;
/** The receipt row's columns a delivery reads, with their byte bounds, and
 * its first target's, which the row keeps in arrays (commandJournal.ts):
 * `audit` names them as one target's columns. Shared with the PostgreSQL reader. */
export const EVENT_DELIVERY_RECEIPT_BOUNDS = Object.freeze({
  receipt: Object.freeze({
    id: 128,
    app_id: 128,
    store_id: 256,
    source_id: 128,
    realm: 8,
    tenant_id: 128,
    actor_id: 512,
    command_id: 128,
    idempotency_key: 256,
    fingerprint: 256,
    result_json: 16_384,
    request_id: 128,
    completed_at: 32,
    membership_id: 1024,
    membership_version: 128,
    realm_version: 128,
    roles_json: 65_536,
    deployment: 256,
    target: 256,
    owners_json: 65_536,
    keys_json: 2_097_152,
    changes_json: 4_194_304,
  }),
  audit: Object.freeze({
    owner_tenant_id: 128,
    key_json: 8192,
    changes_json: 65_536,
  }),
  /* An App-scope receipt keeps the ordinary empty namespace and audit
     provenance; only its event batch carries the source. These may be empty. */
  empty: Object.freeze([
    'store_id',
    'source_id',
    'tenant_id',
    'owner_tenant_id',
    'membership_id',
    'membership_version',
    'realm_version',
    'deployment',
  ]),
});
/** A receipt row's first target, as the one audit row delivery reads it as: its
 * provenance from the row, its owner, key and changes the first of each array.
 * Undefined where the arrays are not texts. */
export function firstTargetOf(r: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
  const first = (text: unknown): unknown => {
    try {
      const parsed: unknown = typeof text === 'string' ? JSON.parse(text) : undefined;
      return Array.isArray(parsed) && parsed.length >= 1 && parsed.every((entry) => typeof entry === 'string') ? parsed[0] : undefined;
    } catch {
      return undefined;
    }
  };
  const audit = {
    receipt_id: r.id,
    app_id: r.app_id,
    store_id: r.store_id,
    source_id: r.source_id,
    realm: r.realm,
    tenant_id: r.tenant_id,
    owner_tenant_id: first(r.owners_json),
    actor_id: r.actor_id,
    membership_id: r.membership_id,
    membership_version: r.membership_version,
    realm_version: r.realm_version,
    roles_json: r.roles_json,
    deployment: r.deployment,
    target: r.target,
    key_json: first(r.keys_json),
    changes_json: first(r.changes_json),
  };
  for (const [name, limit] of Object.entries(EVENT_DELIVERY_RECEIPT_BOUNDS.audit)) {
    const value = audit[name as keyof typeof audit];
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > limit) return undefined;
    if (!value.length && !EVENT_DELIVERY_RECEIPT_BOUNDS.empty.includes(name)) return undefined;
  }
  return audit;
}
const PROVENANCE = ['membership_id', 'membership_version', 'realm_version', 'deployment'];
/** SQL bounds are applied BEFORE Node materializes possibly damaged TEXT/BLOBs.
 * TEXT containing NUL must be rejected in SQLite (its API can truncate it). */
function bounded(
  db: DatabaseSync,
  table: string,
  key: string,
  id: string,
  fields: Readonly<Record<string, number>>,
  integers: string[] = [],
  empty: readonly string[] = [],
): Row {
  const conditions = Object.entries(fields).map(
    ([name, limit]) =>
      `(typeof("${name}")='text' AND instr("${name}",char(0))=0 AND length(CAST("${name}" AS BLOB)) BETWEEN ${empty.includes(name) ? 0 : 1} AND ${limit})`,
  );
  const names = [...Object.keys(fields), ...integers];
  const row = db
    .prepare(`SELECT ${names.map((name) => `"${name}"`).join(',')} FROM main."${table}"
    WHERE "${key}"=? COLLATE BINARY AND ${conditions.join(' AND ')}`)
    .get(id);
  if (!row) return deliveryFail();
  return row;
}
function json(value: unknown): unknown {
  if (typeof value !== 'string') return deliveryFail();
  try {
    return JSON.parse(value);
  } catch {
    return deliveryFail();
  }
}

/** The route, if any, that takes this receipt's facts. */
export function eventDeliveryRouteFor(
  policy: EventDeliveryPolicy,
  owner: CommandEventOwner,
  commandId: string,
  commandVersion: number,
): EventDeliveryRoute | undefined {
  return policy.routes.find(
    (route) =>
      route.commandId === commandId &&
      route.commandVersion === commandVersion &&
      (route.scope === 'app'
        ? owner.scope === 'app'
        : owner.scope === 'tenant' && (route.scope === 'tenants' || route.tenantId === owner.tenantId)),
  );
}

/** From one receipt row and its first audit row, already read within their
 * bounds: the event owner they identify, and the receipt and audit its
 * batch was written with. Every context scalar comes from these rows and is
 * checked against the deployment's captured source; shared by both engines. */
export function eventDeliveryReceiptContext(
  policy: EventDeliveryPolicy,
  r: Readonly<Record<string, unknown>>,
  a: Readonly<Record<string, unknown>>,
  receiptId: string,
): { owner: CommandEventOwner; receipt: StoredCommandReceipt; audit: CommandAudit } {
  for (const field of ['app_id', 'store_id', 'source_id', 'realm', 'tenant_id', 'actor_id']) {
    if (r[field] !== a[field]) return deliveryFail();
  }
  // Only a tenant's realm, or an App scope's, carries events; its audit owner is its own tenant.
  if (
    r.id !== receiptId ||
    a.receipt_id !== receiptId ||
    r.app_id !== policy.source.appId ||
    r.realm !== 'tenant' ||
    a.owner_tenant_id !== r.tenant_id
  )
    return deliveryFail();
  let owner: CommandEventOwner;
  if (r.store_id === '' && r.source_id === '' && r.tenant_id === '') {
    if (PROVENANCE.some((field) => a[field] !== '') || a.roles_json !== '[]') return deliveryFail();
    deliveryText(r.actor_id, 512);
    owner = { scope: 'app', ...policy.source, actorId: r.actor_id };
  } else {
    if (r.store_id !== policy.source.storeId || r.source_id !== policy.source.sourceId) return deliveryFail();
    owner = tenantCommandEventOwner(
      captureCommandJournalTenant({
        appId: r.app_id as string,
        storeId: r.store_id as string,
        sourceId: r.source_id as string,
        tenantId: r.tenant_id as string,
        actorId: r.actor_id as string,
        membershipId: a.membership_id as string,
        membershipVersion: a.membership_version as string,
        tenantVersion: a.realm_version as string,
        roles: json(a.roles_json) as string[],
        deployment: a.deployment as string,
      }),
    );
  }
  for (const [field, limit] of Object.entries({
    id: 128,
    command_id: 128,
    idempotency_key: 256,
    fingerprint: 256,
    request_id: 128,
    completed_at: 32,
  }))
    deliveryText(r[field], limit);
  deliveryInteger(r.command_version, 1, Number.MAX_SAFE_INTEGER);
  if (new Date(r.completed_at as string).toISOString() !== r.completed_at) return deliveryFail();
  json(r.result_json);
  json(a.changes_json);
  deliveryText(a.target, 256);
  const key = json(a.key_json);
  // A public command's receipt names no record: its key is `{}`. Discovery
  // reads every App-scope receipt, routed or not, so it must read that one too.
  if (
    !key ||
    typeof key !== 'object' ||
    Array.isArray(key) ||
    Object.keys(key).length > 16 ||
    Object.entries(key).some(
      ([name, value]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
        (typeof value === 'string'
          ? Buffer.byteLength(value) > 1024
          : typeof value !== 'number' || !Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))),
    )
  )
    return deliveryFail();
  const receipt: StoredCommandReceipt = {
    id: r.id as string,
    appId: owner.appId,
    actorId: owner.actorId,
    commandId: r.command_id as string,
    commandVersion: r.command_version,
    idempotencyKey: r.idempotency_key as string,
    fingerprint: r.fingerprint as string,
    resultJson: r.result_json as string,
    requestId: r.request_id as string,
    completedAt: r.completed_at as string,
  };
  const audit: CommandAudit = { target: a.target as string, keyJson: a.key_json as string, changesJson: a.changes_json as string };
  return { owner, receipt, audit };
}

/** Private historical journal reader, never a current-user admission adapter.
 * The expectation is the deployment's route, not the batch's own manifest. */
export function readEventDeliveryReceipt(
  db: DatabaseSync,
  policy: EventDeliveryPolicy,
  receiptId: string,
): readonly CommandEventEnvelope[] {
  try {
    if (!db.isTransaction) return deliveryFail();
    assertSqliteCommandEventStore(db, policy.source);
    deliveryText(receiptId, 128);
    const bounds = EVENT_DELIVERY_RECEIPT_BOUNDS;
    const r = bounded(db, tables.receipt, 'id', receiptId, bounds.receipt, ['command_version'], bounds.empty);
    const a = firstTargetOf(r) ?? deliveryFail();
    const { owner, receipt, audit } = eventDeliveryReceiptContext(policy, r, a, receiptId);
    const route = eventDeliveryRouteFor(policy, owner, receipt.commandId, receipt.commandVersion);
    if (!route) return Object.freeze([]);
    bounded(db, tables.receipt, 'id', receiptId, { manifest_json: 65_536, digest: 64 });
    if (
      db
        .prepare(`SELECT 1 FROM main."${events.event}" WHERE receipt_id=? AND
      (typeof(envelope_json)<>'text' OR instr(envelope_json,char(0))<>0 OR length(CAST(envelope_json AS BLOB))>131072
        OR typeof(event_id)<>'text' OR instr(event_id,char(0))<>0 OR length(CAST(event_id AS BLOB))<>36) LIMIT 1`)
        .get(receiptId)
    )
      return deliveryFail();
    // The expectation is deployment-owned, not the batch's own manifest. This
    // catches missing/reordered batches as well as forged envelope provenance.
    return assertSqliteCommandEvents(db, owner, receipt, audit, route.manifest);
  } catch {
    return deliveryFail();
  }
}

export function attestEventDeliverySource(db: DatabaseSync, source: CommandEventStoreBinding): void {
  try {
    assertSqliteCommandEventStore(db, source);
  } catch {
    deliveryFail();
  }
}
