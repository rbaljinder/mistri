/**
 * Horizontal `ShardedAdapter`: routes reads, writes, transactions, and
 * scatter-gather queries across `N` physical shard adapters behind one unified
 * `Adapter` contract.
 *
 * Mirrors `createAppSourceAdapter` (vertical split by table name) on the
 * horizontal axis (split by shard key / virtual bucket):
 * - Single-shard reads & writes dispatch directly to one shard with zero
 *   coordinator overhead.
 * - Unsharded tables route to the optional `control` adapter.
 * - Replicated reference tables read from any active shard and refuse runtime
 *   writes (per Mistri's no-custom-fanout-replicator doctrine).
 * - Multi-shard / scatter reads enforce per-table `ScatterPolicy` fail-closed
 *   and delegate to `shardedScatter.ts` (k-way merge + 2-phase partial aggregates).
 * - Cross-shard writes and transactions are refused loudly; single-shard
 *   transactions run atomically via `forShard(shardId)` / `transactionFor(key)`.
 */
import {
  Refusal,
  type Adapter,
  type AggregateRequest,
  type CountItem,
  type CteRequest,
  type DeleteRequest,
  type InsertRequest,
  type QueryRequest,
  type UpdateRequest,
  type WriteTransaction,
} from './adapter.js';
import { findTable, type DatabaseSchema, type TableMeta } from '../shared/schema.js';
import type { ShardRouter } from '../shared/sharding.js';
import {
  planInsertShard,
  planRecordShard,
  planShardRoute,
  planViewShardRoute,
  type ScatterPolicy,
  type TableShardPlacement,
} from '../shared/shardPlan.js';
import {
  assertScatterAllowed,
  scatterAggregate,
  scatterBreakdown,
  scatterCount,
  scatterQuery,
  scatterView,
  type ShardedTarget,
} from './shardedScatter.js';

/** Minimal opt-in lookup directory contract needed by `ShardedAdapter` for `id: 'directory'` tables. */
interface ShardLookupResolver {
  getLookup(resource: string, lookupKey: string): Promise<Readonly<{ readonly shardId: string; readonly vbucket: number }> | undefined>;
  putLookup?(
    entry: Readonly<{ readonly resource: string; readonly lookupKey: string; readonly shardId: string; readonly vbucket: number }>,
  ): Promise<void>;
}

interface ShardedAdapterOptions {
  readonly router: ShardRouter;
  /** Lazily open (or return) the underlying dialect `Adapter` for `shardId`. */
  readonly openShard: (shardId: string) => Promise<Adapter>;
  /** Optional close callback per opened shard adapter (default calls `adapter.close()`). */
  readonly closeShard?: (shardId: string, adapter: Adapter) => Promise<void>;
  /** Optional coordinator/control adapter hosting `placement: 'unsharded'` tables. */
  readonly control?: Adapter;
  /** Per-table placement declarations (`tableId -> TableShardPlacement`). Unlisted tables default to `unsharded`. */
  readonly placements: Readonly<Record<string, TableShardPlacement>>;
  /** Optional opt-in lookup directory for `id: 'directory'` sharded tables. */
  readonly lookup?: ShardLookupResolver;
  /** Default scatter-gather policy when a sharded table omits `scatter`. Defaults to `'refuse'`. */
  readonly defaultScatter?: ScatterPolicy;
  /** Maximum shard count allowed for `scatter: 'bounded'` queries. Defaults to 32. */
  readonly maxBoundedShards?: number;
}

export interface ShardedAdapter extends Adapter {
  readonly router: ShardRouter;
  /** Lazily open and return the underlying `Adapter` for one physical shard. */
  forShard(shardId: string): Promise<Adapter>;
  /** Run an ACID single-shard transaction anchored to the shard owning `shardKey`. */
  transactionFor<T>(shardKey: string | number, run: (tx: WriteTransaction, shardId: string) => Promise<T>): Promise<T>;
  /** Every shard ID whose adapter has been lazily opened in this process. */
  openedShards(): readonly string[];
}

