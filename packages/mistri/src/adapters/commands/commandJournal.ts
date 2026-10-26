import { statSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { isPromise, isProxy } from 'node:util/types';
import { Refusal, type TransactionOperations } from '@mistriwork/engine/adapters/adapter.js';
import { snapshotScopedData } from '@mistriwork/engine/adapters/scoped/scopedReads.js';
import {
  assertSqliteCommandJournal,
  catalog,
  COMMAND_JOURNAL_TABLES,
  COMMAND_TARGET_BOUNDS,
  CommandJournalUnavailable,
  definitions,
  isCommandJournalTable,
  JOURNAL_VERSION,
} from './commandJournalSchema.js';
import { assertSqliteCommandEventStore } from '../events/commandEventSchema.js';
import { appendSqliteCommandEvents, assertSqliteCommandEvents, tenantCommandEventOwner } from '../events/commandEventStore.js';
import type { CommandEventBatch, CommandEventManifest, CommandEventOwner } from '../events/commandEventTypes.js';
import { captureCommandEventManifest } from '../events/commandEventCapture.js';
import { BULK_LIMIT } from '../../shared/command.js';
import { nextSqliteCommandNumber, provisionSqliteCommandSequences } from './commandSequences.js';
import type {
  CommandReceiptScope,
  StoredCommandReceipt,
  CommandAudit,
  CommandJournal,
  CommandJournalAppScope,
  CommandJournalPlatform,
  CommandJournalTenant,
} from './commandJournalTypes.js';
export type {
  CommandReceiptScope,
  StoredCommandReceipt,
  CommandAudit,
  CommandJournal,
  CommandJournalPlatform,
  CommandJournalTenant,
} from './commandJournalTypes.js';

export { assertSqliteCommandJournal, COMMAND_JOURNAL_TABLES, CommandJournalUnavailable, isCommandJournalTable, JOURNAL_VERSION };

export class CommandTransactionFailure extends Error {
  constructor(
    cause: unknown,
    readonly outcome: 'not_applied' | 'unknown',
  ) {
    super('The command transaction did not complete successfully.', { cause });
    this.name = 'CommandTransactionFailure';
  }
}

// SQLite stores canonical CREATE text without the schema qualifier.
const inMain = (ddl: string) => ddl.replace(/^CREATE (TABLE|INDEX) /, 'CREATE $1 main.');

/**
 * Explicit maintenance operation. Never called implicitly when opening an App.
 * A file without a journal gets version 1; anything else under the prefix is
 * refused unchanged.
 */
export function migrateSqliteCommandJournal(existingPath: string): { version: 1; migrated: boolean } {
  if (!statSync(existingPath).isFile()) throw new Refusal('Command journal migration requires an existing SQLite file.');
  const db = new DatabaseSync(existingPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    try {
      let result: { version: 1; migrated: boolean } = { version: 1, migrated: false };
      if (catalog(db).length === 0) {
        for (const ddl of definitions.values()) db.exec(inMain(ddl));
        db.prepare(`INSERT INTO main."${COMMAND_JOURNAL_TABLES.meta}" (singleton, version) VALUES (1, ?)`).run(JOURNAL_VERSION);
        result = { version: 1, migrated: true };
      }
      assertSqliteCommandJournal(db);
      // The sequences a handler numbers from live beside the journal.
      if (provisionSqliteCommandSequences(db)) result = { version: 1, migrated: true };
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* Preserve the migration failure. */
      }
      throw error;
    }
  } finally {
    db.close();
  }
}

