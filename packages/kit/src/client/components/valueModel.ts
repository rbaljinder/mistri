/**
 * How a value is said, before it is drawn.
 *
 * The record view and the page view each grew their own idea of what a
 * value looks like, and the page's was the worse one. This is the one rule
 * book: the grid's planner classifies, a display rule from the app dresses,
 * and everything below is a pure decision the components render.
 */
import { richTextExcerpt, richTextImageAddress } from '@mistriwork/engine/shared/richText.js';
import { MASK, displayWord, vocabularyWord } from '@mistriwork/engine/shared/model.js';
import {
  defaultCurrency,
  formatDate,
  formatDateTime,
  formatLocale,
  formatMoney,
  formatNumber,
  formatPercent,
  formatRelativeDay,
  daysFromToday,
  NEAR_DAYS,
  sayNearDay,
  withPercentSign,
} from '../locale.js';
import { minorFigure } from '@mistriwork/engine/shared/money.js';
export { yesNoRule } from '../yesNoRule.js';
import { unitWord } from '@mistriwork/engine/shared/unitWord.js';
import { planColumn } from '../columns.js';
import { leadTonePath, subtitlePath } from '@mistriwork/engine/shared/subtitlePath.js';
import type { ColumnMeta } from '@mistriwork/engine/shared/schema.js';
import { say } from '../copy/record/components/valueModel.js';
import { shellBody } from '../shellHost.js';

export interface DisplayRule {
  /** The face the column's values are set in (`display: { vin: { face: 'code' } }`). */
  face?: 'data' | 'ui' | 'code';
  format?: 'money' | 'percent' | 'number' | 'relative' | string;
  /** A due date's row is still open (dueOpen.ts), set by whoever draws it from the row, as a row's currency is:
      a `relative` date that has passed is then overdue. Never authored. */
  open?: boolean;
  /** A `relative` column whose values are not all near today: every one is its date, none "6 days ago" beside a date
      (centsAmong decides it for the values drawn together). Never authored. */
  absolute?: true;
  currency?: string;
  /** `currency: { column }`: the column of the row its currency code is read from (money.ts). */
  currencyColumn?: string;
  /** Money kept as minor units: 1999 is said as 19.99 dollars, in the currency's own decimals. */
  minor?: true;
  tone?: Record<string, string>;
  bar?: boolean;
  max?: number;
  /** An initials disc; given a file resource of photos, the record's photo where there is one (avatarPhotos.tsx). */
  avatar?: boolean | { from: string; whose: string; sort?: string };
  /** Value → an App icon before the word, where a tone's dot would stand. */
  icons?: Record<string, string>;
  /** Value → the word it is said as; the stored value keys `tone` and `icons` still. */
  values?: Record<string, string>;
  /** Every value no `values` key names, said as words (`IN_REVIEW` → "In review"). */
  humanize?: boolean;
  subtitle?: string;
  /** A mark in a tinted square before the value; `tone` names the column whose rule tints it per row. */
  icon?: { mark: string; toneOf?: string };
  /** Value → the theme's chart color it is drawn in (1–8): a board card's category stripe and chip. */
  colors?: Record<string, number>;
  unit?: string;
  /** true masks every value; `{ prefix }` only the values starting with it, the rest dressing by the rule as usual. */
  masked?: true | { prefix: string };
  /** A value renderer: the App's component draws the value (valueRenderers.tsx); the rest of the rule dresses it meanwhile. */
  component?: { id: string };
  /** With format "richText": who an @ names, and the file resource a picture is kept in (resolved table ids). */
  mentions?: {
    from: string;
    by: string;
    labelColumn?: string;
    groups?: { from: string; by: string; labelColumn?: string; through?: string };
  };
  images?: string;
  /** With format "rating": the stars of its scale. */
  outOf?: number;
  /** With format "percent": a ring beside the figure. */
  ring?: boolean;
  /** A number edited along its range; drawn as the number. */
  slider?: { min: number; max: number; step?: number };
  /** A text read by the camera where it can be; drawn as the text. */
  scan?: boolean;
  /** A signature kept as a row of a file resource (its table id and key column): drawn as the picture. */
  signature?: true | { table: string; key: string };
  /**
   * Money drawn among others (a grid's column, a card list's field, a metric strip): whether the set says its cents.
   * Never authored; the drawer works it out with `centsAmong`. Left out, a figure says its cents only if it has some.
   */
  cents?: boolean;
}

