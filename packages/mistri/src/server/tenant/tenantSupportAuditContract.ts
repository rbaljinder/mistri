/**
 * The engine-neutral half of the support audit: the durable record of what an
 * operator did inside a dealer's tenant under a support session ("enter as
 * dealer"). Names, row shapes, validation, the audit key and the MAC chain
 * live here so SQLite (tenantSupportAudit.ts) and PostgreSQL
 * (tenantSupportAuditPostgres.ts) store and verify exactly the same thing.
 * Nothing here touches a database: the write sink, the read ledger and the
 * routes hold the handles and call in.
 *
 * Why a MAC chain on top of layout attestation: attestation stops other
 * roles, triggers, rules and policies, but not the App's own role — a
 * PostgreSQL `/api/sql` or MCP `sql` session, or anyone holding the SQLite
 * file, can edit a row. Each entry's MAC covers the previous MAC and every
 * column of the entry; the chain starts from a MAC over the store binding and
 * the session's fixed columns; the session row carries a tip MAC over the
 * last entry and the end columns; and a closed session's end is its last
 * entry. So an edited value, a deleted tail, a
 * reordered entry, a forged tip or an edited session no longer verifies. The
 * documented limit: someone with write access to the database *and* the key
 * can forge a chain.
 *
 * Layout 2 records the operator's display name in the session's fixed
 * columns, so the genesis MAC covers it: what a dealer is later shown as
 * "who" is as tamper-evident as the rest. The email stays platform-side, in
 * the native auth store. A layout 1 store is refused, not migrated: reseed.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import { canonicalCommandJson } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { binding, identifier, json } from './tenantAdministrationJournalValidation.js';
import { captureTenantData, denyTenant, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { parseTenantSelector } from './tenantMembership.js';
import type { TenantStoreBinding } from './tenantStoreContract.js';

export const SUPPORT_AUDIT_VERSION = 1;
export const SUPPORT_AUDIT_PREFIX = '__mistri_support_';
export const SUPPORT_AUDIT_TABLES = Object.freeze({
  meta: `${SUPPORT_AUDIT_PREFIX}meta`,
  session: `${SUPPORT_AUDIT_PREFIX}session`,
  entry: `${SUPPORT_AUDIT_PREFIX}entry`,
});
export const SUPPORT_ENTRY_KINDS = ['open', 'read', 'write', 'undo', 'command', 'exit'] as const;
export const SUPPORT_END_REASONS = ['exit', 'expired', 'revoked', 'parent_revoked', 'tenant_inactive', 'superseded'] as const;
const SUPPORT_WRITE_OPERATIONS = ['insert', 'update', 'delete'] as const;
/* A read entry lists every returned key, so it may be larger than a change. */
export const SUPPORT_DETAIL_BYTES = Object.freeze({ read: 262_144, other: 65_536 });
export const SUPPORT_KEY_BYTES = 8_192;
export const SUPPORT_REASON_BYTES = 500;
export const SUPPORT_NAME_BYTES = 256;

/* ---------- the audit key ---------- */

export const SUPPORT_AUDIT_KEY_VARIABLE = 'MISTRI_AUDIT_KEY';

export class SupportAuditKeyMissing extends Refusal {
  constructor() {
    super(
      `The support audit needs ${SUPPORT_AUDIT_KEY_VARIABLE}: a secret of at least 32 bytes, kept apart from BETTER_AUTH_SECRET ` +
        'so that rotating sign-in never breaks audit verification. It is read, never printed or stored.',
    );
    this.name = 'SupportAuditKeyMissing';
  }
}

/** The derived MAC key, held where no caller can read it. The handle only
 * names the key: `id` is recorded in the store's meta row, so a store written
 * under another key refuses instead of failing every chain. */
export interface SupportAuditKey {
  readonly id: string;
}
const secrets = new WeakMap<SupportAuditKey, Buffer>();

/** Derive the audit key from `MISTRI_AUDIT_KEY` (or the given secret). */
export function supportAuditKey(secret: string | undefined = process.env[SUPPORT_AUDIT_KEY_VARIABLE]): SupportAuditKey {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) throw new SupportAuditKeyMissing();
  const derived = Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), 'mistri.support-audit', 'mac.v1', 32));
  const id = createHmac('sha256', derived).update('mistri.support-audit.key-id').digest('hex').slice(0, 16);
  const key: SupportAuditKey = Object.freeze({ id });
  secrets.set(key, derived);
  return key;
}
/**
 * A store's meta row bound to this App, source and store, at this version,
 * under another key: the deployment's `MISTRI_AUDIT_KEY` is not the one
 * the store was set up with (field report G165). Said by what to do, never
 * with the key or its id: a start refused for it read only "The tenant
 * context could not be verified."
 */
