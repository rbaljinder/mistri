/**
 * A small query language for browsing.
 *
 *   customers country = "Australia" and credit_limit > 1000
 *   invoices where total >= 50 sort invoice_date desc limit 20
 *   employees title contains manager show first_name, last_name, email
 *   orders order_date = last 30 days
 *
 * The table comes first, because that is how people say it out loud. Every
 * other clause is optional, and `where` / `order by` are accepted as aliases
 * for `filter` / `sort` so SQL habits do not have to be unlearned.
 *
 * Why a language at all, when the thing underneath is SQL?
 *
 * Because this one compiles to a `Filter` — a structure — and never to SQL
 * text. The adapter turns that structure into a parameterised statement, so
 * there is no path from what a user types to what the database parses as
 * syntax. A tool that let people type SQL directly would have to either trust
 * them or write a SQL parser to untrust them; this sidesteps both by making
 * the dangerous shape unrepresentable.
 *
 * Two things fall out of it for free. Because the compiler holds the schema,
 * a mistyped column is an error at the caret instead of a database exception
 * — and, worse, a mistyped *value* on a real column can be caught too. And
 * because the compiled statement is shown next to the query, the language
 * teaches SQL rather than hiding it.
 */
import type { Condition, Filter, Op } from './filter.js';
import { MAX_LIMIT } from './reads.js';
import { LIKE_ESCAPE, likePattern } from './like.js';
import { distance, nearest } from './suggest.js';
import { columnKind, findTable, type ColumnMeta, type DatabaseSchema, type MachineStates, type TableMeta } from './schema.js';
import { dateWindow } from './queryDates.js';
import { maskQuoted } from './maskQuoted.js';
import { ME_SET, columnOperand, meOperand, meSetOperand, type CompileContext, type QueryPerson } from './queryOperands.js';
import { TAGS_TYPE } from './tagLists.js';
import { DEFINED_PATH_TYPE } from './definedFields.js';

const RANGE_OPS: ReadonlySet<string> = new Set(['<', '<=', '>', '>=']);
export { dateWindow } from './queryDates.js';

interface ParsedQuery {
  table: string;
  filter: Filter;
  /** Explicit column list from `show`, empty for all columns. */
  columns: string[];
  orderBy: { column: string; direction: 'asc' | 'desc' }[];
  limit?: number;
}

export interface QueryError {
  message: string;
  /** Character offset into the input, when it can be located. */
  at?: number;
}

/**
 * A query's problem as an App's author reads it: the message, then where in
 * the query it stands. The query bar underlines the word; a query written in
 * an App's source is read in a terminal, where "character 23" and the words
 * from there are what find it. `text` is what the positions count in, and the
 * author's own words start at `from` (after a table name the caller added).
 */
export function saidAt(error: QueryError, text: string, from = 0): string {
  const own = text.slice(from);
  const at = error.at === undefined ? -1 : error.at - from;
  if (at < 0 || at >= own.length) return error.message;
  const rest = own.slice(at).trimStart();
  const start = own.length - rest.length;
  return `${error.message} (at character ${start + 1}: "${rest.length > 32 ? `${rest.slice(0, 32)}…` : rest}")`;
}

interface ParseResult {
  query?: ParsedQuery;
  errors: QueryError[];
}

/**
 * What can appear in a field position.
 *
 * `\w`, plus `.` for reference paths, `$` because some dialects allow it in
 * identifiers, and `+` for the composite-hop syntax a view uses:
 * `invoice_id+line_no.sku` follows a two-column foreign key. Without `+`
 * those hops were addressable only by their constraint name, which is a
 * database artefact nobody wants to type.
 *
 * `+` is safe to admit because the language has no arithmetic — there is
 * nothing it could otherwise have meant — and it cannot appear in a real
 * column name, so it can never be ambiguous with one.
 */
const FIELD = String.raw`[\w.$+]+`;

/** Operator words users type, mapped to the filter's operators. */
const OPERATORS: Record<string, Op> = {
  '=': '=',
  '!=': '!=',
  '<': '<',
  '<=': '<=',
  '>': '>',
  '>=': '>=',
  contains: 'contains',
  startswith: 'startsWith',
  endswith: 'endsWith',
  like: 'like',
  in: 'in',
  has: 'has',
};

/* Re-exported: the classifier moved to schema.ts to keep adapters from
   importing this module, but callers here have always got it from here. */
export { columnKind, type ColumnKind } from './schema.js';

/* ---------- expression parsing: and / or / parentheses ---------- */

type Node = { kind: 'cond'; text: string; at: number } | { kind: 'and'; children: Node[] } | { kind: 'or'; children: Node[] };

/**
 * Split on a keyword at depth zero, honouring quotes and parentheses so that
 * `a and (b or c)` and `name = "Smith and Sons"` both survive intact.
 */
/** Whether `word` sits at `i` as a whole word rather than inside a longer one. */
function isWord(text: string, i: number, word: string): boolean {
  const before = text[i - 1];
  const after = text[i + word.length];
  return (before === undefined || /[\s(]/.test(before)) && (after === undefined || /[\s(]/.test(after));
}

/* The same few conditions are split on every request that carries them (a view's filter, a saved query);
   the answer is a pure function of its arguments, so a bounded recency map keeps it. The parts are only
   read by the callers, and frozen so that stays true. */
const splits = new Map<string, ReadonlyArray<{ text: string; at: number }>>();
const MAX_SPLITS = 512;

function splitTopLevel(text: string, keyword: 'and' | 'or', offset: number): Array<{ text: string; at: number }> {
  if (text.length > 2000) return splitTopLevelFresh(text, keyword, offset);
  const key = `${keyword}\u0000${offset}\u0000${text}`;
  const hit = splits.get(key);
  if (hit) {
    splits.delete(key);
    splits.set(key, hit);
    return hit as Array<{ text: string; at: number }>;
  }
  const parts = splitTopLevelFresh(text, keyword, offset);
  for (const part of parts) Object.freeze(part);
  Object.freeze(parts);
  splits.set(key, parts);
  if (splits.size > MAX_SPLITS) splits.delete(splits.keys().next().value!);
  return parts;
}

function splitTopLevelFresh(text: string, keyword: 'and' | 'or', offset: number): Array<{ text: string; at: number }> {
  const parts: Array<{ text: string; at: number }> = [];
  let current = '';
  let start = 0;
  let quote: string | null = null;
  let depth = 0;
  /** Set when a `between` is open and its `and` has not been seen yet. */
  let pendingBetween = false;
  const lower = text.toLowerCase();

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      /* An escaped character cannot end the quote — the same rule
         `maskQuoted` applies below, and the reason this loop needed it:
         without it `name = "a \\" and b"` closed its quote at the escaped
         one, found a top-level `and` inside the value, and split a single
         condition in half. Two quote scanners in one file disagreeing about
         whether the grammar has escapes. */
      if (ch === '\\' && i + 1 < text.length) {
        current += ch + text[i + 1];
        i += 1;
        continue;
      }
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);

    /* `between 10 and 20` contains an `and` that joins a range rather than two
       conditions. Splitting there cut one condition in half and left `20` as
       a condition of its own, which parsed as nothing and reported an error
       about `20` — so the word had to be tracked rather than the grammar
       reworded. The first top-level `and` after a `between` belongs to it. */
    if (keyword === 'and' && lower.startsWith('between', i) && isWord(text, i, 'between')) {
      pendingBetween = true;
    }

    const atBoundary =
      depth === 0 &&
      lower.startsWith(keyword, i) &&
      (i === 0 || /[\s)]/.test(text[i - 1])) &&
      /[\s(]/.test(text[i + keyword.length] ?? ' ');
    if (atBoundary && pendingBetween) {
      pendingBetween = false;
      current += text[i];
      continue;
    }
    if (atBoundary) {
      parts.push({ text: current, at: offset + start });
      i += keyword.length - 1;
      current = '';
      start = i + 1;
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push({ text: current, at: offset + start });
  return parts.filter((p) => p.text.trim());
}

/** Strip one layer of wrapping parentheses, when they wrap the whole term. */
function unwrap(text: string): { text: string; shift: number } {
  const t = text.trim();
  const lead = text.length - text.trimStart().length;
  if (!t.startsWith('(') || !t.endsWith(')')) return { text: t, shift: lead };
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '(') depth++;
    else if (t[i] === ')') {
      depth--;
      if (depth === 0 && i < t.length - 1) return { text: t, shift: lead }; // `)(` — not one wrap
    }
  }
  return { text: t.slice(1, -1).trim(), shift: lead + 1 };
}

