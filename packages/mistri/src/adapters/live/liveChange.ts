/**
 * Live sync, the engine-neutral half of its store: what one write
 * transaction's change row says, which of an adapter's tables write one, and
 * the capture that builds it beneath every write (../writeCapture.ts).
 *
 * One row per transaction, written by the capture's `finish()` just before
 * COMMIT, so a row exists exactly when its writes committed: a rolled-back
 * transaction leaves none, and no after-the-fact appender could promise that.
 * The capture is the one place every App write passes — a Save, a cell, a
 * bulk edit, a command, an Undo, a flow step, a row-policy or tenant writer —
 * so none of them can forget to announce itself. Raw SQL is not captured, as
 * history's is not: nothing can say which records a statement changed.
 *
 * What a row keeps is what the server's hub (server/live/liveHub.ts) needs to
 * tell each subscriber only about rows they may read: the table, the kind,
 * the changed keys (at most 200, else `many`), the columns an update wrote,
 * the owning tenant on a tenant table (read off the row inside this
 * transaction, as history reads it), and on a table a row scope filters, the
 * before image a scope may name, so a delete or a move out of scope reaches
 * exactly the people who could see the row before. None of it leaves the
 * server: an event carries table ids and filtered keys, never values, actor,
 * tenant or scope.
 *
 * The store is a cache, not a log: fifteen minutes of rows, and on PostgreSQL
 * an UNLOGGED table, whose loss in a crash costs the subscribers a `reset`,
 * never a wrong answer.
 */
import {
  Refusal,
  type DeleteRequest,
  type DeleteResult,
  type InsertRequest,
  type InsertResult,
  type UpdateRequest,
  type UpdateResult,
} from '@mistriwork/engine/adapters/adapter.js';
import { currentWriteAttribution } from '@mistriwork/engine/adapters/writeAttribution.js';

export const LIVE_CHANGE_VERSION = 1;
export const LIVE_CHANGE_PREFIX = '__mistri_live_';
export const LIVE_CHANGE_TABLES = Object.freeze({
  meta: `${LIVE_CHANGE_PREFIX}meta`,
  change: `${LIVE_CHANGE_PREFIX}change`,
});
/** The one index the change table carries besides its key: what the reader seeks by on PostgreSQL ((xact, id)), what retention prunes by elsewhere (at). */
export const LIVE_CHANGE_INDEX = `${LIVE_CHANGE_PREFIX}change_seek`;
/** The channel a committed change row is announced on (PostgreSQL). The payload is empty: any role that may connect may LISTEN. */
export const LIVE_CHANNEL = 'mistri_live';
export const NOTIFY_LIVE = `SELECT pg_notify('${LIVE_CHANNEL}', '')`;

/** Bounds, the same on every engine. */
export const LIVE_CHANGE_LIMITS = Object.freeze({
  /** Keys one entry names before it says `many` instead. */
  keys: 200,
  /** A row's entries as JSON, in bytes: past it the widest entries say `many`. */
  entries: 1_048_576,
  /** A before image keeps a text value only up to this many characters; a scope naming a longer one reads it as absent. */
  value: 256,
  actor: 320,
  tenant: 128,
  /** How long a row is kept. A cursor older than this is answered with `reset`. */
  retentionMs: 15 * 60_000,
});

export class LiveChangeUnavailable extends Refusal {
  constructor(
    message = 'The live sync store is missing or is not the layout this version expects. It is provisioned once, never on ' +
      "startup: run `mistri migrate stores up --app <the App's directory>`, or provisionStores(<the database>, { only: ['live-change'] }) " +
      'from @mistriwork/mistri/maintenance against the database. Until then pages refresh as they did before live sync.',
  ) {
    super(message);
    this.name = 'LiveChangeUnavailable';
  }
}

export type LiveKind = 'insert' | 'update' | 'delete';
export type LiveKey = Readonly<Record<string, string | number>>;
type LiveScalar = string | number | boolean | null;

