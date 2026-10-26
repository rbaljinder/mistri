/**
 * Somewhere to keep a value for a while: in this process by default, in a
 * Valkey cache when the config names one, so every instance of a deployment
 * shares it.
 *
 * Never a source of truth. Everything here is a copy or a count that is
 * allowed to vanish — a cached API answer, a rate-limit window — so every
 * write carries a time to live (there is no "forever"), a read that cannot
 * reach the cache is a miss, and a write that cannot is dropped. The one
 * caller that must know the difference, the rate limiter, is told through
 * `incr`, which throws `CacheUnavailable` rather than inventing a count.
 */
import { CacheUnavailable, RespReplyError, type RespClient } from './resp.js';

export { CacheUnavailable } from './resp.js';

export interface CacheStore {
  readonly kind: 'memory' | 'valkey';
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * Count one under `key`. A new key starts a window of `ttlMs`; the answer is
   * the count within it and the milliseconds it has left. Throws
   * CacheUnavailable when the count cannot be kept.
   */
  incr(key: string, ttlMs: number): Promise<{ count: number; ttlMs: number }>;
  close(): Promise<void>;
}

/* Thirty days: a copy kept longer than that is a copy nobody meant to keep. */
const MAX_TTL_MS = 30 * 24 * 3_600_000;

function assertTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS) {
    throw new Error(`A cached value needs a time to live between 1 ms and 30 days; ${ttlMs} is not one.`);
  }
}

/**
 * The process's own cache: a Map in least-recently-used order, bounded, so a
 * stream of distinct keys (an API's pages, a flood of client addresses) cannot
 * grow it without end. Expiry is read, not scheduled: no timers to clean up.
 */
export class MemoryCacheStore implements CacheStore {
  readonly kind = 'memory' as const;
  private readonly entries = new Map<string, { value: string; expires: number }>();

  constructor(
    private readonly maxEntries = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  async get(key: string): Promise<string | undefined> {
    const entry = this.live(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    assertTtl(ttlMs);
    this.entries.delete(key);
    this.entries.set(key, { value, expires: this.now() + ttlMs });
    this.trim();
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async incr(key: string, ttlMs: number): Promise<{ count: number; ttlMs: number }> {
    assertTtl(ttlMs);
    const entry = this.live(key);
    const now = this.now();
    const next = entry ? { value: String(Number(entry.value) + 1), expires: entry.expires } : { value: '1', expires: now + ttlMs };
    this.entries.delete(key);
    this.entries.set(key, next);
    this.trim();
    return { count: Number(next.value), ttlMs: next.expires - now };
  }

  async close(): Promise<void> {
    this.entries.clear();
  }

  /** How many entries are held; tests read it. */
  get size(): number {
    return this.entries.size;
  }

  private live(key: string) {
    const entry = this.entries.get(key);
    if (entry && entry.expires <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  private trim(): void {
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }
}

/* One round trip, and atomic: a window that is counted is a window that
   expires, even if this process stops between the two steps. */
const COUNT_IN_WINDOW = `local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local t = redis.call('PTTL', KEYS[1])
if t < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) t = tonumber(ARGV[1]) end
return {n, t}`;

/**
 * A Valkey cache shared by every instance. `onUnavailable` hears each
 * outage's reason — the server logs it once — while reads carry on as misses.
 */
export class ValkeyCacheStore implements CacheStore {
  readonly kind = 'valkey' as const;

  constructor(
    private readonly client: RespClient,
    private readonly onUnavailable: (message: string) => void = () => {},
  ) {}

  async get(key: string): Promise<string | undefined> {
    try {
      const value = await this.client.command('GET', key);
      return typeof value === 'string' ? value : undefined;
    } catch (error) {
      this.unavailable(error);
      return undefined;
    }
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    assertTtl(ttlMs);
    try {
      await this.client.command('SET', key, value, 'PX', ttlMs);
    } catch (error) {
      this.unavailable(error);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.command('DEL', key);
    } catch (error) {
      this.unavailable(error);
    }
  }

  async incr(key: string, ttlMs: number): Promise<{ count: number; ttlMs: number }> {
    assertTtl(ttlMs);
    let reply;
    try {
      reply = await this.client.command('EVAL', COUNT_IN_WINDOW, 1, key, ttlMs);
    } catch (error) {
      this.unavailable(error);
      throw error instanceof CacheUnavailable ? error : new CacheUnavailable('the cache refused a count.');
    }
    if (!Array.isArray(reply) || typeof reply[0] !== 'number' || typeof reply[1] !== 'number')
      throw new CacheUnavailable('the cache answered a count in an unexpected shape.');
    return { count: reply[0], ttlMs: reply[1] };
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private unavailable(error: unknown): void {
    this.onUnavailable(error instanceof CacheUnavailable || error instanceof RespReplyError ? error.message : 'the cache failed.');
  }
}

/** The same store under a key prefix: `tw:<app>:http:<connection>:`, say. */
export function scopedCache(store: CacheStore, prefix: string): CacheStore {
  return {
    kind: store.kind,
    get: (key) => store.get(prefix + key),
    set: (key, value, ttlMs) => store.set(prefix + key, value, ttlMs),
    delete: (key) => store.delete(prefix + key),
    incr: (key, ttlMs) => store.incr(prefix + key, ttlMs),
    close: () => store.close(),
  };
}
