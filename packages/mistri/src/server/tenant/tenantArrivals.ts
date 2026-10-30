/**
 * How many arrivals a tenant host works on at once: `/api/tenant/enter` and `/api/tenant/bootstrap`, each a
 * person's discovery, their lease and (entering) the page's boot on it.
 *
 * An arrival is the dearest request a tenant host answers: eight or nine reader checkouts and a hundred and fifty
 * milliseconds of CPU, alone. In a capacity run twenty-five people arrived in the same second on half a core; every
 * arrival started at once, each waited its turn for a reader behind the others' checkouts, and sixteen of them
 * waited past the pool's two-second queue limit and were answered 503 — then asked again, twice each, which did the
 * same work again on the same saturated core. The boots that did land took twelve seconds at the median, against
 * half a second for an arrival alone. Started one or two at a time, the same arrivals finish one after another in
 * well under that, and the readers stay free for the people already in.
 *
 * So an arrival waits here, in order, before it costs anything: at most half the readers' width work at once (the
 * rest stay with the people already in), and one that has waited `ARRIVAL_WAIT_MS` — far longer than the pool
 * would let it — is answered as the database's busy answer is (503, `tenant_temporarily_unavailable`, Retry-After),
 * as is one past `ARRIVALS_WAITING_MOST` in line. A person who leaves while waiting is let out of the line.
 */
import { tenantRequestReaders } from './tenantConnections.js';
import { recordRefusalCause, TenantUnavailableError } from '@mistriwork/engine/server/evidence.js';

/** How long an arrival waits for its turn before it is answered busy. */
const ARRIVAL_WAIT_MS = 20_000;
/** How many arrivals may wait; the next is answered busy at once. */
const ARRIVALS_WAITING_MOST = 256;

interface ArrivalGate {
  /** Resolves with this arrival's release, once it may start; rejects, busy, when it waited too long or left. */
  admit(signal: AbortSignal): Promise<() => void>;
  readonly running: number;
  readonly waiting: number;
}

/** How many arrivals this process works on at once: half its readers, at least one. */
export function arrivalWidth(readers: number = tenantRequestReaders()): number {
  return Math.max(1, Math.ceil(readers / 2));
}

const busy = (why: string) => recordRefusalCause(new TenantUnavailableError(), new Error(why));

export function arrivalGate(width: number, waitMs: number = ARRIVAL_WAIT_MS, waitingMost: number = ARRIVALS_WAITING_MOST): ArrivalGate {
  let running = 0;
  /* In arrival order. A release hands its turn to the first in line, so `running` counts turns, not callers. */
  const line: Array<() => void> = [];
  const handOn = () => {
    const next = line.shift();
    if (next) next();
    else running -= 1;
  };
  const turn = () => {
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      handOn();
    };
  };
  return {
    get running() {
      return running;
    },
    get waiting() {
      return line.length;
    },
    admit(signal) {
      if (signal.aborted) return Promise.reject(busy('The arrival left before its turn.'));
      if (running < width) {
        running += 1;
        return Promise.resolve(turn());
      }
      if (line.length >= waitingMost) return Promise.reject(busy(`${line.length} arrivals were already waiting for a turn.`));
      return new Promise((resolve, reject) => {
        const settle = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', left);
        };
        const go = () => {
          settle();
          resolve(turn());
        };
        const leave = (why: string) => {
          const at = line.indexOf(go);
          if (at >= 0) line.splice(at, 1);
          settle();
          reject(busy(why));
        };
        const left = () => leave('The arrival left before its turn.');
        const timer = setTimeout(() => leave(`The arrival waited ${waitMs} ms for a turn among ${width}.`), waitMs);
        timer.unref?.();
        signal.addEventListener('abort', left, { once: true });
        line.push(go);
      });
    },
  };
}
