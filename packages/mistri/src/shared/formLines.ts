/**
 * A New form's child rows and the figures it says as they are typed.
 *
 * `form.lines` asks an order's lines (a bundle's items, a pay run's lines)
 * as a grid under the record's fields, and the server inserts them with the
 * record, in its transaction, each one the insert the reader could make of
 * that row alone (dataWriteRoutes.ts). `form.live` names the resource's own
 * computed columns and rollups — `subtotal: sum('order_line', 'line_total')`,
 * `total: computed.number('subtotal + shipping')` — and the form says each as
 * its fields and lines change, worked out by the one evaluator the server's
 * statement agrees with (computedValue.ts `evaluateComputed`). What the form says
 * is a preview: the record's figures are the server's, read from the rows it
 * stored, so nothing the browser works out is ever written.
 *
 * Two readers. The load judges the declarations against the catalog
 * (`formLinesProblems`); the browser works out the values (`liveValues`)
 * from the catalog it is served, where each computed column comes with its
 * constants folded and each rollup with the reference it walks.
 */
import type { AppDef, FormLines } from './appModel.js';
import { computedReads, type ComputedNode, type ComputedValue } from '@mistriwork/engine/shared/computed.js';
import { evaluateComputed } from '@mistriwork/engine/shared/computedValue.js';
import { columnKind, tableNamed, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { Rollup } from '@mistriwork/engine/shared/rollups.js';
import { typedValue } from '@mistriwork/engine/shared/formValues.js';
export { typedValue } from '@mistriwork/engine/shared/formValues.js';

/** The child table and the column a rollup reads its rows by: `order_line.order_id` → those two, or undefined for a composite. */
function viaOf(rollup: Pick<Rollup, 'via'>): { table: string; column: string } | undefined {
  const dot = rollup.via.lastIndexOf('.');
  const column = rollup.via.slice(dot + 1);
  return dot < 0 || column.includes('+') ? undefined : { table: rollup.via.slice(0, dot), column };
}

/** The one reference from `child.whose` to the parent table, if the catalog has exactly that. */
function bindsTo(schema: DatabaseSchema, child: TableMeta, whose: string, parent: TableMeta): boolean {
  return (schema.foreignKeys ?? []).some(
    (fk) => fk.from.table === child.id && fk.to.table === parent.id && fk.from.columns.length === 1 && fk.from.columns[0] === whose,
  );
}

/**
 * Each resource form's `lines` and `live` against the catalog — rollups and
 * computed columns resolved on it (withRollups, withComputed) — as problems
 * naming the fix. A form whose declarations do not hold would offer a grid
 * the server refuses or a figure that never comes.
 */
export function formLinesProblems(app: AppDef, schema: DatabaseSchema): string[] {
  const problems: string[] = [];
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    const form = resource.form;
    if (!form?.lines && !form?.live) continue;
    const table = tableNamed(schema, name);
    if (!table) continue;
    const at = `resources "${name}"`;
    const lines = form.lines ?? [];
    for (const line of lines) {
      const here = `${at}: form.lines "${line.label}"`;
      const child = tableNamed(schema, line.from);
      if (!child || !Object.hasOwn(app.resources ?? {}, line.from)) {
        problems.push(`${here}: "${line.from}" is not one of this App's resources; declare it, with access: 'write'.`);
        continue;
      }
      if (app.resources![line.from].access !== 'write')
        problems.push(`${here}: the App does not write "${line.from}"; give it access: 'write' so its rows can be added with the record.`);
      if (!bindsTo(schema, child, line.whose, table))
        problems.push(
          `${here}: "${line.whose}" is not a reference from ${child.name} to ${table.name}; name the column that points at the new record.`,
        );
      for (const column of [...line.show, ...(line.order ? [line.order] : [])]) {
        const meta = child.columns.find((c) => c.name === column);
        if (!meta) problems.push(`${here}: "${column}" is not a column of ${child.name}.`);
        else if (meta.writable === false) problems.push(`${here}: "${column}" is not written by a form (the database fills it).`);
      }
      if (line.show.includes(line.whose))
        problems.push(`${here} shows "${line.whose}", which the server fills with the new record; leave it out.`);
      if (line.order && line.show.includes(line.order))
        problems.push(`${here} shows its order column "${line.order}", which the rows' places fill; leave it out of show.`);
      if (line.order && columnKind(child.columns.find((c) => c.name === line.order)?.type ?? '') !== 'number')
        problems.push(`${here}: the order column "${line.order}" is not a number.`);
    }
    for (const live of form.live ?? []) {
      const problem = liveProblem(table, live, lines, schema, new Set());
      if (problem) problems.push(`${at}: form.live "${live}" ${problem}`);
    }
  }
  return problems;
}

