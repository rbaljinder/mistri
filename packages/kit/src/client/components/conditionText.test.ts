/**
 * The filter wording a list says before its words have loaded
 * (conditionText.ts): squeezed, joined by the catalog's connectives,
 * ungrouped once, and split as written.
 */
import { expect, test } from 'vitest';
import { andWords, joined, squeeze, ungroup, written } from './conditionText.js';

test('squeeze collapses whitespace and trims', () => {
  expect(squeeze('  status   =  open\n')).toBe('status = open');
  expect(squeeze('')).toBe('');
});

test('joined lists words with commas and the catalog connective last', () => {
  expect(joined([], 'filter.and')).toBe('');
  expect(joined(['Status is Open'], 'filter.and')).toBe('Status is Open');
  expect(joined(['A', 'B'], 'filter.and')).toBe('A and B');
  expect(joined(['A', 'B', 'C'], 'filter.or')).toBe('A, B or C');
  expect(andWords(['A', 'B'])).toBe('A and B');
});

test('ungroup drops a single outer pair of parentheses, and only one', () => {
  expect(ungroup('(status = open)')).toBe('status = open');
  expect(ungroup('((status = open))')).toBe('(status = open)');
  expect(ungroup('(status = open) or (priority = high)')).toBe('(status = open) or (priority = high)');
  expect(ungroup('status = open')).toBe('status = open');
});

test('written says conditions as written, split at the top level', () => {
  expect(written.condition('(status = open)')).toBe('status = open');
  expect(written.filter('status = open and priority = high')).toEqual(['status = open', 'priority = high']);
  expect(written.filter('')).toEqual([]);
  expect(written.tails('status', ['= open', '= done'])).toBe('status = open and status = done');
  expect(written.question('  is it open? ')).toEqual(['is it open?']);
  expect(written.question('   ')).toEqual([]);
});
