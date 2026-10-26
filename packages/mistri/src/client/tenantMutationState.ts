import {
  captureSessionIdentity,
  sessionIdentity,
  subscribeSessionIdentity,
  tenantLeaseActive,
  type SessionIdentitySnapshot,
} from '@mistriwork/kit/client/sessionIdentity.js';

export type TenantMutationKind = 'update' | 'insert' | 'delete' | 'command';
export interface TenantMutationAttempt {
  readonly id: symbol;
  readonly kind: TenantMutationKind;
  readonly identity: SessionIdentitySnapshot;
}

const kinds: readonly TenantMutationKind[] = ['update', 'insert', 'delete', 'command'];
const attempts = new Map<TenantMutationAttempt, 'pending' | 'unknown'>();
const listeners = new Set<() => void>();
let owner = captureSessionIdentity();
let revision = 0;

function changed(): void {
  revision++;
  for (const listener of [...listeners]) {
    // A broken observer must not lose a newly started handle or veto security
    // retirement (including the remaining session-identity subscribers).
    try {
      listener();
    } catch {
      /* Observers do not own mutation lifetime. */
    }
  }
}

function syncOwner(): void {
  const current = sessionIdentity();
  if (current === owner) return;
  owner = current;
  if (!attempts.size) return;
  attempts.clear();
  changed();
}
subscribeSessionIdentity(syncOwner);

function live(attempt: TenantMutationAttempt | undefined): attempt is TenantMutationAttempt {
  syncOwner();
  return attempt !== undefined && attempts.has(attempt) && attempt.identity === sessionIdentity();
}

/** Tab-memory exit guard only, never write authority or a command-envelope
 * store. Unmounting a subscriber does not settle work. Identity retirement
 * drops all entries immediately, without claiming any request rolled back. */
export const tenantMutationState = Object.freeze({
  start(kind: TenantMutationKind, identity = captureSessionIdentity()): TenantMutationAttempt | undefined {
    syncOwner();
    if (
      identity !== sessionIdentity() ||
      identity.mode !== 'authenticated' ||
      !identity.tenantRequired ||
      !identity.tenant ||
      !kinds.includes(kind)
    )
      return;
    if (!tenantLeaseActive(identity) || identity !== sessionIdentity()) return;
    const attempt = Object.freeze({ id: Symbol('tenant-mutation'), kind, identity });
    attempts.set(attempt, 'pending');
    changed();
    return attempt;
  },
  unknown(attempt: TenantMutationAttempt | undefined): boolean {
    if (!live(attempt) || attempts.get(attempt) === 'unknown') return false;
    attempts.set(attempt, 'unknown');
    changed();
    return true;
  },
  /** Caller has verified success or definite refusal for this exact attempt.
   * In particular, a command retry's refusal does not settle an earlier unknown
   * execution; commandOperations remains responsible for that distinction. */
  settle(attempt: TenantMutationAttempt | undefined): boolean {
    if (!live(attempt)) return false;
    attempts.delete(attempt);
    changed();
    return true;
  },
  hasUnresolved(identity = captureSessionIdentity()): boolean {
    syncOwner();
    return identity === sessionIdentity() && attempts.size > 0;
  },
  version(): number {
    syncOwner();
    return revision;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
});