function text(value: unknown, field: string, max: number): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value !== value.trim() ||
    Buffer.byteLength(value, 'utf8') > max ||
    /\p{Cc}/u.test(value) ||
    [...value].some((character) => {
      const point = character.codePointAt(0)!;
      return point >= 0xd800 && point <= 0xdfff;
    })
  )
    throw new Refusal(`Invalid command journal ${field}.`);
}
function json(value: unknown, field: string, max: number): asserts value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > max) throw new Refusal(`Invalid command journal ${field}.`);
  try {
    JSON.parse(value);
  } catch {
    throw new Refusal(`Invalid command journal ${field}.`);
  }
}
function scopeValues(scope: CommandReceiptScope): [string, string, string, number, string] {
  if (!scope || typeof scope !== 'object') throw new Refusal('Invalid command receipt scope.');
  text(scope.appId, 'application', 128);
  text(scope.actorId, 'actor', 512);
  text(scope.commandId, 'command', 128);
  text(scope.idempotencyKey, 'idempotency key', 256);
  if (!Number.isSafeInteger(scope.commandVersion) || scope.commandVersion < 1) throw new Refusal('Invalid command journal version.');
  return [scope.appId, scope.actorId, scope.commandId, scope.commandVersion, scope.idempotencyKey];
}
const receiptFields = [
  'appId',
  'actorId',
  'commandId',
  'commandVersion',
  'idempotencyKey',
  'id',
  'fingerprint',
  'resultJson',
  'requestId',
  'completedAt',
];
const invalid = (): never => {
  throw new Refusal('Invalid structured operation.');
};
function record(value: unknown, fields: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key))) invalid();
}
/** Reject proxies before the shared bounded snapshot inspects any descriptors.
 * The same limits stop cycles/huge graphs; accessors are never evaluated. */
function capture<T>(input: T): T {
  let nodes = 0;
  const check = (value: unknown, depth = 0): void => {
    if (++nodes > 32_768 || depth > 16) return invalid();
    if (!value || typeof value !== 'object') return;
    if (isProxy(value)) return invalid();
    const keys = Reflect.ownKeys(value);
    if (keys.length > 8193) return invalid();
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in descriptor)) return invalid();
      check(descriptor.value, depth + 1);
    }
  };
  check(input);
  return snapshotScopedData(input);
}
function validateTenant(input: CommandJournalTenant): void {
  record(input, [
    'appId',
    'storeId',
    'sourceId',
    'tenantId',
    'actorId',
    'membershipId',
    'membershipVersion',
    'tenantVersion',
    'roles',
    'deployment',
  ]);
  text(input.appId, 'application', 128);
  text(input.actorId, 'actor', 512);
  text(input.storeId, 'store', 256);
  text(input.sourceId, 'source', 128);
  text(input.tenantId, 'tenant', 128);
  text(input.membershipId, 'membership', 1024);
  text(input.deployment, 'deployment', 256);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.sourceId) || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(input.tenantId)) return invalid();
  // A public intake submission has no membership: its provenance names the
  // public principal in the membership's place, at revision 0, with no role.
  // Only that exact shape takes revision 0; a member's revision never does.
  const publicIntake =
    input.membershipVersion === '0' &&
    typeof input.actorId === 'string' &&
    /^public:[a-z0-9][a-z0-9-]{0,63}$/.test(input.actorId) &&
    input.membershipId === input.actorId &&
    Array.isArray(input.roles) &&
    input.roles.length === 0;
  // A job's service principal has no membership either: `service:<name>` in
  // its place, at revision 0, with the roles the jobs module declares for it.
  const service =
    input.membershipVersion === '0' &&
    typeof input.actorId === 'string' &&
    /^service:[a-z][a-z0-9-]{0,62}$/.test(input.actorId) &&
    input.membershipId === input.actorId &&
    Array.isArray(input.roles) &&
    input.roles.length > 0;
  for (const revision of publicIntake || service ? [input.tenantVersion] : [input.membershipVersion, input.tenantVersion]) {
    if (typeof revision !== 'string' || revision.length > 128 || !/^[1-9][0-9]*$/.test(revision)) return invalid();
  }
  if (!Array.isArray(input.roles) || input.roles.length > 256 || new Set(input.roles).size !== input.roles.length) return invalid();
  for (const role of input.roles) text(role, 'role', 256);
  json(JSON.stringify(input.roles), 'roles', 64 * 1024);
}
/** Capture private source-owned execution evidence before any adapter queue
 * wait. No runtime session, database provenance or credential is inferred. */
export function captureCommandJournalTenant(input: CommandJournalTenant): CommandJournalTenant {
  const captured = capture(input);
  validateTenant(captured);
  return Object.freeze({ ...captured, roles: Object.freeze([...captured.roles]) });
}
/** The platform realm's provenance: a tenant's rules, with the platform
 * version in the tenant version's place and no tenant. */
