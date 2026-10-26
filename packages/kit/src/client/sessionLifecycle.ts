import { captureSessionIdentity, lockSessionIdentity, sessionIdentity, type SessionIdentitySnapshot } from './sessionIdentity.js';
import { say } from './copy/shell/sessionLifecycle.js';
import { addHostListener, removeHostListener } from './shellHost.js';
import { fetchServer } from './transport.js';

type SessionLockReason = 'expired' | 'signed-out' | 'account-changed' | 'other-tab' | 'unavailable';
interface SessionLifecycleOptions {
  onLock: (reason: SessionLockReason) => void;
  onCheck?: (snapshot: SessionIdentitySnapshot, signal: AbortSignal) => Promise<Response>;
  /** Tenant hosts also revalidate the captured selection, not just the account. */
  onContextCheck?: (snapshot: SessionIdentitySnapshot, signal: AbortSignal) => Promise<void>;
  /** Unavailable verification is recoverable for selected tenants. Confirmed
   * sign-out, account changes and context denial still retire private state. */
  onTenantSuspend?: (snapshot: SessionIdentitySnapshot) => void;
  /** Retire denied business data without destroying independently admitted
   * account administration. Must synchronously retire the selected data owner. */
  onTenantDenied?: (snapshot: SessionIdentitySnapshot) => void;
  onReload?: () => void;
  intervalMs?: number;
  /** Each try's deadline, and the deadline of what follows the answer. */
  timeoutMs?: number;
  /** The pause before the one retry of a check that got no answer (a timeout, a network error, a 502/503/504). */
  retryDelayMs?: number;
}

export const SESSION_CHANGE_KEY = 'mistri.session-change.v1';
let options: SessionLifecycleOptions = { onLock: () => {} };
let stopMonitoring: (() => void) | undefined;
let generation = 0;
let pending: { snapshot: SessionIdentitySnapshot; controller: AbortController; promise: Promise<void> } | undefined;

export function configureSessionLifecycle(next: SessionLifecycleOptions): void {
  stopMonitoring?.();
  generation++;
  pending?.controller.abort();
  pending = undefined;
  options = next;
}

/** This notice carries no account information and is never an authorization signal. */
export function announceSessionChange(): void {
  try {
    window.localStorage.setItem(SESSION_CHANGE_KEY, crypto.randomUUID());
  } catch {
    /* Storage can be disabled. */
  }
}

export function invalidateSession(reason: SessionLockReason, broadcast = true): void {
  const previous = sessionIdentity();
  if (previous.mode === 'locked') return;
  lockSessionIdentity();
  pending?.controller.abort();
  pending = undefined;
  try {
    options.onLock(reason);
  } finally {
    if (broadcast && previous.mode === 'authenticated') announceSessionChange();
  }
}

export function beginSessionSignOut(): void {
  invalidateSession('signed-out');
}

export function invalidateTenantContext(snapshot: SessionIdentitySnapshot): void {
  if (sessionIdentity() !== snapshot) return;
  if (snapshot.tenant && options.onTenantDenied) {
    try {
      options.onTenantDenied(snapshot);
    } catch {
      /* Failed retirement still locks below. */
    }
    // A hook cannot leave denied data authority active, even if it throws away
    // the UI alone. The default remains a complete fail-closed session lock.
    if (sessionIdentity() !== snapshot) return;
  }
  invalidateSession('unavailable', false);
}

/** Call only after sign-in/sign-out cookie updates have completed. */
export function reloadSession(): void {
  options.onReload?.();
}

const isCurrent = (snapshot: SessionIdentitySnapshot, capturedGeneration: number) =>
  generation === capturedGeneration && sessionIdentity() === snapshot;

/** A gateway's answers that say the server did not get to the question: worth one more try. */
const TRANSIENT_STATUS = new Set([502, 503, 504]);
/** The pause before the one retry, and the spread added to it so a server's many tabs do not all ask again at once. */
const RETRY_DELAY_MS = 750;
const RETRY_JITTER_MS = 500;

/* A wait that a superseding check ends early; the caller asks isCurrent after it. */
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });

