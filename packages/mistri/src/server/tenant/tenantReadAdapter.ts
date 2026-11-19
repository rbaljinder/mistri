/* The reader a tenant, platform or support context hands an App's reads: the context's own data calls behind the
   Adapter shape, never a connection that could be closed or introspected past the schema it was granted. */
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import { denyTenant } from '@mistriwork/engine/server/evidence.js';
import type { TenantReadContext } from './tenantReadRuntime.js';

/** What a read needs from a context, a tenant's or the platform realm's. Both
 * present their granted commands; only a tenant context presents edits. */
export type ReadContext = Pick<TenantReadContext, 'schema' | 'data'> & {
  readonly capabilities?: TenantReadContext['capabilities'];
  readonly principal: { readonly roles: readonly string[]; readonly tenantId?: string };
  /** A tenant context's zone; the platform realm, which spans tenants, keeps the App's own. */
  readonly zone?: string;
  /** A tenant context's member's own locale; the platform realm reads none, as it reads no zone. */
  readonly locale?: string;
  /** A member's context: many reads asked at once, on one snapshot (tenantReadRuntime.ts). */
  readonly together?: TenantReadContext['together'];
  /** A member's context: the columns of the tenant's profile `auth.tenancy.shared` lists, read for this request. */
  readonly tenant?: TenantReadContext['tenant'];
};
/** `work` with its reads on one snapshot of `context`, where the context can share one; else as it is. */
export const together = <T>(context: ReadContext, work: () => Promise<T>): Promise<T> =>
  context.together ? context.together(work) : work();
export function readAdapter(context: ReadContext): Adapter {
  return Object.freeze({
    dialect: context.schema.dialect,
    introspect: async () => context.schema,
    close: async () => denyTenant(),
    ...context.data,
  });
}
