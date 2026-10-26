/**
 * A cache that is never wrong, because it is never trusted on its own.
 *
 * Every entry is kept under the version of the thing it was derived from —
 * the catalog's epoch (postgresSchemaEpoch.ts, SQLite's `schema_version`),
 * an App's version, a role set — and is served only to a caller that holds
 * the current version, read cheaply inside the transaction that will use the
 * entry. An entry under any other version is a miss, never an answer: a
 * stale cache is only a slower one. So nothing here expires by time, and
 * nothing needs invalidating; a new version simply stops matching.
 *
 * The version is read BEFORE what is derived from it, never after: a change
 * committing between the two leaves an entry filed under a version no later
 * read can match, so it is derived again rather than trusted on a version it
 * postdates.
 *
 * Generic on purpose: the catalog caches here, the command metadata in the
 * journal and the plans compiled per (App, roles, epoch) all keep their
 * entries through one of these, and so can a composed read that wants to.
 */
export class EpochCache<V> {
  private readonly entries = new Map<string, { version: string; value: V }>();
  private counts = { hits: 0, misses: 0 };

  /** At most `max` keys; the least recently set goes first. Bounded, because a key can carry a caller's role set. */
  constructor(private readonly max = 512) {}

  /** The value kept for `key` under exactly `version`; anything else is a miss. */
  get(version: string | undefined, key: string): V | undefined {
    if (version === undefined) {
      this.counts.misses++;
      return undefined;
    }
    const entry = this.entries.get(key);
    if (entry?.version === version) {
      this.counts.hits++;
      return entry.value;
    }
    this.counts.misses++;
    return undefined;
  }

  /** What is kept for `key`, whatever its version: for work that must happen before the version is read (a lock). Never an answer. */
  peek(key: string): { version: string; value: V } | undefined {
    return this.entries.get(key);
  }

  /** Keep `value` under `version`, the one read before `value` was derived. Returns the value. */
  set<T extends V>(version: string | undefined, key: string, value: T): T {
    if (version === undefined) return value;
    this.entries.delete(key);
    this.entries.set(key, { version, value });
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
    return value;
  }

  /** Read through: the kept value under `version`, or `derive()` kept under it. */
  async through<T extends V>(version: string | undefined, key: string, derive: () => Promise<T>): Promise<T> {
    const kept = this.get(version, key) as T | undefined;
    if (kept !== undefined) return kept;
    return this.set(version, key, await derive());
  }

  /** Synchronous read through, for SQLite. */
  throughSync<T extends V>(version: string | undefined, key: string, derive: () => T): T {
    const kept = this.get(version, key) as T | undefined;
    if (kept !== undefined) return kept;
    return this.set(version, key, derive());
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  /** Hits and misses since the process started, for the operator and the budget tests. */
  stats(): Readonly<{ hits: number; misses: number; size: number }> {
    return { ...this.counts, size: this.entries.size };
  }
}
