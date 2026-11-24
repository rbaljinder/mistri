/**
 * What the dashboard's charts share: their sayers, period ticks, the axis marks
 * and levels bound to the dashboard's face, and stepped hue ramps. The rules
 * with no drawing in them come from `@mistriwork/ui/charts/core.js`.
 */
import {
  AXIS_CHAR_PX,
  estimateTextWidth,
  f1,
  linePath,
  readChartValue,
  stepTarget,
  thinAxisLabels,
  valueAxisGutter,
  valueScale,
  type ValueScale,
} from '@mistriwork/ui/charts/core.js';
import { formatDate } from '../locale.js';
import { say as sayCopy } from '../copy/dashboards/components/Chart.js';

export interface ChartRow {
  key: unknown;
  value: unknown;
}

/** How a figure is said; its `tick`, where it has one, is how an axis says a round level ("$2K", not "$2,000.00"). */
export type Say = ((v: unknown) => string) & { tick?: ((v: unknown) => string) & { steps?: readonly number[] } };

/** An axis's words for a level: the sayer's axis form, else the sayer itself. */
export const tickSay = (say: Say) => say.tick ?? say;

export interface Point {
  key: string;
  value: number;
  /** The measure's digits as they came, where a number rounds them (past 2^53): what the words say (`sayMeasure`). */
  exact?: string;
  /** The row's key as it came, where a point drills: a gap-filled bucket has none. */
  raw?: unknown;
}

/** The periods a window cuts through (shared/autoBucket.ts `partialPeriods`): a bucket drawn from only part of its days. */
export interface PartialPeriods {
  keys: ReadonlySet<string>;
  unit: 'week' | 'month' | 'quarter';
}

/* The rules with no drawing in them (scales, levels, paths, how a value is read) are `@mistriwork/ui`'s chart core,
   which the page charts (`@mistriwork/mistri/charts`) draw from too: a fix to an axis is made there, once. What is
   here binds them to the dashboard's own face, sayers and periods. */
export { f1, linePath };

/**
 * A row's measure as a chart plots it, or nothing where there is none to plot: null, an empty string and a word
 * that is no number are absent, not zero (`Number(null)` is 0, and a bar drawn at it is a measurement nobody took).
 * A period nothing was counted in is a different thing, and is still put back at zero (chart.js, fillGaps).
 */
export function measureOf(value: unknown): { value: number; exact?: string } | undefined {
  const reading = readChartValue(value);
  return reading.value === null ? undefined : { ...reading, value: reading.value };
}

/** A plotted measure in the chart's words: its digits as they came where a number would round them. */
export const sayMeasure = (say: Say, measure: { value: number; exact?: string }): string => say(measure.exact ?? measure.value);

/** The value axis of a dashboard chart: round levels over the figures and the target, two steps or so (ChartLines, ChartBars). */
export function levelsOver(figures: { min: number; max: number }, say: Say, goal?: number): ValueScale {
  return valueScale(figures, { intervals: 2, steps: say.tick?.steps, also: goal === undefined ? [] : [goal] });
}

/** The gutter left of the plot the levels are said in: as wide as the widest of them. A sayer's axis form (`tick`)
    is already its short one, and a sayer may convert what it is given (minor units, a duration), so there is no
    compact fallback here as the page charts have. */
export const levelGutter = (levels: readonly number[], say: Say): number =>
  valueAxisGutter(levels, tickSay(say), { width: tickWidth, inset: 6 }).pad;

/**
 * Where a key takes the keyboard among a figure's doors (the points or columns that drill), from the door at index
 * `from`: the arrows to its neighbours, Home and End to the ends, or nothing where the key is the page's (an arrow
 * past either end, Up and Down).
 */
export function doorStep(key: string, doors: readonly number[], from: number): number | undefined {
  const at = doors.indexOf(from);
  const to = stepTarget(key, at, doors.length, { vertical: false });
  if (to === undefined || (to === at && key !== 'Home' && key !== 'End')) return undefined;
  return doors[to];
}

const MONTH = /^(\d{4})-(\d{2})$/;
const DAY = /^(\d{4})-\d{2}-\d{2}$/;

/** Whether a key is a period the grammar buckets by ("2026-08", "2026-Q3"). */
export const PERIOD = /^\d{4}(-\d{2}(-\d{2})?|-Q[1-4])?$/;

/** A category's key as a chart says it unless told otherwise: a bucket of no value is a dash, never "null". The
    caller's `label` (a column's groupLabel) says it in the field's own `empty` word where it has one. */
export const keyWord = (key: unknown): string => (key == null ? '—' : String(key));

/**
 * A month bucket as a reader says it, in the App's locale: "Jan 2026" where
 * the year starts or changes from the tick before it, "Feb" after it. The
 * grammar spells a month `2026-01` on every engine, which is a key, not a
 * word; any other key is said as it came.
 */