export const SUPPORT_AUDIT_KEY_DIFFERS =
  'MISTRI_AUDIT_KEY is not the key this support audit store was set up with. Start with the key it was set up with: ' +
  'its sessions are signed with that key and are verified only with it. A new key needs a new support audit store.';
export function auditKeyDiffers(
  row: Readonly<Record<string, unknown>> | undefined,
  owner: { readonly appId: string; readonly source: { readonly id: string }; readonly storeId: string },
  key: SupportAuditKey,
  version: number,
): boolean {
  return (
    row !== undefined &&
    row.singleton === 1 &&
    row.version === version &&
    row.app_id === owner.appId &&
    row.source_id === owner.source.id &&
    row.store_id === owner.storeId &&
    typeof row.key_id === 'string' &&
    row.key_id !== keyId(key)
  );
}
export function keyId(key: SupportAuditKey): string {
  if (!secrets.has(key)) return denyTenant();
  return key.id;
}
function mac(key: SupportAuditKey, value: readonly unknown[]): string {
  const secret = secrets.get(key);
  if (!secret) return denyTenant();
  return createHmac('sha256', secret).update(canonicalCommandJson(value, 1_048_576)).digest('hex');
}
/** What a redacted column keeps instead of its value: a hash under the audit
 * key. Keyed, not a bare digest, so someone holding the log but not the key
 * cannot confirm a guessed value by hashing it; and salted by resource and
 * column, so the same value in two places does not visibly match across them.
 * The prefix is there so a reader can never mistake one for a stored value. */
