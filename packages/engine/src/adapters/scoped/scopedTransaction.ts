import { Refusal, type Filter, type ScopedReads, type WriteTransaction } from '../adapter.js';
import { buildWhere, type ConditionEquality, type SqlFragment, type SqlStyle } from '../../shared/filter.js';
import { recordRefusalCause } from '../../shared/refusal.js';
import type { RowScope, RowScopeFilter } from '../../shared/rowScope.js';
import { coerceForColumn, columnKind, type DatabaseSchema, type ForeignKey, type TableMeta } from '../../shared/schema.js';
import { blockingTriggers, firedBy, sayRuns, sayTriggers, sayWrite, type ScopeTrigger, type TriggeringWrite } from './scopeTriggers.js';
import type { Afterward, ScopedTriggers } from './triggerProof.js';
import { detachStoredText, overlaid, storedText, storedTextOf } from './storedText.js';

/** Physical metadata read on the writer inside its own transaction. `writable`
 * names the tables this scope may mutate; everything else stays in the graph
 * so a hidden dependent cannot vanish from the FK checks. */
export interface ScopeCatalog {
  schema: DatabaseSchema;
  writable: ReadonlySet<string>;
  /** What in the database keeps a table out of `writable`, named where it can be: on PostgreSQL its rules, policies
   * or row security. A refusal says it, so the owner knows what to drop or move. */
  blockedBy?: ReadonlyMap<string, string>;
  /** Tables kept out of `writable` only by their triggers, with those triggers: a write that fires none of them but
   * validation-only ones runs (scopeTriggers.ts); any other is refused, naming the trigger. */
  triggered?: ReadonlyMap<string, readonly ScopeTrigger[]>;
  /**
   * How the database's own foreign key compares each reference with its parent's key, by {@link referenceKey}: what a
   * parent check compares by (parentChecks below), or why a write through it cannot be checked. Absent, a reference is
   * compared by `=`, its value coerced by the referencing column's type; present, a key it does not name is refused.
   */
  references?: ReadonlyMap<string, ReferenceComparison>;
  /** Tables whose primary key has a column of a type a scoped write does not take as a row's identity (keyTypes.ts),
   * with why: no write targets one, whose key would name a row by a value the database may not compare. */
  unkeyed?: ReadonlyMap<string, string>;
  /**
   * PostgreSQL: the tables in a partition or inheritance hierarchy, on either side of pg_inherits (a partitioned table,
   * a partition at any level, an inheritance parent or child). No scoped write or trigger effect targets one: a foreign
   * key may be declared on a partition alone, or point at one, and a write through the table above it reaches rows
   * under keys and cascades that the table written does not have, which no parent or child check here reads. A
   * reference to a partitioned table from an ordinary one is still checked, through the partitioned table.
   */
  hierarchy?: ReadonlySet<string>;
}

/** One foreign key's comparison, column by column in its order (ScopeCatalog.references); or the reason it has none. */
export type ReferenceComparison =
  | { readonly refused: string }
  | {
      readonly columns: ReadonlyArray<{
        /** The referencing column's declared type, as the write coerces a value for it (shared/schema.ts coerceForColumn). */
        readonly type: string;
        /** PostgreSQL: the foreign key's own equality (Condition.equality). */
        readonly equality?: ConditionEquality;
      }>;
    };

/** A foreign key's name in ScopeCatalog.references: its table, name and columns, each side. */
export const referenceKey = (fk: ForeignKey): string =>
  JSON.stringify([fk.from.table, fk.name, fk.from.columns, fk.to.table, fk.to.columns]);

/** Whether a failure is the database's foreign key refusing a write: SQLite's SQLITE_CONSTRAINT_FOREIGNKEY, PostgreSQL's 23503. */
export const isForeignKeyViolation = (error: unknown): boolean => {
  const { code, errcode } = (error ?? {}) as { code?: unknown; errcode?: unknown };
  return errcode === 787 || code === '23503';
};

/**
 * A foreign key's refusal of a scoped write, said as a hidden parent's is: the database's own error says whether the
 * row it points at exists (and, on PostgreSQL, its key, a default's part of it included), which the principal's rows
 * may hide. Whichever statement it came from, at the statement or at COMMIT for a deferred one, it is the one
 * refusal; what the operator reads names the constraint and nothing of the row.
 */
export const foreignKeyRefusal = (error: unknown): ScopeRefusal => {
  const constraint = (error as { constraint?: unknown } | null)?.constraint;
  return recordRefusalCause(
    new ScopeRefusal('This operation is not available in the current row scope.'),
    `The database's foreign key${typeof constraint === 'string' ? ` ${JSON.stringify(constraint)}` : ''} refused the write: a row it points at is not in the principal's rows, or does not exist.`,
  );
};

/** A table's triggers as a refusal names them: `the trigger "audit_order"`, `the triggers "a", "b"`. */
export const triggerNames = (names: readonly string[]): string =>
  `the trigger${names.length === 1 ? '' : 's'} ${names.map((name) => JSON.stringify(name)).join(', ')}`;