export function createShardedAdapter(options: ShardedAdapterOptions): ShardedAdapter {
  const { router, placements, lookup, defaultScatter = 'refuse', maxBoundedShards } = options;
  const opened = new Map<string, Adapter>();
  const pending = new Map<string, Promise<Adapter>>();
  let cachedSchema: DatabaseSchema | undefined;
  let closed = false;

  const forShard = async (shardId: string): Promise<Adapter> => {
    if (closed) throw new Refusal('Sharded adapter is closed.');
    if (!router.node(shardId)) throw new Refusal(`Unknown shard "${shardId}".`);
    const existing = opened.get(shardId);
    if (existing) return existing;
    let inFlight = pending.get(shardId);
    if (!inFlight) {
      inFlight = (async () => {
        const adapter = await options.openShard(shardId);
        if (closed) {
          await (options.closeShard ? options.closeShard(shardId, adapter) : adapter.close());
          throw new Refusal('Sharded adapter closed while opening shard.');
        }
        opened.set(shardId, adapter);
        return adapter;
      })().finally(() => {
        pending.delete(shardId);
      });
      pending.set(shardId, inFlight);
    }
    return inFlight;
  };

  const controlAdapter = async (): Promise<Adapter> => {
    if (options.control) return options.control;
    const first = router.allShards()[0];
    if (!first) throw new Refusal('Sharded cluster has no configured shards.');
    return forShard(first);
  };

  const anyReadableShard = async (): Promise<Adapter> => {
    const first = router.allShards()[0];
    if (!first) throw new Refusal('Sharded cluster has no configured shards.');
    return forShard(first);
  };

  const ensureSchema = async (): Promise<DatabaseSchema> => {
    if (cachedSchema) return cachedSchema;
    const base = await anyReadableShard();
    const shardSchema = await base.introspect();
    if (!options.control) {
      cachedSchema = shardSchema;
      return cachedSchema;
    }
    const controlSchema = await options.control.introspect();
    const seenTables = new Set(shardSchema.tables.map((t) => t.id));
    const extraTables = controlSchema.tables.filter((t) => !seenTables.has(t.id));
    if (!extraTables.length) {
      cachedSchema = shardSchema;
      return cachedSchema;
    }
    const extraIds = new Set(extraTables.map((t) => t.id));
    const extraFks = controlSchema.foreignKeys.filter((fk) => extraIds.has(fk.from.table) || extraIds.has(fk.to.table));
    cachedSchema = {
      ...shardSchema,
      tables: [...shardSchema.tables, ...extraTables],
      foreignKeys: [...shardSchema.foreignKeys, ...extraFks],
    };
    return cachedSchema;
  };

  const tableOf = async (tableId: string): Promise<TableMeta> => {
    const schema = await ensureSchema();
    const found = findTable(schema, tableId);
    if (!found) throw new Refusal(`Unknown table "${tableId}".`);
    return found;
  };

  const placementOf = (table: TableMeta): TableShardPlacement | undefined => placements[table.id] ?? placements[table.name];

  const assertWritableShard = (shardId: string) => {
    const node = router.node(shardId);
    if (node?.status === 'read_only') {
      throw new Refusal(`Shard "${shardId}" is read-only and does not accept writes.`);
    }
  };

  const resolveTargets = async (table: TableMeta, plan: ReturnType<typeof planShardRoute>): Promise<readonly ShardedTarget[]> => {
    if (plan.kind === 'control') {
      return [{ shardId: '__control__', adapter: await controlAdapter() }];
    }
    if (plan.kind === 'any') {
      const shardId = router.allShards()[0]!;
      return [{ shardId, adapter: await forShard(shardId) }];
    }
    if (plan.kind === 'single') {
      return [{ shardId: plan.shardId, adapter: await forShard(plan.shardId) }];
    }
    if (plan.kind === 'multi') {
      return Promise.all(plan.shardIds.map(async (shardId) => ({ shardId, adapter: await forShard(shardId) })));
    }
    if (plan.kind === 'lookup') {
      if (!lookup) {
        throw new Refusal(`Table "${table.name}" uses directory lookup sharding, but no lookup directory is configured.`);
      }
      const shardIds = new Set<string>();
      for (const k of plan.lookupKeys) {
        const found = await lookup.getLookup(table.id, String(k));
        if (found) shardIds.add(found.shardId);
      }
      if (!shardIds.size) return [];
      return Promise.all([...shardIds].map(async (shardId) => ({ shardId, adapter: await forShard(shardId) })));
    }
    const placement = placementOf(table);
    const shardKey = placement?.kind === 'sharded' ? placement.key : 'shard_key';
    assertScatterAllowed(table.name, shardKey, plan.shardIds.length, plan.policy, maxBoundedShards);
    return Promise.all(plan.shardIds.map(async (shardId) => ({ shardId, adapter: await forShard(shardId) })));
  };

  const resolveWriteTarget = async (
    table: TableMeta,
    key: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly shardId: string; readonly adapter: Adapter }> => {
    const placement = placementOf(table);
    const plan = planRecordShard(table, placement, key, router);
    if (plan.kind === 'control') return { shardId: '__control__', adapter: await controlAdapter() };
    if (plan.kind === 'reference') {
      throw new Refusal(`Reference table "${table.name}" is read-only at runtime. Update it through migrations or declare it "unsharded".`);
    }
    if (plan.kind === 'single') {
      assertWritableShard(plan.shardId);
      return { shardId: plan.shardId, adapter: await forShard(plan.shardId) };
    }
    if (plan.kind === 'lookup') {
      if (!lookup) throw new Refusal(`Table "${table.name}" requires a lookup directory to route writes.`);
      const found = await lookup.getLookup(table.id, String(plan.lookupKey));
      if (!found) throw new Refusal(`No shard placement found for "${table.name}" key "${String(plan.lookupKey)}".`);
      assertWritableShard(found.shardId);
      return { shardId: found.shardId, adapter: await forShard(found.shardId) };
    }
    throw new Refusal(plan.reason);
  };

  return {
    dialect: 'postgres',
    router,
    forShard,
    openedShards: () => Object.freeze([...opened.keys()]),

    async introspect() {
      return ensureSchema();
    },

    async query(request: QueryRequest) {
      const table = await tableOf(request.table);
      const plan = planShardRoute(table, placementOf(table), request.filter, router, defaultScatter);
      const targets = await resolveTargets(table, plan);
      if (!targets.length) {
        return { columns: request.columns ?? table.columns.map((c) => c.name), rows: [], ms: 0, sql: { text: '', params: [] } };
      }
      if (targets.length === 1) return targets[0]!.adapter.query(request);
      return scatterQuery(targets, request);
    },

    async count(tableId: string, filter?: QueryRequest['filter'], limit?: number) {
      const table = await tableOf(tableId);
      const plan = planShardRoute(table, placementOf(table), filter, router, defaultScatter);
      const targets = await resolveTargets(table, plan);
      if (!targets.length) return 0;
      if (targets.length === 1) return targets[0]!.adapter.count(tableId, filter, limit);
      return scatterCount(targets, tableId, filter, limit);
    },

    async countEach(items: readonly CountItem[], limit?: number) {
      return Promise.all(items.map((item) => this.count(item.table, item.filter, limit)));
    },

    async estimateCount(tableId: string) {
      const table = await tableOf(tableId);
      const placement = placementOf(table);
      if (!placement || placement.kind === 'unsharded') {
        return (await controlAdapter()).estimateCount?.(tableId);
      }
      if (placement.kind === 'reference') {
        return (await anyReadableShard()).estimateCount?.(tableId);
      }
      const estimates = await Promise.all(router.allShards().map(async (shardId) => (await forShard(shardId)).estimateCount?.(tableId)));
      if (estimates.some((n) => n === undefined)) return undefined;
      return estimates.reduce<number>((sum, n) => sum + (n ?? 0), 0);
    },

    async runView(view, offset = 0) {
      const table = await tableOf(view.base);
      const plan = planViewShardRoute(table, placementOf(table), view.filter, router, defaultScatter);
      const targets = await resolveTargets(table, plan);
      if (!targets.length) {
        return { columns: [], resolved: [], joins: [], rows: [], ms: 0, sql: { text: '', params: [] } };
      }
      if (targets.length === 1) {
        const adapter = targets[0]!.adapter;
        if (!adapter.runView) throw new Refusal(`Shard "${targets[0]!.shardId}" does not support views.`);
        return adapter.runView(view, offset);
      }
      return scatterView(targets, view, offset);
    },

    async countView(view, limit) {
      const table = await tableOf(view.base);
      const plan = planViewShardRoute(table, placementOf(table), view.filter, router, defaultScatter);
      const targets = await resolveTargets(table, plan);
      if (!targets.length) return 0;
      if (targets.length === 1) {
        const adapter = targets[0]!.adapter;
        if (!adapter.countView) throw new Refusal(`Shard "${targets[0]!.shardId}" does not support view counts.`);
        return adapter.countView(view, limit);
      }
      const counts = await Promise.all(
        targets.map((target) => {
          if (!target.adapter.countView) throw new Refusal(`Shard "${target.shardId}" does not support view counts.`);
          return target.adapter.countView(view, limit);
        }),
      );
      let total = 0;
      for (const n of counts) {
        total += n;
        if (limit !== undefined && total > limit) return limit + 1;
      }
      return total;
    },

    async runBreakdown(breakdown, offset = 0) {
      const table = await tableOf(breakdown.base);
      const placement = placementOf(table);
      const plan = planViewShardRoute(table, placement, breakdown.filter, router, defaultScatter);
      const targets = await resolveTargets(table, plan);
      if (!targets.length) {
        return { columns: [], resolved: [], rows: [], ms: 0, sql: { text: '', params: [] } };
      }
      if (targets.length === 1) {
        const adapter = targets[0]!.adapter;
        if (!adapter.runBreakdown) throw new Refusal(`Shard "${targets[0]!.shardId}" does not support breakdowns.`);
        return adapter.runBreakdown(breakdown, offset);
      }
      return scatterBreakdown(targets, breakdown, offset, placement?.kind === 'sharded' ? placement.key : undefined);
    },

    async countBreakdown(breakdown, limit) {
      const result = await this.runBreakdown!({ ...breakdown, limit: limit ?? 1_000 }, 0);
      return result.rows.length;
    },

    async aggregate(request: AggregateRequest) {
      const table = await tableOf(request.table);
      const placement = placementOf(table);
      const plan = planShardRoute(table, placement, request.filter, router, defaultScatter);
      const targets = await resolveTargets(table, plan);
      if (!targets.length) {
        return { rows: [] };
      }
      if (targets.length === 1) {
        const adapter = targets[0]!.adapter;
        if (!adapter.aggregate) throw new Refusal(`Shard "${targets[0]!.shardId}" does not support aggregates.`);
        return adapter.aggregate(request);
      }
      return scatterAggregate(targets, request, placement?.kind === 'sharded' ? placement.key : undefined);
    },

    async cte(request: CteRequest) {
      const table = await tableOf(request.query.from);
      const placement = placementOf(table);
      if (!placement || placement.kind === 'unsharded') {
        const control = await controlAdapter();
        if (!control.cte) throw new Refusal('Control shard does not support CTE queries.');
        return control.cte(request);
      }
      if (placement.kind === 'reference') {
        const shard = await anyReadableShard();
        if (!shard.cte) throw new Refusal('Shard does not support CTE queries.');
        return shard.cte(request);
      }
      throw new Refusal(
        `Unanchored CTE query on sharded table "${table.name}" cannot span shards. Anchor to one shard via forShard() or filter within one shard.`,
      );
    },

    async insert(request: InsertRequest) {
      const table = await tableOf(request.table);
      const placement = placementOf(table);
      const plan = planInsertShard(table, placement, request.values, router);
      if (plan.kind === 'reference') {
        throw new Refusal(
          `Reference table "${table.name}" is read-only at runtime. Update it through migrations or declare it "unsharded".`,
        );
      }
      if (plan.kind === 'unroutable') throw new Refusal(plan.reason);
      if (plan.kind === 'control') {
        const control = await controlAdapter();
        if (!control.insert) throw new Refusal('Control shard is read-only.');
        return control.insert(request);
      }
      assertWritableShard(plan.shardId);
      const shard = await forShard(plan.shardId);
      if (!shard.insert) throw new Refusal(`Shard "${plan.shardId}" is read-only.`);
      const inserted = await shard.insert({ ...request, values: { ...plan.values } as InsertRequest['values'] });
      if (placement?.kind === 'sharded' && placement.id === 'directory' && lookup?.putLookup) {
        const keyValues = Object.values(inserted.key);
        if (keyValues.length === 1) {
          await lookup.putLookup({
            resource: table.id,
            lookupKey: String(keyValues[0]),
            shardId: plan.shardId,
            vbucket: plan.vbucket,
          });
        }
      }
      return inserted;
    },

    async update(request: UpdateRequest) {
      const table = await tableOf(request.table);
      const { shardId, adapter } = await resolveWriteTarget(table, request.key);
      if (!adapter.update) throw new Refusal(`Shard "${shardId}" is read-only.`);
      const placement = placementOf(table);
      if (placement?.kind === 'sharded' && Object.hasOwn(request.values, placement.key)) {
        const currentKey = request.key[placement.key];
        const proposed = request.values[placement.key];
        if (currentKey === undefined || proposed !== currentKey) {
          throw new Refusal(
            `Cannot change shard key "${placement.key}" on "${table.name}" in place: cross-shard row moves require an explicit workflow.`,
          );
        }
      }
      return adapter.update(request);
    },

    async remove(request: DeleteRequest) {
      const table = await tableOf(request.table);
      const { shardId, adapter } = await resolveWriteTarget(table, request.key);
      if (!adapter.remove) throw new Refusal(`Shard "${shardId}" is read-only.`);
      return adapter.remove(request);
    },

    async transaction() {
      throw new Refusal(
        'Cannot open an unanchored transaction on a sharded adapter. Use transactionFor(shardKey, run) or forShard(shardId) for single-shard ACID transactions.',
      );
    },

    async transactionFor<T>(shardKey: string | number, run: (tx: WriteTransaction, shardId: string) => Promise<T>): Promise<T> {
      const shardId = router.shardForKey(shardKey);
      assertWritableShard(shardId);
      const shard = await forShard(shardId);
      if (!shard.transaction) throw new Refusal(`Shard "${shardId}" does not support transactions.`);
      return shard.transaction((tx) => run(tx, shardId));
    },

    async close() {
      if (closed) return;
      closed = true;
      const entries = [...opened.entries()];
      opened.clear();
      for (const [shardId, adapter] of entries) {
        await (options.closeShard ? options.closeShard(shardId, adapter) : adapter.close());
      }
    },
  };
}