function validatePlatform(input: CommandJournalPlatform): void {
  record(input, [
    'realm',
    'appId',
    'storeId',
    'sourceId',
    'actorId',
    'membershipId',
    'membershipVersion',
    'platformVersion',
    'roles',
    'deployment',
  ]);
  if (input.realm !== 'platform') return invalid();
  // The placeholder tenant only borrows the tenant checks; it is never stored.
  validateTenant({
    appId: input.appId,
    storeId: input.storeId,
    sourceId: input.sourceId,
    tenantId: 'platform',
    actorId: input.actorId,
    membershipId: input.membershipId,
    membershipVersion: input.membershipVersion,
    tenantVersion: input.platformVersion,
    roles: input.roles,
    deployment: input.deployment,
  });
}
export function captureCommandJournalPlatform(input: CommandJournalPlatform): CommandJournalPlatform {
  const captured = capture(input);
  validatePlatform(captured);
  return Object.freeze({ ...captured, roles: Object.freeze([...captured.roles]) });
}
const platformOwned = (owner: unknown) =>
  !!owner && typeof owner === 'object' && !isProxy(owner) && Object.getOwnPropertyDescriptor(owner, 'realm')?.value === 'platform';
/** A verified command transaction's member, a tenant's or the platform
 * realm's, told apart by its own data property `realm`. */
export function captureCommandJournalMember(
  input: CommandJournalTenant | CommandJournalPlatform,
): CommandJournalTenant | CommandJournalPlatform {
  return platformOwned(input)
    ? captureCommandJournalPlatform(input as CommandJournalPlatform)
    : captureCommandJournalTenant(input as CommandJournalTenant);
}
const TENANT_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;
/** The receipt namespace a journal writes and finds in: store, source, realm
 * and tenant. The platform realm's has no tenant; an unbound journal's is empty. */
function namespaceOf(
  tenant: CommandJournalTenant | undefined,
  platform: CommandJournalPlatform | undefined,
): readonly [string, string, 'tenant' | 'platform', string] {
  if (platform) return [platform.storeId, platform.sourceId, 'platform', ''];
  return [tenant?.storeId ?? '', tenant?.sourceId ?? '', 'tenant', tenant?.tenantId ?? ''];
}
/** The owner an audit row records: in a tenant's realm always that tenant (an
 * unbound journal's is ''); in the platform realm the tenant the server read
 * from the target row, or '' for a platform-owned target. */
function auditOwner(entry: CommandAudit, realm: 'tenant' | 'platform', tenantId: string): string {
  if (realm === 'tenant') return entry.owner === undefined || entry.owner === tenantId ? tenantId : invalid();
  return typeof entry.owner === 'string' && (entry.owner === '' || TENANT_ID.test(entry.owner)) ? entry.owner : invalid();
}
/** A journal is bound to one tenant's source owner, the platform realm's,
 * its App's event source, or nothing; the own data properties `realm` and
 * `scope` say which. */
function captureCommandJournalOwner(
  owner: CommandJournalTenant | CommandJournalPlatform | CommandJournalAppScope | undefined,
): Readonly<{ tenant?: CommandJournalTenant; platform?: CommandJournalPlatform; app?: CommandJournalAppScope }> {
  if (owner === undefined) return Object.freeze({});
  if (platformOwned(owner)) return Object.freeze({ platform: captureCommandJournalPlatform(owner as CommandJournalPlatform) });
  if (owner && typeof owner === 'object' && !isProxy(owner) && Object.getOwnPropertyDescriptor(owner, 'scope')?.value === 'app') {
    const captured = capture(owner as CommandJournalAppScope);
    record(captured, ['scope', 'appId', 'storeId', 'sourceId']);
    text(captured.appId, 'application', 128);
    text(captured.storeId, 'store', 256);
    text(captured.sourceId, 'source', 128);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(captured.sourceId)) return invalid();
    return Object.freeze({
      app: Object.freeze({ scope: 'app' as const, appId: captured.appId, storeId: captured.storeId, sourceId: captured.sourceId }),
    });
  }
  return Object.freeze({ tenant: captureCommandJournalTenant(owner as CommandJournalTenant) });
}
/** Who a bound journal writes and reads event batches as. */
function eventOwnerOf(
  tenant: CommandJournalTenant | undefined,
  app: CommandJournalAppScope | undefined,
  actorId: string,
): CommandEventOwner | undefined {
  if (tenant) return tenantCommandEventOwner(tenant);
  return app && { scope: 'app', appId: app.appId, storeId: app.storeId, sourceId: app.sourceId, actorId };
}
const eventStoreOf = (source: CommandJournalTenant | CommandJournalAppScope) => ({
  appId: source.appId,
  storeId: source.storeId,
  sourceId: source.sourceId,
});

