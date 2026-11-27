/**
 * Query-level shard route planner shared across the engine and App framework.
 *
 * Inspects structured `Filter` / `ViewFilter` predicates, single-record keys,
 * and insert payloads to classify every operation as:
 *   - `control`: unsharded table living on the coordinator database;
 *   - `any`: read-only replicated reference table served from any active shard;
 *   - `single`: routes to exactly one physical shard (zero coordinator overhead);
 *   - `multi`: routes to a bounded subset of shards (`shard_key IN (...)`);
 *   - `lookup`: resolves via an opt-in control-plane lookup directory;
 *   - `scatter`: no shard key bound — governed by the table/view `ScatterPolicy`.
 *
 * Also determines when a reference crosses shard groups (so it becomes a
 * 2-step `stitched` edge) and when co-located joins should propagate shard-key
 * equality.
 */
import type { Condition, Filter } from './filter.js';
import { primaryKey, type TableMeta } from './schema.js';
import type { ViewCondition, ViewFilter } from './viewPaths.js';
import { encodeVbucketInt64, encodeVbucketUlid, vbucketOf, type ShardIdEncoding, type ShardRouter } from './sharding.js';

export type ScatterPolicy = 'refuse' | 'bounded' | 'allow';

export type TableShardPlacement =
  | Readonly<{
      readonly kind: 'sharded';
      readonly group: string;
      readonly key: string;
      readonly id?: ShardIdEncoding | 'composite' | 'directory';
      readonly scatter?: ScatterPolicy;
    }>
  | Readonly<{ readonly kind: 'reference'; readonly writable?: false }>
  | Readonly<{ readonly kind: 'unsharded' }>;

type ShardRoutePlan =
  | Readonly<{ readonly kind: 'control' }>
  | Readonly<{ readonly kind: 'any' }>
  | Readonly<{ readonly kind: 'single'; readonly shardId: string }>
  | Readonly<{ readonly kind: 'multi'; readonly shardIds: readonly string[] }>
  | Readonly<{ readonly kind: 'lookup'; readonly lookupKeys: readonly (string | number)[] }>
  | Readonly<{ readonly kind: 'scatter'; readonly shardIds: readonly string[]; readonly policy: ScatterPolicy }>;

function isScalar(value: unknown): value is string | number {
  return (typeof value === 'string' && value.length > 0) || (typeof value === 'number' && Number.isFinite(value));
}

function extractEqualValues<C extends { readonly op: string; readonly value?: unknown; readonly other?: string }>(
  group: readonly C[],
  columnName: string,
  nameOf: (c: C) => string,
): Array<string | number> | undefined {
  for (const cond of group) {
    if (cond.other !== undefined || nameOf(cond) !== columnName) continue;
    if (cond.op === '=' && isScalar(cond.value)) return [cond.value];
    if (cond.op === 'in' && Array.isArray(cond.value) && cond.value.length > 0 && cond.value.every(isScalar)) {
      return [...(cond.value as Array<string | number>)];
    }
  }
  return undefined;
}

