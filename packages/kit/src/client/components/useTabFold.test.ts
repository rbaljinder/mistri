/**
 * Which tabs a strip draws and which go under More (useTabFold.ts): as many as fit in order, room kept for More, and
 * the chosen one always drawn, the ones before it giving way.
 */
import { expect, test } from 'vitest';
import { foldTabs, leastStrip } from './useTabFold.js';

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

test('the least a strip is drawn at holds the chosen tab and More beside it, and never more than every tab', () => {
  // Contacts at 320px: "Primary contacts 150" (150) and More (53), a gap between.
  expect(leastStrip([150, 82], 53, 4, 0)).toBe(207);
  expect(leastStrip(widths, 40, 4, 3)).toBe(90 + 4 + 40);
  // Two narrow tabs take less than one and More: the strip asks only for them.
  expect(leastStrip([30, 20], 53, 4, 0)).toBe(54);
  // Nothing chosen: More alone.
  expect(leastStrip(widths, 40, 4, -1)).toBe(40);
});

test('a tab that yields folds before the others, wherever it stands, and order is kept', () => {
  // Tabs 1 and 2 are empty lists kept for their Add: they fold, and the list with rows at the end stays drawn.
  expect(foldTabs(widths, 262, 40, 4, 0, new Set([1, 2]))).toEqual([0, 3, 4]);
  // A yielding tab that is chosen is drawn all the same.
  expect(foldTabs(widths, 262, 40, 4, 1, new Set([1, 2]))).toEqual([0, 1]);
  // Room for every tab: none folds.
  expect(foldTabs(widths, span, 40, 4, 0, new Set([1]))).toEqual([0, 1, 2, 3, 4]);
});