function validateReceipt(receipt: StoredCommandReceipt): void {
  record(receipt, receiptFields);
  scopeValues(receipt);
  text(receipt.id, 'receipt ID', 128);
  text(receipt.fingerprint, 'fingerprint', 256);
  text(receipt.requestId, 'request ID', 128);
  text(receipt.completedAt, 'completion time', 32);
  const date = new Date(receipt.completedAt);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== receipt.completedAt)
    throw new Refusal('Invalid command journal completion time.');
  json(receipt.resultJson, 'result', 16 * 1024);
}
function validateAudit(audit: CommandAudit): void {
  record(audit, ['target', 'keyJson', 'changesJson', 'owner']);
  if (audit.owner !== undefined && typeof audit.owner !== 'string') return invalid();
  text(audit.target, 'audit target', 256);
  json(audit.keyJson, 'audit key', 8 * 1024);
  json(audit.changesJson, 'audit changes', 64 * 1024);
}
/** One audit or a list, one per target: at least one, at most BULK_LIMIT.
 * An event batch belongs to exactly one target. */
function auditEntries(audit: CommandAudit | readonly CommandAudit[], eventBatch: unknown): readonly CommandAudit[] {
  const entries = Array.isArray(audit) ? (audit as readonly CommandAudit[]) : [audit as CommandAudit];
  if (!entries.length || entries.length > BULK_LIMIT || (eventBatch !== undefined && entries.length !== 1)) return invalid();
  for (const entry of entries) validateAudit(entry);
  return entries;
}
interface StoredAuditRow {
  ordinal: unknown;
  app: unknown;
  store: unknown;
  source: unknown;
  realm: unknown;
  tenant: unknown;
  owner: unknown;
  actor: unknown;
  membershipId: unknown;
  membershipVersion: unknown;
  realmVersion: unknown;
  rolesJson: unknown;
  deployment: unknown;
  target: unknown;
  keyJson: unknown;
  changesJson: unknown;
}
/** A receipt's audit rows, read in ordinal order: numbered 0..n-1 without a
 * gap, every one with the first row's provenance and target, each valid.
 * Owners may differ row to row only in the platform realm, which may span
 * tenants; a tenant's realm records its own tenant on every row. */
function validateAuditRows(rows: readonly StoredAuditRow[]): void {
  if (!rows.length || rows.length > BULK_LIMIT) throw new CommandJournalUnavailable();
  const [first] = rows;
  const provenance = (row: StoredAuditRow) => [
    row.app,
    row.store,
    row.source,
    row.realm,
    row.tenant,
    row.actor,
    row.membershipId,
    row.membershipVersion,
    row.realmVersion,
    row.rolesJson,
    row.deployment,
    row.target,
  ];
  const expected = JSON.stringify(provenance(first));
  rows.forEach((row, index) => {
    if (Number(row.ordinal) !== index || JSON.stringify(provenance(row)) !== expected) throw new CommandJournalUnavailable();
    if (
      row.realm === 'tenant'
        ? row.owner !== row.tenant
        : row.realm !== 'platform' ||
          row.tenant !== '' ||
          (row.owner !== '' && !(typeof row.owner === 'string' && TENANT_ID.test(row.owner)))
    )
      throw new CommandJournalUnavailable();
    validateAudit({ target: row.target, keyJson: row.keyJson, changesJson: row.changesJson } as CommandAudit);
  });
}
/** What a journal row carries beside its receipt: the provenance it ran
 * under, the same for every target. An unbound journal's is empty. */
function provenanceOf(
  member: CommandJournalTenant | CommandJournalPlatform | undefined,
): readonly [string, string, string, string, string] {
  return [
    member?.membershipId ?? '',
    member?.membershipVersion ?? '',
    member === undefined ? '' : 'realm' in member ? member.platformVersion : member.tenantVersion,
    JSON.stringify(member?.roles ?? []),
    member?.deployment ?? '',
  ];
}
const mib = (bytes: number) => (bytes / 1_048_576).toFixed(1);
/** A command's targets as its receipt row keeps them: the one resource, and per
 * target in request order its owner, key and changes, each an array of the
 * exact texts given. Refused past the row's bounds, which are over all targets. */
