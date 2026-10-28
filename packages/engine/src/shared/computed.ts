/**
 * Computed columns: a resource's virtual columns, each a typed expression over
 * its own columns — `computed: { is_overdue: computed.boolean('due_on < today
 * and not completed'), days_open: computed.number('today - opened_on') }`.
 *
 * A computed column is served like a rollup (rollups.ts): never a column of
 * the table, so no insert, no update, no form and no single-table read ever
 * names it; it lives beside the columns (`TableMeta.computed`), where the path
 * resolver finds it by name, and the view compiler writes its expression into
 * the statement wherever a path names it — a list's `show`, a sort, a tab's or
 * an action's condition, a record page's fields, a dashboard's measure, an
 * export. So it sorts, filters, tones and exports like a column, on every
 * engine, with nothing for the browser to work out.
 *
 * Its words are the query language's: columns (and paths through a reference,
 * as a record label's template reads them, `account_id.close_date`), numbers,
 * quoted text, `true`/`false`, `today` and `now`, `me` (the signed-in
 * account's email, as a fixed action's `set` writes it), comparisons,
 * `and`/`or`/`not`, `in (…)`, `is empty`, arithmetic, and dates: a date minus a date is
 * days, a date plus a number is that many days later, and a unit says others
 * (`ends_on + term months`, `now - 30 minutes`). Five functions: `coalesce(a, b, …)`
 * the first that has a value, `round(x)` and `round(x, 2)`, `abs(x)`, and
 * `min(a, b, …)` and `max(a, b, …)` of numbers or dates, which have no value
 * where one of theirs has none, as arithmetic has (`max(owed - paid, 0)`).
 * That covers a due flag, an age, a renewal day, a balance.
 * Anything heavier is a database view or a generated column, which the
 * catalog reads as a column already.
 *
 * The constants are folded when the catalog is served (withComputed), each
 * request's: `today` is the App's day in its time zone, `now` the instant,
 * `me` this reader. A reader is served a computed column only where every
 * column it reads is served to them, so a value never says what its inputs
 * would not (appComputed.ts).
 */
import type { SqlStyle } from './filter.js';
import { noteRead } from './query.js';
import type { ColumnMeta, DatabaseSchema } from './schema.js';

export const COMPUTED_TYPES = ['boolean', 'number', 'date'] as const;
export type ComputedType = (typeof COMPUTED_TYPES)[number];

/** A span a date moves by: `3 days`, `term months`. */
export type ComputedUnit = ComputedSpan['unit'];

export type ComputedNode =
  | { k: 'path'; path: string }
  | { k: 'number'; value: number }
  | { k: 'text'; value: string }
  | { k: 'bool'; value: boolean }
  /* The constants, as authored; folded to literals where the catalog is served. */
  | { k: 'today' }
  | { k: 'now' }
  | { k: 'me' }
  | { k: 'date'; value: string }
  | { k: 'instant'; value: string }
  /* `me` for a visitor: nobody, so no comparison with it is true. */
  | { k: 'nobody' }
  | { k: 'not'; of: ComputedNode }
  | { k: 'neg'; of: ComputedNode }
  | { k: 'empty'; of: ComputedNode; negate: boolean }
  | ComputedSpan
  | { k: 'call'; fn: ComputedFunction; args: ComputedNode[] }
  | { k: 'op'; op: ComputedOp; left: ComputedNode; right: ComputedNode };

/** The functions an expression may call (computedParse.ts COMPUTED_FUNCTIONS): each written alike on every engine and worked out alike in JavaScript. */
export type ComputedFunction = 'coalesce' | 'round' | 'min' | 'max' | 'abs';

interface ComputedSpan {
  k: 'span';
  of: ComputedNode;
  /* `hour` and `minute` move an instant (`now - 30 minutes`, `due_at + 2 hours`); the rest move by the calendar. */
  unit: 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';
}
export type ComputedOp = '+' | '-' | '*' | '/' | '=' | '!=' | '<' | '<=' | '>' | '>=' | 'and' | 'or';

/** A computed column as a catalog serves it and a view carries it: no request ever supplies one. */
export interface ComputedColumn {
  type: ComputedType;
  expr: ComputedNode;
  /** The paths it reads, from its own table: what a reader must be served for it to be. */
  reads: string[];
}

