/**
 * A SQLite trigger read from its `CREATE TRIGGER` text in `sqlite_schema`:
 * the writes that fire it, whether it is validation-only, and what it does
 * where it does more (scopeTriggers.ts).
 *
 * SQLite keeps no parsed form of a trigger, only the statement as written, so
 * this reads that statement — and reads only a narrow grammar. A header it
 * cannot follow is taken to fire on every write; a body it cannot follow is
 * not validation-only and has no effects anyone can accept. Validation-only
 * means every statement of the body is
 *
 *     SELECT <expressions> [WHERE <expression>];
 *
 * with no FROM, and every expression (the trigger's WHEN too) is built from
 * NEW.<column>, OLD.<column>, literals, the operators, CASE, CAST, BETWEEN,
 * IN (a parenthesized list), LIKE and GLOB, a short list of SQLite's own pure
 * functions (no app-defined function is ever registered on the writer), and
 * `RAISE(ABORT, '<literal>')`. Not RAISE(ROLLBACK): it would end the
 * scoped transaction from inside it, and what the handler wrote next would
 * commit on its own. Not RAISE(FAIL): it keeps what the statement already
 * changed, past the checks a refused write never reaches. Not RAISE(IGNORE):
 * it skips the write silently. No subquery, no other table, no parameter.
 *
 * The tokens are SQLite's to the byte, because a word read differently is a
 * name read differently: `NEW.note IN TRUE` reads a table (or view) named
 * "true", since after IN a bare word is a table to SQLite, so IN takes only a
 * parenthesized list here. Whitespace is exactly SQLite's six characters, not
 * JavaScript's `\s`: U+00A0 is an identifier character to SQLite, so
 * `IN<U+00A0>` names a table called U+00A0. And a body holding any character
 * past ASCII outside a string literal is not proven at all.
 *
 * The keyed-effect grammar (docs/trigger-effects.md) adds, each the whole
 * statement or one term of a SELECT's expression:
 *
 *     UPDATE <table> SET <column> = <expression>, … WHERE <key> = NEW.<column> [AND …];
 *     INSERT INTO <table> (<column>, …) VALUES (<expression>, …);
 *     DELETE FROM <table> WHERE <key> = OLD.<column> [AND …];
 *     (SELECT <column> FROM <table> WHERE <key> = NEW.<column> [AND …])
 *
 * A SET's expressions may name the target row's own columns; an INSERT gives
 * one row; no OR clause, upsert, RETURNING, FROM or subquery inside a write.
 * The table is never qualified: SQLite refuses `main.` inside a trigger's
 * writes, and a TEMP table of the same name would shadow it. Whether `<key>`
 * covers a key of the table is the catalog's to judge (triggerEffects.ts).
 */
import { createHash } from 'node:crypto';
import {
  PLAIN,
  plainDefinition,
  type EffectRef,
  type EffectTerm,
  type ScopeTrigger,
  type TriggerEffect,
  type TriggerEvent,
} from './scopeTriggers.js';

type Token =
  | { kind: 'word'; text: string; upper: string }
  | { kind: 'id'; text: string }
  | { kind: 'string'; text: string }
  | { kind: 'literal'; text: string }
  | { kind: 'op'; text: string };

const EVERY: readonly TriggerEvent[] = ['insert', 'update', 'delete'];