/**
 * Whether the text carries an `or` at depth zero — the one case where
 * appending `and …` textually would regroup its meaning, since `or`
 * binds loosest. Mirrored in the client (core.js `andQuery`), kept
 * honest by test/mirrors.test.ts.
 */
function hasTopLevelOr(text: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  const lower = text.toLowerCase();
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && lower.startsWith('or', i) && (i === 0 || /[\s)]/.test(text[i - 1])) && /[\s(]/.test(text[i + 2] ?? ' '))
      return true;
  }
  return false;
}

/**
 * Join query fragments with `and`, parenthesizing any fragment whose
 * top-level `or` would otherwise regroup: `a or b` composed with `c`
 * must mean `(a or b) and c`, never `a or (b and c)`. Every place that
 * folds an authored query into a narrower one goes through this.
 */
export function andQuery(...parts: Array<string | false | null | undefined>): string {
  const heads: string[] = [];
  const tails: string[] = [];
  for (const raw of parts) {
    const p = typeof raw === 'string' ? raw.trim() : '';
    if (!p) continue;
    /* Conditions and clauses part company here. A tab written `kind = a or
       kind = b sort happened_on desc` is conditions *and* a sort; bracketing
       the whole text put the sort inside the parentheses and the parser
       could not read it. Only the conditions are composed; the clauses
       follow, in the order their fragments came. */
    const { head, tail } = splitClauseTail(p);
    if (head) heads.push(hasTopLevelOr(head) ? `(${head})` : head);
    if (tail) tails.push(tail);
  }
  return [heads.join(' and '), ...tails].filter(Boolean).join(' ');
}

/**
 * A fragment's conditions, and the clauses that follow them: `a = 1 sort b
 * limit 5` is head `a = 1`, tail `sort b limit 5`. A leading `filter`/`where`
 * is dropped from the head, since the composition supplies its own. Quoted
 * values are masked before scanning so `name = "sort of"` stays a value; a
 * clause word followed by an operator is a column (`limit > 5`), as the
 * parser itself decides. Mirrored in the client (core.js), kept honest by
 * test/mirrors.test.ts.
 */
export function splitClauseTail(text: string): { head: string; tail: string } {
  const masked = maskQuoted(text);
  const re = /\b(filter|where|show|select|sort|order\s+by|limit)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    if (FOLLOWED_BY_OPERATOR.test(masked.slice(re.lastIndex))) continue;
    /* `any opportunity where stage = won` is one condition: its `where` opens the child rows' conditions, not a clause. */
    if (/^(filter|where)$/i.test(m[1]) && ANY_BEFORE.test(masked.slice(0, m.index))) continue;
    if (m.index === 0 && /^(filter|where)$/i.test(m[1])) {
      const rest = text.slice(re.lastIndex);
      const inner = splitClauseTail(rest);
      return { head: inner.head, tail: inner.tail };
    }
    return { head: text.slice(0, m.index).trim(), tail: text.slice(m.index).trim() };
  }
  return { head: text.trim(), tail: '' };
}