/* The trigger vocabulary, for `mistri check` (commandTriggerChecks.ts), which says the same refusal ahead of time. */
export { blocksEveryWrite, sayBlocked, sayRuns, sayTriggers, type ScopeTrigger } from './scopeTriggers.js';
/** The keyed-effect judge (triggerEffects.ts), loaded where it is used: a process that never meets a named trigger never loads it. */
export const loadTriggerEffects = () => import('./triggerEffects.js');

/** Row locks taken on the writer before a guard read, for engines whose
 * transaction does not already exclude every other writer. SQLite passes
 * none: `BEGIN IMMEDIATE` is the lock. Each receives the physical table and
 * the complete-key (target) or parent-key (parent) filter. */
interface ScopeRowLocks {
  target(table: TableMeta, filter: Filter): Promise<void>;
  parent(table: TableMeta, filter: Filter): Promise<void>;
  /**
   * Run `ride` the moment the update of `table` is sent, so the read that
   * proves the row still in scope leaves behind it in the same round trip
   * (postgresTransactionHandle.ts behindWrite). Answers a withdraw, true when
   * `ride` never ran; undefined where reads are not sent behind a write.
   */
  behind?(table: TableMeta, ride: () => void): (() => boolean) | undefined;
  /**
   * Whether statements asked without waiting leave together (a writer that
   * pipelines, postgresPool.ts). A row's lock and the guard read behind it,
   * and every parent's lock and count, are then sent at once, in the order
   * they would have been asked one by one, and judged in that order when the
   * flight is answered: the server still grants each lock before it runs the
   * read behind it, so each read is as fresh as it was a round trip later.
   * Elsewhere each is asked once the one before it is answered.
   */
  readonly together?: boolean;
  /**
   * Told of each write that fired a trigger the catalog proved validation-only, before it is sent: where a trigger's
   * function can change without a lock on the table (PostgreSQL), the proof is read again before COMMIT.
   */
  relied?(table: TableMeta): void;
}

/**
 * The outer bound a command's scope sits inside, when its host has one: a
 * tenant's rows within the command's footprint, whatever the member's own
 * row policy narrows (tenantWriteKindMember.ts). `reads` reads under it, and
 * `whole` names the tables where the principal's scope is the bound itself —
 * nothing within the bound is hidden from it there.
 *
 * Two checks are judged against it, and only these:
 * - a command's insert may land on a row the principal cannot read, so long
 *   as it lands inside the bound; it is answered its key and the values it
 *   wrote, never the stored row (a requester's rating opens a desk-only
 *   follow-up);
 * - a delete of a row others reference is no longer refused outright: once
 *   the row is locked, every table that references it must be `whole` and
 *   hold no row referencing it at all, counted on the writer itself across
 *   every row of that table — so a cascade can never reach a row anyone hid.
 */
export interface ScopeBound {
  readonly reads: Pick<ScopedReads, 'query' | 'count'>;
  readonly whole: ReadonlySet<string>;
  /** How many rows reference the row `key` names through `fk`, counted on the writer: {@link referencesStatement}. */
  readonly references: (fk: ForeignKey, key: Filter) => Promise<number>;
}

/**
 * The count of rows of `fk.from.table` that reference the `fk.to.table` row
 * `key` names, as the database's own foreign key matches them, and so as its
 * cascade would reach them.
 *
 * A foreign key compares a reference as the parent key compares: SQLite
 * applies the parent column's affinity and collation to the child's value
 * (an untyped child column holding the number 7 references the text key
 * '7'), PostgreSQL the parent's collation where the child's is the default.
 * The child counted by its own column (`child.col = ?`) compares as the child
 * does, and missed such a reference, which the delete's cascade then reached.
 * Here each parent column is the left side of a join, where both engines take
 * its affinity and collation as the foreign key does; where two collations
 * conflict, PostgreSQL refuses the count, and the delete with it.
 */
export function referencesStatement(schema: DatabaseSchema, fk: ForeignKey, key: Filter, style: SqlStyle): SqlFragment {
  const relation = (id: string) => {
    const table = schema.tables.find((table) => table.id === id);
    if (!table) throw new Refusal('This operation is not available in the current row scope.');
    return `${style.quote(table.schema)}.${style.quote(table.name)}`;
  };
  const on = fk.to.columns.map((column, index) => `p.${style.quote(column)} = c.${style.quote(fk.from.columns[index])}`).join(' AND ');
  const where = buildWhere(key, style, 1, (name) => `p.${style.quote(name)}`);
  if (!where.text) throw new Refusal('This operation is not available in the current row scope.');
  return {
    text: `SELECT COUNT(*) AS n FROM ${relation(fk.from.table)} AS c JOIN ${relation(fk.to.table)} AS p ON ${on}${where.text}`,
    params: where.params,
  };
}

