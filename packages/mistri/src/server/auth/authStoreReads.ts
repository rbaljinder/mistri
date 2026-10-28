/**
 * What a PostgreSQL authentication store answered about a session, kept for a
 * few seconds in this process, so a signed-in request costs no round trip to
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
 * - A read is kept for `ttlMs` (MISTRI_AUTH_SESSION_CACHE, five seconds by
 *   default): a page's burst and the reads that follow a save land well inside
 *   it, so they cost one read between them; and it is short beside anything a
 *   person does after signing out somewhere else. Zero keeps nothing, and
 *   every observation reads the store, as before.
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
 *   of the cache, and the setting's reason to exist.
 * - Reads asked together while one is in flight share it, so a burst that
 *   arrives cold reads once.
 *
 * Keys are the store's own (a session's id; the digest of the cookies and the
 * header a request presents), one map per store handle, so nothing is shared
 * across Apps but the knowledge that the store changed.
 */
import { statementHead } from '@mistriwork/engine/adapters/postgresPooler.js';

/** Five seconds: see the header. */
export const DEFAULT_AUTH_READ_TTL_MS = 5_000;
const MAX_TTL_S = 60;
/** Enough for every session a busy instance sees in a few seconds; the oldest goes first past it. */
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
type ReadMark = Readonly<{ epoch: number; at: number }>;

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
    options?: { keep?: (value: T) => boolean; usable?: (value: T) => boolean },
  ): Promise<T>;
  /** Keep `value` for `key` as a read asked at `mark` would be: only if the store has not changed since. */
  prime(key: string, value: unknown, mark: ReadMark): void;
  /** The pool's client is about to send `text`; what it returns is called once it is answered. */
  statement(client: object, text: string | undefined): () => void;
  /** The client's connection ended: a transaction it held open with a write in it is over. */
  ended(client: object): void;
}

/* The store's epoch, shared by every handle on the same URL in this process:
   one App's sign-out drops what another kept of the same rows. */
const epochs = new Map<string, { value: number }>();

const READ = /^SELECT\b/i;
const BEGINS = /^(?:BEGIN|START\s+TRANSACTION)\b/i;
/** As postgresPooler.ts reads a transaction's end: not ROLLBACK TO a savepoint, and not the PREPARED forms. */
const ENDS = /^(?:COMMIT|END|ABORT|ROLLBACK)\b(?!\s+(?:(?:WORK|TRANSACTION)\s+)?(?:TO|PREPARED)\b)/i;
/** Change nothing a session read sees. */
const NEUTRAL = /^(?:SAVEPOINT|RELEASE|ROLLBACK\s+(?:(?:WORK|TRANSACTION)\s+)?TO|SET|RESET|SHOW)\b/i;

export function createAuthStoreReads(store: string, ttlMs: number, clock: () => number = Date.now): AuthStoreReads {
  let epoch = epochs.get(store);
  if (!epoch) epochs.set(store, (epoch = { value: 0 }));
  const shared = epoch;
  const entries = new Map<string, { value: unknown; epoch: number; at: number }>();
  const flights = new Map<string, { epoch: number; promise: Promise<unknown> }>();
  const changed = () => {
    shared.value += 1;
    entries.clear();
  };
  const put = (key: string, value: unknown, mark: ReadMark) => {
    if (ttlMs <= 0 || shared.value !== mark.epoch || clock() - mark.at >= ttlMs) return;
    entries.delete(key);
    if (entries.size >= MAX_ENTRIES) {
      const now = clock();
      for (const [name, kept] of entries) if (now - kept.at >= ttlMs) entries.delete(name);
      if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value!);
    }
    entries.set(key, { value, epoch: mark.epoch, at: mark.at });
  };
  /* Per client: inside a transaction, and whether it has written yet. */
  const open = new WeakMap<object, { dirty: boolean }>();

  return {
    ttlMs,
    read<T>(
      key: string,
      load: (mark: ReadMark) => Promise<T>,
      options: { keep?: (value: T) => boolean; usable?: (value: T) => boolean } = {},
    ): Promise<T> {
      const now = clock();
      const kept = entries.get(key);
      if (kept) {
        if (kept.epoch === shared.value && now - kept.at < ttlMs && (options.usable?.(kept.value as T) ?? true))
          return Promise.resolve(kept.value as T);
        entries.delete(key);
      }
      const mark = { epoch: shared.value, at: now };
      // Nothing kept means nothing shared: each observation is its own read.
      if (ttlMs <= 0) return load(mark);
      const flying = flights.get(key);
      if (flying && flying.epoch === shared.value) return flying.promise as Promise<T>;
      const promise = load(mark).then((value) => {
        if (options.keep?.(value) ?? true) put(key, value, mark);
        return value;
      });
      const flight = { epoch: mark.epoch, promise };
      flights.set(key, flight);
      const land = () => {
        if (flights.get(key) === flight) flights.delete(key);
      };
      promise.then(land, land);
      return promise;
    },
    prime: (key, value, mark) => put(key, value, mark),
    statement(client, text) {
      const state = open.get(client);
      const statement = text === undefined ? undefined : statementHead(text).trim().replace(/;\s*$/, '');
      // One statement, recognizably: anything else (several at once, none to read) is taken for a write.
      const single = statement !== undefined && !statement.includes(';');
      if (single && BEGINS.test(statement)) {
        open.set(client, { dirty: false });
        return () => {};
      }
      if (single && ENDS.test(statement)) {
        open.delete(client);
        if (!state?.dirty) return () => {};
        changed();
        return changed;
      }
      if (single && (READ.test(statement) || NEUTRAL.test(statement))) return () => {};
      // Several settings at once (a session's setup as its connection opens) change no row either.
      if (statement?.split(';').every((part) => NEUTRAL.test(statementHead(part)))) return () => {};
      if (statement !== undefined && BEGINS.test(statement)) open.set(client, { dirty: true });
      else if (statement !== undefined && ENDS.test(statement)) open.delete(client);
      else if (state) state.dirty = true;
      changed();
      return changed;
    },
    ended(client) {
      const state = open.get(client);
      open.delete(client);
      if (state?.dirty) changed();
    },
  };
}