/** One table's changes of one kind (and, on a tenant table, of one tenant) in one transaction. */
export interface LiveEntry {
  readonly table: string;
  readonly kind: LiveKind;
  /** The owning tenant of a tenant table's rows; absent where the table is not a tenant's or the row did not say. */
  readonly tenant?: string;
  readonly keys: readonly LiveKey[] | 'many';
  /** An update's written columns; absent for an insert or a delete, which change every column. */
  readonly columns?: readonly string[];
  /** On a scoped table, each changed row as it stood before (an update's, a delete's): what a scope may name, bounded. */
  readonly before?: ReadonlyArray<Readonly<Record<string, LiveScalar>>>;
}

/** One transaction's change row, as written. */
export interface LiveChangeRow {
  /** Milliseconds since the epoch: what retention prunes by. */
  readonly at: number;
  /** The verified account the transaction was attributed to, or '': the hub's "this was you", never sent. */
  readonly actor: string;
  /** The one tenant every entry names, or null. */
  readonly tenant: string | null;
  readonly entries: readonly LiveEntry[];
}

/** A row read back. `id` is the cursor a subscriber holds; `xact` orders it on PostgreSQL. */
export interface StoredLiveChange extends LiveChangeRow {
  readonly id: string;
}

/* ---------- which tables write a change row ---------- */

/**
 * What one adapter's tables say beyond their writes: the ownership column of
 * a tenant App's tenant tables, and which tables a row scope may filter (a
 * row-policy or tenant App's, `true` for all), whose before images are kept.
 */
export interface LiveBinding {
  readonly owners?: ReadonlyMap<string, string>;
  readonly scoped?: ReadonlySet<string> | true;
  /** Tables every App that follows changes on this database keeps out (a resource's `live: false`): a write to one says nothing. */
  readonly skip?: ReadonlySet<string>;
  /**
   * The only tables a write to which says something, where no App on this database follows its changes (`live`) and
   * some form offers a table's rows as its choices (server/forms/choiceCache.ts): the cache of those choices is told
   * of their writes, and nothing else is captured. Absent: every table but `skip`.
   */
  readonly only?: ReadonlySet<string>;
  /**
   * Whether the store stands attested, asked by the first write of each
   * transaction before anything is read or written for live sync: a binding
   * made before anyone looked (server/live/liveBinding.ts binds an adapter as
   * it is dialed) writes no row where the answer is no. Never rejects. Absent:
   * the binder attested the store first.
   */
  readonly ready?: () => Promise<boolean>;
}

const bindings = new WeakMap<object, LiveBinding>();

/** Trusted server code only (server/live/liveBinding.ts), once the adapter's store attests: every table of it writes a change row. */
export function bindLiveChanges(adapter: object, binding: LiveBinding | undefined): void {
  if (!binding) {
    bindings.delete(adapter);
    return;
  }
  bindings.set(
    adapter,
    Object.freeze({
      ...(binding.owners?.size ? { owners: new Map(binding.owners) } : {}),
      ...(binding.scoped === true ? { scoped: true as const } : binding.scoped?.size ? { scoped: new Set(binding.scoped) } : {}),
      ...(binding.skip?.size ? { skip: new Set(binding.skip) } : {}),
      ...(binding.only ? { only: new Set(binding.only) } : {}),
      ...(binding.ready ? { ready: binding.ready } : {}),
    }),
  );
}

/* The store's own tables and every other reserved one are mistri's, never a record anyone lists: the prefix, or on
   PostgreSQL the runtime schema. */
const reserved = (table: string) => /(^|\.)__mistri_|^"?mistri"?\./i.test(table);

/** Whether a write to this table writes a change row, so that even a lone write runs in a transaction the row can join. */
export const capturesLiveChanges = (adapter: object, table: unknown): boolean =>
  typeof table === 'string' && bindings.has(adapter) && !unheardBy(bindings.get(adapter)!, table);

/* Not a record anyone follows: mistri's own tables, those kept out of live sync, and — where only some tables are
   followed — every other. */
const unheardBy = (binding: LiveBinding, table: string): boolean =>
  reserved(table) || Boolean(binding.skip?.has(table)) || (binding.only !== undefined && !binding.only.has(bareTable(table)));

