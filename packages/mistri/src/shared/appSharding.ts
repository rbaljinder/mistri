/**
 * App-level sharding declarations, validation (`mistri check`), and search
 * hit shard-key hydration helpers for non-tenant large sharded databases.
 *
 * Generalizes Mistri's tenant `owner` taxonomy (`tenant` / `global` / `platform`)
 * into `placement` (`sharded` / `reference` / `unsharded`) across one or more
 * co-location groups. Enforces unique-index and `noOverlap` shard-key alignment,
 * warns on shard-local auto-increment sequences and unindexed scatter typeaheads,
 * and prevents cross-group correlated rollups.
 */
import { allowKeys, isRecord } from '@mistriwork/engine/shared/model.js';
import type { Condition, Filter } from '@mistriwork/engine/shared/filter.js';
import { columnKind, primaryKey, tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import {
  DEFAULT_SHARD_BUCKETS,
  isBucketCount,
  MAX_SHARD_BUCKETS,
  MIN_SHARD_BUCKETS,
  type ShardIdEncoding,
  type ShardStrategy,
} from '@mistriwork/engine/shared/sharding.js';
import { isCrossGroupEdge, type ScatterPolicy, type TableShardPlacement } from '@mistriwork/engine/shared/shardPlan.js';
import type { AppDef } from './appModel.js';

type ShardKeyType = 'bigint' | 'int' | 'text' | 'uuid';

interface AppShardGroupDef {
  readonly keyType: ShardKeyType;
  readonly strategy?: ShardStrategy;
}

export interface AppSourceShardingDef {
  readonly buckets?: number;
  readonly groups: Readonly<Record<string, AppShardGroupDef>>;
}

const KEY_TYPES = new Set<ShardKeyType>(['bigint', 'int', 'text', 'uuid']);
const STRATEGIES = new Set<ShardStrategy>(['hash', 'range', 'list', 'directory']);
const ID_MODES = new Set<ShardIdEncoding | 'composite' | 'directory'>(['vbucket-int64', 'vbucket-ulid', 'composite', 'directory']);
const SCATTER_POLICIES = new Set<ScatterPolicy>(['refuse', 'bounded', 'allow']);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parse `sources.<name>.sharding` from an App definition. */
export function parseSourceSharding(raw: unknown, where: string): AppSourceShardingDef {
  if (!isRecord(raw)) throw new Error(`${where}: "sharding" must be an object with "groups".`);
  allowKeys(raw, ['buckets', 'groups'], where);
  let buckets: number | undefined;
  if (raw.buckets !== undefined) {
    if (!isBucketCount(raw.buckets)) {
      throw new Error(`${where}: "buckets" must be an integer from ${MIN_SHARD_BUCKETS} to ${MAX_SHARD_BUCKETS}.`);
    }
    buckets = raw.buckets;
  }
  if (!isRecord(raw.groups) || !Object.keys(raw.groups).length) {
    throw new Error(`${where}: "sharding.groups" must declare at least one co-location group.`);
  }
  const groups: Record<string, AppShardGroupDef> = {};
  for (const [name, entry] of Object.entries(raw.groups)) {
    const at = `${where}.groups.${name}`;
    if (!IDENT.test(name)) throw new Error(`${at}: group name must be a valid identifier.`);
    if (!isRecord(entry)) throw new Error(`${at}: must be an object with "keyType".`);
    allowKeys(entry, ['keyType', 'strategy'], at);
    if (typeof entry.keyType !== 'string' || !KEY_TYPES.has(entry.keyType as ShardKeyType)) {
      throw new Error(`${at}: "keyType" must be "bigint", "int", "text" or "uuid".`);
    }
    let strategy: ShardStrategy | undefined;
    if (entry.strategy !== undefined) {
      if (typeof entry.strategy !== 'string' || !STRATEGIES.has(entry.strategy as ShardStrategy)) {
        throw new Error(`${at}: "strategy" must be "hash", "range", "list" or "directory".`);
      }
      strategy = entry.strategy as ShardStrategy;
    }
    groups[name] = Object.freeze({ keyType: entry.keyType as ShardKeyType, ...(strategy ? { strategy } : {}) });
  }
  return Object.freeze({ ...(buckets !== undefined ? { buckets } : { buckets: DEFAULT_SHARD_BUCKETS }), groups: Object.freeze(groups) });
}

/** Parse `resources.<name>.placement` from an App definition. */
export function parseResourcePlacement(raw: unknown, where: string): TableShardPlacement {
  if (!isRecord(raw)) throw new Error(`${where}: "placement" must be an object naming "kind".`);
  const kind = raw.kind;
  if (kind === 'unsharded') {
    allowKeys(raw, ['kind'], where);
    return Object.freeze({ kind: 'unsharded' });
  }
  if (kind === 'reference') {
    allowKeys(raw, ['kind', 'writable'], where);
    if (raw.writable !== undefined && raw.writable !== false) {
      throw new Error(`${where}: reference tables are read-only at runtime in v1; use kind "unsharded" for writable global tables.`);
    }
    return Object.freeze({ kind: 'reference', writable: false });
  }
  if (kind === 'sharded') {
    allowKeys(raw, ['kind', 'group', 'key', 'id', 'scatter'], where);
    if (typeof raw.group !== 'string' || !IDENT.test(raw.group)) {
      throw new Error(`${where}: sharded placement requires a valid "group" name.`);
    }
    if (typeof raw.key !== 'string' || !IDENT.test(raw.key)) {
      throw new Error(`${where}: sharded placement requires a valid "key" column name.`);
    }
    let id: ShardIdEncoding | 'composite' | 'directory' | undefined;
    if (raw.id !== undefined) {
      if (typeof raw.id !== 'string' || !ID_MODES.has(raw.id as ShardIdEncoding | 'composite' | 'directory')) {
        throw new Error(`${where}: "id" must be "vbucket-int64", "vbucket-ulid", "composite" or "directory".`);
      }
      id = raw.id as ShardIdEncoding | 'composite' | 'directory';
    }
    let scatter: ScatterPolicy | undefined;
    if (raw.scatter !== undefined) {
      if (typeof raw.scatter !== 'string' || !SCATTER_POLICIES.has(raw.scatter as ScatterPolicy)) {
        throw new Error(`${where}: "scatter" must be "refuse", "bounded" or "allow".`);
      }
      scatter = raw.scatter as ScatterPolicy;
    }
    return Object.freeze({
      kind: 'sharded',
      group: raw.group,
      key: raw.key,
      ...(id ? { id } : {}),
      ...(scatter ? { scatter } : {}),
    });
  }
  throw new Error(`${where}: "placement.kind" must be "sharded", "reference" or "unsharded".`);
}

function keyTypeMatches(expected: ShardKeyType, sqlType: string): boolean {
  const kind = columnKind(sqlType);
  if (expected === 'int' || expected === 'bigint') return kind === 'number';
  return kind === 'text';
}

interface ShardingValidationResult {
  /** Blocking problems that `mistri check` and startup must refuse. */
  readonly errors: readonly string[];
  /** Non-blocking operational advice (e.g., shard-local sequences or scatter typeahead without search). */
  readonly warnings: readonly string[];
}

/**
 * Validate every sharded source and resource placement against `schema`.
 *
 * Enforces:
 * - Shard group exists and key column is present, `NOT NULL`, and type-compatible.
 * - Reference tables are read-only (`access: 'write'` refused).
 * - Every `UNIQUE` single-column constraint on a sharded table is either its
 *   shard key, a globally unique self-routing PK (`vbucket-int64`/`vbucket-ulid`),
 *   or backed by `id: 'directory'`.
 * - Every `noOverlap` rule on a sharded table includes the shard key in `by`.
 * - Correlated rollups stay within the same co-location group (never cross-group).
 * - Advises when a sharded resource uses an auto-increment single-column PK
 *   without composite `(shard_key, id)`, or declares list `suggest` / dashboard
 *   `find` without an external search provider.
 */
export function validateAppSharding(
  app: Pick<AppDef, 'sources' | 'resources' | 'views'>,
  schema: DatabaseSchema,
): ShardingValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const groups = new Map<string, AppShardGroupDef>();
  for (const source of Object.values(app.sources ?? {})) {
    for (const [name, group] of Object.entries(source.sharding?.groups ?? {})) {
      groups.set(name, group);
    }
  }
  const placements = new Map<string, TableShardPlacement>();
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    if (resource.placement) placements.set(name, resource.placement);
  }
  if (!groups.size && !placements.size) return { errors, warnings };

  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    const placement = resource.placement;
    if (!placement) continue;
    const at = `resources "${name}"`;
    const table = tableNamed(schema, name);

    if (placement.kind === 'reference') {
      if (resource.access === 'write') {
        errors.push(`${at}: reference table cannot declare access "write"; reference tables are read-only at runtime.`);
      }
      continue;
    }
    if (placement.kind !== 'sharded') continue;

    const group = groups.get(placement.group);
    if (!group) {
      errors.push(`${at}: placement group "${placement.group}" is not declared under any source's "sharding.groups".`);
    }
    if (!table) continue;

    const keyCol = table.columns.find((col) => col.name === placement.key);
    if (!keyCol) {
      errors.push(`${at}: shard key column "${placement.key}" does not exist on "${table.name}".`);
      continue;
    }
    if (keyCol.nullable) {
      errors.push(`${at}: shard key column "${placement.key}" on "${table.name}" must be NOT NULL.`);
    }
    if (group && !keyTypeMatches(group.keyType, keyCol.type)) {
      errors.push(
        `${at}: shard key "${placement.key}" has SQL type "${keyCol.type}", which does not match group "${placement.group}" keyType "${group.keyType}".`,
      );
    }

    const pk = primaryKey(table);
    if (placement.id === 'composite' && !pk.includes(placement.key)) {
      errors.push(
        `${at}: placement id "composite" requires "${placement.key}" to be part of "${table.name}" primary key (${pk.join(', ')}).`,
      );
    }
    if ((placement.id === 'vbucket-int64' || placement.id === 'vbucket-ulid') && pk.length !== 1) {
      errors.push(`${at}: placement id "${placement.id}" requires a single-column primary key on "${table.name}".`);
    }
    if (pk.length === 1 && pk[0] !== placement.key && !placement.id) {
      const pkCol = table.columns.find((c) => c.name === pk[0]);
      if (pkCol?.identity || /serial/i.test(pkCol?.type ?? '')) {
        warnings.push(
          `${at}: single-column auto-generated key "${pk[0]}" on sharded table "${table.name}" will collide across shards unless stepped per shard or switched to id "vbucket-int64" / "composite".`,
        );
      }
    }

    // Single-column unique constraints on sharded tables cannot hold globally across shards
    // unless the column IS the shard key, a globally unique self-routing PK, or directory-backed.
    const selfRoutingPk = pk.length === 1 && (placement.id === 'vbucket-int64' || placement.id === 'vbucket-ulid') ? pk[0] : undefined;
    for (const uniqueCol of table.unique ?? []) {
      if (uniqueCol === placement.key || uniqueCol === selfRoutingPk || placement.id === 'directory') continue;
      errors.push(
        `${at}: unique constraint on "${table.name}.${uniqueCol}" omits shard key "${placement.key}". ` +
          `Include "${placement.key}" in a composite UNIQUE (${placement.key}, ${uniqueCol}) or use a lookup directory.`,
      );
    }

    // `noOverlap` exclusion constraints must include the shard key in `by` so per-shard GiST stays exact.
    for (const rule of resource.noOverlap ?? []) {
      const byCols = Array.isArray(rule.by) ? rule.by : [rule.by];
      if (!byCols.includes(placement.key)) {
        errors.push(`${at}: noOverlap rule must include shard key "${placement.key}" in "by" to remain enforced across shards.`);
      }
    }

    // Correlated rollups must stay within the same co-location group.
    for (const [rollupName, rollup] of Object.entries(resource.rollups ?? {})) {
      const childPlacement = placements.get(rollup.from);
      if (isCrossGroupEdge(placement, childPlacement)) {
        errors.push(
          `${at}: rollup "${rollupName}" aggregates "${rollup.from}", which is in another shard group. ` +
            `Correlated rollups require co-located tables.`,
        );
      }
    }
  }

  // Warn when dashboard `find` or list `suggest` targets a sharded table without a search provider.
  for (const [viewId, view] of Object.entries(app.views ?? {})) {
    if ('suggest' in view && view.suggest?.length) {
      const resName = view.table;
      const res = app.resources?.[resName];
      if (res?.placement?.kind === 'sharded' && !res.search) {
        warnings.push(
          `view "${viewId}": "suggest" on sharded resource "${resName}" without a search provider triggers cross-shard scans on every keystroke.`,
        );
      }
    }
    if ('sections' in view && Array.isArray(view.sections)) {
      for (const section of view.sections) {
        if (section && typeof section === 'object' && 'kind' in section && section.kind === 'find' && 'resources' in section) {
          const targets = Array.isArray(section.resources) ? section.resources : [];
          for (const target of targets) {
            const resName = typeof target === 'string' ? target : (target as { resource?: string })?.resource;
            if (!resName) continue;
            const res = app.resources?.[resName];
            if (res?.placement?.kind === 'sharded' && !res.search) {
              warnings.push(
                `dashboard "${viewId}": "find" on sharded resource "${resName}" without a search provider fans out across every shard.`,
              );
            }
          }
        }
      }
    }
  }

  return { errors, warnings };
}

