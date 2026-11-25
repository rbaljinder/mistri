/**
 * `noOverlap` and `constraints`, held where every write of the row passes: the App's write layer (appAccess.ts
 * authorizeTransaction), so Save, a list cell, an import, the App API, a command's `db`, a flow and a job all meet
 * the same rule and hear the same refusal. The rules themselves are the catalog's (shared/appDataRules.ts).
 *
 * Two things happen here.
 *
 * A write the database refused by a constraint the App named is said as that constraint's refusal: the field and
 * the App's fixed words, in place of `constraint_failed` (`declaredRefusal`). Only the constraint's name is read
 * off the engine's error, never its detail, so nothing of the row written or the row it met is carried. That holds
 * under a row policy and in a tenant too, where the row met may be one the person cannot read: the App declared
 * that this rule says so, and the words say nothing else.
 *
 * On SQLite, where no constraint can hold `noOverlap`, the rule is read for after the row is written, inside the
 * write's own transaction (`holdNoOverlap`): one writer at a time, so nothing can come between the read and the
 * COMMIT. On PostgreSQL the exclusion constraint is the rule, and nothing is read here: a read could not stop two
 * writers that each see the slot free.
 */
import type { QueryRequest, WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import type { Condition, Filter } from '@mistriwork/engine/shared/filter.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { ConstraintRefusal, NoOverlapRule } from '../../shared/appDataRules.js';
import { AppValidationDenied } from './appValidationDenied.js';

/** A resource's `noOverlap` among the App's write rules (appValidation.ts). */
export interface NoOverlapWriteRule {
  kind: 'noOverlap';
  rule: NoOverlapRule;
}

/** A named constraint's refusal among the App's write rules: a resource's `constraints`, and each `noOverlap`'s own. */
export interface ConstraintWriteRule {
  kind: 'constraint';
  name: string;
  refusal: ConstraintRefusal;
}

type Rules = ReadonlyMap<string, readonly unknown[]> | undefined;
const kindOf = (item: unknown) => (item && typeof item === 'object' ? (item as { kind?: unknown }).kind : undefined);

/** The `noOverlap` rules a table's writes hold, out of the App's write rules. */
export function noOverlapOf(validation: Rules, table: string): NoOverlapRule[] {
  return (validation?.get(table) ?? []).flatMap((item) => (kindOf(item) === 'noOverlap' ? [(item as NoOverlapWriteRule).rule] : []));
}

/** Whether any constraint of `table` has a refusal declared: the only writes whose failures are read at all. */
function namesConstraints(validation: Rules, table: string): boolean {
  return (validation?.get(table) ?? []).some((item) => kindOf(item) === 'constraint');
}

/**
 * The constraint a refused write names, and the table when the engine says one. Names only: PostgreSQL's
 * `constraint` field (a rule of the database's, or a trigger's `RAISE … USING CONSTRAINT`), which a row scope's
 * refusal carries on (scopedTransaction.ts); SQLite's `CHECK constraint failed: <name>`, and a trigger's
 * `RAISE(ABORT, '<name>')`, whose whole message is the name.
 */
function constraintNamed(error: unknown): { name: string; table?: string } | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as {
    constraint?: unknown;
    table?: unknown;
    errcode?: unknown;
    message?: unknown;
  };
  if (typeof e.constraint === 'string' && e.constraint)
    return {
      name: e.constraint,
      ...(typeof e.table === 'string' && e.table ? { table: e.table } : {}),
    };
  if (typeof e.message !== 'string') return undefined;
  if (e.errcode === 275) {
    const said = /^CHECK constraint failed: (.+)$/.exec(e.message);
    return said ? { name: said[1]! } : undefined;
  }
  // SQLITE_CONSTRAINT_TRIGGER: the message is what the trigger raised, and nothing of the engine's.
  return e.errcode === 1811 && e.message.length <= 63 ? { name: e.message } : undefined;
}

/**
 * The declared refusal of a write of `table` the database refused, or undefined when the error names no constraint
 * the App declared on that table. A constraint of another table (a trigger's or a cascade's write) is not this
 * resource's to say.
 */
function declaredRefusal(full: DatabaseSchema, validation: Rules, table: string, error: unknown): AppValidationDenied | undefined {
  const named = constraintNamed(error);
  if (!named) return undefined;
  const physical = full.tables.find((item) => item.id === table)?.name;
  if (named.table !== undefined && physical !== undefined && named.table !== physical) return undefined;
  const found = (validation?.get(table) ?? []).find(
    (item) => kindOf(item) === 'constraint' && (item as ConstraintWriteRule).name === named.name,
  ) as ConstraintWriteRule | undefined;
  return found
    ? new AppValidationDenied([found.refusal.field], {
        [found.refusal.field]: found.refusal.message,
      })
    : undefined;
}

