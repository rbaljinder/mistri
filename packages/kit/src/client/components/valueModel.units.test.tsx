/**
 * A figure's unit, and a text of one item per line: "85,780 mi", "$237/mo",
 * and a car's features as a list where there is room and one line where
 * there is not.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { columnKind } from '../../../../engine/src/shared/schema.js';

vi.mock('../core.js', () => ({
  state: { schema: { tables: [], foreignKeys: [] } },
  columnDisplay: () => null,
  emptyWord: () => 'Empty',
  findTable: (id: string) => ({ id, name: id, columns: [] }),
  refsFrom: () => [],
  openRecord: () => {},
  columnKind,
}));

const { Dressed } = await import('./Value.js');
const { dressFor, sayDuration, withUnit } = await import('./valueModel.js');

afterEach(cleanup);

test('a duration is its two largest units, a unit with nothing under it ends the saying, and the seconds stay in the title', () => {
  const intl = Intl as unknown as { DurationFormat?: unknown };
  const format = intl.DurationFormat;
  // The narrow units every runtime can say, with the locale's formatter away.
  delete intl.DurationFormat;
  try {
    expect(sayDuration(8100)).toBe('2h 15m');
    expect(sayDuration(90_061)).toBe('1d 1h');
    expect(sayDuration(3_601)).toBe('1h');
    expect(sayDuration(45)).toBe('45s');
    expect(sayDuration(0)).toBe('0s');
    expect(sayDuration(-300)).toBe('−5m');
  } finally {
    if (format) intl.DurationFormat = format;
  }
  expect(sayDuration(8100, 'en-US')).toMatch(/2.*15/);
  expect(dressFor({ format: 'duration' }, 8100)).toMatchObject({ kind: 'number', title: '8100 s' });
  // An interval the database hands back as text is not a number of seconds.
  expect(dressFor({ format: 'duration' }, '1 day 02:00:00')).toBeNull();
});

test('a unit follows its figure, and a leading slash joins it', () => {
  expect(withUnit('85,780', 'mi')).toBe('85,780 mi');
  expect(withUnit('$242', '/mo')).toBe('$242/mo');
  expect(withUnit('7', undefined)).toBe('7');
  expect(withUnit('1', 'days')).toBe('1 day');
  expect(withUnit('2', 'days')).toBe('2 days');
  expect(withUnit('1.5', 'hours')).toBe('1.5 hours');
  expect(withUnit('1', 'lbs')).toBe('1 lbs');
  // A count noun is said singular for one, as a time unit is: "1 bike", never "1 bikes".
  expect(withUnit('1', 'bikes')).toBe('1 bike');
  expect(withUnit('2', 'bikes')).toBe('2 bikes');
  expect(withUnit('1', 'batteries')).toBe('1 battery');
  expect(withUnit('1', 'boxes')).toBe('1 box');
  expect(withUnit('1', 'inches')).toBe('1 inch');
  expect(withUnit('1', 'mins')).toBe('1 min');
  // An abbreviation, or a word whose own "s" ends it, is said as written.
  for (const kept of ['pcs', 'hrs', 'kWh', 'glass', 'bus', 'basis', 'm²', 'per day']) expect(withUnit('1', kept)).toBe(`1 ${kept}`);
  expect(dressFor({ format: 'number', unit: 'mi' }, 85780)).toMatchObject({ kind: 'number', text: '85,780 mi' });
  expect(dressFor({ format: 'money', currency: 'USD', unit: '/mo' }, 237)).toMatchObject({ kind: 'money', text: '$237/mo' });
});

test('a percent sign as a unit sits where the locale puts it: "100%" in en-US, not "100 %"', () => {
  // A service review's figures, `{ format: 'number', unit: '%' }`, on paper and on the record alike.
  expect(withUnit('100', '%')).toBe('100%');
  expect(dressFor({ format: 'number', unit: '%' }, 95)).toMatchObject({ kind: 'number', text: '95%' });
  expect(dressFor({ format: 'number', unit: '%', tone: { '>= 90': 'good' } }, 100)).toMatchObject({ kind: 'tone', label: '100%' });
});

test('a toned figure keeps its format and unit in the pill', () => {
  // Payday's hours: `number({ unit: 'h' })` with a tone — "104" said the stored digits.
  expect(dressFor({ format: 'number', unit: 'h', tone: { '>= 40': 'warn', '*': 'good' } }, 104)).toMatchObject({
    kind: 'tone',
    tone: 'warn',
    label: '104 h',
    text: '104',
  });
  expect(dressFor({ format: 'money', currency: 'USD', unit: '/mo', tone: { '*': 'info' } }, 1200)).toMatchObject({
    kind: 'tone',
    label: '$1,200/mo',
  });
  expect(dressFor({ format: 'percent', tone: { '< 50': 'bad' } }, 42)).toMatchObject({ kind: 'tone', tone: 'bad', label: '42%' });
  // A neutral figure is no tone at all, and a toned one is ink only (`figure`): neither is a pill with a dot.
  expect(dressFor({ unit: 'mi', tone: { '*': 'neutral' } }, 85780)).toMatchObject({ kind: 'number', text: '85,780 mi' });
  expect(dressFor({ format: 'money', currency: 'USD', tone: { '> 0': 'warn' } }, 1200)).toMatchObject({ kind: 'tone', figure: true });
  expect(dressFor({ format: 'money', currency: 'USD', tone: { '> 0': 'warn' } }, 0)).toMatchObject({ kind: 'money', text: '$0' });
  // A word stays the vocabulary's word, and an id past 2^53 is never rounded into a figure.
  expect(dressFor({ format: 'number', tone: { in_review: 'warn' } }, 'in_review')).toMatchObject({ kind: 'tone', label: 'In review' });
  expect(dressFor({ format: 'number', tone: { '*': 'info' } }, '9007199254740993')).toMatchObject({
    kind: 'tone',
    label: '9007199254740993',
  });
  const { container } = render(<Dressed dress={dressFor({ format: 'number', unit: 'h', tone: { '*': 'good' } }, 16)!} />);
  expect(container.querySelector('.tone')).toHaveTextContent('16 h');
});

test('a text of one item per line is a list where there is room, and one line where there is not', () => {
  const dress = dressFor({ format: 'items' }, 'Heated seats\n\n Navigation \nTow hitch');
  expect(dress).toEqual({ kind: 'items', items: ['Heated seats', 'Navigation', 'Tow hitch'], text: 'Heated seats, Navigation, Tow hitch' });
  const { container } = render(<Dressed dress={dress!} />);
  expect([...container.querySelectorAll('.value-items li')].map((li) => li.textContent)).toEqual([
    'Heated seats',
    'Navigation',
    'Tow hitch',
  ]);
  cleanup();
  const compact = render(<Dressed dress={dress!} compact />);
  expect(compact.container.textContent).toBe('Heated seats, Navigation, Tow hitch');
  expect(compact.container.querySelector('ul')).toBeNull();
  // Nothing to list is not a list.
  expect(dressFor({ format: 'items' }, '   ')).toBeNull();
});

test("a rule says a stored value in the author's word, and keeps its tone and icon keyed by the stored value", async () => {
  const { groupLabel, ruleSays, wordFor } = await import('./valueModel.js');
  const rule = { values: { PUB: 'Published', DRF: 'Draft' }, tone: { PUB: 'good', DRF: 'neutral' }, icons: { PUB: 'check' } };
  expect(dressFor(rule, 'PUB')).toMatchObject({ kind: 'tone', tone: 'good', label: 'Published', text: 'PUB', icon: 'check' });
  expect(dressFor({ values: { PUB: 'Published' } }, 'PUB')).toEqual({ kind: 'word', text: 'PUB', label: 'Published' });
  expect(dressFor({ values: { PUB: 'Published' }, icons: { PUB: 'check' } }, 'PUB')).toMatchObject({ kind: 'mark', label: 'Published' });
  // A value no key names is said as it is, or made words where the rule says humanize.
  expect(dressFor({ values: { PUB: 'Published' } }, 'ARC')).toBeNull();
  expect(wordFor({ humanize: true }, 'IN_REVIEW')).toBe('In review');
  expect(wordFor({ humanize: true, values: { IN_REVIEW: 'Being read' } }, 'IN_REVIEW')).toBe('Being read');
  expect(wordFor({ values: { PUB: 'Published' } }, 'toString')).toBeUndefined();
  expect(groupLabel({ values: { PUB: 'Published' } }, 'PUB')).toBe('Published');
  // A value renderer is handed what the rest of the rule says, so it keeps the tone.
  expect(ruleSays(rule, 'PUB')).toEqual({ tone: 'good', word: 'Published' });
  expect(ruleSays(rule, null)).toEqual({});
  const { container } = render(<Dressed dress={dressFor({ values: { PUB: 'Published' } }, 'PUB')!} />);
  expect(container).toHaveTextContent('Published');
  expect(container.querySelector('[title="PUB"]')).not.toBeNull();
});

test('a unit with no format says a number with it, and leaves a text value as it is', () => {
  expect(dressFor({ unit: 'mi' }, 85780)).toEqual({ kind: 'number', text: '85,780 mi', title: '85780' });
  expect(dressFor({ unit: '/mo' }, '242')).toEqual({ kind: 'number', text: '242/mo', title: '242' });
  expect(dressFor({ unit: 'mi' }, 'unknown')?.kind).not.toBe('number');
  expect(dressFor({ unit: 'mi' }, '')?.kind).not.toBe('number');
});

test("a figure the author names is said as the word: a money column's zero as 'No charge', whatever its stored scale", () => {
  const rule = { format: 'money' as const, currency: 'USD', values: { 0: 'No charge' } };
  expect(dressFor(rule, '0.00')).toEqual({ kind: 'word', text: '0.00', label: 'No charge' });
  expect(dressFor(rule, 0)).toEqual({ kind: 'word', text: '0', label: 'No charge' });
  expect(dressFor(rule, '12.50')).toMatchObject({ kind: 'money' });
});

test('money drawn as a set says its cents only where one of its figures has some', async () => {
  const { centsAmong, dressFor } = await import('./valueModel.js');
  const money: import('./valueModel.js').DisplayRule = { format: 'money', currency: 'USD' };
  const said = (rule: object | null, value: unknown) => (dressFor(rule as never, value) as { text: string }).text;
  // A column of prices, all whole: no ".00" down it.
  const prices = centsAmong(money, ['24495.00', 10495, '22495']);
  expect(['24495.00', 10495, '22495'].map((v) => said(prices, v))).toEqual(['$24,495', '$10,495', '$22,495']);
  // One figure with cents and every figure says them, so "$24" never stands beside "$0.50".
  const fees = centsAmong(money, ['0.00', '24.50', 24, null]);
  expect(['0.00', '24.50', 24].map((v) => said(fees, v))).toEqual(['$0.00', '$24.50', '$24.00']);
  // Minor units are read in the major unit: 1999 cents has cents, 2000 has none.
  expect(centsAmong({ ...money, minor: true }, [2000, 1999])?.cents).toBe(true);
  expect(centsAmong({ ...money, minor: true }, [2000, 3000])?.cents).toBe(false);
  // The same rule and answer give the same object, so a grid keeps its columns between paints.
  expect(centsAmong(money, [1, 2])).toBe(centsAmong(money, [3]));
  // Anything that is not money is left as it was.
  const plain = { format: 'number' };
  expect(centsAmong(plain, [1.5])).toBe(plain);
});

test("a record's money fields share one form: a labor rate of $89 beside a total of $145.45 says $89.00", async () => {
  const { centsTogether, dressFor } = await import('./valueModel.js');
  const money: import('./valueModel.js').DisplayRule = { format: 'money', currency: 'USD' };
  const cents = centsTogether([
    [money, 89],
    [money, '145.45'],
    [{ format: 'number' }, 2.5],
    [money, null],
  ]);
  expect(cents).toBe(true);
  expect((dressFor({ ...money, cents } as never, 89) as { text: string }).text).toBe('$89.00');
  // All whole, all whole; a fraction in a column that is not money is not cents.
  expect(
    centsTogether([
      [money, 89],
      [money, '145.00'],
      [{ format: 'number' }, 2.5],
    ]),
  ).toBe(false);
  // No money at all leaves each value its own say.
  expect(
    centsTogether([
      [{ format: 'number' }, 2.5],
      [null, 'x'],
    ]),
  ).toBeUndefined();
});

test('a relative date column says one way: from today only where every value is near, else every one is its date', async () => {
  const { centsAmong, dressFor } = await import('./valueModel.js');
  const day = (offset: number) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const rule: import('./valueModel.js').DisplayRule = { format: 'relative' };
  const near = [day(-6), day(0), day(2)];
  const said = (set: string[], column: import('./valueModel.js').DisplayRule | null) =>
    set.map((value) => (dressFor(column, value) as { text: string }).text);
  expect(centsAmong(rule, near)).toBe(rule);
  expect(said(near, centsAmong(rule, near))).toEqual(['6 days ago', 'today', 'in 2 days']);
  const mixed = [day(-6), day(-40)];
  const apart = said(mixed, centsAmong(rule, mixed));
  expect(apart.some((text) => /ago|today|in \d/.test(text))).toBe(false);
  expect(new Set(apart).size).toBe(2);
  expect(centsAmong(rule, mixed)).toBe(centsAmong(rule, [day(-90)]));
});
