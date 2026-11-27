/**
 * Server boot plumbing for horizontally sharded non-tenant App sources.
 *
 * When a connection in `mistri.json` configures `"shards"` (PostgreSQL) and the
 * App declares `sources.<name>.sharding` or `resources.<name>.placement`,
 * `openShardedAppSource` wraps the configured shards behind one `ShardedAdapter`
 * cached on the `Registry` (closed cleanly on `registry.closeAll()` /
 * `registry.closeServices()`). Multi-tenant cell-sharded apps (`auth.tenancy`)
 * route via `TenantShardRouter` instead and bypass this wrapper.
 */
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import { connect } from '@mistriwork/engine/adapters/connect.js';
import { shardPoolDefaults } from '@mistriwork/engine/adapters/postgresPool.js';
import { createShardedAdapter, type ShardedAdapter } from '@mistriwork/engine/adapters/shardedAdapter.js';
import { resolveConnection } from '@mistriwork/engine/server/auth/credentials.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { TableShardPlacement } from '@mistriwork/engine/shared/shardPlan.js';
import { createShardRouter } from '@mistriwork/engine/shared/sharding.js';
import { openPostgresShardDirectory } from '../../adapters/sharding/postgresShardDirectory.js';
import type { ShardDirectory } from '../../adapters/sharding/shardDirectory.js';
import type { AppDef } from '../../shared/app.js';

interface OpenedShardedEntry {
  adapter?: ShardedAdapter;
  directory?: ShardDirectory;
  opening?: Promise<{ adapter: ShardedAdapter; schema: DatabaseSchema }>;
  schema?: DatabaseSchema;
}

function placementsForOwner(app: AppDef, ownerSources: ReadonlySet<string>): Record<string, TableShardPlacement> {
  const placements: Record<string, TableShardPlacement> = {};
  for (const [resourceKey, def] of Object.entries(app.resources ?? {})) {
    if (!def.placement) continue;
    const dot = resourceKey.indexOf('.');
    const bare = dot < 0 ? resourceKey : resourceKey.slice(dot + 1);
    const source = def.source ?? (dot < 0 ? '' : resourceKey.slice(0, dot));
    if (ownerSources.size && !ownerSources.has(source)) continue;
    const physical = def.physical ?? bare;
    placements[physical] = def.placement;
    if (bare !== physical) placements[bare] = def.placement;
  }
  return placements;
}

/**
 * If `owner` has a configured PostgreSQL `shards` topology and `app` declares
 * non-tenant sharding (`sources.<name>.sharding` or `resources.<name>.placement`)
 * on it, open (or reuse) a `ShardedAdapter` cached on `registry`. Returns
 * `undefined` for ordinary connections or tenant-cell-only apps.
 */
export async function openShardedAppSource(
  registry: Registry,
  owner: string,
  app: AppDef,
  ownerSources: readonly string[],
  control?: Adapter,
): Promise<{ adapter: ShardedAdapter; schema: DatabaseSchema } | undefined> {
  const config = registry.configOf(owner);
  if (!config?.shards) return undefined;
  const sourceSet = new Set(ownerSources);
  const hasSourceSharding = ownerSources.some((src) => Boolean(app.sources?.[src]?.sharding));
  const placements = placementsForOwner(app, sourceSet);
  if (!hasSourceSharding && !Object.keys(placements).length) return undefined;

  const shards = config.shards;
  const key = `sharded-source:${owner}:${JSON.stringify(placements)}`;
  const state = registry.serviceState<OpenedShardedEntry>(key, () => ({}), {
    resetOnClose: true,
    close: async (held) => {
      const adapter = held.adapter;
      const directory = held.directory;
      held.adapter = undefined;
      held.directory = undefined;
      held.schema = undefined;
      await Promise.allSettled([adapter?.close(), directory?.close()]);
    },
  });
  if (state.adapter && state.schema) return { adapter: state.adapter, schema: state.schema };
  if (state.opening) return state.opening;

  state.opening = (async () => {
    const router = createShardRouter({
      strategy: shards.strategy,
      buckets: shards.buckets,
      shards: shards.nodes.map((node) => ({
        id: node.id,
        ...(node.status ? { status: node.status } : {}),
        ...(node.buckets ? { buckets: node.buckets } : {}),
        ...(node.range ? { range: node.range } : {}),
        ...(node.values ? { values: node.values } : {}),
      })),
    });

    const nodeById = new Map(shards.nodes.map((node) => [node.id, node]));
    const needsLookup = Object.values(placements).some((p) => p.kind === 'sharded' && p.id === 'directory');
    let directory: ShardDirectory | undefined;
    if (needsLookup && shards.directory) {
      const resolvedDir = await resolveConnection(`${config.name}:directory`, shards.directory, {
        secrets: true,
        environment: registry.environment,
      });
      directory = await openPostgresShardDirectory(resolvedDir.url);
    }

    const adapter = createShardedAdapter({
      router,
      placements,
      ...(control ? { control } : {}),
      ...(directory ? { lookup: directory } : {}),
      openShard: async (shardId) => {
        const node = nodeById.get(shardId);
        if (!node) throw new Error(`Unknown shard "${shardId}" on connection "${config.name}".`);
        const resolved = await resolveConnection(`${config.name}:${shardId}`, node.url, {
          secrets: true,
          environment: registry.environment,
        });
        const replicas = node.replicas?.length
          ? await Promise.all(
              node.replicas.map(async (replicaUrl) => {
                const res = await resolveConnection(`${config.name}:${shardId}`, replicaUrl, {
                  secrets: true,
                  environment: registry.environment,
                });
                return res.url;
              }),
            )
          : undefined;
        const rawPool = node.pool ?? config.pool;
        const pool = shardPoolDefaults(shards.nodes.length, rawPool);
        return connect(resolved.url, {
          ...(replicas ? { replicas } : {}),
          schemas: config.schemas ?? [],
          label: `${config.name}:${shardId}`,
          postgres: {
            readers: pool.readers,
            writers: pool.writers,
            minIdle: pool.minIdle,
            ...(rawPool?.idleSeconds !== undefined ? { idleSeconds: rawPool.idleSeconds } : {}),
            ...(rawPool?.connectTimeoutMs !== undefined ? { connectTimeoutMs: rawPool.connectTimeoutMs } : {}),
            ...(rawPool?.queryTimeoutMs !== undefined ? { queryTimeoutMs: rawPool.queryTimeoutMs } : {}),
          },
        });
      },
    });

    try {
      const schema = await adapter.introspect();
      state.adapter = adapter;
      state.directory = directory;
      state.schema = schema;
      return { adapter, schema };
    } catch (error) {
      await Promise.allSettled([adapter.close(), directory?.close()]);
      throw error;
    }
  })().finally(() => {
    state.opening = undefined;
  });

  return state.opening;
}
