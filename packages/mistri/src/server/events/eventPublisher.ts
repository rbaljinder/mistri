import { isProxy } from 'node:util/types';
import { inSpan } from '@mistriwork/engine/adapters/telemetry/trace.js';
import type { EventDeliveryStore } from '../../adapters/events/eventDeliveryContract.js';
import {
  deliveryFail,
  type EventDeliveryClaim,
  type EventDeliveryCode,
  type EventDeliveryOutcome,
  type EventDiscovery,
} from '../../adapters/events/eventDeliveryTypes.js';
import type { CommandEventEnvelope } from '../../adapters/events/commandEventTypes.js';

export interface EventPublication {
  readonly destinationId: string;
  readonly serviceId: string;
  readonly envelope: CommandEventEnvelope;
  /** Stable across attempts/restarts/destinations; consumers must namespace by
   * source/destination as appropriate. Never use a lease token for deduplication. */
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
  /** On this host's clock. */
  readonly deadline: number;
}
/** 'accepted' promises the transport's durable acceptance, not consumer effects.
 * 'rejected' promises no acceptance. Throw/reject/invalid return is UNKNOWN.
 * Abort asks the transport to stop; it cannot retract an already accepted send.
 * Must return promptly, release resources on abort and eventually settle. */
export type EventPublicationTransport = (publication: EventPublication) => Promise<'accepted' | 'rejected'>;

/** Explicitly driven private publisher over one opened delivery store, which
 * it owns from here on: `stop()` closes it. No background timer loop,
 * endpoint, startup registration, broker dependency or public factory export.
 * A trusted host drives bounded ticks and owns stopping/reopening instances. */
