/**
 * The client's pure helpers, run in Node behind the same DOM stub the
 * mirrors test uses. Nothing here touches a browser; these are the rules
 * a dashboard or a record page applies to values before drawing them, and
 * until now the only coverage they had was a screenshot.
 */
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';

type Chart = typeof import('../packages/kit/src/client/chart.js');

let chart: Chart;

function stubDom() {
  const node = () => ({
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    dataset: {},
    hidden: false,
    textContent: '',
    children: [],
    childNodes: [],
    addEventListener() {},
    removeEventListener() {},
    append() {},
    remove() {},
    appendChild() {},
    setAttribute() {},
    replaceChildren() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  });
  (globalThis as Record<string, unknown>).document = {
    readyState: 'complete',
    body: node(),
    documentElement: node(),
    addEventListener() {},
    removeEventListener() {},
    createElement: node,
    createElementNS: node,
    createTextNode: () => ({}),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  (globalThis as Record<string, unknown>).window = {
    localStorage: undefined,
    location: { hash: '', href: 'http://localhost/', pathname: '/' },
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };
}

before(async () => {
  stubDom();
  chart = await import('../packages/kit/src/client/chart.js');
});

describe('fillGaps', () => {
  type Point = { key: string; value: number };
  const pts = (...keys: string[]): Point[] => keys.map((key, i) => ({ key, value: i + 1 }));
  const keysOf = (points: Point[]) => points.map((p) => p.key);

  test('puts the missing months back at zero, in order', () => {
    const filled = chart.fillGaps(pts('2025-11', '2026-01', '2026-04')) as Point[];
    assert.deepEqual(keysOf(filled), ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04']);
    assert.deepEqual(
      filled.map((p: Point) => p.value),
      [1, 0, 2, 0, 0, 3],
    );
  });

  test('knows days, quarters and years', () => {
    assert.deepEqual(keysOf(chart.fillGaps(pts('2026-02-27', '2026-03-02')) as Point[]), [
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
      '2026-03-02',
    ]);
    assert.deepEqual(keysOf(chart.fillGaps(pts('2025-Q3', '2026-Q2')) as Point[]), ['2025-Q3', '2025-Q4', '2026-Q1', '2026-Q2']);
    assert.deepEqual(keysOf(chart.fillGaps(pts('2023', '2026')) as Point[]), ['2023', '2024', '2025', '2026']);
  });

  test('knows a week by its first day: the missing weeks come back at zero, a week apart', () => {
    const filled = chart.fillGaps(pts('2026-09-21', '2026-10-12', '2026-09-28')) as Point[];
    assert.deepEqual(keysOf(filled), ['2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12']);
    assert.deepEqual(
      filled.map((p: Point) => p.value),
      [1, 3, 0, 2],
    );
  });

  test('puts periods in time order first, whatever order they came in', () => {
    const filled = chart.fillGaps([
      { key: '2026-02', value: 5 },
      { key: '2025-12', value: 9 },
    ]) as Point[];
    assert.deepEqual(keysOf(filled), ['2025-12', '2026-01', '2026-02']);
    assert.deepEqual(
      filled.map((p: Point) => p.value),
      [9, 0, 5],
    );
  });

  test('leaves keys that are not periods alone, and a mix alone', () => {
    const cats = pts('north', 'south');
    assert.deepEqual(chart.fillGaps(cats), cats);
    const mixed = pts('2026-01', 'north');
    assert.deepEqual(chart.fillGaps(mixed), mixed);
    assert.deepEqual(chart.fillGaps(pts('2026-01')), pts('2026-01'), 'one point has no gap to fill');
  });
});
