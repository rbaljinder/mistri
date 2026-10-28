/**
 * A command's `when` over its target's rollups and computed columns: `when: 'fulfillment_status =
 * pending'`, where `fulfillment_status` is `latest('fulfillment', 'status')`, a word read where it is written
 * rather than copied onto the order.
 *
 * A `when` of the target's own columns is one condition in the read that fetches the row (businessCommandExecution
 * and its neighbors), as it always was. One that names a rollup or a computed column cannot be: the transaction's
 * reads are single-table (adapter.ts `WriteTransaction`), and a rollup is a subquery only the view compiler writes.
 * So each such value is read here, inside the same transaction and through the same row scope as the handler's
 * reads — the rows that point at the target counted, summed or ordered by the transaction itself — and the
 * condition decided over it with the statement's semantics: nothing compares equal to nothing, `!=` holds only
 * between two values. Read in the transaction rather than taken from the request or a cache, so two commands racing
 * on one order each judge the other's committed write, as they would a column's.
 *
 * What is read here is held to what one transaction can say exactly: a rollup through one reference to rows the
 * command reads, narrowed by their own stored columns, of a stored column or of a computed column of those rows (a
 * repair's balance from its lines' `qty * price`, worked out row by row here); a computed column over the target's
 * columns and such rollups. The rest — two hops, a rollup of a rollup, a path or a computed column in a rollup's
 * query — is refused when the App loads, naming why.
 */
