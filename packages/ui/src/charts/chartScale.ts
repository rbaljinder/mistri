/**
 * Where a chart puts things, with no drawing in it: a value axis's range and round levels, how far along a point or
 * a band stands, a bar's span from the zero line, which axis labels are named, and how wide the gutter of a value
 * axis is. The declarative dashboard charts (the kit's) and the free-form page charts (`charts.ts`) both draw from
 * these, so a fix to an axis is made once. No React and no DOM: the kit imports this without the renderers.
 */
import { niceScale, type NiceScale } from '../internal/niceTicks.js';

export { DURATION_STEPS, niceScale, type NiceScale } from '../internal/niceTicks.js';

/** Lowest and highest of a list, by a loop: spreading a long series into `Math.min` overflows the call stack. */
export function extentOf(values: ReadonlyArray<number>, floor = Infinity, ceiling = -Infinity): { min: number; max: number } {
  let min = floor;
  let max = ceiling;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

/** A value axis: round levels over the figures, and how far up it a value stands. */
export interface ValueScale extends NiceScale {
  /** `max - min`, never zero. */
  span: number;
  /** A value's share of the way from `min` to `max`. */
  share: (value: number) => number;
}

/*
 * The value axis every bar, line and area is measured on. Zero is always on it: a bar's length and an area's fill
 * are read from the zero line, and a line cut off above it overstates every change. Figures that are all zero, or
 * all absent, are ruled 0 to 1 (niceScale's own rule for a flat range), not at an invented 0 to 10, which read as
 * ten of something nobody counted. `also` are levels kept in view beside the figures (a target).
 */
export function valueScale(
  figures: { min: number; max: number },
  { intervals = 2, steps, also = [] }: { intervals?: number; steps?: readonly number[]; also?: ReadonlyArray<number> } = {},
): ValueScale {
  const { min: low, max: high } = extentOf(also.filter(Number.isFinite), Math.min(figures.min, 0), Math.max(figures.max, 0));
  const scale = niceScale(Number.isFinite(low) ? low : 0, Number.isFinite(high) ? high : 0, intervals, steps);
  const span = scale.max - scale.min || 1;
  return { ...scale, span, share: (value) => (value - scale.min) / span };
}

/** The parts of one stack: what stands above the zero line, what hangs below it, and their sum. */
export function stackSums(parts: ReadonlyArray<number | null | undefined>): { up: number; down: number; total: number } {
  let up = 0;
  let down = 0;
  let total = 0;
  for (const part of parts) {
    if (part === null || part === undefined || !Number.isFinite(part)) continue;
    total += part;
    if (part >= 0) up += part;
    else down += part;
  }
  return { up, down, total };
}

/** The range stacks cover: the tallest above the zero line and the deepest below it, zero included. */
export function stackExtent(stacks: Iterable<ReadonlyArray<number | null | undefined>>): { min: number; max: number } {
  let min = 0;
  let max = 0;
  for (const parts of stacks) {
    const { up, down } = stackSums(parts);
    if (up > max) max = up;
    if (down < min) min = down;
  }
  return { min, max };
}

/** Where point `index` of `count` stands along `length` from `start`: evenly spaced end to end, a lone point in the middle. */
export function pointAlong(index: number, count: number, start: number, length: number): number {
  return start + (count > 1 ? (index * length) / (count - 1) : length / 2);
}

/** The point nearest a position along the same run: the one a pointer there is reading. */
export function nearestPoint(position: number, count: number, start: number, length: number): number {
  if (count <= 1 || !(length > 0) || !Number.isFinite(position)) return 0;
  return Math.min(count - 1, Math.max(0, Math.round(((position - start) / length) * (count - 1))));
}

/** A run of equal bands, one a category, with a bar of `share` of the band (never wider than `widest`) centred in each. */
export interface Bands {
  band: number;
  bar: number;
  /** Where band `index`'s bar starts, and where its middle is. */
  barStart: (index: number) => number;
  mid: (index: number) => number;
  /** The band a position falls in. */
  at: (position: number) => number;
}

export function bandsAlong(
  count: number,
  start: number,
  length: number,
  { share, widest = Infinity, narrowest = 0 }: { share: number; widest?: number; narrowest?: number },
): Bands {
  const band = length / Math.max(1, count);
  const bar = Math.max(narrowest, Math.min(widest, band * share));
  return {
    band,
    bar,
    barStart: (index) => start + band * index + (band - bar) / 2,
    mid: (index) => start + band * (index + 0.5),
    at: (position) => (Number.isFinite(position) ? Math.min(count - 1, Math.max(0, Math.floor((position - start) / band))) : count - 1),
  };
}

/*
 * A bar's span along the value axis, given where its value and the zero line are drawn. It always has one edge on
 * the zero line, whichever side its value is on: a negative bar hangs from it, it does not rise from the plot's
 * floor. `least` keeps a value that is not zero from rounding away to nothing.
 */
export function barSpan(valueAt: number, zeroAt: number, least = 0): { start: number; length: number } {
  return { start: Math.min(valueAt, zeroAt), length: Math.max(Math.abs(valueAt - zeroAt), least) };
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Words on an axis                                                                                                 */
/* ---------------------------------------------------------------------------------------------------------------- */

/*
 * A chart is laid out before there is a rendered label to measure, so a label's width is estimated from its length.
 * The two faces in use: the page charts set axis text at --text-xs, about 7.2px a character for figure-heavy text;
 * the dashboard charts set it at 11px, about 6.6px. One rule, the face a parameter, so the two cannot drift apart
 * in how they budget, only in the size of their type.
 */
export const AXIS_CHAR_PX = { page: 7.2, dashboard: 6.6 } as const;

export function estimateTextWidth(text: string, charPx: number, pad = 0): number {
  return text.length * charPx + pad;
}

type AxisAnchor = 'start' | 'middle' | 'end';

/** One axis label chosen to be drawn: the point it names, what it says and how its text is anchored to the point. */
export interface AxisMark {
  index: number;
  text: string;
  anchor: AxisAnchor;
}

interface AxisThinning {
  /** A point's words, given the named point before it (a month says its year only where the year turns). */
  text: (index: number, previous: number | undefined) => string;
  width: (text: string) => number;
  /** The least room between two labels. */
  gap: number;
  /** How a label is anchored to its point, given where the point is and how wide the label is. */
  anchor: (index: number, at: number, width: number) => AxisAnchor;
}

/*
 * Which points along an axis are named. Every one when they fit; otherwise every second, third, … from the first,
 * the shortest stride whose labels stand clear of each other, each budgeted at what it will actually say and where
 * it is actually anchored. The last point is always named (a reader anchors a series by its ends, and on a time
 * axis the last is the period in hand); the regular mark before it gives way when those two would meet. A clash
 * further in is a stride too short, and the next is tried.
 *
 * Both chart families thinned labels by rules of their own once (a fixed stride from a worst-case width; the most
 * that fit, spread by rounding), and each had the overlap the other had fixed. A stride keeps the marks regular,
 * which an axis of dates wants ("every fifth day") and an axis of names does not mind.
 */
export function thinAxisLabels(count: number, at: (index: number) => number, { text, width, gap, anchor }: AxisThinning): AxisMark[] {
  if (count <= 0) return [];
  const last = count - 1;
  const place = (index: number, previous: number | undefined) => {
    const said = text(index, previous);
    const w = width(said);
    const x = at(index);
    const how = anchor(index, x, w);
    const [left, right] = how === 'start' ? [x, x + w] : how === 'end' ? [x - w, x] : [x - w / 2, x + w / 2];
    return { mark: { index, text: said, anchor: how }, left, right };
  };
  for (let stride = 1; stride <= Math.max(1, last); stride += 1) {
    const placed: Array<ReturnType<typeof place>> = [];
    let clear = true;
    for (let index = 0; index < last && clear; index += stride) {
      const next = place(index, placed.at(-1)?.mark.index);
      clear = placed.length === 0 || next.left - placed.at(-1)!.right >= gap;
      placed.push(next);
    }
    if (!clear) continue;
    let end = place(last, placed.at(-1)?.mark.index);
    if (placed.length > 1 && end.left - placed.at(-1)!.right < gap) {
      placed.pop();
      end = place(last, placed.at(-1)?.mark.index);
    }
    if (placed.length === 0 || end.left - placed.at(-1)!.right >= gap) return [...placed, end].map((one) => one.mark);
  }
  return [place(last, undefined).mark];
}

/*
 * The room a value axis's labels take beside the plot, and how each tick is said in it: as wide as the widest label
 * plus `inset`, so a tick is never cut at the drawing's edge ("$12,000.00" was, to "2,000.00", in a fixed gutter).
 * `floor` keeps short labels from moving the plot. Past `ceiling` the labels would take the plot's own room, so
 * they are said by `shorten` instead, where the caller has a shorter way to say a level.
 */
export function valueAxisGutter(
  ticks: ReadonlyArray<number>,
  format: (tick: number) => string,
  {
    width,
    inset,
    floor = 0,
    ceiling = Infinity,
    shorten,
    whole = false,
  }: {
    width: (text: string) => number;
    inset: number;
    floor?: number;
    ceiling?: number;
    shorten?: () => (tick: number) => string;
    /** Round the labels' width up to a whole pixel, where the gutter is written into the drawing as it is. */
    whole?: boolean;
  },
): { pad: number; say: (tick: number) => string } {
  const need = (say: (tick: number) => string) => {
    const widest = Math.max(...ticks.map((tick) => width(say(tick))), 0);
    return (whole ? Math.ceil(widest) : widest) + inset;
  };
  const full = need(format);
  if (full <= ceiling || !shorten) return { pad: Math.max(floor, full), say: format };
  const say = shorten();
  return { pad: Math.min(ceiling, Math.max(floor, need(say))), say };
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Stepping through the points by keyboard                                                                          */
/* ---------------------------------------------------------------------------------------------------------------- */

/*
 * Where an arrow, Home or End takes the reader among `count` stops, from `current` (null: none yet). It stops at
 * the ends rather than wrapping, since a series has a first and a last. `undefined` is a key that is not a step,
 * left to the page. `vertical` lets Up and Down step too, for a plot that is a single tab stop; a stop that is one
 * of several buttons leaves them to the page's scroll.
 */
export function stepTarget(key: string, current: number | null, count: number, { vertical = true } = {}): number | undefined {
  if (count <= 0) return undefined;
  const last = count - 1;
  if (key === 'ArrowRight' || (vertical && key === 'ArrowDown')) return current === null ? 0 : Math.min(last, current + 1);
  if (key === 'ArrowLeft' || (vertical && key === 'ArrowUp')) return current === null ? last : Math.max(0, current - 1);
  if (key === 'Home') return 0;
  if (key === 'End') return last;
  return undefined;
}