/* The start of a condition about the rows that point at a record (`any opportunity via account_id`), up to where its own `where` would stand. */
const ANY_BEFORE = /(?:^|[\s(])(?:any|no)\s+[A-Za-z_$][\w$.]*(?:\s+via\s+[A-Za-z_$][\w$+]*)?\s*$/i;

/**
 * A condition about the rows that point at the record: `any opportunity where
 * stage = won`, `no task via owner_id`. The child table, the reference it
 * points through where it has several, and its own conditions — several of
 * them in parentheses, since a top-level `and` belongs to the record's.
 */
export const ANY_CONDITION = /^(any|no)\s+([A-Za-z_$][\w$.]*)(?:\s+via\s+([A-Za-z_$][\w$+]*))?(?:\s+(?:where|filter)\s+([\s\S]+))?$/i;

/** Each `any …`/`no …` condition in a condition text, where it stands; a column called `any` (`any = 3`) is not one. */
export function anyConditions(text: string): Array<{ at: number; text: string }> {
  const found: Array<{ at: number; text: string }> = [];
  const visit = (node: Node) => {
    if (node.kind !== 'cond') return node.children.forEach(visit);
    const word = /^(any|no)\s/i.exec(node.text);
    if (word && ANY_CONDITION.test(node.text) && !FOLLOWED_BY_OPERATOR.test(node.text.slice(word[1].length)))
      found.push({ at: node.at, text: node.text });
  };
  visit(parseExpression(text, 0));
  return found;
}

/** `or` binds loosest, then `and`, then parentheses. */
function parseExpression(text: string, offset: number): Node {
  const { text: inner, shift } = unwrap(text);
  const base = offset + shift;
  const ors = splitTopLevel(inner, 'or', base);
  if (ors.length > 1) return { kind: 'or', children: ors.map((p) => parseExpression(p.text, p.at)) };
  const ands = splitTopLevel(inner, 'and', base);
  if (ands.length > 1) return { kind: 'and', children: ands.map((p) => parseExpression(p.text, p.at)) };
  return { kind: 'cond', text: inner, at: base };
}

/**
 * The conditions a query holds at its top level, segments written out and nested `and`s flattened, each in a
 * spelling that does not depend on spacing: `a = 1 and (b = 2 and c = 3)` is three. An `or` stays one
 * condition, its branches in order, since which branch holds is not a question of more or fewer conditions. It is
 * how one query is shown to ask no more than another (a metric's whole, dashboards: `targetWhole`).
 */
export function topLevelConditions(text: string, segments?: Readonly<Record<string, string>>): string[] {
  const head = splitClauseTail(expandSegments(text, segments).text).head;
  if (!head) return [];
  const spell = (node: Node): string =>
    node.kind === 'cond' ? node.text.replace(/\s+/g, ' ').trim() : `(${node.children.map(spell).join(` ${node.kind} `)})`;
  const flat = (node: Node): string[] => (node.kind === 'and' ? node.children.flatMap(flat) : [spell(node)]);
  return flat(parseExpression(head, 0));
}

/**
 * Flatten to OR-of-ANDs, which is exactly the shape `Filter` holds.
 *
 * The distribution can blow up on a pathological query — `(a or b) and (c or
 * d) and (e or f)` is eight groups — so it is capped. Better to refuse than
 * to build a statement with ten thousand clauses in it.
 */
const MAX_GROUPS = 64;

function toGroups(node: Node): Node[][] {
  if (node.kind === 'cond') return [[node]];
  if (node.kind === 'or') return node.children.flatMap(toGroups);
  return node.children.reduce<Node[][]>(
    (groups, child) => {
      const childGroups = toGroups(child);
      const out = groups.flatMap((g) => childGroups.map((c) => [...g, ...c]));
      return out.slice(0, MAX_GROUPS + 1);
    },
    [[]],
  );
}

/* ---------- segments: a name for conditions ----------

   An App's segment (appSegments.ts) is a word the language reads where a
   condition stands — `overdue and mine` — and writes inline, in parentheses,
   before anything else is read. So it is the same statement as the conditions
   written out, by construction: the paths, rollups and computed columns it
   names are found by the view parser exactly as if they had been typed, and
   `me` and `today` are this request's. Only a whole condition is a segment;
   `status = open` keeps `open` a value. */

/** `me` read by a parse that was handed no person (ParseOptions.me). */
export const NO_ONE_HERE = 'me is the signed-in person, and nobody is named here to be it. Quote it ("me") to mean the text.';

const SEGMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** How deep segments may name segments: a chain this long is a cycle the load did not catch. */
const SEGMENT_DEPTH = 8;

/** Where an expansion put a segment's text: `from`..`from + length` in the expanded text was `was` characters at `at`. */
interface SegmentSplice {
  at: number;
  was: number;
  from: number;
  length: number;
}

interface ExpandedSegments {
  text: string;
  /** A position in the expanded text, said in the text as written: inside a segment's words, the segment's own word. */
  at: (position: number) => number;
  error?: QueryError;
}

/**
 * A condition text with each segment it names written out, nested ones too.
 * The positions of what was written stay readable through `at`, so a mistake
 * in the author's own words is still underlined where they typed it.
 */
export function expandSegments(
  text: string,
  segments: Readonly<Record<string, string>> | undefined,
  chain: readonly string[] = [],
): ExpandedSegments {
  const same: ExpandedSegments = { text, at: (position) => position };
  if (!segments || !text.trim()) return same;
  const words: Array<{ at: number; name: string }> = [];
  const visit = (node: Node) => {
    if (node.kind === 'cond') {
      if (SEGMENT_WORD.test(node.text) && Object.hasOwn(segments, node.text)) words.push({ at: node.at, name: node.text });
    } else node.children.forEach(visit);
  };
  visit(parseExpression(text, 0));
  if (!words.length) return same;
  const splices: SegmentSplice[] = [];
  let out = '';
  let last = 0;
  for (const word of words.sort((a, b) => a.at - b.at)) {
    if (chain.includes(word.name) || chain.length >= SEGMENT_DEPTH) {
      return {
        ...same,
        error: {
          message: `The segment "${word.name}" names itself through ${[...chain, word.name].map((name) => `"${name}"`).join(' → ')}.`,
          at: word.at,
        },
      };
    }
    const inner = expandSegments(segments[word.name], segments, [...chain, word.name]);
    if (inner.error) return { ...same, error: { message: inner.error.message, at: word.at } };
    out += text.slice(last, word.at);
    const written = `(${inner.text})`;
    splices.push({ at: word.at, was: word.name.length, from: out.length, length: written.length });
    out += written;
    last = word.at + word.name.length;
  }
  out += text.slice(last);
  return {
    text: out,
    at: (position) => {
      let shift = 0;
      for (const splice of splices) {
        if (position < splice.from) break;
        if (position < splice.from + splice.length) return splice.at;
        shift = splice.from + splice.length - (splice.at + splice.was);
      }
      return position - shift;
    },
  };
}

/* ---------- value coercion ----------

   The schema is the reason this is possible at all. Knowing the column's
   declared type lets `active = true` mean the boolean `true` on Postgres and
   the integer `1` on SQLite, without the user thinking about either. */

/**
 * Take the quotes off a value, and the escapes out of it.
 *
 * The unescaping half was missing, and its absence was invisible because the
 * *tokenizer* has always understood `\"` — `maskQuoted` skips an
 * escaped character precisely so it cannot end the quote. So `name =
 * "Harbour \"HQ\""` was split into a clause correctly and then bound as the
 * literal `Harbour \"HQ\"`, backslashes and all, which matches no row. Two
 * halves of one grammar disagreeing about whether it has escapes.
 *
 * Only `\"`, `\'` and `\\` are unescaped. This is not C: `\n` in a value
 * is a backslash and an n, because that is what someone typing a Windows path
 * into a filter means by it.
 */
function unquoteValue(raw: string): { value: string; quoted: boolean } {
  const t = raw.trim();
  if ((t.startsWith('"') && t.endsWith('"') && t.length > 1) || (t.startsWith("'") && t.endsWith("'") && t.length > 1)) {
    return { value: unescapeValue(t.slice(1, -1)), quoted: true };
  }
  return { value: t, quoted: false };
}

/**
 * Write a value back into the grammar, quoting only when it needs it.
 *
 * The exact counterpart of `unquoteValue` above, and the reason it lives here
 * rather than beside the caller: quoting used to be written out wherever a
 * value had to be turned back into query text — three times in the client and
 * once here — and the four disagreed about an embedded `"`, so the same value
 * produced a different filter depending on which button was pressed.
 *
 * The backslash is escaped before the quote, or a value ending in one would
 * escape its own closing quote and swallow the rest of the query. The client
 * has its own copy in `core.quote`, because the browser cannot import this
 * file; `mirrors.test.ts` asserts the two agree character for character.
 */
export function quoteValue(value: unknown): string {
  const text = String(value);
  /* A dot is left bare only in a number: `a.b` is a path wherever `a` is a
     column, which the probe below cannot know about a real table. */
  if (/^(?:[\w-]+|-?\d+\.\d+)$/.test(text) && readsAsItself(text)) return text;
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/* The probe `readsAsItself` parses against: one text column, so a bare value
   is bound as the text it is and nothing about a real table can change the
   answer, and a session, so `me` is read as the person it would name. */
const PROBE_SCHEMA: DatabaseSchema = {
  label: 'probe',
  dialect: 'sqlite',
  foreignKeys: [],
  readAt: '',
  tables: [
    {
      name: 'probe',
      schema: '',
      id: 'probe',
      isView: false,
      columns: [{ name: 'value', type: 'text', nullable: true, primaryKey: false }],
    },
  ],
};
const PROBE_ME: QueryPerson = { email: 'probe@example.invalid' };
const PROBE_NOW = new Date(0);

/**
 * Whether a bare value would be read back as exactly itself, both after `=`
 * and inside `in (…)`.
 *
 * Asked of the parser rather than of a list of its words, because a list is a
 * second copy of the grammar and the copy was the bug: the old rule was "any
 * run of word characters, dots and hyphens is safe", and a card photo's slug
 * `2023-mazda-cx-5-select-lf1015` carried `select`, which the parser reads as
 * a clause. The request was refused and every card on the page lost its
 * photo. A word the grammar learns later (`me`, a date phrase, a clause) is
 * quoted here the day it is learned, with nothing to keep in step.
 */
function readsAsItself(text: string): boolean {
  const read = (query: string) => parseQuery(query, { schema: PROBE_SCHEMA, me: PROBE_ME, now: PROBE_NOW });
  const equal = read(`probe value = ${text}`);
  const listed = read(`probe value in (${text})`);
  const only = (result: ParseResult) =>
    result.errors.length === 0 && result.query?.filter.groups.length === 1 && result.query.filter.groups[0].length === 1
      ? result.query.filter.groups[0][0]
      : undefined;
  const one = only(equal);
  const inList = only(listed);
  return (
    one?.op === '=' &&
    one.value === text &&
    inList?.op === 'in' &&
    Array.isArray(inList.value) &&
    inList.value.length === 1 &&
    inList.value[0] === text
  );
}

function unescapeValue(text: string): string {
  return text.replace(/\\(["'\\])/g, '$1');
}

/**
 * Dates are bound as ISO strings because both target dialects compare them
 * correctly that way: Postgres casts on the way in, and SQLite's documented
 * text-date format is exactly ISO-8601. A `Date` object handed to a driver
 * is at the mercy of whatever it decides to do with the local timezone.
 */
function bindDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  /* A midnight boundary is bound as the bare day. Text comparison sorts
     '2026-08-30' before '2026-08-30 00:00:00', so appending the zero time
     made every bare-DATE column compare wrong at the boundary — SQLite
     counted a task due *today* as `< today`, i.e. overdue. Bare, the bound
     is right for every storage shape at once: it sorts before any datetime
     of its day, and a driver casting for a real date/timestamp column reads
     it as midnight exactly as before. */
  if (!d.getHours() && !d.getMinutes() && !d.getSeconds()) return day;
  return `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function coerce(column: ColumnMeta | undefined, value: string, quoted: boolean, op?: string): string | number | boolean {
  const kind = column ? columnKind(column.type) : 'other';
  if (quoted) return value; // an explicit quote is an explicit "this is text"
  /* A key of a JSON column (`specs.capacity`) is compared as its text, which
     is how an equality reads the same on every engine and for every value a
     key holds (`true` for a yes); only an ordering against a number compares
     numbers (viewLabels.ts picks the expression). */
  if (column?.type === DEFINED_PATH_TYPE) {
    const n = Number(value);
    return op && RANGE_OPS.has(op) && value !== '' && Number.isFinite(n) ? n : value;
  }

  const truthy = /^(true|yes)$/i.test(value);
  const falsy = /^(false|no)$/i.test(value);

  if (kind === 'boolean') {
    if (truthy || value === '1') return true;
    if (falsy || value === '0') return false;
  }
  /* An integer past 2^53 is not a JavaScript number. `id = 9007199254740993`
     through Number() binds …992 and finds the wrong row, or none, with
     nothing about it that looks wrong — the same rounding the adapters
     guard against on the way *out* (ids past 2^53 come back as strings).
     Left as text, every driver hands the digits to the database whole and
     the column's own type does the comparison. */
  if (/^-?\d+$/.test(value) && !Number.isSafeInteger(Number(value))) return value;
  if (kind === 'number') {
    /* SQLite has no boolean type, so a flag column is declared INTEGER and
       stores 1 and 0. Someone typing `active = true` against it means the
       integer, and binding the string 'true' would match nothing while
       looking exactly like an empty table. */
    if (truthy) return 1;
    if (falsy) return 0;
    const n = Number(value);
    if (Number.isFinite(n) && value !== '') return n;
  }
  if (kind === 'other') {
    /* An untyped column compared to a bare number is still probably a number
       — SQLite's dynamic typing makes untyped columns common. */
    if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
    if (truthy) return true;
    if (falsy) return false;
  }
  return value;
}

/* ---------- condition compilation ---------- */

function resolveColumn(table: TableMeta | undefined, name: string): { column?: ColumnMeta; error?: string } {
  if (!table) return {};
  const exact = table.columns.find((c) => c.name === name);
  if (exact) return { column: exact };
  // Case-insensitive next: people type `Name` for `name` constantly, and
  // both dialects fold unquoted identifiers anyway.
  const insensitive = table.columns.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (insensitive) return { column: insensitive };

  /* A reference path read where only the table's own columns can be: the
     plain query has no joins, and "not a column" is true and useless when
     the first hop plainly is one. The view parser admits paths before this
     is reached, so this is said only where a path genuinely cannot go. */
  const hop = name.split('.')[0];
  if (name.includes('.') && table.columns.some((c) => c.name === hop)) {
    return { error: `"${name}" is a path, and a condition here reads only ${table.name}'s own columns.` };
  }
  const near = nearest(
    name,
    table.columns.map((c) => c.name),
  );
  const suggestion = near ? ` Did you mean "${near}"?` : '';
  return { error: `"${name}" is not a column on ${table.name}.${suggestion}` };
}

export type { QueryPerson } from './queryOperands.js';
export { ANYONE } from './queryOperands.js';

/* A record's tags are asked only whether they hold a label: `tags = bug` would
   compare the list itself, which is no question anyone means. */
function compileCondition(raw: string, ctx: CompileContext): { conditions?: Condition[]; error?: string } {
  const compiled = compileClause(raw, ctx);
  const tagged = compiled.conditions?.find(
    (c) => c.op !== 'has' && ctx.table?.columns.find((col) => col.name === c.column)?.type === TAGS_TYPE,
  );
  if (tagged) return { error: `"${tagged.column}" is a record's tags: ask it with has, as in ${tagged.column} has bug.` };
  return compiled;
}

function compileClause(raw: string, ctx: CompileContext): { conditions?: Condition[]; error?: string } {
  const { table, now } = ctx;
  const text = raw.trim();

  /**
   * `column between a and b`.
   *
   * Expanded into `>= a` and `<= b` rather than carried as an operator of its
   * own. The filter model would need a new `Op` in three adapters to express
   * a range it can already express, and every one of them would have to get
   * the inclusive ends right. Two conditions is the same set of rows, needs
   * nothing new, and shows in the SQL panel as exactly what it does.
   *
   * Inclusive at both ends, which is what SQL's BETWEEN means and what
   * someone typing `total between 100 and 500` expects of `500`.
   */
  const between = text.match(new RegExp(String.raw`^(${FIELD})\s+(not\s+)?between\s+(.+?)\s+and\s+(.+)$`, 'i'));
  if (between) {
    const [, field, not, lowRaw, highRaw] = between;
    const { column, error } = resolveColumn(table, field);
    if (error) return { error };
    const name = column?.name ?? field;
    if (not) {
      return {
        error: `"not between" is not supported. Write it as two conditions: ` + `${name} < ${lowRaw.trim()} or ${name} > ${highRaw.trim()}`,
      };
    }

    const low = unquoteValue(lowRaw);
    const high = unquoteValue(highRaw);
    if (!low.value || !high.value) {
      return { error: `"between" needs two values, as in ${name} between 10 and 20` };
    }
    /* Each end coerced on its own, so a date range gets the same treatment a
       single date comparison does — `between 2024-01-01 and 2024-06-30` binds
       two timestamps, not two strings. */
    return {
      conditions: [
        { column: name, op: '>=' as const, value: coerce(column, low.value, low.quoted, '>=') as string | number },
        { column: name, op: '<=' as const, value: coerce(column, high.value, high.quoted, '<=') as string | number },
      ],
    };
  }

  /* `status is open`: the machine's states that are not final; `is not open`, the final ones (appMachine.ts). A
     group the machine names reads the same way: `status is onBench` is its states, `is not onBench` the others. */
  const open = text.match(new RegExp(String.raw`^(${FIELD})\s+is\s+(not\s+)?([A-Za-z]\w*)$`, 'i'));
  if (open && open[3].toLowerCase() !== 'empty') {
    const [, field, not, word] = open;
    const { column, error } = resolveColumn(table, field);
    if (error) return { error };
    const name = column?.name ?? field;
    const states = column?.states ?? ctx.states?.[name];
    if (!states)
      return {
        error: `"${name} is ${not ? 'not ' : ''}${word}" asks a machine's column, and "${name}" has no machine here. Name its states: ${name} in (…).`,
      };
    if (word.toLowerCase() !== 'open') {
      const group = states.groups && Object.hasOwn(states.groups, word) ? states.groups[word] : undefined;
      if (!group) {
        const groups = Object.keys(states.groups ?? {});
        return {
          error:
            `"${name}" has no group "${word}": \`is\` reads open or one of its machine's groups` +
            `${groups.length ? ` (${groups.join(', ')})` : ', and it names none'}. A single state is ${name} = ${word}.`,
        };
      }
      return not
        ? { conditions: group.map((state) => ({ column: name, op: '!=' as const, value: state })) }
        : { conditions: [{ column: name, op: 'in', value: [...group] }] };
    }
    const values = not ? states.final : states.open;
    if (!values.length)
      return {
        conditions: [
          { column: name, op: 'isNull' },
          { column: name, op: 'isNotNull' },
        ],
      };
    return { conditions: [{ column: name, op: 'in', value: [...values] }] };
  }

  const empty = text.match(new RegExp(String.raw`^([\w.$+"]+)\s+is\s+(not\s+)?empty$`, 'i'));
  if (empty) {
    const [, field, not] = empty;
    const { column, error } = resolveColumn(table, field);
    if (error) return { error };
    return { conditions: [{ column: column?.name ?? field, op: not ? 'isNotNull' : 'isNull' }] };
  }

  // Word operators are tried first because they are multi-character and a
  // symbol match would otherwise never see them.
  const word = text.match(
    new RegExp(String.raw`^(${FIELD})\s+(not\s+contains|contains|startswith|endswith|like|not\s+in|in|has)\s+(.+)$`, 'i'),
  );
  if (word) {
    const [, field, opRaw, valueRaw] = word;
    const { column, error } = resolveColumn(table, field);
    if (error) return { error };
    const name = column?.name ?? field;
    const key = opRaw.toLowerCase().replace(/\s+/g, ' ');
    const negated = key.startsWith('not ');
    const op = OPERATORS[negated ? key.slice(4) : key];
    if (!op) return { error: `Unknown operator "${opRaw}"` };

    /* `tags has bug`, `tags has (bug, docs)`: a record's tags (TableMeta.tags)
       hold any of the labels. A set, so a list never needs `in`. */
    if (op === 'has') {
      if (column?.type !== TAGS_TYPE && column?.type !== DEFINED_PATH_TYPE)
        return { error: `"has" asks a record's tags or a key of a JSON column, and "${name}" is neither.` };
      const list = valueRaw
        .trim()
        .replace(/^[([]\s*/, '')
        .replace(/\s*[)\]]$/, '');
      const labels = list
        .split(',')
        .map((s) => unquoteValue(s).value)
        .filter((s) => s !== '');
      if (!labels.length) return { error: `"has" needs a tag, as in ${name} has bug` };
      return { conditions: [{ column: name, op: 'has', value: labels }] };
    }

    if (op === 'in') {
      // `in (a, b)` and `in [a, b]` read more naturally than a bare list.
      const list = valueRaw
        .trim()
        .replace(/^[([]\s*/, '')
        .replace(/\s*[)\]]$/, '');
      const items = list
        .split(',')
        .map((s) => unquoteValue(s))
        .filter((s) => s.value !== '');
      if (!items.length) return { error: `"${opRaw}" needs at least one value` };
      const values: Array<string | number> = [];
      for (const item of items) {
        /* The signed-in person's memberships (`assignment_group_id in (me.group_member.group_id)`): the values read for this request through its own reader. Where nobody is meant, it is no text. */
        if (!item.quoted && ME_SET.test(item.value)) {
          if (ctx.me === undefined)
            return {
              error: `${item.value} is the signed-in person's rows, and nobody is signed in here. Quote it ("${item.value}") to mean the text.`,
            };
          const set = meSetOperand(ctx, column, item.value);
          if (set.error) return { error: set.error };
          values.push(...set.values!);
          continue;
        }
        /* A group the machine names is asked with `is` (`status is onBench`), as `is open` is: one way to say it. */
        const groups = item.quoted ? undefined : (column?.states ?? ctx.states?.[name])?.groups;
        if (groups && Object.hasOwn(groups, item.value))
          return { error: `"${item.value}" is a group of ${name}'s states; ask it with is: ${name} is ${item.value}.` };
        if (!item.quoted && item.value === 'me') {
          if (ctx.me === undefined) return { error: NO_ONE_HERE };
          const me = meOperand(ctx, column, '=');
          if (me.error) return { error: me.error };
          if (me.value !== undefined) values.push(me.value);
          continue;
        }
        values.push(coerce(column, item.value, item.quoted) as string | number);
      }
      if (negated) {
        /* There is no NOT IN in the filter model, and adding one would mean a
           new operator in every adapter. An expanded chain of != is the same
           set and needs nothing new. */
        return { conditions: values.map((v) => ({ column: name, op: '!=' as const, value: v })) };
      }
      return { conditions: [{ column: name, op: 'in', value: values }] };
    }
    if (negated) {
      return { error: `"not ${op}" is not supported yet — use "is empty" or a different operator` };
    }
    const { value, quoted } = unquoteValue(valueRaw);
    // LIKE operands stay text even on a numeric column; `contains 5` on an
    // integer is a substring question, not an equality one.
    return { conditions: [{ column: name, op, value: quoted ? value : value }] };
  }

  const symbol = text.match(new RegExp(String.raw`^(${FIELD})\s*(!=|<=|>=|=|<|>)\s*(.+)$`));
  if (symbol) {
    const [, field, opRaw, valueRaw] = symbol;
    const { column, error } = resolveColumn(table, field);
    if (error) return { error };
    const name = column?.name ?? field;
    const op = OPERATORS[opRaw];
    const { value, quoted } = unquoteValue(valueRaw);

    /* SQL's NULL is not a word this language compares with: `= null` bound
       the four letters and matched nothing, which reads as an empty list
       rather than a mistake — and in an App, as a count that is always 0. */
    if (!quoted && /^null$/i.test(value)) {
      return {
        error: `"${field} ${opRaw} ${value}" compares with the word "${value}": write "${field} is ${op === '!=' ? 'not ' : ''}empty" for a missing value, or quote it ("${value}") to mean the text.`,
      };
    }

    /* `me` is resolved here, in the parse the server runs for this request,
       so the person a tab means is the session's and never the browser's. */
    if (!quoted && ME_SET.test(value) && ctx.me !== undefined)
      return { error: `${value} is a set of values: ask it with in, as in ${field} in (${value}).` };
    /* A parse that was handed no person cannot say whose `me` it is. Read as the two letters, `owner != me` was
       every row, silently, on any path that forgot the person: refused here, so it forgets loudly. A path where
       nobody is signed in says so (`me: null`); a check before any request reads it as anyone's (ANYONE). */
    if (!quoted && value === 'me' && ctx.me === undefined) return { error: NO_ONE_HERE };
    if (!quoted && value === 'me') {
      const me = meOperand(ctx, column, op);
      if (me.error) return { error: me.error };
      if (me.conditions) return { conditions: me.conditions };
      return { conditions: [{ column: name, op, value: me.value! }] };
    }
    if (!quoted) {
      const operand = columnOperand(ctx, column, op, value);
      if (operand.error) return { error: operand.error };
      if (operand.other) return { conditions: [{ column: name, op, other: operand.other.name }] };
    }

    /* `now` beside a date is the instant, bound as a date phrase's edges are, so `resolution_due_at < now` reads
       the same on every engine. Bound as the word, PostgreSQL alone took it for the clock (SQLite compared the
       text, and every row was before it), and the typed query refused what the segment had passed. */
    if (!quoted && value.toLowerCase() === 'now' && column && columnKind(column.type) === 'date') {
      nowRead = 2;
      return { conditions: [{ column: name, op, value: bindDate(now) }] };
    }

    /* A date phrase is a range, not a point, so `=` becomes two conditions.
       Getting this wrong is the failure this language is built to avoid: an
       unparseable phrase sent through as a literal matches nothing, and a
       filter that silently matches nothing looks exactly like a table that is
       genuinely empty. */
    if (!quoted) {
      const window = dateWindow(value, now);
      if (window) {
        nowRead = /\b(?:hour|minute)s?$/.test(window.label) ? 2 : Math.max(nowRead, 1);
        if (op === '=') {
          return {
            conditions: [
              { column: name, op: '>=', value: bindDate(window.start) },
              { column: name, op: '<', value: bindDate(window.end) },
            ],
          };
        }
        if (op === '>=' || op === '<') return { conditions: [{ column: name, op, value: bindDate(window.start) }] };
        /* The inclusive side of a range is half-open against the *next* day:
           `<= today` must take everything before tomorrow (a datetime late
           tonight included), and `> today` everything from tomorrow on.
           Bound with their literal operators they read the boundary itself
           as a row, which admitted tomorrow into "<= today". */
        if (op === '>') return { conditions: [{ column: name, op: '>=', value: bindDate(window.end) }] };
        if (op === '<=') return { conditions: [{ column: name, op: '<', value: bindDate(window.end) }] };
        return { error: `"${value}" is a date range — use =, >=, >, <= or < with it, not ${opRaw}` };
      }
    }

    /* A bare multi-word value is nearly always a missing pair of quotes. It
       would otherwise bind as a literal that matches nothing, which reads as
       "no results" rather than "you made a mistake". The message shows the
       whole condition quoted, because an author (or an agent) copies the fix
       rather than reading it; a date phrase is offered only where the column
       holds dates, since on a status column it sent people looking for one. */
    if (!quoted && /\s/.test(value)) {
      const dated = column && columnKind(column.type) === 'date';
      return {
        error: `The value ${value} has a space, so quote it: ${field} ${opRaw} "${value}"${dated ? ', or use a date phrase like today or last 30 days' : ''}.`,
      };
    }

    return { conditions: [{ column: name, op, value: coerce(column, value, quoted, op) }] };
  }

  /* A bare column name is a common half-typed state, and it is ambiguous in a
     useful way: the user may be starting a filter, or may want projection and
     not know the word for it. Naming both is how `show` gets discovered —
     an error that only suggests filtering teaches that projection does not
     exist. */
  if (new RegExp(String.raw`^${FIELD}$`).test(text) && table) {
    const { column } = resolveColumn(table, text);
    if (column) {
      return {
        error:
          `What about "${text}"? To filter, try ${text} = … or ${text} is not empty. ` +
          `To show only that column, put "show" first: show ${text}`,
      };
    }
    /* A word alone where a condition stands is a segment's name (expandSegments wrote out every one it knew). */
    const names = Object.keys(table.segments ?? {});
    if (names.length && SEGMENT_WORD.test(text)) {
      const near = nearest(text, names);
      return {
        error: `"${text}" is not a segment of ${table.name}. Its segments: ${names.join(', ')}.${near ? ` Did you mean "${near}"?` : ''}`,
      };
    }
  }
  return { error: `Could not read "${text}" — try e.g. status = open, or amount > 100` };
}

/* ---------- the parser ---------- */

/**
 * What makes a clause word a column name instead: an operator right after it.
 * A table with a column called `filter`, `sort` or `limit` is not unusual, and
 * eating the word as a clause turns `limit is empty` into a nonsense query.
 */
const FOLLOWED_BY_OPERATOR =
  /^\s*(?:=|!=|>=|<=|>|<|\bis\s+not\s+empty\b|\bis\s+empty\b|\bis\b|\bcontains\b|\bstartswith\b|\bendswith\b|\blike\b|\bnot\s+in\b|\bin\b|\bhas\b)/i;

const CLAUSE_RE = /\b(filter|where|show|select|sort|order\s+by|limit)\b/gi;

/** The hyphenated word a clause keyword at [start, end) is part of (`no-show`), or undefined where it stands alone. */
function hyphenatedValue(text: string, start: number, end: number): { start: number; end: number } | undefined {
  if (text[start - 1] !== '-' && text[end] !== '-') return undefined;
  let from = start;
  let to = end;
  while (from > 0 && /[\w-]/.test(text[from - 1])) from -= 1;
  while (to < text.length && /[\w-]/.test(text[to])) to += 1;
  return { start: from, end: to };
}

/**
 * What to say about a clause given twice.
 *
 * `filter` is the one that combines, and it is not routed here: two conditions
 * genuinely narrow one result, so they are joined with `and`. Nothing else
 * does. `show a show b` used to compile as a single column literally named
 * "a and b" and then fail as an unknown column — an error naming a word the
 * user never typed, about a mistake it never mentioned.
 *
 * Refusing beats picking one. There is no reading of two `limit`s under which
 * the discarded number was not asked for, and a silently dropped clause is the
 * failure this language exists to avoid: the answer looks like an answer. So
 * the clause is named, and — where the language has a way to say both things
 * at once — the comma that does it is shown.
 */
function repeatedClause(keyword: string): string {
  const combine: Record<string, string> = {
    show: 'Name every column in one, separated by commas: show first_name, last_name',
    sort: 'Name every field in one, separated by commas: sort invoice_date desc, id',
    limit: 'Only one number can be the number of rows — keep the one you meant.',
  };
  return `Two "${keyword}" clauses, and the second cannot add to the first. ${combine[keyword] ?? 'Say it once.'}`;
}

function normalizeClause(word: string): string {
  const w = word.toLowerCase().replace(/\s+/g, ' ');
  if (w === 'where') return 'filter';
  if (w === 'order by') return 'sort';
  if (w === 'select') return 'show';
  return w;
}

/* The ceiling comes from the adapters rather than being restated here, so
   the language cannot promise a limit the database layer would refuse. */

interface ParseOptions {
  schema?: DatabaseSchema;
  /** Injected so compilation is deterministic and testable. */
  now?: Date;
  /**
   * Admit another column on a condition's right-hand side. Only a view's
   * compiler can write one (`buildWhere` refuses it elsewhere), so a plain
   * query says so by name and the query bar reads the text again as a view.
   */
  columnValues?: boolean;
  /** Who `me` is: the server's reading of the session; null, nobody signed in. Absent, `me` is refused. */
  me?: QueryPerson | null;
  /** A machine's states by column, for a parse with no catalog to carry them (`status is open`). */
  states?: Readonly<Record<string, MachineStates>>;
}

/* ---------- the parse, remembered ----------

   A parse is a pure function of the text, the schema, `me`, `columnValues`
   and — only when a date phrase is read — `now`. A busy server parses the same
   few hundred texts over and over (every list tab, every dashboard tile), so
   the answer is kept, per schema object (a reloaded App or a new catalog is a
   different object and starts empty) and bounded, least recently used first.

   `now` is left out of the key until a condition actually reads it. A phrase
   that resolves by calendar day (`today`, `last 30 days`) is kept under the
   local day, which is how `startOfDay` reads it, so a cached `today` is
   re-resolved when the day turns. One that resolves to the millisecond
   (`last 2 hours`, `last 30 minutes`) is never kept. The result is frozen: it is shared. */
const PARSE_KEPT = 512;
const NO_SCHEMA: object = {};
const parsesBySchema = new WeakMap<object, Map<string, ParseResult | { dated: true }>>();
/** Set by `compileCondition` when a date phrase resolved: 1 by day, 2 by the millisecond. */
let nowRead = 0;

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) freezeDeep(inner);
  }
  return value;
}

