import type { TenantContextReply } from '../shared/tenantContext.js';
import {
  acceptTenantRenewal,
  captureSessionIdentity,
  captureTenantLease,
  sessionIdentity,
  subscribeSessionIdentity,
  subscribeTenantLease,
  suspendTenantLease,
  tenantLeaseActive,
  type SessionIdentitySnapshot,
} from '@mistriwork/kit/client/sessionIdentity.js';
import { isTransientTenantFailure, renewTenant } from './tenantTransport.js';
import { say } from './copy/tenancy/tenantRenewal.js';
import { addHostListener, removeHostListener } from '@mistriwork/kit/client/shellHost.js';

export interface TenantRenewalState {
  suspended: boolean;
  busy: boolean;
  offline: boolean;
}
export interface TenantRenewalOptions {
  onState?: (state: TenantRenewalState) => void;
  /** Refresh eligibility separately from form originals and mutation receipts. */
  onResume?: (owner: SessionIdentitySnapshot) => void;
  onWake?: () => Promise<void>;
  renew?: typeof renewTenant;
  timeoutMs?: number;
  aheadMs?: number;
  retryMs?: number;
  maxRetryMs?: number;
}

/** One exact outstanding CAS per owner, including after an aborted/lost reply.
 * No identity transitions, data replay or mutation settlement happens here. */