/** Why a name cannot be worked out live on this form, or undefined when it can. */
function liveProblem(
  table: TableMeta,
  name: string,
  lines: readonly FormLines[],
  schema: DatabaseSchema,
  seen: Set<string>,
): string | undefined {
  if (seen.has(name)) return `reads itself.`;
  seen.add(name);
  const rollup = table.rollups?.[name];
  if (rollup) {
    const via = viaOf(rollup);
    const childId = via && tableNamed(schema, via.table)?.id;
    const line = childId && lines.find((l) => tableNamed(schema, l.from)?.id === childId && l.whose === via.column);
    if (!via || !line) return `is a rollup of rows this form does not ask; add its rows to form.lines, by the reference it counts.`;
    if (rollup.of) return `rolls up another rollup, which a form's lines do not hold.`;
    if (rollup.fn === 'latest') return `reads the newest of its rows, which a form's lines have no order for until they are saved.`;
    if (rollup.filter)
      return `narrows its rows by a query; a form adds up every line it holds, so roll up a computed column of the line instead.`;
    const reads = rollup.expression ? rollup.expression.reads : rollup.column ? [rollup.column] : [];
    const missing = reads.find((column) => !line.show.includes(column) && column !== line.order);
    if (missing) return `reads "${missing}", which the lines "${line.label}" do not ask; add it to their show.`;
    return undefined;
  }
  const computed = table.computed?.[name];
  if (!computed) return `is not a computed column or a rollup of ${table.name}.`;
  for (const path of computedReads(computed.expr)) {
    if (path.includes('.')) return `reads "${path}" through a reference, which a form does not hold until it is saved.`;
    if (table.rollups?.[path] || table.computed?.[path]) {
      const inner = liveProblem(table, path, lines, schema, seen);
      if (inner) return `reads "${path}", which ${inner}`;
    } else if (!table.columns.some((c) => c.name === path)) return `reads "${path}", which is not a column of ${table.name}.`;
  }
  return undefined;
}

/* ---------- the values, in the browser ---------- */

/** A form's draft as text, the way its inputs hold each value: stored units, an empty box as ''. */
export type DraftValues = Readonly<Record<string, string | null | undefined>>;

/**
 * The form's live values, by name: each of `names` worked out from the
 * draft (`values`) and its lines (`rows`, keyed by the child table's id), in
 * the catalog's own reading — a computed column's folded expression, a
 * rollup's reference and column. A name the catalog does not serve this
 * reader is left out, as it would be from a list. `today` and `now` were
 * folded where the catalog was served, so a form says what a list would.
 */
export function liveValues(
  schema: DatabaseSchema,
  table: TableMeta,
  names: readonly string[],
  values: DraftValues,
  rows: Readonly<Record<string, readonly DraftValues[]>>,
): Record<string, ComputedValue> {
  const clock = { today: new Date().toISOString().slice(0, 10), now: new Date(), me: null };
  const memo = new Map<string, ComputedValue>();
  const rowValue = (child: TableMeta, row: DraftValues, column: string, expression?: Pick<Rollup, 'expression'>['expression']) =>
    expression
      ? evaluateComputed(expression.expr as ComputedNode, clock, (path) => typedValue(child, path, row[path]))
      : typedValue(child, column, row[column]);
  const value = (name: string): ComputedValue => {
    if (memo.has(name)) return memo.get(name)!;
    memo.set(name, null);
    let result: ComputedValue = null;
    const rollup = table.rollups?.[name];
    const computed = table.computed?.[name];
    if (rollup) {
      const via = viaOf(rollup);
      const child = via && tableNamed(schema, via.table);
      const held = (child && rows[child.id]) ?? [];
      if (child && !rollup.of && !rollup.filter && rollup.fn !== 'latest') {
        /* As the aggregate does: a count of the rows, a sum of their values (0 where none has one), and a least or most with nothing where none has one. */
        const figures = held
          .map((row) => rowValue(child, row, rollup.column ?? '', rollup.expression))
          .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
        result =
          rollup.fn === 'count'
            ? held.length
            : rollup.fn === 'sum'
              ? figures.reduce((a, b) => a + b, 0)
              : !figures.length
                ? null
                : rollup.fn === 'min'
                  ? Math.min(...figures)
                  : Math.max(...figures);
      }
    } else if (computed) {
      result = evaluateComputed(computed.expr, clock, (path) =>
        table.rollups?.[path] || table.computed?.[path] ? value(path) : typedValue(table, path, values[path]),
      );
    }
    memo.set(name, result);
    return result;
  };
  return Object.fromEntries(names.filter((name) => table.rollups?.[name] || table.computed?.[name]).map((name) => [name, value(name)]));
}