/**
 * Whether `thrown`, a transaction callback's failure, is the App's own saying of `kept`, the failure its queue of
 * operations kept: the refusal of a named constraint, said in the App's declared words above the operation that
 * failed. A layer that prefers what its operations kept lets the restated one stand, as it does a record's line
 * named by its place.
 */
export const restatesConstraint = (kept: unknown, thrown: unknown): boolean =>
  thrown instanceof AppValidationDenied && !(kept instanceof AppValidationDenied) && constraintNamed(kept) !== undefined;

/** A write's promise, its failure said as the App's declared refusal where the database named a declared constraint. */
export function sayingDeclared<T>(full: DatabaseSchema, validation: Rules, table: string, write: () => Promise<T>): Promise<T> {
  if (!namesConstraints(validation, table)) return write();
  return write().catch((error: unknown) => {
    throw declaredRefusal(full, validation, table, error) ?? error;
  });
}

/* Two ends as SQLite orders them where both are of one kind: numbers by value, text by its characters (ISO dates). */
const before = (a: unknown, b: unknown): boolean =>
  typeof a === 'number' && typeof b === 'number' ? a < b : typeof a === 'string' && typeof b === 'string' ? a < b : false;
const held = (value: unknown): value is string | number => (typeof value === 'string' && value !== '') || typeof value === 'number';

/**
 * Refuse the write of the row `key` names when it meets another row under one of `rules`. Called after the row is
 * written, in the write's transaction, on SQLite only. The row is read back as stored, so a default or a value an
 * update left alone is judged as it stands; a row outside the rule (an empty end, an empty range, `when` not met)
 * passes. The read is the transaction's own, so under a row policy it sees the rows the writer may read: a row
 * hidden from the writer does not refuse here (`mistri check` says so, [no-overlap-rows]).
 */
export async function holdNoOverlap(
  writer: Pick<WriteTransaction, 'query' | 'count'>,
  full: DatabaseSchema,
  rules: readonly NoOverlapRule[],
  table: string,
  key: Record<string, string | number>,
  written?: readonly string[],
): Promise<void> {
  const meta = full.tables.find((item) => item.id === table);
  if (!meta || (meta.sourceDialect ?? full.dialect) !== 'sqlite') return;
  const own: Condition[] = Object.entries(key).map(([column, value]) => ({
    column,
    op: '=' as const,
    value,
  }));
  if (!own.length) return;
  for (const rule of rules) {
    if (written && !written.some((column) => rule.reads.includes(column))) continue;
    const read: QueryRequest = {
      table,
      columns: [...rule.by, rule.from, rule.to],
      filter: { groups: [own] },
      limit: 2,
      offset: 0,
    };
    const found = await writer.query(read);
    if (found.rows.length !== 1) continue;
    const row = found.rows[0]!;
    const from = row[rule.from];
    const to = row[rule.to];
    if (!held(from) || !held(to) || !before(from, to) || rule.by.some((column) => !held(row[column]))) continue;
    const within = rule.when?.groups ?? [[]];
    if (
      rule.when &&
      (await writer.count(table, {
        groups: within.map((group) => [...own, ...group]),
      })) !== 1
    )
      continue;
    const meets: Condition[] = [
      ...rule.by.map((column) => ({
        column,
        op: '=' as const,
        value: row[column] as string | number,
      })),
      { column: rule.from, op: '<', value: to },
      { column: rule.to, op: '>', value: from },
    ];
    /* Any other row: one whose key differs in some column. OR of ANDs, so each `when` group is asked once per key column. */
    const others: Filter = {
      groups: within.flatMap((group) =>
        own.map((part) => [...group, ...meets, { column: part.column, op: '!=' as const, value: part.value }]),
      ),
    };
    /* A stored row whose own range is empty meets nothing, as on PostgreSQL: read the ends and judge them here,
       since a filter compares a column with a value and not with another column. */
    const met = await writer.query({
      table,
      columns: [rule.from, rule.to],
      filter: others,
      limit: 50,
      offset: 0,
    });
    if (met.rows.some((other) => before(other[rule.from], other[rule.to])))
      throw new AppValidationDenied([rule.field], {
        [rule.field]: rule.message,
      });
  }
}
