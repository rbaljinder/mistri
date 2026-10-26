/**
 * The filter rail's rules, before anything is drawn: which facet a column
 * gets, what a facet reads out of the list's question and writes back into
 * it, and the breakdown that counts a facet's values.
 *
 * The rail writes the same language into the same place as the bar's boxes
 * — one condition tail per column, folded in by withCondition — so a rail
 * selection is a URL, a chip and a tab refinement exactly as a box's is.
 * What it adds are the tails a box has no gesture for: several values at
 * once (`in (a, b)`), and a date's presets beside a range. Pure, so the rail
 * and its tests read one rule.
 */
import { quote } from '../core.js';
import { splitQuery } from '../clauses.js';
import { conditionTail, holdsCondition, squeeze, stripCondition, unquote } from '../filterbar.js';
import { andQuery } from '@mistriwork/engine/shared/query.js';
import type { ColumnMeta } from '@mistriwork/engine/shared/schema.js';
import { say } from '../copy/filters/components/filterRailModel.js';

/** What a facet draws: a checklist of values, a checklist of tags, a toggle, date presets and a range, or a contains box. */
type FacetKind = 'values' | 'tags' | 'flag' | 'date' | 'text';

/** A box kind as a facet: a vocabulary and a reference are both a checklist of values; a record's tags, of its tags. */
export const facetKind = (boxKind: string): FacetKind =>
  boxKind === 'enum' || boxKind === 'ref' ? 'values' : boxKind === 'flag' || boxKind === 'date' || boxKind === 'tags' ? boxKind : 'text';

/* A value list split on its commas, never on a comma inside quotes. */
function listItems(text: string): string[] {
  const out: string[] = [];
  let item = '';
  let inside: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inside) {
      item += ch;
      if (ch === '\\') {
        item += text[++i] ?? '';
        continue;
      }
      if (ch === inside) inside = null;
    } else if (ch === '"' || ch === "'") {
      inside = ch;
      item += ch;
    } else if (ch === ',') {
      out.push(item);
      item = '';
    } else item += ch;
  }
  out.push(item);
  return out.map((s) => unquote(s.trim())).filter(Boolean);
}

/**
 * The values a tail selects: `= a` one, `in (a, b)` several, none for no
 * tail. Null for a condition a checklist cannot draw — `!= a`, `is empty`
 * typed in Advanced — which stays as written until someone ticks a value.
 */
export function selectedValues(tail: string): string[] | null {
  const t = squeeze(tail);
  if (!t) return [];
  if (t.startsWith('= ')) return [unquote(t.slice(2))];
  const list = /^in\s*[([](.*)[)\]]$/i.exec(t);
  return list ? listItems(list[1]) : null;
}

/** The tail for a set of ticked values: one is an equality, several an `in`, none no condition. */
export function valuesTail(values: readonly string[]): string {
  if (!values.length) return '';
  if (values.length === 1) return `= ${quote(values[0])}`;
  return `in (${values.map((value) => quote(value)).join(', ')})`;
}

/**
 * The tags a record's-tags tail asks for: `has a` one, `has (a, b)` any of
 * several, none for no tail. Null for anything else typed by hand.
 */
export function selectedTags(tail: string): string[] | null {
  const t = squeeze(tail);
  if (!t) return [];
  const list = /^has\s*[([](.*)[)\]]$/i.exec(t);
  if (list) return listItems(list[1]);
  const one = /^has\s+(.+)$/i.exec(t);
  return one ? [unquote(one[1].trim())] : null;
}

/** The tail for a set of ticked tags: a record that has any of them. */
export function tagsTail(values: readonly string[]): string {
  if (!values.length) return '';
  if (values.length === 1) return `has ${quote(values[0])}`;
  return `has (${values.map((value) => quote(value)).join(', ')})`;
}

