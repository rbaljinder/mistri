/**
 * Admission evidence kept between one login's requests.
 *
 * Admission (tenantMembership.ts, tenantPlatform.ts) verifies the session and
 * reads the membership in a read snapshot of its own, to mint the evidence
 * every later fence compares against. Those fences — each read's own
 * snapshot, the release fence, the writer's FOR SHARE rows held to COMMIT —
 * are what refuse a revoked member, not admission; so admission's own read
 * repeats one that follows anyway. This keeps the evidence an earlier request
 * minted and hands it to the next, and nothing else:
 *
 * - Evidence only. Never grants, row scopes or refusals: those are computed
 *   from the evidence on every request, and a refusal is never kept, so a
 *   membership that becomes valid is seen at once.
 * - Keyed by App, deployment, store, database, source, account, the native
 *   session instance and the tenant (or `@platform`). A request whose login
 *   has no session instance — an App API token — is never served from it,
 *   nor kept in it; another login, even the same account's, never meets
 *   another's evidence; each deployment has its own, so a restart onto
 *   another database or store starts empty.
 * - Served only before the evidence's own `validUntil`, and never before its
 *   `verifiedAt`. The session is verified before the lookup every time.
 * - Dropped on sign-out (`endAdmissionSession`) and on any refusal that
 *   evidence met, and the request is then admitted afresh at most once, and
 *   only where nothing could have been written yet (the issuers and the
 *   request runtimes say where).
 * - A context's open, switch and renewal always admit afresh
 *   (`requireFreshAdmission`): the lease window they set is bounded by the
 *   evidence, and kept evidence would never lengthen it.
 */
import { TenantContextError, TenantUnavailableError } from '@mistriwork/engine/server/evidence.js';
import type { TenantMembershipEvidence } from './tenantMembership.js';
import type { PlatformMembershipEvidence } from './tenantPlatform.js';
import type { TenantSourceIdentity } from './tenantSourceIdentity.js';

type Evidence = TenantMembershipEvidence | PlatformMembershipEvidence;
/* Far above one host's open contexts (tenantContexts.ts allows 1,024 tabs),
   so eviction only bounds memory. */
const MAXIMUM = 4096;

/* The native session instance a request's login was verified as, noted by
   the host verifier that resolved it (tenantAuthenticatedHttp.ts). */
const sessions = new WeakMap<object, string>();
const fresh = new WeakSet<object>();
const live = new Set<Map<string, { session: string; evidence: Evidence }>>();

export function noteAdmissionSession(request: unknown, sessionId: string | null): void {
  if (!request || typeof request !== 'object') return;
  if (sessionId === null) sessions.delete(request);
  else sessions.set(request, sessionId);
}
/** This request is a context's open, switch or renewal: never served kept evidence. */
export function requireFreshAdmission(request: unknown): void {
  if (request && typeof request === 'object') fresh.add(request);
}
/** A refusal kept evidence met, not a database that could not answer: only
 * the first is worth admitting afresh for. */
export function evidenceRefused(error: unknown): boolean {
  return error instanceof TenantContextError && !(error instanceof TenantUnavailableError);
}
/** Sign-out: every deployment's evidence for that session instance goes. */
export function endAdmissionSession(sessionId: string): void {
  for (const entries of live) for (const [key, entry] of entries) if (entry.session === sessionId) entries.delete(key);
}

export interface AdmissionCache {
  /** The kept evidence for this request's login in `realm`, and its key; no key when nothing may be kept. */
  find(request: unknown, accountId: string, realm: string): { key?: string; evidence?: Evidence };
  keep(key: string | undefined, evidence: Evidence): void;
  drop(key: string | undefined): void;
  retire(): void;
}

export function createAdmissionCache(identity: TenantSourceIdentity, deployment: string): AdmissionCache {
  const entries = new Map<string, { session: string; evidence: Evidence }>();
  live.add(entries);
  const scope = [identity.appId, deployment, identity.storeId, identity.canonicalPath, identity.source.id, identity.source.connection];
  return Object.freeze({
    find(request: unknown, accountId: string, realm: string) {
      const session = request && typeof request === 'object' ? sessions.get(request) : undefined;
      if (session === undefined) return {};
      const key = JSON.stringify([...scope, accountId, session, realm]);
      const kept = fresh.has(request as object) ? undefined : entries.get(key);
      return kept ? { key, evidence: kept.evidence } : { key };
    },
    keep(key: string | undefined, evidence: Evidence) {
      if (key === undefined) return;
      const session = (JSON.parse(key) as string[])[scope.length + 1];
      entries.delete(key);
      if (entries.size >= MAXIMUM) entries.delete(entries.keys().next().value!);
      entries.set(key, { session, evidence });
    },
    drop(key: string | undefined) {
      if (key !== undefined) entries.delete(key);
    },
    retire() {
      entries.clear();
      live.delete(entries);
    },
  });
}