function routeGroups<C extends { readonly op: string; readonly value?: unknown; readonly other?: string }>(
  table: TableMeta,
  placement: TableShardPlacement | undefined,
  groups: readonly (readonly C[])[] | undefined,
  nameOf: (c: C) => string,
  router: ShardRouter,
  defaultScatter: ScatterPolicy = 'refuse',
): ShardRoutePlan {
  if (!placement || placement.kind === 'unsharded') return { kind: 'control' };
  if (placement.kind === 'reference') return { kind: 'any' };
  const policy = placement.scatter ?? defaultScatter;
  if (!groups?.length) return { kind: 'scatter', shardIds: router.allShards(), policy };

  const pk = primaryKey(table);
  const singlePk = pk.length === 1 ? pk[0] : undefined;
  const targetShards = new Set<string>();
  const lookupKeys: Array<string | number> = [];
  let needsLookup = false;

  for (const group of groups) {
    // 1. Direct shard-key predicate (`shard_key = X` or `shard_key IN (...)`).
    const keyVals = extractEqualValues(group, placement.key, nameOf);
    if (keyVals) {
      for (const val of keyVals) targetShards.add(router.shardForKey(val));
      continue;
    }
    // 2. Self-routing vbucket-encoded PK (`pk = X` or `pk IN (...)`).
    if (singlePk && (placement.id === 'vbucket-int64' || placement.id === 'vbucket-ulid')) {
      const pkVals = extractEqualValues(group, singlePk, nameOf);
      if (pkVals) {
        let allDecoded = true;
        for (const val of pkVals) {
          const shardId = router.shardForId(val, placement.id);
          if (!shardId) {
            allDecoded = false;
            break;
          }
          targetShards.add(shardId);
        }
        if (allDecoded) continue;
      }
    }
    // 3. Opt-in directory lookup vindex on PK.
    if (singlePk && placement.id === 'directory') {
      const pkVals = extractEqualValues(group, singlePk, nameOf);
      if (pkVals) {
        needsLookup = true;
        lookupKeys.push(...pkVals);
        continue;
      }
    }
    // At least one OR-branch has no shard predicate -> full scatter.
    return { kind: 'scatter', shardIds: router.allShards(), policy };
  }

  if (needsLookup && !targetShards.size) {
    return { kind: 'lookup', lookupKeys: [...new Set(lookupKeys)] };
  }
  if (needsLookup && targetShards.size) {
    return { kind: 'scatter', shardIds: router.allShards(), policy };
  }
  const shardIds = [...targetShards];
  if (shardIds.length === 1) return { kind: 'single', shardId: shardIds[0]! };
  return { kind: 'multi', shardIds };
}

/** Plan target shard(s) for a single-table `Filter`. */
export function planShardRoute(
  table: TableMeta,
  placement: TableShardPlacement | undefined,
  filter: Filter | undefined,
  router: ShardRouter,
  defaultScatter: ScatterPolicy = 'refuse',
): ShardRoutePlan {
  return routeGroups<Condition>(table, placement, filter?.groups, (c) => c.column, router, defaultScatter);
}

/** Plan target shard(s) for a `ViewFilter`. */
export function planViewShardRoute(
  table: TableMeta,
  placement: TableShardPlacement | undefined,
  filter: ViewFilter | undefined,
  router: ShardRouter,
  defaultScatter: ScatterPolicy = 'refuse',
): ShardRoutePlan {
  return routeGroups<ViewCondition>(table, placement, filter?.groups, (c) => c.path, router, defaultScatter);
}

/**
 * Plan the single shard for a keyed point operation (`update`, `remove`,
 * `lockRecord`, single-record read) from its primary-key map.
 */
export function planRecordShard(
  table: TableMeta,
  placement: TableShardPlacement | undefined,
  key: Readonly<Record<string, unknown>>,
  router: ShardRouter,
):
  | Readonly<{ readonly kind: 'control' }>
  | Readonly<{ readonly kind: 'reference' }>
  | Readonly<{ readonly kind: 'single'; readonly shardId: string }>
  | Readonly<{ readonly kind: 'lookup'; readonly lookupKey: string | number }>
  | Readonly<{ readonly kind: 'unroutable'; readonly reason: string }> {
  if (!placement || placement.kind === 'unsharded') return { kind: 'control' };
  if (placement.kind === 'reference') return { kind: 'reference' };

  const shardVal = key[placement.key];
  if (isScalar(shardVal)) return { kind: 'single', shardId: router.shardForKey(shardVal) };

  const pk = primaryKey(table);
  if (pk.length === 1) {
    const pkVal = key[pk[0]!];
    if (isScalar(pkVal)) {
      if (placement.id === 'vbucket-int64' || placement.id === 'vbucket-ulid') {
        const shardId = router.shardForId(pkVal, placement.id);
        if (shardId) return { kind: 'single', shardId };
        return {
          kind: 'unroutable',
          reason: `Key "${pk[0]}=${String(pkVal)}" on "${table.name}" is not a valid ${placement.id} self-routing ID.`,
        };
      }
      if (placement.id === 'directory') {
        return { kind: 'lookup', lookupKey: pkVal };
      }
    }
  }
  return {
    kind: 'unroutable',
    reason: `Cannot route "${table.name}" without shard key "${placement.key}" (or a self-routing ID).`,
  };
}