export function supportRedacted(key: SupportAuditKey, resource: string, column: string, value: unknown): string {
  return `redacted:${mac(key, ['mistri.support-audit.redact.v1', resource, column, value ?? null]).slice(0, 32)}`;
}
const MAC = /^[0-9a-f]{64}$/;
function same(a: unknown, b: string): boolean {
  return typeof a === 'string' && MAC.test(a) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/* ---------- shapes ---------- */

/** A support session's fixed columns, as opening one records them. */
export interface SupportSession {
  id: string;
  tenantId: string;
  accountId: string;
  /** The operator's native display name when the session opened. */
  operatorName: string;
  dealerRole: string;
  parentMembershipId: string;
  parentMembershipVersion: string;
  /** The `@platform` tenant row's version when the session opened. */
  platformVersion: string;
  reason: string;
  openedAt: string;
  validUntil: number;
  nativeSessionId: string;
  deployment: string;
  policyId: string;
  policyVersion: string;
  openReceiptId: string;
}
export interface SupportSessionRow extends SupportSession {
  endedAt: string | null;
  endReason: string | null;
  headSeq: number;
  headMac: string;
}
/** One entry as a caller supplies it; the store adds the session, seq, tenant, realm and MACs. */
export interface SupportEntry {
  kind: (typeof SUPPORT_ENTRY_KINDS)[number];
  at: string;
  requestId: string;
  actorId: string;
  tenantVersion: string;
  supportMembershipVersion: string;
  parentMembershipVersion: string;
  platformVersion: string;
  resource: string | null;
  operation: string | null;
  keyJson: string | null;
  detailJson: string;
  commandReceiptId: string | null;
}
export interface SupportEntryRow extends SupportEntry {
  sessionId: string;
  seq: number;
  tenantId: string;
  realm: string;
  prevMac: string;
  mac: string;
}
/** The owner-only composition each engine returns, on the owner's open
 * transaction and queue. */
export interface SupportAudit {
  /** Record a new session and its opening entry. */
  open(session: SupportSession, entry: SupportEntry): Promise<void>;
  /** Append to an open session whose chain verifies; an exit entry closes it. */
  append(sessionId: string, entry: SupportEntry): Promise<{ seq: number }>;
  /** Whether a session's rows are intact; null for no such session. */
  verify(sessionId: string): Promise<boolean | null>;
}
/** Verified storage history only; copying this data cannot grant support access. */
export interface SupportAuditHeader {
  readonly stage: 'support-audit-header';
  readonly authorization: 'pending';
  readonly binding: TenantStoreBinding;
  readonly session: Omit<SupportSessionRow, 'headSeq' | 'headMac'>;
}
/** Private native writer composition, not a public log or admission surface. */
export interface SupportAuditOwner {
  readonly audit: SupportAudit;
  readHeader(sessionId: string): Promise<SupportAuditHeader | null>;
}
/** Called only after native exact-byte and full chain/tip verification. */
export function captureSupportAuditHeader(owner: TenantStoreBinding, row: SupportSessionRow): SupportAuditHeader {
  const { headSeq: _seq, headMac: _mac, ...session } = row;
  return captureTenantData<SupportAuditHeader>({
    stage: 'support-audit-header',
    authorization: 'pending',
    binding: binding(owner),
    session,
  });
}
/** Stored support history as a log reader returns it: whole sessions and the
 * entries belonging to them. Rows, not a verdict — nothing here verifies a
 * chain or admits anybody. At most SUPPORT_LOG_VISITS sessions, the newest;
 * `more` says older ones exist. */
export interface SupportLogRows {
  readonly sessions: readonly SupportSessionRow[];
  readonly entries: readonly SupportEntryRow[];
  readonly more: boolean;
}
/** What maintenance verification reports: counts and the sessions that fail. */
export interface SupportAuditReport {
  version: 1;
  sessions: number;
  entries: number;
  failed: string[];
}

const SESSION_FIELDS = [
  'id',
  'tenantId',
  'accountId',
  'operatorName',
  'dealerRole',
  'parentMembershipId',
  'parentMembershipVersion',
  'platformVersion',
  'reason',
  'openedAt',
  'validUntil',
  'nativeSessionId',
  'deployment',
  'policyId',
  'policyVersion',
  'openReceiptId',
] as const;
const ENTRY_FIELDS = [
  'kind',
  'at',
  'requestId',
  'actorId',
  'tenantVersion',
  'supportMembershipVersion',
  'parentMembershipVersion',
  'platformVersion',
  'resource',
  'operation',
  'keyJson',
  'detailJson',
  'commandReceiptId',
] as const;
/** Columns in insert order, and the camelCase alias each is read back as. */
export const SESSION_COLUMNS = [
  'id',
  'tenant_id',
  'account_id',
  'operator_name',
  'dealer_role',
  'parent_membership_id',
  'parent_membership_version',
  'platform_version',
  'reason',
  'opened_at',
  'valid_until',
  'native_session_id',
  'deployment',
  'policy_id',
  'policy_version',
  'open_receipt_id',
  'ended_at',
  'end_reason',
  'head_seq',
  'head_mac',
] as const;
export const ENTRY_COLUMNS = [
  'session_id',
  'seq',
  'kind',
  'at',
  'request_id',
  'actor_id',
  'tenant_id',
  'tenant_version',
  'realm',
  'support_membership_version',
  'parent_membership_version',
  'platform_version',
  'resource',
  'operation',
  'key_json',
  'detail_json',
  'command_receipt_id',
  'prev_mac',
  'mac',
] as const;
const camel = (column: string) => column.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
export const SESSION_SELECT = SESSION_COLUMNS.map((column) => `${column} AS "${camel(column)}"`).join(', ');
export const ENTRY_SELECT = ENTRY_COLUMNS.map((column) => `${column} AS "${camel(column)}"`).join(', ');

/* ---------- validation ---------- */

export function validateSupportInstant(value: unknown): void {
  identifier(value, 32);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) denyTenant();
}
const version = (value: unknown) => identifier(value, 64);
const nullable = (value: unknown, check: (value: unknown) => void) => {
  if (value !== null) check(value);
};
/* A malformed document is a refusal like any other, not a parser's SyntaxError. */
const document = (value: unknown, maximum: number) => {
  try {
    json(value, maximum);
  } catch {
    denyTenant();
  }
};

export function validateSupportSession(value: SupportSession): void {
  tenantRecord(value, SESSION_FIELDS);
  identifier(value.id, 1024);
  parseTenantSelector([value.tenantId]);
  identifier(value.accountId, 1024);
  identifier(value.operatorName, SUPPORT_NAME_BYTES);
  identifier(value.dealerRole);
  identifier(value.parentMembershipId, 1024);
  version(value.parentMembershipVersion);
  version(value.platformVersion);
  identifier(value.reason, SUPPORT_REASON_BYTES);
  validateSupportInstant(value.openedAt);
  if (!Number.isSafeInteger(value.validUntil) || value.validUntil < 0) denyTenant();
  identifier(value.nativeSessionId, 1024);
  identifier(value.deployment);
  identifier(value.policyId);
  identifier(value.policyVersion);
  identifier(value.openReceiptId, 1024);
}

