/**
 * The rate limits and sign-in lockouts a `--workers` start counts once (workers.ts): the public forms' budgets, Better
 * Auth's request budget and the lockouts in auth/signInState.ts. Without a cache service each process counts its own,
 * which across n workers of one start would give a visitor n times the budget and n times the guesses. So the primary,
 * which serves no request and outlives its workers, holds the counts, and a worker reaches them as a cache store over
 * the process bus (`ask`), as instances reach a Valkey the config names. With a cache service none of this is used: the
 * service already counts for every process, and every replica.
 *
 * What a worker does when its primary does not answer in time is each caller's: the public forms' budgets go on in
 * the worker's own count (open), and a lockout check is failed closed (auth/signInState.ts says why).
 */
import { CacheUnavailable, MemoryCacheStore, type CacheStore } from '@mistriwork/engine/adapters/cache/cacheStore.js';
import { ask, NoAnswer } from '../processBus.js';

/** The one question these counters answer; the bus's other questions are their own. */
export const COUNTERS_OP = 'counters';

/* The primary answers from memory in well under a millisecond: a second without an answer is a primary that is stuck
   (or stopping), and a request is not held longer than that on it. */
const ASK_MS = 1_000;

/**
 * Apart, as signInState keeps them apart in one process: a flood of public-form clients or of unauthenticated OAuth
 * requests can push out only its own oldest entries, never a sign-in lock or its counters.
 */
type CounterBucket = 'forms' | 'signin' | 'pending';
const SIZES: Record<CounterBucket, number> = { forms: 50_000, signin: 50_000, pending: 10_000 };
const METHODS = new Set(['get', 'set', 'delete', 'incr']);

let held: Record<CounterBucket, MemoryCacheStore> | undefined;

/** In the primary: answers a worker's `counters` question from the primary's own stores. */
export function answerCounters(op: string, args: unknown[]): unknown {
  if (op !== COUNTERS_OP) throw new Error(`The primary has no answer to ${op}.`);
  const [bucket, method, key, ...rest] = args;
  if (typeof bucket !== 'string' || !(bucket in SIZES) || typeof method !== 'string' || !METHODS.has(method) || typeof key !== 'string')
    throw new Error('The primary was asked a counter it does not keep.');
  held ??= {
    forms: new MemoryCacheStore(SIZES.forms),
    signin: new MemoryCacheStore(SIZES.signin),
    pending: new MemoryCacheStore(SIZES.pending),
  };
  const store = held[bucket as CounterBucket];
  if (method === 'get') return store.get(key);
  if (method === 'delete') return store.delete(key);
  if (method === 'set') return store.set(key, String(rest[0]), Number(rest[1]));
  return store.incr(key, Number(rest[0]), rest[1] === undefined || rest[1] === null ? undefined : Number(rest[1]));
}

/** In the primary: forgets every count; tests use it. */
export function resetPrimaryCounters(): void {
  held = undefined;
}

/**
 * In a worker: the counters of `bucket` its primary keeps. Every method throws CacheUnavailable when the primary does
 * not answer within ASK_MS, reads included, so a caller can tell "no count" from "no answer".
 */
export function primaryCounters(bucket: CounterBucket, asking: typeof ask = ask): CacheStore {
  const question = async (method: string, ...args: unknown[]): Promise<unknown> => {
    try {
      return await asking(COUNTERS_OP, [bucket, method, ...args], ASK_MS);
    } catch (error) {
      if (error instanceof NoAnswer) throw new CacheUnavailable(error.message);
      throw error;
    }
  };
  return {
    kind: 'primary',
    get: async (key) => {
      const value = await question('get', key);
      return typeof value === 'string' ? value : undefined;
    },
    set: async (key, value, ttlMs) => {
      await question('set', key, value, ttlMs);
    },
    delete: async (key) => {
      await question('delete', key);
    },
    incr: async (key, ttlMs, by) => {
      const counted = (await question('incr', key, ttlMs, by)) as { count?: unknown; ttlMs?: unknown } | undefined;
      if (typeof counted?.count !== 'number' || typeof counted.ttlMs !== 'number')
        throw new CacheUnavailable('The primary answered a count with none.');
      return { count: counted.count, ttlMs: counted.ttlMs };
    },
    // The counts are the primary's, kept for as long as the start runs; a worker has nothing of its own to close.
    close: async () => {},
  };
}
