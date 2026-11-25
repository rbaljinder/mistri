/**
 * `mistri --export openapi` for a tenant App: the document its API serves,
 * without serving. The tenant catalogs are judged against the policy's
 * ownership and the database's shape, so the policy is read for that and for
 * nothing else; no auth store is opened, no principal admitted, and no row is
 * read. What the document says is static: the catalogs, the owned columns and
 * the commands' declarations.
 */
import { declaredReferences, homeSourceOf, physicalBindings, tenantAppShape, tenantBusinessApp, type AppDef } from '../../shared/app.js';
import type { LoadedApp } from '../app/apps.js';
import { appResourceCatalog } from '../app/appResources.js';
import { appSourceConnections } from '../app/appRuntimeResources.js';
import { loadAppTenantPolicy } from '../policy/appTenantPolicy.js';
import { readApiApp } from '../api/appApiValidation.js';
import { checkApiTenantReadCatalog } from '../api/apiTenantReadCatalog.js';
import { checkApiTenantCommandCatalog, tenantCommandEvidence } from '../api/apiTenantCommandCatalog.js';
import { renderAppApiOpenApi } from '../api/apiPublicSpec.js';
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';
import { captureTenantOwnership, type TenantOwnershipSnapshot } from './tenantOwnership.js';
import { tenantAuthoringSchema } from './tenantVisibleFields.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import { refusalsOf } from '../api/apiRefusals.js';

export async function tenantAppOpenApi(
  registry: Registry,
  loaded: LoadedApp,
  policyFile: string | undefined,
  integers: 'decimal-string' | 'number',
  commands: BusinessCommandRegistry | undefined,
): Promise<string> {
  const app = loaded.app;
  const source = homeSourceOf(app);
  if (!policyFile?.trim() || policyFile.startsWith('-'))
    throw new Error("--export openapi of a tenant App needs --policy <file>: its ownership is part of the document's shape.");
  if (!tenantAppShape(app) || !source || !app.sources)
    throw new Error('A tenant App needs native auth with auth.rows "tenant" and one named source.');
  if (app.api!.commands.length && !commands)
    throw new Error(
      'This App exposes API commands: --export openapi needs its commands module, commands.ts beside the manifest or --commands <file>.',
    );
  const policy = await loadAppTenantPolicy(policyFile);
  const entry = appSourceConnections(registry, tenantBusinessApp(app)).get(source);
  if (!entry) throw new Error(`App "${app.name}" names an unconfigured or ambiguous connection.`);
  const { schema: physical } = await registry.open(entry);
  const catalog = appResourceCatalog(physical, physicalBindings(app, source), declaredReferences(app, source));
  const owned = captureTenantOwnership({
    appId: app.id,
    source: { id: source, connection: app.sources[source].connection },
    physicalSchema: physical,
    schema: catalog.schema,
    resources: Object.fromEntries(catalog.schema.tables.map((table) => [table.id, catalog.toPhysical(table.id)])),
    ownership: policy.ownership,
    ...(app.auth?.tenancy?.profile === undefined ? {} : { profile: app.auth.tenancy.profile }),
  });
  return JSON.stringify(tenantApiDocument(app, owned, integers, commands), null, 2);
}

/** The document itself, from the App and its attested ownership: what the export prints and what serving answers from. */
function tenantApiDocument(
  app: AppDef,
  owned: TenantOwnershipSnapshot,
  integers: 'decimal-string' | 'number',
  commands: BusinessCommandRegistry | undefined,
): unknown {
  const reads = checkApiTenantReadCatalog(readApiApp(app), owned);
  const exposed = commands ? checkApiTenantCommandCatalog(app, owned, commands) : undefined;
  return renderAppApiOpenApi(app, tenantAuthoringSchema(owned), {
    integers,
    ...(commands ? { commands } : {}),
    evidence: tenantCommandEvidence(owned),
    tenant: { reads, ...(exposed ? { commands: exposed } : {}) },
  });
}

/**
 * What the export would refuse, for `mistri check` (tenantFeatureApi.ts): the same catalogs and the same render, so a
 * refusal is found while the App is written. The reads and the commands are judged apart, and within each catalog
 * every exposure on its own, so one run says every refused exposure (api/apiRefusals.ts). An App that exposes commands and was given no
 * registry is judged on its reads alone, as an ordinary App's check is.
 */
export function tenantApiProblems(app: AppDef, owned: TenantOwnershipSnapshot, commands: BusinessCommandRegistry | undefined): string[] {
  if (!app.api) return [];
  const problems: string[] = [];
  const judged = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      problems.push(...(refusalsOf(error) ?? [(error as Error).message]));
    }
  };
  const exposed = app.api.commands.length > 0 && commands ? commands : undefined;
  judged(() => checkApiTenantReadCatalog(readApiApp(app), owned));
  if (exposed) judged(() => checkApiTenantCommandCatalog(app, owned, exposed));
  // The render's own refusals, once the catalogs stand: it reads them again, so a refused catalog is not said twice.
  if (!problems.length) judged(() => tenantApiDocument(app, owned, 'decimal-string', exposed));
  return problems;
}