/** A stale check may neither replace identity nor lock a newer account. */
export function checkSessionIdentity(): Promise<void> {
  const snapshot = captureSessionIdentity();
  if (snapshot.mode !== 'authenticated') return Promise.resolve();
  if (pending?.snapshot === snapshot) return pending.promise;
  pending?.controller.abort();
  const controller = new AbortController();
  const capturedGeneration = generation;
  const config = options;
  const work = { snapshot, controller, promise: Promise.resolve() };
  pending = work;
  work.promise = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const timeoutMs = config.timeoutMs ?? 10_000;
    try {
      /* One try at the account check, under its own deadline. A try that ran out of time, or never got an answer, is
         transient; so is a gateway's 502, 503 or 504. Everything else is the server's answer. */
      const ask = async (): Promise<{ response: Response } | { transient: true }> => {
        const attempt = new AbortController();
        const relay = () => attempt.abort();
        controller.signal.addEventListener('abort', relay, { once: true });
        let late: ReturnType<typeof setTimeout> | undefined;
        let stopped: (() => void) | undefined;
        try {
          const cut = new Promise<never>((_, reject) => {
            stopped = () => reject(new Error(say('sessionCheckInterrupted')));
            attempt.signal.addEventListener('abort', stopped, { once: true });
            late = setTimeout(() => attempt.abort(), timeoutMs);
          });
          const request = config.onCheck
            ? config.onCheck(snapshot, attempt.signal)
            : fetchServer(`/api/whoami?${new URLSearchParams({ app: snapshot.appId! })}`, {
                credentials: 'same-origin',
                cache: 'no-store',
                signal: attempt.signal,
              });
          const response = await Promise.race([request, cut]);
          return TRANSIENT_STATUS.has(response.status) ? { transient: true } : { response };
        } catch (error) {
          /* Superseded, or a refusal that says who: never retried. A missing answer is. */
          if (controller.signal.aborted || (error as { status?: unknown } | null)?.status !== undefined) throw error;
          return { transient: true };
        } finally {
          clearTimeout(late);
          controller.signal.removeEventListener('abort', relay);
          if (stopped) attempt.signal.removeEventListener('abort', stopped);
        }
      };
      /* Under load the server is slow, not wrong: a check that got no answer is asked once more after a short, jittered
         pause before the session is called unavailable. A definite answer — 401, 403, another person — locks at once. */
      let asked = await ask();
      if ('transient' in asked && isCurrent(snapshot, capturedGeneration)) {
        await pause(config.retryDelayMs ?? RETRY_DELAY_MS + Math.random() * RETRY_JITTER_MS, controller.signal);
        if (!isCurrent(snapshot, capturedGeneration)) return;
        asked = await ask();
      }
      if (!isCurrent(snapshot, capturedGeneration)) return;
      if ('transient' in asked) throw new Error(say('sessionVerificationIsUnavailable'));
      const { response } = asked;
      /* What follows the answer — its body, a tenant's context check — has a deadline of its own. */
      const interrupted = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error(say('sessionCheckInterrupted')));
        controller.signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => controller.abort(), timeoutMs);
      });
      /* A lock below aborts the check: the deadline's rejection then has no reader, and is not an error. */
      interrupted.catch(() => {});
      if (response.status === 401) {
        invalidateSession('expired');
        return;
      }
      if (!response.ok) {
        if (response.status === 403) {
          invalidateSession('unavailable', false);
          return;
        }
        throw new Error(say('sessionVerificationIsUnavailable'));
      }
      const value: unknown = await Promise.race([response.json(), interrupted]);
      if (!isCurrent(snapshot, capturedGeneration)) return;
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        invalidateSession('unavailable', false);
        return;
      }
      const whoami = value as Record<string, unknown>;
      if (whoami.signedIn === false) {
        invalidateSession('expired');
        return;
      }
      if (
        whoami.signedIn !== true ||
        typeof whoami.accountId !== 'string' ||
        !whoami.accountId ||
        typeof whoami.appId !== 'string' ||
        !whoami.appId
      ) {
        invalidateSession('unavailable', false);
        return;
      }
      if (whoami.accountId !== snapshot.accountId || whoami.appId !== snapshot.appId) {
        invalidateSession('account-changed');
        return;
      }
      if (snapshot.tenant) {
        if (!config.onContextCheck) throw new Error(say('tenantContextVerificationIsUnavailable'));
        await Promise.race([config.onContextCheck(snapshot, controller.signal), interrupted]);
      }
    } catch (error) {
      if (isCurrent(snapshot, capturedGeneration)) {
        const denial = error as { status?: number; code?: string } | null;
        if (denial?.status === 401) invalidateSession('expired');
        else if (denial?.status === 403 || denial?.code === 'tenant_context_unavailable') invalidateTenantContext(snapshot);
        else if (snapshot.tenant && config.onTenantSuspend) config.onTenantSuspend(snapshot);
        else invalidateSession('unavailable', false);
      }
    } finally {
      clearTimeout(timer);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
      if (pending === work) pending = undefined;
    }
  })();
  return work.promise;
}

export function startSessionMonitoring(): () => void {
  if (stopMonitoring) return stopMonitoring;
  const foreground = () => {
    if (document.visibilityState !== 'hidden') void checkSessionIdentity();
  };
  const parking = (event: PageTransitionEvent) => {
    // A selected tenant can park its mounted forms behind the recovery cover.
    const snapshot = sessionIdentity();
    if (event.persisted && snapshot.mode === 'authenticated') {
      if (snapshot.tenant && options.onTenantSuspend) options.onTenantSuspend(snapshot);
      else invalidateSession('unavailable', false);
    }
  };
  const noticed = (event: StorageEvent) => {
    if (event.key === SESSION_CHANGE_KEY && event.newValue && sessionIdentity().mode === 'authenticated') {
      // A sessionStorage event must not masquerade as the shared localStorage notice.
      try {
        if (event.storageArea && event.storageArea !== window.localStorage) return;
      } catch {
        return;
      }
      invalidateSession('other-tab', false);
    }
  };
  addHostListener(window, 'focus', foreground);
  addHostListener(window, 'pageshow', foreground);
  addHostListener(window, 'pagehide', parking);
  addHostListener(document, 'visibilitychange', foreground);
  addHostListener(window, 'storage', noticed);
  const timer = setInterval(foreground, options.intervalMs ?? 60_000);
  const stop = () => {
    if (stopMonitoring !== stop) return;
    stopMonitoring = undefined;
    generation++;
    pending?.controller.abort();
    pending = undefined;
    clearInterval(timer);
    removeHostListener(window, 'focus', foreground);
    removeHostListener(window, 'pageshow', foreground);
    removeHostListener(window, 'pagehide', parking);
    removeHostListener(document, 'visibilitychange', foreground);
    removeHostListener(window, 'storage', noticed);
  };
  stopMonitoring = stop;
  return stop;
}
