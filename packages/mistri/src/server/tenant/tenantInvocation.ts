import { isPromise, isProxy } from 'node:util/types';
import { denyTenant } from '@mistriwork/engine/server/evidence.js';
import type { TenantMembershipEvidence } from './tenantMembership.js';
import type { PlatformMembershipEvidence } from './tenantPlatform.js';

/** Either realm's admission evidence. A guard is issued for one realm and only
 * ever called with that realm's evidence: each context owner admits in one. */
type InvocationPrincipal = TenantMembershipEvidence | PlatformMembershipEvidence;
/** Private narrowing lease, issued by the server context owner. Never a request
 * body's membership credential or a replacement for the underlying issuer. */
export type TenantInvocationGuard<P extends InvocationPrincipal = TenantMembershipEvidence> = (principal: P) => void;
type Verify<P> = (principal: P) => void | Promise<void>;
const verification = new WeakMap<TenantInvocationGuard<never>, Verify<never>>();
export function tenantInvocationGuard<P extends InvocationPrincipal = TenantMembershipEvidence>(
  assert: TenantInvocationGuard<P>,
  verify?: Verify<P>,
): TenantInvocationGuard<P> {
  if (typeof assert !== 'function' || isProxy(assert) || (verify !== undefined && (typeof verify !== 'function' || isProxy(verify))))
    return denyTenant();
  const guard: TenantInvocationGuard<P> = (principal) => checkTenantInvocation(assert, principal);
  if (verify) verification.set(guard as TenantInvocationGuard<never>, verify as Verify<never>);
  return guard;
}
const verifier = <P>(guard: TenantInvocationGuard<P & InvocationPrincipal> | undefined): Verify<P> | undefined =>
  guard && (verification.get(guard as TenantInvocationGuard<never>) as Verify<P> | undefined);
/** Cancellation adds a synchronous check without dropping the context's private
 * asynchronous session-instance verification. Nothing is stored on functions. */
export function narrowTenantInvocation<P extends InvocationPrincipal = TenantMembershipEvidence>(
  parent: TenantInvocationGuard<P> | undefined,
  assert: TenantInvocationGuard<P>,
): TenantInvocationGuard<P> {
  return tenantInvocationGuard<P>((principal) => {
    checkTenantInvocation(parent, principal);
    checkTenantInvocation(assert, principal);
  }, verifier<P>(parent));
}
export function revalidateTenantInvocation<P extends InvocationPrincipal = TenantMembershipEvidence>(
  guard: TenantInvocationGuard<P> | undefined,
  principal: P,
): void | Promise<void> {
  const verify = verifier<P>(guard);
  if (!verify) return;
  checkTenantInvocation(guard, principal);
  const result = verify(principal);
  const done = (value: unknown) => {
    if (value !== undefined) return denyTenant();
    checkTenantInvocation(guard, principal);
  };
  if (isPromise(result)) return Promise.prototype.then.call(result, done, () => denyTenant()) as Promise<void>;
  done(result);
}
export function checkTenantInvocation<P extends InvocationPrincipal = TenantMembershipEvidence>(
  guard: TenantInvocationGuard<P> | undefined,
  principal: P,
): void {
  if (guard === undefined) return;
  if (typeof guard !== 'function' || isProxy(guard)) return denyTenant();
  const result = guard(principal);
  if (isPromise(result)) void Promise.prototype.then.call(result, undefined, () => {});
  if (result !== undefined) denyTenant();
}