export function validateEntry(value: SupportEntry): void {
  tenantRecord(value, ENTRY_FIELDS);
  if (!SUPPORT_ENTRY_KINDS.includes(value.kind)) denyTenant();
  validateSupportInstant(value.at);
  identifier(value.requestId, 1024);
  identifier(value.actorId, 1024);
  version(value.tenantVersion);
  version(value.supportMembershipVersion);
  version(value.parentMembershipVersion);
  version(value.platformVersion);
  nullable(value.resource, (resource) => identifier(resource));
  nullable(value.operation, (operation) => identifier(operation, 64));
  nullable(value.keyJson, (key) => document(key, SUPPORT_KEY_BYTES));
  nullable(value.commandReceiptId, (receipt) => identifier(receipt, 1024));
  document(value.detailJson, value.kind === 'read' ? SUPPORT_DETAIL_BYTES.read : SUPPORT_DETAIL_BYTES.other);
  const target = [value.resource, value.operation, value.keyJson];
  // Each kind carries exactly the columns that describe it, so a row cannot
  // be dressed as another kind after the fact.
  if (value.kind === 'write' || value.kind === 'undo') {
    if (
      target.includes(null) ||
      !(SUPPORT_WRITE_OPERATIONS as readonly string[]).includes(value.operation!) ||
      value.commandReceiptId !== null
    )
      denyTenant();
  } else if (value.kind === 'command') {
    if (value.commandReceiptId === null || value.keyJson !== null) denyTenant();
  } else if (target.some((column) => column !== null) || value.commandReceiptId !== null) denyTenant();
  if (value.kind === 'exit') {
    const detail = JSON.parse(value.detailJson) as { endReason?: unknown };
    if (!detail || typeof detail !== 'object' || !(SUPPORT_END_REASONS as readonly string[]).includes(detail.endReason as string))
      denyTenant();
  }
}

/* ---------- the chain ---------- */

function genesis(key: SupportAuditKey, owner: TenantStoreBinding, session: SupportSession): string {
  return mac(key, [
    'mistri.support-audit.genesis.v2',
    owner.appId,
    owner.source.id,
    owner.storeId,
    ...SESSION_FIELDS.map((field) => session[field]),
  ]);
}
function entryMac(key: SupportAuditKey, row: Omit<SupportEntryRow, 'mac'>): string {
  return mac(key, [
    'mistri.support-audit.entry.v1',
    row.sessionId,
    row.seq,
    row.prevMac,
    row.kind,
    row.at,
    row.requestId,
    row.actorId,
    row.tenantId,
    row.tenantVersion,
    row.realm,
    row.supportMembershipVersion,
    row.parentMembershipVersion,
    row.platformVersion,
    row.resource,
    row.operation,
    row.keyJson,
    row.detailJson,
    row.commandReceiptId,
  ]);
}
/* The tip is its own MAC, not a copy of the last entry's: that value sits in
   the entry row for anyone to copy, so deleting the newest entries and moving
   the tip back to an earlier one would verify. A tip value exists only in the
   session row, until the next append replaces it; rewinding now needs a tip
   captured while it was live. It also covers the end columns. */
function headMac(
  key: SupportAuditKey,
  sessionId: string,
  seq: number,
  last: string,
  endedAt: string | null,
  endReason: string | null,
): string {
  return mac(key, ['mistri.support-audit.head.v1', sessionId, seq, last, endedAt, endReason]);
}
const fixed = (row: SupportSessionRow): SupportSession =>
  Object.fromEntries(SESSION_FIELDS.map((field) => [field, row[field]])) as unknown as SupportSession;
const supplied = (row: SupportEntryRow): SupportEntry =>
  Object.fromEntries(ENTRY_FIELDS.map((field) => [field, row[field]])) as unknown as SupportEntry;

/** Whether one session's rows are exactly what this key and store wrote, in
 * order and complete. Never throws: a false is what a dealer's log shows as
 * "integrity check failed". Entries must be ordered by seq. */