function dayKey(base: string, now: Date | undefined): string {
  const at = now ?? new Date();
  return `${base}\0${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`;
}

export function parseQuery(input: string, options: ParseOptions = {}): ParseResult {
  // States handed in beside the text are rare (a board's lanes) and never kept: the cache is keyed by the catalog.
  if (options.states) {
    nowRead = 0;
    return freezeDeep(parseUncached(input, options));
  }
  const schemaKey = options.schema ?? NO_SCHEMA;
  let kept = parsesBySchema.get(schemaKey);
  if (!kept) parsesBySchema.set(schemaKey, (kept = new Map()));
  const base = `${input}\0${options.columnValues === true ? 1 : 0}\0${options.me === undefined ? '' : JSON.stringify(options.me)}`;
  const marker = kept.get(base);
  const key = marker && 'dated' in marker ? dayKey(base, options.now) : base;
  const hit = marker && 'dated' in marker ? kept.get(key) : marker;
  if (hit && !('dated' in hit)) {
    kept.delete(key);
    kept.set(key, hit);
    return hit;
  }
  nowRead = 0;
  const result = freezeDeep(parseUncached(input, options));
  const used: number = nowRead;
  if (used !== 2) {
    if (used === 1) kept.set(base, { dated: true });
    const at = used === 1 ? dayKey(base, options.now) : base;
    kept.set(at, result);
    while (kept.size > PARSE_KEPT) kept.delete(kept.keys().next().value as string);
  }
  return result;
}