function packTargets(audits: readonly CommandAudit[], owners: readonly string[]): readonly [string, string, string, string] {
  const [{ target }] = audits;
  // One resource per receipt: recovery, governance and an event's context name it once.
  if (audits.some((entry) => entry.target !== target)) return invalid();
  const ownersJson = JSON.stringify(owners),
    keysJson = JSON.stringify(audits.map((entry) => entry.keyJson)),
    changesJson = JSON.stringify(audits.map((entry) => entry.changesJson));
  const changes = Buffer.byteLength(changesJson, 'utf8');
  if (changes > COMMAND_TARGET_BOUNDS.changes)
    throw new Refusal(
      `A command keeps at most ${mib(COMMAND_TARGET_BOUNDS.changes)} MiB of changes across its targets, and this one would keep ` +
        `${mib(changes)} MiB over ${audits.length}. Split it into smaller commands.`,
    );
  if (
    Buffer.byteLength(keysJson, 'utf8') > COMMAND_TARGET_BOUNDS.keys ||
    Buffer.byteLength(ownersJson, 'utf8') > COMMAND_TARGET_BOUNDS.owners
  )
    throw new Refusal(
      `A command names at most ${mib(COMMAND_TARGET_BOUNDS.keys)} MiB of keys across its targets. Split it into smaller commands.`,
    );
  return [target, ownersJson, keysJson, changesJson];
}
/** The columns a receipt row is written with, in the order receiptRow gives them. */
const RECEIPT_COLUMNS = `id, app_id, store_id, source_id, realm, tenant_id, actor_id, command_id, command_version, idempotency_key,
  fingerprint, result_json, request_id, completed_at, membership_id, membership_version, realm_version, roles_json, deployment,
  target, owners_json, keys_json, changes_json`;
/** One receipt row's values: the receipt under its scope (receiptValues), its provenance and its targets. */
function receiptRow(
  receipt: StoredCommandReceipt,
  scope: readonly unknown[],
  member: CommandJournalTenant | CommandJournalPlatform | undefined,
  audits: readonly CommandAudit[],
  owners: readonly string[],
): unknown[] {
  return [
    receipt.id,
    ...scope,
    receipt.fingerprint,
    receipt.resultJson,
    receipt.requestId,
    receipt.completedAt,
    ...provenanceOf(member),
    ...packTargets(audits, owners),
  ];
}
/** What a lookup reads of a receipt row, by the names readReceiptRow takes. `completed` is how the engine says the
 * completion time as `toISOString()` text. */
const receiptRowColumns = (completed = 'completed_at') => `id, app_id AS "appId", actor_id AS "actorId", command_id AS "commandId",
  command_version AS "commandVersion", idempotency_key AS "idempotencyKey", fingerprint, result_json AS "resultJson",
  request_id AS "requestId", ${completed} AS "completedAt", store_id AS "storeId", source_id AS "sourceId", realm,
  tenant_id AS "tenantId", membership_id AS "membershipId", membership_version AS "membershipVersion",
  realm_version AS "realmVersion", roles_json AS "rolesJson", deployment, target, owners_json AS "ownersJson",
  keys_json AS "keysJson", changes_json AS "changesJson"`;
/** A stored array of texts, or the journal cannot vouch for its row. */
function texts(value: unknown): string[] {
  let parsed: unknown;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : undefined;
  } catch {
    throw new CommandJournalUnavailable();
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) throw new CommandJournalUnavailable();
  return parsed as string[];
}
/** A receipt row's targets, one audit row each in request order, every one under the row's provenance; validated as a list. */
function auditRowsOf(row: Readonly<Record<string, unknown>>): StoredAuditRow[] {
  const owners = texts(row.ownersJson),
    keys = texts(row.keysJson),
    changes = texts(row.changesJson);
  if (keys.length !== owners.length || changes.length !== owners.length) throw new CommandJournalUnavailable();
  const rows = owners.map((owner, ordinal) => ({
    ordinal,
    app: row.appId,
    store: row.storeId,
    source: row.sourceId,
    realm: row.realm,
    tenant: row.tenantId,
    owner,
    actor: row.actorId,
    membershipId: row.membershipId,
    membershipVersion: row.membershipVersion,
    realmVersion: row.realmVersion,
    rolesJson: row.rolesJson,
    deployment: row.deployment,
    target: row.target,
    keyJson: keys[ordinal],
    changesJson: changes[ordinal],
  }));
  validateAuditRows(rows);
  return rows;
}
type ReceiptRow = Readonly<{
  receipt: StoredCommandReceipt;
  /** The first target's audit: what an event batch's context was made from. */
  audit: CommandAudit;
  targets: readonly Readonly<{ target: string; keyJson: string }>[];
}>;
/**
 * A receipt row read back under this journal: in its namespace, a valid
 * receipt, every target valid, and its provenance valid for who wrote it —
 * validated as history, never compared with today's admission, so a renewed
 * grant, revision or deployment cannot permit a duplicate execution.
 */
