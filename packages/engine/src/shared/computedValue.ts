/**
 * An expression's value, worked out in JavaScript (computed.ts parses it and
 * writes its SQL). A module of its own so the evaluator loads only with what
 * uses it — a form saying its live values (formLines.ts), a fixed action's
 * stamp on the server (appStamps.ts) — and never with a page's first paint.
 */
import { ComputedError, type ComputedNode, type ComputedValue } from './computed.js';

const DAY_MS = 86_400_000;
const dayOf = (date: Date) => date.toISOString().slice(0, 10);
const COMPARISONS = new Set(['=', '!=', '<', '<=', '>', '>=']);

/* A figure to `places`, a half away from zero, as the engines round a numeric: moved by its places and said to 15
   digits first (as PostgreSQL casts a double to a numeric, and computed.ts has SQLite do), so 1.005 is 1.01 as it is
   written rather than 1.00 as the double nearest it would say. */
function roundAway(figure: number, places: number): number {
  const scale = 10 ** places;
  const moved = Number((Math.abs(figure) * scale).toPrecision(15));
  const rounded = Math.round(moved) / scale;
  return rounded === 0 ? 0 : Math.sign(figure) * rounded;
}

/** Whether an expression is a yes-or-no at its top: a comparison, `and`, `or`, `not`, `is empty`, or `true`/`false`. */
const isCondition = (node: ComputedNode): boolean =>
  node.k === 'not' ||
  node.k === 'empty' ||
  node.k === 'bool' ||
  (node.k === 'op' && (node.op === 'and' || node.op === 'or' || COMPARISONS.has(node.op)));

/**
 * An expression's value, worked out in JavaScript with the statement's
 * semantics (compileComputed), so the browser and the server say one thing:
 * where a fixed action's `set` writes a constant (appStamps on the server),
 * and where a form says its live values as someone types (formLines.ts).
 * `read` supplies each path's value, typed — a number, a yes-or-no, text, a
 * day — or null for none; an expression that reads no column needs none.
 *
 * As SQL does: anything with no value in it has none (`price * qty` with no
 * price), a number over zero has none, a comparison with nothing is unknown,
 * and `and`, `or` and `not` keep unknown as SQL's three-valued logic does. A
 * yes-or-no that comes out unknown is no, as a computed flag is (the CASE in
 * compileComputed): a task with no due date is not overdue. Dates move as the
 * statement moves them: days and weeks by count, months and years by the
 * calendar, a day past a month's end landing on its last, an instant by hours
 * and minutes.
 */