/** Whether a figure in the major unit has cents that are not zero. */
function fractional(major: unknown): boolean {
  const n = Number(major);
  return Number.isFinite(n) && Math.round(n * 100) % 100 !== 0;
}

/** A stored money value's cents: minor units are read in the major unit first. */
function hasCents(rule: DisplayRule, value: unknown): boolean {
  return fractional(rule.minor ? (minorFigure(value, rule.currency || defaultCurrency()) ?? value) : value);
}

/**
 * Whether a set of money figures drawn together says its cents: only where one of them has some. "$24,495" down a
 * column of prices, not "$24,495.00"; a column holding $0.00 and $24.50 says every figure to the cent, so "$24"
 * never stands beside "$0.50". Anything not money keeps its rule unchanged.
 */
export function centsAmong<R extends DisplayRule | null | undefined>(rule: R, values: readonly unknown[]): R {
  /* A relative date follows the same law: one way to say the column. Said from today only where every value is near
     (a sentence of days), else every one is its date and the phrase stays its tooltip. */
  if (rule?.format === 'relative') {
    const far = values.some((value) => {
      if (value === null || value === undefined || value === '') return false;
      const days = daysFromToday(String(value));
      return days !== null && Math.abs(days) > NEAR_DAYS;
    });
    if (!far) return rule;
    return (apart.get(rule) ?? (apart.set(rule, { ...rule, absolute: true }), apart.get(rule)!)) as R;
  }
  if (!rule || rule.format !== 'money') return rule;
  const cents = values.some((value) => value !== null && value !== undefined && value !== '' && hasCents(rule, value));
  /* The same object for the same rule and answer: a grid keeps its columns while they are equal by identity, and a
     fresh rule every paint redrew every cell on a keystroke. */
  const known = settled.get(rule) ?? {};
  settled.set(rule, known);
  return (known[String(cents) as 'true' | 'false'] ??= { ...rule, cents }) as R;
}
const settled = new WeakMap<DisplayRule, { true?: DisplayRule; false?: DisplayRule }>();
const apart = new WeakMap<DisplayRule, DisplayRule>();

/**
 * Whether the money a record shows together — its fields, its headline — says its cents: where one figure has some,
 * every one does, so "$89" never stands beside "$145.45" on one page as it would where each figure decided alone.
 * Undefined where none of them is money, which leaves each value its own say.
 */
export function centsTogether(figures: ReadonlyArray<readonly [DisplayRule | null | undefined, unknown]>): boolean | undefined {
  const money = figures.filter(([rule, value]) => rule?.format === 'money' && value !== null && value !== undefined && value !== '');
  return money.length ? money.some(([rule, value]) => hasCents(rule!, value)) : undefined;
}

