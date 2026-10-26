/** Test-owned logical time, separate from wall-clock transport timeouts. */
import type { VirtualClock } from './definition.js';

export function createVirtualClock(initial: number): VirtualClock & { reset(): void; close(): void } {
  if (!Number.isSafeInteger(initial) || initial < 0) throw new Error('Clock must start at nonnegative integer milliseconds.');
  let now = initial,
    closed = false;
  const sleepers = new Set<{ at: number; finish(error?: Error): void }>();
  const duration = (ms: number) => {
    if (!Number.isSafeInteger(ms) || ms < 0 || !Number.isSafeInteger(now + ms))
      throw new Error('Clock duration must be nonnegative safe integer milliseconds.');
  };
  const cancel = () => {
    for (const sleeper of [...sleepers]) sleeper.finish(new Error('Virtual clock retired.'));
  };
  return Object.freeze({
    now: () => now,
    advance(ms: number) {
      if (closed) throw new Error('Virtual clock closed.');
      duration(ms);
      now += ms;
      for (const sleeper of [...sleepers]) if (sleeper.at <= now) sleeper.finish();
    },
    sleep(ms: number, signal?: AbortSignal) {
      duration(ms);
      if (closed || signal?.aborted) return Promise.reject(new Error('Virtual clock sleep cancelled.'));
      if (ms === 0) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const abort = () => sleeper.finish(new Error('Virtual clock sleep cancelled.'));
        const sleeper = {
          at: now + ms,
          finish(error?: Error) {
            if (!sleepers.delete(sleeper)) return;
            signal?.removeEventListener('abort', abort);
            if (error) reject(error);
            else resolve();
          },
        };
        sleepers.add(sleeper);
        signal?.addEventListener('abort', abort, { once: true });
      });
    },
    reset() {
      if (closed) throw new Error('Virtual clock closed.');
      cancel();
      now = initial;
    },
    close() {
      closed = true;
      cancel();
    },
  });
}

export function seededRandom(seed: number): () => number {
  if (!Number.isSafeInteger(seed)) throw new Error('Random seed must be a safe integer.');
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(value ^ (value >>> 15), value | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}
