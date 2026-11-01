/**
 * Sign-in state that every instance of a deployment must agree on: a status
 * check's lockouts (forms/statusCheck.ts), a status step-up's sessions
 * (forms/statusStepUp.ts) and an identity provider's step-up evidence
 * (identityRoles.ts), and Better Auth's own request budget. Kept as the public forms' budgets are kept
 * (http/rateLimit.ts): with a cache named in the config — the same switch —
 * in it, under the deployment's namespace, so a lockout earned on one
 * instance holds on the next and a step-up proved on one opens on another;
 * without one, in this process. Every entry expires.
 *
 * A cache that stops answering is read as this process's own store until it
 * answers again, as the budgets fall back to theirs: the state an outage
 * strands is at most one window's, and nothing is opened that was not proved.
 */
import { CacheUnavailable, MemoryCacheStore, scopedCache, type CacheStore } from '@mistriwork/engine/adapters/cache/cacheStore.js';

let local = new MemoryCacheStore(50_000);
/** The OAuth server's pending requests and consent nonces, apart from the lockouts and request budgets in `local`: the
    memory store drops its oldest entries when full, so a flood of unauthenticated authorize requests must only be able to
    push out other pending requests, never a sign-in lock or a counter. */
let pending = new MemoryCacheStore(10_000);
const PENDING_KINDS = new Set(['oauth-request', 'oauth-consent']);
let shared: CacheStore | undefined;

/** Keep sign-in state in `cache` (a Valkey the config names) under `namespace`; `undefined` or a memory cache keeps it here. */
export function configureSignInState(cache: CacheStore | undefined, namespace: string): void {
  shared = !cache || cache.kind === 'memory' ? undefined : scopedCache(cache, `tw:${namespace}:signin:`);
}

/** Forget everything this process holds: tests use it. A configured cache is kept; `configureSignInState(undefined, …)` lets it go. */
export function resetSignInState(): void {
  local = new MemoryCacheStore(50_000);
  pending = new MemoryCacheStore(10_000);
}

async function on<T>(work: (store: CacheStore) => Promise<T>, kind?: string): Promise<T> {
  if (shared) {
    try {
      return await work(shared);
    } catch (error) {
      if (!(error instanceof CacheUnavailable)) throw error;
    }
  }
  return work(kind !== undefined && PENDING_KINDS.has(kind) ? pending : local);
}

/** Bounded so a crafted key cannot make an entry outlive the cache's own ceiling. */
const ttl = (ms: number) => Math.max(1, Math.min(Math.ceil(ms), 30 * 24 * 3_600_000));

export const signInState = {
  /** The failures counted under `key` in its current window. */
  failures: (key: string): Promise<number> =>
    on(async (store) => {
      const value = Number(await store.get(`fail:${key}`));
      return Number.isSafeInteger(value) && value > 0 ? value : 0;
    }),
  /** Count one more failure; the window starts at the first and lasts `windowMs`. */
  fail: (key: string, windowMs: number): Promise<number> => on(async (store) => (await store.incr(`fail:${key}`, ttl(windowMs))).count),
  clearFailures: (key: string): Promise<void> => on((store) => store.delete(`fail:${key}`)),
  /** Better Auth's own request budget (its `rateLimit.customStorage`): one
      more request under `key` in a fixed window of `windowSeconds`, allowed
      while the count is within `max`. Kept here so instances behind one load
      balancer spend one budget, as a lockout is honoured by each; Better
      Auth's default keeps it in each process's memory. */
  consume: (key: string, rule: { window: number; max: number }): Promise<{ allowed: boolean; retryAfter: number | null }> =>
    on(async (store) => {
      const counted = await store.incr(`limit:${key}`, ttl(rule.window * 1000));
      return counted.count <= rule.max
        ? { allowed: true, retryAfter: null }
        : { allowed: false, retryAfter: Math.max(1, Math.ceil(counted.ttlMs / 1000)) };
    }),
  /** A JSON record that lives until `until` (epoch ms). */
  put: (kind: string, key: string, value: unknown, until: number, now = Date.now()): Promise<void> =>
    until <= now ? Promise.resolve() : on((store) => store.set(`${kind}:${key}`, JSON.stringify(value), ttl(until - now)), kind),
  read: async <T>(kind: string, key: string): Promise<T | undefined> => {
    const text = await on((store) => store.get(`${kind}:${key}`), kind);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text) as T;
    } catch {
      return undefined;
    }
  },
  remove: (kind: string, key: string): Promise<void> => on((store) => store.delete(`${kind}:${key}`), kind),
};