/** A money figure, already in its major unit, in its rule's form: to the cent where it (or its set) has cents, else whole. */
function moneyText(rule: DisplayRule, value: number | string): string {
  const cents = rule.cents ?? fractional(value);
  return formatMoney(value, rule.currency, cents ? {} : { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

/**
 * The word a rule says a stored value as: the author's own (`values`), the
 * value made words where the rule says `humanize` (`IN_REVIEW` → "In
 * review"), or undefined where the rule says neither. Own keys only, as
 * everywhere a stored value names a key.
 */
export function wordFor(rule: DisplayRule | null | undefined, text: string): string | undefined {
  return displayWord(rule, text);
}

/**
 * A vocabulary value as a picker, a filter or a chip names it in an App: the
 * rule's own word first, else the value made words as a tone chip makes it,
 * so a form's select, a filter rail and the grid say one thing for one value.
 */
export function choiceWord(rule: DisplayRule | null | undefined, value: string): string {
  return wordFor(rule, value) ?? vocabularyWord(value);
}

/* The spellings a true/false column's value reaches a rule as: the engine's
   own (`true` on Postgres, `1` on SQLite) and the others an author may key. */
const TRUTH = { yes: ['true', '1', 't'], no: ['false', '0', 'f'] } as const;

/**
 * The words a true/false column's editor offers, as its display says them: the
 * rule's word for the value the editor writes, else for another spelling of
 * the same truth (`values: { true: 'On', false: 'Off' }` over a SQLite 1/0).
 * A side the rule does not name is undefined, and the editor says Yes or No there.
 */
export function booleanWords(rule: DisplayRule | null | undefined, choices: { yes: string; no: string }): { yes?: string; no?: string } {
  const side = (stored: string, spellings: readonly string[]) =>
    [stored, ...spellings].map((text) => (rule?.values && Object.hasOwn(rule.values, text) ? rule.values[text] : undefined)).find(Boolean);
  return { yes: side(choices.yes, TRUTH.yes), no: side(choices.no, TRUTH.no) };
}

/**
 * What the rest of a rule says of a value, for a value renderer that draws it
 * in the rule's place: the tone its pill would wear and the word it would say.
 * A renderer is handed these, so an author's component keeps the rule's
 * colour and words instead of starting over from the stored value.
 */
export function ruleSays(rule: DisplayRule | null | undefined, value: unknown): { tone?: string; word?: string } {
  if (!rule || value === null || value === undefined) return {};
  const text = String(value);
  const tone = toneFor(rule, value, text);
  const word = wordFor(rule, text);
  return { ...(tone ? { tone } : {}), ...(word !== undefined ? { word } : {}) };
}

/** Vocabulary captions only: identifiers and arbitrary grouped text stay exact.
 * A toned value is a word everywhere; a value of the column's own vocabulary
 * (`allowed`) is a word in an App, where the Workbench shows the data.
 * Callers keep the raw key for navigation and aggregation. */
export function groupLabel(rule: DisplayRule | null | undefined, value: unknown, allowed?: readonly string[]): string {
  if (value == null) return '—';
  const text = String(value);
  const vocabulary = allowed?.includes(text) && typeof document !== 'undefined' && shellBody()?.classList.contains('app-mode');
  return wordFor(rule, text) ?? (rule?.tone || vocabulary ? vocabularyWord(text) : text);
}

/* The path a shown column's second line reads: shared, since a list's
   question fetches it (shared/subtitlePath.ts). */
export { subtitlePath, leadTonePath };

/** A figure and its unit: "85,780 mi", "$242/mo" when the unit opens with a slash, and "100%" (a reader in Paris
    reads "100 %") when it is a percent sign, placed as the locale places it. */
export function withUnit(figure: string, unit: string | undefined): string {
  if (!unit) return figure;
  if (unit === '%') return withPercentSign(figure);
  if (unit.startsWith('/')) return `${figure}${unit}`;
  return `${figure} ${unitWord(figure, unit)}`;
}

/** The tone a rule gives a value: an exact key first, then — for a numeric
    value — the first satisfied threshold key (">= 90"), in the order the
    author wrote them; "*" for every value no other key names, which wears
    `neutral` where the map says nothing. */
function toneFor(rule: DisplayRule, value: unknown, text: string): string | null {
  if (!rule.tone) return null;
  /* Own keys only: a cell that reads `constructor` found the prototype's
     function through a plain property read. */
  const exact = Object.hasOwn(rule.tone, text) ? rule.tone[text] : undefined;
  if (exact) return exact;
  const rest = Object.hasOwn(rule.tone, '*') ? rule.tone['*'] : text.trim() ? 'neutral' : null;
  const n = Number(value);
  if (!Number.isFinite(n)) return rest;
  for (const [key, tone] of Object.entries(rule.tone)) {
    const m = /^(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)$/.exec(key);
    if (!m) continue;
    const bound = Number(m[2]);
    const hit = m[1] === '>=' ? n >= bound : m[1] === '<=' ? n <= bound : m[1] === '>' ? n > bound : n < bound;
    if (hit) return tone;
  }
  return rest;
}

/** What a display rule makes of a value, or null when the rule does not reach it. */
export type Dress =
  /* `figure`: the value is a number or an amount, which a tone colours and never boxes or dots (docs/design.md, rule 6). */
  | { kind: 'tone'; tone: string; text: string; label: string; icon?: string; figure?: true }
  | { kind: 'mark'; icon: string; text: string; label: string }
  | { kind: 'word'; text: string; label: string }
  | { kind: 'money'; text: string; title: string }
  | { kind: 'percent'; text: string; bar?: number; ring?: number }
  /* Stars: `value` whole ones of `outOf`, toned where the rule says; `text` says it in words. */
  | { kind: 'rating'; value: number; outOf: number; tone: string | null; text: string }
  | { kind: 'color'; hex: string; text: string }
  /* A JSON document: `text` as stored, `excerpt` its one line. */
  | { kind: 'json'; text: string; excerpt: string }
  | { kind: 'qr'; text: string }
  /* A signature: the stored picture's address; `text` says it was signed. */
  | { kind: 'signature'; src: string; text: string }
  | { kind: 'number'; text: string; title: string }
  | { kind: 'relative'; text: string; title: string; overdue?: true }
  | { kind: 'meter'; text: string; fill: number; tone: string | null; title: string }
  | { kind: 'avatar'; text: string; initials: string; hue: number; photo?: string }
  | { kind: 'items'; items: string[]; text: string }
  /* The people on a thing: the first few as overlapping discs, the rest counted; `text` names every one. */
  | { kind: 'avatars'; names: string[]; more: number; text: string }
  /* `html` is the stored value, drawn through the allowlist (RichText.tsx); `text` its words in one line. */
  | { kind: 'richText'; html: string; text: string }
  /* `text` is the placeholder, never the value: a caller that says a dress as text says the mask. */
  | { kind: 'masked'; text: string };

/**
 * The placeholder a rule draws instead of this value — `masked: true`, or a
 * value starting with the rule's `masked.prefix`, said as that prefix and the
 * mask — or undefined when the rule leaves the value be. Presentation only:
 * the value is in the browser; `hidden` is what keeps a column out of it.
 */
export function maskedText(rule: Pick<DisplayRule, 'format' | 'masked'> | null | undefined, value: unknown): string | undefined {
  if (!rule || value === null || value === undefined || value === '') return undefined;
  if (rule.masked === true) return MASK;
  const prefix = rule.masked?.prefix;
  return prefix && String(value).startsWith(prefix) ? `${prefix}${MASK}` : undefined;
}

/** Up to two initials, from the first two words that have a letter or digit. */
export function initialsOf(text: string): string {
  const words = text
    .trim()
    .split(/[\s._-]+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word));
  return (
    words
      .slice(0, 2)
      .map((word) => [...word.replace(/[^\p{L}\p{N}]/gu, '')][0] ?? '')
      .join('')
      .toUpperCase() || '?'
  );
}

const DURATION_UNITS = [
  ['days', 86_400, 'd'],
  ['hours', 3_600, 'h'],
  ['minutes', 60, 'm'],
  ['seconds', 1, 's'],
] as const;

/**
 * A number of seconds said as its two largest units — "2h 15m", "3d 4h",
 * "45s" — in the reader's locale where the runtime can say a duration, and
 * in the narrow units everywhere else. Two units, because a time left or a
 * time taken is read at a glance; the stored seconds stay in the title.
 */
export function sayDuration(seconds: number, locale?: string): string {
  const sign = seconds < 0 ? '−' : '';
  let rest = Math.round(Math.abs(seconds));
  const parts: Array<{ unit: (typeof DURATION_UNITS)[number][0]; count: number; mark: string }> = [];
  for (const [unit, size, mark] of DURATION_UNITS) {
    const count = Math.floor(rest / size);
    rest -= count * size;
    if (count && parts.length < 2) parts.push({ unit, count, mark });
    else if (parts.length) break;
  }
  if (!parts.length) parts.push({ unit: 'seconds', count: 0, mark: 's' });
  const Format = (Intl as unknown as { DurationFormat?: new (locale?: string, options?: object) => { format: (d: object) => string } })
    .DurationFormat;
  if (Format) {
    try {
      return sign + new Format(locale, { style: 'narrow' }).format(Object.fromEntries(parts.map(({ unit, count }) => [unit, count])));
    } catch {
      /* the narrow units below */
    }
  }
  return sign + parts.map(({ count, mark }) => `${count}${mark}`).join(' ');
}

/** One of eight palette slots, fixed by the text, so a name keeps its colour everywhere. */
export function hueOf(text: string): number {
  let h = 0;
  for (const ch of text) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return h % 8;
}

/* Three faces and a count: a fourth disc would crowd a card's footer without naming anyone the count does not. */
const AVATAR_STACK = 3;

/** The names in a people value: an array (Postgres hands one back), a JSON array as text, or one name per line or comma. */
function namesOf(value: unknown): string[] {
  let list: unknown = value;
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      list = JSON.parse(value);
    } catch {
      list = value;
    }
  }
  const items = Array.isArray(list) ? list.map((item) => (item == null ? '' : String(item))) : String(list).split(/\r?\n|,/);
  return items.map((item) => item.trim()).filter(Boolean);
}