import type { Condition, Filter, WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import { appComputedRules, computedConstants } from '../../shared/appComputed.js';
import type { AppDef } from '../../shared/appModel.js';
import { appRollupRules } from '../../shared/appRollups.js';
import { zonedNow } from '../../shared/appZone.js';
import { readsMe, type ComputedColumn, type ComputedValue } from '@mistriwork/engine/shared/computed.js';
import { compares, evaluateComputed } from '@mistriwork/engine/shared/computedValue.js';
import { typedValue } from '../../shared/formLines.js';
import { parseViewQuery } from '@mistriwork/engine/shared/view.js';
import { mentionsMe } from '../../shared/appMe.js';
import type { QueryPerson } from '@mistriwork/engine/shared/query.js';
import type { Rollup } from '@mistriwork/engine/shared/rollups.js';
import type { DatabaseSchema, TableMeta } from '@mistriwork/engine/shared/schema.js';
import { canonicalKey, compileWhere, keyFilter, type CommandCatalog } from './commandDb.js';

/** A rollup a `when` reads, named in the command's own (local) tables. */
interface WhenRollup {
  readonly fn: Rollup['fn'];
  /** The child table, by its local name, and its columns that point at the target's `to`. */
  readonly child: string;
  readonly via: readonly string[];
  readonly to: readonly string[];
  readonly column?: string;
  readonly by?: string;
  readonly filter?: Filter;
  /** Set where `column` is a computed column of the child: its expression, worked out over each row read (R4). */
  readonly expression?: Pick<ComputedColumn, 'type' | 'expr' | 'reads'>;
}

/** What a table's `when` may read beyond its columns, or why a name it serves cannot be read in a transaction. */
export interface CommandDerived {
  readonly rollups: Readonly<Record<string, WhenRollup | string>>;
  readonly computed: Readonly<Record<string, ComputedColumn | string>>;
  /** The table as the query language reads it: its columns, rollups and computed columns. */
  readonly parse: DatabaseSchema;
  readonly constants: (now: Date) => { today: string; now: Date; me: null };
}

/** The catalog an App serves for its commands' `when`: rollups, then computed columns unfolded, so `today` is the day the command runs. */
function derivedSchema(app: AppDef, schema: DatabaseSchema): DatabaseSchema | undefined {
  if (!Object.values(app.resources ?? {}).some((resource) => resource.rollups || resource.computed)) return undefined;
  // Judged once per catalog an authorizer holds, not once per command it binds.
  let byApp = servedOnce.get(schema);
  if (!byApp) servedOnce.set(schema, (byApp = new WeakMap()));
  const kept = byApp.get(app);
  if (kept) return kept;
  const { rules } = appRollupRules(app, schema);
  const rolled = {
    ...schema,
    tables: schema.tables.map((table) => (rules.has(table.id) ? { ...table, rollups: rules.get(table.id)! } : table)),
  };
  const computed = appComputedRules(app, rolled).rules;
  const served = {
    ...rolled,
    tables: rolled.tables.map((table) => (computed.has(table.id) ? { ...table, computed: computed.get(table.id)! } : table)),
  };
  byApp.set(app, served);
  return served;
}
const servedOnce = new WeakMap<DatabaseSchema, WeakMap<AppDef, DatabaseSchema>>();

/* Each served table by id, and each reference by the tables it joins: asked for every table of every command's
   footprint, a scan of the whole catalog and its graph each time was most of what binding a large App's commands
   cost. `served` is derivedSchema's own, made once per catalog and App and never changed, so its index is kept
   with it. The first of each, as the scans found it. */
interface ServedIndex {
  tables: Map<string, TableMeta>;
  references: Map<string, Map<string, DatabaseSchema['foreignKeys']>>;
}
const servedIndexes = new WeakMap<DatabaseSchema, ServedIndex>();
function servedIndex(served: DatabaseSchema): ServedIndex {
  let index = servedIndexes.get(served);
  if (index) return index;
  index = { tables: new Map(), references: new Map() };
  for (const table of served.tables) if (!index.tables.has(table.id)) index.tables.set(table.id, table);
  for (const key of served.foreignKeys) {
    let to = index.references.get(key.from.table);
    if (!to) index.references.set(key.from.table, (to = new Map()));
    const list = to.get(key.to.table);
    if (list) list.push(key);
    else to.set(key.to.table, [key]);
  }
  servedIndexes.set(served, index);
  return index;
}

/**
 * One table's derived names as its commands read them. `served` is `derivedSchema`'s, `local` maps the footprint's
 * logical tables to their local names: a rollup over rows the command does not read is no value it may judge.
 */
function commandDerived(
  app: AppDef,
  served: DatabaseSchema,
  logical: string,
  meta: TableMeta,
  local: ReadonlyMap<string, string>,
): CommandDerived | undefined {
  const index = servedIndex(served);
  const table = index.tables.get(logical);
  if (!table || (!table.rollups && !table.computed)) return undefined;
  const rollups: Record<string, WhenRollup | string> = {};
  for (const [name, rollup] of Object.entries(table.rollups ?? {})) {
    const dot = rollup.via.lastIndexOf('.');
    const childId = rollup.via.slice(0, dot);
    const via = rollup.via.slice(dot + 1).split('+');
    const fk = index.references
      .get(childId)
      ?.get(logical)
      ?.find((key) => key.from.columns.join('+') === via.join('+'));
    const child = local.get(childId);
    rollups[name] =
      rollup.of || !fk
        ? `"${name}" reads through two references, and a when reads a rollup of the rows that point at its record`
        : rollup.reach
          ? `"${name}" narrows its rows through a reference, and a when reads a rollup narrowed by its rows' own columns`
          : rollup.computed && Object.keys(rollup.computed).length
            ? `"${name}" narrows its rows by a computed column of theirs, and a when reads a rollup narrowed by their stored columns`
            : !child
              ? `"${name}" reads "${childId}", which the command does not read; add it to "read"`
              : {
                  fn: rollup.fn,
                  child,
                  via,
                  to: fk.to.columns,
                  ...(rollup.column === undefined ? {} : { column: rollup.column }),
                  ...(rollup.by === undefined ? {} : { by: rollup.by }),
                  ...(rollup.filter ? { filter: rollup.filter } : {}),
                  ...(rollup.expression ? { expression: rollup.expression } : {}),
                };
  }
  const computed: Record<string, ComputedColumn | string> = {};
  for (const [name, column] of Object.entries(table.computed ?? {})) {
    const through = column.reads.find((read) => read.includes('.'));
    const rolled = column.reads.find((read) => typeof rollups[read] === 'string');
    computed[name] = through
      ? `"${name}" reads "${through}" through a reference, and a when reads a computed column of its record's own columns`
      : readsMe(column.expr)
        ? `"${name}" says "me", and a when is the same for everyone who runs the command`
        : rolled
          ? (rollups[rolled] as string)
          : column;
  }
  const parse: DatabaseSchema = {
    label: meta.name,
    dialect: 'sqlite',
    tables: [{ ...meta, ...(table.rollups ? { rollups: table.rollups } : {}), ...(table.computed ? { computed: table.computed } : {}) }],
    foreignKeys: [],
    readAt: '',
  };
  return Object.freeze({
    rollups: Object.freeze(rollups),
    computed: Object.freeze(computed),
    parse,
    constants: (now: Date) => ({ ...computedConstants(app, now, null), now, me: null }),
  });
}

/**
 * The catalog with what each table's `when` may derive: `schema` the logical catalog the footprint was read from,
 * `logical` the footprint's local names to it. Unchanged where the App declares no rollup or computed column.
 */
export function withDerived(
  catalog: CommandCatalog,
  app: AppDef,
  schema: DatabaseSchema,
  logical: (local: string) => string,
): CommandCatalog {
  const served = derivedSchema(app, schema);
  if (!served) return catalog;
  const local = new Map(Object.keys(catalog).map((name) => [logical(name), name]));
  return Object.freeze(
    Object.fromEntries(
      Object.entries(catalog).map(([name, table]) => {
        const derived = commandDerived(app, served, logical(name), table.meta, local);
        return [name, derived ? Object.freeze({ ...table, derived }) : table];
      }),
    ),
  );
}

type Table = CommandCatalog[string];

interface CompiledWhen {
  readonly filter: Filter;
  readonly none: boolean;
  /**
   * What is judged here once the row is read: the rollups and computed columns it names, and both sides of a
   * comparison of two values (`qty < reorder_at`, `paid < owed`), which no single-table read writes. None, and the
   * `when` is a condition in the target's own read.
   */
  readonly derived: ReadonlySet<string>;
  /** The target's stored columns it judges, directly or under what it derives. */
  readonly reads: readonly string[];
}

/* What a derived value is compared by: what a statement says the same of a number, a word, a day and a yes-or-no. */
const DERIVED_OPS: ReadonlySet<string> = new Set(['=', '!=', '<', '<=', '>', '>=', 'in', 'isNull', 'isNotNull']);

/** A command's `when` over its target: the target's columns, and the rollups and computed columns `table.derived` serves. */
export function compileWhen(table: Table, when: unknown, now: Date, me?: QueryPerson): CompiledWhen {
  let plain: ReturnType<typeof compileWhere>;
  try {
    plain = compileWhere(table, when, now, [], me, { columnValues: true });
  } catch (error) {
    if (!table.derived || typeof when !== 'string') throw error;
    return derivedWhen(table, table.derived, when, now, me);
  }
  /* `paid < spend`, where `spend` is a rollup: the target's own columns read it as a word, so it is read where the
     rollups and computed columns are names (a word beside a number is never its value). */
  const derived = table.derived;
  if (
    derived &&
    typeof when === 'string' &&
    plain.filter.groups
      .flat()
      .some((c) => typeof c.value === 'string' && (Object.hasOwn(derived.rollups, c.value) || Object.hasOwn(derived.computed, c.value)))
  )
    return derivedWhen(table, derived, when, now, me);
  const reads = plain.filter.groups.flatMap((group) => group.flatMap((c) => [c.column, ...(c.other === undefined ? [] : [c.other])]));
  const compared = plain.filter.groups.flat().flatMap((c) => (c.other === undefined ? [] : [c.column, c.other]));
  return { filter: plain.filter, none: plain.none, derived: new Set(compared), reads: [...new Set(reads)] };
}

function derivedWhen(table: Table, derived: CommandDerived, when: string, now: Date, me?: QueryPerson): CompiledWhen {
  // Read as a list's tab reads its query, where a rollup and a computed column are names like a column's.
  const parsed = parseViewQuery(derived.parse, table.name, when, zonedNow(table.zone, now), me ? { me } : {});
  if (parsed.errors.length) throw new Error(`${table.name}: ${parsed.errors.map((error) => error.message).join(' ')}`);
  if (parsed.columns?.length || parsed.orderBy.length || parsed.limit !== undefined)
    throw new Error(`${table.name}: a when names rows, not columns, an order or a count; leave out "show", "sort" and "limit".`);
  const asked = parsed.filter.groups.flat().find((c) => c.any);
  if (asked)
    throw new Error(
      `${table.name}: a when reads the record's own values; "${asked.path}" asks about other rows, which a list's tab or segment may.`,
    );
  const query = {
    filter: {
      groups: parsed.filter.groups.map((group) =>
        group.map((c): Condition => ({
          column: c.path,
          op: c.op,
          ...(c.value === undefined ? {} : { value: c.value }),
          ...(c.other === undefined ? {} : { other: c.other }),
        })),
      ),
    },
  };
  const names = new Set<string>();
  const reads = new Set<string>();
  const read = (name: string): boolean => {
    if (Object.hasOwn(table.kinds, name)) {
      reads.add(name);
      return false;
    }
    const rollup = Object.hasOwn(derived.rollups, name) ? derived.rollups[name] : undefined;
    const computed = Object.hasOwn(derived.computed, name) ? derived.computed[name] : undefined;
    const why = typeof rollup === 'string' ? rollup : typeof computed === 'string' ? computed : undefined;
    if (why) throw new Error(`${table.name}: ${why}.`);
    if (rollup) (rollup as WhenRollup).to.forEach((column) => reads.add(column));
    else if (computed) (computed as ComputedColumn).reads.forEach(read);
    else throw new Error(`${table.name}: "${name}" is not a column, a rollup or a computed column of it.`);
    names.add(name);
    return true;
  };
  for (const condition of query.filter.groups.flat()) {
    const derives = [condition.column, ...(condition.other === undefined ? [] : [condition.other])].map(read).some(Boolean);
    /* Two values compared, of the row or derived from it: both read, and the comparison judged here. */
    if (condition.other !== undefined) {
      names.add(condition.column).add(condition.other);
      continue;
    }
    if (!derives) continue;
    if (!DERIVED_OPS.has(condition.op))
      throw new Error(
        `${table.name}: "${condition.column}" is judged with ${condition.op}; a when judges a rollup or a computed column with =, !=, <, >, in or is empty.`,
      );
  }
  return { filter: query.filter, none: false, derived: names, reads: [...reads] };
}

type Reader = Pick<WriteTransaction, 'query' | 'count'>;

/** The table people are rows of, by its local name, where the command reads it (businessCommandAuthorization.ts peopleIn). */
export type CommandPeople = Readonly<{ table: string; column: string; key: string; id: string }>;

/**
 * Who `me` is in a command's `when` and its inputs' (`when: 'owner = me'`, a "my records" verb): the actor, as
 * an action's `when` reads the writer (appTransitions.ts) — their verified email, and where the command reads
 * the people table (`auth.me`, binding.people) their row there, found in the same transaction. Undefined where
 * no text says `me`. An actor with no verified email (a service principal, an unproven sign-up) is someone,
 * and nothing is theirs. A check before any request reads `me` as anyone's (ANYONE) instead.
 */
export async function whenPerson(
  reader: Pick<Reader, 'query'>,
  actor: { readonly email?: string },
  people: CommandPeople | undefined,
  texts: readonly (string | undefined)[],
): Promise<QueryPerson | undefined> {
  if (!texts.some((text) => mentionsMe(text))) return undefined;
  const email = actor.email ?? null;
  if (email === null) return { email, unproven: true, ...(people ? { person: { table: people.id, key: null } } : {}) };
  if (!people) return { email };
  const found = await reader.query({
    table: people.table,
    columns: [people.key],
    limit: 2,
    offset: 0,
    filter: { groups: [[{ column: people.column, op: '=', value: email }]] },
  });
  // Two rows carrying one email name nobody in particular, as appMe.ts says.
  const key = found.rows.length === 1 ? found.rows[0][people.key] : null;
  return { email, person: { table: people.id, key: typeof key === 'string' || typeof key === 'number' ? key : null } };
}

/**
 * Whether `when` holds of each row (normalized, each read by its key in this transaction). A group of conditions
 * holds when the target's row matches its stored conditions — one count by key, the row scope's as every read is —
 * and each derived value, read here, meets its condition.
 */
export async function whenHolds(
  reader: Reader,
  catalog: CommandCatalog,
  target: string,
  when: CompiledWhen,
  rows: readonly Readonly<Record<string, unknown>>[],
  now: Date,
): Promise<boolean[]> {
  const table = catalog[target];
  const derived = table.derived;
  const constants = derived?.constants(now) ?? { today: '', now, me: null };
  /* A condition judged once the row is read: one comparing two values, or one over a rollup or a computed column. */
  const here = (condition: Condition) =>
    condition.other !== undefined || (when.derived.has(condition.column) && !Object.hasOwn(table.kinds, condition.column));
  const held: boolean[] = [];
  for (const row of rows) {
    if (when.none) {
      held.push(false);
      continue;
    }
    const key = canonicalKey(table, row);
    if (!key) throw new Error(`${target}: a row without its key.`);
    const [named] = keyFilter(key).groups;
    const values = new Map<string, Promise<ComputedValue>>();
    const value = (name: string): Promise<ComputedValue> => {
      let found = values.get(name);
      if (!found) values.set(name, (found = derive(name)));
      return found;
    };
    const derive = async (name: string): Promise<ComputedValue> => {
      if (Object.hasOwn(table.kinds, name)) return typedValue(table.meta, name, row[name]);
      const rollup = derived!.rollups[name];
      if (rollup && typeof rollup !== 'string') return readRollup(reader, catalog, rollup, row, constants);
      const computed = derived!.computed[name] as ComputedColumn;
      const known = new Map<string, ComputedValue>();
      for (const path of computed.reads) if (!Object.hasOwn(table.kinds, path)) known.set(path, await value(path));
      return evaluateComputed(computed.expr, constants, (path) =>
        known.has(path) ? known.get(path)! : typedValue(table.meta, path, row[path]),
      );
    };
    let holds = !when.filter.groups.length;
    for (const group of when.filter.groups) {
      const stored = group.filter((condition) => !here(condition));
      if (stored.length && !(await reader.count(target, { groups: [[...named, ...stored]] }))) continue;
      let all = true;
      for (const condition of group) {
        if (!here(condition)) continue;
        const met =
          condition.other === undefined
            ? meets(condition, await value(condition.column))
            : compares(condition.op, await value(condition.column), await value(condition.other));
        if (!met) {
          all = false;
          break;
        }
      }
      if (all) {
        holds = true;
        break;
      }
    }
    held.push(holds);
  }
  return held;
}

/**
 * One derived value of one row, a rollup or a computed column `table.derived` serves, read in the transaction as a
 * `when` reads it: a decision's input (decide/decideReads.ts). Undefined when the table derives no such name.
 */
export async function derivedValue(
  reader: Reader,
  catalog: CommandCatalog,
  target: string,
  row: Readonly<Record<string, unknown>>,
  name: string,
  now: Date,
): Promise<ComputedValue | undefined> {
  const table = catalog[target];
  const derived = table?.derived;
  if (!derived) return undefined;
  const constants = derived.constants(now);
  const value = async (each: string): Promise<ComputedValue | undefined> => {
    if (Object.hasOwn(table.kinds, each)) return typedValue(table.meta, each, row[each]);
    const rollup = derived.rollups[each];
    if (rollup && typeof rollup !== 'string') return readRollup(reader, catalog, rollup, row, constants);
    const computed = derived.computed[each];
    if (!computed || typeof computed === 'string') return undefined;
    const known = new Map<string, ComputedValue | undefined>();
    for (const path of computed.reads) if (!Object.hasOwn(table.kinds, path)) known.set(path, await value(path));
    return evaluateComputed(computed.expr, constants, (path) =>
      known.has(path) ? (known.get(path) as ComputedValue) : typedValue(table.meta, path, row[path]),
    );
  };
  return value(name);
}

const PAGE = 1000;

/** A rollup's value for one record, read in the transaction as the subquery would read it (viewLabels.ts). */
async function readRollup(
  reader: Reader,
  catalog: CommandCatalog,
  rollup: WhenRollup,
  row: Readonly<Record<string, unknown>>,
  constants: { today: string; now: Date; me: null },
): Promise<ComputedValue> {
  const child = catalog[rollup.child];
  const pointing = rollup.via.map((column, at): Condition => ({ column, op: '=', value: row[rollup.to[at]] as string | number }));
  // A record with no key value has no rows pointing at it.
  if (rollup.via.some((_, at) => row[rollup.to[at]] === null || row[rollup.to[at]] === undefined))
    return rollup.fn === 'count' || rollup.fn === 'sum' ? 0 : null;
  const groups = (extra: Condition[] = []): Condition[][] =>
    rollup.filter?.groups.length ? rollup.filter.groups.map((group) => [...pointing, ...group, ...extra]) : [[...pointing, ...extra]];
  if (rollup.fn === 'count') return reader.count(rollup.child, { groups: groups() });
  if (rollup.expression) return readComputedRollup(reader, child, rollup, rollup.expression, groups, constants);
  const column = rollup.column!;
  const first = async (extra: Condition[], orderBy: { column: string; direction: 'asc' | 'desc' }[]) => {
    const found = await reader.query({
      table: rollup.child,
      columns: [column],
      filter: { groups: groups(extra) },
      orderBy,
      limit: 1,
      offset: 0,
    });
    return found.rows.length ? typedValue(child.meta, column, found.rows[0][column]) : undefined;
  };
  if (rollup.fn === 'min' || rollup.fn === 'max')
    return (await first([{ column, op: 'isNotNull' }], [{ column, direction: rollup.fn === 'min' ? 'asc' : 'desc' }])) ?? null;
  if (rollup.fn === 'latest') {
    const by = rollup.by!;
    const key = child.key.filter((name) => name !== by).map((name) => ({ column: name, direction: 'desc' as const }));
    /* The greatest `by`, its key breaking a tie; a row with none is newest only where no row has one. */
    const nullable = child.meta.columns.find((item) => item.name === by)?.nullable;
    const dated = await first(nullable ? [{ column: by, op: 'isNotNull' }] : [], [{ column: by, direction: 'desc' }, ...key]);
    if (dated !== undefined || !nullable) return dated ?? null;
    return (await first([{ column: by, op: 'isNull' }], key)) ?? null;
  }
  // A sum reads every row's value: in pages, so a record with many rows is still summed whole. Over none it is 0.
  let total = 0;
  for (let offset = 0; ; offset += PAGE) {
    const found = await reader.query({
      table: rollup.child,
      columns: [column],
      filter: { groups: groups([{ column, op: 'isNotNull' }]) },
      orderBy: child.key.map((name) => ({ column: name, direction: 'asc' as const })),
      limit: PAGE,
      offset,
    });
    for (const each of found.rows) {
      const figure = typedValue(child.meta, column, each[column]);
      if (typeof figure === 'number') total += figure;
    }
    if (found.rows.length < PAGE) return total;
  }
}

/* A day or an instant as a value that orders, so a min or a max of them compares like the statement's. */
const ordered = (value: ComputedValue): string | number | boolean | null =>
  value !== null && typeof value === 'object' ? ('day' in value ? value.day : value.instant.toISOString()) : value;

/**
 * A rollup over a computed column of its rows (`sum('line', 'amount')`, `amount` being `qty * price`), read as the
 * subquery reads it: the expression worked out over each row the rollup counts, its reads read in this transaction
 * and in pages, then summed, or the least, greatest or newest kept. A row whose expression comes to nothing is left
 * out, as the aggregate leaves out a null.
 */
async function readComputedRollup(
  reader: Reader,
  child: Table,
  rollup: WhenRollup,
  expression: NonNullable<WhenRollup['expression']>,
  groups: (extra?: Condition[]) => Condition[][],
  constants: { today: string; now: Date; me: null },
): Promise<ComputedValue> {
  const columns = [...new Set([...expression.reads, ...child.key])];
  const worked = (each: Record<string, unknown>) =>
    evaluateComputed(expression.expr, constants, (path) => typedValue(child.meta, path, each[path]));
  if (rollup.fn === 'latest') {
    const by = rollup.by!;
    const key = child.key.filter((name) => name !== by).map((name) => ({ column: name, direction: 'desc' as const }));
    const nullable = child.meta.columns.find((item) => item.name === by)?.nullable;
    const first = async (extra: Condition[], orderBy: { column: string; direction: 'asc' | 'desc' }[]) => {
      const found = await reader.query({ table: rollup.child, columns, filter: { groups: groups(extra) }, orderBy, limit: 1, offset: 0 });
      return found.rows.length ? worked(found.rows[0]) : undefined;
    };
    const dated = await first(nullable ? [{ column: by, op: 'isNotNull' }] : [], [{ column: by, direction: 'desc' }, ...key]);
    if (dated !== undefined || !nullable) return dated ?? null;
    return (await first([{ column: by, op: 'isNull' }], key)) ?? null;
  }
  let kept: ComputedValue = rollup.fn === 'sum' ? 0 : null;
  for (let offset = 0; ; offset += PAGE) {
    const found = await reader.query({
      table: rollup.child,
      columns,
      filter: { groups: groups() },
      orderBy: child.key.map((name) => ({ column: name, direction: 'asc' as const })),
      limit: PAGE,
      offset,
    });
    for (const each of found.rows) {
      const value = worked(each);
      if (value === null) continue;
      if (rollup.fn === 'sum') {
        if (typeof value === 'number') kept = (kept as number) + value;
      } else if (kept === null) kept = value;
      else {
        const [a, b] = [ordered(value)!, ordered(kept)!];
        if (rollup.fn === 'min' ? a < b : a > b) kept = value;
      }
    }
    if (found.rows.length < PAGE) return kept;
  }
}

/** A condition over a derived value, as the statement decides it: unknown — a comparison with nothing — is no. */
function meets(condition: Condition, value: ComputedValue): boolean {
  if (condition.op === 'isNull') return value === null;
  if (condition.op === 'isNotNull') return value !== null;
  if (value === null) return false;
  const plain = typeof value === 'object' ? ('day' in value ? value.day : value.instant.toISOString()) : value;
  const as = (given: unknown): string | number | boolean | null => {
    if (given === null || given === undefined) return null;
    if (typeof plain === 'number') return Number(given);
    if (typeof plain === 'boolean') return given === true || given === 1 || /^(1|true|t|yes|y)$/i.test(String(given));
    return String(given);
  };
  if (condition.op === 'in') {
    const list = Array.isArray(condition.value) ? condition.value : [condition.value];
    return list.some((item) => as(item) === plain);
  }
  const other = as(condition.value);
  if (other === null) return false;
  switch (condition.op) {
    case '=':
      return plain === other;
    case '!=':
      return plain !== other;
    case '<':
      return plain < other;
    case '<=':
      return plain <= other;
    case '>':
      return plain > other;
    case '>=':
      return plain >= other;
    default:
      return false;
  }
}

/**
 * The first condition of a `when` the row does not meet, where it is one of the target's own stored columns judged
 * by a plain comparison: what a refusal names so a person can see why (`balance_cents is $108.99; needs <= 0`).
 * For a compound `when` it is the first part that fails, in the order it was written; undefined where the failing
 * part is a rollup, a comparison of two columns or anything else a sentence about one value cannot say.
 */
export function failingCondition(table: Table, when: CompiledWhen, row: Readonly<Record<string, unknown>>): Condition | undefined {
  if (when.none) return undefined;
  const fails = (condition: Condition) =>
    condition.other === undefined &&
    DERIVED_OPS.has(condition.op) &&
    Object.hasOwn(table.kinds, condition.column) &&
    !meets(condition, typedValue(table.meta, condition.column, row[condition.column]));
  for (const group of when.filter.groups) {
    const found = group.find(fails);
    if (found) return found;
  }
  return undefined;
}

/**
 * The inputs a command asks only where their `when` holds, judged of one record as its `when` is:
 * a condition of its own columns as a count of that row, one over a rollup or a computed column by `whenHolds`.
 * Returns the names of the inputs whose condition does not hold, which the form leaves out and a run refuses.
 */
export async function inputsWithheld(
  reader: Reader,
  catalog: CommandCatalog,
  target: string,
  fields: readonly { readonly name: string; readonly when?: string }[],
  row: Readonly<Record<string, unknown>>,
  now: Date,
  me?: QueryPerson,
): Promise<string[]> {
  const table = catalog[target];
  const withheld: string[] = [];
  for (const field of fields) {
    if (field.when === undefined) continue;
    const when = compileWhen(table, field.when, now, me);
    let holds: boolean;
    if (when.none) holds = false;
    else if (when.derived.size) [holds] = await whenHolds(reader, catalog, target, when, [row], now);
    else {
      const key = canonicalKey(table, row);
      if (!key) throw new Error(`${target}: a row without its key.`);
      const [named] = keyFilter(key).groups;
      const groups = when.filter.groups.length ? when.filter.groups.map((group) => [...named, ...group]) : [named];
      holds = (await reader.count(target, { groups })) > 0;
    }
    if (!holds) withheld.push(field.name);
  }
  return withheld;
}
