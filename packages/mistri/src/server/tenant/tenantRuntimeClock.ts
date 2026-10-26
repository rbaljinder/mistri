import { isPromise } from 'node:util/types';
import { denyTenant } from '@mistriwork/engine/server/evidence.js';

/** One deployment high-water mark spans issuer admission/completion and runtime
 * checks. Separate local clocks would forget observations at their handoff. */
export function tenantRuntimeClock(read: () => number): () => number {
  let observed = 0;
  return () => {
    const value = read();
    if (isPromise(value)) void Promise.prototype.then.call(value, undefined, () => {});
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < observed) return denyTenant();
    observed = value;
    return value;
  };
}
