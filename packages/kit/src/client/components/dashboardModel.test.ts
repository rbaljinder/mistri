import { describe, expect, test } from 'vitest';
import { windowed } from '../../../../engine/src/shared/dashboardAsks.js';
import { CurrencyFigures, figureSayer, namedGroups, ownWindow, sayer, type Section } from './dashboardModel.js';

describe('ownWindow', () => {
  const won = {
    kind: 'metric',
    title: 'Won',
    table: 'deal',
    over: 'closed_on',
    query: 'stage = won and closed_on = last 90 days',
    windowBase: 'stage = won',
  } as Section;

  test("names the window a section's own query sets on its over column", () => {
    expect(ownWindow(won)).toBe('last 90 days');
    expect(ownWindow({ ...won, query: 'closed_on = LAST   2   weeks', windowBase: '' })).toBe('last 2 weeks');
  });

  test('says nothing where the query windows another column, or none', () => {
    expect(ownWindow({ ...won, query: 'stage = won and opened_on = last 90 days' })).toBeUndefined();
    expect(ownWindow({ ...won, windowBase: undefined })).toBeUndefined();
    expect(ownWindow({ ...won, over: undefined })).toBeUndefined();
    expect(ownWindow({ ...won, query: 'stage = won and reclosed_on = last 90 days' })).toBeUndefined();
  });
});

test('a group of a reference is said by the name the answer gives it, and any other group as its key is said', () => {
  const say = (key: unknown) => `key ${String(key)}`;
  const answer = { names: { tenant_id: { 'north-motors': 'North Motors' } } };
  const sayKey = namedGroups(answer, 'tenant_id', say);
  expect(sayKey('north-motors')).toBe('North Motors');
  expect(sayKey('harbor-auto')).toBe('key harbor-auto');
  expect(sayKey(null)).toBe('key null');
  expect(namedGroups(answer, 'status', say)).toBe(say);
  expect(namedGroups(undefined, 'tenant_id', say)).toBe(say);
});

test('a measured fraction is said to a headline precision, not to every digit the database sent', () => {
  const say = sayer({
    kind: 'metric',
    title: 'Resolution SLA met',
    table: 'incident',
    measure: 'avg resolution_met * 100 as met',
  } as Section);
  expect(say('78.2608695652173913')).toBe('78.3');
  expect(say(78.26086956521739)).toBe('78.3');
  expect(say(0.034567)).toBe('0.0346');
  expect(say(1234.5678)).toBe('1,234.6');
  expect(say(42)).toBe('42');
  expect(say('9007199254740993'), 'an integer past 2^53 keeps every digit').toBe('9,007,199,254,740,993');
});

test("a metric's format and unit say its figure where the measure has no column's rule", () => {
  const section = { kind: 'metric', title: 'Resolution SLA met', table: 'incident', measure: 'avg resolution_met * 100 as met' };
  const share = sayer({ ...section, format: 'percent' } as Section);
  expect(share('78.2608695652173913')).toBe('78.3%');
  expect(share(100)).toBe('100%');
  // A share is said from a figure kept 0–100: a win rate of `avg won_flag * 100` is "53.8%", never "5,380%" or "53.8".
  expect(share(53.84615)).toBe('53.8%');
  expect(sayer({ ...section, format: 'number', unit: 'days' } as Section)(4.25)).toBe('4.3 days');
  expect(sayer({ ...section, format: 'money', unit: '/mo' } as Section)(1200)).toMatch(/^\$1,200(\.00)?\/mo$/);
});

test('a measure of seconds is said as a time taken, as a duration column is', () => {
  const taken = sayer({ kind: 'chart', table: 'ticket', by: 'team', measure: 'avg first_response_seconds', format: 'duration' } as Section);
  // An average comes back to every digit; a time taken is its two largest units.
  expect(taken('36120.4166666')).toMatch(/^10\s?h,? 2\s?m(in)?$/);
  expect(taken(183_600)).toMatch(/^2\s?d,? 3\s?h$/);
  expect(taken(45)).toMatch(/^45\s?s(ec)?$/);
  // A measure over a column whose rule says duration is said by that rule, with no format of its own.
  expect(figureSayer({ format: 'duration' })(5400)).toMatch(/^1\s?h,? 30\s?m(in)?$/);
});

test('money summed apart per currency is said per currency; one currency is a figure, its change said in it', () => {
  const section = { kind: 'metric', table: 'deal', format: 'money' } as Section;
  const mixed = new CurrencyFigures([
    ['USD', 1200],
    ['JPY', 5000],
  ]);
  expect(sayer(section)(mixed)).toMatch(/^\$1,200(\.00)? · ¥5,000$/);
  // Several currencies are no one number: a change or a goal against them is not said.
  expect(Number.isNaN(Number(mixed))).toBe(true);
  const yen = new CurrencyFigures([['JPY', 5000]]);
  expect(Number(yen)).toBe(5000);
  expect(sayer(section, yen)(250)).toBe('¥250');
});

test('a metric card says money one way across a strip: compact from a thousand, whole below; a table keeps its figures whole', () => {
  const section = { kind: 'metric', title: 'Revenue', table: 'deal', measure: 'sum amount', format: 'money' } as Section;
  const card = sayer(section, undefined, { card: true });
  // "$414.1K" stood beside "$27,300" in one strip; each card now keeps the one rule by itself.
  expect(card(414_100)).toBe('$414.1K');
  expect(card(27_300)).toBe('$27.3K');
  expect(card(950)).toBe('$950');
  expect(card(12.5)).toBe('$12.50');
  // Outside a card a figure is read against its neighbours, whole to a hundred thousand.
  expect(sayer(section)(27_300)).toBe('$27,300');
  expect(sayer(section)(414_100)).toBe('$414.1K');
});

test("a window picked replaces the author's on a metric and on the whole it is a share of, so both count one cohort", () => {
  const section = {
    kind: 'metric',
    table: 'application',
    query: 'status = approved and decided_on = last 90 days',
    windowBase: 'status = approved',
    over: 'decided_on',
    target: { table: 'application', measure: 'count', over: 'decided_on', query: 'decided_on = last 90 days', windowBase: '' },
    targetWhole: true,
  } as Section;
  const out = windowed(section, 'this month');
  expect(out.query).toBe('status = approved and decided_on = this month');
  expect(typeof out.target === 'object' && out.target.query).toBe('decided_on = this month');
});
