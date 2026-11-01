/**
 * Search for a tenant App: a search provider's index beside PostgreSQL (or
 * SQLite), as an ordinary App has it (appSearchRuntime.ts), with every tenant
 * in one index.
 *
 * One collection per searched resource of the App — not one per tenant. Each
 * document keeps its record's tenant (`mistri_tenant`), and every search a
 * tenant's context asks names that tenant as a filter the engine applies
 * before it ranks. Why one: a deployment's tenants come and go by the
 * thousand, an engine's collection is a schema and an in-memory index of its
 * own, and a collection per tenant would be made at a tenant's creation,
 * migrated with every field the App adds, and reindexed one by one. One
 * collection is one schema, one reindex and the engine's own documented way
 * to serve many tenants. An engine's scoped search keys can embed such a
 * filter in a key a browser could hold; here no key leaves the server, so the
 * filter is composed on it from the tenant the lease admitted, never from
 * anything a request says.
 *
 * And the engine is never the boundary. The keys it answers are read through
 * the context's own reader, under its tenant, grants and row scope, as every
 * row is (`tenantSearchAdapter`); an index that held a wrong document could
 * narrow a list, never show a row of another tenant.
 *
 * The index follows the source's writes, whatever wrote them — a member's
 * edit, a command, a job, an intake, the App API — through the writer's
 * commit observer (tenantWriteSource.ts): each record written is re-read from
 * the database, its tenant with it, and its document written or removed, off
 * the request, as an ordinary App's are. `--reindex --policy` fills it from
 * scratch.
 */
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import type { AppDef } from '../../shared/appModel.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import type { AppTenantPolicy } from '../policy/appTenantPolicy.js';
import { indexerFor, tenantSearchAdapter } from '../app/appSearchRuntime.js';
import { searchProviderOf } from '../app/searchProvider.js';
import type { TenantOwnershipSnapshot } from './tenantOwnership.js';
import { observeTenantCommits } from './tenantWriteSource.js';

/** What the tenant host is handed: a reader made searchable, and nothing of the registry behind it. */
export interface TenantSearch {
  /** `adapter` (a context's own reader) with text filters on searched fields asked of the engine, within `tenantId`. */
  reader(adapter: Adapter, schema: DatabaseSchema, tenantId: string): Adapter;
  /** Stop following the writer. */
  close(): void;
}

/** Each tenant-owned resource's tenant column, by its logical name. */
export function tenantSearchColumns(
  ownership: AppTenantPolicy['ownership'] | TenantOwnershipSnapshot['ownership'],
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(ownership).flatMap(([resource, rule]) =>
      rule && rule.kind === 'tenant' && typeof rule.column === 'string' ? [[resource, rule.column]] : [],
    ),
  );
}

/** The tenant App's search, or undefined when it declares none or no search provider is plugged in. */
export function openTenantSearch(
  input: Readonly<{ registry: Registry; app: AppDef; ownership: TenantOwnershipSnapshot }>,
): TenantSearch | undefined {
  const { registry, app, ownership } = input;
  const searched = Object.entries(app.resources ?? {}).filter(([, resource]) => resource.search);
  if (!searched.length || !searchProviderOf(registry)) return undefined;
  const tenantColumns = tenantSearchColumns(ownership.ownership);
  const named = ownership.source.connection;
  const connection = registry.list().find((each) => each.id === named || each.name === named)?.id ?? named;
  const indexer = indexerFor(registry);
  const stop = observeTenantCommits(ownership, (writes) => {
    for (const write of writes) {
      const physical = ownership.resources[write.table];
      if (physical === undefined) continue;
      // Its own document when it is searched, and the documents that copy it through a path (`requester.name`).
      indexer.touched(
        app,
        { connection, resource: write.table, physical },
        write.key,
        tenantColumns[write.table],
        tenantColumns,
        write.tenant,
      );
    }
  });
  return Object.freeze({
    reader: (adapter: Adapter, schema: DatabaseSchema, tenantId: string) =>
      tenantSearchAdapter(adapter, { registry, app, schema, tenantId, tenantColumns }),
    close: stop,
  });
}
