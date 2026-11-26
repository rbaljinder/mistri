/**
 * Column projection (`.select`), batch lookup (`getMany`, `by`), and structured relation
 * hydration (`.include`) for command and page-loader `ctx.db` handles.
 *
 * Every included parent or child read runs through the peer table's own handle inside the
 * same transaction, preserving declared `reads`, role grants, field projection, row policy,
 * and tenant isolation with zero N+1 queries.
 */
import type { Condition, Filter } from '@mistriwork/engine/adapters/adapter.js';
import type { ColumnKind, ForeignKey, TableMeta } from '@mistriwork/engine/shared/schema.js';
import { authorFault } from '@mistriwork/engine/shared/refusal.js';
import { BusinessCommandExecutionError } from './commandErrors.js';

function authorMistake(message: string): never {
  throw authorFault(new BusinessCommandExecutionError('invalid_result'), message);
}

import type { DbIncludeSpec } from './commandDb.js';
interface DbIncludeParentObj {
  readonly via: string;
  readonly from?: string;
  readonly select?: readonly string[];
}
interface DbIncludeChildSpec {
  readonly from?: string;
  readonly by: string;
  readonly select?: readonly string[];
  readonly orderBy?: readonly [string, 'asc' | 'desc'];
  readonly limit?: number;
}

export interface IncludeTableMeta {
  readonly name: string;
  readonly key: readonly string[];
  readonly kinds: Readonly<Record<string, ColumnKind>>;
  readonly meta: TableMeta;
  readonly declared?: { readonly tables: readonly TableMeta[]; readonly foreignKeys: readonly ForeignKey[] };
}

export interface PeerReadHandle {
  getMany(
    keys: Iterable<string | number | Readonly<Record<string, unknown>>>,
    options?: { readonly select?: readonly string[] },
  ): Promise<Map<unknown, Record<string, unknown>>>;
  by(
    column: string,
    keys: Iterable<string | number>,
    options?: { readonly select?: readonly string[]; readonly orderBy?: readonly [string, 'asc' | 'desc']; readonly limit?: number },
  ): Promise<Map<unknown, Record<string, unknown>[]>>;
}

function isChildSpec(spec: unknown): spec is DbIncludeChildSpec {
  return Boolean(spec) && typeof spec === 'object' && !Array.isArray(spec) && typeof (spec as { by?: unknown }).by === 'string';
}

function isParentObj(spec: unknown): spec is DbIncludeParentObj {
  return Boolean(spec) && typeof spec === 'object' && !Array.isArray(spec) && typeof (spec as { via?: unknown }).via === 'string';
}

