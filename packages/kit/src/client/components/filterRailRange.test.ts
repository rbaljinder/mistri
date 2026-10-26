/**
 * The rail's ranges and shapes: what a number's Min/Max reads out of a
 * question and writes back, the shape a plain column's facet takes, and the
 * view's standing condition every count stands on.
 */
import { describe, expect, test } from 'vitest';
import { withCondition, conditionTail } from '../filterbar.js';
import { autoShape, facetCountText, facetShapeText, numberRangeOf, numberRangeTail } from './filterRailModel.js';

describe("a number's range", () => {
  test('both ends are one between, in order whichever was set first; one end is a bound', () => {
    expect(numberRangeTail('5000', '15000')).toBe('between 5000 and 15000');
    expect(numberRangeTail('15000', '5000')).toBe('between 5000 and 15000');
    expect(numberRangeTail('5000', '')).toBe('>= 5000');
    expect(numberRangeTail('', '15000')).toBe('<= 15000');
    expect(numberRangeTail('', '')).toBe('');
    // A figure that is not a number is no end at all, never a condition the server refuses.
    expect(numberRangeTail('cheap', '15000')).toBe('<= 15000');
  });

  test('reads back the ends it wrote, and nothing it did not', () => {
    expect(numberRangeOf('between 5000 and 15000')).toEqual({ min: '5000', max: '15000' });
    expect(numberRangeOf('>= 5000')).toEqual({ min: '5000', max: '' });
    expect(numberRangeOf('<= 15000')).toEqual({ min: '', max: '15000' });
    expect(numberRangeOf('= 5000')).toEqual({ min: '', max: '' });
    expect(numberRangeOf('between 2026-01-01 and 2026-02-01')).toEqual({ min: '', max: '' });
  });

  test('a range is one condition in the question, which the rail reads back whole', () => {
    const text = withCondition('make = Toyota', 'price', numberRangeTail('5000', '15000'));
    expect(text).toBe('make = Toyota and price between 5000 and 15000');
    expect(numberRangeOf(conditionTail(text, 'price'))).toEqual({ min: '5000', max: '15000' });
  });
});

describe("a plain column's shape", () => {
  test('a number with many values is a range, with a few a checklist', () => {
    expect(autoShape(true, 3, true)).toBe('values');
    expect(autoShape(true, 12, true)).toBe('values');
    expect(autoShape(true, 13, true)).toBe('range');
    expect(autoShape(true, 51, false)).toBe('range');
  });

  test('text with a few dozen values is a checklist, more a contains box', () => {
    expect(autoShape(false, 12, true)).toBe('values');
    expect(autoShape(false, 50, true)).toBe('values');
    expect(autoShape(false, 51, false)).toBe('text');
  });

  test("is judged over the rows the view stands on, never the reader's narrowing", () => {
    expect(facetShapeText('vehicle', 'price', 'status != sold')).toBe('vehicle status != sold count by price sort count desc');
    expect(facetShapeText('task', 'priority')).toBe('task count by priority sort count desc');
  });
});

describe('the standing condition', () => {
  test("every count stands on it, beside the reader's question and without the facet's own condition", () => {
    expect(facetCountText('vehicle', 'make = Toyota and fuel = Hybrid sort price', 'fuel', undefined, 'status != sold')).toBe(
      'vehicle status != sold and make = Toyota count by fuel sort count desc',
    );
    // No standing condition, as before.
    expect(facetCountText('task', 'status = open', 'priority')).toBe('task status = open count by priority sort count desc');
  });
});
