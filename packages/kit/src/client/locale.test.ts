/**
 * How figures are written, in four locales that disagree about nearly all
 * of it: which separator groups, which marks the fraction, where the
 * currency sign goes, what order a date's fields come in, and what the day
 * before yesterday is called.
 */
import { afterEach, describe, expect, test } from 'vitest';
import {
  dayOf,
  defaultCurrency,
  formatApprox,
  formatBytes,
  formatDate,
  formatDateTime,
  formatDayHeading,
  formatLocale,
  formatMoney,
  formatNumber,
  formatPercent,
  withPercentSign,
  formatRelativeDay,
  formatTimeOfDay,
  plural,
  sayNearDay,
  type FormatSettings,
} from './locale.js';
import { installShell } from './shellMode.js';

/* Intl writes some of these with a no-break or narrow no-break space;
   the tests read them as plain spaces. */
const plain = (text: string | null) => text?.replace(/[  ]/g, ' ');
const inLocale = (settings: FormatSettings) => installShell({ format: () => settings });
const ROWS = { one: 'row', other: 'rows' };
const now = new Date(2026, 8, 3, 15, 0, 0); // 3 September 2026, the reader's afternoon

afterEach(() => inLocale({ locale: 'en-US' }));

describe('the source', () => {
  test('unregistered, the browser decides and money is USD', () => {
    installShell({ format: () => null });
    expect(formatLocale()).toBeUndefined();
    expect(defaultCurrency()).toBe('USD');
  });

  test('an App pins the locale and the currency', () => {
    inLocale({ locale: 'de-DE', currency: 'EUR' });
    expect(formatLocale()).toBe('de-DE');
    expect(plain(formatMoney(12))).toBe('12,00 €');
  });
});

describe('numbers', () => {
  test.each([
    ['de-DE', '1.234.567,891'],
    ['en-GB', '1,234,567.891'],
    ['fr-FR', '1 234 567,891'],
    ['ja-JP', '1,234,567.891'],
  ])('%s groups and marks the fraction its own way', (locale, said) => {
    inLocale({ locale });
    expect(plain(formatNumber(1234567.891))).toBe(said);
    expect(plain(formatNumber('1234567.891')), 'a numeric string from the adapter').toBe(said);
  });

  test.each([
    ['de-DE', '9.223.372.036.854.775.807'],
    ['en-GB', '9,223,372,036,854,775,807'],
    ['fr-FR', '9 223 372 036 854 775 807'],
    ['ja-JP', '9,223,372,036,854,775,807'],
  ])('%s keeps every digit of an integer past 2^53', (locale, said) => {
    inLocale({ locale });
    const big = '9223372036854775807';
    expect(plain(formatNumber(big))).toBe(said);
    expect(plain(formatNumber(big))!.replace(/\D/g, '')).toBe(big);
    expect(plain(formatNumber(`-${big}`))!.replace(/[^\d-]/g, '')).toBe(`-${big}`);
  });

  test('what is not a number comes back as it was', () => {
    inLocale({ locale: 'de-DE' });
    expect(formatNumber('N/A')).toBe('N/A');
    expect(formatNumber('')).toBe('');
    expect(formatNumber(null)).toBe('null');
  });

  test.each([
    ['de-DE', '2,4 Mio.'],
    ['en-GB', '2.4m'],
    ['fr-FR', '2,4 M'],
    ['ja-JP', '240万'],
  ])('%s rounds an estimate in its own words', (locale, said) => {
    inLocale({ locale });
    expect(plain(formatApprox(2_400_113))).toBe(said);
    expect(formatApprox(640)).toBe('640');
  });

  test.each([
    ['de-DE', '1,5 kB', '12 Byte'],
    ['en-GB', '1.5 kB', '12 bytes'],
    ['fr-FR', '1,5 ko', '12 octets'],
    ['ja-JP', '1.5 KB', '12 バイト'],
  ])('%s says a file size', (locale, kilo, bytes) => {
    inLocale({ locale });
    expect(plain(formatBytes(1536))).toBe(kilo);
    expect(plain(formatBytes(12))).toBe(bytes);
  });
});