export function createEventPublisher(store: EventDeliveryStore, transport: EventPublicationTransport, clock: () => number = Date.now) {
  if (
    !store ||
    typeof store !== 'object' ||
    isProxy(store) ||
    typeof store.claim !== 'function' ||
    typeof store.discover !== 'function' ||
    typeof transport !== 'function' ||
    isProxy(transport) ||
    typeof clock !== 'function' ||
    isProxy(clock)
  )
    return deliveryFail();
  const send = transport,
    now = clock;
  const captured = store.policy;
  let state: 'running' | 'stopping' | 'stopped' | 'halted' = 'running';
  let active: Promise<PublicationTick> | undefined;
  let abort: (() => void) | undefined;
  let stopping: Promise<void> | undefined;
  // The latest time this publisher offered a claim: a clock that then reads
  // earlier is not a store that failed to answer, and the store refuses it
  // with the same unavailable.
  let lastClaimAt = -Infinity;
  const halt = () => {
    if (state !== 'stopping') state = 'halted';
  };
  type Completion = { outcome: EventDeliveryOutcome; code: EventDeliveryCode };
  async function work(): Promise<PublicationTick> {
    if (state !== 'running') return { status: state, pressure: false };
    let discovery: EventDiscovery, claimedAt: number, claim: EventDeliveryClaim | undefined;
    try {
      discovery = await store.discover();
      // This host's clock before the claim: the lease it measures is on the
      // store's clock, which on PostgreSQL is the database's.
      claimedAt = now();
      const regressed = claimedAt < lastClaimAt;
      lastClaimAt = Math.max(lastClaimAt, claimedAt);
      if (regressed) {
        // Stops publication rather than shortening a backoff or lease.
        halt();
        return { status: 'unavailable', pressure: false };
      }
      claim = await store.claim(claimedAt);
    } catch {
      /* Nothing was sent and nothing is leased that this publisher knows of —
         a claim whose answer was lost is a lease no one holds, which expiry
         returns. A failover here is a cycle that did not happen; the next
         one tries again, where halting stopped delivery until a restart. */
      return { status: 'unavailable', pressure: false };
    }
    try {
      if (!claim) return { status: 'idle', pressure: discovery.pressure };
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let interrupt!: (value: Completion) => void;
      const interrupted = new Promise<Completion>((resolve) => {
        interrupt = resolve;
      });
      const cancel = (code: 'timeout' | 'shutdown') => {
        // Resolve first: an abort listener can synchronously reject transport.
        interrupt({ outcome: 'unknown', code });
        controller.abort();
      };
      abort = () => cancel('shutdown');
      if (state !== 'running') cancel('shutdown');
      const deadline = Math.min(claimedAt + captured.limits.leaseMs - 1, now() + captured.limits.timeoutMs);
      const publication = Object.freeze({
        destinationId: captured.destinationId,
        serviceId: captured.serviceId,
        envelope: claim.envelope,
        idempotencyKey: claim.eventId,
        deadline,
        signal: controller.signal,
      });
      let transportSettled = false;
      timer = setTimeout(() => cancel('timeout'), Math.max(0, deadline - now()));
      // The claim is committed and its store transaction is over. A
      // microtask also turns synchronous throws into handled unknown results.
      const delivery: Promise<Completion> = Promise.resolve()
        .then(() => {
          if (controller.signal.aborted || state !== 'running') return 'interrupted';
          // One delivery, one trace: the event's name and version travel, its payload stays local.
          return inSpan(
            `event ${claim.envelope.name}`,
            {
              kind: 'producer',
              attributes: {
                'messaging.system': 'mistri',
                'messaging.operation.type': 'send',
                'mistri.event.name': claim.envelope.name,
                'mistri.event.version': claim.envelope.version,
              },
            },
            (span) => {
              span.detail(() => ({ event: { id: claim.eventId, name: claim.envelope.name, payload: claim.envelope.payloadJson } }));
              return send(publication);
            },
          );
        })
        .then(
          (result) => {
            transportSettled = true;
            return result === 'accepted' || result === 'rejected'
              ? { outcome: result, code: result }
              : { outcome: 'unknown', code: 'transport' };
          },
          () => {
            transportSettled = true;
            return { outcome: 'unknown', code: 'transport' };
          },
        );
      try {
        const completion = await Promise.race([delivery, interrupted]);
        if (!transportSettled) {
          // Interrupted, and the abort is sent. A slow send is an unknown
          // attempt that backoff retries, not a reason to stop: wait for the
          // transport to let go, but not past the lease, after which the
          // store's expiry owns the event. Its late answer is not recorded.
          let grace: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            delivery,
            new Promise<void>((resolve) => {
              grace = setTimeout(resolve, Math.max(0, claimedAt + captured.limits.leaseMs - now() - 1));
            }),
          ]);
          clearTimeout(grace);
          // Once an uncooperative invocation outlives its lease, this owner
          // never starts another. Late fulfillment cannot settle a newer claim.
          if (!transportSettled) halt();
        }
        const recorded = await store.complete(claim, completion.outcome, completion.code, now());
        if (!recorded) halt();
        return { status: recorded ? completion.outcome : 'unknown', pressure: discovery.pressure };
      } finally {
        clearTimeout(timer);
        abort = undefined;
      }
    } catch {
      // Failure after acceptance may mean local acknowledgement was lost. Keep
      // the durable lease/attempt and stop; expiry/restart conservatively retries.
      halt();
      return { status: 'unavailable', pressure: false };
    }
  }
  return Object.freeze({
    tick(): Promise<PublicationTick> {
      if (state !== 'running') return Promise.resolve({ status: state, pressure: false });
      if (active) return Promise.resolve({ status: 'busy', pressure: false });
      // Set the reentry fence before calling even the trusted clock callback.
      const task = Promise.resolve().then(work);
      active = task;
      void task.then(() => {
        if (active === task) active = undefined;
      });
      return task;
    },
    status: () => state,
    stop(): Promise<void> {
      return (stopping ??= (async () => {
        state = 'stopping';
        abort?.();
        if (active) await active;
        await store.close().catch(() => {});
        state = 'stopped';
      })());
    },
  });
}
export interface PublicationTick {
  readonly status: 'accepted' | 'rejected' | 'unknown' | 'idle' | 'busy' | 'stopping' | 'stopped' | 'halted' | 'unavailable';
  readonly pressure: boolean;
}
