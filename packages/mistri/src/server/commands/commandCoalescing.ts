/**
 * In-flight single-flight coalescing for idempotent business commands.
 *
 * When a slow idempotent command (such as one calling an external integration)
 * is still executing and a timed-out caller retries with the same binding,
 * scope, idempotency key, and payload fingerprint, the retry attaches to the
 * live promise instead of duplicating handler work or contending on row locks.
 * A concurrent retry carrying the same key with a different fingerprint fails
 * immediately with `idempotency_conflict`.
 */
import type { BusinessCommandBinding } from './businessCommandAccess.js';
import { BusinessCommandExecutionError } from './commandErrors.js';

interface InFlightCommand<T> {
  readonly fingerprint: string;
  readonly promise: Promise<T>;
}

const IN_FLIGHT_MAX = 1_024;
const inFlightCommands = new WeakMap<BusinessCommandBinding, Map<string, InFlightCommand<unknown>>>();

function waitForInFlight<T extends { readonly replayed: boolean }>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new BusinessCommandExecutionError('cancelled'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new BusinessCommandExecutionError('cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve({ ...result, replayed: true });
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

type CoalescedFlight<T> =
  | Readonly<{ kind: 'attached'; promise: Promise<T> }>
  | Readonly<{ kind: 'leader'; settle: (result?: T, error?: unknown) => void }>
  | Readonly<{ kind: 'bypass' }>;

/**
 * Join an already-running command execution matching `key` + `fingerprint`, or
 * register as the leader that settles any retries arriving before completion.
 */
export function enterInFlightCommand<T extends { readonly replayed: boolean }>(
  binding: BusinessCommandBinding,
  key: string,
  fingerprint: string,
  signal: AbortSignal,
): CoalescedFlight<T> {
  let map = inFlightCommands.get(binding);
  if (!map) {
    map = new Map<string, InFlightCommand<unknown>>();
    inFlightCommands.set(binding, map);
  }
  const existing = map.get(key) as InFlightCommand<T> | undefined;
  if (existing) {
    if (existing.fingerprint !== fingerprint) throw new BusinessCommandExecutionError('idempotency_conflict');
    return { kind: 'attached', promise: waitForInFlight(existing.promise, signal) };
  }
  if (map.size >= IN_FLIGHT_MAX) return { kind: 'bypass' };
  let resolveFlight!: (value: T) => void;
  let rejectFlight!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFlight = resolve;
    rejectFlight = reject;
  });
  // Prevent unhandledRejection when no concurrent retry attaches to a failed leader execution.
  promise.catch(() => {});
  const activeMap = map;
  activeMap.set(key, { fingerprint, promise });
  let settled = false;
  return {
    kind: 'leader',
    settle(result?: T, error?: unknown) {
      if (settled) return;
      settled = true;
      activeMap.delete(key);
      if (result !== undefined) resolveFlight(result);
      else rejectFlight(error);
    },
  };
}