/* A date column's meaning, read off its name and default — the signals a
   catalog carries. A stamp records when something happened (`created_at`,
   `signed_up_on`, a `DEFAULT CURRENT_TIMESTAMP`): it is only ever in the
   past, so it is asked about windows behind today. A deadline says when
   something is due (`due_on`, `expires_at`, `ship_by`): it is asked what is
   overdue and what is coming. Anything else — a birthday, a start date — is
   asked about the days on either side of today. */
const STAMP =
  /^(sys_)?(created|inserted|added|opened|raised|issued|ordered|received|signed_up|joined|updated|modified|changed|last_updated|submitted|sent|posted|published|logged|recorded|completed|closed|resolved|shipped|delivered|paid|approved|signed|happened|occurred|deleted|archived|last_[a-z]+)(_at|_on|_date|_time)?$/i;
const DEADLINE =
  /(^|_)(due|deadline|expires?|expiry|expiration|ship_by|respond_by|needed_by|renews?|renewal|follow_up|valid_until|until)(_|$)/i;
const STAMPED_DEFAULT = /current_timestamp|current_date|now\(\)|localtimestamp|getdate|sysdate/i;

type DateMeaning = 'stamp' | 'deadline' | 'date';

/** What a date column is to the reader: a stamp of the past, a deadline, or a plain date. */
export function dateMeaning(column: (Pick<ColumnMeta, 'name'> & Partial<Pick<ColumnMeta, 'default'>>) | undefined): DateMeaning {
  const name = column?.name.split('.').pop() ?? '';
  if (DEADLINE.test(name)) return 'deadline';
  if (STAMP.test(name) || (column?.default !== undefined && STAMPED_DEFAULT.test(column.default))) return 'stamp';
  return 'date';
}

/* The windows each kind of date is asked about, in the query language's own
   phrases, which resolve on the server, so a link means the same thing
   tomorrow. "Overdue" is before today, and is offered only on a deadline:
   on a `created_at` it was every row. */
const PRESETS: Record<DateMeaning, ReadonlyArray<readonly [label: string, tail: string]>> = {
  stamp: [
    [say('common.today'), '= today'],
    [say('thisWeek'), '= this week'],
    [say('last7Days'), '= last 7 days'],
    [say('last30Days'), '= last 30 days'],
  ],
  deadline: [
    [say('overdue'), '< today'],
    [say('common.today'), '= today'],
    [say('thisWeek'), '= this week'],
    [say('next7Days'), '= next 7 days'],
  ],
  date: [
    [say('common.today'), '= today'],
    [say('thisWeek'), '= this week'],
    [say('last7Days'), '= last 7 days'],
    [say('next7Days'), '= next 7 days'],
  ],
};

