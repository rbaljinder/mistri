import { Refusal, type Filter, type ScopedReads, type WriteTransaction } from '../adapter.js';
import { recordRefusalCause } from '../../shared/refusal.js';
import type { RowScope, RowScopeFilter } from '../../shared/rowScope.js';
import type { DatabaseSchema, ForeignKey, TableMeta } from '../../shared/schema.js';

/** Physical metadata read on the writer inside its own transaction. `writable`
 * names the tables this scope may mutate; everything else stays in the graph
 * so a hidden dependent cannot vanish from the FK checks. */
export interface ScopeCatalog {
  schema: DatabaseSchema;
  writable: ReadonlySet<string>;
  /** What in the database keeps a table out of `writable`, named where it can be: its triggers, and on PostgreSQL its
   * rules, policies or row security. A refusal says it, so the owner knows what to drop or move. */
  blockedBy?: ReadonlyMap<string, string>;
}

/** A table's triggers as a refusal names them: `the trigger "audit_order"`, `the triggers "a", "b"`. */
export const triggerNames = (names: readonly string[]): string =>
  `the trigger${names.length === 1 ? '' : 's'} ${names.map((name) => JSON.stringify(name)).join(', ')}`;

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
  readonly reads: (scope: RowScope, guard: boolean) => Pick<ScopedReads, 'query' | 'count'>;
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
  reads: Pick<ScopedReads, 'query' | 'count'>,
  guards: Pick<ScopedReads, 'query' | 'count'>,
  locks?: ScopeRowLocks,
  bound?: ScopeBound,
  own?: ScopeOwnRows,
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
  const target = (id: string): TableMeta => {
    const table = catalog.schema.tables.find((table) => table.id === id);
    if (!table) return refuse(`"${id}" is not in this write's footprint: a command writes only the tables it declares.`);
    if (!catalog.writable.has(id)) {
      /* A trigger writes what no row policy bounds, so a scoped write never fires one: name it, or the owner is left
         guessing why a table they declared written is not. */
      const by = catalog.blockedBy?.get(id);
      return refuse(
        by
          ? `"${id}" cannot be written under a row policy: it has ${by}, whose writes the policy cannot bound.`
          : `"${id}" is read-only in this scope: the command does not declare it written, or the principal's rows do not admit writing it.`,
      );
    }
    if (!table.columns.some((column) => column.primaryKey))
      return refuse(`"${id}" has no primary key, so a scoped write cannot prove which row it changed.`);
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
  const lockedRead = async (table: TableMeta, filter: Filter, within: Pick<ScopedReads, 'query' | 'count'>) => {
    const locked = locks?.target(table, filter);
    const read = () => within.query({ table: table.id, filter, limit: 2, offset: 0 });
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
     list, refused there, so the checks before it still speak first. */
  const parentChecks = (table: TableMeta, row: Record<string, unknown>, set?: ReadonlySet<string>): ParentCheck[] => {
    const checks: ParentCheck[] = [];
    for (const fk of catalog.schema.foreignKeys.filter(
      (fk) => fk.from.table === table.id && (!set || fk.from.columns.some((column) => set.has(column))),
    )) {
      const values = fk.from.columns.map((column) => row[column]);
      if (values.some((value) => value === null)) continue;
      if (!values.every(comparable)) {
        checks.push({ refused: `"${table.id}".${fk.from.columns.join('+')} holds a value that is not a text or a number.` });
        break;
      }
      // Parent columns stay on the SQL left-hand side so SQLite's parent
      // affinity and collation, rather than JavaScript equality, decide.
      const filter: Filter = {
        groups: [fk.to.columns.map((column, index) => ({ column, op: '=', value: values[index] as string | number }))],
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
      return guess.fk === check.fk && guess.values.every((value, at) => value === check.values[at]);
    });
  const parents = async (table: TableMeta, row: Record<string, unknown>, set?: ReadonlySet<string>, guessed?: readonly Asked[]) => {
    const checks = parentChecks(table, row, set);
    if (!locks?.together) {
      for (const check of checks) {
        if ('refused' in check) return refuse(check.refused);
        // A parent's visibility must hold until commit, not just at this read.
        await locks?.parent(check.parent, check.filter);
        if ((await guards.count(check.fk.to.table, check.filter)) !== 1) return refuse(unseen(check));
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
    }
  };
  return Object.freeze({
    query: (request) => reads.query(request),
    count: (table, filter) => reads.count(table, filter),
    async insert(request) {
      const table = target(request.table);
      const result = await records.insert(request);
      const filter = keyFilter(table, result.key);
      /* The new row locked and read back, and where the writer sends together
         its references checked in the same flight, from the row the INSERT
         returned (parents uses them only where the stored row holds exactly
         those). No other transaction can see this row yet, so its lock is
         granted at once and the read answers what a count before it would. */
      const read = lockedRead(table, filter, guards);
      const guessed = locks?.together && result.row ? ask(parentChecks(table, result.row)) : undefined;
      read.catch(() => {});
      const found = await read;
      // Inside the bound and outside the principal's rows: the command's own row, answered by its key and what it wrote.
      if (bound && found.rows.length !== 1) {
        await parents(table, await stored(table, result.key, bound.reads), undefined, guessed);
        return { key: result.key, applied: result.applied, sql: result.sql };
      }
      const row = one(table, result.key, found);
      await parents(table, row, undefined, guessed);
      madeBy(table, row);
      return result;
    },
    async update(request) {
      const table = target(request.table);
      const protectedColumns = new Set([
        ...table.columns.filter((column) => column.primaryKey).map((column) => column.name),
        ...catalog.schema.foreignKeys.filter((fk) => fk.to.table === table.id).flatMap((fk) => fk.to.columns),
      ]);
      const moved = Object.keys(request.values ?? {}).filter((column) => protectedColumns.has(column));
      if (moved.length)
        return refuse(`A scoped update may not change "${table.id}".${moved.join(', ')}: a key, or a column another table references.`);
      const before = await stored(table, request.key);
      const set = new Set(Object.keys(request.values ?? {}));
      /* The row read again after the write, sent the moment the write is: it
         reads what the write wrote, and leaves in the write's round trip, with
         the references the write sets checked behind it, as the row will hold
         them. A write that fails aborts them too, and the write's failure is
         the one thrown. */
      const after: { row?: Promise<Record<string, unknown>>; guessed?: Asked[] } = {};
      const withdraw = locks?.behind?.(table, () => {
        after.row = stored(table, request.key);
        after.row.catch(() => {});
        if (locks.together) after.guessed = ask(parentChecks(table, { ...before, ...request.values }, set));
      });
      let result: Awaited<ReturnType<WriteTransaction['update']>>;
      try {
        result = await records.update(request);
      } finally {
        withdraw?.();
      }
      if (result.affected !== 1) return refuse(`The update of "${table.id}" changed ${result.affected} rows, not one.`);
      await parents(table, await (after.row ?? stored(table, request.key)), set, after.guessed);
      return result;
    },
    async remove(request) {
      const table = target(request.table);
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
        const filter: Filter = {
          groups: [fk.from.columns.map((column, index) => ({ column, op: '=', value: values[index] as string | number }))],
        };
        if ((await records.count(fk.from.table, filter)) !== 0)
          return refuse(
            `A scoped command may not delete the "${table.id}" row ${keyText(request.key)}: "${fk.from.table}" still references it.`,
          );
      }
      const result = await records.remove(request);
      if (result.affected !== 1) return refuse(`The delete from "${table.id}" removed ${result.affected} rows, not one.`);
      return result;
    },
  } satisfies WriteTransaction);
}