/** A computed column a view names, keyed by its path in `ViewDef.expressions`, with the prefix of the record it is on. */
export interface ComputedPath extends ComputedColumn {
  on: string;
}

/** What a computed column is to anything that reads columns: typed, never written, never a key. */
export function computedColumnMeta(name: string, computed: Pick<ComputedColumn, 'type'>): ColumnMeta {
  return {
    name,
    type: computed.type === 'number' ? 'numeric' : computed.type,
    nullable: computed.type !== 'boolean',
    primaryKey: false,
    writable: false,
  };
}

/**
 * The catalog with each table's computed columns among its columns, typed and never written (`computed` by table id):
 * what a rule judged of a stored row reads one through (a validation, a form's value from a referenced record), where
 * the figure is worked out once the row is read rather than by the statement that reads it.
 */
export function withComputedColumns(
  schema: DatabaseSchema,
  computed: ReadonlyMap<string, Readonly<Record<string, Pick<ComputedColumn, 'type'>>>>,
): DatabaseSchema {
  if (!computed.size) return schema;
  return {
    ...schema,
    tables: schema.tables.map((table) => {
      const named = computed.get(table.id);
      if (!named) return table;
      const extra = Object.entries(named)
        .filter(([name]) => !table.columns.some((column) => column.name === name))
        .map(([name, column]) => computedColumnMeta(name, column));
      return extra.length ? { ...table, columns: [...table.columns, ...extra] } : table;
    }),
  };
}

/* ---------- the words (the parser is computedParse.ts) ---------- */

export class ComputedError extends Error {
  constructor(
    message: string,
    readonly at: number,
  ) {
    super(message);
  }
}

/** Every path an expression reads, once each, in order. */
export function computedReads(node: ComputedNode): string[] {
  const out: string[] = [];
  const walk = (n: ComputedNode) => {
    if (n.k === 'path') {
      if (!out.includes(n.path)) out.push(n.path);
      return;
    }
    if (n.k === 'op') {
      walk(n.left);
      walk(n.right);
      return;
    }
    if (n.k === 'call') n.args.forEach(walk);
    if (n.k === 'not' || n.k === 'neg' || n.k === 'empty' || n.k === 'span') walk(n.of);
  };
  walk(node);
  return out;
}

/* ---------- the types ---------- */

export type ValueKind = 'number' | 'date' | 'text' | 'boolean' | 'span' | 'null';

/**
 * What an expression is, or why it is none: each column's kind from the
 * catalog (`kindOf`), a date minus a date a number of days, a date plus a
 * number or a span a date. Said in the author's words, with the character
 * the mistake stands at where a word locates it.
 */
