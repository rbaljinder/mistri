/** An App API request inside a tenant deployment, or a row-policy App's
 * (policyApiOwner.ts): not an HTTP request and not a session. The deployment
 * has one verifier, bound when it is enrolled or loaded; that verifier asks an
 * API request who is calling, and the request answers by observing its bearer
 * token natively each time it is asked. So the tenant runtime's revalidation,
 * before and after every operation and before a write's COMMIT, re-reads the
 * token as it re-reads the membership; a row-policy deployment asks once, as
 * it asks a session, when it builds the context.
 *
 * Only trusted composition can make one: the brand is this module's WeakMap,
 * never a property of the object, and nothing a client sends can reach it.
 * Browser requests are never in it, so they keep their session verifier. The
 * notice sender makes one too (tenantNoticeMail.ts): a read as the recipient's
 * own membership, its account looked up again each time it is asked. */
import type { Identity } from '../auth/auth.js';
import { captureTenantData, denyTenant } from '@mistriwork/engine/server/evidence.js';

const requests = new WeakMap<object, { verify: () => Promise<Identity>; roles: readonly string[] }>();

/** `roles`: the token's own roles. A token acts under those alone — never the
 * wider grants its member may hold, or gain after it was issued. */
export function createTenantApiRequest(verify: () => Promise<Identity>, roles: readonly string[]): object {
  if (typeof verify !== 'function' || !Array.isArray(roles) || roles.some((role) => typeof role !== 'string')) return denyTenant();
  const request = Object.freeze(Object.create(null) as object);
  requests.set(request, { verify, roles: Object.freeze([...roles]) });
  return request;
}

/** The enrolled deployment's verifier: an API request answers for itself;
 * any other request is the host's session verifier's to answer. */
export function withTenantApiRequests<Request>(verify: (request: Request) => Identity | null | Promise<Identity | null>) {
  return async (request: Request): Promise<Identity | null> => {
    const api = request !== null && typeof request === 'object' ? requests.get(request as object) : undefined;
    return api ? api.verify() : verify(request);
  };
}

/** The principal a request's grants and authored rows are computed for: the
 * admitted membership, narrowed to the token's roles for an API request. The
 * membership evidence itself is untouched — its fences compare the stored
 * roles — so only what is granted from it narrows. */
export function actingPrincipal<P extends { readonly roles: readonly string[] }>(request: unknown, principal: P): P {
  const api = request !== null && typeof request === 'object' ? requests.get(request) : undefined;
  if (!api) return principal;
  return captureTenantData({ ...principal, roles: principal.roles.filter((role) => api.roles.includes(role)) });
}
