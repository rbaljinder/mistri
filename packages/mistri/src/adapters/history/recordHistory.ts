/**
 * Record history, the engine-neutral half: what a record's change log keeps,
 * who a write is attributed to, and how one write's before and after images
 * become its rows.
 *
 * The journal (server/journal.ts) is in memory on purpose: it holds what it
 * takes to undo, and an undo from an hour ago is an overwrite. A record's
 * history is the other question — who changed what, and when — and that
 * answer has to outlive the process, so it lives in the database beside the
 * records, in reserved `__mistri_history_*` tables, written in the same
 * transaction as the change it describes. A write that commits has its row;
 * one that rolls back has none; a history row that cannot be written fails
 * the write. No after-the-fact appender could promise that.
 *
 * Capture sits inside each adapter's transaction, under every facade: the
 * form's Save, a grid cell, a bulk edit, an action, a command, an Undo, an
 * agent's update and a row-policy or tenant writer all reach the same three
 * methods, so none of them can forget to record. Which tables keep a history
 * is the App's to say (a page with a `history()` section), bound once per
 * physical adapter by trusted server code. Who made a write is set by that
 * code too, from the verified session, around the work — never read from a
 * request body.
 *
 * What it deliberately does not keep. A redacted column (`audit.redact`)
 * records that it changed and never its values. A delete records only that
 * the record went: its page is gone, and the row it held is not history
 * anyone can open. Raw SQL writes are not recorded, because nothing can say
 * which records a statement changed. And it is not tamper-evident: whoever
 * can write the database can edit its history, which is what the support
 * audit's MAC chain exists for and this log does not claim.
 */
import { commandEventsAppended } from '../events/commandEventSignal.js';
import { randomUUID } from 'node:crypto';
import { registerPrune } from '../retention/pruner.js';
import {
  Refusal,
  type DeleteRequest,
  type DeleteResult,
  type InsertRequest,
  type InsertResult,
  type TellRequest,
  type UpdateRequest,
  type UpdateResult,
} from '@mistriwork/engine/adapters/adapter.js';
import { captureNotices, noticeBinding, type NoticeRow } from '../inbox/inbox.js';
import type { QueuedChannelNotice } from '../integrations/integrationStore.js';
import { currentWriteAttribution, WRITE_VIAS, type WriteVia } from '@mistriwork/engine/adapters/writeAttribution.js';

export const RECORD_HISTORY_VERSION = 1;
export const RECORD_HISTORY_PREFIX = '__mistri_history_';
export const RECORD_HISTORY_TABLES = Object.freeze({
  meta: `${RECORD_HISTORY_PREFIX}meta`,
  change: `${RECORD_HISTORY_PREFIX}change`,
});
/** A record's rows, newest last. */
export const RECORD_HISTORY_INDEX = `${RECORD_HISTORY_PREFIX}change_record`;
/** By age: what retention's daily prune and a feed's window read, so neither scans the log. */
export const RECORD_HISTORY_AT_INDEX = `${RECORD_HISTORY_PREFIX}change_at`;

/* Old rows are forgotten under the App's `history` window (server/retention.ts). */
registerPrune({
  id: 'record-history',
  window: 'history',
  table: RECORD_HISTORY_TABLES.change,
  time: 'at',
  clock: { sqlite: 'iso-text', postgres: 'timestamp', mysql: 'timestamp' },
});

/** Bounds, the same on every engine. A value past TEXT_LIMIT is kept cut. */
export const RECORD_HISTORY_LIMITS = Object.freeze({
  key: 2048,
  changes: 262_144,
  text: 1000,
  actor: 320,
  actorName: 200,
  action: 200,
  resource: 512,
});

export class RecordHistoryUnavailable extends Refusal {
  constructor(
    message = 'The record history store is missing or is not the layout this version expects. It is provisioned once, never on ' +
      "startup: run `mistri migrate stores up --app <the App's directory>`, or provisionStores(<the database>, { only: ['record-history'] }) from " +
      '@mistriwork/mistri/maintenance against the database, then start again. A foreign layout is refused, not altered.',
  ) {
    super(message);
    this.name = 'RecordHistoryUnavailable';
  }
}