/** The tables where `scope` is exactly `bound`, and the bound admits rows at all: nothing in it is hidden there. */
export function wholeWithin(scope: Readonly<Record<string, unknown>>, bound: Readonly<Record<string, unknown>>): ReadonlySet<string> {
  return new Set(
    Object.keys(bound).filter(
      (table) => bound[table] !== false && Object.hasOwn(scope, table) && JSON.stringify(scope[table]) === JSON.stringify(bound[table]),
    ),
  );
}

/** A bound names exactly the scope's tables: it bounds that scope, never another. */
export function sameTables(scope: Readonly<Record<string, unknown>>, bound: Readonly<Record<string, unknown>>): boolean {
  const tables = Object.keys(scope);
  return tables.length === Object.keys(bound).length && tables.every((table) => Object.hasOwn(bound, table));
}

/* The caller hears one sentence, whatever the rule: which row a scope hides,
   and that it exists, is what the scope keeps. The rule and the row are
   recorded for the operator (shared/refusal.ts) — a command that failed here
   used to answer a bare 503 with nothing anywhere saying which check it was. */
/** A write the row scope refuses: for good, for this request — outside the principal's rows, off the footprint, on a
 * table it cannot bound. Its own class so the executor can say it as forbidden rather than as a while (503); the
 * words stay value-free, the reason recorded beneath them for the owner. */
export class ScopeRefusal extends Refusal {}
const refuse = (reason?: string): never => {
  throw recordRefusalCause(new ScopeRefusal('This operation is not available in the current row scope.'), reason);
};
const keyText = (key: Record<string, unknown>) =>
  Object.entries(key)
    .map(([column, value]) => `${column} ${JSON.stringify(value)}`)
    .join(', ');
const comparable = (value: unknown): value is string | number =>
  typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
/* A value for a number column as the write sends it: "" is NULL, "7.0" is 7 (sqlite.ts and postgres.ts coerce every
   value by its column's type before binding it). Only numbers: a parent check binds what it is given, and a number
   is where the given text and the written value part. */
const asWritten = (type: string | undefined, value: unknown): unknown =>
  type !== undefined && columnKind(type) === 'number' && typeof value === 'string' ? coerceForColumn(type, value) : value;
/* A value a PostgreSQL reference compared through its foreign key's equality (Condition.equality) is bound as text and
   read by the column's type: a boolean as its word. Every other type a reference may be (keyTypes.ts) the driver reads
   as a string or a number already, which is its text. */
const asBound = (value: unknown): unknown => (typeof value === 'boolean' ? String(value) : value);
/* Two values a check binds name the same parent: identical, or, where both are bound as text read by the column's type
   (Condition.equality), the same text — a given 7 and the stored "7" are the one parameter. */
const sameBound = (a: unknown, b: unknown, equality: boolean): boolean =>
  a === b ||
  (equality &&
    (typeof a === 'string' || typeof a === 'number') &&
    (typeof b === 'string' || typeof b === 'number') &&
    String(a) === String(b));

/**
 * The principal's scope and the reads it compiles to, for a transaction that
 * may create a parent and then its children. A scope is resolved before the
 * transaction begins, so a child rule that names its parents by key (`request_id
 * in [...]`) cannot name a parent this transaction made: a resident filing a
 * repair with its first message was refused the message. Rows this transaction
 * inserted inside the principal's rows join those key lists for the rest of the
 * transaction — every other condition of the child's rule still holds, a rule
 * of `false` stays false, and a parent anyone else made gains nothing.
 */
export interface ScopeOwnRows {
  readonly scope: RowScope;
  readonly reads: (scope: RowScope, guard: boolean) => Pick<ScopedReads, 'query' | 'count' | 'aggregate'>;
}

/** `scope` with each child rule's key conditions on a reference to a table in `made` extended by those rows' keys. */
function withOwnRows(
  schema: { foreignKeys: readonly { from: { table: string; columns: string[] }; to: { table: string; columns: string[] } }[] },
  scope: RowScope,
  made: ReadonlyMap<string, readonly Record<string, unknown>[]>,
): RowScope {
  const out: Record<string, boolean | RowScopeFilter> = { ...scope };
  for (const [table, rule] of Object.entries(scope)) {
    if (typeof rule !== 'object') continue;
    const extra = new Map<string, (string | number)[]>();
    for (const fk of schema.foreignKeys) {
      // A composite reference is named by no single condition: it is left as the policy said it.
      if (fk.from.table !== table || fk.from.columns.length !== 1) continue;
      const rows = made.get(fk.to.table);
      if (!rows?.length) continue;
      const values = rows.map((row) => row[fk.to.columns[0]]).filter(comparable);
      if (values.length) extra.set(fk.from.columns[0], [...(extra.get(fk.from.columns[0]) ?? []), ...values]);
    }
    if (!extra.size) continue;
    out[table] = {
      ...rule,
      groups: rule.groups.map((group) =>
        group.map((condition) => {
          const added = extra.get(condition.column);
          if (!added || condition.other !== undefined || condition.any !== undefined) return condition;
          if (condition.op === '=' && comparable(condition.value))
            return { ...condition, op: 'in' as const, value: [condition.value, ...added] };
          if (condition.op === 'in' && Array.isArray(condition.value)) return { ...condition, value: [...condition.value, ...added] };
          return condition;
        }),
      ),
    };
  }
  return out;
}