/** SQLite's own functions that read only their arguments and change nothing. */
const PURE = new Set([
  'ABS',
  'COALESCE',
  'IFNULL',
  'IIF',
  'NULLIF',
  'LENGTH',
  'LOWER',
  'UPPER',
  'TRIM',
  'LTRIM',
  'RTRIM',
  'SUBSTR',
  'SUBSTRING',
  'INSTR',
  'REPLACE',
  'TYPEOF',
  'ROUND',
  'SIGN',
  'MIN',
  'MAX',
  'DATE',
  'TIME',
  'DATETIME',
  'JULIANDAY',
  'UNIXEPOCH',
  'STRFTIME',
]);
const COLLATIONS = new Set(['BINARY', 'NOCASE', 'RTRIM']);
const OPERATORS = new Set(['||', '*', '/', '%', '+', '-', '<<', '>>', '&', '|', '<', '<=', '>', '>=', '=', '==', '!=', '<>', '~']);
/** Keywords an expression may hold; the rest of the vocabulary is handled where it appears. */
const EXPRESSION_WORDS = new Set([
  'NULL',
  'TRUE',
  'FALSE',
  'CURRENT_DATE',
  'CURRENT_TIME',
  'CURRENT_TIMESTAMP',
  'AND',
  'OR',
  'NOT',
  'IS',
  'IN',
  'LIKE',
  'GLOB',
  'ESCAPE',
  'BETWEEN',
  'ISNULL',
  'NOTNULL',
  'WHEN',
  'THEN',
  'ELSE',
]);
const WRITES = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'UPSERT']);

class Unreadable extends Error {}
const fail = (): never => {
  throw new Unreadable();
};

const identifierStart = (char: string) => /[A-Za-z_]/.test(char) || char.charCodeAt(0) >= 0x80;
const identifierPart = (char: string) => /[A-Za-z0-9_$]/.test(char) || char.charCodeAt(0) >= 0x80;
/* SQLite's whitespace (sqlite3Isspace): tab, newline, vertical tab, form feed, carriage return and space. Nothing else
   — every byte from 0x80 up is an identifier character to its tokenizer. */
const whitespace = (char: string) => char === ' ' || (char >= '\t' && char <= '\r');
/** A name past ASCII: SQLite's reading of it is not one this proof repeats, so a body holding one is not proven. */
const wide = (text: string) => /[\u0080-\u{10FFFF}]/u.test(text);

/** SQLite's tokens, as its tokenizer reads them; anything it would read otherwise (a parameter, a stray byte) refuses. */
function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const quoted = (close: string, doubled: boolean): string => {
    let text = '';
    i += 1;
    for (;;) {
      if (i >= sql.length) return fail();
      const char = sql[i];
      if (char === close) {
        if (doubled && sql[i + 1] === close) {
          text += close;
          i += 2;
          continue;
        }
        i += 1;
        return text;
      }
      text += char;
      i += 1;
    }
  };
  while (i < sql.length) {
    const char = sql[i];
    if (whitespace(char)) {
      i += 1;
    } else if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end + 1;
    } else if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      // SQLite ends an unterminated comment at the end of input; a trigger's text never has one, so it refuses.
      if (end === -1) return fail();
      i = end + 2;
    } else if (char === "'") {
      tokens.push({ kind: 'string', text: quoted("'", true) });
    } else if ((char === 'x' || char === 'X') && sql[i + 1] === "'") {
      i += 1;
      tokens.push({ kind: 'literal', text: `X'${quoted("'", false)}'` });
    } else if (char === '"') {
      tokens.push({ kind: 'id', text: quoted('"', true) });
    } else if (char === '`') {
      tokens.push({ kind: 'id', text: quoted('`', true) });
    } else if (char === '[') {
      tokens.push({ kind: 'id', text: quoted(']', false) });
    } else if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      const match = /^(?:0[xX][0-9A-Fa-f_]+|(?:[0-9][0-9_]*(?:\.[0-9_]*)?|\.[0-9][0-9_]*)(?:[eE][+-]?[0-9_]+)?)/.exec(sql.slice(i));
      if (!match) return fail();
      i += match[0].length;
      // `12abc` is one bad token to SQLite, not a number beside a word.
      if (i < sql.length && identifierPart(sql[i])) return fail();
      tokens.push({ kind: 'literal', text: match[0] });
    } else if (identifierStart(char)) {
      let end = i + 1;
      while (end < sql.length && identifierPart(sql[end])) end += 1;
      const text = sql.slice(i, end);
      tokens.push({ kind: 'word', text, upper: text.toUpperCase() });
      i = end;
    } else {
      const op = ['->>', '||', '<=', '>=', '==', '!=', '<>', '<<', '>>', '->'].find((candidate) => sql.startsWith(candidate, i)) ?? char;
      if (!'()[],;.+-*/%<>=&|~'.includes(op[0])) return fail();
      tokens.push({ kind: 'op', text: op });
      i += op.length;
    }
  }
  return tokens;
}

