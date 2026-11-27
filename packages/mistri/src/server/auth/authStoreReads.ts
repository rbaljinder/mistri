/**
 * What a PostgreSQL authentication store answered about a session, kept for up
 * to a minute in this process, so a signed-in request costs no round trip to
 * the store once the session has been read.
 *
 * A field report measured why that matters: a tenant App's list page made 116
 * transactions on its auth store and 71 on its own database. Every API call
 * resolved its cookie through Better Auth (the session row, then the account)
 * and then observed the session again at every fence it crossed, eleven times
 * for one query; behind a transaction-mode pooler each was three round trips,
 * and the store's four connections queued a page's sixteen parallel calls. At
 * 25 ms to the database a save took 16–25 s to settle.
 *
 * What is kept, and for how long:
 *
 * - A read is kept for `ttlMs` (MISTRI_AUTH_SESSION_CACHE, sixty seconds by
 *   default; DEFAULT_AUTH_READ_TTL_MS says why), and never past the session's
 *   own expiry. Zero keeps nothing, and every observation reads the store.
 * - Every statement this process sends the store through its pool is seen
 *   here before it leaves and when it is answered (authStore.ts), and anything
 *   but a read — a sign-out, a revoked or shortened session, a ban, a role
 *   set, an account removed — drops everything kept, the moment it is sent and
 *   again when it is answered; one in a transaction, again when that
 *   transaction ends. A read is kept only if nothing was written from the
 *   moment it was asked until it was answered. So a revocation this process
 *   made is never answered from what was kept before it, here or in another
 *   App on the same store URL in this process.
 * - A change another process makes (another instance, a maintenance command,
 *   an operator's SQL) is not seen until what was kept expires: a session
 *   revoked elsewhere is honored here for at most `ttlMs`. That is the price
 *   of the cache, and the setting's reason to exist. The workers of one
 *   `--workers` start are not another process here: each tells the others
 *   when it changes the store (processBus.ts `session.evict`), and they drop
 *   what they kept as the one that made the change does.
 * - Reads asked together while one is in flight share it, so a burst that
 *   arrives cold reads once.
 *
 * Keys are the store's own (a session's id; the digest of the cookies and the
 * header a request presents), one map per store handle, so nothing is shared
 * across Apps but the knowledge that the store changed.
 */
import { createHash } from 'node:crypto';
import { statementHead } from '@mistriwork/engine/adapters/postgresPooler.js';
import { publish, subscribe } from '../processBus.js';

/**
 * Sixty seconds, the maintainer's call. Everything this process does to a
 * session (a sign-out, a revocation, a password change, a ban) drops what is
 * kept at once, so the window only bounds what another instance or a
 * maintenance command did: a session revoked there is honored here for up to
 * a minute. A person working a page asks again every few seconds, and at five
 * seconds most of those asks read the store; at sixty, one read covers a
 * stretch of work. Membership, roles and the tenant are never kept here: they
 * are read fresh with every request. The file store keeps nothing: it is read
 * in place, with no round trip to save.
 */
export const DEFAULT_AUTH_READ_TTL_MS = 60_000;
const MAX_TTL_S = 60;
/** Enough for every session a busy instance sees in a minute; the oldest goes first past it. */
const MAX_ENTRIES = 10_000;

/** MISTRI_AUTH_SESSION_CACHE in seconds, 0 to 60, as milliseconds; the default where it is unset. */
export function authReadTtlMs(environment: NodeJS.ProcessEnv = process.env): number {
  const raw = environment.MISTRI_AUTH_SESSION_CACHE?.trim();
  if (!raw) return DEFAULT_AUTH_READ_TTL_MS;
  const seconds = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(seconds >= 0 && seconds <= MAX_TTL_S))
    throw new RangeError(`MISTRI_AUTH_SESSION_CACHE takes seconds from 0 to ${MAX_TTL_S}; "${raw}" is not one.`);
  return Math.round(seconds * 1000);
}

/** When a read was asked: what it may be kept under. */
type ReadMark = Readonly<{ epoch: number; untaggedEpoch: number; seq: number; at: number }>;

/** Identity tags for a cached positive session read, enabling targeted eviction. */
type AuthSessionTags = Readonly<{ sessionId?: string; userId?: string; token?: string }>;

