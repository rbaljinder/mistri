/**
 * An expression's words read into its tree (computed.ts): the tokenizer and the parser computed columns, a form's
 * live lines and the App's checks read with. A module of its own because nothing in computed.ts calls it, and a
 * browser's first page reaches computed.ts (a computed column's meta): what a part loaded on demand uses of a module
 * the first page reaches is drawn into the first page's chunk, so the parser lived there for a form's live lines.
 */
import { ComputedError, type ComputedFunction, type ComputedNode, type ComputedOp, type ComputedUnit } from './computed.js';

/** The functions an expression may call: each written alike on every engine and worked out alike in JavaScript. */
const COMPUTED_FUNCTIONS = ['coalesce', 'round', 'min', 'max', 'abs'] as const satisfies readonly ComputedFunction[];
const isFunction = (word: string): word is ComputedFunction => (COMPUTED_FUNCTIONS as readonly string[]).includes(word);
/* The greatest number of places `round` keeps: past it a figure is no longer one an engine says exactly. */
const ROUND_PLACES = 10;

const CONSTANTS = new Set(['today', 'now', 'me', 'true', 'false']);

type Token = { t: 'word' | 'number' | 'text' | 'op' | 'end'; v: string; at: number };

const UNITS: Record<string, ComputedUnit> = {
  minute: 'minute',
  minutes: 'minute',
  hour: 'hour',
  hours: 'hour',
  day: 'day',
  days: 'day',
  week: 'week',
  weeks: 'week',
  month: 'month',
  months: 'month',
  year: 'year',
  years: 'year',
};
const WORD = /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*/y;

function tokens(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/\d/.test(c)) {
      const m = /\d+(?:\.\d+)?/y;
      m.lastIndex = i;
      const n = m.exec(text)![0];
      out.push({ t: 'number', v: n, at: i });
      i += n.length;
      continue;
    }
    if (c === "'") {
      let j = i + 1,
        value = '';
      for (;;) {
        if (j >= text.length) throw new ComputedError('a quoted text is not closed.', i);
        if (text[j] === "'") {
          if (text[j + 1] === "'") {
            value += "'";
            j += 2;
            continue;
          }
          break;
        }
        value += text[j++];
      }
      /* Written into the statement between quotes, so held to what every engine reads alike there (recordLabel.ts). */
      if ([...value].some((ch) => ch === '\\' || ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) {
        throw new ComputedError('a quoted text holds a backslash or a control character, which engines read differently.', i);
      }
      out.push({ t: 'text', v: value, at: i });
      i = j + 1;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (['!=', '<>', '<=', '>='].includes(two)) {
      out.push({ t: 'op', v: two === '<>' ? '!=' : two, at: i });
      i += 2;
      continue;
    }
    if ('=<>+-*/(),'.includes(c)) {
      out.push({ t: 'op', v: c, at: i });
      i++;
      continue;
    }
    WORD.lastIndex = i;
    const w = WORD.exec(text);
    if (w) {
      out.push({ t: 'word', v: w[0], at: i });
      i += w[0].length;
      continue;
    }
    throw new ComputedError(`"${c}" is not part of an expression.`, i);
  }
  out.push({ t: 'end', v: '', at: text.length });
  return out;
}

/**
 * An expression's tree, or why it is not one. `isColumn` says which bare
 * words are names: a word on the right of `=` or `!=` that is not one is a
 * value, as it is in a query (`status = open`).
 */
