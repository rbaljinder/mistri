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
  expect(dressFor({ format: 'money', currency: 'USD', unit: '/mo' }, 237)).toMatchObject({ kind: 'money', text: '$237.00/mo' });
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
    label: '$1,200.00/mo',
  });
  expect(dressFor({ format: 'percent', tone: { '< 50': 'bad' } }, 42)).toMatchObject({ kind: 'tone', tone: 'bad', label: '42%' });
  // A neutral figure is no tone at all, and a toned one is ink only (`figure`): neither is a pill with a dot.
  expect(dressFor({ unit: 'mi', tone: { '*': 'neutral' } }, 85780)).toMatchObject({ kind: 'number', text: '85,780 mi' });
  expect(dressFor({ format: 'money', currency: 'USD', tone: { '> 0': 'warn' } }, 1200)).toMatchObject({ kind: 'tone', figure: true });
  expect(dressFor({ format: 'money', currency: 'USD', tone: { '> 0': 'warn' } }, 0)).toMatchObject({ kind: 'money', text: '$0.00' });
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

test("money is said to its currency's minor digits wherever it stands: whole, zero, negative and in minor units", async () => {
  /* A field report found "$5,917" beside "$5,917.40": an amount is read to settle something, so it is one form. */
  const { dressFor } = await import('./valueModel.js');
  const money: import('./valueModel.js').DisplayRule = { format: 'money', currency: 'USD' };
  const said = (rule: object, value: unknown) =>
    (dressFor(rule as never, value) as { text: string } | null)?.text?.replace(/[\u00a0\u202f]/g, ' ');
  expect(['24495.00', 10495, '22495', '24.5'].map((v) => said(money, v))).toEqual(['$24,495.00', '$10,495.00', '$22,495.00', '$24.50']);
  expect([0, '0.00', '-0.00', -12, '-12.50'].map((v) => said(money, v))).toEqual(['$0.00', '$0.00', '$0.00', '-$12.00', '-$12.50']);
  expect([2000, 1999, '-1250', 0].map((v) => said({ ...money, minor: true }, v))).toEqual(['$20.00', '$19.99', '-$12.50', '$0.00']);
  // A currency's own digits: none for yen, three for dinars.
  expect(said({ format: 'money', currency: 'JPY' }, 1500)).toBe('¥1,500');
  expect(said({ format: 'money', currency: 'JPY', minor: true }, 1500)).toBe('¥1,500');
  expect(said({ format: 'money', currency: 'KWD', minor: true }, 1999)).toMatch(/1\.999$/);
});

test('whole money drops the minor digits only where they are zeros, and never hides cents', async () => {
  const { dressFor } = await import('./valueModel.js');
  const whole = { format: 'money', currency: 'USD', whole: true } as const;
  const said = (rule: object, value: unknown) =>
    (dressFor(rule as never, value) as { text: string } | null)?.text?.replace(/[\u00a0\u202f]/g, ' ');
  expect(['24495.00', 24495, '22495', '0.00', 0].map((v) => said(whole, v))).toEqual(['$24,495', '$24,495', '$22,495', '$0', '$0']);
  expect(['24495.50', 24495.5, '0.05', '24495.01'].map((v) => said(whole, v))).toEqual(['$24,495.50', '$24,495.50', '$0.05', '$24,495.01']);
  expect([-12, '-12.00', '-12.50'].map((v) => said(whole, v))).toEqual(['-$12', '-$12', '-$12.50']);
  // Minor units: 2449500 cents is a whole $24,495; 2449550 keeps its cents.
  expect([2449500, 2449550].map((v) => said({ ...whole, minor: true }, v))).toEqual(['$24,495', '$24,495.50']);
  // Past 2^53, by the digits.
  expect(said(whole, '90071992547409931.00')).toBe('$90,071,992,547,409,931');
  expect(said(whole, '90071992547409931.25')).toBe('$90,071,992,547,409,931.25');
  // Currencies of their own digits: yen has none to drop, dinars have three.
  expect(said({ format: 'money', currency: 'JPY', whole: true }, 1500)).toBe('¥1,500');
  expect(said({ format: 'money', currency: 'KWD', whole: true }, '12.000')).toMatch(/12$/);
  expect(said({ format: 'money', currency: 'KWD', whole: true }, '12.500')).toMatch(/12\.500$/);
  expect(said({ format: 'money', currency: 'USD', whole: true, unit: '/mo' }, 242)).toBe('$242/mo');
});

