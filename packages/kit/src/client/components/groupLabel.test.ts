import { expect, test } from 'vitest';
import { choiceWord, dressFor, groupLabel, sayValue, wordFor } from './valueModel.js';

test('group captions humanize declared vocabularies, not arbitrary identifiers', () => {
  expect(groupLabel({ tone: { closed_won: 'good' } }, 'closed_won')).toBe('Closed won');
  expect(groupLabel({ tone: { closed_won: 'good' } }, 'prospecting')).toBe('Prospecting');
  expect(groupLabel(null, 'account_id')).toBe('account_id');
  expect(groupLabel(null, '9007199254740993')).toBe('9007199254740993');
  expect(groupLabel(null, null)).toBe('—');
});

test('a vocabulary is worded one way whichever joiner the schema spelled it with', () => {
  const rule = { tone: { done: 'good', 'in progress': 'info', 'no-show': 'bad', in_review: 'warn' } };
  expect(['done', 'in progress', 'in_review', 'no-show'].map((value) => groupLabel(rule, value))).toEqual([
    'Done',
    'In progress',
    'In review',
    'No-show',
  ]);
  // Codes, names and phrases with punctuation stay as stored.
  expect(['RNO', 'Dr. Webb', 'iPhone 15', 'a, b'].map((value) => groupLabel(rule, value))).toEqual([
    'RNO',
    'Dr. Webb',
    'iPhone 15',
    'a, b',
  ]);
});

test('humanize, a picker and a chip say the same word for one value', () => {
  const humanize = { humanize: true };
  expect(wordFor(humanize, 'annual physical')).toBe('Annual physical');
  expect(wordFor(humanize, 'IN_REVIEW')).toBe('In review');
  expect(wordFor(humanize, 'shippedOn')).toBe('Shipped on');
  expect(choiceWord(null, 'off track')).toBe('Off track');
  expect(choiceWord({ values: { 'off track': 'Behind' } }, 'off track')).toBe('Behind');
  expect(dressFor({ tone: { 'in progress': 'info' } }, 'in progress')).toMatchObject({ kind: 'tone', label: 'In progress' });
});

test('an integer a CHECK pins to 0 and 1 reads as yes or no, a plain integer as a number', () => {
  const flag = { name: 'auto_renew', type: 'INTEGER', nullable: false, primaryKey: false, flag: true as const };
  expect(sayValue(flag, 1)).toMatchObject({ kind: 'boolean', on: true, title: '1' });
  expect(sayValue(flag, 0)).toMatchObject({ kind: 'boolean', on: false });
  expect(sayValue({ ...flag, flag: undefined }, 1)).toMatchObject({ kind: 'number' });
});
