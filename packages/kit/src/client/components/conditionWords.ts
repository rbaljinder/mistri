/**
 * A condition said in words, for a reader of an App.
 *
 * The filter controls write the query language — `status != done`,
 * `claim_number contains zzzz`, `rent >= 1000` — and that is the right thing
 * for an address and for the Workbench, whose reader writes it too. An App's
 * reader never wrote it, so every place an App says what a list is narrowed
 * by — a chip, a facet's note, the column menu's Clear filter, the empty
 * list, a saved view's name — says it through here: the column's label, the
 * display rule's word for a value, and the catalog's connectives. "Status is
 * not Done", "Claim number contains “zzzz”", "Rent from $1,000", "Due
 * before Oct 1".
 *
 * Pure: what it knows of the App comes in as a speaker (the columns this
 * reader is served, their labels and rules, the names of referenced records
 * once read). Without one — the Workbench — the language is said as written.
 * A column the reader is not served (hidden, or outside their field grant)
 * is said as "Another condition": neither its name nor its value.
 */
import { MASK, vocabularyWord } from '@mistriwork/engine/shared/model.js';
import { dateWindow } from '@mistriwork/engine/shared/query.js';
import { columnKind, isFlagColumn, type ColumnMeta } from '@mistriwork/engine/shared/schema.js';
import { maskQuoted, sortFields, splitConditions, splitQuery } from '../clauses.js';
import { andWords, joined, squeeze, ungroup, written } from './conditionText.js';
import { unquote } from '../filterbar.js';
import { defaultCurrency, formatDate, formatMoney, formatNumber, formatPercent } from '../locale.js';
import { messageLanguage } from '../messages.js';
import { say as sayCopy } from '../copy/filters/components/conditionWords.js';
import { withUnit, wordFor, type DisplayRule } from './valueModel.js';
import { minorFigure } from '@mistriwork/engine/shared/money.js';

type Meta = ColumnMeta & { allowed?: readonly string[]; flag?: true };

/** What an App lends the words: its columns as this reader is served them. */
export interface ConditionSpeaker {
  /** The column, or undefined for one this reader is not served. */
  column(name: string): Meta | undefined;
  label(name: string): string;
  rule(name: string): DisplayRule | null | undefined;
  /** The name of the record a reference's id points at, once it has been read. */
  recordName?(column: string, id: string): string | undefined;
}

interface Operand {
  text: string;
  quoted: boolean;
}
type Read =
  | { op: 'empty' | 'notEmpty' }
  | { op: '=' | '!=' | '>' | '>=' | '<' | '<=' | 'contains' | 'notContains' | 'startsWith' | 'endsWith' | 'like'; value: Operand }
  | { op: 'between'; from: Operand; to: Operand }
  | { op: 'in'; values: Operand[] };