function parseUncached(input: string, options: ParseOptions): ParseResult {
  const text = input.trim();
  const now = options.now ?? new Date();
  if (!text) return { errors: [{ message: 'Start with a table name.' }] };

  const errors: QueryError[] = [];

  /* Clause keywords are found in a copy with the *insides* of quoted values
     blanked out, and then used as offsets into the real text.
    
     Scanning the raw string made a value that happens to contain a clause word
     into a clause: `name = "order by"` split at the quote, and the error came
     back "\"\"\" is not a column on customer. Did you mean \"id\"?" — confident,
     specific, and about a column nobody typed. The blanking preserves length
     and the quote characters themselves, so every offset still lines up with
     the original and error positions stay honest. */
  const scannable = maskQuoted(text);

  CLAUSE_RE.lastIndex = 0;
  const marks: Array<{ keyword: string; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = CLAUSE_RE.exec(scannable))) {
    if (FOLLOWED_BY_OPERATOR.test(scannable.slice(CLAUSE_RE.lastIndex))) continue;
    /* A clause word inside an unquoted hyphenated value — `status = no-show` —
       is the value's, not a clause: taken as one, the query read `status = no-`
       and nothing more, or said the conditions after it were "not a column". */
    const glued = hyphenatedValue(scannable, m.index, CLAUSE_RE.lastIndex);
    if (glued) {
      const word = text.slice(glued.start, glued.end);
      const lead = /([\w.]+\s*(?:!=|>=|<=|=|>|<|\bcontains\b|\bstartswith\b|\bendswith\b|\blike\b))\s*$/i.exec(
        text.slice(0, glued.start),
      )?.[1];
      errors.push({
        message: `"${word}" is a value, and unquoted its "${m[1]}" starts a clause: quote it — ${lead ? `${lead} ` : ''}"${word}".`,
        at: glued.start,
      });
      continue;
    }
    marks.push({ keyword: normalizeClause(m[1]), start: m.index, end: CLAUSE_RE.lastIndex });
  }

  const head = (marks.length ? text.slice(0, marks[0].start) : text).trim();
  const tableName = head.split(/\s+/)[0] ?? '';
  if (!tableName) return { errors: [{ message: 'Which table?' }] };

  /* The table has to resolve before anything else can be checked, since every
     column error is relative to it. An unqualified name is matched on the
     bare table name too, so `customers` finds `public.customers`. */
  let table: TableMeta | undefined;
  if (options.schema) {
    table = findTable(options.schema, tableName);
    if (!table) {
      const candidates = options.schema.tables.filter((t) => t.name === tableName);
      if (candidates.length === 1) table = candidates[0];
      else if (candidates.length > 1) {
        errors.push({
          message: `"${tableName}" is ambiguous — it exists in ${candidates.map((c) => c.schema).join(', ')}. Qualify it, e.g. ${candidates[0].id}.`,
          at: 0,
        });
      } else {
        const near = options.schema.tables
          .map((t) => ({ id: t.id, d: Math.min(distance(tableName, t.name), distance(tableName, t.id)) }))
          .sort((a, b) => a.d - b.d)[0];
        errors.push({
          message: `No table called "${tableName}".${near && near.d <= 3 ? ` Did you mean "${near.id}"?` : ''}`,
          at: 0,
        });
      }
    }
  }

  // Anything after the table name and before the first clause word is already
  // a filter. `where` stays as optional sugar, but making it mandatory would
  // be ceremony with nothing to disambiguate.
  const implied = head.slice(tableName.length).trim();
  const clauses: Record<string, string> = {};
  const clauseAt: Record<string, number> = {};
  if (implied) {
    clauses.filter = implied;
    clauseAt.filter = tableName.length + 1;
  }
  marks.forEach((mark, i) => {
    const bodyEnd = i + 1 < marks.length ? marks[i + 1].start : text.length;
    const body = text.slice(mark.end, bodyEnd).trim();
    if (clauses[mark.keyword] === undefined) {
      clauses[mark.keyword] = body;
      clauseAt[mark.keyword] = mark.end;
      return;
    }
    // Repeated conditions concatenate: `where a where b` is `a and b`, which
    // is also how the implied filter and an explicit `where` are joined.
    if (mark.keyword === 'filter') {
      clauses.filter = `${clauses.filter} and ${body}`;
      return;
    }
    /* Everything else refuses. Located at the repeat rather than the first
       one, because that is the word that made the query ambiguous — and the
       first clause is left standing, so the partial result the editor shows
       is still something that was typed. */
    errors.push({ message: repeatedClause(mark.keyword), at: mark.start });
  });

  const filter: Filter = { groups: [] };
  /* A segment's name is written out before the conditions are read (expandSegments), and an error inside what
     it wrote is said at the name, where the author can see it. */
  let said = (at: number) => at;
  if (clauses.filter && table?.segments) {
    const base = clauseAt.filter ?? 0;
    const expanded = expandSegments(clauses.filter, table.segments);
    if (expanded.error) {
      errors.push({ message: expanded.error.message, at: base + (expanded.error.at ?? 0) });
      clauses.filter = '';
    } else if (expanded.text !== clauses.filter) {
      clauses.filter = expanded.text;
      said = (at) => base + expanded.at(at - base);
    }
  }
  if (clauses.filter) {
    const tree = parseExpression(clauses.filter, clauseAt.filter ?? 0);
    const groups = toGroups(tree);
    if (groups.length > MAX_GROUPS) {
      errors.push({ message: `That expands to more than ${MAX_GROUPS} OR branches. Simplify it or filter in two steps.` });
    } else {
      for (const group of groups) {
        const conditions: Condition[] = [];
        for (const node of group) {
          if (node.kind !== 'cond') continue;
          const { conditions: got, error } = compileCondition(node.text, {
            table,
            now,
            columnValues: options.columnValues === true,
            ...(options.me !== undefined ? { me: options.me } : {}),
            ...(options.states ? { states: options.states } : {}),
          });
          if (error) errors.push({ message: error, at: said(node.at) });
          else if (got) conditions.push(...got);
        }
        if (conditions.length) filter.groups.push(conditions);
      }
    }
  }

  const orderBy: ParsedQuery['orderBy'] = [];
  if (clauses.sort) {
    for (const part of clauses.sort.split(/\s*,\s*|\s+and\s+/i)) {
      const [field, dir] = part.trim().split(/\s+/);
      if (!field) continue;
      const { column, error } = resolveColumn(table, field);
      if (error) errors.push({ message: error, at: clauseAt.sort });
      else orderBy.push({ column: column?.name ?? field, direction: (dir ?? '').toLowerCase() === 'desc' ? 'desc' : 'asc' });
    }
  }

  const columns: string[] = [];
  for (const raw of (clauses.show ?? '').split(',')) {
    const field = raw.trim();
    if (!field) continue;
    const { column, error } = resolveColumn(table, field);
    if (error) errors.push({ message: error, at: clauseAt.show });
    else columns.push(column?.name ?? field);
  }

  let limit: number | undefined;
  if (clauses.limit) {
    const n = Number(clauses.limit.split(/\s+/)[0]);
    if (Number.isFinite(n) && n > 0) limit = Math.min(Math.floor(n), MAX_LIMIT);
    else errors.push({ message: `limit expects a number, got "${clauses.limit}"`, at: clauseAt.limit });
  }

  /* A query is returned even when there are errors, so the editor can show a
     partial result while someone is still typing. The caller decides whether
     errors are fatal; only a missing table makes the query unusable. */
  if (!tableName) return { errors };
  return {
    query: { table: table?.id ?? tableName, filter, columns, orderBy, limit },
    errors,
  };
}