function readReceiptRow(
  row: Readonly<Record<string, unknown>>,
  namespace: readonly [string, string, string, string],
  member: CommandJournalTenant | CommandJournalPlatform | undefined,
): ReceiptRow {
  if (row.storeId !== namespace[0] || row.sourceId !== namespace[1] || row.realm !== namespace[2] || row.tenantId !== namespace[3])
    throw new CommandJournalUnavailable();
  const receipt = Object.fromEntries(receiptFields.map((field) => [field, row[field]])) as unknown as StoredCommandReceipt;
  validateReceipt(receipt);
  const audits = auditRowsOf(row);
  if (member) {
    json(row.rolesJson, 'roles', 64 * 1024);
    const historical = {
      appId: receipt.appId,
      actorId: receipt.actorId,
      storeId: row.storeId,
      sourceId: row.sourceId,
      membershipId: row.membershipId,
      membershipVersion: row.membershipVersion,
      roles: JSON.parse(row.rolesJson as string),
      deployment: row.deployment,
    };
    if ('realm' in member)
      validatePlatform({ ...historical, realm: 'platform', platformVersion: row.realmVersion } as CommandJournalPlatform);
    else validateTenant({ ...historical, tenantId: row.tenantId, tenantVersion: row.realmVersion } as CommandJournalTenant);
  } else if (
    row.membershipId !== '' ||
    row.membershipVersion !== '' ||
    row.realmVersion !== '' ||
    row.rolesJson !== '[]' ||
    row.deployment !== ''
  )
    throw new CommandJournalUnavailable();
  const [first] = audits;
  return Object.freeze({
    receipt: Object.freeze(receipt),
    audit: Object.freeze({ target: first.target as string, keyJson: first.keyJson as string, changesJson: first.changesJson as string }),
    targets: Object.freeze(audits.map((entry) => Object.freeze({ target: entry.target as string, keyJson: entry.keyJson as string }))),
  });
}

/** Shared with the PostgreSQL journal so the two engines cannot disagree about
 * what a valid receipt, audit, tenant or scope is. Internal: not for handlers. */
export const commandJournalValidation = Object.freeze({
  capture,
  record,
  receiptFields,
  scopeValues,
  validateReceipt,
  validateAudit,
  validateTenant,
  validatePlatform,
  json,
  text,
  auditEntries,
  validateAuditRows,
  provenanceOf,
  packTargets,
  receiptRow,
  RECEIPT_COLUMNS,
  receiptRowColumns,
  readReceiptRow,
  owner: captureCommandJournalOwner,
  eventOwnerOf,
  eventStoreOf,
  namespaceOf,
  auditOwner,
});

type ReceiptRecovery = Readonly<{ receipt: StoredCommandReceipt; targets: readonly Readonly<{ target: string; keyJson: string }>[] }>;
const ordinaryRecovery = new WeakMap<
  CommandJournal,
  (scope: CommandReceiptScope, expectedManifest?: CommandEventManifest) => Promise<ReceiptRecovery | undefined>
>();

/** Private storage capability only, not actor authorization. Raw key JSON is
 * storage-validated, not yet checked against a command's typed key catalog.
 * No change images or historical membership/session provenance leave here. */
export const isOrdinarySqliteCommandJournal = (journal: CommandJournal): boolean => ordinaryRecovery.has(journal);