export function computedKind(node: ComputedNode, kindOf: (path: string) => ValueKind | undefined): ValueKind {
  const kind = (n: ComputedNode): ValueKind => {
    switch (n.k) {
      case 'path': {
        const found = kindOf(n.path);
        if (!found) throw new Error(`"${n.path}" is not a column here.`);
        return found;
      }
      case 'number':
        return 'number';
      case 'text':
      case 'me':
      case 'nobody':
        return 'text';
      case 'bool':
        return 'boolean';
      case 'today':
      case 'now':
      case 'date':
      case 'instant':
        return 'date';
      case 'not': {
        if (kind(n.of) !== 'boolean') throw new Error('"not" reads a yes-or-no.');
        return 'boolean';
      }
      case 'neg': {
        if (kind(n.of) !== 'number') throw new Error('a minus sign reads a number.');
        return 'number';
      }
      case 'empty':
        kind(n.of);
        return 'boolean';
      case 'span': {
        if (kind(n.of) !== 'number') throw new Error(`"${n.unit}s" counts a number: "3 days", "term months".`);
        return 'span';
      }
      case 'call': {
        const kinds = n.args.map(kind);
        if (n.fn === 'round' || n.fn === 'abs') {
          if (kinds.some((each) => each !== 'number')) throw new Error(`${n.fn}(…) reads numbers.`);
          return 'number';
        }
        const first = kinds[0];
        if (kinds.some((each) => each !== first))
          throw new Error(`${n.fn}(…) takes values of one kind, and has a ${first} and a ${kinds.find((each) => each !== first)}.`);
        if (first === 'span') throw new Error(`${n.fn}(…) takes no span of days; add it to a date.`);
        if (first === 'boolean') throw new Error(`${n.fn}(…) takes numbers, dates or text, not yes-or-no conditions.`);
        if (n.fn !== 'coalesce' && first === 'text') throw new Error(`${n.fn}(…) takes numbers or dates.`);
        return first;
      }
      case 'op': {
        const l = kind(n.left),
          r = kind(n.right);
        if (n.op === 'and' || n.op === 'or') {
          if (l !== 'boolean' || r !== 'boolean') throw new Error(`"${n.op}" joins two yes-or-no conditions.`);
          return 'boolean';
        }
        if (['=', '!=', '<', '<=', '>', '>='].includes(n.op)) {
          if (l !== r && !(l === 'text' && r === 'text')) throw new Error(`"${n.op}" compares a ${l} with a ${r}.`);
          if (l === 'span') throw new Error('a span of days is not compared; add it to a date.');
          return 'boolean';
        }
        /* A day has no hours: `today + 2 hours` would be a moment in no stated zone. */
        const clockOnDay = (date: ComputedNode, span: ComputedNode) =>
          span.k === 'span' && (span.unit === 'hour' || span.unit === 'minute') && (date.k === 'today' || date.k === 'date');
        if (clockOnDay(n.left, n.right) || clockOnDay(n.right, n.left))
          throw new Error(`today is a day, and hours and minutes move an instant: write now, or a timestamp column.`);
        if (n.op === '+') {
          if (l === 'number' && r === 'number') return 'number';
          if ((l === 'date' && (r === 'number' || r === 'span')) || (r === 'date' && (l === 'number' || l === 'span'))) return 'date';
          throw new Error(`"+" adds numbers, or days to a date — not a ${l} and a ${r}.`);
        }
        if (n.op === '-') {
          if (l === 'number' && r === 'number') return 'number';
          if (l === 'date' && r === 'date') return 'number';
          if (l === 'date' && (r === 'number' || r === 'span')) return 'date';
          throw new Error(`"-" takes numbers, a date from a date (days), or days from a date — not a ${r} from a ${l}.`);
        }
        if (l !== 'number' || r !== 'number') throw new Error(`"${n.op}" reads numbers.`);
        return 'number';
      }
    }
  };
  return kind(node);
}

/** The expression with its constants as this request's values: the App's day, the instant, the reader. */
export function foldConstants(node: ComputedNode, values: { today: string; now: string; me: string | null }): ComputedNode {
  /* Each constant folded is told to whatever keeps the catalog it is folded into (query.ts readsOf). */
  const fold = (n: ComputedNode): ComputedNode => {
    switch (n.k) {
      case 'today':
        noteRead(1);
        return { k: 'date', value: values.today };
      case 'now':
        noteRead(2);
        return { k: 'instant', value: values.now };
      case 'me':
        noteRead(0, true);
        return values.me === null ? { k: 'nobody' } : { k: 'text', value: values.me };
      case 'op':
        return { ...n, left: fold(n.left), right: fold(n.right) };
      case 'call':
        return { ...n, args: n.args.map(fold) };
      case 'not':
      case 'neg':
      case 'empty':
      case 'span':
        return { ...n, of: fold(n.of) };
      default:
        return n;
    }
  };
  return fold(node);
}

/* ---------- the statement ---------- */

type Dialect = 'sqlite' | 'postgres' | 'mysql';
const dialectOf = (style: SqlStyle): Dialect => style.dialect ?? 'sqlite';

/**
 * The expression as SQL on one engine. `column` writes a path the way the
 * view writes every other (qualified against its joins); `kindOf` is the
 * same reading of the catalog that typed it, which says where a yes-or-no
 * column is an integer (SQLite, MySQL, a PostgreSQL 0/1 flag).
 */