/** A table's name without its schema: how `only` names tables, since a write may name one either way (`make`, `public.make`). */
export const bareTable = (table: string): string => table.slice(table.lastIndexOf('.') + 1);

/* ---------- the in-process nudge ---------- */

const listeners = new Set<() => void>();

/** The hub in this process listens, so a change committed here is read at once, on every engine. Returns the unsubscribe. */
export function onLiveChanges(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A change row committed in this process. Carries nothing and grants nothing: the hub reads what the store holds. */
function liveChangesCommitted(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* A listener's failure is its own; the write has committed. */
    }
  }
}

/* ---------- one transaction's capture ---------- */

/** What the capture needs from its transaction: a row by key on the writer, and the append. */
export interface LiveChangeSink {
  read(
    table: string,
    key: Record<string, string | number>,
    columns?: string[],
    lock?: boolean,
  ): Promise<Record<string, unknown> | undefined>;
  append(row: LiveChangeRow): Promise<void>;
}

export interface LiveChangeCapture {
  insert(request: InsertRequest, write: (request: InsertRequest) => Promise<InsertResult>): Promise<InsertResult>;
  update(request: UpdateRequest, write: (request: UpdateRequest) => Promise<UpdateResult>): Promise<UpdateResult>;
  remove(request: DeleteRequest, write: (request: DeleteRequest) => Promise<DeleteResult>): Promise<DeleteResult>;
  finish(): Promise<void>;
  committed(): void;
}

/** A value a before image keeps: scalars only, a text only while short. Anything else is left out, and a scope that names it reads it as absent. */
function kept(value: unknown): LiveScalar | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return value.length <= LIVE_CHANGE_LIMITS.value ? value : undefined;
  return undefined;
}

function boundedImage(row: Record<string, unknown>, key: LiveKey): Record<string, LiveScalar> {
  const out: Record<string, LiveScalar> = {};
  for (const [column, value] of Object.entries(row)) {
    const scalar = kept(value);
    if (scalar !== undefined) out[column] = scalar;
  }
  // The key is always kept whole: it is what the image is matched by.
  for (const [column, value] of Object.entries(key)) out[column] = value;
  return out;
}

/* A key as the client holds it: its own columns, with the values the database handed back. */
function liveKey(key: Record<string, unknown>): LiveKey | undefined {
  const out: Record<string, string | number> = {};
  for (const [column, value] of Object.entries(key)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[column] = value;
    else if (typeof value === 'string') out[column] = value;
    else if (typeof value === 'bigint') out[column] = value.toString();
    else return undefined;
  }
  return Object.keys(out).length ? out : undefined;
}

const keyText = (key: LiveKey) =>
  JSON.stringify(
    Object.keys(key)
      .sort()
      .map((column) => [column, key[column]]),
  );

interface Building {
  table: string;
  kind: LiveKind;
  tenant?: string;
  keys: Map<string, LiveKey>;
  many: boolean;
  columns: Set<string>;
  before: Map<string, Record<string, LiveScalar>>;
  scoped: boolean;
}

/**
 * One transaction's capture, or undefined where the adapter writes no change
 * rows. Its writes are gathered as they go and written as one row at
 * `finish()`; a write that changed nothing (an update of no row) says nothing.
 */