export interface AuthStoreReads {
  readonly ttlMs: number;
  /**
   * `load`'s answer for `key`: one kept from a read asked since the store last
   * changed in this process and less than `ttlMs` ago, one in flight, or a
   * fresh one. `keep` says whether an answer may be kept (a signed-out answer
   * is not); `usable` is asked of a kept one before it is given (a session
   * that has since expired is read again). Callers must not change what they
   * are given: it is everyone's.
   */
  read<T>(
    key: string,
    load: (mark: ReadMark) => Promise<T>,
    options?: {
      keep?: (value: T) => boolean;
      usable?: (value: T) => boolean;
      tags?: AuthSessionTags | ((value: T) => AuthSessionTags | undefined);
    },
  ): Promise<T>;
  /** Keep `value` for `key` as a read asked at `mark` would be: only if the store has not changed since. */
  prime(key: string, value: unknown, mark: ReadMark, tags?: AuthSessionTags): void;
  /** The pool's client is about to send `text`; what it returns is called once it is answered. */
  statement(client: object, text: string | undefined, params?: readonly unknown[]): () => void;
  /** The client's connection ended: a transaction it held open with a write in it is over. */
  ended(client: object): void;
}

const MAX_TAG_SEQ = MAX_ENTRIES * 4;

interface StoreEpoch {
  value: number;
  untagged: number;
  seq: number;
  tagSeq: Map<string, number>;
}

/* The store's epoch, shared by every handle on the same URL in this process:
   one App's sign-out drops what another kept of the same rows. */
const epochs = new Map<string, StoreEpoch>();

/* The same epochs by a digest of the URL, as the process bus names a store: the URL carries credentials. A worker
   that hears another changed a store moves its epoch (or targeted tag) on. */
const byDigest = new Map<string, StoreEpoch>();
const storeKey = (store: string) => createHash('sha256').update(store).digest('base64url').slice(0, 22);

function bumpGlobal(state: StoreEpoch): void {
  state.value += 1;
  state.untagged += 1;
  state.seq += 1;
  state.tagSeq.clear();
}

function bumpTag(state: StoreEpoch, tag: string): void {
  if (state.tagSeq.size >= MAX_TAG_SEQ && !state.tagSeq.has(tag)) {
    bumpGlobal(state);
    return;
  }
  state.untagged += 1;
  state.seq += 1;
  state.tagSeq.set(tag, state.seq);
}

let listening = false;
function listen(): void {
  if (listening) return;
  listening = true;
  subscribe('session.evict', (payload) => {
    const said = payload as { store?: unknown; from?: unknown; tag?: unknown } | undefined;
    const state = said?.from !== process.pid && typeof said?.store === 'string' ? byDigest.get(said.store) : undefined;
    if (!state) return;
    if (typeof said?.tag === 'string' && said.tag.length > 0) bumpTag(state, said.tag);
    else bumpGlobal(state);
  });
}