export function compileComputed(
  computed: Pick<ComputedColumn, 'type' | 'expr'>,
  style: SqlStyle,
  column: (path: string) => string,
  kindOf: (path: string) => { kind: ValueKind; native?: boolean } | undefined,
): string {
  const dialect = dialectOf(style);
  const literal = (text: string) => `'${text.replace(/'/g, "''")}'`;
  const truthy = (n: ComputedNode): string => {
    if (n.k === 'bool') return dialect === 'postgres' ? (n.value ? 'TRUE' : 'FALSE') : n.value ? '(1 = 1)' : '(1 = 0)';
    if (n.k === 'path') {
      const found = kindOf(n.path);
      /* A native boolean reads as itself; a 0/1 integer as whether it is not 0. */
      return dialect === 'postgres' && found?.native ? column(n.path) : `(${column(n.path)} <> 0)`;
    }
    return sql(n);
  };
  const days = (n: ComputedNode): string =>
    n.k === 'span' ? (n.unit === 'week' ? `(${sql(n.of)}) * 7` : `(${sql(n.of)})`) : `(${sql(n)})`;
  const unitOf = (n: ComputedNode): ComputedUnit => (n.k === 'span' ? (n.unit === 'week' ? 'day' : n.unit) : 'day');
  /* An instant moved by the clock (`now - 30 minutes`), kept an instant rather than cast to its day. */
  const clocked = (date: string, amount: ComputedSpan, sign: 1 | -1): string => {
    const n = sign === 1 ? `(${sql(amount.of)})` : `(-(${sql(amount.of)}))`;
    if (dialect === 'postgres') return `(${date} + ${n} * INTERVAL '1 ${amount.unit}')`;
    if (dialect === 'mysql') return `DATE_ADD(${date}, INTERVAL ${n} ${amount.unit.toUpperCase()})`;
    return `datetime(${date}, printf('%+d ${amount.unit}s', CAST(${n} AS INTEGER)))`;
  };
  const shifted = (date: string, amount: ComputedNode, sign: 1 | -1): string => {
    if (amount.k === 'span' && (amount.unit === 'hour' || amount.unit === 'minute')) return clocked(date, amount, sign);
    const unit = unitOf(amount);
    const n = sign === 1 ? days(amount) : `(-${days(amount)})`;
    if (dialect === 'postgres')
      return unit === 'day'
        ? `(CAST(${date} AS DATE) + CAST(${n} AS INTEGER))`
        : `CAST(CAST(${date} AS DATE) + ${n} * INTERVAL '1 ${unit}' AS DATE)`;
    if (dialect === 'mysql') return `DATE_ADD(CAST(${date} AS DATE), INTERVAL ${n} ${unit.toUpperCase()})`;
    return `date(${date}, printf('%+d ${unit}s', CAST(${n} AS INTEGER)))`;
  };
  const sql = (n: ComputedNode): string => {
    switch (n.k) {
      case 'path':
        return column(n.path);
      case 'number':
        return String(n.value);
      case 'text':
        return literal(n.value);
      case 'nobody':
        return 'NULL';
      case 'bool':
        return truthy(n);
      case 'today':
      case 'now':
      case 'me':
        throw new Error(`"${n.k}" is read when the catalog is served, before a statement is written.`);
      case 'date':
        return dialect === 'sqlite' ? literal(n.value) : `DATE ${literal(n.value)}`;
      case 'instant':
        return dialect === 'sqlite'
          ? literal(n.value.replace('T', ' ').replace(/\.\d+Z$|Z$/, ''))
          : dialect === 'postgres'
            ? `CAST(${literal(n.value)} AS TIMESTAMPTZ)`
            : `TIMESTAMP ${literal(n.value.replace('T', ' ').replace(/\.\d+Z$|Z$/, ''))}`;
      case 'not':
        return `(NOT ${truthy(n.of)})`;
      case 'neg':
        return `(-(${sql(n.of)}))`;
      case 'empty':
        return `(${sql(n.of)} IS ${n.negate ? 'NOT ' : ''}NULL)`;
      case 'span':
        return days(n);
      case 'call': {
        const args = n.args.map(sql);
        if (n.fn === 'abs') return `ABS(${args[0]})`;
        if (n.fn === 'coalesce') return `COALESCE(${args.join(', ')})`;
        if (n.fn === 'round') {
          const places = args[1] ?? '0';
          /* A half rounds away from zero, of the figure as written: 1.005 is 1.01. PostgreSQL rounds a numeric so (a
             double cast to one keeps 15 digits); SQLite rounds the double, which is 1.00499…, so the figure is moved
             by its places and said to 15 digits first, as computedValue.ts works it out. */
          if (dialect === 'postgres') return `ROUND(CAST(${args[0]} AS NUMERIC), ${places})`;
          if (dialect === 'mysql') return `ROUND(${args[0]}, ${places})`;
          const scale = places === '0' ? '' : ` * 1e${places}`;
          const back = places === '0' ? '' : ` / 1e${places}`;
          return `(CASE WHEN (${args[0]}) IS NULL THEN NULL ELSE ROUND(CAST(printf('%.15g', (${args[0]})${scale}) AS REAL))${back} END)`;
        }
        /* SQLite's min and max of several are what MySQL's LEAST and GREATEST are, nothing where one is nothing;
           PostgreSQL's skip a null, so it is said there. */
        if (dialect === 'sqlite') return `${n.fn.toUpperCase()}(${args.join(', ')})`;
        const pick = `${n.fn === 'min' ? 'LEAST' : 'GREATEST'}(${args.join(', ')})`;
        if (dialect === 'mysql') return pick;
        return `(CASE WHEN ${args.map((arg) => `(${arg}) IS NULL`).join(' OR ')} THEN NULL ELSE ${pick} END)`;
      }
      case 'op': {
        if (n.op === 'and' || n.op === 'or') return `(${truthy(n.left)} ${n.op.toUpperCase()} ${truthy(n.right)})`;
        const lk = kindAt(n.left),
          rk = kindAt(n.right);
        if (['=', '!=', '<', '<=', '>', '>='].includes(n.op)) {
          const op = n.op === '!=' ? '<>' : n.op;
          if (lk === 'boolean') return `(${truthy(n.left)} ${op} ${truthy(n.right)})`;
          return `(${sql(n.left)} ${op} ${sql(n.right)})`;
        }
        if (n.op === '-' && lk === 'date' && rk === 'date') {
          if (dialect === 'postgres') return `(CAST(${sql(n.left)} AS DATE) - CAST(${sql(n.right)} AS DATE))`;
          if (dialect === 'mysql') return `DATEDIFF(${sql(n.left)}, ${sql(n.right)})`;
          return `CAST(julianday(date(${sql(n.left)})) - julianday(date(${sql(n.right)})) AS INTEGER)`;
        }
        if ((n.op === '+' || n.op === '-') && lk === 'date') return shifted(sql(n.left), n.right, n.op === '+' ? 1 : -1);
        if (n.op === '+' && rk === 'date') return shifted(sql(n.right), n.left, 1);
        /* Division never truncates and never fails: a number over zero has no value. */
        if (n.op === '/') return `((${sql(n.left)}) * 1.0 / NULLIF(${sql(n.right)}, 0))`;
        return `(${sql(n.left)} ${n.op} ${sql(n.right)})`;
      }
    }
  };
  const kindAt = (n: ComputedNode): ValueKind => computedKind(n, (path) => kindOf(path)?.kind);
  /* A yes-or-no column is yes or no, never unknown: a task with no due date is not overdue. */
  if (computed.type === 'boolean') {
    return dialect === 'postgres'
      ? `(CASE WHEN ${truthy(computed.expr)} THEN TRUE ELSE FALSE END)`
      : `(CASE WHEN ${truthy(computed.expr)} THEN 1 ELSE 0 END)`;
  }
  return sql(computed.expr);
}