export function periodTick(key: string, previous?: string): string {
  /* A day is said as a month's is, "Sep 10, 2026" then "Sep 11": a stacked
     bar over days read "2026-09-10", a key where every other chart said a date. */
  const day = DAY.exec(key);
  if (day) {
    const year = !previous || DAY.exec(previous)?.[1] !== day[1];
    return formatDate(key, year ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' });
  }
  const month = MONTH.exec(key);
  if (!month) return key;
  const year = !previous || MONTH.exec(previous)?.[1] !== month[1];
  return formatDate(`${key}-01`, year ? { month: 'short', year: 'numeric' } : { month: 'short' });
}

/**
 * Step `i` of `n` along one hue, for series over a scale (a priority, a
 * severity, an age in days): categorical hues said Medium and High in two
 * greens a reader could not tell apart, and said nothing of which came
 * first. The first step is the lead series deepened toward the ink, the last
 * the same hue washed toward the surface, mixed in OKLab so the steps are
 * even to the eye; by night the ink is light and the surface dark, so the
 * first step is still the one that stands out. Tokens only: an App's accent
 * and its dark pair carry through.
 */
export function rampInk(i: number, n: number): string {
  const lead = 'var(--chart-1, var(--accent))';
  if (n <= 1) return lead;
  const strong = Math.round(100 * (1 - Math.min(Math.max(i / (n - 1), 0), 1)));
  return `color-mix(in oklab, color-mix(in oklab, ${lead}, var(--ink) 30%) ${strong}%, color-mix(in oklab, ${lead}, var(--surface) 55%))`;
}

/** The width a tick's words take at the axis's 11px, budgeted generously: a label that overlaps its neighbour is worse than one left out. */
export const tickWidth = (text: string) => estimateTextWidth(text, AXIS_CHAR_PX.dashboard, 4);

/**
 * Which points the x axis names, and what it calls each: as many as fit the
 * width at a regular stride, the first and the last always among them (the
 * shared rule, thinAxisLabels). A month says its year only where the year
 * turns from the mark before it, and a mark is budgeted at what it will
 * actually say — "Oct", not "Oct 2025" — so a month that has room is not
 * dropped for a year it would not have shown.
 *
 * A mark is budgeted where it is drawn: a line's first and last words stand
 * inside the plot, starting and ending at their points; a bar's are centred
 * under their bars, as every other mark is (`centered`). Budgeting a bar's
 * as a line's took a whole word's width twice, and a half-width bar chart
 * named only its first and last month.
 */
export function axisMarks(keys: string[], at: (i: number) => number, { centered = false } = {}): Array<{ index: number; text: string }> {
  const last = keys.length - 1;
  return thinAxisLabels(keys.length, at, {
    text: (index, previous) => periodTick(keys[index], previous === undefined ? undefined : keys[previous]),
    width: tickWidth,
    gap: 12,
    anchor: (index) => (centered ? 'middle' : index === 0 ? 'start' : index === last ? 'end' : 'middle'),
  }).map(({ index, text }) => ({ index, text }));
}

/* Two names closer than a line of small text overlap: each is pushed apart from its neighbor, then the column is
   kept inside the plot. Returned in the order the ends were given. */
export function namesAtEnds(ends: readonly number[], top: number, bottom: number, gap = 14): number[] {
  const order = ends.map((at, i) => ({ at, i })).sort((a, b) => a.at - b.at);
  for (let k = 1; k < order.length; k++) order[k].at = Math.max(order[k].at, order[k - 1].at + gap);
  const over = order.length ? order[order.length - 1].at - bottom : 0;
  if (over > 0) for (const o of order) o.at -= over;
  for (let k = 0; k < order.length; k++) order[k].at = Math.max(order[k].at, top + k * gap);
  const out: number[] = [];
  for (const o of order) out[o.i] = o.at;
  return out;
}

/** A bucket's name, said as partial where its window cuts it, so a short first week and a week still in hand are not read as full ones. */
export const partialName = (label: string, key: unknown, partial: PartialPeriods | undefined): string =>
  partial?.keys.has(String(key))
    ? sayCopy(partial.unit === 'week' ? 'partialWeek' : partial.unit === 'month' ? 'partialMonth' : 'partialQuarter', { label })
    : label;

/** A display tone as the ink it is drawn in (the status tokens, so a look's and a dark mode's own are worn). */
export const TONE_INK: Record<string, string> = {
  good: 'var(--status-good)',
  warn: 'var(--status-warning)',
  bad: 'var(--status-critical)',
  info: 'var(--status-info)',
  neutral: 'var(--ink-subtle)',
};

/** A stacked chart over periods is drawn at this height, as a bar chart's figure is: a fixed figure, so its room is held before its answer. */
export const TIMED_HEIGHT = 180;