describe('money', () => {
  test.each([
    ['de-DE', 'EUR', '1.234,50 €', '1.234,00 €'],
    ['en-GB', 'GBP', '£1,234.50', '£1,234.00'],
    ['fr-FR', 'EUR', '1 234,50 €', '1 234,00 €'],
    ['ja-JP', 'JPY', '￥1,235', '￥1,234'],
  ])('%s writes %s, every amount to its minor unit', (locale, currency, cents, whole) => {
    inLocale({ locale, currency });
    expect(plain(formatMoney(1234.5))).toBe(cents);
    expect(plain(formatMoney(1234))).toBe(whole);
  });

  /* A computed or rolled-up sum that came out even said "$24" beside a stored "$0.00" on the same row. */
  test('a whole amount keeps its cents, stored as text or worked out as a number', () => {
    inLocale({ locale: 'en-US', currency: 'USD' });
    expect(plain(formatMoney('5294.00'))).toBe('$5,294.00');
    expect(plain(formatMoney('6645.82'))).toBe('$6,645.82');
    expect(plain(formatMoney('18995'))).toBe('$18,995.00');
    expect(plain(formatMoney(24))).toBe('$24.00');
  });

  test("a rule's own currency wins over the App's, and compact notation layers on", () => {
    inLocale({ locale: 'de-DE', currency: 'EUR' });
    expect(plain(formatMoney(1234.5, 'USD'))).toBe('1.234,50 $');
    expect(plain(formatMoney(27_900_000, null, { notation: 'compact', maximumFractionDigits: 1 }))).toBe('27,9 Mio. €');
  });
});

describe('percent', () => {
  test.each([
    ['de-DE', '42,5 %'],
    ['en-GB', '42.5%'],
    ['fr-FR', '42,5 %'],
    ['ja-JP', '42.5%'],
  ])('%s, from a figure kept 0 to 100', (locale, said) => {
    inLocale({ locale });
    expect(plain(formatPercent(42.5))).toBe(said);
  });

  test.each([
    ['en-US', '100%'],
    ['de-DE', '100 %'],
    ['fr-FR', '100 %'],
    ['tr-TR', '%100'],
  ])('%s places a unit of "%%" as its percents place the sign', (locale, said) => {
    inLocale({ locale });
    expect(plain(withPercentSign('100'))).toBe(said);
    expect(plain(withPercentSign(formatNumber(95)))).toBe(plain(formatPercent(95)));
  });
});

describe('dates and times', () => {
  test.each([
    ['de-DE', '05.03.2026', '05.03.2026, 14:30', '05.03.2026, 14:30:15', '14:30'],
    ['en-GB', '5 Mar 2026', '5 Mar 2026, 14:30', '5 Mar 2026, 14:30:15', '14:30'],
    ['fr-FR', '5 mars 2026', '5 mars 2026, 14:30', '5 mars 2026, 14:30:15', '14:30'],
    ['ja-JP', '2026/03/05', '2026/03/05 14:30', '2026/03/05 14:30:15', '14:30'],
  ])('%s orders the fields its own way', (locale, day, minute, second, clock) => {
    inLocale({ locale });
    expect(plain(formatDate('2026-03-05'))).toBe(day);
    expect(plain(formatDateTime('2026-03-05T14:30:00'))).toBe(minute);
    expect(plain(formatDateTime('2026-03-05 14:30:15')), 'seconds only when there are some').toBe(second);
    expect(plain(formatDateTime('14:30:00')), 'a time alone').toBe(clock);
    expect(plain(formatDateTime('2026-03-05')), 'a date alone').toBe(day);
  });

  test('a plain date is the day it names in every zone, and a stored wall clock is not converted', () => {
    inLocale({ locale: 'en-GB' });
    /* Parsed as an instant, "2026-03-05" is UTC midnight — the 4th in New
       York. It is kept as a day, whatever the zone of the reader. */
    expect(formatDate('2026-03-05')).toBe('5 Mar 2026');
    expect(formatDate('2026-01-01T00:00:00')).toBe('1 Jan 2026');
    expect(formatDateTime('2026-03-05T23:30:00Z'), 'the wall clock as written').toBe('5 Mar 2026, 23:30');
    expect(formatDateTime('2026-03-05T23:30:00.000+10:00')).toBe('5 Mar 2026, 23:30');
  });

  test('what is not a date comes back as it was', () => {
    expect(formatDate('soon')).toBe('soon');
    expect(formatDate('2026-02-31'), 'not a day').toBe('2026-02-31');
    expect(formatDateTime('2026-03-05 garbage')).toBe('2026-03-05 garbage');
    expect(formatDateTime('1700000000')).toBe('1700000000');
  });

  test("an instant is said in the reader's own zone", () => {
    inLocale({ locale: 'en-GB' });
    const at = new Date(2026, 2, 5, 9, 5);
    expect(formatDateTime(at)).toBe('5 Mar 2026, 09:05');
    expect(formatDateTime(at.getTime())).toBe('5 Mar 2026, 09:05');
  });
});