/* ---------- an expression, in JavaScript ---------- */

/** What an expression comes to: a figure, a yes-or-no, text, a calendar day or an instant; null for no value. */
export type ComputedValue = number | boolean | string | null | { day: string } | { instant: Date };

/** Whether an expression says the instant (`now`), so it comes to a moment rather than a day. */
export function readsNow(node: ComputedNode): boolean {
  if (node.k === 'now' || node.k === 'instant') return true;
  if (node.k === 'op') return readsNow(node.left) || readsNow(node.right);
  if (node.k === 'call') return node.args.some(readsNow);
  if (node.k === 'not' || node.k === 'neg' || node.k === 'empty' || node.k === 'span') return readsNow(node.of);
  return false;
}

/** Whether an expression says the reader (`me`), so it comes to a different value for each. */
export function readsMe(node: ComputedNode): boolean {
  if (node.k === 'me') return true;
  if (node.k === 'op') return readsMe(node.left) || readsMe(node.right);
  if (node.k === 'call') return node.args.some(readsMe);
  if (node.k === 'not' || node.k === 'neg' || node.k === 'empty' || node.k === 'span') return readsMe(node.of);
  return false;
}

/* Working an expression out in JavaScript is computedValue.ts: its own module,
   so a page that only reads an expression's shape never fetches the evaluator. */