export function startTenantRenewal(options: TenantRenewalOptions = {}) {
  const owner = captureSessionIdentity();
  if (!owner.tenant || !captureTenantLease(owner)) throw new Error(say('chooseATenantBefore'));
  let stopped = false,
    busy = false,
    failures = 0,
    wasSuspended = !tenantLeaseActive(owner);
  let attempt: TenantContextReply | undefined;
  let running: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let renewalTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let lastClock = Date.now();
  let interruption = 0;
  let parked = false;
  const current = () => !stopped && sessionIdentity() === owner;
  // Losing focus is ordinary navigation. Pause only automatic work while a
  // document is hidden; its admitted lease remains usable until its own
  // deadline or a real verification/transport failure fences it.
  const available = () => !parked && navigator.onLine !== false && document.visibilityState !== 'hidden';
  const draw = () => {
    if (!current()) return;
    const suspended = !tenantLeaseActive(owner);
    if (suspended) wasSuspended = true;
    options.onState?.({ suspended, busy, offline: navigator.onLine === false });
  };
  const clockValid = () => {
    const now = Date.now();
    if (!Number.isFinite(now) || now < lastClock) return false;
    lastClock = now;
    return true;
  };
  const suspend = () => {
    if (!current()) return;
    interruption++;
    clearTimeout(renewalTimer);
    controller?.abort();
    suspendTenantLease(owner);
    draw();
  };
  const automatic = () => {
    void check().catch(() => {});
  };
  const schedule = () => {
    clearTimeout(renewalTimer);
    clearTimeout(expiryTimer);
    if (!current()) return;
    const lease = captureTenantLease(owner);
    if (!lease) return;
    const remaining = lease.expiresAt - Date.now();
    if (remaining > 0 && tenantLeaseActive(owner)) {
      expiryTimer = setTimeout(() => {
        if (current()) suspend();
      }, remaining);
    }
    if (!available()) return;
    const delay = failures
      ? Math.min(options.maxRetryMs ?? 30_000, (options.retryMs ?? 1_000) * 2 ** Math.min(failures - 1, 10))
      : !tenantLeaseActive(owner)
        ? 0
        : Math.max(0, remaining - Math.min(options.aheadMs ?? 30_000, Math.max(1, remaining / 5)));
    renewalTimer = setTimeout(automatic, delay);
  };
  async function request(expected: TenantContextReply): Promise<TenantContextReply> {
    const active = new AbortController();
    controller = active;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort!: () => void;
    let late = false;
    const interrupted = new Promise<never>((_, reject) => {
      // Our own deadline passing is a slow server; any other abort is a suspension.
      onAbort = () => reject(Object.assign(new Error(say('tenantRenewalInterrupted')), late ? { transient: true } : {}));
      active.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        late = true;
        active.abort();
      }, options.timeoutMs ?? 8_000);
    });
    try {
      return await Promise.race([(options.renew ?? renewTenant)(owner, expected, active.signal), interrupted]);
    } finally {
      clearTimeout(timer);
      active.signal.removeEventListener('abort', onAbort);
      if (controller === active) controller = undefined;
    }
  }
  function check(): Promise<void> {
    if (!current()) return Promise.resolve();
    if (running) return running;
    if (!clockValid() || navigator.onLine === false) {
      suspend();
      return Promise.reject(new Error(say('tenantRenewalIsUnavailable')));
    }
    // A background page does not create a new renewal attempt. Its expiry
    // timer remains armed, and foreground session verification will resume.
    if (!available()) return Promise.resolve();
    clearTimeout(renewalTimer);
    if (!tenantLeaseActive(owner)) suspendTenantLease(owner);
    busy = true;
    draw();
    // Defer dispatch until running is assigned, including synchronous test providers.
    running = Promise.resolve().then(async () => {
      try {
        for (let receipt = 0; receipt < 2; receipt++) {
          attempt ??= captureTenantLease(owner);
          if (!attempt) throw new Error(say('tenantLeaseIsUnavailable'));
          const expected = attempt;
          const uninterrupted = interruption;
          const reply = await request(expected);
          if (!current()) return;
          // Explicit suspension increments interruption (offline, pagehide or
          // a failed verification). A merely hidden document may still receive
          // its already-admitted CAS reply; it remains exact-owner guarded.
          if (interruption !== uninterrupted || !clockValid()) throw new Error(say('tenantRenewalNeedsACurrent'));
          // An expired receipt advances only the control revision. It never
          // opens data access, even briefly, before the fresh follow-up succeeds.
          if (reply.expiresAt <= Date.now()) suspendTenantLease(owner);
          acceptTenantRenewal(owner, expected.revision, reply);
          attempt = undefined;
          if (tenantLeaseActive(owner)) {
            failures = 0;
            if (wasSuspended) {
              wasSuspended = false;
              options.onResume?.(owner);
            }
            return;
          }
        }
        throw new Error(say('theRecoveredLeaseHasExpired'));
      } catch (error) {
        if (current()) {
          failures++;
          /* A renewal the server was too slow or busy to answer decided nothing
             about the context (G172): while the lease it would extend still
             runs, it is asked again on the backoff, the same exact attempt,
             and the page stays open. The expiry timer still fences at the
             deadline, and a refusal (stale, expired, revoked, unverified) is
             not transient, so it suspends here at once as before. */
          if (!(isTransientTenantFailure(error) && tenantLeaseActive(owner))) suspend();
        }
        throw error;
      } finally {
        busy = false;
        running = undefined;
        if (current()) {
          draw();
          schedule();
        }
      }
    });
    return running;
  }
  const changed = () => {
    if (!current()) return;
    draw();
    if (!busy) schedule();
  };
  const wake = () => {
    parked = false;
    if (!current() || !available()) return;
    // Session monitoring receives the same foreground event. It verifies the
    // account and context; do not manufacture a suspension before that check.
    void (options.onWake ? options.onWake() : check()).catch(() => {});
  };
  const park = () => {
    parked = true;
    clearTimeout(renewalTimer);
  };
  // A pagehide can arrive while visibility still says visible. Park before
  // publishing suspension so the lease listener cannot queue background work.
  const pagehide = () => {
    park();
    suspend();
  };
  const visibility = () => {
    if (document.visibilityState === 'hidden') park();
    else wake();
  };
  const unsubscribeLease = subscribeTenantLease(changed);
  const unsubscribeIdentity = subscribeSessionIdentity(() => {
    if (sessionIdentity() !== owner) stop();
  });
  function stop() {
    if (stopped) return;
    stopped = true;
    controller?.abort();
    clearTimeout(renewalTimer);
    clearTimeout(expiryTimer);
    unsubscribeLease();
    unsubscribeIdentity();
    removeHostListener(window, 'offline', suspend);
    removeHostListener(window, 'online', wake);
    removeHostListener(window, 'focus', wake);
    removeHostListener(window, 'pagehide', pagehide);
    removeHostListener(window, 'pageshow', wake);
    removeHostListener(document, 'visibilitychange', visibility);
  }
  addHostListener(window, 'offline', suspend);
  addHostListener(window, 'online', wake);
  addHostListener(window, 'focus', wake);
  addHostListener(window, 'pagehide', pagehide);
  addHostListener(window, 'pageshow', wake);
  addHostListener(document, 'visibilitychange', visibility);
  if (document.visibilityState === 'hidden') park();
  else if (navigator.onLine === false) suspend();
  draw();
  schedule();
  return { owner, check, suspend, stop };
}
