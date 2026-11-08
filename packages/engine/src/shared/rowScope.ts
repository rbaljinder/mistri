/*
 * Row scopes: the per-resource row filters a server-owned policy supplies,
 * captured within fixed limits, and the scoped relations a read or write is
 * compiled against. Shared so views and breakdowns compile under a scope
 * through the same builder as a plain read.
 */
import { buildWhere, OPS, POSTGRES_STYLE, type Condition, type Filter, type SqlFragment, type SqlStyle } from './filter.js';
import { Refusal } from './refusal.js';
import { findTable, type DatabaseSchema, type TableMeta } from './schema.js';
import { isFixedScopeCatalog } from './scopeCatalog.js';
import { qualifiedTable } from './sqlRelation.js';
import { plainType, tryResolvePath } from './viewPaths.js';

/** Internal, server-owned compiler input; never a member of a request definition.
 * Exact catalog IDs only. With a scope present, missing resources deny rows.
 * `true` explicitly allows all rows; filters address local columns, not paths.
 * This primitive alone does not enable App authorization or tenant isolation.
 */
export interface RowScopeFilter {
  groups: Array<Array<Condition | ViaCondition>>;
  /** Private SQLite comparison metadata, never SQL or a request filter field.
   * Applies BINARY collation to these local columns; LIKE keeps its own semantics. */
  readonly binary?: readonly string[];
}

/** The rows of another resource this row's key must be among: the ones this reader may see there. */
export interface RowScopeVia {
  readonly resource: string;
  /** The target's key; equal in length to the condition's `column` (a composite key is compared pairwise). */
  readonly column: string | readonly string[];
  /** Narrows the target's rows further (never wider): groups are ORed, conditions in one ANDed, literal conditions only. */
  readonly where?: readonly (readonly Condition[])[];
}