export function parseComputed(text: string, isColumn: (path: string) => boolean): ComputedNode {
  const list = tokens(text);
  let p = 0;
  const peek = () => list[p];
  const word = (v: string) => peek().t === 'word' && peek().v.toLowerCase() === v;
  const take = () => list[p++];
  const expect = (v: string) => {
    if (peek().t !== 'op' || peek().v !== v)
      throw new ComputedError(`expected "${v}"${peek().t === 'end' ? ' before the end' : ` at "${peek().v}"`}.`, peek().at);
    take();
  };
  const or = (): ComputedNode => {
    let left = and();
    while (word('or')) {
      take();
      left = { k: 'op', op: 'or', left, right: and() };
    }
    return left;
  };
  const and = (): ComputedNode => {
    let left = not();
    while (word('and')) {
      take();
      left = { k: 'op', op: 'and', left, right: not() };
    }
    return left;
  };
  const not = (): ComputedNode => {
    if (word('not')) {
      take();
      return { k: 'not', of: not() };
    }
    return compare();
  };
  const compare = (): ComputedNode => {
    const left = additive();
    if (word('is')) {
      take();
      const negate = word('not');
      if (negate) take();
      if (!word('empty')) throw new ComputedError('say "is empty" or "is not empty".', peek().at);
      take();
      return { k: 'empty', of: left, negate };
    }
    /* `status in (open, waiting)`, `status not in (done)`: the query language's list, said as the equalities it
       means, joined by "or", so it types, compiles on every engine and works out in the browser as `=` does. */
    const negated = word('not') && list[p + 1].t === 'word' && list[p + 1].v.toLowerCase() === 'in';
    if (negated || word('in')) {
      if (negated) take();
      take();
      expect('(');
      const items: ComputedNode[] = [];
      for (;;) {
        const valueAt = peek();
        const next = list[p + 1];
        items.push(
          left.k === 'path' &&
            valueAt.t === 'word' &&
            !CONSTANTS.has(valueAt.v.toLowerCase()) &&
            !valueAt.v.includes('.') &&
            !isColumn(valueAt.v) &&
            next.t === 'op' &&
            (next.v === ',' || next.v === ')')
            ? (take(), { k: 'text', value: valueAt.v })
            : additive(),
        );
        if (peek().t === 'op' && peek().v === ',') {
          take();
          continue;
        }
        expect(')');
        break;
      }
      const any = items
        .map((right): ComputedNode => ({ k: 'op', op: '=', left, right }))
        .reduce((either, each): ComputedNode => ({ k: 'op', op: 'or', left: either, right: each }));
      return negated ? { k: 'not', of: any } : any;
    }
    const op = peek();
    if (op.t === 'op' && ['=', '!=', '<', '<=', '>', '>='].includes(op.v)) {
      take();
      const valueAt = peek();
      /* `status = open`: a bare word that names no column is the value, as in a query. */
      const right =
        (op.v === '=' || op.v === '!=') &&
        left.k === 'path' &&
        valueAt.t === 'word' &&
        !CONSTANTS.has(valueAt.v.toLowerCase()) &&
        !valueAt.v.includes('.') &&
        !isColumn(valueAt.v) &&
        (list[p + 1].t === 'end' || list[p + 1].t === 'word' || (list[p + 1].t === 'op' && list[p + 1].v === ')'))
          ? (take(), { k: 'text', value: valueAt.v } as ComputedNode)
          : additive();
      if (op.v === '=' && right.k === 'path' && /^null$/i.test(right.path))
        throw new ComputedError('"= null" is never true; say "is empty".', valueAt.at);
      return { k: 'op', op: op.v as ComputedOp, left, right };
    }
    return left;
  };
  const additive = (): ComputedNode => {
    let left = multiplicative();
    while (peek().t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = take().v as ComputedOp;
      left = { k: 'op', op, left, right: multiplicative() };
    }
    return left;
  };
  const multiplicative = (): ComputedNode => {
    let left = unary();
    while (peek().t === 'op' && (peek().v === '*' || peek().v === '/')) {
      const op = take().v as ComputedOp;
      left = { k: 'op', op, left, right: unary() };
    }
    return left;
  };
  const unary = (): ComputedNode => {
    if (peek().t === 'op' && peek().v === '-') {
      take();
      return { k: 'neg', of: unary() };
    }
    const value = primary();
    /* `3 days`, `term months`: a span a date moves by. */
    if (peek().t === 'word' && Object.hasOwn(UNITS, peek().v.toLowerCase()))
      return { k: 'span', of: value, unit: UNITS[take().v.toLowerCase()] };
    return value;
  };
  const primary = (): ComputedNode => {
    const token = take();
    if (token.t === 'number') return { k: 'number', value: Number(token.v) };
    if (token.t === 'text') return { k: 'text', value: token.v };
    if (token.t === 'op' && token.v === '(') {
      const inner = or();
      expect(')');
      return inner;
    }
    if (token.t === 'word') {
      const lower = token.v.toLowerCase();
      /* `round(total, 2)`: a function's name is a word followed by "(", which no column or value ever is. */
      if (peek().t === 'op' && peek().v === '(') {
        if (!isFunction(lower))
          throw new ComputedError(`"${token.v}" is not a function; an expression calls ${COMPUTED_FUNCTIONS.join(', ')}.`, token.at);
        take();
        const args: ComputedNode[] = [];
        if (!(peek().t === 'op' && peek().v === ')'))
          for (;;) {
            args.push(or());
            if (peek().t === 'op' && peek().v === ',') {
              take();
              continue;
            }
            break;
          }
        expect(')');
        const fn = lower;
        const many = fn === 'coalesce' || fn === 'min' || fn === 'max';
        if (many ? args.length < 2 : fn === 'round' ? args.length < 1 || args.length > 2 : args.length !== 1)
          throw new ComputedError(
            many
              ? `${fn}(…) takes two values or more: ${fn}(a, b).`
              : fn === 'round'
                ? 'round(…) takes a number and, if you like, how many places: round(total) or round(total, 2).'
                : `${fn}(…) takes one number.`,
            token.at,
          );
        if (fn === 'round' && args[1] && !(args[1].k === 'number' && Number.isInteger(args[1].value) && args[1].value <= ROUND_PLACES))
          throw new ComputedError(
            `round(…)'s places are a whole number from 0 to ${ROUND_PLACES}, written out: round(total, 2).`,
            token.at,
          );
        return { k: 'call', fn, args };
      }
      if (lower === 'true' || lower === 'false') return { k: 'bool', value: lower === 'true' };
      if (lower === 'today' || lower === 'now' || lower === 'me') return { k: lower };
      if (['and', 'or', 'not', 'is', 'empty', 'in'].includes(lower) || Object.hasOwn(UNITS, lower))
        throw new ComputedError(`"${token.v}" stands where a value goes.`, token.at);
      return { k: 'path', path: token.v };
    }
    throw new ComputedError(
      token.t === 'end' ? 'the expression ends where a value goes.' : `"${token.v}" stands where a value goes.`,
      token.at,
    );
  };
  const tree = or();
  if (peek().t !== 'end') throw new ComputedError(`"${peek().v}" follows a complete expression; join two with "and" or "or".`, peek().at);
  return tree;
}