class Cursor {
  at = 0;
  constructor(readonly tokens: readonly Token[]) {}
  peek(offset = 0): Token | undefined {
    return this.tokens[this.at + offset];
  }
  word(offset = 0): string | undefined {
    const token = this.peek(offset);
    return token?.kind === 'word' ? token.upper : undefined;
  }
  op(offset = 0): string | undefined {
    const token = this.peek(offset);
    return token?.kind === 'op' ? token.text : undefined;
  }
  take(): Token {
    return this.tokens[this.at++] ?? fail();
  }
  expectWord(word: string): void {
    if (this.word() !== word) fail();
    this.at += 1;
  }
  expectOp(op: string): void {
    if (this.op() !== op) fail();
    this.at += 1;
  }
  /** A name: a bare word or a quoted identifier. */
  name(): string {
    const token = this.take();
    if (token.kind === 'word' || token.kind === 'id') return token.text;
    return fail();
  }
  /** `name` or `schema.name`. */
  qualified(): string {
    const first = this.name();
    if (this.op() !== '.') return first;
    this.at += 1;
    return this.name();
  }
}

/** Words that are SQL's own, never a column of the row a write's expression names bare. */
const NOT_COLUMNS = new Set([
  'SELECT',
  'FROM',
  'EXISTS',
  'JOIN',
  'WITH',
  ...WRITES,
  'WHERE',
  'SET',
  'VALUES',
  'INTO',
  'ORDER',
  'GROUP',
  'HAVING',
  'LIMIT',
  'UNION',
  'DEFAULT',
  'ON',
  'USING',
  'OVER',
  'FILTER',
  'RETURNING',
  'NEW',
  'OLD',
  'RAISE',
  'CASE',
  'END',
  'CAST',
  'AS',
  'COLLATE',
  'DISTINCT',
]);

interface ExpressionOptions {
  /** A SELECT statement's own WHERE, once. */
  readonly where?: boolean;
  /** Keyed reads are allowed, and land here. */
  readonly effects?: TriggerEffect[];
  /** Bare names are the written row's own columns, and land here. */
  readonly own?: Set<string>;
}

/**
 * One expression of the grammar, from the cursor to the first token `stop`
 * accepts outside every parenthesis and CASE. Throws where the expression
 * leaves the grammar.
 */
