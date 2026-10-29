/*
 * Row scopes: the per-resource row filters a server-owned policy supplies,
 * captured within fixed limits, and the scoped relations a read or write is
 * compiled against. Shared so views and breakdowns compile under a scope
 * through the same builder as a plain read.
 */
import { buildWhere, OPS, type Filter, type SqlFragment, type SqlStyle } from './filter.js';
import { Refusal } from './refusal.js';
import { findTable, type DatabaseSchema } from './schema.js';
import { isFixedScopeCatalog } from './scopeCatalog.js';
import { qualifiedTable } from './sqlRelation.js';
import { tryResolvePath } from './viewPaths.js';

/** Internal, server-owned compiler input; never a member of a request definition.
 * Exact catalog IDs only. With a scope present, missing resources deny rows.
 * `true` explicitly allows all rows; filters address local columns, not paths.
 * This primitive alone does not enable App authorization or tenant isolation.
 */
export interface RowScopeFilter extends Filter {
  /** Private SQLite comparison metadata, never SQL or a request filter field.
   * Applies BINARY collation to these local columns; LIKE keeps its own semantics. */
  readonly binary?: readonly string[];
}
export type RowScope = Readonly<Record<string, boolean | RowScopeFilter>>;

/** Composition must budget expanded data against the same capture limits. */
export const ROW_SCOPE_LIMITS = Object.freeze({
  resources: 256,
  conditions: 2048,
  array: 4096,
  nodes: 16_384,
  string: 16_384,
  characters: 262_144,
});

const invalid = (): never => {
  throw new Refusal('Invalid row scope.');
};

/** Copy before validation so accessors, prototypes and later mutation cannot
 * change what was checked. Bounds apply to the entire scope, not each table.
 * Frozen nested values stay private; Readonly<Record> alone is not a snapshot.
 */
export function captureRowScope(input: RowScope): RowScope {
  let nodes = 0;
  let characters = 0;
  const copy = (value: unknown, depth = 0): unknown => {
    if (++nodes > ROW_SCOPE_LIMITS.nodes || depth > 8) return invalid();
    if (typeof value === 'string') {
      characters += value.length;
      if (value.length > ROW_SCOPE_LIMITS.string || characters > ROW_SCOPE_LIMITS.characters) return invalid();
      return value;
    }
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
    if (!value || typeof value !== 'object') return invalid();
    const array = Array.isArray(value);
    const proto = Object.getPrototypeOf(value);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return invalid();
    const keys = Reflect.ownKeys(value);
    if (keys.length > ROW_SCOPE_LIMITS.array + 1) return invalid();
    if (array) {
      const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
      if (!Number.isInteger(length) || length > ROW_SCOPE_LIMITS.array || keys.length !== length + 1) return invalid();
      const result: unknown[] = [];
      for (let i = 0; i < length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return invalid();
        result.push(copy(descriptor.value, depth + 1));
      }
      return Object.freeze(result);
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string') return invalid();
      characters += key.length;
      if (key.length > ROW_SCOPE_LIMITS.string || characters > ROW_SCOPE_LIMITS.characters) return invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in descriptor) || !descriptor.enumerable) return invalid();
      result[key] = copy(descriptor.value, depth + 1);
    }
    return Object.freeze(result);
  };
  const scope = copy(input);
  if (!scope || typeof scope !== 'object' || Array.isArray(scope) || Object.keys(scope).length > ROW_SCOPE_LIMITS.resources)
    return invalid();
  return scope as RowScope;
}

/* The scopes this module copied, froze and checked, each with the catalogs it
   was checked against. A tenant read snapshotted one request's scope again at
   every layer it crossed — composed, authorized, bound, and once more per
   statement — each a full copy and a scan of the catalog for every resource:
   a field report's profile put it among the largest costs of a page. A
   snapshot is frozen all the way down and was made here, never by a caller,
   so checking it again against the same catalog object could only pass and
   copy it to an equal value: it is handed back as it is. A catalog that can
   still change is checked afresh every time, as before; anything a caller
   built, however frozen, is copied every time and then found by its text
   (below), never handed back as itself. */
const snapshots = new WeakMap<object, WeakSet<DatabaseSchema>>();
const checkedAgainst = (scope: object, schema: DatabaseSchema) => snapshots.get(scope)?.has(schema) === true;

