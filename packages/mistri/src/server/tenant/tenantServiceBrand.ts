/* The service bindings bindTenantServices built, and no other: a structural lookalike is not one. A module of its
   own so the command access module can ask without importing the binding it vouches for. */
import { denyTenant } from '@mistriwork/engine/server/evidence.js';

const bindings = new WeakSet<object>();
export function brandTenantServices(services: object): void {
  bindings.add(services);
}
/** The binding itself when bindTenantServices built it; anything else is refused. */
export function captureTenantServices<T extends object>(services: T): T {
  if (!bindings.has(services)) return denyTenant();
  return services;
}