function expression(cursor: Cursor, stop: (cursor: Cursor) => boolean, options: ExpressionOptions = {}): void {
  // What each open parenthesis is: a CAST's, which may hold `AS <type>`, or any other.
  const parens: Array<'cast' | 'plain'> = [];
  let cases = 0;
  let sawWhere = false;
  let any = false;
  for (;;) {
    if (cursor.peek() === undefined) fail();
    if (!parens.length && !cases && any && stop(cursor)) return;
    any = true;
    const token = cursor.take();
    if (token.kind === 'string' || token.kind === 'literal') continue;
    if (token.kind === 'id') fail();
    if (token.kind === 'op') {
      if (token.text === '(') {
        // A keyed read: one column of one row another table holds, found by NEW's or OLD's columns.
        if (options.effects && cursor.word() === 'SELECT') options.effects.push(keyedRead(cursor));
        else parens.push('plain');
      } else if (token.text === ')') {
        if (!parens.pop()) fail();
      } else if (token.text === ',') continue;
      else if (!OPERATORS.has(token.text)) fail();
      continue;
    }
    // A quoted name here is a column of no row, or a string SQLite falls back to: not proven.
    const word = token.kind === 'word' ? token.upper : fail();
    if (word === 'NEW' || word === 'OLD') {
      cursor.expectOp('.');
      cursor.name();
    } else if (word === 'IN') {
      // After IN a bare word is a table to SQLite (`NEW.note IN TRUE` reads one named "true"): only a list is proven.
      if (cursor.op() !== '(') fail();
    } else if (word === 'CASE') {
      cases += 1;
    } else if (word === 'END') {
      if (!cases) fail();
      cases -= 1;
    } else if (word === 'DISTINCT') {
      // Only `IS [NOT] DISTINCT FROM`.
      const before = cursor.tokens[cursor.at - 2];
      const twoBefore = cursor.tokens[cursor.at - 3];
      const isBefore =
        (before?.kind === 'word' && before.upper === 'IS') ||
        (before?.kind === 'word' && before.upper === 'NOT' && twoBefore?.kind === 'word' && twoBefore.upper === 'IS');
      if (!isBefore) fail();
      cursor.expectWord('FROM');
    } else if (word === 'CAST') {
      cursor.expectOp('(');
      parens.push('cast');
    } else if (word === 'AS') {
      if (parens.at(-1) !== 'cast') fail();
      // A type name: words, and at most one `(n)` or `(n, m)`.
      if (cursor.peek()?.kind !== 'word') fail();
      while (cursor.peek()?.kind === 'word') cursor.at += 1;
      if (cursor.op() === '(') {
        cursor.at += 1;
        if (cursor.op() === '+' || cursor.op() === '-') cursor.at += 1;
        if (cursor.take().kind !== 'literal') fail();
        if (cursor.op() === ',') {
          cursor.at += 1;
          if (cursor.op() === '+' || cursor.op() === '-') cursor.at += 1;
          if (cursor.take().kind !== 'literal') fail();
        }
        cursor.expectOp(')');
      }
      if (cursor.op() !== ')') fail();
    } else if (word === 'COLLATE') {
      if (!COLLATIONS.has(cursor.name().toUpperCase())) fail();
    } else if (word === 'RAISE') {
      // Only RAISE(ABORT, '<literal>'): see the module comment for the other three.
      cursor.expectOp('(');
      cursor.expectWord('ABORT');
      cursor.expectOp(',');
      if (cursor.take().kind !== 'string') fail();
      cursor.expectOp(')');
    } else if (EXPRESSION_WORDS.has(word)) {
      continue;
    } else if (word === 'WHERE' && options.where && !parens.length && !cases && !sawWhere) {
      sawWhere = true;
    } else if (cursor.op() === '(' && PURE.has(word)) {
      cursor.at += 1;
      parens.push('plain');
    } else if (options.own && !NOT_COLUMNS.has(word) && cursor.op() !== '(' && cursor.op() !== '.' && cursor.peek()?.kind !== 'id') {
      // The written row's own column, bare: `posted_minor + NEW.amount`. Which columns the table has is the catalog's.
      options.own.add(token.text);
    } else {
      fail();
    }
  }
}

/** Words a body may put before a parenthesis that are not a call of a function. */
const SYNTAX = new Set([
  ...EXPRESSION_WORDS,
  'SELECT',
  'WHERE',
  'CASE',
  'END',
  'CAST',
  'RAISE',
  'EXISTS',
  'DISTINCT',
  'ALL',
  'AS',
  'VALUES',
  'SET',
]);

/** `<column> = NEW.<column>` (or the other way round, or `==`), joined by AND: the row a keyed effect reaches. */
function keyEqualities(cursor: Cursor, table: string, end: (cursor: Cursor) => boolean): Record<string, EffectRef> {
  const key: Record<string, EffectRef> = {};
  const side = (): string | EffectRef => {
    const word = cursor.word();
    if (word === 'NEW' || word === 'OLD') {
      cursor.at += 1;
      cursor.expectOp('.');
      return { row: word === 'NEW' ? 'new' : 'old', column: cursor.name() };
    }
    const first = cursor.name();
    if (cursor.op() !== '.') return first;
    // `account.id`: the target itself, never another table.
    if (first.toLowerCase() !== table.toLowerCase()) fail();
    cursor.at += 1;
    return cursor.name();
  };
  for (;;) {
    const left = side();
    if (cursor.op() !== '=' && cursor.op() !== '==') fail();
    cursor.at += 1;
    const right = side();
    const column = typeof left === 'string' ? left : typeof right === 'string' ? right : fail();
    const ref = typeof left === 'string' ? right : left;
    if (typeof ref === 'string' || Object.keys(key).some((known) => known.toLowerCase() === column.toLowerCase())) fail();
    key[column] = ref as EffectRef;
    if (end(cursor)) return key;
    cursor.expectWord('AND');
  }
}