export function evaluateComputed(
  node: ComputedNode,
  values: { today: string; now: Date; me: string | null },
  read: (path: string) => ComputedValue = (path) => {
    throw new ComputedError(`"${path}" is a column, and this expression reads none.`, 0);
  },
): ComputedValue {
  const span = (n: ComputedNode & { k: 'span' }) => ({ count: Number(value(n.of)), unit: n.unit });
  const move = (
    at: { day: string } | { instant: Date },
    by: { count: number; unit: string },
    sign: 1 | -1,
  ): { day: string } | { instant: Date } => {
    const base = 'day' in at ? new Date(`${at.day}T00:00:00Z`) : new Date(at.instant);
    const count = by.count * sign;
    if (by.unit === 'hour' || by.unit === 'minute')
      return { instant: new Date(base.getTime() + count * (by.unit === 'hour' ? 3_600_000 : 60_000)) };
    if (by.unit === 'day' || by.unit === 'week') base.setTime(base.getTime() + count * (by.unit === 'week' ? 7 : 1) * DAY_MS);
    else {
      const months = by.unit === 'year' ? count * 12 : count,
        day = base.getUTCDate();
      base.setUTCDate(1);
      base.setUTCMonth(base.getUTCMonth() + months);
      const last = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
      base.setUTCDate(Math.min(day, last));
    }
    return 'day' in at ? { day: dayOf(base) } : { instant: base };
  };
  const isDate = (v: ComputedValue): v is { day: string } | { instant: Date } => typeof v === 'object' && v !== null;
  const ms = (v: { day: string } | { instant: Date }) => ('day' in v ? Date.parse(`${v.day}T00:00:00Z`) : v.instant.getTime());
  const comparable = (v: ComputedValue) => (isDate(v) ? ms(v) : v);
  /* SQL's truth: yes, no, or unknown (null). */
  const truth = (v: ComputedValue): boolean | null => (v === null ? null : Boolean(v));
  const value = (n: ComputedNode): ComputedValue => {
    switch (n.k) {
      case 'number':
        return n.value;
      case 'text':
        return n.value;
      case 'bool':
        return n.value;
      case 'today':
        return { day: values.today };
      case 'date':
        return { day: n.value };
      case 'now':
        return { instant: values.now };
      case 'instant':
        return { instant: new Date(n.value) };
      case 'me':
        return values.me;
      case 'nobody':
        return null;
      case 'not': {
        const v = truth(value(n.of));
        return v === null ? null : !v;
      }
      case 'neg': {
        const v = value(n.of);
        return v === null ? null : -Number(v);
      }
      case 'empty': {
        const v = value(n.of);
        return (v === null || v === '') !== n.negate;
      }
      case 'span':
        return Number(value(n.of));
      case 'call': {
        const args = n.args.map(value);
        if (n.fn === 'coalesce') return args.find((each) => each !== null) ?? null;
        if (args.some((each) => each === null)) return null;
        if (n.fn === 'abs') return Math.abs(Number(args[0]));
        if (n.fn === 'round') return roundAway(Number(args[0]), args[1] === undefined ? 0 : Number(args[1]));
        let kept = args[0];
        for (const each of args.slice(1)) {
          const [a, b] = [comparable(each)!, comparable(kept)!];
          if (n.fn === 'min' ? a < b : a > b) kept = each;
        }
        return kept;
      }
      case 'path': {
        const v = read(n.path);
        return v === undefined || v === '' ? null : v;
      }
      case 'op': {
        if (n.op === 'and' || n.op === 'or') {
          const l = truth(value(n.left)),
            r = truth(value(n.right));
          if (n.op === 'and') return l === false || r === false ? false : l === null || r === null ? null : true;
          return l === true || r === true ? true : l === null || r === null ? null : false;
        }
        const l = value(n.left),
          r = value(n.right);
        if (COMPARISONS.has(n.op)) {
          if (l === null || r === null) return null;
          const a = comparable(l)!,
            b = comparable(r)!;
          switch (n.op) {
            case '=':
              return a === b;
            case '!=':
              return a !== b;
            case '<':
              return a < b;
            case '<=':
              return a <= b;
            case '>':
              return a > b;
            default:
              return a >= b;
          }
        }
        if (l === null || r === null) return null;
        if (n.op === '+' || n.op === '-') {
          const sign = n.op === '+' ? 1 : -1;
          if (isDate(l) && isDate(r) && n.op === '-') return Math.round((ms(l) - ms(r)) / DAY_MS);
          if (isDate(l) && !isDate(r)) return move(l, n.right.k === 'span' ? span(n.right) : { count: Number(r), unit: 'day' }, sign);
          if (isDate(r) && !isDate(l) && n.op === '+')
            return move(r, n.left.k === 'span' ? span(n.left) : { count: Number(l), unit: 'day' }, 1);
          return Number(l) + sign * Number(r);
        }
        if (n.op === '*') return Number(l) * Number(r);
        return Number(r) === 0 ? null : Number(l) / Number(r);
      }
    }
  };
  const result = value(node);
  return result === null && isCondition(node) ? false : result;
}

/**
 * A constant expression's value, worked out where a fixed action's `set`
 * writes it (appStamps on the server): `today + 14 days`, `now + 1 week`,
 * `3 * 7`. It reads no column, which loading the App made sure of; the
 * constants are this request's — the App's day, the instant, the
 * signed-in person.
 */
export function evaluateConstant(node: ComputedNode, values: { today: string; now: Date; me: string | null }): ComputedValue {
  return evaluateComputed(node, values);
}

/**
 * Two values compared as the statement compares them (`qty < reorder_at`, `paid < owed`): a number with a number,
 * a day with a day or an instant; a comparison with nothing is no. Where a guard reads both sides in one transaction
 * rather than writing the comparison into a single-table read, which never compares two columns (filter.ts).
 */
export function compares(op: string, left: ComputedValue, right: ComputedValue): boolean {
  if (!COMPARISONS.has(op)) return false;
  const node = { k: 'op', op, left: { k: 'path', path: 'l' }, right: { k: 'path', path: 'r' } } as ComputedNode;
  return evaluateComputed(node, { today: '', now: new Date(0), me: null }, (path) => (path === 'l' ? left : right)) === true;
}