export function captureLiveChanges(adapter: object, sink: LiveChangeSink, now: () => number = Date.now): LiveChangeCapture | undefined {
  const binding = bindings.get(adapter);
  if (!binding) return undefined;
  // Read once, when the transaction starts, as history's is: the attribution is the code's that opened it.
  const actor = (currentWriteAttribution()?.actor ?? '').slice(0, LIVE_CHANGE_LIMITS.actor);
  const building = new Map<string, Building>();
  let wrote = false;
  /* Asked once per transaction, at its first write: a store that is not there leaves every write as it was. */
  let ready: Promise<boolean> | undefined;
  const on = () => (ready ??= binding.ready ? binding.ready().catch(() => false) : Promise.resolve(true));
  const scoped = (table: string) => binding.scoped === true || Boolean(binding.scoped?.has(table));
  /* Not a record anyone follows: mistri's own tables, and those kept out of live sync. A transaction of only these writes no row. */
  const unheard = (table: string) => unheardBy(binding, table);
  const ownerOf = (table: string) => binding.owners?.get(table);
  const tenantOf = (table: string, row: Record<string, unknown> | undefined): string | undefined => {
    const owner = ownerOf(table);
    if (!owner) return undefined;
    const value = row?.[owner];
    return typeof value === 'string' && value && value.length <= LIVE_CHANGE_LIMITS.tenant ? value : undefined;
  };
  const note = (
    table: string,
    kind: LiveKind,
    tenant: string | undefined,
    key: LiveKey | undefined,
    columns: readonly string[] | undefined,
    before: Record<string, unknown> | undefined,
  ) => {
    wrote = true;
    const id = JSON.stringify([table, kind, tenant ?? null]);
    let entry = building.get(id);
    if (!entry) {
      entry = {
        table,
        kind,
        ...(tenant ? { tenant } : {}),
        keys: new Map(),
        many: false,
        columns: new Set(),
        before: new Map(),
        scoped: scoped(table),
      };
      building.set(id, entry);
    }
    for (const column of columns ?? []) entry.columns.add(column);
    if (entry.many) return;
    if (!key) {
      entry.many = true;
      entry.keys.clear();
      entry.before.clear();
      return;
    }
    const text = keyText(key);
    entry.keys.set(text, key);
    // The first image of a row in the transaction is the one before it: a second write sees the first's result.
    if (entry.scoped && before && !entry.before.has(text)) entry.before.set(text, boundedImage(before, key));
    if (entry.keys.size > LIVE_CHANGE_LIMITS.keys) {
      entry.many = true;
      entry.keys.clear();
      entry.before.clear();
    }
  };
  /* What an update or delete must read first, under the row's lock: the
     owner on a tenant table, and the whole row on a scoped one. */
  const readBefore = async (table: string, key: Record<string, string | number>) => {
    if (scoped(table)) return sink.read(table, key, undefined, true);
    const owner = ownerOf(table);
    return owner ? sink.read(table, key, [owner], true) : undefined;
  };
  return {
    async insert(request, write) {
      if (unheard(request.table) || !(await on())) return write(request);
      const result = await write(request);
      if (!Object.keys(result.key).length) return result;
      const owner = ownerOf(request.table);
      const row =
        owner && !(result.row && Object.hasOwn(result.row, owner)) ? await sink.read(request.table, result.key, [owner]) : result.row;
      note(request.table, 'insert', tenantOf(request.table, row), liveKey(result.key), undefined, undefined);
      return result;
    },
    async update(request, write) {
      if (unheard(request.table) || !(await on())) return write(request);
      const before = await readBefore(request.table, request.key);
      const result = await write(request);
      if (result.affected !== 1) return result;
      const columns = Object.keys(request.values);
      const tenant = tenantOf(request.table, before);
      note(request.table, 'update', tenant, liveKey(request.key), columns, before);
      // A key column the update moved names the record under its new key too.
      if (Object.keys(request.key).some((column) => Object.hasOwn(result.applied, column))) {
        const moved = Object.fromEntries(
          Object.entries(request.key).map(([column, value]) => [
            column,
            Object.hasOwn(result.applied, column) ? result.applied[column] : value,
          ]),
        );
        note(request.table, 'update', tenant, liveKey(moved), columns, undefined);
      }
      return result;
    },
    async remove(request, write) {
      if (unheard(request.table) || !(await on())) return write(request);
      const before = await readBefore(request.table, request.key);
      const result = await write(request);
      if (result.affected !== 1) return result;
      note(request.table, 'delete', tenantOf(request.table, before), liveKey(request.key), undefined, before);
      return result;
    },
    async finish() {
      if (!wrote || !building.size) return;
      const entries = bounded([...building.values()]);
      const tenants = new Set(entries.map((entry) => entry.tenant ?? null));
      await sink.append({ at: now(), actor, tenant: tenants.size === 1 ? [...tenants][0] : null, entries });
    },
    committed() {
      if (wrote) liveChangesCommitted();
    },
  };
}

