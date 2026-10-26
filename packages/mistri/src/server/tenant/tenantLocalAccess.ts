/**
 * Memberships for people on this machine: a test host's setup (http/testControl.ts, `host.tenant`) and the
 * sign-ins `mistri dev` prints (cli/devMode.ts). Neither is a door of the App: each runs the operator steps of
 * `@mistriwork/mistri/maintenance` (tenantMaintenance.ts) on the served App's own database, under its policy's binding, in
 * their own journaled transactions, as a deployment's seed script does. Whoever calls this is the operator; the
 * App's grants, the role ceilings and the one-live-membership rule are the steps' own, so nothing here reaches past
 * what an operator may do, and nothing serves it to a browser.
 */
import type { LoadedApp } from '../app/apps.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import { resolveConnection } from '@mistriwork/engine/server/auth/credentials.js';
import { storeTargetOf } from '../commands/appCommandEvents.js';
import { homeSourceOf } from '../../shared/appModel.js';
import { primaryKey, tableNamed } from '@mistriwork/engine/shared/schema.js';
import { PLATFORM_TENANT_ID } from '@mistriwork/engine/shared/sessionLease.js';
import {
  grantPlatformMembership,
  grantTenantMembership,
  putTenant,
  setPlatformStatus,
  TenantMaintenanceRefusal,
  type TenantMaintenanceTarget,
} from './tenantMaintenance.js';
import type { TenantStoreBinding } from './tenantStore.js';

interface TenantLocalAccess {
  readonly dir: string;
  readonly target: TenantMaintenanceTarget;
  readonly binding: TenantStoreBinding;
}

/** Where the served tenant App's store is, and the binding its policy made it under, as `migrate stores up` binds it. */
export async function tenantLocalAccess(loaded: LoadedApp, registry: Registry, policyFile: string): Promise<TenantLocalAccess> {
  const { loadAppTenantPolicy } = await import('../policy/appTenantPolicy.js');
  const policy = await loadAppTenantPolicy(policyFile);
  const app = loaded.app;
  const source = homeSourceOf(app);
  const home = source === undefined ? undefined : app.sources?.[source]?.connection;
  if (source === undefined || home === undefined) throw new Error(`${app.name} names no source its tenants' rows are kept in.`);
  const config = registry.configs().find((each) => each.id === home || each.name === home);
  if (!config) throw new Error(`The App's connection "${home}" is not one this server serves.`);
  const { url } = await resolveConnection(config.name, config.url, { secrets: true });
  const target = storeTargetOf(url);
  if (!target) throw new Error("A tenant App's store is kept in SQLite or PostgreSQL.");
  if (!loaded.dir) throw new Error(`${app.name} was not loaded from a directory, which the maintenance steps read its roles from.`);
  return Object.freeze({
    dir: loaded.dir,
    target,
    binding: { appId: app.id, source: { id: source, connection: home }, storeId: policy.storeId },
  });
}

/**
 * The first tenants of the App's profile table (`auth.tenancy.profile`), by its key: who a local member is made a
 * member of, where nothing names one. None where the App has no profile or its table cannot be read.
 */
export async function profileTenants(loaded: LoadedApp, registry: Registry, limit: number): Promise<string[]> {
  const app = loaded.app;
  const profile = app.auth?.tenancy?.profile;
  if (!profile) return [];
  const source = homeSourceOf(app);
  const bound = app.connection ?? (source === undefined ? undefined : app.sources?.[source]?.connection);
  const connection = registry.list().find((each) => each.id === bound || each.name === bound) ?? registry.list()[0];
  if (!connection) return [];
  const { adapter, schema } = await registry.open(connection.id);
  const table = tableNamed(schema, app.resources?.[profile]?.physical ?? profile);
  const [key] = table ? primaryKey(table) : [];
  if (!table || !key) return [];
  const rows = await adapter.query({ table: table.id, columns: [key], limit, offset: 0, orderBy: [{ column: key, direction: 'asc' }] });
  return rows.rows.map((row) => String(row[key]));
}

/* A step that found what it would make already there: the steps refuse it, and here it is what was wanted. */
const already = (error: unknown) =>
  error instanceof TenantMaintenanceRefusal && /version given is not the current one|already holds a live/.test(error.message);

/** The tenant (or `@platform`), made active when it is not there yet; one that is there is left as it is. */
export async function ensureLocalTenant(access: TenantLocalAccess, tenantId: string, operator: string): Promise<void> {
  try {
    if (tenantId === PLATFORM_TENANT_ID)
      await setPlatformStatus(access.target, access.binding, { status: 'active', expectedVersion: null, operator });
    else await putTenant(access.target, access.binding, { tenantId, status: 'active', expectedVersion: null, operator });
  } catch (error) {
    if (!already(error)) throw error;
  }
}

/**
 * One membership of an existing account in the tenant, or in the platform realm under `@platform`, with these
 * roles, for `days`. True when made; false when the account already held a live one there, which is kept as it is.
 */
export async function grantLocalMembership(
  access: TenantLocalAccess,
  input: Readonly<{ tenantId: string; accountId: string; roles: readonly string[]; days: number; operator: string }>,
): Promise<boolean> {
  const validUntil = Date.now() + input.days * 24 * 60 * 60 * 1000;
  const common = { app: access.dir, accountId: input.accountId, roles: input.roles, validUntil, operator: input.operator };
  try {
    if (input.tenantId === PLATFORM_TENANT_ID) await grantPlatformMembership(access.target, access.binding, common);
    else await grantTenantMembership(access.target, access.binding, { ...common, tenantId: input.tenantId });
    return true;
  } catch (error) {
    if (already(error)) return false;
    throw error;
  }
}
