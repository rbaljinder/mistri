/** The native tenant owners register their exact admitted principal here.
 * A copied membership, query selector or native role is never a flag owner. */
import { captureTenantData, denyTenant } from '@mistriwork/engine/server/evidence.js';
import type { TenantMembershipEvidence } from './tenantMembership.js';
import type { PlatformMembershipEvidence } from './tenantPlatform.js';

type FlagMembershipPrincipal = TenantMembershipEvidence | PlatformMembershipEvidence;
interface TenantFlagOwner {
  readonly generation: object;
  readonly principal: FlagMembershipPrincipal;
  current(): Promise<void>;
  assertCurrent(): void;
}
const owners = new WeakMap<object, WeakMap<object, TenantFlagOwner>>();

/** Internal admission hook. Register only after row scope and ordinary grants
 * have been admitted; release in the existing owner's finally block. */
export function bindTenantFlagOwner(
  request: unknown,
  principal: FlagMembershipPrincipal,
  current: () => Promise<void>,
  assertCurrent: () => void,
): () => void {
  // Generic runtimes also support primitive request fixtures. Those cannot
  // acquire this capability; HTTP requests and job-attempt tokens are objects.
  if (!request || typeof request !== 'object') return () => {};
  let byPrincipal = owners.get(request);
  if (!byPrincipal) owners.set(request, (byPrincipal = new WeakMap()));
  const captured = captureTenantData(principal),
    generation = Object.freeze({});
  let active = true;
  const check = () => {
    if (!active || byPrincipal!.get(principal) !== owner) return denyTenant();
    assertCurrent();
  };
  const owner: TenantFlagOwner = Object.freeze({
    generation,
    principal: captured,
    assertCurrent: check,
    async current() {
      check();
      await current();
      check();
    },
  });
  byPrincipal.set(principal, owner);
  return () => {
    active = false;
    if (byPrincipal!.get(principal) === owner) byPrincipal!.delete(principal);
  };
}

export function captureTenantFlagOwner(request: unknown, principal: unknown): TenantFlagOwner {
  const owner =
    request && typeof request === 'object' && principal && typeof principal === 'object' ? owners.get(request)?.get(principal) : undefined;
  if (!owner) return denyTenant();
  owner.assertCurrent();
  return owner;
}