test('money past 2^53 is said digit for digit, never through Number()', async () => {
  const { dressFor } = await import('./valueModel.js');
  const money: import('./valueModel.js').DisplayRule = { format: 'money', currency: 'USD' };
  const said = (rule: object, value: unknown) => (dressFor(rule as never, value) as { text: string } | null)?.text;
  expect(said(money, '9223372036854775807')).toBe('$9,223,372,036,854,775,807.00');
  expect(said(money, '90071992547409931.25')).toBe('$90,071,992,547,409,931.25');
  expect(said(money, '-90071992547409931.25')).toBe('-$90,071,992,547,409,931.25');
  // A sum of cents past 2^53: 9007199254740993 cents is $90,071,992,547,409.93, where Number() reads ...409.92.
  expect(said({ ...money, minor: true }, '9007199254740993')).toBe('$90,071,992,547,409.93');
  // What is not a figure is said as itself.
  expect(dressFor(money, 'n/a')).toBeNull();
});

test('a relative date column says one way: from today only where every value is near, else every one is its date', async () => {
  const { datesAmong, dressFor } = await import('./valueModel.js');
  const day = (offset: number) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const rule: import('./valueModel.js').DisplayRule = { format: 'relative' };
  const near = [day(-6), day(0), day(2)];
  const said = (set: string[], column: import('./valueModel.js').DisplayRule | null) =>
    set.map((value) => (dressFor(column, value) as { text: string }).text);
  expect(datesAmong(rule, near)).toBe(rule);
  expect(said(near, datesAmong(rule, near))).toEqual(['6 days ago', 'today', 'in 2 days']);
  const mixed = [day(-6), day(-40)];
  const apart = said(mixed, datesAmong(rule, mixed));
  expect(apart.some((text) => /ago|today|in \d/.test(text))).toBe(false);
  expect(new Set(apart).size).toBe(2);
  expect(datesAmong(rule, mixed)).toBe(datesAmong(rule, [day(-90)]));
});

test("a date column wears a tone by the same date phrases a list takes, on the App's today", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date(2026, 5, 15, 9, 0, 0));
    const tone = { '< today': 'bad', '<= next 7 days': 'warn' };
    const rule = { format: 'date', tone };
    // Before today: overdue. Today and the next 7 days (today and the six after it, as the query language reads the phrase): soon.
    expect(dressFor(rule, '2026-06-14')).toMatchObject({ kind: 'tone', tone: 'bad' });
    expect(dressFor(rule, '2026-06-15')).toMatchObject({ kind: 'tone', tone: 'warn' });
    expect(dressFor(rule, '2026-06-21')).toMatchObject({ kind: 'tone', tone: 'warn' });
    expect(dressFor(rule, '2026-06-22')).toMatchObject({ kind: 'date' });
    // A day past every key keeps the plain date, said as itself.
    expect(dressFor(rule, '2026-06-30')).toMatchObject({ kind: 'date' });
    // A toned date still says the date, and keeps the stored text.
    expect(dressFor(rule, '2026-06-14')).toMatchObject({ text: '2026-06-14', label: expect.stringContaining('2026') });
    // `<= today` takes the day itself, `> today` starts tomorrow.
    expect(dressFor({ format: 'date', tone: { '<= today': 'bad' } }, '2026-06-15')).toMatchObject({ tone: 'bad' });
    expect(dressFor({ format: 'date', tone: { '> today': 'good' } }, '2026-06-15')).toMatchObject({ kind: 'date' });
    expect(dressFor({ format: 'date', tone: { '> today': 'good' } }, '2026-06-16')).toMatchObject({ tone: 'good' });
    // A moment is judged by its day.
    expect(dressFor({ format: 'datetime', tone: { '< today': 'bad' } }, '2026-06-14 23:00:00')).toMatchObject({ tone: 'bad' });
  } finally {
    vi.useRealTimers();
  }
});