/**
 * Plan target shard for an `insert` and optionally synthesize a self-routing
 * primary key (`vbucket-int64` or `vbucket-ulid`) when omitted from `values`.
 */
export function planInsertShard(
  table: TableMeta,
  placement: TableShardPlacement | undefined,
  values: Readonly<Record<string, unknown>>,
  router: ShardRouter,
):
  | Readonly<{ readonly kind: 'control'; readonly values: Readonly<Record<string, unknown>> }>
  | Readonly<{ readonly kind: 'reference' }>
  | Readonly<{
      readonly kind: 'single';
      readonly shardId: string;
      readonly vbucket: number;
      readonly values: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{ readonly kind: 'unroutable'; readonly reason: string }> {
  if (!placement || placement.kind === 'unsharded') return { kind: 'control', values };
  if (placement.kind === 'reference') return { kind: 'reference' };

  const shardVal = values[placement.key];
  if (!isScalar(shardVal)) {
    return {
      kind: 'unroutable',
      reason: `Insert into sharded table "${table.name}" requires non-empty shard key "${placement.key}".`,
    };
  }
  const vbucket = vbucketOf(shardVal, router.buckets);
  const shardId = router.shardForKey(shardVal);
  const pk = primaryKey(table);
  if (pk.length === 1 && (placement.id === 'vbucket-int64' || placement.id === 'vbucket-ulid')) {
    const pkCol = pk[0]!;
    const existing = values[pkCol];
    if (existing === undefined || existing === null || existing === '') {
      const minted = placement.id === 'vbucket-int64' ? encodeVbucketInt64(vbucket) : encodeVbucketUlid(vbucket);
      return { kind: 'single', shardId, vbucket, values: { ...values, [pkCol]: minted } };
    }
    const decodedShard = router.shardForId(existing as string | number, placement.id);
    if (decodedShard !== shardId) {
      return {
        kind: 'unroutable',
        reason: `Provided "${pkCol}" on "${table.name}" routes to shard "${decodedShard ?? 'invalid'}", which disagrees with "${placement.key}" shard "${shardId}".`,
      };
    }
  }
  return { kind: 'single', shardId, vbucket, values };
}

/**
 * Whether a reference from `from` to `to` crosses shard boundaries and must be
 * treated as a 2-step `stitched` edge instead of a local SQL `JOIN`.
 *
 * Local joins are valid when:
 * - both are unsharded,
 * - the target is a replicated `reference` table (available locally on every shard),
 * - both are sharded in the **same co-location group**.
 */
export function isCrossGroupEdge(from: TableShardPlacement | undefined, to: TableShardPlacement | undefined): boolean {
  if (!from && !to) return false;
  if (to?.kind === 'reference') return false;
  if (from?.kind === 'reference') return to?.kind === 'sharded';
  const fromKind = from?.kind ?? 'unsharded';
  const toKind = to?.kind ?? 'unsharded';
  if (fromKind === 'unsharded' && toKind === 'unsharded') return false;
  if (fromKind === 'sharded' && toKind === 'sharded') {
    return (
      (from as Extract<TableShardPlacement, { kind: 'sharded' }>).group !== (to as Extract<TableShardPlacement, { kind: 'sharded' }>).group
    );
  }
  return true;
}

/**
 * Extra shard-key equality pair `[fromCol, toCol]` to inject into co-located
 * SQL `JOIN`s so every join enforces same-shard locality even when the FK is
 * single-column.
 */
export function coLocatedJoinColumns(
  from: TableShardPlacement | undefined,
  to: TableShardPlacement | undefined,
): readonly [fromColumn: string, toColumn: string] | undefined {
  if (from?.kind !== 'sharded' || to?.kind !== 'sharded') return undefined;
  if (from.group !== to.group) return undefined;
  return [from.key, to.key];
}