/** A table a keyed effect names: bare, since a qualified one inside a trigger is SQLite's error or TEMP's shadow. */
function effectTable(cursor: Cursor): string {
  const table = cursor.name();
  if (cursor.op() === '.') fail();
  return table;
}

/** `SELECT <column> FROM <table> WHERE <key> = NEW.<column> …)`, its opening parenthesis already taken. */
function keyedRead(cursor: Cursor): TriggerEffect {
  cursor.expectWord('SELECT');
  const column = cursor.name();
  let qualifier: string | undefined;
  let read = column;
  if (cursor.op() === '.') {
    cursor.at += 1;
    qualifier = column;
    read = cursor.name();
  }
  cursor.expectWord('FROM');
  const table = effectTable(cursor);
  if (qualifier !== undefined && qualifier.toLowerCase() !== table.toLowerCase()) fail();
  cursor.expectWord('WHERE');
  const key = keyEqualities(cursor, table, (at) => at.op() === ')');
  cursor.expectOp(')');
  return { kind: 'read', table, key, values: { [read]: { literal: null } } };
}

/** What an expression's tokens are known to be before the trigger runs: a column of NEW or OLD, a literal, or neither. */
function term(tokens: readonly Token[]): EffectTerm {
  const [first, second, third] = tokens;
  if (tokens.length === 3 && first.kind === 'word' && (first.upper === 'NEW' || first.upper === 'OLD') && second.kind === 'op')
    return { row: first.upper === 'NEW' ? 'new' : 'old', column: (third as { text: string }).text };
  if (tokens.length === 1 && first.kind === 'string') return { literal: first.text };
  if (tokens.length === 1 && first.kind === 'word' && first.upper === 'NULL') return { literal: null };
  if (tokens.length === 1 && first.kind === 'literal' && /^[0-9]+$/.test(first.text) && Number.isSafeInteger(Number(first.text)))
    return { literal: Number(first.text) };
  return { expression: true };
}

/** `UPDATE <table> SET <column> = <expression>, … WHERE <key>;`, from UPDATE. */
function keyedUpdate(cursor: Cursor): TriggerEffect {
  cursor.expectWord('UPDATE');
  const table = effectTable(cursor);
  cursor.expectWord('SET');
  const values: Record<string, EffectTerm> = {};
  const own = new Set<string>();
  for (;;) {
    const column = cursor.name();
    if (Object.keys(values).some((set) => set.toLowerCase() === column.toLowerCase())) fail();
    cursor.expectOp('=');
    const start = cursor.at;
    expression(cursor, (at) => at.op() === ',' || at.word() === 'WHERE', { own });
    values[column] = term(cursor.tokens.slice(start, cursor.at));
    if (cursor.op() !== ',') break;
    cursor.at += 1;
  }
  cursor.expectWord('WHERE');
  const key = keyEqualities(cursor, table, (at) => at.op() === ';');
  // The bare columns it reads are the target row's own, which the proof finds in scope before the write.
  return { kind: 'update', table, key, values };
}