const operand = (raw: string): Operand => {
  const text = raw.trim();
  return /^["']/.test(text) ? { text: unquote(text), quoted: true } : { text, quoted: false };
};

/* A list's items, split on the commas outside quotes. */
function items(list: string): Operand[] {
  const masked = maskQuoted(list) as string;
  const out: Operand[] = [];
  let start = 0;
  for (let i = 0; i <= list.length; i += 1) {
    if (i < list.length && masked[i] !== ',') continue;
    const item = list.slice(start, i).trim();
    if (item) out.push(operand(item));
    start = i + 1;
  }
  return out;
}

const WORD_OPS: Record<string, Exclude<Read['op'], 'empty' | 'notEmpty' | 'between' | 'in'>> = {
  contains: 'contains',
  'not contains': 'notContains',
  startswith: 'startsWith',
  endswith: 'endsWith',
  like: 'like',
};

/** What a condition's tail asks — `!= done`, `in (a, b)`, `is empty` — or null for one the words do not know. */
function readTail(tail: string): Read | null {
  const t = squeeze(tail);
  const empty = /^is\s+(not\s+)?empty$/i.exec(t);
  if (empty) return { op: empty[1] ? 'notEmpty' : 'empty' };
  const between = /^between\s+(.+?)\s+and\s+(.+)$/i.exec(t);
  if (between) return { op: 'between', from: operand(between[1]), to: operand(between[2]) };
  const list = /^(not\s+)?in\s+[([](.*)[)\]]$/i.exec(t);
  if (list) {
    const values = items(list[2]);
    return list[1] ? null : { op: 'in', values };
  }
  const word = /^(not\s+contains|contains|startswith|endswith|like)\s+(.+)$/i.exec(t);
  if (word) return { op: WORD_OPS[word[1].toLowerCase().replace(/\s+/g, ' ')], value: operand(word[2]) };
  const symbol = /^(!=|<=|>=|=|<|>)\s*(.+)$/.exec(t);
  if (symbol) return { op: symbol[1] as '=', value: operand(symbol[2]) };
  return null;
}

export { andWords };

/* ---------- a value, as the App says it ---------- */

const FIXED_PHRASES: Record<string, () => string> = {
  today: () => sayCopy('today'),
  yesterday: () => sayCopy('yesterday'),
  tomorrow: () => sayCopy('tomorrow'),
  'this week': () => sayCopy('thisWeek'),
  'last week': () => sayCopy('lastWeek'),
  'this month': () => sayCopy('thisMonth'),
  'last month': () => sayCopy('lastMonth'),
  'this quarter': () => sayCopy('thisQuarter'),
  'last quarter': () => sayCopy('lastQuarter'),
  'next quarter': () => sayCopy('nextQuarter'),
  'this year': () => sayCopy('thisYear'),
  'last year': () => sayCopy('lastYear'),
};
const SPAN = /^(last|next|previous)\s+(\d+)\s+(minute|hour|day|week|month|year)s?$/i;

/** A relative date — `today`, `last 30 days` — in words, and whether it is a window ("the last 30 days") rather than a day. */
function datePhrase(value: Operand): { words: string; span: boolean } | undefined {
  if (value.quoted) return undefined;
  const p = value.text.toLowerCase().trim();
  if (!dateWindow(p, new Date())) return undefined;
  if (Object.hasOwn(FIXED_PHRASES, p)) return { words: FIXED_PHRASES[p](), span: false };
  const span = SPAN.exec(p);
  if (!span) return undefined;
  const said = new Intl.NumberFormat(messageLanguage(), { style: 'unit', unit: span[3].toLowerCase(), unitDisplay: 'long' }).format(
    Number(span[2]),
  );
  const way = span[1].toLowerCase();
  return { words: sayCopy(way === 'next' ? 'nextSpan' : way === 'previous' ? 'previousSpan' : 'lastSpan', { span: said }), span: true };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function shortDate(text: string): string {
  const sameYear = text.slice(0, 4) === String(new Date().getFullYear());
  return formatDate(text, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** Whether a column is read as a masked value: nothing it is compared with is ever said. */
const isMasked = (rule: DisplayRule | null | undefined) => Boolean(rule && rule.masked);

/** One value of a column, in the words the App draws it with. */
function sayValue(sp: ConditionSpeaker, column: string, meta: Meta | undefined, value: Operand, pattern = false): string {
  const rule = sp.rule(column);
  if (isMasked(rule)) return MASK;
  // What a text is searched for is the reader's own fragment, quoted as typed: “zzzz”.
  if (pattern) return sayCopy('quoted', { text: value.text });
  const { text, quoted } = value;
  if (!quoted && text === 'me') return sayCopy('me');
  // Compared with another column: that column's label.
  if (!quoted && text !== column && /^[\w.$+]+$/.test(text) && !/^-?\d/.test(text) && sp.column(text)) return sp.label(text);
  const phrase = datePhrase(value);
  if (phrase) return phrase.words;
  if (meta?.references) return sp.recordName?.(column, text) ?? text;
  const n = Number(text);
  const figure = text.trim() !== '' && Number.isFinite(n) && Number.isSafeInteger(Math.trunc(n));
  /* A vocabulary — a CHECK, or values the rule tones or marks — says a value
     as its pill does: `in_progress` is "In progress". A toned figure stays a
     figure, dressed below as the rule dresses it. */
  const vocabulary = Boolean(meta?.allowed?.length || rule?.tone || rule?.icons);
  const word = wordFor(rule, text) ?? (vocabulary && !figure ? vocabularyWord(text) : undefined);
  if (word !== undefined) return word;
  const flag = isFlagColumn(meta) || (meta && columnKind(meta.type) === 'boolean');
  if (!quoted && (/^(true|false)$/i.test(text) || (flag && /^[01]$/.test(text)))) {
    return sayCopy(/^(true|1)$/i.test(text) ? 'yes' : 'no');
  }
  if (figure && rule?.format === 'money') {
    const currency = rule.currency ?? defaultCurrency();
    const amount = rule.minor ? (minorFigure(text, currency) ?? n) : n;
    /* A bound is said as it was typed: "up to $15,000", not a figure to the cent. A value is always to the cent. */
    return withUnit(formatMoney(amount, currency, Number.isInteger(Number(amount)) ? { maximumFractionDigits: 0 } : {}), rule.unit);
  }
  if (figure && rule?.format === 'percent') return formatPercent(n);
  if (figure && (rule?.format === 'number' || rule?.unit)) return withUnit(formatNumber(n), rule.unit);
  if (ISO_DATE.test(text) && (!meta || columnKind(meta.type) === 'date' || columnKind(meta.type) === 'text')) return shortDate(text);
  return text;
}

const isDateish = (meta: Meta | undefined, value: Operand) =>
  Boolean(datePhrase(value)) || (meta ? columnKind(meta.type) === 'date' : false) || (!value.quoted && ISO_DATE.test(value.text));

/* ---------- one column's conditions ---------- */

function sayRead(sp: ConditionSpeaker, column: string, meta: Meta | undefined, read: Read): string {
  const label = sp.label(column);
  const value = (v: Operand) => sayValue(sp, column, meta, v);
  const fragment = (v: Operand) => sayValue(sp, column, meta, v, true);
  switch (read.op) {
    case 'empty':
      return sayCopy('empty', { label });
    case 'notEmpty':
      return sayCopy('notEmpty', { label });
    case 'in':
      return sayCopy('is', { label, value: joined(read.values.map(value), 'filter.or') });
    case 'between':
      return sayCopy('between', { label, from: value(read.from), to: value(read.to) });
    case 'contains':
      return sayCopy('contains', { label, value: fragment(read.value) });
    case 'notContains':
      return sayCopy('notContains', { label, value: fragment(read.value) });
    case 'startsWith':
      return sayCopy('startsWith', { label, value: fragment(read.value) });
    case 'endsWith':
      return sayCopy('endsWith', { label, value: fragment(read.value) });
    case 'like':
      return sayCopy('matches', { label, value: fragment(read.value) });
    default:
      break;
  }
  const phrase = datePhrase(read.value);
  // A window asked with `=` is the window: "Due today", "Created in the last 30 days".
  if (read.op === '=' && phrase)
    return sayCopy('when', { label, phrase: phrase.span ? sayCopy('within', { phrase: phrase.words }) : phrase.words });
  if (read.op === '=') return sayCopy('is', { label, value: value(read.value) });
  if (read.op === '!=') return sayCopy('isNot', { label, value: value(read.value) });
  const dated = isDateish(meta, read.value);
  const said = { label, value: value(read.value) };
  if (dated)
    return read.op === '>'
      ? sayCopy('after', said)
      : read.op === '>='
        ? sayCopy('onOrAfter', said)
        : read.op === '<'
          ? sayCopy('before', said)
          : sayCopy('onOrBefore', said);
  return read.op === '>'
    ? sayCopy('moreThan', said)
    : read.op === '>='
      ? sayCopy('from', said)
      : read.op === '<'
        ? sayCopy('lessThan', said)
        : sayCopy('upTo', said);
}

/* The column a condition names, and what it can be said as: a path
   (`account_id.name`) is said by its own label, and only where the reference
   it starts from is one this reader is served; its value is text. */
function subject(sp: ConditionSpeaker, column: string): { column: string; meta: Meta | undefined } | null {
  const meta = sp.column(column);
  if (meta) return { column, meta };
  const head = column.split('.')[0];
  if (head !== column && sp.column(head)) return { column, meta: undefined };
  return null;
}

/**
 * One column's conditions — its tails, as the filter controls read them
 * (`= open`, `!= a` and `!= b`, `>= 5` and `<= 9`) — as one phrase.
 */
export function sayTails(sp: ConditionSpeaker | null, column: string, tails: readonly string[]): string {
  if (!sp) return written.tails(column, tails);
  // A whole condition — the rows that point at the record, by a segment of theirs — is its own label.
  if (tails.length && tails.every((tail) => !squeeze(tail)) && sp.column(column)) return sp.label(column);
  return sayReads(sp, column, tails.map(readTail));
}

function sayReads(sp: ConditionSpeaker, column: string, reads: Array<Read | null>): string {
  const who = subject(sp, column);
  if (!who || !reads.length || reads.some((read) => !read)) return sayCopy('other');
  const said = reads as Read[];
  const say = (read: Read) => sayRead(sp, who.column, who.meta, read);
  // `stage != won and stage != lost`: "Stage is not Won or Lost".
  if (said.length > 1 && said.every((read) => read.op === '!=')) {
    const values = said.map((read) => sayValue(sp, who.column, who.meta, (read as { value: Operand }).value));
    return sayCopy('isNot', { label: sp.label(who.column), value: joined(values, 'filter.or') });
  }
  // `price >= 5 and price <= 9`: the range the rail would have written.
  if (said.length === 2 && said[0].op === '>=' && said[1].op === '<=') {
    return say({ op: 'between', from: said[0].value, to: said[1].value });
  }
  return andWords(said.map(say));
}

/* The arms of a top-level `or`, outside quotes and parentheses. */
function orArms(text: string): string[] {
  const masked = maskQuoted(text) as string;
  const arms: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (masked[i] === '(') depth += 1;
    else if (masked[i] === ')') depth -= 1;
    else if (depth === 0 && /\s/.test(masked[i]) && /^\sor\s/i.test(masked.slice(i, i + 4))) {
      arms.push(text.slice(start, i));
      start = i + 4;
      i += 3;
    }
  }
  arms.push(text.slice(start));
  return arms.map(squeeze).filter(Boolean);
}

const PLAIN = /^([\w.$+]+)\s*((?:!=|<=|>=|=|<|>|\s)[\s\S]*)$/;
/* A list's filter over the rows that point at its record (shared/listFilters.ts) is its words up to what they
   ask, `any opportunity where stage`, and a tail after them as any column's — or none, by a segment of theirs. */
const HAS = /^(any\s+[\w.$]+(?:\s+via\s+[\w$+]+)?\s+where\s+[\w.$]+)(?:\s*((?:!=|<=|>=|=|<|>|\s)[\s\S]*))?$/i;
const SIMPLE = {
  exec(text: string): [string, string, string] | null {
    const has = HAS.exec(text);
    if (has) return [has[0], has[1], has[2] ?? ''];
    const plain = PLAIN.exec(text);
    return plain && !/^(?:any|no)$/i.test(plain[1]) ? [plain[0], plain[1], plain[2]] : null;
  },
};

/** One top-level condition of a filter — `status != done`, an or-group, a bracketed and — in words. */
export function sayCondition(sp: ConditionSpeaker | null, condition: string): string {
  if (!sp) return written.condition(condition);
  const text = ungroup(condition);
  const arms = orArms(text);
  if (arms.length > 1) {
    const simple = arms.map((arm) => SIMPLE.exec(ungroup(arm)));
    const reads = simple.map((m) => (m ? readTail(m[2]) : null));
    // `status = open or status = done`: "Status is Open or Done".
    const column = simple[0]?.[1];
    const values = reads.map((read) => (read?.op === '=' && !datePhrase(read.value) ? read.value : null));
    if (column && simple.every((m) => m?.[1] === column) && values.every(Boolean)) {
      return sayReads(sp, column, [{ op: 'in', values: values as Operand[] }]);
    }
    return joined(
      arms.map((arm) => sayCondition(sp, arm)),
      'filter.or',
    );
  }
  const parts = splitConditions(text) as string[];
  if (parts.length > 1) return andWords(parts.map((part) => sayCondition(sp, part)));
  const simple = SIMPLE.exec(text);
  return simple ? sayTails(sp, simple[1], [simple[2]]) : sayCopy('other');
}

/** Each condition of a filter's text (no table name), in words. */
export function sayFilter(sp: ConditionSpeaker | null, filter: string): string[] {
  return (splitConditions(squeeze(filter)) as string[]).map((condition) => sayCondition(sp, condition));
}

/**
 * Everything a question asks beyond its table — its conditions, and a sort,
 * a column list or a page size a reader wrote by hand — one phrase each.
 */
export function sayQuestion(sp: ConditionSpeaker | null, text: string): string[] {
  if (!sp) return written.question(text);
  const parts = splitQuery(`q ${squeeze(text)}`) as { filter: string; sort?: string; show?: string; limit?: string };
  const out = sayFilter(sp, parts.filter);
  const name = (column: string) => (subject(sp, column) ? sp.label(subject(sp, column)!.column) : sayCopy('other'));
  if (parts.sort) {
    const fields = (sortFields(`q ${parts.sort}`) as Array<{ column: string; direction: 'asc' | 'desc' }>).map((field) =>
      field.direction === 'desc' ? sayCopy('descending', { label: name(field.column) }) : name(field.column),
    );
    out.push(sayCopy('sorted', { columns: andWords(fields) }));
  }
  if (parts.show) {
    const columns = parts.show
      .replace(/^(show|select)\s+/i, '')
      .split(',')
      .map((column) => name(column.trim()));
    out.push(sayCopy('showing', { columns: andWords(columns) }));
  }
  const limit = parts.limit ? /\d+/.exec(parts.limit)?.[0] : undefined;
  if (limit) out.push(sayCopy('first', { count: formatNumber(Number(limit)) }));
  return out;
}

/**
 * The ids a question compares a reference with, column by column: what a
 * speaker needs named before `owner_id in (3, 7)` can say "Dana Ward or
 * Sam Reyes".
 */
export function referencedIds(sp: ConditionSpeaker, text: string): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  const visit = (condition: string): void => {
    const plain = ungroup(condition);
    const arms = orArms(plain);
    if (arms.length > 1) {
      arms.forEach(visit);
      return;
    }
    const parts = splitConditions(plain) as string[];
    if (parts.length > 1) {
      parts.forEach(visit);
      return;
    }
    const simple = SIMPLE.exec(plain);
    const meta = simple ? sp.column(simple[1]) : undefined;
    if (!simple || !meta?.references) return;
    const read = readTail(simple[2]);
    const values = !read ? [] : read.op === 'in' ? read.values : 'value' in read ? [read.value] : [];
    for (const value of values) {
      if (value.text === 'me' && !value.quoted) continue;
      if (!out.has(simple[1])) out.set(simple[1], new Set());
      out.get(simple[1])!.add(value.text);
    }
  };
  const parts = splitQuery(`q ${squeeze(text)}`) as { filter: string };
  (splitConditions(parts.filter) as string[]).forEach(visit);
  return new Map([...out].map(([column, ids]) => [column, [...ids]]));
}