/* ---------- which tables keep a history ---------- */

/**
 * What one table's history keeps of its values: every value, none
 * (`'values'`), or all but some. `owner` names a tenant-owned table's
 * ownership column (a tenant App's, tenant/tenantRecordHistoryStore.ts): its
 * value is part of the record's key in the store, read off the row inside
 * the write's own transaction, so a record's history is its tenant's alone —
 * the same key under another tenant, or reused there after a delete, is a
 * different record's. The column itself is never a change.
 */
export interface RecordHistoryRule {
  readonly redact: 'values' | ReadonlySet<string>;
  readonly owner?: string;
  /**
   * Columns the platform advances itself on a write and no person sets: the
   * table's revision column (server/commands/commandRevision.ts). An update
   * whose only moved columns are these writes no row, so a retried or no-op
   * save does not fill the log with "version changed". Declared by the code
   * that binds the rule, from the catalog; the store never infers one from a name.
   */
  readonly bookkeeping?: ReadonlySet<string>;
}
/** Physical table id (as the adapter is asked it) → its rule. */
export type RecordHistoryBinding = ReadonlyMap<string, RecordHistoryRule>;

const bindings = new WeakMap<object, RecordHistoryBinding>();

/** Trusted server code only: which of this physical adapter's tables keep a
 * history. Replaces what was bound; an empty binding records nothing. */
export function bindRecordHistory(adapter: object, binding: RecordHistoryBinding): void {
  if (!binding.size) {
    bindings.delete(adapter);
    return;
  }
  bindings.set(
    adapter,
    new Map(
      [...binding].map(([table, rule]) => [
        table,
        Object.freeze({
          redact: rule.redact === 'values' ? ('values' as const) : new Set(rule.redact),
          ...(rule.owner ? { owner: rule.owner } : {}),
          ...(rule.bookkeeping?.size ? { bookkeeping: new Set(rule.bookkeeping) } : {}),
        }),
      ]),
    ),
  );
}

/** What this adapter records, for its own transactions to read. */
export const recordHistoryBinding = (adapter: object): RecordHistoryBinding | undefined => bindings.get(adapter);

/**
 * Whether a write to this table is captured — a history kept, or a notice
 * sent (inbox/inbox.ts) — so that the adapter runs even a lone write inside
 * a transaction the capture's rows can join.
 */
export const capturesWrites = (adapter: object, table: unknown): boolean =>
  typeof table === 'string' && Boolean(bindings.get(adapter)?.has(table) || noticeBinding(adapter)?.has(table));

/* ---------- who a write is ---------- */

/* Who and what a write is lives with the write path (../writeAttribution.ts); this log reads it. */

/* An address, as a name that looks like one: a person may make their name
   their email, and whoever reads a history is not thereby one who may read
   people's emails. */
const LOOKS_LIKE_ADDRESS = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/**
 * What a history entry and a notice call the person who wrote: their name at
 * the time, one plain line within the store's bound, and never anything that
 * reads as an email address. '' where there is none to say, which a reader
 * sees as "Someone".
 */