export function verifySupportSession(
  key: SupportAuditKey,
  input: TenantStoreBinding,
  session: SupportSessionRow,
  entries: readonly SupportEntryRow[],
): boolean {
  try {
    const owner = binding(input);
    validateSupportSession(fixed(session));
    if (!entries.length || !Number.isSafeInteger(session.headSeq) || session.headSeq !== entries.length - 1) return false;
    let previous = genesis(key, owner, fixed(session));
    for (const [index, row] of entries.entries()) {
      validateEntry(supplied(row));
      if (
        row.sessionId !== session.id ||
        row.seq !== index ||
        row.tenantId !== session.tenantId ||
        row.realm !== 'tenant' ||
        (row.kind === 'open') !== (index === 0) ||
        (row.kind === 'exit' && index !== entries.length - 1)
      )
        return false;
      if (!same(row.prevMac, previous) || !same(row.mac, entryMac(key, row))) return false;
      previous = row.mac;
    }
    if (!same(session.headMac, headMac(key, session.id, session.headSeq, previous, session.endedAt, session.endReason))) return false;
    // A closed session's end is its exit entry, so the end columns are covered too.
    const last = entries[entries.length - 1];
    if (session.endedAt === null || session.endReason === null) return session.endedAt === session.endReason && last.kind !== 'exit';
    return (
      last.kind === 'exit' &&
      last.at === session.endedAt &&
      (JSON.parse(last.detailJson) as { endReason: string }).endReason === session.endReason
    );
  } catch {
    return false;
  }
}

/** The two rows that open a session: the session (its tip already the open
 * entry's MAC) and that entry at seq 0, chained from the genesis. */
export function planSupportOpen(
  key: SupportAuditKey,
  input: TenantStoreBinding,
  sessionInput: SupportSession,
  openInput: SupportEntry,
): { session: SupportSessionRow; entry: SupportEntryRow } {
  const owner = binding(input);
  const session = captureTenantData(sessionInput),
    open = captureTenantData(openInput);
  validateSupportSession(session);
  validateEntry(open);
  if (open.kind !== 'open') return denyTenant();
  const body = {
    ...open,
    sessionId: session.id,
    seq: 0,
    tenantId: session.tenantId,
    realm: 'tenant',
    prevMac: genesis(key, owner, session),
  };
  const entry = { ...body, mac: entryMac(key, body) };
  return {
    session: { ...session, endedAt: null, endReason: null, headSeq: 0, headMac: headMac(key, session.id, 0, entry.mac, null, null) },
    entry,
  };
}

/** The next entry on a verified, open session, and the tip it moves to. An
 * exit entry also closes the session. Refuses a chain that does not verify. */
export function planSupportAppend(
  key: SupportAuditKey,
  input: TenantStoreBinding,
  session: SupportSessionRow,
  entries: readonly SupportEntryRow[],
  entryInput: SupportEntry,
): { entry: SupportEntryRow; headSeq: number; headMac: string; end: { endedAt: string; endReason: string } | null } {
  const next = captureTenantData(entryInput);
  validateEntry(next);
  if (next.kind === 'open' || session.endedAt !== null || !verifySupportSession(key, input, session, entries)) return denyTenant();
  const seq = session.headSeq + 1;
  const body = {
    ...next,
    sessionId: session.id,
    seq,
    tenantId: session.tenantId,
    realm: 'tenant',
    prevMac: entries[entries.length - 1].mac,
  };
  const entry = { ...body, mac: entryMac(key, body) };
  const end =
    next.kind === 'exit' ? { endedAt: next.at, endReason: (JSON.parse(next.detailJson) as { endReason: string }).endReason } : null;
  return { entry, headSeq: seq, headMac: headMac(key, session.id, seq, entry.mac, end?.endedAt ?? null, end?.endReason ?? null), end };
}

export const sessionValues = (row: SupportSessionRow) => [
  row.id,
  row.tenantId,
  row.accountId,
  row.operatorName,
  row.dealerRole,
  row.parentMembershipId,
  row.parentMembershipVersion,
  row.platformVersion,
  row.reason,
  row.openedAt,
  row.validUntil,
  row.nativeSessionId,
  row.deployment,
  row.policyId,
  row.policyVersion,
  row.openReceiptId,
  row.endedAt,
  row.endReason,
  row.headSeq,
  row.headMac,
];
export const entryValues = (row: SupportEntryRow) => [
  row.sessionId,
  row.seq,
  row.kind,
  row.at,
  row.requestId,
  row.actorId,
  row.tenantId,
  row.tenantVersion,
  row.realm,
  row.supportMembershipVersion,
  row.parentMembershipVersion,
  row.platformVersion,
  row.resource,
  row.operation,
  row.keyJson,
  row.detailJson,
  row.commandReceiptId,
  row.prevMac,
  row.mac,
];

export { binding as supportAuditBinding };