function entryOf(entry: Building): LiveEntry {
  const keys = entry.many ? ('many' as const) : [...entry.keys.values()];
  const before = !entry.many && entry.scoped && entry.before.size ? [...entry.before.values()] : undefined;
  return Object.freeze({
    table: entry.table,
    kind: entry.kind,
    ...(entry.tenant ? { tenant: entry.tenant } : {}),
    keys,
    ...(entry.kind === 'update' ? { columns: [...entry.columns].sort() } : {}),
    ...(before ? { before } : {}),
  });
}

/* A pathological transaction (thousands of wide rows) says `many` for its
   widest entries rather than failing the business write. */
function bounded(building: Building[]): LiveEntry[] {
  let entries = building.map(entryOf);
  const size = () => Buffer.byteLength(JSON.stringify(entries), 'utf8');
  while (size() > LIVE_CHANGE_LIMITS.entries) {
    let widest = -1,
      width = 0;
    entries.forEach((entry, at) => {
      if (entry.keys === 'many') return;
      const bytes = Buffer.byteLength(JSON.stringify(entry), 'utf8');
      if (bytes > width) [widest, width] = [at, bytes];
    });
    if (widest === -1) throw new Refusal('This write changes too many tables to announce.');
    const { before: _before, ...rest } = entries[widest];
    entries = entries.map((entry, at) => (at === widest ? Object.freeze({ ...rest, keys: 'many' as const }) : entry));
  }
  return entries;
}

/* ---------- reading rows back ---------- */

const KINDS: ReadonlySet<string> = new Set(['insert', 'update', 'delete']);

function scalarRecord(value: unknown): Record<string, LiveScalar> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, LiveScalar> = {};
  for (const [column, item] of Object.entries(value)) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item)))
      out[column] = item;
    else return undefined;
  }
  return out;
}

/** A stored entries document read back: the store is ours, but its rows are data, so anything malformed is dropped. */
export function parseLiveEntries(text: unknown): LiveEntry[] {
  let parsed: unknown;
  try {
    parsed = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item): LiveEntry[] => {
    if (!item || typeof item !== 'object' || typeof item.table !== 'string' || !KINDS.has(item.kind)) return [];
    let keys: LiveKey[] | 'many';
    if (item.keys === 'many') keys = 'many';
    else if (Array.isArray(item.keys)) {
      keys = [];
      for (const key of item.keys) {
        const record = scalarRecord(key);
        if (!record || Object.values(record).some((value) => typeof value !== 'string' && typeof value !== 'number')) return [];
        keys.push(record as LiveKey);
      }
    } else return [];
    const columns =
      Array.isArray(item.columns) && item.columns.every((column: unknown) => typeof column === 'string') ? item.columns : undefined;
    const before = Array.isArray(item.before) ? item.before.map(scalarRecord) : undefined;
    return [
      Object.freeze({
        table: item.table,
        kind: item.kind as LiveKind,
        ...(typeof item.tenant === 'string' && item.tenant ? { tenant: item.tenant } : {}),
        keys,
        ...(columns ? { columns } : {}),
        ...(before && before.every(Boolean) ? { before: before as Record<string, LiveScalar>[] } : {}),
      }),
    ];
  });
}

/** Shared row validation for every engine's append: the store's CHECKs say the same. */
export function assertLiveChangeRow(row: LiveChangeRow): string {
  const entries = JSON.stringify(row.entries);
  if (
    !Number.isSafeInteger(row.at) ||
    typeof row.actor !== 'string' ||
    row.actor.length > LIVE_CHANGE_LIMITS.actor ||
    (row.tenant !== null && (typeof row.tenant !== 'string' || row.tenant.length > LIVE_CHANGE_LIMITS.tenant)) ||
    !Array.isArray(row.entries) ||
    !row.entries.length ||
    Buffer.byteLength(entries, 'utf8') > LIVE_CHANGE_LIMITS.entries
  )
    throw new Refusal('Invalid live change row.');
  return entries;
}

/** How many rows one read of the store returns at most. */
export const LIVE_CHANGE_PAGE = 500;