/** One reference a write makes, to be checked; or the refusal that ends the list where one cannot be. */
type ParentCheck =
  | { readonly refused: string }
  | { readonly fk: ForeignKey; readonly values: readonly unknown[]; readonly filter: Filter; readonly parent: TableMeta };
/** A check sent: its parent's lock and its count, in flight. */
type Asked =
  | Extract<ParentCheck, { refused: string }>
  | (Extract<ParentCheck, { fk: ForeignKey }> & { locked: Promise<void>; counted: Promise<number> });

/** Runs INSIDE a single queued operation. The supplied guards retain actual
 * stored scalar types, not display conversions (a blob label is not a key).
 * This capability deliberately refuses side effects it cannot bound. */
export function createScopedTransaction(
  catalog: ScopeCatalog,
  records: WriteTransaction,
  reads: Pick<ScopedReads, 'query' | 'count' | 'aggregate'>,
  guards: Pick<ScopedReads, 'query' | 'count'>,
  locks?: ScopeRowLocks,
  bound?: ScopeBound,
  own?: ScopeOwnRows,
  triggers?: ScopedTriggers,
): WriteTransaction {
  /* The rows this transaction inserted inside the principal's rows, by table, and the reads that count them in
     (ScopeOwnRows). Rebuilt on each such insert; until the first, the reads are the ones resolved for the request. */
  const made = new Map<string, Record<string, unknown>[]>();
  const madeBy = (table: TableMeta, row: Record<string, unknown>) => {
    if (!own) return;
    made.set(table.id, [...(made.get(table.id) ?? []), row]);
    const scope = withOwnRows(catalog.schema, own.scope, made);
    reads = own.reads(scope, false);
    guards = own.reads(scope, true);
  };
  const target = (id: string, write: TriggeringWrite): TableMeta => {
    const table = catalog.schema.tables.find((table) => table.id === id);
    if (!table) return refuse(`"${id}" is not in this write's footprint: a command writes only the tables it declares.`);
    if (catalog.hierarchy?.has(id))
      return refuse(`"${id}" is part of a partition or inheritance hierarchy, which writes under a row policy do not support yet.`);
    const triggers = catalog.writable.has(id) ? undefined : catalog.triggered?.get(id);
    if (triggers) {
      /* A trigger does what no row policy bounds, so a scoped write fires none but those proven to validate their own
         row. Decided per write: an update of a column no `UPDATE OF` names fires nothing. The refusal names the
         trigger, or the owner is left guessing why a table they declared written is not. */
      const foldCase = catalog.schema.dialect === 'sqlite';
      // A trigger the App names and the proof accepts runs, its effects proven per write (triggerProof.ts).
      const blocking = blockingTriggers(triggers, write, foldCase)
        .filter((trigger) => !proof?.accepts(id, trigger))
        .map((trigger) => ({ ...trigger, why: proof?.unaccepted(id, trigger) ?? trigger.why }));
      if (blocking.length)
        return refuse(
          `"${id}" cannot be written under a row policy: ${sayWrite(write)} ${sayRuns(blocking)} ${sayTriggers(blocking)}, whose effects the policy cannot bound. ` +
            `A trigger that only checks NEW and OLD and raises does not block a write; mistri check names each command one blocks.`,
        );
      if (firedBy(triggers, write, foldCase).length) locks?.relied?.(table);
    } else if (!catalog.writable.has(id)) {
      const by = catalog.blockedBy?.get(id);
      return refuse(
        by
          ? `"${id}" cannot be written under a row policy: it has ${by}, whose writes the policy cannot bound.`
          : `"${id}" is read-only in this scope: the command does not declare it written, or the principal's rows do not admit writing it.`,
      );
    }
    if (!table.columns.some((column) => column.primaryKey))
      return refuse(`"${id}" has no primary key, so a scoped write cannot prove which row it changed.`);
    const unkeyed = catalog.unkeyed?.get(id);
    if (unkeyed) return refuse(`${unkeyed}.`);
    return table;
  };
  const keyFilter = (table: TableMeta, key: Record<string, unknown>): Filter => {
    const pk = table.columns.filter((column) => column.primaryKey).map((column) => column.name);
    if (!key || Object.keys(key).length !== pk.length || !pk.every((column) => Object.hasOwn(key, column) && comparable(key[column]))) {
      return refuse(`A key for "${table.id}" names exactly its primary key (${pk.join(', ')}), each a text or a number.`);
    }
    return { groups: [pk.map((column) => ({ column, op: '=', value: key[column] as string | number }))] };
  };
  /* A row by its key, read after its lock. Lock before looking: the guard's
     snapshot is then the row no other writer can move until this transaction
     ends, so what the scope checks is what the write will change. Where the
     writer sends together, the read leaves right behind the lock, in its
     flight; the server runs it only once the lock is granted. */
  /* A row by its key, with its reference columns' stored text beside it where the engine reads one (storedText.ts):
     every check that takes a value from a stored row binds that text, never the driver's reading of it. */
  const readStored = async (table: TableMeta, filter: Filter, within: Pick<ScopedReads, 'query' | 'count'>) => {
    const texts = storedTextOf(catalog.schema, table);
    const result = await within.query({ table: table.id, filter, limit: 2, offset: 0, ...(texts ? { storedText: true as const } : {}) });
    return { ...result, rows: result.rows.map((row) => detachStoredText(texts, row)) };
  };
  const lockedRead = async (table: TableMeta, filter: Filter, within: Pick<ScopedReads, 'query' | 'count'>) => {
    const locked = locks?.target(table, filter);
    const read = () => readStored(table, filter, within);
    if (!locks?.together) {
      await locked;
      return read();
    }
    const sent = read();
    // Both heard before either is judged: the lock's failure, if it failed, is the one said.
    await Promise.allSettled([locked, sent]);
    await locked;
    return sent;
  };
  const one = (table: TableMeta, key: Record<string, unknown>, result: { rows: Record<string, unknown>[] }) => {
    if (result.rows.length !== 1) {
      return refuse(
        `The "${table.id}" row ${keyText(key)} is outside the principal's rows: the row policy (or tenant) does not admit it, before or after this write.`,
      );
    }
    const row = result.rows[0];
    // Null / opaque / nonportable keys cannot prove stored-row identity.
    keyFilter(
      table,
      Object.fromEntries(table.columns.filter((column) => column.primaryKey).map((column) => [column.name, row[column.name]])),
    );
    return row;
  };
  const stored = async (table: TableMeta, key: Record<string, unknown>, within: Pick<ScopedReads, 'query' | 'count'> = guards) =>
    one(table, key, await lockedRead(table, keyFilter(table, key), within));
  /* Every reference a write makes must land on a row the principal reads:
     all of a new row's, and of an updated row only those whose columns the
     update sets. A reference the update leaves as it was is not this write's
     to vouch for — it was made before, and refusing over it refused every
     edit of a row whose unrelated parent (a lender's relationship manager on
     a dealer) lies outside the scope, while telling the caller that it does.

     Each reference is checked by its parent's lock, then that parent's count
     under the principal's rows; a reference that cannot be checked ends the
     list, refused there, so the checks before it still speak first.

     The references a write names are checked before it is sent, not only
     after: the database's own foreign key answers a parent that does not
     exist with its error, at the statement, while a parent that exists and
     is hidden passed the statement and was refused after it. The two
     answers told a hidden row from a missing one. Checked first, both are
     the one refusal below. `given` keeps to the references whose every
     column the write names; the rest (a default, a value a trigger sets)
     are checked after the statement as before.

     A reference is checked as the database's foreign key compares it
     (ScopeCatalog.references), with the value the write sends: a check that
     compared otherwise found one parent where the foreign key found
     another, a hidden one (a char(3) value against a text key on
     PostgreSQL, whose foreign key drops its padding; a REAL column's 7.0
     against a TEXT key on SQLite). A value the write sends as NULL ("" for
     a number) points at nothing. And a row that names itself as its own
     parent by the key it gives (`{id: 1, parent_id: 1}`) is that parent:
     it exists once the statement has run, and is checked after it. */
  const comparisonOf = (fk: ForeignKey): ReferenceComparison => {
    const said = catalog.references?.get(referenceKey(fk));
    if (said) return said;
    if (catalog.references)
      return {
        refused: `"${fk.from.table}".${fk.from.columns.join('+')} has a foreign key whose comparison was not read with the catalog.`,
      };
    const child = catalog.schema.tables.find((table) => table.id === fk.from.table);
    return { columns: fk.from.columns.map((name) => ({ type: child?.columns.find((column) => column.name === name)?.type ?? '' })) };
  };
  /* A reference with a generated column (the catalog marks one unwritable: PostgreSQL's attgenerated, SQLite's
     table_xinfo hidden 2 or 3) moves with whatever column its expression reads, which no update names: an update of
     `x` re-pointed `k GENERATED ALWAYS AS (x + 1) REFERENCES p` at a hidden parent, checked by nobody. So every update
     touches it, and it is checked after the statement, from the row as stored; before the statement its value is not
     known (what the row held is not what the update leaves), so a check of what a write gives leaves it out. */
  const generated = (table: TableMeta, name: string) => table.columns.find((column) => column.name === name)?.writable === false;
  const generatedIn = (table: TableMeta, fk: ForeignKey) => fk.from.columns.some((name) => generated(table, name));
  const parentChecks = (table: TableMeta, row: Record<string, unknown>, set?: ReadonlySet<string>, given = false): ParentCheck[] => {
    const checks: ParentCheck[] = [];
    for (const fk of catalog.schema.foreignKeys.filter(
      (fk) =>
        fk.from.table === table.id &&
        (!set || fk.from.columns.some((column) => set.has(column)) || (!given && generatedIn(table, fk))) &&
        (!given || (!generatedIn(table, fk) && fk.from.columns.every((column) => Object.hasOwn(row, column) && row[column] !== undefined))),
    )) {
      const compared = comparisonOf(fk);
      // A value the row holds as stored is bound as the text it was read as (storedText.ts); one given, as given.
      const texts = storedText(row);
      const values = fk.from.columns.map((column, index) => {
        const compares = 'columns' in compared ? compared.columns[index] : undefined;
        if (compares?.equality && texts && Object.hasOwn(texts, column) && Object.hasOwn(row, column)) return texts[column];
        const value = asWritten(compares?.type, row[column]);
        return compares?.equality ? asBound(value) : value;
      });
      if (values.some((value) => value === null)) continue;
      if ('refused' in compared) {
        checks.push({ refused: compared.refused });
        break;
      }
      const unsupported = values.findIndex((value) => !comparable(value));
      if (unsupported !== -1) {
        checks.push({
          refused: `"${table.id}".${fk.from.columns[unsupported]} holds a value of a type a scoped write does not support for a reference: a check could not bind it as the foreign key compares it.`,
        });
        break;
      }
      if (
        given &&
        fk.to.table === table.id &&
        fk.to.columns.every(
          (column, index) =>
            Object.hasOwn(row, column) &&
            asWritten(table.columns.find((candidate) => candidate.name === column)?.type, row[column]) === values[index],
        )
      )
        continue;
      // Parent columns stay on the SQL left-hand side so SQLite's parent
      // affinity and collation, rather than JavaScript equality, decide.
      const filter: Filter = {
        groups: [
          fk.to.columns.map((column, index) => {
            const equality = compared.columns[index]?.equality;
            return { column, op: '=' as const, value: values[index] as string | number, ...(equality ? { equality } : {}) };
          }),
        ],
      };
      const parent = catalog.schema.tables.find((table) => table.id === fk.to.table);
      if (!parent) {
        checks.push({
          refused: `"${table.id}" references "${fk.to.table}", which is not in this write's footprint: declare it read by the command.`,
        });
        break;
      }
      checks.push({ fk, values, filter, parent });
    }
    return checks;
  };
  /** Whether a check binds every value as text read by its column's type (Condition.equality): PostgreSQL's. */
  const bindsText = (check: Extract<ParentCheck, { fk: ForeignKey }>) => check.filter.groups[0].every((condition) => condition.equality);
  const unseen = (check: Extract<ParentCheck, { fk: ForeignKey }>) =>
    `"${check.fk.from.table}".${check.fk.from.columns.join('+')} points at the "${check.fk.to.table}" row ${keyText(Object.fromEntries(check.fk.to.columns.map((column, index) => [column, check.values[index]])))}, which the principal's rows do not include (or the command does not declare "${check.fk.to.table}" read).`;
  /** The checks sent at once (locks.together): each parent's lock, then its count, every answer heard. */
  const ask = (checks: readonly ParentCheck[]): Asked[] =>
    checks.map((check) => {
      if ('refused' in check) return check;
      const locked = locks?.parent(check.parent, check.filter) ?? Promise.resolve();
      const counted = guards.count(check.fk.to.table, check.filter);
      locked.catch(() => {});
      counted.catch(() => {});
      return { ...check, locked, counted };
    });
  /* Checks asked ahead of the row they are for (built from what the write
     returned, or from what an update sets), used only where they name exactly
     the references the row as stored holds: the same statements, sent sooner. */
  const sameChecks = (asked: readonly Asked[], checks: readonly ParentCheck[]) =>
    asked.length === checks.length &&
    asked.every((guess, index) => {
      const check = checks[index];
      if ('refused' in guess || 'refused' in check) return 'refused' in guess && 'refused' in check && guess.refused === check.refused;
      return guess.fk === check.fk && guess.values.every((value, at) => sameBound(value, check.values[at], bindsText(check)));
    });
  /* References this transaction has proven: each parent locked and counted inside the principal's rows, which holds
     until COMMIT (the lock), so the same reference is not asked again after the write that made it. */
  const proven: Array<Extract<ParentCheck, { fk: ForeignKey }>> = [];
  const unproven = (checks: readonly ParentCheck[]) =>
    checks.filter(
      (check) =>
        'refused' in check ||
        !proven.some(
          (done) => done.fk === check.fk && done.values.every((value, at) => sameBound(value, check.values[at], bindsText(check))),
        ),
    );
  const verify = async (checks: readonly ParentCheck[], guessed?: readonly Asked[]) => {
    if (!locks?.together) {
      for (const check of checks) {
        if ('refused' in check) return refuse(check.refused);
        // A parent's visibility must hold until commit, not just at this read.
        await locks?.parent(check.parent, check.filter);
        if ((await guards.count(check.fk.to.table, check.filter)) !== 1) return refuse(unseen(check));
        proven.push(check);
      }
      return;
    }
    const asked = guessed && sameChecks(guessed, checks) ? guessed : ask(checks);
    // Every answer is heard before any is judged: nothing is left in flight behind a refusal.
    await Promise.allSettled(asked.flatMap((check) => ('refused' in check ? [] : [check.locked, check.counted])));
    for (const check of asked) {
      if ('refused' in check) return refuse(check.refused);
      await check.locked;
      if ((await check.counted) !== 1) return refuse(unseen(check));
      proven.push(check);
    }
  };
  const parents = async (
    table: TableMeta,
    row: Record<string, unknown>,
    set?: ReadonlySet<string>,
    guessed?: readonly Asked[],
    given = false,
  ) => verify(unproven(parentChecks(table, row, set, given)), guessed);
  /**
   * Before a write: the references it names, checked as `parents` checks them. Where the writer sends together, the
   * checks leave ahead of the write, in its flight, and `write` is sent behind them before any is judged: the server
   * runs them first, and a refused one is said whatever the write then answered (a foreign key's error included).
   */
  const parentsFirst = async <T>(checks: readonly ParentCheck[], write: () => Promise<T>): Promise<T> => {
    if (!locks?.together) {
      await verify(checks);
      return write();
    }
    const asked = ask(checks);
    const sent = write();
    await Promise.allSettled([sent, ...asked.flatMap((check) => ('refused' in check ? [] : [check.locked, check.counted]))]);
    await verify(checks, asked);
    return sent;
  };
  /* Triggers the App names: each write that fires one proves its effects' keys first and the rest right after the
     statement, with the transaction's own locks and guards (triggerProof.ts). */
  const proof = triggers
    ? triggers.prove(triggers.acceptance, {
        tables: catalog.schema.tables,
        foreignKeys: catalog.schema.foreignKeys,
        triggered: catalog.triggered,
        foldCase: catalog.schema.dialect === 'sqlite',
        scope: triggers.scope,
        guards: () => guards,
        lockedRead,
        read: (table, filter) => readStored(table, filter, guards),
        parents: (table, row, set) => parents(table, row, set),
        parentsBefore: (table, row, set) => parents(table, row, set, undefined, true),
        ...(locks ? { holdParent: (table: TableMeta, filter: Filter) => locks.parent(table, filter) } : {}),
        ...(locks?.relied ? { relied: (table: TableMeta) => locks.relied!(table) } : {}),
        ...(triggers.watch ? { watch: triggers.watch } : {}),
        refuse,
      })
    : undefined;
  /* The statements themselves. A foreign key that refuses one answers as a hidden parent does (foreignKeyRefusal):
     the checks before a write compare what it names, and this is everything they cannot see — a default's part of a
     reference, a value a trigger writes, a deferred check. */
  const statement = <T>(sent: Promise<T>): Promise<T> =>
    sent.catch((error: unknown) => {
      throw isForeignKeyViolation(error) ? foreignKeyRefusal(error) : error;
    });
  const insertRow = (request: Parameters<WriteTransaction['insert']>[0]) => statement(records.insert(request));
  const updateRow = (request: Parameters<WriteTransaction['update']>[0]) => statement(records.update(request));
  const afterward = async (afterwards: readonly Afterward[] | undefined, images: Parameters<Afterward>[0]) => {
    for (const next of afterwards ?? []) await next(images);
  };
  return Object.freeze({
    query: (request) => reads.query(request),
    count: (table, filter) => reads.count(table, filter),
    /* Under the principal's rows, as `count` reads: never the writer's own unscoped aggregate. */
    ...(reads.aggregate
      ? {
          aggregate: (request: Parameters<NonNullable<ScopedReads['aggregate']>>[0]) =>
            reads.aggregate ? reads.aggregate(request) : refuse('This scope cannot aggregate.'),
        }
      : {}),
    async insert(request) {
      const table = target(request.table, { kind: 'insert' });
      const afterwards = proof && (await proof.before(table, { kind: 'insert' }, proof.images.insert(table, request.values)));
      const given = unproven(parentChecks(table, request.values ?? {}, undefined, true));
      if (!locks?.together) await verify(given);
      const result = locks?.together ? await parentsFirst(given, () => insertRow(request)) : await insertRow(request);
      const filter = keyFilter(table, result.key);
      /* The new row locked and read back, and where the writer sends together
         its references checked in the same flight, from the row the INSERT
         returned (parents uses them only where the stored row holds exactly
         those). No other transaction can see this row yet, so its lock is
         granted at once and the read answers what a count before it would. */
      const read = lockedRead(table, filter, guards);
      const guessed = locks?.together && result.row ? ask(unproven(parentChecks(table, result.row))) : undefined;
      read.catch(() => {});
      const found = await read;
      // Inside the bound and outside the principal's rows: the command's own row, answered by its key and what it wrote.
      if (bound && found.rows.length !== 1) {
        const within = await stored(table, result.key, bound.reads);
        await parents(table, within, undefined, guessed);
        await afterward(afterwards, { new: within, old: null });
        return { key: result.key, applied: result.applied, sql: result.sql };
      }
      const row = one(table, result.key, found);
      await parents(table, row, undefined, guessed);
      await afterward(afterwards, { new: row, old: null });
      madeBy(table, row);
      return result;
    },
    async update(request) {
      const table = target(request.table, { kind: 'update', set: Object.keys(request.values ?? {}) });
      const protectedColumns = new Set([
        ...table.columns.filter((column) => column.primaryKey).map((column) => column.name),
        ...catalog.schema.foreignKeys.filter((fk) => fk.to.table === table.id).flatMap((fk) => fk.to.columns),
      ]);
      const moved = Object.keys(request.values ?? {}).filter((column) => protectedColumns.has(column));
      if (moved.length)
        return refuse(`A scoped update may not change "${table.id}".${moved.join(', ')}: a key, or a column another table references.`);
      const before = await stored(table, request.key);
      const set = new Set(Object.keys(request.values ?? {}));
      const afterwards =
        proof && (await proof.before(table, { kind: 'update', set: [...set] }, proof.images.update(table, before, request.values)));
      // What the update sets is given; every other column of a reference it sets in part is as stored, bound as its text.
      const given = unproven(parentChecks(table, overlaid(before, request.values), set, true));
      if (!locks?.together) await verify(given);
      /* The row read again after the write, sent the moment the write is: it
         reads what the write wrote, and leaves in the write's round trip, with
         the references the write sets checked ahead of it, as the row will
         hold them. A reference refused is the answer whatever the write said;
         otherwise a write that fails aborts the read too, and the write's
         failure is the one thrown. */
      const after: { row?: Promise<Record<string, unknown>> } = {};
      const withdraw = locks?.behind?.(table, () => {
        after.row = stored(table, request.key);
        after.row.catch(() => {});
      });
      let result: Awaited<ReturnType<WriteTransaction['update']>>;
      try {
        // The references it sets leave ahead of it, in its flight (parentsFirst).
        result = locks?.together ? await parentsFirst(given, () => updateRow(request)) : await updateRow(request);
      } finally {
        withdraw?.();
      }
      if (result.affected !== 1) return refuse(`The update of "${table.id}" changed ${result.affected} rows, not one.`);
      const now = await (after.row ?? stored(table, request.key));
      /* A key or a referenced column the database generates moves with the columns its expression reads, which the
         names above cannot catch: one that moved is refused, whatever a cascade or the foreign key made of it. */
      const shifted = [...protectedColumns].filter(
        (column) => generated(table, column) && JSON.stringify(before[column]) !== JSON.stringify(now[column]),
      );
      if (shifted.length)
        return refuse(
          `A scoped update may not change "${table.id}".${shifted.join(', ')}: a key, or a column another table references, generated from the columns it sets.`,
        );
      await parents(table, now, set);
      await afterward(afterwards, { new: now, old: before });
      return result;
    },
    async remove(request) {
      const table = target(request.table, { kind: 'delete' });
      const children = catalog.schema.foreignKeys.filter((fk) => fk.to.table === table.id);
      const hidden = children.find((fk) => !bound?.whole.has(fk.from.table));
      if (hidden)
        return refuse(`A scoped command may not delete from "${table.id}": "${hidden.from.table}" references it, and a hidden row might.`);
      const row = await stored(table, request.key);
      /* Locked first (stored), so no reference can be made to it while these
         are counted: across every row of each table, on the writer itself,
         since the principal sees every row the bound holds there and a row
         outside the bound pointing in is the one a cascade must never reach. */
      for (const fk of children) {
        const values = fk.to.columns.map((column) => row[column]);
        if (values.some((value) => value === null)) continue;
        if (!values.every(comparable))
          return refuse(`"${table.id}".${fk.to.columns.join('+')} holds a value that is not a text or a number.`);
        const key: Filter = { groups: [Object.entries(request.key).map(([column, value]) => ({ column, op: '=', value }))] };
        if ((await bound?.references(fk, key)) !== 0)
          return refuse(
            `A scoped command may not delete the "${table.id}" row ${keyText(request.key)}: "${fk.from.table}" still references it.`,
          );
      }
      const afterwards = proof && (await proof.before(table, { kind: 'delete' }, proof.images.delete(row)));
      const result = await statement(records.remove(request));
      if (result.affected !== 1) return refuse(`The delete from "${table.id}" removed ${result.affected} rows, not one.`);
      await afterward(afterwards, { new: null, old: row });
      return result;
    },
  } satisfies WriteTransaction);
}
