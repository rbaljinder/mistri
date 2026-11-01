/**
 * What a sitemap answer is kept as, and for how long (sitemap.ts). The route is public and costs a keyset read per
 * record route per request (an index walks up to a hundred of them), so a crawler, or anyone with a loop, would turn
 * one cheap request into minutes of database time. An answer is kept per App, per origin and per part for a few
 * minutes — a crawler reads a sitemap at most daily, and a record is public when the page says so, not within the
 * minute — and concurrent requests for an answer being built share it. Only a built answer is kept: a refusal or
 * a failure is built again by the next request. Bounded, so addresses a caller makes up cannot fill it.
 */
export function shortLived<T extends string | null | undefined>(options: {
  /** Read at each request, so a test or an operator can change it; 0 or less keeps nothing. */
  ttlMs: () => number;
  /** Answers kept per owner. */
  kept: number;
  now?: () => number;
}) {
  const clock = options.now ?? Date.now;
  const owners = new WeakMap<object, Map<string, { at: number; value: Promise<T> }>>();
  /** The answer for `key` under `owner` (the App's definition object: an App that reloads starts empty). */
  return (owner: object, key: string, build: () => Promise<T>): Promise<T> => {
    const ttl = options.ttlMs();
    if (!(ttl > 0)) return build();
    let held = owners.get(owner);
    if (!held) owners.set(owner, (held = new Map()));
    const at = clock();
    const known = held.get(key);
    if (known && at - known.at < ttl) return known.value;
    held.delete(key);
    const entry = { at, value: build() };
    held.set(key, entry);
    while (held.size > options.kept) held.delete(held.keys().next().value!);
    const forget = () => {
      if (held.get(key) === entry) held.delete(key);
    };
    entry.value.then((answer) => (typeof answer === 'string' ? undefined : forget()), forget);
    return entry.value;
  };
}