/**
 * Render a parsed query back as the SQL it will become.
 *
 * This is for the explain panel, not for execution — the adapter builds the
 * real statement from the same `Filter` with bound parameters. Showing values
 * inline here is safe because the string never reaches a database, and it is
 * the whole point: seeing `country = $1` next to `country = 'Australia'` is
 * how someone learns what the tool is doing on their behalf.
 */
export function explain(query: ParsedQuery): string {
  const cols = query.columns.length ? query.columns.join(', ') : '*';
  const lines = [`SELECT ${cols}`, `  FROM ${query.table}`];
  if (query.filter.groups.length) {
    const groups = query.filter.groups.map((g) =>
      g
        .map((c) => {
          if (c.op === 'isNull') return `${c.column} IS NULL`;
          if (c.op === 'isNotNull') return `${c.column} IS NOT NULL`;
          if (c.other !== undefined) return `${c.column} ${c.op} ${c.other}`;
          if (c.op === 'in') {
            const list = (Array.isArray(c.value) ? c.value : [c.value]).map(literal).join(', ');
            return `${c.column} IN (${list})`;
          }
          if (c.op === 'has') {
            const list = (Array.isArray(c.value) ? c.value : [c.value]).map(literal).join(', ');
            return `${c.column} HAS (${list})`;
          }
          if (c.op === 'like') {
            /* Shown with its ESCAPE clause always, unlike the searches above.
               There the clause is plumbing behind a plain search; here the
               escape character is part of the operator someone chose to write
               by hand, and the preview is where they find out it exists. */
            return `${c.column} LIKE ${literal(String(c.value ?? ''))} ESCAPE '${LIKE_ESCAPE}'`;
          }
          if (c.op === 'contains' || c.op === 'startsWith' || c.op === 'endsWith') {
            const pattern = likePattern(c.value, c.op);
            /* The ESCAPE clause is shown only when the value needed escaping.
               It is always sent — but printing it on every plain search would
               put dialect plumbing in front of the thing this preview exists
               to teach, and printing the escaped pattern *without* it would
               be a statement that means something else. */
            const escape = pattern.includes(LIKE_ESCAPE) ? ` ESCAPE '${LIKE_ESCAPE}'` : '';
            return `${c.column} LIKE ${literal(pattern)}${escape}`;
          }
          return `${c.column} ${c.op} ${literal(c.value)}`;
        })
        .join(' AND '),
    );
    lines.push(` WHERE ${groups.length === 1 ? groups[0] : groups.map((g) => `(${g})`).join('\n    OR ')}`);
  }
  if (query.orderBy.length) {
    lines.push(` ORDER BY ${query.orderBy.map((o) => `${o.column} ${o.direction.toUpperCase()}`).join(', ')}`);
  }
  if (query.limit !== undefined) lines.push(` LIMIT ${query.limit}`);
  return lines.join('\n');
}

function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}
