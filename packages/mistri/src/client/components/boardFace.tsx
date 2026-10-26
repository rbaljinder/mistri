/**
 * What a board says on a lane's head and a card's lines, wherever the board
 * is drawn. A dashboard's board and a list's board were one board dressed two
 * ways: the dashboard's lanes said a status as a dot and its word and its
 * cards a toned priority, while the list's said the same values as plain
 * text. Both read a value through the column's display rule here.
 */
import type { ReactNode } from 'react';
import { columnDisplay } from '@mistriwork/kit/client/core.js';
import { defaultCurrency, formatLocale } from '@mistriwork/kit/client/locale.js';
import type { ColumnMeta } from '@mistriwork/engine/shared/schema.js';
import { choiceWord, dressFor, hueOf, sayValue, type DisplayRule } from '@mistriwork/kit/client/components/valueModel.js';
import { Dressed, Said } from '@mistriwork/kit/client/components/Dressed.js';
import { minorFigure } from '@mistriwork/engine/shared/money.js';

/** A value as its column's display rule dresses it, or null where the rule says nothing about it. */
export function dressedValue(table: string, column: string, value: unknown): ReactNode | null {
  const dress = dressFor(columnDisplay(table, column) as DisplayRule | null, value);
  return dress ? <Dressed dress={dress} compact /> : null;
}

/** A lane's word: what its column's display says the value is ("Negotiation" for `negotiate`), as its head says it,
    so a card's Move to menu, a lane's controls and its announcements name the lane the reader sees. */
export function laneWord(table: string, column: string, value: string): string {
  return choiceWord(columnDisplay(table, column) as DisplayRule | null, value);
}

/** A lane's name: the value's tone where its column gives one, else the words it is said in. */
export function laneMark(table: string, column: string, value: string, words: string): ReactNode {
  return dressedValue(table, column, value) ?? words;
}

/** A fact on a card's foot: the value as its column dresses it (as a plain value says it where no rule does), its words,
    and whether it is a person, who stands at the foot's end. */
export function cardFact(
  table: string,
  column: ColumnMeta | undefined,
  name: string,
  value: unknown,
): { node: ReactNode; text: string; person: boolean } {
  const rule = columnDisplay(table, name) as DisplayRule | null;
  const dress = dressFor(rule, value);
  if (!dress) {
    const said = sayValue(column, value);
    return { node: <Said col={column} value={value} compact app />, text: 'text' in said ? said.text : said.title, person: false };
  }
  const text = 'label' in dress ? dress.label : dress.text;
  return { node: <Dressed dress={dress} compact />, text, person: dress.kind === 'avatar' || dress.kind === 'avatars' };
}

/** Whether a column's rule draws its value as a person (an initials disc, or a stack of them). */
export function namesPerson(table: string, name: string): boolean {
  const rule = columnDisplay(table, name) as DisplayRule | null;
  return Boolean(rule?.avatar || rule?.format === 'avatars');
}

/** A card's kind: its value's word, and the series color its rule's `colors` names, else one fixed by its text. */
export function cardCategory(table: string, name: string, value: unknown): { label: string; color: number } | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const text = String(value);
  const rule = columnDisplay(table, name) as DisplayRule | null;
  const named = rule?.colors && Object.hasOwn(rule.colors, text) ? rule.colors[text] : undefined;
  return { label: choiceWord(rule, text), color: named ?? hueOf(text) + 1 };
}

/** The rule of a board's amount column where it says money or a number; null where the column is neither. */
export function amountRule(table: string, name: string | undefined): DisplayRule | null {
  if (!name) return null;
  const rule = columnDisplay(table, name) as DisplayRule | null;
  return rule?.format === 'money' || rule?.format === 'number' ? rule : null;
}

const NUMERIC = /^-?\d+(\.\d+)?$/;
const formats = new Map<string, Intl.NumberFormat>();
function formatter(options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const locale = formatLocale();
  const key = `${locale ?? ''} ${JSON.stringify(options)}`;
  let made = formats.get(key);
  if (!made) formats.set(key, (made = new Intl.NumberFormat(locale, options)));
  return made;
}

/**
 * An amount said short, as a board's cards and lane heads say it — $240K,
 * $1.25M — and in full for its title, in the App's locale and currency. The
 * value goes to Intl as the decimal text it is: an amount the adapters sent
 * as a string (a numeric column, a sum past 2^53) keeps every digit in the
 * title, where Number() would round it. A figure under a thousand is already
 * short and is said whole.
 */
export function shortAmount(value: unknown, rule: DisplayRule | null): { text: string; title: string } | null {
  const stored = typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!NUMERIC.test(stored)) return null;
  const money = rule?.format === 'money';
  /* Minor units are said as the major figure, exact text (money.ts). */
  const text = money && rule?.minor ? String(minorFigure(stored, rule.currency || defaultCurrency()) ?? stored) : stored;
  const base: Intl.NumberFormatOptions = money
    ? { style: 'currency', currency: rule?.currency || defaultCurrency() }
    : { maximumFractionDigits: 20 };
  /* Intl reads a decimal string exactly (ECMA-402 2023); the type says number. */
  const exact = text as unknown as number;
  const title = formatter(base).format(exact);
  const small = text.replace(/^-/, '').split('.')[0].length < 4;
  return {
    text: small
      ? title
      : formatter({ ...base, notation: 'compact', maximumSignificantDigits: 3, maximumFractionDigits: undefined }).format(exact),
    title,
  };
}