export function sayableActorName(name: unknown): string {
  if (typeof name !== 'string') return '';
  const line = name
    .replace(/[\p{Cc}\p{Cs}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!line || LOOKS_LIKE_ADDRESS.test(line)) return '';
  // Bounded in bytes, as every engine's store and the inbox's check are, and cut between characters.
  let kept = '';
  for (const character of line) {
    if (Buffer.byteLength(kept + character, 'utf8') > RECORD_HISTORY_LIMITS.actorName) break;
    kept += character;
  }
  return kept.trim();
}

/* ---------- what one write stores ---------- */

type HistoryValue = string | number | boolean | null;
/** One field's change: before and after, or only that it changed (`r`). A value cut to the limit carries `t`. */
export interface StoredChange {
  c: string;
  b?: HistoryValue;
  a?: HistoryValue;
  r?: 1;
  t?: 1;
}
type ChangeKind = 'insert' | 'update' | 'delete';

/** One record's change in one write, as a row of the change table. */
export interface RecordChangeRow {
  writeId: string;
  at: string;
  resource: string;
  key: string;
  kind: ChangeKind;
  changes: StoredChange[];
  /** The verified account, for whoever can read the store; never said to a reader of the App. */
  actor: string;
  /** What the account was called when it wrote, or '' — what a reader is shown. */
  actorName: string;
  via: WriteVia;
  action: string;
}

/** A stored row read back, newest first. */
export interface StoredRecordChange extends RecordChangeRow {
  id: number;
}

/**
 * A record's key as the store names it: its columns in order, each value as
 * text, so 3 and '3' are one record. A tenant-owned record's owner is one of
 * its columns here (`historyKey({ ...key, [owner]: tenant })`).
 */
export function historyKey(key: Record<string, unknown>): string {
  const text = JSON.stringify(
    Object.fromEntries(
      Object.keys(key)
        .sort()
        .map((column) => [column, String(key[column])]),
    ),
  );
  if (Buffer.byteLength(text, 'utf8') > RECORD_HISTORY_LIMITS.key) throw new Refusal("This record's key is too long to keep a history.");
  return text;
}

function stored(value: unknown): { value: HistoryValue; cut?: true } {
  if (value === null || value === undefined) return { value: null };
  if (typeof value === 'boolean') return { value };
  if (typeof value === 'number') return { value: Number.isFinite(value) ? value : String(value) };
  if (typeof value === 'bigint') return { value: value.toString() };
  if (value instanceof Uint8Array) return { value: `<${value.byteLength} bytes>` };
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  return text.length > RECORD_HISTORY_LIMITS.text ? { value: `${text.slice(0, RECORD_HISTORY_LIMITS.text)}…`, cut: true } : { value: text };
}

/* Values cross the driver: 3 and '3' are one value, null is only null. */
const same = (a: unknown, b: unknown) =>
  a === null || a === undefined || b === null || b === undefined ? (a ?? null) === (b ?? null) : String(a) === String(b);

const redacted = (rule: RecordHistoryRule, column: string) => rule.redact === 'values' || rule.redact.has(column);

function change(rule: RecordHistoryRule, column: string, before: unknown, after: unknown, kind: ChangeKind): StoredChange {
  if (redacted(rule, column)) return { c: column, r: 1 };
  const out: StoredChange = { c: column };
  if (kind !== 'insert') {
    const b = stored(before);
    out.b = b.value;
    if (b.cut) out.t = 1;
  }
  const a = stored(after);
  out.a = a.value;
  if (a.cut) out.t = 1;
  return out;
}

function bounded(changes: StoredChange[]): StoredChange[] {
  // A pathological row (hundreds of long columns) keeps every column's name
  // and loses values from the end, rather than failing the business write.
  let kept = changes;
  while (Buffer.byteLength(JSON.stringify(kept), 'utf8') > RECORD_HISTORY_LIMITS.changes) {
    const at = kept.findLastIndex((item) => item.b !== undefined || item.a !== undefined);
    if (at === -1) throw new Refusal('This write changes too many fields to keep a history.');
    kept = kept.map((item, index) => (index === at ? { c: item.c, r: 1 } : item));
  }
  return kept;
}

/** The two things a capture needs from its transaction: a row by key, and an append. Both on the writer. */
export interface RecordHistorySink {
  /** `lock` takes the row for the rest of the transaction (FOR UPDATE), so the before image is the one the write replaces. */
  read(
    table: string,
    key: Record<string, string | number>,
    columns?: string[],
    lock?: boolean,
  ): Promise<Record<string, unknown> | undefined>;
  /** Up to `limit` rows whose columns equal these values: the members of a team a notice mentions. */
  rows(table: string, where: Record<string, string | number>, columns: string[], limit: number): Promise<Record<string, unknown>[]>;
  append(row: RecordChangeRow): Promise<void>;
  /** A notice, appended in the same transaction (inbox/inbox.ts). */
  notify(row: NoticeRow): Promise<void>;
  /** A notice's channel message, queued in the same transaction (inbox/inbox.ts, `send`). */
  message?(row: QueuedChannelNotice): Promise<void>;
}

interface RecordHistoryCapture {
  insert(request: InsertRequest, write: (request: InsertRequest) => Promise<InsertResult>): Promise<InsertResult>;
  update(request: UpdateRequest, write: (request: UpdateRequest) => Promise<UpdateResult>): Promise<UpdateResult>;
  remove(request: DeleteRequest, write: (request: DeleteRequest) => Promise<DeleteResult>): Promise<DeleteResult>;
  /** A flow's notify step: the record's `{ flow }` rules tell their people, in this transaction (WriteTransaction.tell). */
  tell(request: TellRequest): Promise<void>;
}

/**
 * One transaction's capture, or undefined where the adapter records nothing.
 * Every row of the transaction shares its write id and moment, which is what
 * groups a command's several changes to one record into one entry.
 */
export function captureRecordHistory(
  adapter: object,
  sink: RecordHistorySink,
  now: () => Date = () => new Date(),
): RecordHistoryCapture | undefined {
  const binding = bindings.get(adapter);
  if (!binding && !noticeBinding(adapter)) return undefined;
  // Read once, when the transaction starts: the attribution belongs to the
  // code that opened it, not to whatever runs when a queued write settles.
  const attribution = currentWriteAttribution();
  const writeId = randomUUID();
  const at = now().toISOString();
  const actor = (attribution?.actor ?? '').slice(0, RECORD_HISTORY_LIMITS.actor);
  const actorName = actor ? sayableActorName(attribution?.name) : '';
  const via: WriteVia = attribution?.via && WRITE_VIAS.includes(attribution.via) ? attribution.via : 'system';
  const action = (attribution?.action ?? '').slice(0, RECORD_HISTORY_LIMITS.action);
  const append = (resource: string, key: Record<string, unknown>, kind: ChangeKind, changes: StoredChange[]) => {
    const appended = sink.append({
      writeId,
      at,
      resource,
      key: historyKey(key),
      kind,
      changes: bounded(changes),
      actor,
      actorName,
      via,
      action,
    });
    // A change may start a flow (workflows/flowTail.ts): the jobs host in this process looks soon rather than at its longest wait.
    commandEventsAppended();
    return appended;
  };
  /* A tenant-owned record's store key carries its owner, read off the row in
     this transaction; a row that does not say whose it is has no history. */
  const owned = (
    rule: RecordHistoryRule,
    key: Record<string, unknown>,
    row: Record<string, unknown> | undefined,
  ): Record<string, unknown> => {
    if (!rule.owner) return key;
    const owner = row?.[rule.owner];
    if (typeof owner !== 'string' || !owner) throw new Refusal('This record does not say whose it is, so no history can be kept for it.');
    return { ...key, [rule.owner]: owner };
  };
  /* The same transaction tells the people the App says a write concerns. */
  const notices = captureNotices(
    adapter,
    { read: sink.read, rows: sink.rows, notify: sink.notify, message: sink.message },
    {
      actor,
      actorName,
      action,
      at,
      /* Nobody signed in, through a form or a public page: a visitor, whose typed address the email channel does not mail
         unproven (integrations/integrationChannels.ts). The platform, an agent and a token's service write as services. */
      kind: actor ? 'account' : via === 'form' || via === 'app' ? 'public' : 'service',
    },
  );
  return {
    async insert(request, write) {
      const rule = binding?.get(request.table);
      const watched = notices?.columns(request.table);
      if (!rule && !watched) return write(request);
      const result = await write(request);
      if (!Object.keys(result.key).length) return result;
      if (rule) {
        const given = result.row;
        const row = given && (!rule.owner || Object.hasOwn(given, rule.owner)) ? given : await sink.read(request.table, result.key);
        const changes = Object.entries(row ?? result.applied)
          .filter(([column, value]) => value !== null && value !== undefined && !Object.hasOwn(result.key, column) && column !== rule.owner)
          .map(([column, value]) => change(rule, column, undefined, value, 'insert'));
        await append(request.table, owned(rule, result.key, row), 'insert', changes);
      }
      if (watched) {
        const given = result.row;
        const after =
          given && watched.every((column) => Object.hasOwn(given, column)) ? given : await sink.read(request.table, result.key, watched);
        if (after) await notices!.inserted(request.table, result.key, after);
      }
      return result;
    },
    async update(request, write) {
      const rule = binding?.get(request.table);
      const watched = notices?.columns(request.table);
      if (!rule && !watched) return write(request);
      const columns = Object.keys(request.values);
      const owner = rule?.owner;
      // The before image holds what the rules read too, so a notice can tell what the write newly said.
      const before = await sink.read(
        request.table,
        request.key,
        [...new Set([...columns, ...(owner ? [owner] : []), ...(watched ?? [])])],
        true,
      );
      const result = await write(request);
      if (result.affected !== 1 || !before) return result;
      // A key column the update moved is read back under its new value.
      const key = Object.fromEntries(
        Object.entries(request.key).map(([column, value]) => [
          column,
          Object.hasOwn(result.applied, column) ? (result.applied[column] as string | number) : value,
        ]),
      );
      const after = await sink.read(request.table, key, watched ? [...new Set([...columns, ...watched])] : columns);
      if (!after) return result;
      const moved = columns.filter((column) => !same(before[column], after[column]) && column !== owner);
      // Writing the value a record already holds is not a change to it, and nor is the platform advancing its own bookkeeping.
      if (rule && moved.some((column) => !rule.bookkeeping?.has(column)))
        await append(
          request.table,
          owned(rule, key, before),
          'update',
          moved.map((column) => change(rule, column, before[column], after[column], 'update')),
        );
      if (watched) await notices!.updated(request.table, key, new Set(moved), after, { ...after, ...before });
      return result;
    },
    async remove(request, write) {
      const rule = binding?.get(request.table);
      if (!rule) return write(request);
      // Whose the record was, read before it goes: its delete ends that tenant's history of it.
      const before = rule.owner ? await sink.read(request.table, request.key, [rule.owner], true) : undefined;
      const result = await write(request);
      if (result.affected === 1) await append(request.table, owned(rule, request.key, before), 'delete', []);
      return result;
    },
    async tell(request) {
      const watched = notices?.columns(request.table);
      if (!watched) return;
      const row = await sink.read(request.table, request.key, watched);
      if (row) await notices!.told(request.table, request.key, request.audience, request.message, row);
    },
  };
}

/** A stored changes document read back, or a refusal: the store is ours, but its rows are data. */
export function parseStoredChanges(text: unknown): StoredChange[] {
  let parsed: unknown;
  try {
    parsed = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    throw new RecordHistoryUnavailable();
  }
  if (!Array.isArray(parsed)) throw new RecordHistoryUnavailable();
  return parsed.flatMap((item): StoredChange[] => {
    if (!item || typeof item !== 'object' || typeof item.c !== 'string') return [];
    const scalar = (value: unknown): value is HistoryValue => value === null || ['string', 'number', 'boolean'].includes(typeof value);
    return [
      {
        c: item.c,
        ...(Object.hasOwn(item, 'b') && scalar(item.b) ? { b: item.b } : {}),
        ...(Object.hasOwn(item, 'a') && scalar(item.a) ? { a: item.a } : {}),
        ...(item.r === 1 ? { r: 1 as const } : {}),
        ...(item.t === 1 ? { t: 1 as const } : {}),
      },
    ];
  });
}

/** Shared row validation for every engine's append: the store's CHECKs say the same. */
export function assertChangeRow(row: RecordChangeRow): string {
  const changes = JSON.stringify(row.changes);
  if (
    typeof row.resource !== 'string' ||
    !row.resource ||
    Buffer.byteLength(row.resource, 'utf8') > RECORD_HISTORY_LIMITS.resource ||
    !['insert', 'update', 'delete'].includes(row.kind) ||
    !WRITE_VIAS.includes(row.via) ||
    typeof row.actorName !== 'string' ||
    Buffer.byteLength(row.actorName, 'utf8') > RECORD_HISTORY_LIMITS.actorName ||
    Buffer.byteLength(changes, 'utf8') > RECORD_HISTORY_LIMITS.changes
  )
    throw new Refusal('Invalid record history entry.');
  return changes;
}

/** How many of a record's rows a read returns at most. */
export const RECORD_HISTORY_PAGE = 200;

/** A read's bounds: at most `limit` rows, older than `before` when given. */
export interface RecordHistoryQuery {
  resource: string;
  key: string;
  limit: number;
  before?: number;
}

/**
 * A feed's bounds (a dashboard's `activity()`): the newest rows of some
 * resources, at most `limit`, written at or after `from` and before `to`
 * (instants as `toISOString()` writes them, which is how `at` is stored, so
 * they compare as text on every engine). Deletes are left out, and so is
 * every row of a record whose key was deleted since: a key the database handed
 * out again belongs to a new record, whose feed is not the old one's.
 */
export interface RecordActivityQuery {
  resources: readonly string[];
  limit: number;
  from?: string;
  to?: string;
  /** The rows appended after this one, oldest first: a tail's cursor (the flows' triggers, jobHost.ts) rather than a feed's page. */
  after?: number;
  /** One tenant's feed (a tenant App): a row of a resource `columns` names is
   * that tenant's only when its key's owner column (`columns[resource]`) says
   * so; a resource it does not name is the platform's and read as it is. In
   * the store, before `limit`, so other tenants' writes never crowd it out. */
  owners?: Readonly<{ tenant: string; columns: Readonly<Record<string, string>> }>;
}

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const OWNER_COLUMN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const OWNER_TENANT = /^[a-z0-9][a-z0-9_-]{0,127}$/;

export function assertActivityQuery(query: RecordActivityQuery): void {
  if (
    !Array.isArray(query.resources) ||
    !query.resources.length ||
    query.resources.length > 64 ||
    query.resources.some((resource) => typeof resource !== 'string' || !resource) ||
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > RECORD_HISTORY_PAGE ||
    [query.from, query.to].some((bound) => bound !== undefined && (typeof bound !== 'string' || !INSTANT.test(bound))) ||
    (query.after !== undefined && (!Number.isSafeInteger(query.after) || query.after < 0)) ||
    (query.owners !== undefined &&
      (!query.owners ||
        typeof query.owners.tenant !== 'string' ||
        !OWNER_TENANT.test(query.owners.tenant) ||
        !query.owners.columns ||
        typeof query.owners.columns !== 'object' ||
        Object.entries(query.owners.columns).some(
          ([resource, column]) => !query.resources.includes(resource) || typeof column !== 'string' || !OWNER_COLUMN.test(column),
        )))
  ) {
    throw new Refusal('Invalid record activity read.');
  }
}

export function assertHistoryQuery(query: RecordHistoryQuery): void {
  if (
    typeof query.resource !== 'string' ||
    !query.resource ||
    typeof query.key !== 'string' ||
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > RECORD_HISTORY_PAGE ||
    (query.before !== undefined && (!Number.isSafeInteger(query.before) || query.before < 1))
  )
    throw new Refusal('Invalid record history read.');
}
