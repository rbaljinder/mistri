/** The command catalog of a tenant App's API: what a token bound to one tenant
 * membership may run. The ordinary catalog's checks, under the tenant runtime's
 * own authority — its one source, and its managed ownership columns — so the
 * API exposes no command the web UI's tenant commands would not run. The
 * runtime still authorizes every call; this decides the shapes and who is
 * eligible, and refuses what a tenant token must never be offered. */
import { isTenantApp, logicalResource, tenantAppShape, tenantBusinessApp, type AppDef } from '../../shared/app.js';
import { primaryKey } from '@mistriwork/engine/shared/schema.js';
import { defineCommands, type BusinessCommandRegistry } from '../commands/businessCommands.js';
import type { TenantOwnershipSnapshot } from '../tenant/tenantOwnership.js';
import { tenantAuthoringSchema } from '../tenant/tenantVisibleFields.js';
import { scopedCommandCatalog } from './apiCommandCatalog.js';

/** The operations a tenant token's scope is drawn from: reads, and commands
 * when the App exposes them. Only identity and eligibility — never grants. */
export type ApiTenantCatalog = Readonly<{ operations: readonly Readonly<{ id: string; eligibleRoles: readonly string[] }>[] }>;

const fail = (at: string, message: string): never => {
  throw new Error(`${at}: ${message}.`);
};

/** The tenant runtime's connection evidence, as bindTenantCommands states it:
 * every owned resource is on the one tenant source, which is the writer. */
export function tenantCommandEvidence(owned: TenantOwnershipSnapshot) {
  const connection = owned.source.connection;
  return Object.freeze({
    connectionFor: (resource: string) =>
      Object.hasOwn(owned.resources, resource) ? connection : fail('api.commands', 'an unowned resource'),
    writableConnection: (id: string) => id === connection,
    transactionalConnection: (id: string) => id === connection,
  });
}

export function checkApiTenantCommandCatalog(app: AppDef, owned: TenantOwnershipSnapshot, declared: BusinessCommandRegistry) {
  const api = app.api;
  if (!api || !isTenantApp(app) || !tenantAppShape(app) || owned.appId !== app.id)
    return fail('api', 'a tenant catalog needs a tenant App and its attested ownership');
  for (const role of api.roles) {
    const grant = app.auth?.roles?.[role] as { realm?: string } | undefined;
    if (!grant || grant.realm === 'platform') fail('api.roles', `"${role}" is not a tenant role`);
  }
  const registry = defineCommands(declared),
    visible = tenantAuthoringSchema(owned);
  for (const { command: ref } of api.commands) {
    const command = registry[ref.id],
      at = `api.commands.${ref.id}`;
    // Unregistered: the shared checks below name it.
    if (!command) continue;
    // One membership's commands: the platform realm acts across tenants.
    if ((command.realm ?? 'tenant') !== 'tenant') fail(at, "a platform-realm command is not a tenant token's");
    // The runtime's own rule (bindTenantCommands), stated before publication.
    if (command.source !== owned.source.id || command.write.some((table) => owned.ownership[table]?.kind !== 'tenant')) {
      fail(at, 'a tenant command writes only tenant-owned tables on the tenant source');
    }
    // A caller spells a target's key as the tenant-visible schema has it. A
    // key holding the managed tenant column would be spelled differently by
    // the runtime, so it is refused rather than guessed.
    if ('target' in ref) {
      const resource = logicalResource(app, command.source, command.target);
      const full = owned.schema.tables.find((table) => table.id === resource),
        shown = visible.tables.find((table) => table.id === resource);
      if (!full || !shown || JSON.stringify(primaryKey(full)) !== JSON.stringify(primaryKey(shown))) {
        fail(at, "a tenant command's target key must not include its tenant column");
      }
    }
  }
  const managedOwnership = Object.fromEntries(
    Object.entries(owned.ownership).flatMap(([id, rule]) => (rule.kind === 'tenant' ? [[id, rule.column]] : [])),
  );
  // The App as its own source sees it: a platform-only source's tables are not
  // in this schema, so resolving the whole App's ceiling against it would
  // refuse a legitimate exposure. No command reaches that source either way.
  return scopedCommandCatalog(api, tenantBusinessApp(app), owned.schema, registry, { ...tenantCommandEvidence(owned), managedOwnership });
}
