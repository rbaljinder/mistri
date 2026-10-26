/** The read catalog of a tenant App's API: what a token bound to one tenant
 * membership may read. It is the ordinary catalog's validation over the web
 * UI's own tenant-visible catalog and grants — platform-owned tables are not
 * resources there and a tenant's managed ownership column is not a field — so
 * the API exposes nothing a tenant role does not already read in the browser.
 * Row scoping stays with the tenant runtime; this decides only the shapes. */
import { isTenantApp, resolveAppAccess, tenantAppShape, tenantBusinessApp, type AppDef } from '../../shared/app.js';
import type { TenantOwnershipSnapshot } from '../tenant/tenantOwnership.js';
import { tenantAuthoringSchema, tenantVisibleFields } from '../tenant/tenantVisibleFields.js';
import { scopedReadCatalog, type ReadCatalog } from './apiReadCatalog.js';

const fail = (at: string, message: string): never => {
  throw new Error(`${at}: ${message}.`);
};

/** The platform-only source a resource belongs to, or undefined. Its tables are
 * the platform realm's own reads alone: no tenant-bound token reads one. */
function platformOnlySourceOf(app: AppDef, resource: string): string | undefined {
  const source = app.resources?.[resource]?.source;
  return source !== undefined && app.sources?.[source]?.realm === 'platform' ? source : undefined;
}

export function checkApiTenantReadCatalog(app: AppDef, owned: TenantOwnershipSnapshot): ReadCatalog {
  const api = app.api;
  if (!api || !isTenantApp(app) || !tenantAppShape(app) || owned.appId !== app.id)
    return fail('api', 'a tenant catalog needs a tenant App and its attested ownership');
  // A token acts through one tenant membership; the platform realm reads across
  // tenants, which no tenant-bound token may do.
  for (const role of api.roles) {
    const grant = app.auth?.roles?.[role] as { realm?: string } | undefined;
    if (!grant || grant.realm === 'platform') fail('api.roles', `"${role}" is not a tenant role`);
  }
  const bases = [
    ...Object.keys(api.resources),
    ...api.views.flatMap((entry) => {
      const view = app.views[entry.view];
      return view && 'table' in view ? [view.table] : [];
    }),
  ];
  for (const base of bases) {
    const source = platformOnlySourceOf(app, base);
    if (source)
      fail(
        `api.resources.${base}`,
        `"${base}" belongs to the platform-only source "${source}", which only the platform realm's own reads see`,
      );
    if (owned.ownership[base]?.kind === 'platform')
      fail(`api.resources.${base}`, 'a platform-owned resource is not readable in a tenant context');
  }
  // Grants resolve as every business owner's do, on the App without its
  // platform-only sources: their tables are not in this schema, so resolving
  // the whole App's ceiling against it would refuse a legitimate exposure.
  const business = tenantBusinessApp(app);
  const catalog = scopedReadCatalog(api, app, tenantAuthoringSchema(owned), (role) =>
    tenantVisibleFields(owned, resolveAppAccess(business, owned.schema, [role])),
  );
  // The walk's own result, not the top level: a field, filter, sort, standing
  // question or reference hop that resolved into a platform-only source would
  // name it among these dependencies. The tenant schema holds none of its
  // tables, so this is the second layer, not the first.
  for (const operation of catalog.operations) {
    for (const resource of [operation.resource, ...operation.dependencies.map((dependency) => dependency.resource)]) {
      const source = platformOnlySourceOf(app, resource);
      if (source) {
        fail(
          `api.${operation.kind === 'view' ? 'views' : 'resources'}.${operation.id}`,
          `it reaches "${resource}", which belongs to the platform-only source "${source}"`,
        );
      }
    }
  }
  return catalog;
}