/** A date facet's presets, fitted to what the column means; "No date" only where the column may be empty. */
export function datePresets(
  column: (Pick<ColumnMeta, 'name'> & Partial<Pick<ColumnMeta, 'default' | 'nullable'>>) | undefined,
): ReadonlyArray<readonly [label: string, tail: string]> {
  const presets = PRESETS[dateMeaning(column)];
  return column?.nullable === false ? presets : [...presets, [say('noDate'), 'is empty']];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The ends of a date range a tail says, '' for an open end; both '' for a tail that is not a range. */
export function rangeOf(tail: string): { from: string; to: string } {
  const t = squeeze(tail);
  const between = /^between\s+(\S+)\s+and\s+(\S+)$/i.exec(t);
  if (between && ISO_DATE.test(unquote(between[1])) && ISO_DATE.test(unquote(between[2]))) {
    return { from: unquote(between[1]), to: unquote(between[2]) };
  }
  const end = /^(>=|<=)\s*(\S+)$/.exec(t);
  if (end && ISO_DATE.test(unquote(end[2]))) return end[1] === '>=' ? { from: unquote(end[2]), to: '' } : { from: '', to: unquote(end[2]) };
  return { from: '', to: '' };
}

/** A range as a tail: both ends inclusive, in order whichever end was set first; one end is a bound. */
export function rangeTail(from: string, to: string): string {
  const [a, b] = from && to && from > to ? [to, from] : [from, to];
  if (a && b) return `between ${a} and ${b}`;
  if (a) return `>= ${a}`;
  if (b) return `<= ${b}`;
  return '';
}

/* The view's standing condition and the reader's filter, as one condition. */
const both = (standing: string, filter: string) => {
  const [a, b] = [squeeze(standing), squeeze(filter)];
  return a && b ? andQuery(a, b) : a || b;
};

/**
 * The breakdown that counts a facet's values under everything else the
 * list asks. The facet's own condition is left out — the usual faceted
 * count, so a second value is offered with what ticking it would add — and
 * so are the sort and the page, which a count does not have. A reference is
 * grouped by its id and said by its target's label path. The view's
 * standing condition (`status != sold`) is the list's and stays: the reader's
 * question hides it, and a count without it counted rows the list never shows.
 */
export function facetCountText(table: string, refinement: string, column: string, labelPath?: string, standing = ''): string {
  const filter = splitQuery(`${table} ${stripCondition(refinement, column)}`).filter ?? '';
  return squeeze(`${table} ${both(standing, filter)} count by ${[column, labelPath].filter(Boolean).join(', ')} sort count desc`);
}

/**
 * How many of the list's records one value of a `has` facet would show
 * (shared/listFilters.ts): the list's rows, under everything else it asks,
 * with one of the rows that point at each holding the value — records, never
 * those rows, so an account with three won deals counts once. One count per
 * value, since a record is under every value one of its rows holds.
 */
export function hasCountText(table: string, refinement: string, key: string, standing = '', value?: string): string {
  const filter = splitQuery(`${table} ${stripCondition(refinement, key)}`).filter ?? '';
  const asked = value === undefined ? key : `${key} = ${quote(value)}`;
  return squeeze(`${table} ${andQuery(both(standing, filter), asked)} count`);
}

/** The values a `has` facet lists: those the rows that point at the record hold, the most held first, by name where they are references. */
export function hasValuesText(child: string, column: string, labelPath?: string): string {
  return squeeze(`${child} count by ${[column, labelPath].filter(Boolean).join(', ')} sort count desc`);
}

/* ---------- a facet's shape ---------- */

/**
 * A column with no vocabulary, flag, date or reference shows as what its
 * values are. Asked once, of the view's standing rows alone — not of the
 * reader's narrowing, or a price would turn into a checklist of the dozen
 * prices a filter left. A number with more than RANGE_ABOVE distinct values is
 * a range; a few (a priority, a model year) a checklist; text with at most
 * CHECKLIST_MOST values a checklist, more a contains box.
 */
const RANGE_ABOVE = 12;
export const CHECKLIST_MOST = 50;
export type AutoShape = 'values' | 'range' | 'text';

/** The breakdown a facet's shape is judged by: every value of the column the view shows. */
export function facetShapeText(table: string, column: string, standing = ''): string {
  return squeeze(`${table} ${squeeze(standing)} count by ${column} sort count desc`);
}

/** A column's facet from how many values it has; `complete` is false when there were more than were asked for. */
export function autoShape(numeric: boolean, distinct: number, complete: boolean): AutoShape {
  if (numeric) return complete && distinct <= RANGE_ABOVE ? 'values' : 'range';
  return complete && distinct <= CHECKLIST_MOST ? 'values' : 'text';
}

/* ---------- a number's range ---------- */

const NUMBER = /^-?\d+(?:\.\d+)?$/;

/** The ends of a number range a tail says, '' for an open end; both '' for a tail that is not one. */
export function numberRangeOf(tail: string): { min: string; max: string } {
  const t = squeeze(tail);
  const between = /^between\s+(\S+)\s+and\s+(\S+)$/i.exec(t);
  if (between && NUMBER.test(between[1]) && NUMBER.test(between[2])) return { min: between[1], max: between[2] };
  const end = /^(>=|<=)\s*(\S+)$/.exec(t);
  if (end && NUMBER.test(end[2])) return end[1] === '>=' ? { min: end[2], max: '' } : { min: '', max: end[2] };
  return { min: '', max: '' };
}

/** A number range as a tail: both ends inclusive and in order, one end a bound, a non-number ignored. */
export function numberRangeTail(min: string, max: string): string {
  const [lo, hi] = [min.trim(), max.trim()].map((end) => (NUMBER.test(end) ? end : ''));
  const [a, b] = lo && hi && Number(lo) > Number(hi) ? [hi, lo] : [lo, hi];
  if (a && b) return `between ${a} and ${b}`;
  if (a) return `>= ${a}`;
  if (b) return `<= ${b}`;
  return '';
}

/** Whether a facet says anything beyond the lit tab: the tab's own condition is the tab's to show. */
export function facetActive(refinement: string, column: string, tabQuery = ''): boolean {
  const tail = squeeze(conditionTail(refinement, column));
  // A whole-condition filter (`any opportunity where open`) has no tail: it is on where it is said.
  if (!tail) return holdsCondition(refinement, column) && !holdsCondition(tabQuery, column);
  return tail !== squeeze(conditionTail(tabQuery, column));
}

/** Every facet's own conditions out, the lit tab's left standing: Clear all empties the rail, not the tab. */
export function clearFacets(refinement: string, columns: readonly string[], tabQuery = ''): string {
  return columns.reduce((text, column) => (facetActive(text, column, tabQuery) ? stripCondition(text, column) : text), squeeze(refinement));
}

/* ---------- the rarer conditions ---------- */

/** A condition a facet keeps behind "More conditions": its word, and whether it takes text. */
export type MoreCondition = 'startswith' | 'like' | 'empty' | 'notempty';
export const MORE_LABELS: Record<MoreCondition, string> = {
  startswith: say('starts'),
  like: say('matchesAPattern'),
  empty: say('isEmpty'),
  notempty: say('isNotEmpty'),
};
export const takesText = (condition: MoreCondition) => condition === 'startswith' || condition === 'like';

/**
 * What a facet offers behind its "More conditions": text is asked what it
 * starts with and a pattern — not a vocabulary, whose values are a list to
 * pick from; a column that may be empty, whether it is. A
 * date's "No date" preset already asks for empty, so it is not asked twice;
 * a source that takes whole values only (an API) is asked nothing more.
 */
export function moreConditions(
  facet: 'values' | 'flag' | 'date' | 'text',
  column: { type?: string; nullable?: boolean; allowed?: readonly string[] } | undefined,
  exact = false,
): MoreCondition[] {
  if (exact || !column) return [];
  const text = /char|text|string|clob|citext/i.test(column.type ?? '') && !column.allowed?.length;
  const out: MoreCondition[] = text && facet !== 'flag' ? ['startswith', 'like'] : [];
  if (column.nullable !== false) {
    if (facet !== 'date') out.push('empty');
    out.push('notempty');
  }
  return out;
}

/** Which of them a tail says, with its text; null for a tail that is none of them. */
export function moreOf(tail: string): { condition: MoreCondition; text: string } | null {
  const t = squeeze(tail);
  if (t === 'is empty') return { condition: 'empty', text: '' };
  if (t === 'is not empty') return { condition: 'notempty', text: '' };
  const said = /^(startswith|like)\s+(.+)$/i.exec(t);
  return said ? { condition: said[1].toLowerCase() as MoreCondition, text: unquote(said[2]) } : null;
}

/** The tail for a rarer condition; '' for one that takes text and has none yet. */
export function moreTail(condition: MoreCondition, text = ''): string {
  if (condition === 'empty') return 'is empty';
  if (condition === 'notempty') return 'is not empty';
  const value = text.trim();
  return value ? `${condition} ${quote(value)}` : '';
}