/** The author's word for a figure: the `values` key that reads as the same number. */
function figureWord(rule: DisplayRule, n: number): string | undefined {
  const key = Object.keys(rule.values ?? {}).find((k) => k.trim() !== '' && Number(k) === n);
  return key === undefined ? undefined : rule.values?.[key];
}

/** The icon a rule gives a value: its exact key only — a mark names a word of the vocabulary, never a range. */
function iconFor(rule: DisplayRule, text: string): string | undefined {
  return rule.icons && Object.hasOwn(rule.icons, text) ? rule.icons[text] : undefined;
}

/**
 * A display rule as an author writes it (`<Value display>`, a fixture's rules) in the shape the dressers read: the
 * DSL's `bar: 5` is a bar filled against 5, which the resource parser keeps as `bar: true` and `max: 5`.
 */
export function authoredDisplay(rule: (Omit<DisplayRule, 'bar'> & { bar?: boolean | number }) | null | undefined): DisplayRule | null {
  if (!rule) return null;
  const { bar, ...rest } = rule;
  return typeof bar === 'number' ? { ...rest, bar: true, max: bar } : { ...rest, ...(bar === undefined ? {} : { bar }) };
}

export function dressFor(rule: DisplayRule | null | undefined, value: unknown): Dress | null {
  if (!rule || value === null || value === undefined) return null;
  const mask = maskedText(rule, value);
  if (mask !== undefined) return { kind: 'masked', text: mask };
  if (rule.format === 'avatars') {
    const names = namesOf(value);
    if (!names.length) return null;
    return { kind: 'avatars', names: names.slice(0, AVATAR_STACK), more: Math.max(0, names.length - AVATAR_STACK), text: names.join(', ') };
  }
  /* Minor units are said as the major figure, exact text: 1999 cents is "19.99" and keeps its cents. */
  if (rule.minor && rule.format === 'money') value = minorFigure(value, rule.currency || defaultCurrency()) ?? value;
  const text = String(value);
  if (rule.signature && typeof rule.signature === 'object' && text.trim())
    return { kind: 'signature', src: richTextImageAddress(rule.signature.table, { [rule.signature.key]: text }), text: say('signed') };
  const own = ownDrawing(rule, value, text);
  if (own !== undefined) return own;
  const tone = toneFor(rule, value, text);
  const n = Number(value);
  /* A meter says the number beside a bar against its max; a tone colours
     the bar instead of becoming a pill. */
  if (rule.bar && rule.max !== undefined && rule.format !== 'percent' && Number.isFinite(n) && Number.isSafeInteger(Math.trunc(n))) {
    const said = rule.format === 'money' ? moneyText(rule, n) : formatNumber(n);
    return {
      kind: 'meter',
      text: said,
      fill: Math.max(0, Math.min(100, (n / rule.max) * 100)),
      tone,
      title: say('textOfMax', { text, max: rule.max }),
    };
  }
  /* A numeric string past 2^53 falls through on purpose: Number() would
     round it, and a formatted wrong number beats an unformatted right one
     nowhere. */
  const safe = Number.isFinite(n) && Number.isSafeInteger(Math.trunc(n));
  /* A toned figure is still a figure: the pill says "104 h" and "$1,200",
     as the same value says untoned, not the bare stored digits. A word is
     said as the vocabulary says it. */
  /* A figure is a figure: its tone is the ink it is set in, nothing before it, so a column of amounts keeps one left
     edge. A neutral one is no tone at all ("$0" with a grey dot said nothing, and moved the figure off its label's edge). */
  const figured = tone
    ? !safe || text.trim() === ''
      ? false
      : rule.format === 'money' || rule.format === 'percent' || rule.format === 'number' || Boolean(rule.unit)
    : false;
  if (tone && !(figured && tone === 'neutral')) {
    const figure =
      !safe || text.trim() === ''
        ? null
        : rule.format === 'money'
          ? withUnit(moneyText(rule, typeof value === 'string' ? text : n), rule.unit)
          : rule.format === 'percent'
            ? formatPercent(n)
            : rule.format === 'number' || rule.unit
              ? withUnit(formatNumber(n), rule.unit)
              : null;
    const icon = iconFor(rule, text);
    return {
      kind: 'tone',
      tone,
      text,
      label: figure ?? wordFor(rule, text) ?? vocabularyWord(text),
      ...(icon ? { icon } : {}),
      ...(figure !== null ? { figure: true as const } : {}),
    };
  }
  /* A mark with no tone: the icon in the caption's ink before the word, which stays the value. */
  const mark = iconFor(rule, text);
  if (mark) return { kind: 'mark', icon: mark, text, label: wordFor(rule, text) ?? vocabularyWord(text) };
  /* A word and nothing else: the author's word for the stored value, the value in the title. */
  const word = rule.format === undefined && !rule.bar && !rule.avatar ? wordFor(rule, text) : undefined;
  if (word !== undefined) return { kind: 'word', text, label: word };
  /* A figure the author names (`values: { 0: 'No charge' }`): a figure keys by its number, so a stored "0.00" finds 0. */
  const named =
    (rule.format === 'money' || rule.format === 'number' || rule.format === 'percent') && safe && text.trim()
      ? figureWord(rule, n)
      : undefined;
  if (named !== undefined) return { kind: 'word', text, label: named };
  /* To the cent where the figure or its set has cents (centsAmong), else whole: "5294.00" alone is $5,294. */
  if (rule.format === 'money' && safe)
    return { kind: 'money', text: withUnit(moneyText(rule, typeof value === 'string' ? text : n), rule.unit), title: text };
  if (rule.format === 'percent' && safe) {
    const said = formatPercent(n);
    const fill = Math.max(0, Math.min(100, n));
    return rule.bar
      ? { kind: 'percent', text: said, bar: fill }
      : rule.ring
        ? { kind: 'percent', text: said, ring: fill }
        : { kind: 'percent', text: said };
  }
  /* A unit with no format is a number's: a numeric value says "85,780 mi", and a text one stays itself. */
  if ((rule.format === 'number' || (rule.format === undefined && rule.unit)) && safe && text.trim() !== '')
    return { kind: 'number', text: withUnit(formatNumber(n), rule.unit), title: text };
  /* A duration is a figure too: tabular, and the stored seconds in the title.
     An interval the database hands back as text is not a number, and stays itself. */
  if (rule.format === 'duration' && safe) return { kind: 'number', text: sayDuration(n, formatLocale()), title: `${text} s` };
  if (rule.format === 'richText') return { kind: 'richText', html: text, text: richTextExcerpt(text) };
  /* One item per line, said as a list; a text with no line in it is not one. */
  if (rule.format === 'items') {
    const items = text
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (items.length) return { kind: 'items', items, text: items.join(', ') };
  }
  if (rule.format === 'relative') {
    const said = formatRelativeDay(text);
    /* Said from today only while it is near: "2 weeks ago" on a ledger hides the date an accountant needs, and
       "6 months ago" is never what a due date is for. Past about two weeks the date is the text and the relative
       phrase its tooltip. */
    const days = daysFromToday(text);
    /* Passed while its row is still open: drawn in the warning tone, however it is said. */
    const overdue = rule.open === true && days !== null && days < 0 ? { overdue: true as const } : {};
    if (said && days !== null && (rule.absolute || Math.abs(days) > NEAR_DAYS))
      return { kind: 'relative', text: formatDate(text), title: said, ...overdue };
    if (said) return { kind: 'relative', text: said, title: text, ...overdue };
  }
  if (rule.avatar && text.trim()) return { kind: 'avatar', text, initials: initialsOf(text), hue: hueOf(text) };
  return null;
}