/** `INSERT INTO <table> (<column>, …) VALUES (<expression>, …);`, from INSERT. */
function keyedInsert(cursor: Cursor): TriggerEffect {
  cursor.expectWord('INSERT');
  cursor.expectWord('INTO');
  const table = effectTable(cursor);
  cursor.expectOp('(');
  const columns: string[] = [cursor.name()];
  while (cursor.op() === ',') {
    cursor.at += 1;
    columns.push(cursor.name());
  }
  cursor.expectOp(')');
  if (new Set(columns.map((column) => column.toLowerCase())).size !== columns.length) fail();
  cursor.expectWord('VALUES');
  cursor.expectOp('(');
  const values: Record<string, EffectTerm> = {};
  for (const [index, column] of columns.entries()) {
    if (index) cursor.expectOp(',');
    const start = cursor.at;
    expression(cursor, (at) => at.op() === ',' || at.op() === ')');
    values[column] = term(cursor.tokens.slice(start, cursor.at));
  }
  cursor.expectOp(')');
  // One row, and nothing after it: no second row, upsert or RETURNING.
  if (cursor.op() !== ';') fail();
  return { kind: 'insert', table, values };
}

/** `DELETE FROM <table> WHERE <key>;`, from DELETE. */
function keyedDelete(cursor: Cursor): TriggerEffect {
  cursor.expectWord('DELETE');
  cursor.expectWord('FROM');
  const table = effectTable(cursor);
  cursor.expectWord('WHERE');
  return { kind: 'delete', table, key: keyEqualities(cursor, table, (at) => at.op() === ';') };
}

/**
 * Why a body that is not validation-only is not, from the tokens it holds outside its literals: said as exactly as
 * they allow, since the owner reads it to know what to change. A subquery is not said to read a table it may not
 * read, and a call of a function SQLite does not count as pure is named as one.
 */
function why(tokens: readonly Token[]): string {
  const isOp = (token: Token | undefined, text: string) => token?.kind === 'op' && token.text === text;
  const isWord = (token: Token | undefined, upper: string) => token?.kind === 'word' && token.upper === upper;
  // A column named after NEW or OLD is a column, whatever it is called (`NEW.select`).
  const words = tokens.flatMap((token, index) =>
    token.kind === 'word' && !isOp(tokens[index - 1], '.') ? [{ upper: token.upper, text: token.text, index }] : [],
  );
  const called = (word: { index: number }) => isOp(tokens[word.index + 1], '(');
  // `replace(…)` is SQLite's string function, not REPLACE INTO.
  if (words.some((word) => WRITES.has(word.upper) && !(PURE.has(word.upper) && called(word)))) return 'it writes rows';
  // FROM, but not IS [NOT] DISTINCT FROM; after IN, a name rather than a list is a table SQLite reads.
  const from = words.some((word) => word.upper === 'FROM' && !isWord(tokens[word.index - 1], 'DISTINCT'));
  const inTable = words.some((word) => word.upper === 'IN' && !called(word));
  if (from || inTable || words.some((word) => word.upper === 'JOIN' || word.upper === 'WITH')) return 'it reads another table';
  if (words.some((word) => word.upper === 'EXISTS' || (word.upper === 'SELECT' && isOp(tokens[word.index - 1], '('))))
    return 'it has a subquery, which can read another table';
  const unknown = words.find((word) => called(word) && !PURE.has(word.upper) && !SYNTAX.has(word.upper));
  if (unknown) return `it calls ${unknown.text}(), which is not one of SQLite's own pure functions`;
  const literal = (word: { index: number }) => {
    const [open, kind, comma, message, close] = tokens.slice(word.index + 1, word.index + 6);
    return isOp(open, '(') && isWord(kind, 'ABORT') && isOp(comma, ',') && message?.kind === 'string' && isOp(close, ')');
  };
  if (words.some((word) => word.upper === 'RAISE' && !literal(word))) return "its RAISE is not RAISE(ABORT, '…') with a literal message";
  return 'it does more than check the row it fires on';
}

/** The definition as tokens, one space apart: comments, spacing and keyword case never move the digest. */
function digestOf(tokens: readonly Token[]): string {
  const normalized = tokens
    .map((token) =>
      token.kind === 'word'
        ? token.upper
        : token.kind === 'string'
          ? `'${token.text.replace(/'/g, "''")}'`
          : token.kind === 'id'
            ? `"${token.text.replace(/"/g, '""')}"`
            : token.text,
    )
    .join(' ');
  return `sha256:${createHash('sha256').update(`sqlite\n${normalized}`).digest('hex')}`;
}

