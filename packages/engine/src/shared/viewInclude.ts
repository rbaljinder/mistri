/**
 * Structured relation includes for multi-table page reads (`useRows` / `useRecord` and `/api/view/run`).
 *
 * Parent includes (`seller_id: ['name', 'city']` or `seller: { via: 'seller_id', show: ['name', 'city'] }`)
 * flatten into dotted paths on the main `/api/view/run` query (one SQL LEFT JOIN, zero extra round trips)
 * and reshape back into typed nested objects (`row.seller_id?.name` or `row.seller?.name`).
 *
 * Child includes (`listing_photo: { by: 'listing_id', show: [...], sort: 'position asc', limit: 20 }`)
 * travel on `/api/view/run` and execute as bounded, grant-checked batched reads in the same HTTP round trip.
 */

export interface ParentIncludeObject {
  readonly via: string;
  readonly show: readonly string[];
}

export interface ChildIncludeSpec {
  readonly from?: string;
  readonly by: string;
  readonly show?: readonly string[];
  readonly sort?: string;
  readonly limit?: number;
  readonly where?: unknown;
  readonly query?: string;
}

export type IncludeEntry = readonly string[] | ParentIncludeObject | ChildIncludeSpec;
export type ViewIncludeSpec = Readonly<Record<string, IncludeEntry>>;

export interface NormalizedParentInclude {
  readonly alias: string;
  readonly via: string;
  readonly show: readonly string[];
}

export interface NormalizedChildInclude {
  readonly alias: string;
  readonly from: string;
  readonly by: string;
  readonly show?: readonly string[];
  readonly sort?: string;
  readonly limit: number;
  readonly where?: unknown;
  readonly query?: string;
}

export interface IncludedChildPayload {
  readonly rowsByParent: Readonly<Record<string, readonly Record<string, unknown>[]>>;
}

export const CHILD_INCLUDE_MAX = 8;
export const CHILD_INCLUDE_DEFAULT_LIMIT = 20;
export const CHILD_INCLUDE_MAX_LIMIT = 100;

export function isChildIncludeEntry(value: unknown): value is ChildIncludeSpec {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && typeof (value as { by?: unknown }).by === 'string';
}

export function isParentIncludeObject(value: unknown): value is ParentIncludeObject {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as { via?: unknown }).via === 'string' &&
    Array.isArray((value as { show?: unknown }).show)
  );
}

/** Splits an `include` map into parent FK joins (compiled into dotted paths) and reverse-FK child includes. */
export function splitInclude(include: ViewIncludeSpec | undefined): {
  readonly parents: readonly NormalizedParentInclude[];
  readonly children: Readonly<Record<string, NormalizedChildInclude>>;
  readonly hasChildren: boolean;
} {
  if (!include || typeof include !== 'object') return { parents: [], children: {}, hasChildren: false };
  const parents: NormalizedParentInclude[] = [];
  const children: Record<string, NormalizedChildInclude> = {};
  let hasChildren = false;
  for (const [alias, spec] of Object.entries(include)) {
    if (!alias) continue;
    if (Array.isArray(spec)) {
      const cols = spec.filter((c): c is string => typeof c === 'string' && c.length > 0);
      if (cols.length) parents.push({ alias, via: alias, show: cols });
    } else if (isParentIncludeObject(spec)) {
      const cols = spec.show.filter((c): c is string => typeof c === 'string' && c.length > 0);
      if (spec.via && cols.length) parents.push({ alias, via: spec.via, show: cols });
    } else if (isChildIncludeEntry(spec)) {
      const limit =
        typeof spec.limit === 'number' && Number.isInteger(spec.limit) && spec.limit >= 1
          ? Math.min(spec.limit, CHILD_INCLUDE_MAX_LIMIT)
          : CHILD_INCLUDE_DEFAULT_LIMIT;
      children[alias] = {
        alias,
        from: typeof spec.from === 'string' && spec.from ? spec.from : alias,
        by: spec.by,
        ...(Array.isArray(spec.show) ? { show: spec.show.filter((c): c is string => typeof c === 'string' && c.length > 0) } : {}),
        ...(typeof spec.sort === 'string' && spec.sort.trim() ? { sort: spec.sort.trim() } : {}),
        limit,
        ...(spec.where !== undefined ? { where: spec.where } : {}),
        ...(typeof spec.query === 'string' && spec.query.trim() ? { query: spec.query.trim() } : {}),
      };
      hasChildren = true;
    }
  }
  return { parents, children, hasChildren };
}

