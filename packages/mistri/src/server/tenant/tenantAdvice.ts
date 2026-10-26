/**
 * What `mistri check` says about a tenant App that startup accepts and that
 * will not behave as written: advice, never a refusal.
 */
import { resolveAppAccess, type AppDef } from '../../shared/app.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { AppTenantPolicy } from '../policy/appTenantPolicy.js';

/**
 * `[tenant-delete-unauthorized]`: a role writes a tenant-owned table and the
 * policy has no `authorizeDeletedRecord`. A delete reads the row's image
 * before it removes it, and with no callback to say who may see that image
 * the runtime answers 403 `forbidden`: Save and New work, Delete never does.
 */
export function tenantDeleteWarnings(
  app: AppDef,
  schema: DatabaseSchema,
  policy: Pick<AppTenantPolicy, 'ownership' | 'authorizeDeletedRecord'>,
): string[] {
  if (policy.authorizeDeletedRecord !== undefined) return [];
  const tables = new Map<string, string[]>();
  for (const role of Object.keys(app.auth?.roles ?? {})) {
    let writable: ReadonlySet<string>;
    try {
      writable = resolveAppAccess(app, schema, [role]).writable;
    } catch {
      // A grant the catalog cannot resolve is validation's to say.
      continue;
    }
    for (const id of writable) if (policy.ownership[id]?.kind === 'tenant') tables.set(id, [...(tables.get(id) ?? []), role]);
  }
  return [...tables].map(
    ([id, roles]) =>
      `table "${id}" [tenant-delete-unauthorized]: ${roles.length === 1 ? `role "${roles[0]}" writes` : `roles ${roles.map((role) => `"${role}"`).join(', ')} write`} it, ` +
      `and the tenant policy has no authorizeDeletedRecord, so a member's Delete is refused with 403 forbidden while Save and New work. ` +
      `Add authorizeDeletedRecord: (member, image) => image.table === '${id}' to defineAppTenantPolicy, or take write from the role${roles.length === 1 ? '' : 's'}.`,
  );
}