/* And by what they say. A policy that names its reader (`owner_account_id = <the account>`) builds its scope afresh
   on every request: a new object each time, equal to the last, so every request copied and checked it again, and
   every cache keyed by a scope's identity downstream (tenantReadScope.ts compositions, the scoped reads' kept
   statements) missed, composing and compiling afresh too — a field report's tenant App, whose staff scope names
   two hundred tables and the reader, spent a sixth of a tenant enter there. The copy is still made, so nothing the
   caller holds can change what is checked; it is then looked up by its text against a catalog nothing can change,
   and an equal scope already checked against it is handed back. The text is the copy's own — plain strings,
   booleans, finite numbers, arrays and records, nothing else survives captureRowScope — so equal text is an equal
   scope. Bounded per catalog; a reader past the bound is checked as before. */
const byText = new WeakMap<DatabaseSchema, Map<string, RowScope>>();
const BY_TEXT_HELD = 256;

/** A scope's text, where the text says all of it: undefined for anything JSON would say the same as something else
 * (an undefined value, which it drops; a non-finite number; an object that is not a plain record). Only for data
 * nothing can intercept — a copy this module or the tenant capture made — never a caller's live object, whose
 * accessors JSON.stringify would run. */
export function rowScopeText(value: unknown): string | undefined {
  let plain = true;
  const text = JSON.stringify(value, (_key, item: unknown) => {
    if (
      item === undefined ||
      (typeof item === 'number' && !Number.isFinite(item)) ||
      (item !== null && typeof item === 'object' && !Array.isArray(item) && ![null, Object.prototype].includes(Object.getPrototypeOf(item)))
    )
      plain = false;
    return item;
  });
  return plain ? text : undefined;
}

/** Test-only: how many row scopes were copied and checked in full rather than handed back. */
export const rowScopeCounters = { checked: 0 };

/** Whether `value` is a row scope snapshotRowScope made: plain data, frozen all the way down, that nothing can change. */
export function isRowScopeSnapshot(value: unknown): boolean {
  return value !== null && typeof value === 'object' && snapshots.has(value);
}

/** Capture can precede an async catalog load; catalog validation cannot. */
export function snapshotRowScope(schema: DatabaseSchema, input: RowScope): RowScope {
  if (input !== null && typeof input === 'object' && checkedAgainst(input, schema)) return input;
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  /* A snapshot checked against another catalog — the same policy's constant scope under a second deployment of the
     App in this process, after a reload — is already plain frozen data this module made, so it is checked as it is
     and kept against this catalog too. Copied, its copy was a new object each time, which the caches keyed by a
     scope (tenantReadScope.ts) never found again: every request after a reload checked and composed afresh. */
  const scope = isRowScopeSnapshot(input) ? input : captureRowScope(input);
  const fixed = isFixedScopeCatalog(schema);
  const text = fixed && scope !== input ? rowScopeText(scope) : undefined;
  const held = text === undefined ? undefined : byText.get(schema);
  const known = text === undefined ? undefined : held?.get(text);
  if (known) return known;
  rowScopeCounters.checked++;
  let conditions = 0;
  for (const [id, policy] of Object.entries(scope)) {
    const table = findTable(schema, id);
    if (!table) return invalid();
    if (typeof policy === 'boolean') continue;
    if (
      !record(policy) ||
      Object.keys(policy).some((key) => key !== 'groups' && key !== 'binary') ||
      !Array.isArray(policy.groups) ||
      !policy.groups.length
    )
      return invalid();
    if (Object.hasOwn(policy, 'binary')) {
      if (
        schema.dialect !== 'sqlite' ||
        !Array.isArray(policy.binary) ||
        policy.binary.some((name) => typeof name !== 'string' || !table.columns.some((column) => column.name === name)) ||
        new Set(policy.binary).size !== policy.binary.length
      )
        return invalid();
    }
    for (const group of policy.groups) {
      if (!Array.isArray(group) || !group.length) return invalid();
      for (const condition of group) {
        if (++conditions > ROW_SCOPE_LIMITS.conditions || !record(condition)) return invalid();
        if (Object.keys(condition).some((key) => !['column', 'op', 'value'].includes(key))) return invalid();
        if (typeof condition.column !== 'string' || !table.columns.some((column) => column.name === condition.column)) return invalid();
        if (typeof condition.op !== 'string' || !OPS.has(condition.op)) return invalid();
        if (condition.op === 'isNull' || condition.op === 'isNotNull') {
          if (Object.hasOwn(condition, 'value')) return invalid();
        } else if (condition.op === 'in') {
          if (!Array.isArray(condition.value) || condition.value.some((value) => typeof value !== 'string' && typeof value !== 'number'))
            return invalid();
        } else if (['contains', 'startsWith', 'endsWith', 'like'].includes(condition.op)) {
          if (typeof condition.value !== 'string') return invalid();
        } else if (!['string', 'number', 'boolean'].includes(typeof condition.value)) return invalid();
      }
    }
  }
  // Kept only against a catalog nothing can change; checked against one that can, it is checked again next time.
  if (fixed) {
    const against = snapshots.get(scope);
    if (against) against.add(schema);
    else snapshots.set(scope, new WeakSet([schema]));
    if (text !== undefined) {
      let kept = held;
      if (!kept) byText.set(schema, (kept = new Map()));
      if (kept.size >= BY_TEXT_HELD) kept.delete(kept.keys().next().value!);
      kept.set(text, scope);
    }
  }
  return scope as RowScope;
}

