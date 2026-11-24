/**
 * The charts' rules with no drawing in them, held once for both chart families: the kit's dashboard charts and the
 * page charts each had a copy of most of these, and the cases marked "both" are where the two copies had drifted.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AXIS_CHAR_PX,
  areaPath,
  bandsAlong,
  barSpan,
  compactAround,
  donutArcs,
  estimateTextWidth,
  extentOf,
  formatChartNumber,
  formatExactNumeric,
  linePath,
  nearestPoint,
  pointAlong,
  readChartValue,
  sliceRing,
  stackExtent,
  stackSums,
  stepTarget,
  thinAxisLabels,
  valueAxisGutter,
  valueScale,
} from './core.js';

describe('the core is rules only', () => {
  it('imports no React, no UI SDK and no renderer, so the kit can take it without the page charts', () => {
    for (const file of ['core.ts', 'chartFormat.ts', 'chartPath.ts', 'chartScale.ts']) {
      const source = readFileSync(join(import.meta.dirname, file), 'utf8');
      const imported = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]!);
      for (const name of imported) {
        expect(name, `${file} imports ${name}`).toMatch(/^\.\/chart(Format|Path|Scale)\.js$|^\.\.\/internal\/(niceTicks|locale)\.js$/);
      }
    }
  });
});

describe('reading a value', () => {
  it('reads an absent value as absent, not as zero (both: the dashboard charts read null and "" as 0)', () => {
    expect(readChartValue(null).value).toBeNull();
    expect(readChartValue(undefined).value).toBeNull();
    expect(readChartValue(Number.NaN).value).toBeNull();
    expect(readChartValue(Number.POSITIVE_INFINITY).value).toBeNull();
    expect(readChartValue('').value).toBeNull();
    expect(readChartValue('   ').value).toBeNull();
    expect(readChartValue('n/a').value).toBeNull();
    expect(readChartValue(true).value).toBeNull();
    expect(readChartValue(0).value).toBe(0);
    expect(readChartValue(' 12 ').value).toBe(12);
  });

  it('keeps the digits a number would round (both: the dashboard charts said them rounded)', () => {
    expect(readChartValue('12').exact).toBeUndefined();
    expect(readChartValue('9007199254740993')).toEqual({ value: 9007199254740992, exact: '9007199254740993' });
    expect(readChartValue('-9007199254740993').exact).toBe('-9007199254740993');
    expect(readChartValue('0.12345678901234567').exact).toBe('0.12345678901234567');
    expect(readChartValue('1234.5').exact).toBeUndefined();
    expect(readChartValue(9007199254740993n).exact).toBe('9007199254740993');
    expect(readChartValue(12n)).toEqual({ value: 12 });
  });

  it('says those digits exactly, grouped, and a figure in its default words', () => {
    expect(formatExactNumeric('9007199254740993', 'en-US')).toBe('9,007,199,254,740,993');
    expect(formatChartNumber(1234.56, 'en-US')).toBe('1,234.6');
    expect(formatChartNumber(12_500, 'en-US')).toBe('12.5K');
    expect(formatChartNumber(Number.NaN, 'en-US')).toBe('0');
  });
});

describe('a value axis', () => {
  it('finds the extent of a series too long to spread into Math.min', () => {
    const long = Array.from({ length: 300_000 }, (_, i) => i % 97);
    expect(extentOf(long)).toEqual({ min: 0, max: 96 });
    expect(extentOf([], 0, 0)).toEqual({ min: 0, max: 0 });
  });

  it('rules all-zero and empty figures 0 to 1 (both: the page charts invented 0 to 10)', () => {
    for (const figures of [extentOf([0, 0, 0]), extentOf([]), { min: Number.NaN, max: Number.NaN }]) {
      for (const intervals of [2, 4]) {
        const scale = valueScale(figures, { intervals });
        expect(scale.levels).toEqual([0, 1]);
        expect(scale.span).toBe(1);
      }
    }
  });

  it('keeps zero on the axis for all-equal, single and negative figures', () => {
    expect(valueScale(extentOf([5, 5, 5])).levels).toEqual([0, 2, 4, 6]);
    expect(valueScale(extentOf([5])).levels).toEqual([0, 2, 4, 6]);
    const below = valueScale(extentOf([-8, -3]));
    expect(below.levels).toEqual([-10, -5, 0]);
    expect(below.share(0)).toBe(1);
    expect(below.share(-10)).toBe(0);
  });

  it('covers mixed signs with round levels through zero, and keeps a target in view', () => {
    const mixed = valueScale(extentOf([-30, 45]), { intervals: 4 });
    expect(mixed.levels).toEqual([-40, -20, 0, 20, 40, 60]);
    expect(mixed.share(10)).toBeCloseTo(0.5);
    expect(valueScale(extentOf([2, 4, 9])).levels).toEqual([0, 5, 10]);
    expect(valueScale(extentOf([2, 4, 9]), { also: [40] }).max).toBe(40);
    expect(valueScale(extentOf([2, 4, 9]), { also: [-5] }).min).toBe(-5);
    expect(valueScale(extentOf([2, 4, 9]), { also: [Number.NaN] }).levels).toEqual([0, 5, 10]);
  });

  it('takes only the steps it is given, where it is given them', () => {
    expect(valueScale(extentOf([0, 5000]), { steps: [60, 3600, 7200] }).levels).toEqual([0, 3600, 7200]);
  });

  it('sums a stack above and below the zero line, an absent part in neither', () => {
    expect(stackSums([3, -2, null, 4, undefined, Number.NaN])).toEqual({ up: 7, down: -2, total: 5 });
    expect(
      stackExtent([
        [3, -2, 4],
        [10, null],
        [-6, -1],
      ]),
    ).toEqual({ min: -7, max: 10 });
    expect(stackExtent([])).toEqual({ min: 0, max: 0 });
  });
});

describe('along the plot', () => {
  it('spaces points end to end and stands a lone one in the middle', () => {
    expect([0, 1, 2].map((i) => pointAlong(i, 3, 40, 200))).toEqual([40, 140, 240]);
    expect(pointAlong(0, 1, 40, 200)).toBe(140);
  });

  it('names the point nearest a position, inside the run, and the first where there is no position', () => {
    expect(nearestPoint(145, 3, 40, 200)).toBe(1);
    expect(nearestPoint(-500, 3, 40, 200)).toBe(0);
    expect(nearestPoint(9000, 3, 40, 200)).toBe(2);
    expect(nearestPoint(Number.NaN, 3, 40, 200)).toBe(0);
    expect(nearestPoint(100, 1, 40, 200)).toBe(0);
  });

  it('lays out bands with a capped bar centred in each', () => {
    const bands = bandsAlong(4, 20, 400, { share: 0.5, widest: 30, narrowest: 2 });
    expect(bands.band).toBe(100);
    expect(bands.bar).toBe(30);
    expect(bands.barStart(1)).toBe(155);
    expect(bands.mid(1)).toBe(170);
    expect(bands.at(20)).toBe(0);
    expect(bands.at(419)).toBe(3);
    expect(bands.at(5000)).toBe(3);
    expect(bandsAlong(0, 0, 100, { share: 0.5 }).band).toBe(100);
  });

  it('puts one edge of every bar on the zero line, whichever side its value is on', () => {
    /* Zero drawn at 100: a positive value above it at 40, a negative below it at 130. */
    expect(barSpan(40, 100)).toEqual({ start: 40, length: 60 });
    expect(barSpan(130, 100)).toEqual({ start: 100, length: 30 });
    expect(barSpan(100, 100)).toEqual({ start: 100, length: 0 });
    expect(barSpan(100.2, 100, 1).length).toBe(1);
  });
});