/** Flat dotted paths (and FK columns) required on the main `/api/view/run` query to satisfy parent includes. */
export function parentIncludePaths(parents: readonly NormalizedParentInclude[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (path: string) => {
    if (!seen.has(path)) {
      seen.add(path);
      out.push(path);
    }
  };
  for (const parent of parents) {
    add(parent.via);
    for (const col of parent.show) add(`${parent.via}.${col}`);
  }
  return out;
}

/** Child table names referenced in a raw `/api/view/run` `include` body (for `tablesReached` and `asksOutside`). */
export function childIncludeTables(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const tables: string[] = [];
  for (const [alias, spec] of Object.entries(raw as Record<string, unknown>)) {
    if (!isChildIncludeEntry(spec)) continue;
    const target = typeof spec.from === 'string' && spec.from ? spec.from : alias;
    if (target && !tables.includes(target)) tables.push(target);
  }
  return tables;
}

/**
 * Reshapes parent dotted paths and attaches server-returned child arrays onto each row.
 * Removes internal-only dotted paths (and internal FK columns) that the caller did not ask for in `explicitShow`.
 */
export function shapeIncludedRows<Row extends Record<string, unknown>>(
  rows: readonly Row[],
  parents: readonly NormalizedParentInclude[],
  included: Readonly<Record<string, IncludedChildPayload>> | undefined,
  pkColumn: string | undefined,
  explicitShow: readonly string[] | undefined,
): Row[] {
  const hasIncluded = Boolean(included && Object.keys(included).length > 0);
  if (!parents.length && !hasIncluded) return rows as Row[];
  const explicit = explicitShow ? new Set(explicitShow) : undefined;
  const internalKeys = new Set<string>();
  if (explicit) {
    for (const parent of parents) {
      if (!explicit.has(parent.via) && parent.alias !== parent.via) internalKeys.add(parent.via);
      for (const col of parent.show) {
        const dotted = `${parent.via}.${col}`;
        if (!explicit.has(dotted)) internalKeys.add(dotted);
      }
    }
  }
  return rows.map((row) => {
    const next: Record<string, unknown> = { ...row };
    for (const parent of parents) {
      const fkVal = row[parent.via];
      if (fkVal === null || fkVal === undefined) {
        next[parent.alias] = null;
      } else {
        const obj: Record<string, unknown> = {};
        let anyPresent = false;
        for (const col of parent.show) {
          const val = row[`${parent.via}.${col}`];
          if (val !== undefined) {
            obj[col] = val;
            if (val !== null) anyPresent = true;
          } else {
            obj[col] = null;
          }
        }
        /* When every joined column came back undefined (e.g., row policy hid the parent), present null rather than an all-null shell. */
        const allUndefined = parent.show.every((col) => row[`${parent.via}.${col}`] === undefined);
        next[parent.alias] = allUndefined && !anyPresent ? null : obj;
      }
    }
    for (const key of internalKeys) delete next[key];
    if (hasIncluded && pkColumn) {
      const pkVal = row[pkColumn];
      const keyStr = pkVal === null || pkVal === undefined ? undefined : String(pkVal);
      for (const [alias, payload] of Object.entries(included!)) {
        next[alias] = keyStr !== undefined && Object.hasOwn(payload.rowsByParent, keyStr) ? payload.rowsByParent[keyStr] : [];
      }
    }
    return next as Row;
  });
}
