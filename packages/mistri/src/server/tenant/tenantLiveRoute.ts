/**
 * `GET /api/live` on a tenant App: a member's stream of the changes in their
 * own tenant, on the tab's lease (tenantHttp.ts answers it there).
 *
 * The member's authority is read inside their own context, as every read on
 * the lease is, and comes out as plain data: the tables their context serves,
 * the columns of each they read, and their row scope on each with the
 * tenant's own condition taken out — the hub already tells a member only of
 * their tenant's entries (liveFilter.ts), so a scope that is only "this
 * tenant" is every row, and needs no probe. A probe is a read in a context
 * of its own on the same lease, through the member's scoped reader. The lease
 * is asserted again on every probe and every 30 s: a lease renewed, switched
 * or released ends the stream, and the client opens another on its new lease.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LiveKey } from '../../adapters/live/liveChange.js';
import type { AppDef } from '../../shared/app.js';
import { primaryKey } from '@mistriwork/engine/shared/schema.js';
import type { RowScopeFilter } from '@mistriwork/engine/shared/rowScope.js';
import { scopeFingerprint, type LiveAuthority, type LiveGrant } from '../live/liveFilter.js';
import type { LiveHub } from '../live/liveHub.js';
import { probedKeys, readColumns } from '../live/liveRoute.js';
import { openLiveStream } from '../live/liveStream.js';
import { tenantServedSchema } from './tenantServedSchema.js';
import { tenantLiveRowsOf, type TenantReadContext } from './tenantReadRuntime.js';
import type { TenantOwnershipSnapshot } from './tenantOwnership.js';

/** What leaves a member's context: data only, never a function or the context. */
interface TenantLiveGrants {
  readonly tenantId: string;
  readonly accountId: string;
  readonly tables: ReadonlyArray<{
    readonly id: string;
    readonly physical: string;
    readonly key: readonly string[];
    readonly columns: readonly string[];
    readonly scope: true | RowScopeFilter;
  }>;
}

/** A member's grants, read in their context. Throws where the context is not this runtime's. */
export function tenantLiveGrants(
  context: TenantReadContext,
  app: AppDef,
  ownership: TenantOwnershipSnapshot,
  now: number,
): TenantLiveGrants {
  const rows = tenantLiveRowsOf(context);
  if (!rows) throw new Error('Not a tenant read context.');
  const tenantId = context.principal.tenantId;
  const served = tenantServedSchema(context, app, new Date(now));
  const columns = readColumns(served);
  const tables: Array<TenantLiveGrants['tables'][number]> = [];
  for (const table of served.tables) {
    if (app.resources?.[table.id]?.live === false) continue;
    const physical = ownership.resources[table.id],
      rule = ownership.ownership[table.id],
      scope = rows[table.id];
    if (physical === undefined || rule === undefined || scope === undefined || scope === false) continue;
    let filter: true | RowScopeFilter = scope;
    if (scope !== true && rule.kind === 'tenant') {
      const ownTenant = (condition: RowScopeFilter['groups'][number][number]) =>
        condition.column === rule.column && condition.op === '=' && condition.value === tenantId && condition.other === undefined;
      const groups = scope.groups.map((group) => group.filter((condition) => !ownTenant(condition)));
      filter = groups.some((group) => group.length === 0) ? true : { groups, ...(scope.binary ? { binary: scope.binary } : {}) };
    }
    tables.push({ id: table.id, physical, key: primaryKey(table), columns: [...(columns.get(table.id) ?? [])], scope: filter });
  }
  return { tenantId, accountId: context.principal.accountId, tables };
}

/** A member's authority on the writer's hub, from their grants and a probe on their lease. */
export function tenantLiveAuthority(
  appId: string,
  grants: TenantLiveGrants,
  actor: string,
  probe: (table: string, keys: readonly LiveKey[]) => Promise<readonly string[]>,
): LiveAuthority {
  const tables = new Map<string, LiveGrant>();
  const logical = new Map<string, string>();
  for (const table of grants.tables) {
    tables.set(
      table.physical,
      Object.freeze({
        id: table.id,
        key: table.key,
        columns: new Set(table.columns),
        scope: table.scope,
        /* The tenant is in the digest: two tenants' members never share a probe, though their scopes read alike. */
        fingerprint: scopeFingerprint(`${appId}\u0000${grants.tenantId}`, table.physical, table.scope),
      }),
    );
    logical.set(table.physical, table.id);
  }
  return Object.freeze({
    actor,
    tenant: grants.tenantId,
    tables,
    probe: async (table: string, keys: readonly LiveKey[]) => {
      const id = logical.get(table);
      if (!id) return new Set<string>();
      return new Set(await probe(id, keys));
    },
  });
}

/** Which of `keys` a member's context reads now, as key texts: plain data out of the context. */
export const tenantProbe = (context: TenantReadContext, table: string, keys: readonly LiveKey[]): Promise<string[]> =>
  probedKeys((request) => context.data.query(request), table, keys).then((found) => [...found]);

/** Open the stream, once the lease admitted the first resolution. */
export function openTenantLiveStream(options: {
  req: IncomingMessage;
  res: ServerResponse;
  hub: LiveHub;
  account: string;
  cursor?: string;
  authority: LiveAuthority;
  resolve: () => Promise<LiveAuthority>;
  headers: Readonly<Record<string, string>>;
  off?: readonly string[];
}): Promise<void> {
  return openLiveStream({
    req: options.req,
    res: options.res,
    account: options.account,
    hubs: [options.hub],
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    authority: [options.authority],
    resolve: async () => [await options.resolve()],
    headers: options.headers,
    ...(options.off?.length ? { off: options.off } : {}),
  });
}
