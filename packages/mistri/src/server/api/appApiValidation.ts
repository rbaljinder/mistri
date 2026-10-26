/** Schema-free stage refusals for the read foundation. Loaders call it on the
 * read half (`readApiApp`) only after checking the authority lock; resource
 * loading repeats it before any database acquisition. Command exposures are
 * checked with their registry by whatever hosts them, never here. */
import type { AppDef } from '../../shared/appModel.js';
import { apiCrossConnectionProblems } from '../../shared/appApi.js';

/** The read half of an App that also exposes commands: the same App with its
 * command exposures projected out, for read catalogs, token scope, rendering
 * and views. Token scope intersects with the catalog, so a command-issued token
 * observes as its read subset. Callers keep checking currentness against the
 * real App. A read-only App is returned as it is. */
export function readApiApp(app: AppDef): AppDef {
  const api = app.api;
  // Generic writes are commands too (apiGenericWrites.ts): the read half carries none.
  const writes = !!api && Object.values(api.resources).some((resource) => resource.create || resource.update || resource.delete);
  if (!api || (!api.commands.length && !writes)) return app;
  return {
    ...app,
    api: {
      ...api,
      commands: [],
      resources: Object.fromEntries(
        Object.entries(api.resources).map(([name, { create: _create, update: _update, delete: _delete, ...read }]) => [name, read]),
      ),
    },
  };
}

export function assertAppApiContext(app: AppDef): void {
  if (!app.api) return;
  if (app.api.commands.length) throw new Error('api.commands: command exposure is not supported by this read foundation.');
  // Tenant Apps are validated against their tenant catalog (apiTenantReadCatalog),
  // and a row-policy App's rows are narrowed by its own deployment, never here:
  // each is served by its own owner (tenantApiReadOwner.ts, policyApiOwner.ts).
  // Several sources are served, one connection per request. What can be seen
  // without a catalog is refused before any database opens; the checked
  // catalog judges every path again (apiReadCatalog.ts).
  const crossing = apiCrossConnectionProblems(app);
  if (crossing.length) throw new Error(crossing[0]);
}