/**
 * The trigger `name`, from its `CREATE TRIGGER` text. `generated` holds the
 * table's generated columns, folded: an `UPDATE OF` naming one is taken to
 * fire on every update, rather than trusting when the engine recomputes it.
 */
export function readSqliteTrigger(name: string, sql: unknown, generated: ReadonlySet<string>): ScopeTrigger {
  const unknown: ScopeTrigger = { name, events: EVERY, validates: false, why: 'its definition is not one mistri can read' };
  if (typeof sql !== 'string') return unknown;
  let tokens: Token[];
  try {
    tokens = tokenize(sql);
  } catch {
    return unknown;
  }
  const digest = digestOf(tokens);
  const cursor = new Cursor(tokens);
  let events: TriggerEvent[];
  let columns: string[] | undefined;
  let bodyStart: number;
  try {
    cursor.expectWord('CREATE');
    if (cursor.word() === 'TEMP' || cursor.word() === 'TEMPORARY') cursor.at += 1;
    cursor.expectWord('TRIGGER');
    if (cursor.word() === 'IF') {
      cursor.at += 1;
      cursor.expectWord('NOT');
      cursor.expectWord('EXISTS');
    }
    cursor.qualified();
    if (cursor.word() === 'BEFORE' || cursor.word() === 'AFTER') cursor.at += 1;
    else if (cursor.word() === 'INSTEAD') {
      cursor.at += 1;
      cursor.expectWord('OF');
    }
    const event = cursor.word();
    cursor.at += 1;
    if (event === 'INSERT') events = ['insert'];
    else if (event === 'DELETE') events = ['delete'];
    else if (event === 'UPDATE') {
      events = ['update'];
      if (cursor.word() === 'OF') {
        cursor.at += 1;
        columns = [cursor.name()];
        while (cursor.op() === ',') {
          cursor.at += 1;
          columns.push(cursor.name());
        }
        const fold = (column: string) => column.replace(/[A-Z]/g, (char) => char.toLowerCase());
        if (columns.some((column) => generated.has(fold(column)))) columns = undefined;
      }
    } else return { ...unknown, digest };
    cursor.expectWord('ON');
    cursor.qualified();
    bodyStart = cursor.at;
  } catch {
    return { ...unknown, digest };
  }
  const fired = { name, events, ...(columns ? { columns } : {}), digest };
  try {
    if (tokens.slice(bodyStart).some((token) => (token.kind === 'word' || token.kind === 'id') && wide(token.text))) fail();
    if (cursor.word() === 'FOR') {
      cursor.at += 1;
      cursor.expectWord('EACH');
      cursor.expectWord('ROW');
    }
    if (cursor.word() === 'WHEN') {
      cursor.at += 1;
      expression(cursor, (at) => at.word() === 'BEGIN');
    }
    cursor.expectWord('BEGIN');
    const effects: TriggerEffect[] = [];
    let statements = 0;
    while (cursor.word() !== 'END') {
      const word = cursor.word();
      if (word === 'SELECT') {
        cursor.at += 1;
        if (cursor.word() === 'DISTINCT' || cursor.word() === 'ALL') cursor.at += 1;
        expression(cursor, (at) => at.op() === ';', { where: true, effects });
      } else if (word === 'UPDATE') effects.push(keyedUpdate(cursor));
      else if (word === 'INSERT') effects.push(keyedInsert(cursor));
      else if (word === 'DELETE') effects.push(keyedDelete(cursor));
      else fail();
      cursor.expectOp(';');
      statements += 1;
    }
    cursor.expectWord('END');
    if (cursor.op() === ';') cursor.at += 1;
    if (cursor.peek() !== undefined || !statements) fail();
    if (!effects.length) return { ...fired, validates: true };
    return {
      ...fired,
      validates: false,
      why: why(tokens.slice(bodyStart)),
      effects,
      ...(plainDefinition(sql, tokens, 'sqlite') ? {} : { unaccepted: PLAIN }),
    };
  } catch {
    return { ...fired, validates: false, why: why(tokens.slice(bodyStart)) };
  }
}