/** `column in <the rows of via.resource this reader may see>`: compiled to an EXISTS over the target's scoped relation. */
export interface ViaCondition {
  readonly column: string | readonly string[];
  readonly op: 'in';
  readonly via: RowScopeVia;
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

/**
 * `via('support_case_id', 'support_case')`: the row shows when its `support_case_id` is the `id` of a `support_case` row
 * the reader may see. The target's key defaults to `id`; a composite key is arrays of equal length
 * (`via(['tenant_id', 'case_no'], 'support_case', ['tenant_id', 'no'])`). `where` narrows the target's rows further
 * (`[[{ column: 'status', op: '=', value: 'open' }]]`): never wider, since it filters the scoped relation.
 */
export function via(
  column: string | readonly string[],
  resource: string,
  key: string | readonly string[] = 'id',
  where?: RowScopeVia['where'],
): ViaCondition {
  return { column, op: 'in', via: { resource, column: key, ...(where ? { where } : {}) } };
}

/** A rule with every `via` target renamed by `rename` (a resource's id to its physical table's): the condition's own columns are the table's, and stay. */
export function renameViaTargets(rule: RowScope[string], rename: (resource: string) => string): RowScope[string] {
  if (rule === true || rule === false) return rule;
  // A captured scope is frozen to its leaves and a bound transaction holds it as such: a rule with no relationship test
  // is handed back as it came, and one that is rebuilt is frozen again (its untouched conditions already are).
  if (!rule.groups.some((group) => group.some(isVia))) return rule;
  return Object.freeze({
    ...rule,
    groups: Object.freeze(
      rule.groups.map((group) =>
        Object.freeze(
          group.map((condition) =>
            isVia(condition)
              ? Object.freeze({ ...condition, via: Object.freeze({ ...condition.via, resource: rename(condition.via.resource) }) })
              : condition,
          ),
        ),
      ),
    ),
  }) as RowScopeFilter;
}

/** A `via` whose target key, or whose own column, no index leads: an EXISTS per row is then a scan per row. Advice for
 * the operator, never a refusal: slow, not wrong. Read off the catalog's own index list, so a table whose adapter does
 * not report indexes (`indexed` absent) is not judged. One line per rule, in policy order. */
export function rowScopeViaAdvisories(schema: DatabaseSchema, scope: RowScope): string[] {
  // Per policy object: asked on every request, and a snapshot is held across them (a new catalog is a new answer).
  let held = advised.get(scope);
  if (!held) advised.set(scope, (held = new WeakMap()));
  let lines = held.get(schema);
  if (!lines) held.set(schema, (lines = viaAdvisories(schema, scope)));
  return lines;
}

const advised = new WeakMap<RowScope, WeakMap<DatabaseSchema, string[]>>();

function viaAdvisories(schema: DatabaseSchema, scope: RowScope): string[] {
  const lines: string[] = [];
  const led = (table: TableMeta | undefined, column: string): boolean | undefined =>
    table?.indexed === undefined
      ? undefined
      : table.indexed.includes(column) || table.columns.some((c) => c.name === column && c.primaryKey);
  for (const [id, rule] of Object.entries(scope)) {
    if (rule === true || rule === false) continue;
    for (const group of rule.groups)
      for (const condition of group) {
        if (!isVia(condition)) continue;
        const from = findTable(schema, id),
          to = findTable(schema, condition.via.resource);
        const missing = [
          ...columnsOf(condition.via.column).flatMap((key) => (led(to, key) === false ? [`${condition.via.resource}.${key}`] : [])),
          ...(condition.via.resource !== id
            ? columnsOf(condition.column).flatMap((own) => (led(from, own) === false ? [`${id}.${own}`] : []))
            : []),
        ];
        if (missing.length)
          lines.push(
            `the row scope of "${id}" reads through "${condition.via.resource}", and no index leads ${missing.join(' or ')}: each row's test scans the other table. Index ${missing.join(' and ')}.`,
          );
      }
  }
  return lines;
}

const invalid = (): never => {
  throw new Refusal('Invalid row scope.');
};

/** A `via` rule refused, saying which rule and why: a bare "Invalid row scope." sent an author to guess at a graph. */
const refuse = (reason: string): never => {
  throw new Refusal(`Invalid row scope: ${reason}`);
};

/** How many hops a chain of `via` targets may be: deeper is almost certainly a modeling mistake and builds a deep CTE chain. */
const VIA_DEPTH = 8;
/** How many columns one composite `via` key may name. */
const VIA_KEY = 8;

/* The family a built-in PostgreSQL column compares in: every number is one, as is every kind of text. Absent for a type
   whose operators are its own (an enum, citext), which is not judged. */
const columnFamily = (table: TableMeta, name: string): string | undefined => {
  const built = POSTGRES_STYLE.builtin?.(typeOfColumn(table, name));
  if (!built) return undefined;
  return ['int2', 'int4', 'int8', 'numeric', 'float4', 'float8'].includes(built.name) ? 'number' : built.text ? 'text' : built.name;
};
const typeOfColumn = (table: TableMeta, name: string): string => table.columns.find((column) => column.name === name)?.type ?? '';

const isVia = (condition: unknown): condition is ViaCondition =>
  !!condition && typeof condition === 'object' && Object.hasOwn(condition, 'via');
const columnsOf = (column: string | readonly string[]): readonly string[] => (typeof column === 'string' ? [column] : column);

/* Past a size bound the scope is refused, never cut short, and the refusal says which bound, by how much and what to
   do instead: "Invalid row scope." alone sent a policy author to guess, and one capped its own list to fit — a silent
   truncation of who may see what, which is the thing the bound exists to refuse. */
const NEXT_STEP = 'Narrow the policy, or scope through the parent with `via` instead of listing its keys (docs: Row access, "Bounds").';
const counted = (n: number) => n.toLocaleString('en-US');
const pastBound = (what: string, size: number, bound: number, unit: string, per: string, more = false): never => {
  const over = more ? 'more than ' : '';
  throw new Refusal(
    `Invalid row scope: ${what} ${over}${counted(size)} ${unit}, ${over}${counted(size - bound)} past the bound of ${counted(bound)} ${per}. ${NEXT_STEP}`,
  );
};

/** How many values a scope holds, as the copy counts them (a value met twice counts twice), for a refusal to say how
 * far past the bound it went. Reads only data properties (never an accessor), as deep as the copy goes, and stops
 * counting at `cap`, so a cycle ends. */
function valuesIn(input: unknown, cap: number): number {
  const pending: Array<[unknown, number]> = [[input, 0]];
  let count = 0;
  while (pending.length && count < cap) {
    const [value, depth] = pending.pop()!;
    count += 1;
    if (!value || typeof value !== 'object' || depth >= 10) continue;
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && 'value' in descriptor && descriptor.enumerable) pending.push([descriptor.value, depth + 1]);
    }
  }
  return count;
}