/** One search index hit carrying its record PK and optional shard key for shard-targeted hydration. */
interface ShardedSearchHit {
  readonly id: string | number;
  readonly shardKey?: string | number;
}

/**
 * Build an OR-of-AND `Filter` grouping search hits by `shardKey` so
 * `ShardedAdapter` hydrates matched rows ONLY from the shards that produced
 * hits, instead of scattering `WHERE id IN (...250 ids)` across all N shards.
 */
export function shardedSearchFilter(hits: readonly ShardedSearchHit[], shardKeyColumn: string, pkColumn: string): Filter {
  if (!hits.length) return { groups: [[{ column: pkColumn, op: 'isNull' }]] };
  const byShard = new Map<string, { shardVal: string | number; ids: Array<string | number> }>();
  const unkeyed: Array<string | number> = [];
  for (const hit of hits) {
    if (hit.shardKey === undefined || hit.shardKey === null || hit.shardKey === '') {
      unkeyed.push(hit.id);
      continue;
    }
    const k = String(hit.shardKey);
    const bucket = byShard.get(k);
    if (bucket) bucket.ids.push(hit.id);
    else byShard.set(k, { shardVal: hit.shardKey, ids: [hit.id] });
  }
  if (unkeyed.length || !byShard.size) {
    return { groups: [[{ column: pkColumn, op: 'in', value: hits.map((h) => h.id) }]] };
  }
  const groups: Condition[][] = [...byShard.values()].map(({ shardVal, ids }) => [
    { column: shardKeyColumn, op: '=', value: shardVal },
    ids.length === 1 ? { column: pkColumn, op: '=', value: ids[0]! } : { column: pkColumn, op: 'in', value: ids },
  ]);
  return { groups };
}