describe('the words on an axis', () => {
  const page = (text: string) => estimateTextWidth(text, AXIS_CHAR_PX.page);
  const dashboard = (text: string) => estimateTextWidth(text, AXIS_CHAR_PX.dashboard, 4);
  const along = (n: number, from: number, to: number) => (i: number) => from + (i / (n - 1)) * (to - from);
  const endsInside = (last: number) => (index: number) =>
    (index === 0 ? 'start' : index === last ? 'end' : 'middle') as 'start' | 'middle' | 'end';
  const box = (mark: { index: number; text: string; anchor: string }, at: (i: number) => number, width: (text: string) => number) => {
    const w = width(mark.text),
      x = at(mark.index);
    return mark.anchor === 'start' ? [x, x + w] : mark.anchor === 'end' ? [x - w, x] : [x - w / 2, x + w / 2];
  };
  const dates = Array.from({ length: 16 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);

  it('names every point when they fit', () => {
    const names = ['Wedding', 'Gala', 'Retreat', 'Launch', 'Summit', 'Party'];
    const marks = thinAxisLabels(6, along(6, 46, 436), { text: (i) => names[i]!, width: page, gap: 10, anchor: () => 'middle' });
    expect(marks.map((mark) => mark.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it.each([
    ['the page face', page, 10],
    ['the dashboard face', dashboard, 12],
  ])('thins sixteen dates to a regular stride that keeps both ends and lets none touch, in %s (both)', (_face, width, gap) => {
    const at = along(16, 46, 436);
    const marks = thinAxisLabels(16, at, { text: (i) => dates[i]!, width, gap, anchor: endsInside(15) });
    expect(marks[0]!.index).toBe(0);
    expect(marks.at(-1)!.index).toBe(15);
    const strides = marks.slice(1, -1).map((mark, k) => mark.index - marks[k]!.index);
    expect(new Set(strides).size).toBe(1);
    for (let k = 1; k < marks.length; k++)
      expect(box(marks[k]!, at, width)[0]! - box(marks[k - 1]!, at, width)[1]!).toBeGreaterThanOrEqual(gap);
  });

  it('budgets a label where it is anchored: a first label starting at its point reaches further than a centred one', () => {
    const at = along(16, 46, 436);
    const centred = thinAxisLabels(16, at, { text: (i) => dates[i]!, width: page, gap: 10, anchor: () => 'middle' });
    const inside = thinAxisLabels(16, at, { text: (i) => dates[i]!, width: page, gap: 10, anchor: endsInside(15) });
    expect(centred[1]!.index).toBeLessThan(inside[1]!.index);
  });

  it('lets the regular mark before the last give way to it, and tries a longer stride for a clash further in', () => {
    /* Ten points 30 apart, labels 40 wide: every second fits (0,2,4,6,8), but 8 and 9 would meet, so 8 gives way. */
    const marks = thinAxisLabels(10, (i) => i * 30, { text: () => 'abcd', width: () => 40, gap: 10, anchor: () => 'middle' });
    expect(marks.map((mark) => mark.index)).toEqual([0, 2, 4, 6, 9]);
  });

  it('names the last point alone when not even the two ends fit, and nothing when there are no points', () => {
    const marks = thinAxisLabels(5, (i) => i * 5, { text: (i) => `label ${i}`, width: () => 60, gap: 10, anchor: () => 'middle' });
    expect(marks.map((mark) => mark.index)).toEqual([4]);
    expect(thinAxisLabels(0, () => 0, { text: () => '', width: () => 0, gap: 10, anchor: () => 'middle' })).toEqual([]);
    expect(thinAxisLabels(1, () => 50, { text: () => 'only', width: page, gap: 10, anchor: () => 'middle' })).toEqual([
      { index: 0, text: 'only', anchor: 'middle' },
    ]);
  });

  it('says a label knowing the named point before it, and budgets it at what it says', () => {
    const years = ['2025', '2025', '2026', '2026'];
    const seen: Array<[number, number | undefined]> = [];
    const marks = thinAxisLabels(4, (i) => i * 100, {
      text: (index, previous) => {
        seen.push([index, previous]);
        return previous !== undefined && years[previous] === years[index] ? 'm' : `m ${years[index]}`;
      },
      width: page,
      gap: 10,
      anchor: () => 'middle',
    });
    expect(marks.map((mark) => mark.text)).toEqual(['m 2025', 'm', 'm 2026', 'm']);
    expect(seen).toContainEqual([0, undefined]);
    expect(seen).toContainEqual([3, 2]);
  });

  it('makes the value gutter as wide as its widest label, never cut, with a floor for short ones', () => {
    const money = (v: number) => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    const ticks = [0, 4000, 8000, 12000];
    const wide = valueAxisGutter(ticks, money, { width: page, inset: 10, floor: 46, ceiling: 134, whole: true });
    expect(wide.pad).toBe(Math.ceil('$12,000.00'.length * 7.2) + 10);
    expect(wide.say(12000)).toBe('$12,000.00');
    expect(valueAxisGutter([0, 5, 10], String, { width: page, inset: 10, floor: 46 }).pad).toBe(46);
    /* The dashboard's: no floor, the label's own width (both: its gutter was always this; the page charts' was fixed). */
    expect(valueAxisGutter([0, 5, 10], String, { width: dashboard, inset: 6 }).pad).toBe(2 * 6.6 + 4 + 6);
  });

  it('says the ticks a shorter way past the ceiling where there is one, and never clips where there is not', () => {
    const long = (v: number) => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2 })} USD`;
    const ticks = [0, 4000, 8000, 12000];
    const capped = valueAxisGutter(ticks, long, {
      width: page,
      inset: 10,
      floor: 46,
      ceiling: 88,
      whole: true,
      shorten: () => compactAround(ticks, long, 'en-US'),
    });
    expect(ticks.map(capped.say)).toEqual(['$0 USD', '$4K USD', '$8K USD', '$12K USD']);
    expect(capped.pad).toBeLessThanOrEqual(88);
    const uncapped = valueAxisGutter(ticks, long, { width: page, inset: 10, ceiling: 88 });
    expect(uncapped.say(12000)).toBe('$12,000.00 USD');
    expect(uncapped.pad).toBeGreaterThan(88);
    expect(compactAround([-12000, 0], (v) => `${v} kg`, 'en-US')(-12000)).toBe('−12K kg');
  });
});

describe('stepping by keyboard', () => {
  it('moves to the neighbours and the ends, stops at them, and leaves other keys to the page', () => {
    expect(stepTarget('ArrowRight', null, 3)).toBe(0);
    expect(stepTarget('ArrowLeft', null, 3)).toBe(2);
    expect(stepTarget('ArrowRight', 1, 3)).toBe(2);
    expect(stepTarget('ArrowRight', 2, 3)).toBe(2);
    expect(stepTarget('ArrowLeft', 0, 3)).toBe(0);
    expect(stepTarget('Home', 2, 3)).toBe(0);
    expect(stepTarget('End', 0, 3)).toBe(2);
    expect(stepTarget('ArrowDown', 0, 3)).toBe(1);
    expect(stepTarget('ArrowDown', 0, 3, { vertical: false })).toBeUndefined();
    expect(stepTarget('Escape', 0, 3)).toBeUndefined();
    expect(stepTarget('ArrowRight', null, 0)).toBeUndefined();
  });
});

describe('paths', () => {
  const coords = (d: string) => [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as const);

  it('draws straight segments in one format, for one point, two, and none', () => {
    expect(
      linePath([
        [0, 10],
        [50, 0],
        [100, 7.25],
      ]),
    ).toBe('M0.0,10.0 L50.0,0.0 L100.0,7.3');
    expect(linePath([[5, 5]])).toBe('M5.0,5.0');
    expect(linePath([[1, 2.345]], false, 2)).toBe('M1.00,2.35');
    expect(linePath([])).toBe('');
    expect(
      linePath(
        [
          [0, 0],
          [10, 10],
        ],
        true,
      ),
    ).toBe('M0.0,0.0 L10.0,10.0');
  });

  it('draws a smooth line through every point without passing any (both: one monotone rule, where there were two)', () => {
    const pts = [
      [0, 100],
      [50, 20],
      [100, 20],
      [150, 90],
      [200, 10],
    ] as const;
    const d = linePath(pts, true);
    expect(d.match(/C/g)).toHaveLength(4);
    const all = coords(d);
    /* M, then three coordinates a segment: two controls and the point. */
    for (let i = 0; i < pts.length - 1; i++) {
      const [c1, c2, end] = [all[1 + i * 3]!, all[2 + i * 3]!, all[3 + i * 3]!];
      expect(end).toEqual(pts[i + 1]);
      const lo = Math.min(pts[i]![1], pts[i + 1]![1]) - 0.05,
        hi = Math.max(pts[i]![1], pts[i + 1]![1]) + 0.05;
      for (const control of [c1, c2]) {
        expect(control[1]).toBeGreaterThanOrEqual(lo);
        expect(control[1]).toBeLessThanOrEqual(hi);
      }
    }
    /* A flat stretch stays flat: no bulge between two equal points. */
    expect(all[4]![1]).toBe(20);
    expect(all[5]![1]).toBe(20);
  });

  it('closes an area back along its level, and has none without a line', () => {
    expect(areaPath('M0.0,5.0 L10.0,2.0', 0, 10, 20)).toBe('M0.0,5.0 L10.0,2.0 L10.0,20.0 L0.0,20.0 Z');
    expect(areaPath('', 0, 10, 20)).toBe('');
    expect(areaPath('M0.00,5.00', 0, 0, 20, 2)).toBe('M0.00,5.00 L0.00,20.00 L0.00,20.00 Z');
  });
});

describe('a donut', () => {
  it('divides the ring by share, each slice starting where the last ended', () => {
    const arcs = donutArcs([50, 25, 25], 100);
    expect(arcs.map((arc) => arc.share)).toEqual([0.5, 0.25, 0.25]);
    expect(arcs.map((arc) => arc.start)).toEqual([0, 50, 75]);
    expect(arcs.map((arc) => arc.length)).toEqual([50, 25, 25]);
  });

  it('parts neighbours by the gap, and a slice too thin to spare it keeps its whole arc (both: the page charts drew it as nothing)', () => {
    const arcs = donutArcs([990, 9, 1], 100, 0.8);
    expect(arcs[0]!.length).toBeCloseTo(99 - 0.8);
    expect(arcs[1]!.length).toBeCloseTo(0.9);
    expect(arcs[2]!.length).toBeCloseTo(0.1);
    for (const arc of arcs) expect(arc.length).toBeGreaterThan(0);
    expect(arcs.reduce((sum, arc) => sum + arc.sweep, 0)).toBeCloseTo(100);
  });

  it('gives no share to a value that is not above zero, and none to anything when nothing is', () => {
    const arcs = donutArcs([42, 18, -5, Number.NaN, 0], 200);
    expect(arcs.map((arc) => arc.share)).toEqual([0.7, 0.3, 0, 0, 0]);
    expect(arcs[2]).toMatchObject({ sweep: 0, length: 0 });
    expect(donutArcs([0, -1], 100).every((arc) => arc.share === 0 && arc.length === 0)).toBe(true);
  });

  it("outlines a slice's arc for its focus ring, and a whole ring as two circles", () => {
    const quarter = sliceRing(21, 15.9155, 75, 25);
    expect(quarter.startsWith('M ')).toBe(true);
    expect(quarter.match(/ A /g)).toHaveLength(2);
    expect(sliceRing(21, 15.9155, 75, 100).match(/M /g)).toHaveLength(2);
  });
});
