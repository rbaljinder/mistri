import { TenantWriteFailure } from './tenantWriteSource.js';

/** Internal ownership composition: stop every admission family synchronously,
 * drain even when a sibling fails, then attempt every captured source closure.
 * These are runtime-owned callbacks, not configurable lifecycle hooks. */
export function tenantRetirement(drains: readonly (() => Promise<void>)[], closes: readonly (() => Promise<void>)[]) {
  const stop = [...drains],
    close = [...closes];
  let retirement: Promise<void> | undefined;
  const invoke = (operation: () => Promise<void>) => {
    try {
      return operation();
    } catch (error) {
      return Promise.reject(error);
    }
  };
  return (): Promise<void> => {
    if (retirement) return retirement;
    // Publish the stable promise before callbacks can synchronously reenter.
    let resolve!: () => void, reject!: (error: unknown) => void;
    retirement = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void retirement.catch(() => {});
    const stopped = stop.map(invoke);
    void (async () => {
      const drained = await Promise.allSettled(stopped);
      const closed = await Promise.allSettled(close.map(invoke));
      if ([...drained, ...closed].some((result) => result.status === 'rejected')) throw new TenantWriteFailure('unknown');
    })().then(resolve, reject);
    return retirement;
  };
}