describe('relative days', () => {
  test.each([
    ['en-GB', ['today', 'yesterday', '2 days ago', 'in 3 days', '7 weeks ago', 'in 1.5 years']],
    ['de-DE', ['heute', 'gestern', 'vorgestern', 'in 3 Tagen', 'vor 7 Wochen', 'in 1,5 Jahren']],
    ['fr-FR', ['aujourd’hui', 'hier', 'avant-hier', 'dans 3 jours', 'il y a 7 semaines', 'dans 1,5 an']],
    ['ja-JP', ['今日', '昨日', '一昨日', '3 日後', '7 週間前', '1.5 年後']],
  ])('%s says a day from today', (locale, said) => {
    inLocale({ locale });
    const days = ['2026-09-03', '2026-09-02', '2026-09-01', '2026-09-06', '2026-07-15', '2028-03-03'];
    expect(days.map((day) => plain(formatRelativeDay(day, now)))).toEqual(said);
  });

  test('whole days, weeks, months and years, a time of day dropped', () => {
    expect(formatRelativeDay('2026-09-04', now)).toBe('tomorrow');
    expect(formatRelativeDay('2026-07-01', now)).toBe('2 months ago');
    expect(formatRelativeDay('2026-03-01', now)).toBe('6 months ago');
    expect(formatRelativeDay('2024-09-03', now)).toBe('2 years ago');
    expect(formatRelativeDay('2027-09-04', now), 'a year away is not "next year"').toBe('in 1 year');
    expect(formatRelativeDay('2027-01-15 09:30:00', now)).toBe('in 4 months');
    expect(formatRelativeDay('hello', now)).toBeNull();
    expect(formatRelativeDay('12', now)).toBeNull();
  });

  test('a near day is said from today, a far one as the date, and the whole of either on hover', () => {
    const say = (text: string, time = false) => {
      const near = sayNearDay(text, time, now);
      return near && { text: plain(near.text), title: plain(near.title) };
    };
    expect(say('2026-09-01')).toEqual({ text: '2 days ago', title: 'Tuesday, September 1, 2026' });
    expect(say('2026-09-17'), 'two weeks is still near').toEqual({ text: 'in 2 weeks', title: 'Thursday, September 17, 2026' });
    expect(say('2026-09-18'), 'past two weeks the day itself').toEqual({ text: 'Sep 18, 2026', title: 'Friday, September 18, 2026' });
    /* A moment of yesterday, today or tomorrow keeps its time; further off the day is enough to read. */
    expect(say('2026-09-02 14:05:00', true)).toEqual({ text: 'yesterday, 2:05 PM', title: 'Wednesday, September 2, 2026 at 2:05 PM' });
    expect(say('2026-08-30 14:05:00', true)?.text).toBe('4 days ago');
    expect(say('2026-07-30 14:05:00', true)?.text).toBe('Jul 30, 2026, 2:05 PM');
    expect(say('2026-09-02 14:05:00')?.text, 'a column of days drops the time').toBe('yesterday');
    expect(say('14:05')).toBeNull();
    expect(say('soon')).toBeNull();
  });

  test('"today" is the App\'s zone\'s when it names one', () => {
    /* 23:30 UTC on 3 September is already the 4th in Sydney. */
    const late = new Date(Date.UTC(2026, 8, 3, 23, 30));
    inLocale({ locale: 'en-GB', timezone: 'Australia/Sydney' });
    expect(formatRelativeDay('2026-09-04', late)).toBe('today');
    inLocale({ locale: 'en-GB', timezone: 'America/Los_Angeles' });
    expect(formatRelativeDay('2026-09-03', late)).toBe('today');
  });

  test("a moment is said on the day its date and time say it: an instant in the App's zone, a wall clock as written", () => {
    /* 10:30 PM on 8 October in New York is 02:30 UTC on the 9th. */
    const evening = new Date(Date.UTC(2026, 9, 9, 2, 30));
    inLocale({ locale: 'en-US', timezone: 'America/New_York' });
    expect(formatDateTime('2026-10-09T02:00:00Z')).toBe('Oct 8, 2026, 10:00 PM');
    expect(formatRelativeDay('2026-10-09T02:00:00Z', evening)).toBe('today');
    expect(formatRelativeDay('2026-10-09 02:00:00+00', evening)).toBe('today');
    expect(formatRelativeDay('2026-10-08T01:00:00Z', evening)).toBe('yesterday');
    // A wall clock with no zone is the day it was written on, as formatDateTime says it.
    expect(formatRelativeDay('2026-10-08 22:00:00', evening)).toBe('today');
    expect(formatRelativeDay('2026-10-09 09:00:00', evening)).toBe('tomorrow');
  });
});

