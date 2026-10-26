/**
 * A record's head draws exactly one filled verb where it has a forward one:
 * the header's `primary`, else the first that takes nothing away; the rest
 * follow in the author's order and the destructive ones end the row, quiet.
 */
import { expect, test } from 'vitest';
import { orderActions } from './actionOrder.js';

const verbs = [
  ['end', 'End lease'],
  ['recordPayment', 'Record payment'],
  ['renew', 'Renew'],
  ['evict', 'Evict'],
].map(([id, label]) => ({ id, label }));
const ends = (action: { label: string }) => action.label === 'End lease' || action.label === 'Evict';
const drawn = (primary?: string, list = verbs, destructive = ends) =>
  orderActions(list, destructive, primary).map(({ action, intent }) => `${action.label}:${intent}`);

test('the first verb that takes nothing away is filled, the destructive last and quiet', () => {
  expect(drawn()).toEqual(['Record payment:primary', 'Renew:secondary', 'End lease:quiet', 'Evict:quiet']);
});

test("the header's primary, by id, is filled and first", () => {
  expect(drawn('renew')).toEqual(['Renew:primary', 'Record payment:secondary', 'End lease:quiet', 'Evict:quiet']);
});

test('a primary not shown now, or one that is destructive, gives way to the first forward verb', () => {
  expect(drawn('extend')).toEqual(['Record payment:primary', 'Renew:secondary', 'End lease:quiet', 'Evict:quiet']);
  expect(drawn('end')[0]).toBe('Record payment:primary');
});

test('only destructive verbs: none is filled', () => {
  const only = [{ id: 'end', label: 'End lease' }];
  expect(drawn(undefined, only)).toEqual(['End lease:quiet']);
  expect(orderActions(only, ends).filter(({ intent }) => intent === 'primary')).toEqual([]);
});