export function recoverSqliteCommandReceipt(
  journal: CommandJournal,
  scope: CommandReceiptScope,
  expectedManifest?: CommandEventManifest,
): Promise<ReceiptRecovery | undefined> {
  const recover = ordinaryRecovery.get(journal);
  if (!recover) return Promise.reject(new CommandJournalUnavailable());
  return recover(scope, expectedManifest);
}

/** The owner supplies the write handle/lifetime. Tenant/verifier-bound journals
 * additionally require that owned transaction and attest around each operation.
 * Ordinary two-argument use retains its existing main-qualified contract. */
export function createSqliteCommandJournal(
  db: DatabaseSync,
  operations: TransactionOperations,
  owner?: CommandJournalTenant | CommandJournalPlatform | CommandJournalAppScope,
  verify?: () => void,
): CommandJournal {
  const { tenant: bound, platform, app: appScope } = captureCommandJournalOwner(owner);
  // The platform realm has no event source: its commands declare no events.
  const source = bound ?? appScope,
    member = bound ?? platform;
  if (verify !== undefined && (typeof verify !== 'function' || isProxy(verify))) return invalid();
  const guard = verify;
  const namespace = namespaceOf(bound, platform);
  const values = (scope: CommandReceiptScope) => {
    record(scope, receiptFields); // StoredCommandReceipt is a supported structural subtype.
    const [app, actor, command, version, key] = scopeValues(scope);
    if ((member && (app !== member.appId || actor !== member.actorId)) || (appScope && app !== appScope.appId)) return invalid();
    return [app, ...namespace, actor, command, version, key] as const;
  };
  const verified = (eventStoreRequired: boolean) => {
    if (eventStoreRequired && !source) throw new CommandJournalUnavailable();
    if (!source && !member && !guard) return;
    if (!db.isTransaction) throw new CommandJournalUnavailable();
    const attest = () => {
      assertSqliteCommandJournal(db);
      if (eventStoreRequired) assertSqliteCommandEventStore(db, eventStoreOf(source!));
    };
    attest();
    if (guard) {
      const result = guard();
      if (isPromise(result)) void Promise.prototype.then.call(result, undefined, () => {});
      if (result !== undefined) return invalid();
    }
    if (!db.isTransaction) throw new CommandJournalUnavailable();
    attest();
  };
  const invoke = <A, R>(input: A, work: (captured: A) => Promise<R>, eventStoreRequired = false): Promise<R> => {
    let captured: A;
    try {
      captured = capture(input);
    } catch (error) {
      // Capture failures must join the shared queue: catching one cannot allow
      // earlier business writes to commit or later operations to keep running.
      return operations.run(async () => {
        throw error;
      });
    }
    return operations.run(async () => {
      verified(eventStoreRequired);
      const result = await work(captured);
      verified(eventStoreRequired);
      return result;
    });
  };
  const lookup = (scope: CommandReceiptScope, expectedManifest?: CommandEventManifest): ReceiptRecovery | undefined => {
    const lookup = values(scope);
    // Prove event storage before establishing absence. A missing receipt in a
    // damaged/unprovisioned event store cannot authorize fresh execution.
    if (expectedManifest !== undefined) {
      if (!source) throw new CommandJournalUnavailable();
      expectedManifest = captureCommandEventManifest(expectedManifest);
      assertSqliteCommandEventStore(db, eventStoreOf(source));
    }
    const row = db
      .prepare(`SELECT ${receiptRowColumns()} FROM main."${COMMAND_JOURNAL_TABLES.receipt}"
        WHERE app_id = ? AND store_id = ? AND source_id = ? AND realm = ? AND tenant_id = ?
          AND actor_id = ? AND command_id = ? AND command_version = ? AND idempotency_key = ?`)
      .get(...lookup);
    if (!row) return undefined;
    const { receipt, audit, targets } = readReceiptRow(row, namespace, member);
    const events = eventOwnerOf(bound, appScope, receipt.actorId);
    if (events) assertSqliteCommandEvents(db, events, receipt, audit, expectedManifest);
    return Object.freeze({ receipt, targets });
  };
  const journal: CommandJournal = Object.freeze({
    find: (scope: CommandReceiptScope, expectedManifest?: CommandEventManifest) =>
      invoke(
        { scope, expectedManifest },
        async ({ scope, expectedManifest }) => lookup(scope, expectedManifest)?.receipt,
        expectedManifest !== undefined,
      ),
    commit: (receipt: StoredCommandReceipt, audit: CommandAudit | readonly CommandAudit[], eventBatch?: CommandEventBatch) =>
      invoke(
        { receipt, audit, eventBatch },
        async ({ receipt, audit, eventBatch }) => {
          validateReceipt(receipt);
          const scope = values(receipt);
          const audits = auditEntries(audit, eventBatch);
          if (eventBatch !== undefined) {
            if (!source) throw new CommandJournalUnavailable();
            assertSqliteCommandEventStore(db, eventStoreOf(source));
          }
          // Every owner before the row: one refused owner writes nothing.
          const owners = audits.map((entry) => auditOwner(entry, namespace[2], namespace[3]));
          const row = receiptRow(receipt, scope, member, audits, owners);
          db.prepare(`INSERT INTO main."${COMMAND_JOURNAL_TABLES.receipt}" (${RECEIPT_COLUMNS})
        VALUES (${row.map(() => '?').join(', ')})`).run(...(row as SQLInputValue[]));
          // The synchronous helper runs inside this same fail-stop operation and
          // writer transaction. Even a caught append error must roll back effects.
          if (eventBatch !== undefined)
            appendSqliteCommandEvents(db, eventOwnerOf(bound, appScope, receipt.actorId)!, receipt, audits[0], eventBatch);
        },
        eventBatch !== undefined,
      ),
    // In the journal's namespace, so a tenant's sequences are its own.
    nextNumber: (appId: string, name: string, per: string, start: number) =>
      invoke({ appId, name, per, start }, async (input) => {
        text(input.appId, 'application', 128);
        if ((member && input.appId !== member.appId) || (appScope && input.appId !== appScope.appId)) return invalid();
        return nextSqliteCommandNumber(db, { appId: input.appId, namespace, name: input.name, per: input.per }, input.start);
      }),
    kept: (appId: string, commandId: string, commandVersion: number) =>
      invoke({ appId, commandId, commandVersion }, async (input) => {
        text(input.appId, 'application', 128);
        text(input.commandId, 'command', 128);
        if (!Number.isSafeInteger(input.commandVersion) || input.commandVersion < 1) return invalid();
        return (
          db
            .prepare(
              `SELECT 1 FROM main."${COMMAND_JOURNAL_TABLES.receipt}" WHERE app_id = ? AND command_id = ? AND command_version = ? LIMIT 1`,
            )
            .get(input.appId, input.commandId, input.commandVersion) !== undefined
        );
      }),
    taken: (scope: CommandReceiptScope) =>
      invoke(
        { scope },
        async ({ scope }) =>
          db
            .prepare(`SELECT 1 FROM main."${COMMAND_JOURNAL_TABLES.receipt}"
      WHERE app_id = ? AND store_id = ? AND source_id = ? AND realm = ? AND tenant_id = ?
        AND actor_id = ? AND command_id = ? AND command_version = ? AND idempotency_key = ? LIMIT 1`)
            .get(...values(scope)) !== undefined,
      ),
    /* BEGIN IMMEDIATE already serialises every writer in the file, so a
       receipt under this scope either committed before this transaction
       began, and the insert does nothing, or cannot exist. */
    insert: (receipt: StoredCommandReceipt, audit: CommandAudit | readonly CommandAudit[]) =>
      invoke({ receipt, audit }, async ({ receipt, audit }) => {
        validateReceipt(receipt);
        const scope = values(receipt);
        const audits = auditEntries(audit, undefined);
        const owners = audits.map((entry) => auditOwner(entry, namespace[2], namespace[3]));
        const row = receiptRow(receipt, scope, member, audits, owners);
        const written = db
          .prepare(`INSERT INTO main."${COMMAND_JOURNAL_TABLES.receipt}" (${RECEIPT_COLUMNS})
        VALUES (${row.map(() => '?').join(', ')}) ON CONFLICT DO NOTHING`)
          .run(...(row as SQLInputValue[]));
        return Number(written.changes) === 1;
      }),
  });
  if (!member)
    ordinaryRecovery.set(journal, (scope, expectedManifest) =>
      invoke(
        { scope, expectedManifest },
        async ({ scope, expectedManifest }) => lookup(scope, expectedManifest),
        expectedManifest !== undefined,
      ),
    );
  return journal;
}
