/** Private one-shot read for `api-token issue --tenant`: the tenant App's
 * business catalog, its tenant store and the subject's membership, read
 * natively in one read snapshot of the business database. Not issuance
 * authority, and not one transaction with the auth store that issues: the token
 * binds the membership version read here, so any change after it leaves the
 * token without authority rather than with more. The policy file is trusted
 * operator code; it supplies the store ID and ownership, as serving does. */
import { realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { PostgresAdapter } from '@mistriwork/engine/adapters/postgres.js';
import { readSqliteReadCatalog } from '@mistriwork/engine/adapters/scoped/sqliteScopeCatalog.js';
import { homeSourceOf, isTenantApp, declaredReferences, physicalBindings, tenantAppShape, tenantBusinessApp } from '../../shared/app.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { type LoadedApp } from '../app/apps.js';
import { appResourceCatalog } from '../app/appResources.js';
import { resolveConnection } from '@mistriwork/engine/server/auth/credentials.js';
import type { ConnectionConfig } from '@mistriwork/engine/server/connections.js';
import { loadAppTenantPolicy } from '../policy/appTenantPolicy.js';
import { checkApiTenantReadCatalog } from '../api/apiTenantReadCatalog.js';
import { checkApiTenantCommandCatalog } from '../api/apiTenantCommandCatalog.js';
import { readApiApp } from '../api/appApiValidation.js';
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';
import { captureTenantData } from '@mistriwork/engine/server/evidence.js';
import { captureTenantOwnership } from '../tenant/tenantOwnership.js';
import type { TenantMembershipRecord } from '../tenant/tenantMembership.js';
import { readSqliteTenantMembershipSnapshot } from '../tenant/tenantStore.js';
import { readPostgresTenantMembership } from '../tenant/tenantStorePostgres.js';
import { tenantAuthoringProblems } from '../tenant/tenantAuthoring.js';

const refuse = (): never => {
  throw new Error('Tenant token issuance context is unavailable.');
};

export async function readTenantIssuance(
  loaded: LoadedApp,
  configured: readonly ConnectionConfig[],
  input: { policyFile: string; tenantId: string; accountId: string },
  /** The App's command registry: required exactly when it exposes commands. */
  commands?: BusinessCommandRegistry,
) {
  try {
    const { policyFile, tenantId, accountId } = captureTenantData(input);
    const app = loaded.app,
      source = homeSourceOf(app);
    if (!isTenantApp(app) || !tenantAppShape(app) || !source || !app.sources || !app.api) return refuse();
    if (!!app.api.commands.length !== (commands !== undefined)) return refuse();
    const named = app.sources[source].connection;
    const matches = captureTenantData(configured).filter((connection) => connection.id === named || connection.name === named);
    if (matches.length !== 1 || matches[0].http) return refuse();
    const policy = await loadAppTenantPolicy(policyFile);
    if (policy.appId !== app.id) return refuse();
    // The DSL's owners and the policy's agree exactly, as the tenant host
    // requires. A platform-only source's resources are outside the policy's
    // ownership, exactly as enrollment judges them; no token reads them.
    const outside = (name: string) => {
      const source = app.resources?.[name]?.source;
      return source !== undefined && app.sources?.[source]?.realm === 'platform';
    };
    for (const [name, resource] of Object.entries(app.resources ?? {})) {
      if (outside(name)) continue;
      if (resource.owner !== undefined && policy.ownership[name]?.kind !== resource.owner) return refuse();
    }
    for (const [name, rule] of Object.entries(policy.ownership)) {
      if (rule.kind === 'platform' && app.resources?.[name]?.owner !== 'platform') return refuse();
    }
    const binding = { appId: app.id, source: { id: source, connection: named }, storeId: policy.storeId };
    const lookup = { appId: app.id, accountId, tenantId, source: binding.source, deployment: 'api-token-issuance' };
    const resolved = await resolveConnection(matches[0].name, matches[0].url);
    const postgres = /^postgres(ql)?:\/\//i.test(resolved.url);
    /* Maintenance dispatches on the auth store's engine, where the token is
       kept; the membership is read here, natively, in the business source's
       own. The two may differ: PostgreSQL data beside local SQLite sign-ins. */
    let physical: DatabaseSchema | undefined,
      record: TenantMembershipRecord | null = null;
    if (postgres) {
      const adapter = new PostgresAdapter(resolved.url, 'API token issuance');
      try {
        await adapter.readSnapshot(async (snapshot) => {
          physical = await snapshot.describe();
          record = await readPostgresTenantMembership(snapshot.client, binding, lookup);
        });
      } finally {
        await adapter.close();
      }
    } else {
      const path = resolved.url.replace(/^sqlite:(\/\/)?/i, '');
      if (!path || path.includes('://') || /^file:/i.test(path) || path === ':memory:') return refuse();
      const db = new DatabaseSync(realpathSync(path), { readOnly: true, enableForeignKeyConstraints: true });
      try {
        db.exec('BEGIN');
        physical = readSqliteReadCatalog(db).schema;
        record = readSqliteTenantMembershipSnapshot(db, binding, lookup);
        db.exec('COMMIT');
      } finally {
        if (db.isTransaction) db.exec('ROLLBACK');
        db.close();
      }
    }
    const current = record as TenantMembershipRecord | null;
    if (!physical || !current || current.status !== 'active' || current.tenantStatus !== 'active' || current.validUntil <= Date.now())
      return refuse();
    const catalog = appResourceCatalog(physical, physicalBindings(app, source), declaredReferences(app, source));
    const owned = captureTenantOwnership({
      appId: app.id,
      source: binding.source,
      physicalSchema: physical,
      schema: catalog.schema,
      resources: Object.fromEntries(catalog.schema.tables.map((table) => [table.id, catalog.toPhysical(table.id)])),
      ownership: policy.ownership,
      ...(app.auth?.tenancy?.profile === undefined ? {} : { profile: app.auth.tenancy.profile }),
    });
    // Judged as the business source sees it: a platform-only source's tables are
    // not in this schema, and nothing of that source is ever a token's to read.
    const business = tenantBusinessApp(app),
      own = new Set(Object.keys(business.resources ?? {}));
    // A token is one tenant membership's, so only the tenant realm's authoring
    // is its own: the platform realm's declarations are judged at startup.
    if (
      tenantAuthoringProblems({ ...loaded, app: business, pages: loaded.pages?.filter((page) => own.has(page.base)) ?? [] }, owned, {
        only: 'tenant',
      }).length
    )
      return refuse();
    const reads = checkApiTenantReadCatalog(readApiApp(app), owned);
    // The token's scope is drawn from both halves, as serving draws it.
    const apiCatalog = commands
      ? Object.freeze({
          operations: Object.freeze([...reads.operations, ...checkApiTenantCommandCatalog(app, owned, commands).operations]),
        })
      : reads;
    // Only the tenant realm's roles: the platform realm is never a tenant token's.
    const roles = current.roles.filter((role) => {
      const grant = app.auth?.roles?.[role] as { realm?: string } | undefined;
      return grant !== undefined && grant.realm !== 'platform';
    });
    return Object.freeze({
      catalog: apiCatalog,
      tenant: Object.freeze({
        tenantId,
        membershipId: current.membershipId,
        membershipVersion: current.membershipVersion,
        roles: Object.freeze(roles),
      }),
    });
  } catch {
    return refuse();
  }
}
