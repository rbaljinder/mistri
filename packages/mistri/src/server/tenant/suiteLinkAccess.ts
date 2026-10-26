/** Target-native availability for a suite link, never a transferable read context. */
import type { IncomingMessage } from 'node:http';
import type { BoundAppTarget } from '@mistriwork/engine/shared/appLinks.js';
import { tableNamed } from '@mistriwork/engine/shared/schema.js';
import type { SuiteLinkApp } from '../app/suiteLinks.js';
import type { SuiteLinkTenantAccess } from '../auth/suiteLinkHttp.js';
import type { TenantEnrollment } from './tenantEnrollment.js';
import type { TenantReadContext } from './tenantReadRuntime.js';
import type { PlatformReadContext } from './tenantPlatformReadRuntime.js';
import { projectTenantMetadata } from './tenantMetadata.js';
import { tenantInvocationGuard } from './tenantInvocation.js';

/** Membership roles and row-policy visibility belong to the target realm.
 * Record availability covers its resource; the final target read checks the row. */
function visible(catalog: SuiteLinkApp, target: BoundAppTarget, context: TenantReadContext | PlatformReadContext): boolean {
  const realm = target.tenant?.kind === 'platform' ? 'platform' : 'tenant';
  const surface = catalog.surfaces.find((item) => item.realm === realm);
  if (!surface) return false;
  if (target.kind === 'home') return true;
  if (target.kind === 'record') {
    const table = surface.resources?.[target.resource] ?? tableNamed(surface.schema, target.resource)?.id;
    return context.schema.tables.some((item) => item.id === table) && table !== undefined && surface.book.records.has(table);
  }
  const metadata = projectTenantMetadata(
    catalog.app,
    catalog.pages,
    context.schema,
    context.capabilities,
    context.principal.roles,
    realm,
    context.zone,
  );
  return Object.hasOwn(metadata.app.views, target.view);
}

/** Capture the already-open enrollment and its host's retirement fence. No source
 * selector or browser context is admitted into the target's native discovery. */
export function createSuiteLinkAccess(enrollment: TenantEnrollment<IncomingMessage>, active: () => void): SuiteLinkTenantAccess {
  return async (request, target, catalog, accountId, guard) => {
    const assertCurrent = () => {
      active();
      guard.assertCurrent();
    };
    const observe = async () => {
      assertCurrent();
      await guard.observe();
      assertCurrent();
    };
    await observe();
    const discovery = await enrollment.discover(request, observe);
    await observe();
    if (discovery.status !== 'ready' || discovery.appId !== target.app || discovery.accountId !== accountId) return false;
    const tenantId = target.tenant?.kind === 'tenant' ? String(target.tenant.id) : undefined;
    if (
      target.tenant?.kind === 'platform'
        ? discovery.platform !== true
        : tenantId !== undefined
          ? !discovery.memberships.some((item) => item.tenantId === tenantId)
          : !discovery.memberships.length && !(target.kind === 'home' && discovery.platform === true)
    )
      return false;
    const checkPrincipal = (principal: TenantReadContext['principal'] | PlatformReadContext['principal']) => {
      assertCurrent();
      if (principal.accountId !== accountId || principal.appId !== target.app) throw new Error('Wrong target principal.');
    };
    let allowed = false;
    if (target.tenant?.kind === 'platform') {
      allowed = await enrollment.deployment.withPlatformContext(
        request,
        (context) => visible(catalog, target, context),
        tenantInvocationGuard<PlatformReadContext['principal']>(checkPrincipal, observe),
      );
    } else if (tenantId !== undefined) {
      allowed = await enrollment.deployment.withContext(
        request,
        [tenantId],
        (context) => visible(catalog, target, context),
        tenantInvocationGuard(checkPrincipal, observe),
      );
    } else if (target.kind === 'home') {
      allowed = true; // The target's native chooser will establish its own context.
    } else {
      for (const membership of discovery.memberships) {
        allowed = await enrollment.deployment.withContext(
          request,
          [membership.tenantId],
          (context) => visible(catalog, target, context),
          tenantInvocationGuard(checkPrincipal, observe),
        );
        if (allowed) break;
      }
    }
    await observe();
    return allowed;
  };
}