/** Words that open a table constraint, never a column definition (a column so named must be quoted). */
const TABLE_CONSTRAINTS = new Set(['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN']);

/**
 * Each column's collation, by its name folded, as a table's `CREATE TABLE` text declares it: a `COLLATE` among the
 * column's own constraints (outside any parenthesis), or BINARY. SQLite keeps no other record of it (no PRAGMA says
 * a column's collation), and a trigger's `NEW.code = code` compares under the left column's. Undefined where the
 * text is not one this reads; a column it cannot read is missing, and either way a key over it is refused.
 */
export function sqliteColumnCollations(sql: string): Map<string, string> | undefined {
  try {
    const tokens = tokenize(sql);
    let at = tokens.findIndex((token) => token.kind === 'op' && token.text === '(');
    if (at < 0 || tokens[0]?.kind !== 'word' || tokens[0].upper !== 'CREATE') return undefined;
    at += 1;
    const items: Token[][] = [[]];
    for (let depth = 0; ; at += 1) {
      const token = tokens[at] ?? fail();
      if (token.kind === 'op' && token.text === '(') depth += 1;
      else if (token.kind === 'op' && token.text === ')') {
        if (depth === 0) break;
        depth -= 1;
      } else if (depth === 0 && token.kind === 'op' && token.text === ',') {
        items.push([]);
        continue;
      }
      items.at(-1)!.push(token);
    }
    const collations = new Map<string, string>();
    for (const item of items) {
      const [first] = item;
      if (!first || (first.kind === 'word' && TABLE_CONSTRAINTS.has(first.upper))) continue;
      if (first.kind !== 'word' && first.kind !== 'id' && first.kind !== 'string') return undefined;
      const name = first.text.replace(/[A-Z]/g, (char) => char.toLowerCase());
      const said: string[] = [];
      for (let i = 1, depth = 0; i < item.length; i += 1) {
        const token = item[i];
        if (token.kind === 'op' && token.text === '(') depth += 1;
        else if (token.kind === 'op' && token.text === ')') depth -= 1;
        else if (depth === 0 && token.kind === 'word' && token.upper === 'COLLATE') {
          const collation = item[i + 1];
          if (!collation || (collation.kind !== 'word' && collation.kind !== 'id' && collation.kind !== 'string')) return undefined;
          said.push(collation.text.toUpperCase());
        }
      }
      // Two COLLATE clauses on one column: which one SQLite keeps is not this reader's to guess.
      if (collations.has(name) || said.length > 1) collations.delete(name);
      else collations.set(name, said[0] ?? 'BINARY');
    }
    return collations;
  } catch {
    return undefined;
  }
}

/**
 * The conflict clauses a table's `CREATE TABLE` text declares (`PRIMARY KEY ON CONFLICT REPLACE`, `NOT NULL ON
 * CONFLICT IGNORE`), each as `ON CONFLICT <resolution>`, upper-cased, in order. SQLite keeps no other record of them.
 * Undefined where the text is not one this reads.
 */
export function sqliteConflictClauses(sql: string): string[] | undefined {
  try {
    const tokens = tokenize(sql);
    if (tokens[0]?.kind !== 'word' || tokens[0].upper !== 'CREATE') return undefined;
    const clauses: string[] = [];
    for (const [at, token] of tokens.entries()) {
      if (token.kind !== 'word' || token.upper !== 'CONFLICT') continue;
      const before = tokens[at - 1];
      const resolution = tokens[at + 1];
      // `conflict` as a column's or a constraint's name is a word too: only `ON CONFLICT <word>` is the clause.
      if (before?.kind !== 'word' || before.upper !== 'ON') continue;
      if (resolution?.kind !== 'word') return undefined;
      clauses.push(`ON CONFLICT ${resolution.upper}`);
    }
    return clauses;
  } catch {
    return undefined;
  }
}
