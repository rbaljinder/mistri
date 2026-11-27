/* A tenant request's App access, kept per App, catalog and set of roles
   rather than resolved on every admission. */
import { isCapturedTenantData } from '@mistriwork/engine/server/evidence.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { isFixedScopeCatalog } from '@mistriwork/engine/shared/scopeCatalog.js';
import { resolveAppAccess, type AppDef } from '../../shared/app.js';

type Access = ReturnType<typeof resolveAppAccess>;

/* What a set of roles may read and write is a function of the App, the
   catalog and the roles alone. Every admitted request resolved it afresh — each
   role's grants checked against the whole catalog (a field report: a twelfth of
   a loaded server's CPU). Where the App is captured data and the catalog one
   nothing can change, the answer is kept with them, by the roles, and goes when
   they do; a reload captures new ones and starts afresh. Each caller gets its
   own sets, so nothing one request does to them reaches another. */
const resolutions = new WeakMap<object, WeakMap<object, Map<string, Access>>>();
/** Test-only: how many access answers were asked for, and how many of them were resolved rather than kept. */
export const accessCounters = { asked: 0, resolved: 0 };

export function tenantAppAccess(app: AppDef, schema: DatabaseSchema, roles: readonly string[]): Access {
  accessCounters.asked++;
  if (!isCapturedTenantData(app) || !(isCapturedTenantData(schema) || isFixedScopeCatalog(schema))) {
    accessCounters.resolved++;
    return resolveAppAccess(app, schema, roles);
  }
  const key = JSON.stringify(roles);
  let bySchema = resolutions.get(app);
  if (!bySchema) resolutions.set(app, (bySchema = new WeakMap()));
  let byRoles = bySchema.get(schema);
  if (!byRoles) bySchema.set(schema, (byRoles = new Map()));
  let kept = byRoles.get(key);
  if (!kept) {
    accessCounters.resolved++;
    kept = Object.freeze(resolveAppAccess(app, schema, [...roles]));
    byRoles.set(key, kept);
  }
  return kept;
}