const HEX = /^#[0-9a-f]{6}$|^#[0-9a-f]{3}$/i;
const CLOCK = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/;
const MONTH = /^(\d{4})-(\d{2})(?:-\d{2})?/;

/**
 * The formats that draw a value their own way: stars, a swatch, a time of day, a month, a year, a JSON tree, a QR
 * code. Undefined for any other format; null where the value is not one the format can draw, which is then said as
 * itself, never guessed at.
 */
function ownDrawing(rule: DisplayRule, value: unknown, text: string): Dress | null | undefined {
  switch (rule.format) {
    case 'rating': {
      const outOf = rule.outOf ?? 5;
      const n = Number(value);
      if (text.trim() === '' || !Number.isFinite(n)) return null;
      const stars = Math.max(0, Math.min(outOf, Math.round(n)));
      return { kind: 'rating', value: stars, outOf, tone: toneFor(rule, value, text), text: say('starsOf', { stars, outOf }) };
    }
    case 'color':
      return HEX.test(text.trim()) ? { kind: 'color', hex: text.trim().toLowerCase(), text: text.trim() } : null;
    case 'time': {
      const m = CLOCK.exec(text.trim());
      if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
      const said = new Intl.DateTimeFormat(formatLocale(), { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(
        Date.UTC(2000, 0, 1, Number(m[1]), Number(m[2])),
      );
      return { kind: 'number', text: said, title: text };
    }
    case 'month': {
      const m = MONTH.exec(text.trim());
      if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return null;
      const said = new Intl.DateTimeFormat(formatLocale(), { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
        Date.UTC(Number(m[1]), Number(m[2]) - 1, 1),
      );
      return { kind: 'number', text: said, title: text };
    }
    /* A year is a name, not a quantity: 2026, never "2,026". */
    case 'year':
      return /^\d{1,4}$/.test(text.trim()) ? { kind: 'number', text: text.trim(), title: text } : null;
    case 'json': {
      const source = typeof value === 'string' ? text : JSON.stringify(value);
      let read: unknown;
      try {
        read = JSON.parse(source);
      } catch {
        return null;
      }
      /* A tree is of an object or a list; a bare number or word is said as itself. */
      if (!read || typeof read !== 'object') return null;
      return { kind: 'json', text: source, excerpt: source.replace(/\s+/g, ' ').slice(0, 120) };
    }
    case 'qr':
      return text.trim() ? { kind: 'qr', text } : null;
  }
  return undefined;
}

/** What a plain value is best shown as, by the grid's own planner on a row of one. */
export type Said =
  | { kind: 'boolean'; on: boolean; title: string }
  | { kind: 'number'; text: string; title?: string }
  | { kind: 'date'; text: string; title?: string }
  | { kind: 'long'; text: string }
  | { kind: 'opaque'; text: string; head: string }
  | { kind: 'text'; text: string; prose: boolean };

const OPAQUE = /^[A-Za-z0-9+/=_:.-]+$/;

/* A column whose name says it holds a year: `year`, `model_year`, `year_built`. */
const YEAR_NAME = /(^|_)(year|yr)(_|$)/i;

export function sayValue(col: ColumnMeta | undefined, value: unknown): Said {
  const type = (col?.type ?? '').toLowerCase();
  const text = String(value);
  const plan = planColumn(col, col?.name ?? '', [{ [col?.name ?? '']: value }]) as { kind: string; identifier?: boolean };
  if (plan.kind === 'boolean') {
    const on = value === true || value === 1 || value === '1' || value === 't';
    return { kind: 'boolean', on, title: text };
  }
  if (plan.kind === 'number' && Number.isFinite(Number(value))) {
    const n = Number(value);
    const overflow = typeof value === 'string' && /^-?\d+$/.test(value) && !Number.isSafeInteger(n);
    /* The grid groups a column when any of its values reaches 10,000, a
       reading one value cannot make: alone, 9495 the price and 2025 the year
       look alike. So every figure is grouped but a year's, which a column's
       name says, and 2025 reads 2025 on a page as it does in a row. Through
       a path (`vehicle_id.year`) the name is its last hop's: the whole path
       read "2,026". */
    const shown = overflow
      ? formatNumber(text)
      : plan.identifier
        ? text
        : formatNumber(n, { maximumFractionDigits: 6, useGrouping: !YEAR_NAME.test((col?.name ?? '').split('.').pop() ?? '') });
    return { kind: 'number', text: shown, title: shown === text ? undefined : text };
  }
  if (plan.kind === 'date' || /date|time/.test(type)) {
    /* Postgres hands back an ISO wire format, precise and unreadable: shown
       in the reader's words, a midnight as the day it is, the original kept
       in the title. A midnight with a zone is an instant, not a day, as the grid reads it (columns.js). */
    const midnight = /[ T]00:00(:00(\.0+)?)?$/.test(text);
    /* An App says a near day from today, the rest as the date, and the whole of it on hover, as its grid does. */
    const near = shellBody().classList.contains('app-mode') ? sayNearDay(text, !midnight) : null;
    if (near) return { kind: 'date', text: near.text, title: near.title };
    const shown = midnight ? formatDate(text) : formatDateTime(text);
    return { kind: 'date', text: shown, title: shown === text ? undefined : text };
  }
  /* Long text gets its own block; a value with a space is prose, one
     without is a token. */
  /* An unbroken run of key or ciphertext characters — base64, hex, a token
     after its `ENC:` — is nothing to read and cannot wrap: it walled the
     page. It is said by its start, the rest a click away. A key has digits
     in it, and an address is a link to follow, not a key. */
  if (text.length > 90 && OPAQUE.test(text) && /\d/.test(text) && !text.includes('://'))
    return { kind: 'opaque', text, head: text.slice(0, 24) };
  /* A text written on several lines is read as typed, one line per line — a checklist, an address — whatever its
     length; drawn inline, its lines ran together. */
  if (text.length > 90 || /\n/.test(text.trim())) return { kind: 'long', text };
  return { kind: 'text', text, prose: /\s/.test(text.trim()) };
}

/** The values a reader acts on rather than reads: an address to write to, a number to call, a page to open. */
type LinkKind = 'email' | 'phone' | 'url';

const EMAIL = /^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]+$/;
const PHONE = /^\+?[\d\s().-]+$/;
const WEB = /^(https?:\/\/)?[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+(:\d+)?([/?#]\S*)?$/iu;
/* A column named like one of them, when no rule says: `email`, `work_email`,
   `phone`, `mobile_number`, `website`, `homepage_url`. */
const NAMED: Array<[RegExp, LinkKind]> = [
  [/(^|_)e_?mail(_address)?$/i, 'email'],
  [/(^|_)(phone|mobile|cell|telephone|tel)(_number|_no)?$/i, 'phone'],
  [/(^|_)(url|website|web_site|homepage|home_page)$/i, 'url'],
];

/**
 * A value as a link, when it is one: a rule's `format: 'email' | 'phone' |
 * 'url'`, or — where `infer` (an App) — a column named like one. Only a
 * value of the right shape is linked, so a note typed into an email column
 * stays text, and only https and http open: a column cannot hand the page a
 * `javascript:` address. The Workbench shows the data exactly and infers
 * nothing.
 */
export function linkFor(
  column: string | undefined,
  value: unknown,
  rule?: DisplayRule | null,
  infer = false,
): { kind: LinkKind; href: string; text: string } | null {
  if (value === null || value === undefined || typeof value === 'object') return null;
  const text = String(value).trim();
  if (!text) return null;
  const format = rule?.format;
  const name = column?.split('.').pop() ?? '';
  const kind: LinkKind | undefined =
    format === 'email' || format === 'phone' || format === 'url'
      ? format
      : infer && !format
        ? NAMED.find(([pattern]) => pattern.test(name))?.[1]
        : undefined;
  if (kind === 'email' && EMAIL.test(text)) return { kind, href: `mailto:${text}`, text };
  if (kind === 'phone' && PHONE.test(text) && text.replace(/\D/g, '').length >= 5)
    return { kind, href: `tel:${text.replace(/[^\d+]/g, '')}`, text };
  if (kind === 'url' && WEB.test(text)) {
    const href = /^https?:\/\//i.test(text) ? text : `https://${text}`;
    return { kind, href, text: text.replace(/^https?:\/\//i, '').replace(/\/$/, '') };
  }
  return null;
}