/** Copy before validation so accessors, prototypes and later mutation cannot
 * change what was checked. Bounds apply to the entire scope, not each table.
 * Frozen nested values stay private; Readonly<Record> alone is not a snapshot.
 */
export function captureRowScope(input: RowScope): RowScope {
  let nodes = 0;
  let characters = 0;
  const copy = (value: unknown, depth = 0): unknown => {
    if (++nodes > ROW_SCOPE_LIMITS.nodes) {
      const cap = ROW_SCOPE_LIMITS.nodes * 64;
      const all = valuesIn(input, cap);
      return pastBound('the scope holds', all, ROW_SCOPE_LIMITS.nodes, 'values', 'in one scope', all >= cap);
    }
    if (depth > 10) return invalid();
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
    if (array) {
      const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
      if (Number.isInteger(length) && length > ROW_SCOPE_LIMITS.array)
        return pastBound('a list holds', length, ROW_SCOPE_LIMITS.array, 'values', 'per list');
      if (!Number.isInteger(length) || keys.length !== length + 1) return invalid();
      const result: unknown[] = [];
      for (let i = 0; i < length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return invalid();
        result.push(copy(descriptor.value, depth + 1));
      }
      return Object.freeze(result);
    }
    if (keys.length > ROW_SCOPE_LIMITS.array) return pastBound('a record holds', keys.length, ROW_SCOPE_LIMITS.array, 'keys', 'per record');
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
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return invalid();
  const resources = Object.keys(scope).length;
  if (resources > ROW_SCOPE_LIMITS.resources)
    return pastBound('the scope names', resources, ROW_SCOPE_LIMITS.resources, 'resources', 'in one scope');
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
  const count = () => {
    if (++conditions <= ROW_SCOPE_LIMITS.conditions) return;
    // The copy is plain frozen data, so counting every group is safe; it says how far past the bound it went.
    const all = Object.values(scope).reduce(
      (sum, entry) =>
        sum +
        (record(entry) && Array.isArray(entry.groups)
          ? entry.groups.reduce(
              (n, g) =>
                n +
                (Array.isArray(g)
                  ? g.reduce(
                      (m, c) => m + 1 + (record(c) && record(c.via) && Array.isArray(c.via.where) ? c.via.where.flat().length : 0),
                      0,
                    )
                  : 0),
              0,
            )
          : 0),
      0,
    );
    pastBound('the scope holds', all, ROW_SCOPE_LIMITS.conditions, 'conditions', 'in one scope');
  };
  /* A condition over the table's own columns and a literal: what a group holds, and what a `via.where` holds of the target. */
  const literal = (table: NonNullable<ReturnType<typeof findTable>>, condition: Record<string, unknown>) => {
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
  };
  const keyOf = (where: string, table: NonNullable<ReturnType<typeof findTable>>, value: unknown): readonly string[] => {
    const names = typeof value === 'string' ? [value] : value;
    if (
      !Array.isArray(names) ||
      !names.length ||
      names.length > VIA_KEY ||
      names.some((name) => typeof name !== 'string' || !table.columns.some((column) => column.name === name)) ||
      new Set(names).size !== names.length
    )
      return refuse(`${where} names a column that "${table.id}" does not have, or names none, or names one twice.`);
    return names as string[];
  };
  // Each policy's relationship targets, for the graph checks below.
  const edges = new Map<string, Set<string>>();
  const selfOf = new Set<string>();
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
    const targets = new Set<string>();
    let treeColumns: string | undefined;
    let tree = 0;
    for (const group of policy.groups) {
      if (!Array.isArray(group) || !group.length) return invalid();
      let selfs = 0;
      let vias = 0;
      for (const condition of group) {
        count();
        if (!record(condition)) return invalid();
        if (!Object.hasOwn(condition, 'via')) {
          literal(table, condition);
          continue;
        }
        const rule = `${id}: a "via" on ${JSON.stringify(condition.column)}`;
        if (Object.keys(condition).some((key) => !['column', 'op', 'via'].includes(key))) return invalid();
        if (condition.op !== 'in')
          return refuse(
            `${rule} takes only the operator "in", not ${JSON.stringify(condition.op)}: a negated test would admit a row whose parent is out of scope or missing.`,
          );
        const via = condition.via;
        if (!record(via) || Object.keys(via).some((key) => !['resource', 'column', 'where'].includes(key))) return invalid();
        if (typeof via.resource !== 'string') return invalid();
        const target = findTable(schema, via.resource);
        if (!target) return refuse(`${rule} names "${via.resource}", which this catalog does not have.`);
        const from = keyOf(rule, table, condition.column);
        const to = keyOf(rule, target, via.column);
        if (from.length !== to.length)
          return refuse(`${rule} compares ${from.length} column${from.length === 1 ? '' : 's'} with ${to.length} of "${target.id}".`);
        // PostgreSQL has no operator between a text key and a number: every read would fail, so the policy is refused here.
        if ((table.sourceDialect ?? schema.dialect) === 'postgres' && (target.sourceDialect ?? schema.dialect) === 'postgres')
          from.forEach((name, at) => {
            const mine = columnFamily(table, name),
              theirs = columnFamily(target, to[at]);
            if (mine && theirs && mine !== theirs)
              refuse(
                `${rule} compares ${table.id}.${name} (${typeOfColumn(table, name)}) with ${target.id}.${to[at]} (${typeOfColumn(target, to[at])}): the types do not compare.`,
              );
          });
        if (via.where !== undefined) {
          if (!Array.isArray(via.where) || !via.where.length) return invalid();
          for (const alternative of via.where) {
            if (!Array.isArray(alternative) || !alternative.length) return invalid();
            for (const test of alternative) {
              count();
              if (!record(test)) return invalid();
              if (Object.hasOwn(test, 'via'))
                return refuse(`${rule} filters "${target.id}" by another "via"; the target's own scope already chains.`);
              literal(target, test);
            }
          }
        }
        vias++;
        if (target.id === table.id) {
          selfs++;
          tree++;
          if (via.where !== undefined)
            return refuse(
              `${rule} points at its own table with a "where"; put the filter beside it in the group, where it narrows each level.`,
            );
          const key = JSON.stringify(to);
          if (treeColumns !== undefined && treeColumns !== key)
            return refuse(`${id}: every "via" a table makes to itself must name the same key, so one walk can serve them.`);
          treeColumns = key;
        } else targets.add(target.id);
      }
      if (selfs > 1) return refuse(`${id}: a group may hold one "via" to its own table, not ${selfs}.`);
      if (selfs && vias > selfs) return refuse(`${id}: a "via" to its own table must be the only "via" in its group.`);
    }
    if (tree) {
      if (tree === policy.groups.length)
        return refuse(
          `${id}: every group walks down from its own rows, so none could ever admit a first row. Add a group with no "via" to "${id}" as the base.`,
        );
      selfOf.add(id);
    }
    edges.set(id, targets);
  }
  /* The graph of tables a scope reads through. A table that names itself is a tree (one hop of depth); any other
     loop is refused, with the loop said. Depth is the longest chain of hops. */
  const depths = new Map<string, number>();
  const walking: string[] = [];
  const depthOf = (id: string): number => {
    const known = depths.get(id);
    if (known !== undefined) return known;
    const at = walking.indexOf(id);
    if (at >= 0) return refuse(`"via" rules loop back: ${[...walking.slice(at), id].map((name) => `"${name}"`).join(' -> ')}.`);
    walking.push(id);
    let deepest = 0;
    for (const target of edges.get(id) ?? []) deepest = Math.max(deepest, 1 + depthOf(target));
    walking.pop();
    const depth = deepest + (selfOf.has(id) ? 1 : 0);
    if (depth > VIA_DEPTH)
      return refuse(
        `"via" rules from "${id}" chain ${depth} hops; the bound is ${VIA_DEPTH}. A chain that deep is almost certainly a modeling mistake.`,
      );
    depths.set(id, depth);
    return depth;
  };
  for (const id of edges.keys()) depthOf(id);
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
function withoutRepeats(policy: Filter): Filter {
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

  /** The catalog a `via` target resolves against: the policy's own, whole. A read's catalog is pruned to what the
   * reader may read, and a membership table they may not read (or a column of one) is missing there; reading it
   * through a `via` only decides whether a row shows, which is what a policy author is allowed to decide. */
  private readonly whole: DatabaseSchema;
  private recursive = false;
  private readonly building = new Set<string>();

  constructor(
    private schema: DatabaseSchema,
    private style: SqlStyle,
    scope?: RowScope,
    policy: DatabaseSchema = schema,
  ) {
    this.whole = policy;
    this.scope = scope === undefined ? undefined : snapshotRowScope(policy, scope);
    this.reserved = new Set(reservedNames(schema));
  }

  /** A table's meta, from the read's catalog and failing that the policy's (a `via` target the reader cannot read). */
  private meta(id: string) {
    return findTable(this.schema, id) ?? findTable(this.whole, id);
  }

  private fresh(): string {
    let name: string;
    do {
      name = `_tw_scope$${++this.ordinal}`;
    } while (this.reserved.has(name.toLowerCase()));
    this.reserved.add(name.toLowerCase());
    return name;
  }

  /* A `via` condition as the EXISTS over the target's scoped relation. The target is planned first (it and its
     parameters precede this table's definition, so a CTE only names earlier ones and the placeholders stay in text
     order), and a target's `where` is one more definition there (`filtered`), so the EXISTS binds nothing. */
  private related(table: TableMeta, condition: ViaCondition): Condition {
    const q = this.style.quote;
    const target = this.meta(condition.via.resource);
    if (!target || !target.columns.length) return invalid();
    const source = condition.via.where
      ? this.narrow(target.id, { groups: condition.via.where.map((group) => [...group]) })
      : this.relation(target.id);
    const from = columnsOf(condition.column);
    const to = columnsOf(condition.via.column);
    const typed = (meta: TableMeta, name: string) => this.style.builtin?.(meta.columns.find((column) => column.name === name)?.type ?? '');
    const pairs = to.map((key, at) => {
      /* The database's own operator where both sides are built-in types, as a column compared with a column is
         (filter.ts): a bare `=` resolves through the search_path. */
      const op = typed(target, key) && typed(table, from[at]) ? 'OPERATOR(pg_catalog.=)' : '=';
      return `${q('_tw_p')}.${q(key)} ${op} ${q('_tw_o')}.${q(from[at])}`;
    });
    return {
      column: from.join(','),
      op: 'in',
      via: { text: `EXISTS (SELECT 1 FROM ${source} ${q('_tw_p')} WHERE ${pairs.join(' AND ')})` },
    };
  }

  /** A table's relation under the scope; a table this read's catalog does not hold is refused, though a `via` may read it. */
  table = (id: string): string => {
    if (this.scope !== undefined && !findTable(this.schema, id)) return invalid();
    return this.relation(id);
  };

  private relation(id: string): string {
    if (this.scope === undefined) return qualifiedTable(this.schema, id, this.style);
    const existing = this.names.get(id);
    if (existing) return this.style.quote(existing);
    if (this.finished) throw new Error('Row scope relations must be planned before outer parameters.');
    const table = this.meta(id);
    if (!table || !table.columns.length) return invalid();
    if (this.building.has(id)) return invalid();
    const policy = this.scope[id] ?? false;
    const q = this.style.quote;
    const columns = table.columns.map((column) => q(column.name)).join(', ');
    const qualified = qualifiedTable(findTable(this.schema, id) ? this.schema : this.whole, id, this.style);
    if (typeof policy === 'boolean') {
      const name = this.fresh();
      this.names.set(id, name);
      const where = policy ? '' : ` WHERE ${this.style.never ?? '1 = 0'}`;
      this.definitions.push(`${q(name)} AS${this.style.cteHint ?? ''} (SELECT ${columns} FROM ${qualified}${where})`);
      return q(name);
    }
    // Target first: every relation this one reads through is planned (with its parameters) before this one's.
    this.building.add(id);
    const resolve = (group: Array<Condition | ViaCondition>) =>
      group.map((c) => (isVia(c) ? (c.via.resource === id ? c : this.related(table, c)) : c));
    const groups = policy.groups.map(resolve);
    this.building.delete(id);
    const typeOf = (column: string) => table.columns.find((c) => c.name === column)?.type;
    const builtIn = (column: string) => this.style.builtin?.(typeOf(column) ?? '');
    const own = (alias?: string) => (column: string) =>
      (alias ? `${q(alias)}.` : '') + q(column) + (policy.binary?.includes(column) ? ' COLLATE BINARY' : '');
    const name = this.fresh();
    this.names.set(id, name);
    const hint = this.style.cteHint ?? '';
    // What resolve left as it was: a table's walk down itself (a resolved test carries its text, not a resource).
    const walks = (c: Condition | ViaCondition): c is ViaCondition => isVia(c) && typeof c.via.resource === 'string';
    if (groups.some((group) => group.some(walks))) {
      // A table that walks down its own tree: a recursive definition of the keys it admits, then the rows with those keys.
      const base = groups.filter((group) => !group.some(walks)) as Condition[][];
      const steps = groups.filter((group) => group.some(walks));
      const keys = columnsOf((steps[0].find(walks) as ViaCondition).via.column);
      const walk = this.fresh();
      this.recursive = true;
      const keyList = keys.map((key) => q(key)).join(', ');
      const first = buildWhere(
        withoutRepeats({ groups: base }),
        this.style,
        this.params.length + 1,
        own('_tw_o'),
        undefined,
        undefined,
        undefined,
        false,
        typeOf,
        true,
      );
      this.params.push(...first.params);
      const alternatives = steps.map((group) => {
        const via = group.find(walks) as ViaCondition;
        /* The database's own operator where both sides are built-in types (filter.ts): a bare `=` resolves through the search_path. */
        const join = columnsOf(via.column).map(
          (column, at) =>
            `${q('_tw_c')}.${q(column)} ${builtIn(column) && builtIn(keys[at]) ? 'OPERATOR(pg_catalog.=)' : '='} ${q('_tw_w')}.${q(keys[at])}`,
        );
        const others = withoutRepeats({ groups: [group.filter((c) => !walks(c)) as Condition[]] });
        const where = buildWhere(
          others,
          this.style,
          this.params.length + 1,
          own('_tw_c'),
          undefined,
          undefined,
          undefined,
          false,
          typeOf,
          true,
        );
        this.params.push(...where.params);
        return `(${[...join, ...(where.text ? [where.text.slice(' WHERE '.length)] : [])].join(' AND ')})`;
      });
      this.definitions.push(
        `${q(walk)}(${keyList}) AS (SELECT ${keys.map((key) => `${q('_tw_o')}.${q(key)}`).join(', ')} FROM ${qualified} ${q('_tw_o')}${first.text}` +
          ` UNION SELECT ${keys.map((key) => `${q('_tw_c')}.${q(key)}`).join(', ')} FROM ${qualified} ${q('_tw_c')} JOIN ${q(walk)} ${q('_tw_w')} ON ${alternatives.join(' OR ')})`,
      );
      const same = keys
        .map((key) => `${q('_tw_k')}.${q(key)} ${builtIn(key) ? 'OPERATOR(pg_catalog.=)' : '='} ${q('_tw_o')}.${q(key)}`)
        .join(' AND ');
      this.definitions.push(
        `${q(name)} AS${hint} (SELECT ${columns} FROM ${qualified} ${q('_tw_o')} WHERE EXISTS (SELECT 1 FROM ${q(walk)} ${q('_tw_k')} WHERE ${same}))`,
      );
      return q(name);
    }
    const related = groups.some((group) => group.some((c) => (c as Condition).via !== undefined));
    const where = buildWhere(
      withoutRepeats({ groups: groups as Condition[][] }),
      this.style,
      this.params.length + 1,
      related ? own('_tw_o') : own(),
      undefined,
      undefined,
      undefined,
      false,
      typeOf,
      true,
    );
    // The style's hint (cteHint) goes between AS and the body: Postgres inlines the CTE, so the
    // scope's predicate meets the read's own filter, sort and limit instead of a copied slice.
    this.definitions.push(`${q(name)} AS${hint} (SELECT ${columns} FROM ${qualified}${related ? ` ${q('_tw_o')}` : ''}${where.text})`);
    this.params.push(...where.params);
    return q(name);
  }

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
    if (this.scope !== undefined && !findTable(this.schema, id)) return invalid();
    return this.narrow(id, filter, written);
  };

  private narrow(id: string, filter: Filter, written?: Readonly<Record<string, (own: (column: string) => string) => string>>): string {
    const key = `${id}\u0000${JSON.stringify(filter)}\u0000${Object.keys(written ?? {}).join(',')}`;
    const existing = this.narrowed.get(key);
    if (existing) return this.style.quote(existing);
    if (this.finished) throw new Error('Filtered relations must be planned before outer parameters.');
    const source = this.relation(id);
    const table = this.meta(id);
    if (!table || !table.columns.length) return invalid();
    const name = this.fresh();
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
    // A column's type, or a path's where it lands on a column: a computed one is an expression, compared as written.
    const typeOf = (column: string) => {
      if (written && Object.hasOwn(written, column)) return undefined;
      if (!column.includes('.')) return table.columns.find((c) => c.name === column)?.type;
      return plainType(this.schema, id, column);
    };
    const where = buildWhere(filter, this.style, this.params.length + 1, local, local, undefined, undefined, false, typeOf);
    const columns = table.columns.map((column) => q(column.name)).join(', ');
    this.definitions.push(`${q(name)} AS (SELECT ${columns} FROM ${source}${row ? ` ${q(row)}` : ''}${where.text})`);
    this.params.push(...where.params);
    return this.style.quote(name);
  }

  finish(): SqlFragment {
    this.finished = true;
    // One recursive definition makes the whole WITH recursive; the others read as they did (a CTE may name an earlier one).
    const head = this.recursive ? 'WITH RECURSIVE' : 'WITH';
    return { text: this.definitions.length ? `${head} ${this.definitions.join(',\n     ')}\n` : '', params: [...this.params] };
  }
}