/**
 * A scope with each group's repeated conditions said once. Composed scopes
 * repeat themselves — a tenant's ownership condition and a membership rule
 * that names the same column and value — and `"tenant_id" = $1 AND
 * "tenant_id" = $2` is the same rows as either half, while the planner
 * estimates it as two independent predicates and misjudges every join above
 * it. Only a condition identical in every field is dropped:
 * a conjunction of one condition with itself is that condition, so no row
 * the scope admits or refuses changes.
 */
function withoutRepeats(policy: RowScopeFilter): Filter {
  return {
    groups: policy.groups.map((group) => {
      const seen = new Set<string>();
      return group.filter((condition) => {
        // Every field, in a fixed order: a collation or a column comparison is a different condition.
        const key = JSON.stringify(
          Object.keys(condition)
            .sort()
            .map((name) => [name, (condition as unknown as Record<string, unknown>)[name]]),
        );
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }),
  };
}

/* A catalog's table names, lower-cased: what a scoped relation's name must not
   shadow. The same for every statement compiled over a catalog nothing can
   change, so it is listed once for such a catalog, not once per statement. */
const reservedOf = new WeakMap<DatabaseSchema, readonly string[]>();
function reservedNames(schema: DatabaseSchema): readonly string[] {
  const kept = reservedOf.get(schema);
  if (kept) return kept;
  const names = schema.tables.map((table) => table.name.toLowerCase());
  if (isFixedScopeCatalog(schema)) reservedOf.set(schema, names);
  return names;
}

/** Every occurrence of a resource reads the same filtered relation, including
 * LEFT JOIN targets and correlated aggregate children. CTE bindings precede
 * outer filters, independent of SQL SELECT/FROM expression order. Call finish
 * only after all relations have been discovered, then number outer bindings.
 */
export class ScopedRelations {
  private readonly scope: RowScope | undefined;
  private readonly names = new Map<string, string>();
  private readonly reserved: Set<string>;
  private readonly definitions: string[] = [];
  private readonly params: unknown[] = [];
  private finished = false;
  private ordinal = 0;

  constructor(
    private schema: DatabaseSchema,
    private style: SqlStyle,
    scope?: RowScope,
  ) {
    this.scope = scope === undefined ? undefined : snapshotRowScope(schema, scope);
    this.reserved = new Set(reservedNames(schema));
  }

  table = (id: string): string => {
    if (this.scope === undefined) return qualifiedTable(this.schema, id, this.style);
    const existing = this.names.get(id);
    if (existing) return this.style.quote(existing);
    if (this.finished) throw new Error('Row scope relations must be planned before outer parameters.');
    const table = findTable(this.schema, id);
    if (!table || !table.columns.length) return invalid();
    // '$' cannot occur in JoinPlan's sanitized aliases; catalog names still
    // need a case-insensitive collision check to avoid CTE self-shadowing.
    let name: string;
    do {
      name = `_tw_scope$${++this.ordinal}`;
    } while (this.reserved.has(name.toLowerCase()));
    this.reserved.add(name.toLowerCase());
    this.names.set(id, name);
    const policy = this.scope[id] ?? false;
    const where =
      typeof policy === 'boolean'
        ? { text: policy ? '' : ' WHERE 1 = 0', params: [] }
        : buildWhere(
            withoutRepeats(policy),
            this.style,
            this.params.length + 1,
            (column) => this.style.quote(column) + (policy.binary?.includes(column) ? ' COLLATE BINARY' : ''),
          );
    const columns = table.columns.map((column) => this.style.quote(column.name)).join(', ');
    // The style's hint (cteHint) goes between AS and the body: Postgres inlines the CTE, so the
    // scope's predicate meets the read's own filter, sort and limit instead of a copied slice.
    this.definitions.push(
      `${this.style.quote(name)} AS${this.style.cteHint ?? ''} (SELECT ${columns} FROM ${qualifiedTable(this.schema, id, this.style)}${where.text})`,
    );
    this.params.push(...where.params);
    return this.style.quote(name);
  };

  private readonly narrowed = new Map<string, string>();

  /**
   * A table's rows narrowed by an authored filter over its own columns — the
   * rows a rollup counts (rollups.ts) — as one more definition here. A CTE
   * rather than a WHERE inside the correlated subquery, for the parameters:
   * a subquery can sit in the SELECT list, the WHERE and the ORDER BY at
   * once, and `?` placeholders bind by position, so values written there
   * would interleave with the outer filter's. Here they bind first, with the
   * scope's, and the subquery names the relation with no values of its own.
   * Read from the scoped relation where there is a scope, so the filter
   * narrows within the reader's rows, never beside them.
   */
  filtered = (id: string, filter: Filter, written?: Readonly<Record<string, (own: (column: string) => string) => string>>): string => {
    const key = `${id}\u0000${JSON.stringify(filter)}\u0000${Object.keys(written ?? {}).join(',')}`;
    const existing = this.narrowed.get(key);
    if (existing) return this.style.quote(existing);
    if (this.finished) throw new Error('Filtered relations must be planned before outer parameters.');
    const source = this.table(id);
    const table = findTable(this.schema, id);
    if (!table || !table.columns.length) return invalid();
    let name: string;
    do {
      name = `_tw_scope$${++this.ordinal}`;
    } while (this.reserved.has(name.toLowerCase()));
    this.reserved.add(name.toLowerCase());
    this.narrowed.set(key, name);
    const q = this.style.quote;
    /* A path (`sales_order_id.status`) is the column it lands on, read by one scalar subquery that walks
       its references from this row through the statement's relations — so a row policy on the order
       narrows what the path can see, as it does a list's join. Planned before the WHERE is written, for
       the parameters: a relation's own scope binds ahead of this filter's values. */
    const named = filter.groups.flatMap((group) => group.flatMap((c) => [c.column, ...(c.other === undefined ? [] : [c.other])]));
    const row = named.some((column) => column.includes('.')) ? '_tw_row' : undefined;
    const own = (column: string) => (row ? `${q(row)}.${q(column)}` : q(column));
    const paths = new Map<string, string>();
    for (const path of named) {
      // A computed column of the row (a rollup's query, rollups.ts `computed`): its expression over this row's columns.
      if (written && Object.hasOwn(written, path)) {
        if (!paths.has(path)) paths.set(path, `(${written[path](own)})`);
        continue;
      }
      if (!path.includes('.') || paths.has(path)) continue;
      const { resolved } = tryResolvePath(this.schema, id, path);
      if (!resolved || !resolved.hops.length || resolved.rollup || resolved.computed || resolved.tags || resolved.jsonKey) return invalid();
      const aliases = resolved.hops.map(() => `_tw_hop$${++this.ordinal}`);
      const joins = resolved.hops.map((hop, at) => {
        const on = hop.to.columns
          .map(
            (to, i) => `${q(aliases[at])}.${q(to)} = ${at ? `${q(aliases[at - 1])}.${q(hop.from.columns[i])}` : own(hop.from.columns[i])}`,
          )
          .join(' AND ');
        return { relation: `${this.table(hop.to.table)} ${q(aliases[at])}`, on };
      });
      const [first, ...rest] = joins;
      paths.set(
        path,
        `(SELECT ${q(aliases[aliases.length - 1])}.${q(resolved.column.name)} FROM ${first.relation}` +
          rest.map((join) => ` JOIN ${join.relation} ON ${join.on}`).join('') +
          ` WHERE ${first.on})`,
      );
    }
    const local = (column: string) => paths.get(column) ?? own(column);
    const where = buildWhere(filter, this.style, this.params.length + 1, local, local);
    const columns = table.columns.map((column) => q(column.name)).join(', ');
    this.definitions.push(`${q(name)} AS (SELECT ${columns} FROM ${source}${row ? ` ${q(row)}` : ''}${where.text})`);
    this.params.push(...where.params);
    return this.style.quote(name);
  };

  finish(): SqlFragment {
    this.finished = true;
    return { text: this.definitions.length ? `WITH ${this.definitions.join(',\n     ')}\n` : '', params: [...this.params] };
  }
}
