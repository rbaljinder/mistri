/**
 * Which tabs a strip draws and which go under More (useTabFold.ts): as many as fit in order, room kept for More, and
 * the chosen one always drawn, the ones before it giving way.
 */
import { expect, test } from 'vitest';
import { foldTabs } from './useTabFold.js';

const widths = [60, 80, 70, 90, 50];
const span = 60 + 80 + 70 + 90 + 50 + 4 * 4;

test('a strip that holds every tab folds none', () => {
  expect(foldTabs(widths, span, 40, 4, 0)).toEqual([0, 1, 2, 3, 4]);
});

test('a strip a pixel short folds from the end, keeping room for More', () => {
  // The first four take 312, and More (40) a gap after them: 356 of 365.
  expect(foldTabs(widths, span - 1, 40, 4, 0)).toEqual([0, 1, 2, 3]);
  // The first three take 218, and More a gap after them: 262 exactly.
  expect(foldTabs(widths, 262, 40, 4, 1)).toEqual([0, 1, 2]);
});

test('the chosen tab is never folded: the last that fit give way to it, and order is kept', () => {
  expect(foldTabs(widths, 262, 40, 4, 4)).toEqual([0, 1, 4]);
  expect(foldTabs(widths, 262, 40, 4, 3)).toEqual([0, 3]);
});

test('a room that holds only More and the chosen tab draws those', () => {
  expect(foldTabs(widths, 140, 40, 4, 3)).toEqual([3]);
  expect(foldTabs(widths, 10, 40, 4, 2)).toEqual([2]);
});