const READ = /^SELECT\b/i;
const BEGINS = /^(?:BEGIN|START\s+TRANSACTION)\b/i;
/** As postgresPooler.ts reads a transaction's end: not ROLLBACK TO a savepoint, and not the PREPARED forms. */
const ENDS = /^(?:COMMIT|END|ABORT|ROLLBACK)\b(?!\s+(?:(?:WORK|TRANSACTION)\s+)?(?:TO|PREPARED)\b)/i;
/** Change nothing a session read sees. */
const NEUTRAL = /^(?:SAVEPOINT|RELEASE|ROLLBACK\s+(?:(?:WORK|TRANSACTION)\s+)?TO|SET|RESET|SHOW)\b/i;
/** Pure single-table INSERT into Better Auth tables (no ON CONFLICT DO UPDATE): never alters existing positive sessions. */
const PURE_INSERT =
  /^INSERT\s+INTO\s+(?:"?mistri"?\.)?"?(?:auth_session|auth_user|auth_account|auth_verification)"?\s*(?:\([^)]*\)\s*)?VALUES\s*\(/i;
/** Writes to auth_verification (OTP/magic-link tokens) never alter existing sessions or users. */
const VERIFICATION_WRITE = /^(?:DELETE\s+FROM|UPDATE)\s+(?:"?mistri"?\.)?"?auth_verification"?\b/i;
/** Single-table UPDATE or DELETE on auth_session or auth_user with a simple WHERE clause. */
const TARGETED_MUTATION =
  /^(?:DELETE\s+FROM|UPDATE)\s+(?:"?mistri"?\.)?"?(auth_session|auth_user)"?\s+(?:SET\s+[\s\S]+?\s+)?WHERE\s+([\s\S]+?)(?:\s+RETURNING\b[\s\S]*)?$/i;
const CONJUNCT_EQ = /^\(*\s*(?:"?(?:auth_session|auth_user|s|u)"?\.)?"?(id|userId|token)"?\s*=\s*\$(\d+)\s*\)*$/i;

type WriteClassification = { kind: 'insert' } | { kind: 'target'; tag: string } | { kind: 'global' };

function classifyWrite(statement: string, params: readonly unknown[] | undefined): WriteClassification {
  if (PURE_INSERT.test(statement) && !/\bDO\s+UPDATE\b/i.test(statement)) return { kind: 'insert' };
  if (VERIFICATION_WRITE.test(statement)) return { kind: 'insert' };
  if (statement.includes("'")) return { kind: 'global' };
  const match = TARGETED_MUTATION.exec(statement);
  if (!match || !params?.length) return { kind: 'global' };
  const table = match[1]!.toLowerCase();
  const where = match[2]!.trim();
  if (/\b(?:OR|NOT|SELECT|WHERE|IN)\b/i.test(where)) return { kind: 'global' };
  for (const part of where.split(/\s+AND\s+/i)) {
    const eq = CONJUNCT_EQ.exec(part.trim());
    if (!eq) continue;
    const column = eq[1]!;
    const idx = Number(eq[2]!) - 1;
    const value = idx >= 0 && idx < params.length ? params[idx] : undefined;
    if (typeof value !== 'string' || !value.length) continue;
    if (table === 'auth_session') {
      if (column.toLowerCase() === 'id') return { kind: 'target', tag: `s:${value}` };
      if (column === 'userId' || column.toLowerCase() === 'userid') return { kind: 'target', tag: `u:${value}` };
      if (column.toLowerCase() === 'token') return { kind: 'target', tag: `t:${value}` };
    } else if (table === 'auth_user' && column.toLowerCase() === 'id') {
      return { kind: 'target', tag: `u:${value}` };
    }
  }
  return { kind: 'global' };
}

function encodeTags(tags: AuthSessionTags | undefined): readonly string[] {
  if (!tags) return [];
  const list: string[] = [];
  if (typeof tags.sessionId === 'string' && tags.sessionId.length) list.push(`s:${tags.sessionId}`);
  if (typeof tags.userId === 'string' && tags.userId.length) list.push(`u:${tags.userId}`);
  if (typeof tags.token === 'string' && tags.token.length) list.push(`t:${tags.token}`);
  return list;
}

export function createAuthStoreReads(store: string, ttlMs: number, clock: () => number = Date.now): AuthStoreReads {
  const digest = storeKey(store);
  let epoch = epochs.get(store);
  if (!epoch) {
    epochs.set(store, (epoch = { value: 0, untagged: 0, seq: 0, tagSeq: new Map() }));
    byDigest.set(digest, epoch);
  }
  listen();
  const shared = epoch;
  const entries = new Map<
    string,
    { value: unknown; epoch: number; untaggedEpoch: number; seq: number; at: number; tags: readonly string[] }
  >();
  const flights = new Map<string, { epoch: number; untaggedEpoch: number; seq: number; promise: Promise<unknown> }>();

  const changed = () => {
    bumpGlobal(shared);
    entries.clear();
    publish('session.evict', { store: digest, from: process.pid });
  };

  const dropUntagged = () => {
    shared.untagged += 1;
    for (const [key, kept] of entries) if (!kept.tags.length) entries.delete(key);
  };

  const evictTag = (tag: string) => {
    const before = shared.value;
    bumpTag(shared, tag);
    if (shared.value !== before) {
      entries.clear();
      publish('session.evict', { store: digest, from: process.pid });
      return;
    }
    for (const [key, kept] of entries) {
      if (!kept.tags.length || kept.tags.includes(tag)) entries.delete(key);
    }
    publish('session.evict', { store: digest, from: process.pid, tag });
  };

  const tagsFresh = (tags: readonly string[], seq: number, untaggedEpoch: number): boolean => {
    if (!tags.length) return shared.untagged === untaggedEpoch;
    for (const tag of tags) if ((shared.tagSeq.get(tag) ?? 0) > seq) return false;
    return true;
  };

  const put = (key: string, value: unknown, mark: ReadMark, rawTags?: AuthSessionTags) => {
    if (ttlMs <= 0 || shared.value !== mark.epoch || clock() - mark.at >= ttlMs) return;
    const tags = encodeTags(rawTags);
    if (!tagsFresh(tags, mark.seq, mark.untaggedEpoch)) return;
    entries.delete(key);
    if (entries.size >= MAX_ENTRIES) {
      const now = clock();
      for (const [name, kept] of entries) {
        if (now - kept.at >= ttlMs || kept.epoch !== shared.value || !tagsFresh(kept.tags, kept.seq, kept.untaggedEpoch))
          entries.delete(name);
      }
      if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value!);
    }
    entries.set(key, { value, epoch: mark.epoch, untaggedEpoch: mark.untaggedEpoch, seq: mark.seq, at: mark.at, tags });
  };

  /* Per client: inside a transaction, and what write scope it touched. */
  const open = new WeakMap<object, { scope: 'none' | 'insert' | 'targeted' | 'global'; targets: Set<string> }>();
  const flushTx = (state: { scope: 'none' | 'insert' | 'targeted' | 'global'; targets: Set<string> }) => {
    if (state.scope === 'global') changed();
    else if (state.scope === 'targeted') for (const tag of state.targets) evictTag(tag);
    else if (state.scope === 'insert') dropUntagged();
  };

  return {
    ttlMs,
    read<T>(
      key: string,
      load: (mark: ReadMark) => Promise<T>,
      options: {
        keep?: (value: T) => boolean;
        usable?: (value: T) => boolean;
        tags?: AuthSessionTags | ((value: T) => AuthSessionTags | undefined);
      } = {},
    ): Promise<T> {
      const now = clock();
      const kept = entries.get(key);
      if (kept) {
        if (
          kept.epoch === shared.value &&
          now - kept.at < ttlMs &&
          tagsFresh(kept.tags, kept.seq, kept.untaggedEpoch) &&
          (options.usable?.(kept.value as T) ?? true)
        )
          return Promise.resolve(kept.value as T);
        entries.delete(key);
      }
      const mark: ReadMark = { epoch: shared.value, untaggedEpoch: shared.untagged, seq: shared.seq, at: now };
      // Nothing kept means nothing shared: each observation is its own read.
      if (ttlMs <= 0) return load(mark);
      const tagged = options.tags !== undefined;
      const flying = flights.get(key);
      if (flying && flying.epoch === shared.value && flying.seq === shared.seq && (tagged || flying.untaggedEpoch === shared.untagged))
        return flying.promise as Promise<T>;
      const promise = load(mark).then((value) => {
        if (options.keep?.(value) ?? true) {
          const resolved = typeof options.tags === 'function' ? options.tags(value) : options.tags;
          put(key, value, mark, resolved);
        }
        return value;
      });
      const flight = { epoch: mark.epoch, untaggedEpoch: mark.untaggedEpoch, seq: mark.seq, promise };
      flights.set(key, flight);
      const land = () => {
        if (flights.get(key) === flight) flights.delete(key);
      };
      promise.then(land, land);
      return promise;
    },
    prime: (key, value, mark, tags) => put(key, value, mark, tags),
    statement(client, text, params) {
      const state = open.get(client);
      const statement = text === undefined ? undefined : statementHead(text).trim().replace(/;\s*$/, '');
      // One statement, recognizably: anything else (several at once, none to read) is taken for a write.
      const single = statement !== undefined && !statement.includes(';');
      if (single && BEGINS.test(statement)) {
        open.set(client, { scope: 'none', targets: new Set() });
        return () => {};
      }
      if (single && ENDS.test(statement)) {
        open.delete(client);
        if (!state || state.scope === 'none') return () => {};
        flushTx(state);
        return () => flushTx(state);
      }
      if (single && (READ.test(statement) || NEUTRAL.test(statement))) return () => {};
      // Several settings at once (a session's setup as its connection opens) change no row either.
      if (statement?.split(';').every((part) => NEUTRAL.test(statementHead(part)))) return () => {};
      if (single) {
        const classified = classifyWrite(statement, params);
        if (classified.kind === 'insert') {
          if (state && state.scope === 'none') state.scope = 'insert';
          dropUntagged();
          return dropUntagged;
        }
        if (classified.kind === 'target') {
          if (state && state.scope !== 'global') {
            state.scope = 'targeted';
            state.targets.add(classified.tag);
          }
          evictTag(classified.tag);
          return () => evictTag(classified.tag);
        }
      }
      if (statement !== undefined && BEGINS.test(statement)) open.set(client, { scope: 'global', targets: new Set() });
      else if (statement !== undefined && ENDS.test(statement)) open.delete(client);
      else if (state) state.scope = 'global';
      changed();
      return changed;
    },
    ended(client) {
      const state = open.get(client);
      open.delete(client);
      if (state && state.scope !== 'none') flushTx(state);
    },
  };
}