/** Validates and deduplicates caller-requested column projection for `table`. */
export function validateSelect(table: IncludeTableMeta, columns: readonly string[] | undefined): string[] | undefined {
  if (!columns) return undefined;
  if (!Array.isArray(columns) || !columns.length) {
    authorMistake(`${table.name}: select takes one or more column names.`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const col of columns) {
    if (typeof col !== 'string' || !Object.hasOwn(table.kinds, col)) {
      authorMistake(`${table.name}: "${String(col)}" is not one of its columns.`);
    }
    if (!seen.has(col)) {
      seen.add(col);
      out.push(col);
    }
  }
  return out;
}

/** Extra internal columns needed on the base query to stitch `include` relations when `select` is narrow. */
export function neededColumnsForInclude(table: IncludeTableMeta, include: DbIncludeSpec | undefined): string[] {
  if (!include) return [];
  const needed = new Set<string>();
  for (const [alias, spec] of Object.entries(include)) {
    if (spec === true || Array.isArray(spec)) {
      if (!Object.hasOwn(table.kinds, alias)) {
        authorMistake(
          `${table.name}: include "${alias}" is not a column on ${table.name}; for a child relation pass { by: '...' }, or for an aliased parent pass { via: '<fk_column>' }.`,
        );
      }
      needed.add(alias);
    } else if (isParentObj(spec)) {
      if (!Object.hasOwn(table.kinds, spec.via)) {
        authorMistake(`${table.name}: include "${alias}" references unknown column "${spec.via}".`);
      }
      needed.add(spec.via);
    } else if (isChildSpec(spec)) {
      if (table.key.length !== 1) {
        authorMistake(`${table.name}: child include "${alias}" requires ${table.name} to have a single-column primary key.`);
      }
      needed.add(table.key[0]!);
    } else {
      authorMistake(`${table.name}: invalid include specification for "${alias}".`);
    }
  }
  return [...needed];
}

/** Projects a row down to `selected` columns (preserving any included keys). */
export function projectRow(
  row: Record<string, unknown>,
  selected: readonly string[] | undefined,
  extraKeep?: ReadonlySet<string>,
): Record<string, unknown> {
  if (!selected) return row;
  const out: Record<string, unknown> = {};
  for (const col of selected) {
    if (Object.hasOwn(row, col)) out[col] = row[col];
  }
  if (extraKeep) {
    for (const key of extraKeep) {
      if (Object.hasOwn(row, key)) out[key] = row[key];
    }
  }
  return Object.freeze(out);
}

/** Hydrates parent and bounded child includes onto `rows` using batched peer table reads in the same transaction. */
export async function hydrateDbIncludes(
  table: IncludeTableMeta,
  rows: readonly Record<string, unknown>[],
  include: DbIncludeSpec | undefined,
  peers: Readonly<Record<string, PeerReadHandle>>,
  explicitSelect: readonly string[] | undefined,
): Promise<Record<string, unknown>[]> {
  if (!include || !Object.keys(include).length) {
    return explicitSelect ? rows.map((row) => projectRow(row, explicitSelect)) : [...rows];
  }
  const declaredNames = Object.keys(peers);
  const entries = Object.entries(include);

  interface ParentTask {
    readonly kind: 'parent';
    readonly alias: string;
    readonly via: string;
    readonly map: Map<unknown, Record<string, unknown>>;
  }
  interface ChildTask {
    readonly kind: 'child';
    readonly alias: string;
    readonly pkCol: string;
    readonly map: Map<unknown, Record<string, unknown>[]>;
  }

  const tasks = await Promise.all(
    entries.map(async ([alias, spec]): Promise<ParentTask | ChildTask> => {
      if (spec === true || Array.isArray(spec) || isParentObj(spec)) {
        const via = isParentObj(spec) ? spec.via : alias;
        const parentSelect = Array.isArray(spec) ? spec : isParentObj(spec) ? spec.select : undefined;
        const fk = table.declared?.foreignKeys.find(
          (key) => key.from.table === table.name && key.from.columns.length === 1 && key.from.columns[0] === via,
        );
        const explicitFrom = isParentObj(spec) ? spec.from : undefined;
        const targetName = explicitFrom ?? fk?.to.table;
        if (!targetName || !Object.hasOwn(peers, targetName)) {
          authorMistake(
            `${table.name}: include "${alias}" follows "${via}", whose target table${targetName ? ` "${targetName}"` : ''} is not declared in this handle's reads (${declaredNames.join(', ')}); declare it in read or write.`,
          );
        }
        const ids = new Set<string | number>();
        for (const row of rows) {
          const val = row[via];
          if (typeof val === 'string' || typeof val === 'number') ids.add(val);
        }
        const map = ids.size ? await peers[targetName]!.getMany(ids, parentSelect ? { select: parentSelect } : undefined) : new Map();
        return { kind: 'parent', alias, via, map };
      }
      if (isChildSpec(spec)) {
        const targetName = spec.from ?? alias;
        if (!Object.hasOwn(peers, targetName)) {
          authorMistake(
            `${table.name}: include "${alias}" reads "${targetName}", which is not declared in this handle's reads (${declaredNames.join(', ')}); declare it in read or write.`,
          );
        }
        if (table.key.length !== 1) {
          authorMistake(`${table.name}: child include "${alias}" requires a single-column primary key.`);
        }
        const pkCol = table.key[0]!;
        const parentIds = new Set<string | number>();
        for (const row of rows) {
          const val = row[pkCol];
          if (typeof val === 'string' || typeof val === 'number') parentIds.add(val);
        }
        const map = parentIds.size
          ? await peers[targetName]!.by(spec.by, parentIds, {
              ...(spec.select ? { select: spec.select } : {}),
              ...(spec.orderBy ? { orderBy: spec.orderBy } : {}),
              ...(spec.limit !== undefined ? { limit: spec.limit } : {}),
            })
          : new Map();
        return { kind: 'child', alias, pkCol, map };
      }
      authorMistake(`${table.name}: invalid include specification for "${alias}".`);
    }),
  );

  const includeAliases = new Set(entries.map(([alias]) => alias));
  return rows.map((row) => {
    const base = explicitSelect ? { ...projectRow(row, explicitSelect) } : { ...row };
    for (const task of tasks) {
      if (task.kind === 'parent') {
        const val = row[task.via];
        base[task.alias] = val === null || val === undefined ? null : (task.map.get(val) ?? null);
      } else {
        const pkVal = row[task.pkCol];
        base[task.alias] = pkVal === null || pkVal === undefined ? [] : (task.map.get(pkVal) ?? []);
      }
    }
    return Object.freeze(explicitSelect ? projectRow(base, explicitSelect, includeAliases) : base);
  });
}

/** Batch primary-key lookup returning a `Map` of matched rows (single query, zero queries on empty input). */
export async function runGetMany(
  table: IncludeTableMeta,
  keys: Iterable<string | number | Readonly<Record<string, unknown>>>,
  canonicalKey: (given: Record<string, unknown>) => Record<string, string | number> | undefined,
  readRows: (filter: Filter, limit: number, columns?: readonly string[]) => Promise<Record<string, unknown>[]>,
  select: readonly string[] | undefined,
  defaultCap: number,
): Promise<Map<unknown, Record<string, unknown>>> {
  const validatedSelect = validateSelect(table, select);
  const fetchCols = validatedSelect ? [...new Set([...table.key, ...validatedSelect])] : undefined;
  const result = new Map<unknown, Record<string, unknown>>();
  const rawList = [...keys];
  if (!rawList.length) return result;

  if (table.key.length === 1) {
    const pkCol = table.key[0]!;
    const unique = new Map<string | number, string | number>();
    for (const item of rawList) {
      const obj = item !== null && typeof item === 'object' ? (item as Record<string, unknown>) : { [pkCol]: item };
      const exact = canonicalKey(obj);
      if (exact && exact[pkCol] !== undefined) unique.set(exact[pkCol]!, exact[pkCol]!);
    }
    if (!unique.size) return result;
    if (unique.size > defaultCap) {
      authorMistake(`${table.name}: getMany takes at most ${defaultCap} keys.`);
    }
    const filter: Filter = { groups: [[{ column: pkCol, op: 'in', value: [...unique.values()] }]] };
    const found = await readRows(filter, defaultCap + 1, fetchCols);
    if (found.length > defaultCap) {
      authorMistake(`${table.name}: getMany matched more than ${defaultCap} rows.`);
    }
    for (const row of found) {
      const k = row[pkCol];
      if (k !== undefined && k !== null) result.set(k, validatedSelect ? projectRow(row, validatedSelect) : row);
    }
    return result;
  }

  /* Composite primary key: OR of AND groups, keyed by JSON tuple of primary key values. */
  const groups: Condition[][] = [];
  const seen = new Set<string>();
  for (const item of rawList) {
    if (!item || typeof item !== 'object') {
      authorMistake(`${table.name}: getMany on a composite key requires key objects (${table.key.join(', ')}).`);
    }
    const exact = canonicalKey(item as Record<string, unknown>);
    if (!exact) continue;
    const keyId = JSON.stringify(table.key.map((col) => exact[col]));
    if (seen.has(keyId)) continue;
    seen.add(keyId);
    groups.push(table.key.map((col) => ({ column: col, op: '=' as const, value: exact[col]! })));
  }
  if (!groups.length) return result;
  if (groups.length > defaultCap) {
    authorMistake(`${table.name}: getMany takes at most ${defaultCap} keys.`);
  }
  const found = await readRows({ groups }, defaultCap + 1, fetchCols);
  for (const row of found) {
    const keyId = JSON.stringify(table.key.map((col) => row[col]));
    result.set(keyId, validatedSelect ? projectRow(row, validatedSelect) : row);
  }
  return result;
}

/** Batch foreign-key lookup grouping child rows by `column` into `Map<Key, Row[]>`. */
export async function runBy(
  table: IncludeTableMeta,
  column: string,
  keys: Iterable<string | number>,
  scalar: (column: string, value: unknown) => string | number | boolean,
  readRows: (
    filter: Filter,
    limit: number,
    orderBy: readonly { column: string; direction: 'asc' | 'desc' }[],
    columns?: readonly string[],
  ) => Promise<Record<string, unknown>[]>,
  options: {
    readonly select?: readonly string[];
    readonly orderBy?: readonly [string, 'asc' | 'desc'];
    readonly limit?: number;
  } = {},
  defaultCap: number,
): Promise<Map<unknown, Record<string, unknown>[]>> {
  if (!Object.hasOwn(table.kinds, column)) {
    authorMistake(`${table.name}: "${column}" is not one of its columns.`);
  }
  const validatedSelect = validateSelect(table, options.select);
  const fetchCols = validatedSelect ? [...new Set([column, ...validatedSelect])] : undefined;
  const orderBy: { column: string; direction: 'asc' | 'desc' }[] = [];
  if (options.orderBy) {
    const [orderCol, dir] = options.orderBy;
    if (!Object.hasOwn(table.kinds, orderCol)) {
      authorMistake(`${table.name}: "${orderCol}" is not one of its columns.`);
    }
    orderBy.push({ column: orderCol, direction: dir === 'desc' ? 'desc' : 'asc' });
  }
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) {
    authorMistake(`${table.name}: by() limit must be a positive whole number.`);
  }

  const grouped = new Map<unknown, Record<string, unknown>[]>();
  const unique: Array<string | number> = [];
  const seen = new Set<string | number>();
  for (const raw of keys) {
    if (raw === null || raw === undefined) continue;
    const coerced = scalar(column, raw) as string | number;
    if (seen.has(coerced)) continue;
    seen.add(coerced);
    unique.push(coerced);
    grouped.set(coerced, []);
  }
  if (!unique.length) return grouped;

  const filter: Filter = { groups: [[{ column, op: 'in', value: unique }]] };
  const found = await readRows(filter, defaultCap + 1, orderBy, fetchCols);
  if (found.length > defaultCap) {
    authorMistake(`${table.name}: by("${column}") matched more than ${defaultCap} rows.`);
  }
  for (const row of found) {
    const val = row[column];
    const bucket = grouped.get(val);
    if (!bucket) continue;
    if (options.limit !== undefined && bucket.length >= options.limit) continue;
    bucket.push(validatedSelect ? projectRow(row, validatedSelect) : row);
  }
  return grouped;
}
