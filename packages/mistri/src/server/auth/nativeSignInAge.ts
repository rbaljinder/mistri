/** Private native sign-in age, separate from the ordinary session contract.
 * The registration owner supplies genuine issued-proof identity and native reads;
 * these observations grant no role or cross-database transaction authority. */
import type { VerifiedSessionInstance } from './auth.js';
import { denyTenant } from '@mistriwork/engine/server/evidence.js';

/**
 * The longest a step-up may count a sign-in as recent. A session a host's
 * assertion opened is looked for only while it is younger than this
 * (auth.ts), so an age asked of anything older could not tell one from a
 * sign-in made here: it is refused.
 */
export const RECENT_SIGN_IN_MAX_MS = 900_000;

type NativeRead =
  | { synchronous: true; checkSession(proof: VerifiedSessionInstance, createdAt: number): void }
  | { synchronous: false; checkSession(proof: VerifiedSessionInstance, createdAt: number): Promise<void> };

export function createNativeSignInAge(
  proofs: WeakSet<VerifiedSessionInstance>,
  instants: WeakMap<VerifiedSessionInstance, number>,
  current: () => void,
  observer: NativeRead,
  /** For a session an identity provider opened: when the provider authenticated the person, or null where
      that sign-in does not count for a step-up (identityProviders.ts stepUpInstant). Absent: the session's own. */
  authenticated: WeakMap<VerifiedSessionInstance, number | null> = new WeakMap(),
) {
  const assertAge = (proof: VerifiedSessionInstance, at: number, maximumAgeMs: number): void => {
    current();
    // Identity before field access: a copied/proxied proof cannot run getters.
    if (!proofs.has(proof)) return denyTenant();
    const createdAt = instants.get(proof);
    /* The age is counted from the provider's own authentication where it
       opened the session, never later than the session itself. */
    const provider = authenticated.get(proof);
    const since =
      provider === undefined ? createdAt : provider === null || createdAt === undefined ? undefined : Math.min(provider, createdAt);
    if (
      createdAt === undefined ||
      since === undefined ||
      !Number.isSafeInteger(at) ||
      at < 0 ||
      !Number.isSafeInteger(maximumAgeMs) ||
      maximumAgeMs < 0 ||
      maximumAgeMs > RECENT_SIGN_IN_MAX_MS ||
      at < createdAt ||
      at - since > maximumAgeMs ||
      at >= proof.expiresAt
    )
      return denyTenant();
  };
  if (observer.synchronous)
    return Object.freeze({
      synchronous: true as const,
      assertAge,
      observeRecent(proof: VerifiedSessionInstance, at: number, maximumAgeMs: number): void {
        try {
          assertAge(proof, at, maximumAgeMs);
          observer.checkSession(proof, instants.get(proof)!);
          assertAge(proof, Math.max(at, Date.now()), maximumAgeMs);
        } catch {
          return denyTenant();
        }
      },
    });
  return Object.freeze({
    synchronous: false as const,
    assertAge,
    async observeRecent(proof: VerifiedSessionInstance, at: number, maximumAgeMs: number): Promise<void> {
      try {
        assertAge(proof, at, maximumAgeMs);
        await observer.checkSession(proof, instants.get(proof)!);
        // Never reuse a pre-await clock as proof that opening is still recent.
        assertAge(proof, Math.max(at, Date.now()), maximumAgeMs);
      } catch {
        return denyTenant();
      }
    },
  });
}
