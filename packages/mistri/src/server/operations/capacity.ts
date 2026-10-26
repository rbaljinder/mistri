/**
 * The capacity section of the operator surface, read at the moment of asking:
 * how busy the event loop has been, and every open database pool's meters.
 *
 * Together they separate the three answers to "it is slow". The event loop
 * busy most of the time, pools calm: this process is the limit, so add pods.
 * Checkouts queueing while each is held briefly: the pool is the limit, so
 * raise it, if the database has connections to spare. Checkouts queueing
 * behind long holds: the database is slow, and more connections would only
 * queue there instead. docs/observability.md has the reading in full.
 */
import type { CapacitySnapshot, ReadinessCheckInput } from './operations.js';

/* Read where the request log's summaries are (diagnostics.ts), which both products' servers keep. */
export { collectCapacity } from '@mistriwork/engine/server/operations/diagnostics.js';

/** The `pools` readiness check: degraded while any pool is saturated, and
 * absent until a connection has opened one. */
export function capacityCheck(capacity: CapacitySnapshot): ReadinessCheckInput | undefined {
  if (!capacity.pools.length) return undefined;
  return capacity.pools.some((pool) => pool.saturated)
    ? { name: 'pools', state: 'degraded', code: 'pool_saturated' }
    : { name: 'pools', state: 'ready', code: 'ok' };
}