describe('plurals', () => {
  test.each([
    ['de-DE', '1.234 rows'],
    ['en-GB', '1,234 rows'],
    ['fr-FR', '1 234 rows'],
    ['ja-JP', '1,234 rows'],
  ])('%s writes the count; the noun keeps English grammar', (locale, many) => {
    inLocale({ locale });
    expect(plural(1, ROWS)).toBe('1 row');
    /* French counts 0 as singular and Japanese has one form: neither
       grammar belongs to an English noun. */
    expect(plural(0, ROWS)).toBe('0 rows');
    expect(plain(plural(1234, ROWS))).toBe(many);
  });

  test('an App says a timestamp that carries its zone in its own ui.timezone, whichever database wrote it', () => {
    inLocale({ locale: 'en-GB', timezone: 'Australia/Sydney' });
    // SQLite's `...Z` and Postgres's `+00` are one instant, and read alike.
    expect(formatDateTime('2026-10-04T07:21:00Z')).toBe('4 Oct 2026, 18:21');
    expect(formatDateTime('2026-10-04 07:21:00+00')).toBe('4 Oct 2026, 18:21');
    expect(formatDateTime('2026-10-04 17:21:00+10')).toBe('4 Oct 2026, 18:21');
    expect(formatDateTime('2026-10-04 03:51:00-03:30')).toBe('4 Oct 2026, 18:21');
    // A wall clock with no zone and a plain date are not instants.
    expect(formatDateTime('2026-10-04 07:21:00')).toBe('4 Oct 2026, 07:21');
    expect(formatDate('2026-10-04')).toBe('4 Oct 2026');
  });
});

describe('a day over its rows', () => {
  test("an instant's day and time are the App's zone's; a wall clock's are as written", () => {
    inLocale({ locale: 'en-US', timezone: 'America/New_York' });
    expect(dayOf('2026-10-04T02:30:00Z')).toBe('2026-10-03');
    expect(formatTimeOfDay('2026-10-04T02:30:00Z')).toBe('10:30 PM');
    expect(dayOf('2026-10-04 02:30:00')).toBe('2026-10-04');
    expect(formatTimeOfDay('2026-10-04')).toBe('');
    expect(dayOf('soon')).toBeNull();
  });

  test('today and yesterday by name, another day short, with its year when not this one', () => {
    inLocale({ locale: 'en-US', timezone: 'UTC' });
    const now = new Date('2026-10-04T12:00:00Z');
    expect(['2026-10-04', '2026-10-03', '2026-10-02', '2025-12-31'].map((day) => formatDayHeading(day, now))).toEqual([
      'Today',
      'Yesterday',
      'Oct 2',
      'Dec 31, 2025',
    ]);
    inLocale({ locale: 'de-DE', timezone: 'UTC' });
    expect(formatDayHeading('2026-10-03', now)).toBe('Gestern');
  });
});
