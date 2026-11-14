/**
 * The owner's reader of a connection under the row-security backstop (docs/postgresql.md), for the paths that read
 * through a registry rather than a tenant host: `--reindex`, and the profile table a local sign-in is made a member of.
 *
 * `registry.open` connects as `url`, the runtime role, which the pinned policy binds: with no tenant set it reads no
 * row of a tenant table. These paths cross tenants by design (a document keeps its row's tenant; a profile row is a
 * tenant), so they read as the owner, whose role the policy does not bind. The roles are attested here as enrollment
 * attests them, so a pair that is not the backstop's refuses before anything is read.
 */
import { PostgresAdapter } from '@mistriwork/engine/adapters/postgres.js';
import { resolveConnection } from '@mistriwork/engine/server/auth/credentials.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';

/** An adapter on the owner's URL for the connection `id`, or undefined when it is not under the backstop. The caller closes it. */
export async function openBackstopOwnerReader(registry: Registry, id: string): Promise<PostgresAdapter | undefined> {
  const config = registry.configOf(id);
  if (config?.backstop !== 'rls' || config.owner === undefined) return undefined;
  const options = { secrets: true, ...(registry.environment ? { environment: registry.environment } : {}) };
  const url = (await resolveConnection(config.name, config.url, options)).url;
  const owner = (await resolveConnection(config.name, config.owner, options)).url;
  const { attestBackstopRoles } = await import('./tenantEnrollment.js');
  const { role } = await attestBackstopRoles(url, owner, []);
  return new PostgresAdapter(owner, 'Backstop owner reader', [], undefined, undefined, { rowSecurity: { role, bypass: true } });
}

/**
 * Refuses `who` a connection under the backstop: only a tenant App reads through it, because `url` is then the
 * runtime role, which the pinned policy binds, and a read with no tenant set sees no tenant row. A non-tenant App or
 * the Workbench pointed at it would start, paint empty tables and look like a database with no data, so the start
 * refuses instead. `names` narrows it to the connections an App binds.
 */
export function assertNoBackstop(
  registry: Pick<Registry, 'configs'>,
  who: 'a non-tenant App' | 'the Workbench',
  names?: readonly string[],
): void {
  const found = registry
    .configs()
    .find((config) => config.backstop === 'rls' && (names === undefined || names.includes(config.name) || names.includes(config.id)));
  if (!found) return;
  throw new Error(
    `connection "${found.name}" is under the row-security backstop ("backstop": "rls"); only a tenant App reads through it — ${who} would see none of its tenant rows. Point it at the owner's URL instead, or remove "backstop".`,
  );
}
