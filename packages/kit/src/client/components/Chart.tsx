/**
 * Charts for dashboards: a line for how a number moved, bars for how much
 * each group holds, a donut for how a whole divides, stacked bars for how each of several wholes divides, a
 * spark for the shape inside a KPI card. Hand-drawn SVG and HTML, not a
 * dependency. A target is a rule in the ink, said in words beside it.
 *
 * Colour comes from theme tokens: the line uses the accent and categorical
 * slices share their series token with the matching legend swatch. Without
 * preset tokens, the original single-accent, stepped-opacity treatment remains.
 * Values are spoken through the caller's `say` so money charts
 * read "$4.6M" everywhere the number appears.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { viewportBox } from '../core.js';
import { fillGaps, isPeriodRun } from '../chart.js';
import { formatDate, formatPercent } from '../locale.js';
import { niceScale } from '@mistriwork/engine/shared/niceTicks.js';
/* The charts' own sheet travels with the chunk that draws them (onDemand). */
import './Chart.css';
import { say as sayCopy } from '../copy/dashboards/components/Chart.js';

interface ChartRow {
  key: unknown;
  value: unknown;
}
/** How a figure is said; its `tick`, where it has one, is how an axis says a round level ("$2K", not "$2,000.00"). */
type Say = ((v: unknown) => string) & { tick?: ((v: unknown) => string) & { steps?: readonly number[] } };
/** An axis's words for a level: the sayer's axis form, else the sayer itself. */
const tickSay = (say: Say) => say.tick ?? say;

interface Point {
  key: string;
  value: number;
}

const f1 = (n: number) => n.toFixed(1);

const MONTH = /^(\d{4})-(\d{2})$/;
const DAY = /^(\d{4})-\d{2}-\d{2}$/;

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
function rampInk(i: number, n: number): string {
  const lead = 'var(--chart-1, var(--accent))';
  if (n <= 1) return lead;
  const strong = Math.round(100 * (1 - Math.min(Math.max(i / (n - 1), 0), 1)));
  return `color-mix(in oklab, color-mix(in oklab, ${lead}, var(--ink) 30%) ${strong}%, color-mix(in oklab, ${lead}, var(--surface) 55%))`;
}

/** The width a tick's words take at the axis's 11px, budgeted generously: a label that overlaps its neighbour is worse than one left out. */
const tickWidth = (text: string) => text.length * 6.6 + 4;

/**
 * Which points the x axis names, and what it calls each: as many as fit the
 * width, evenly spaced, the first and the last always among them. A month
 * says its year only where the year turns from the mark before it, and a
 * mark is budgeted at what it will actually say — "Oct", not "Oct 2025" — so
 * a month that has room is not dropped for a year it would not have shown.
 *
 * A mark is budgeted where it is drawn: a line's first and last words stand
 * inside the plot, starting and ending at their points; a bar's are centred
 * under their bars, as every other mark is (`centered`). Budgeting a bar's
 * as a line's took a whole word's width twice, and a half-width bar chart
 * named only its first and last month.
 */
export function axisMarks(keys: string[], at: (i: number) => number, { centered = false } = {}): Array<{ index: number; text: string }> {
  const last = keys.length - 1;
  const said = (marks: number[]) => marks.map((index, k) => ({ index, text: periodTick(keys[index], k ? keys[marks[k - 1]] : undefined) }));
  const extent = ({ index, text }: { index: number; text: string }): [number, number] => {
    const p = at(index),
      w = tickWidth(text);
    return !centered && index === 0 ? [p, p + w] : !centered && index === last ? [p - w, p] : [p - w / 2, p + w / 2];
  };
  /* The first pair of neighbours too close to read apart, or -1. */
  const clash = (marks: Array<{ index: number; text: string }>) =>
    marks.findIndex((mark, k) => k > 0 && extent(mark)[0] - extent(marks[k - 1])[1] < 12);
  for (let stride = 1; stride <= Math.max(1, last); stride += 1) {
    const marks: number[] = [];
    for (let i = 0; i < last; i += stride) marks.push(i);
    /* The last point is always named; the evenly spaced mark before it gives
       way when those two would meet — and only then: a clash further in is
       a stride too short, and the next one is tried. */
    marks.push(last);
    let named = said(marks);
    if (marks.length > 2 && clash(named) === marks.length - 1) {
      marks.splice(marks.length - 2, 1);
      named = said(marks);
    }
    if (clash(named) < 0) return named;
  }
  return said([last]);
}

/**
 * A path through points: straight segments, or with `smooth` a monotone cubic
 * (Fritsch–Carlson) — a curve that never overshoots its points, so a smooth
 * line still never says a value the data did not reach.
 */
function linePath(pts: ReadonlyArray<readonly [number, number]>, smooth = false): string {
  if (!smooth || pts.length < 3) return pts.map(([px, py], i) => `${i ? 'L' : 'M'}${f1(px)},${f1(py)}`).join(' ');
  const n = pts.length;
  const dx = (i: number) => pts[i + 1][0] - pts[i][0];
  const slope = Array.from({ length: n - 1 }, (_, i) => (pts[i + 1][1] - pts[i][1]) / (dx(i) || 1));
  const m = pts.map((_, i) =>
    i === 0 ? slope[0] : i === n - 1 ? slope[n - 2] : slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2,
  );
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / slope[i],
      b = m[i + 1] / slope[i];
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i] = t * a * slope[i];
      m[i + 1] = t * b * slope[i];
    }
  }
  let d = `M${f1(pts[0][0])},${f1(pts[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const third = dx(i) / 3;
    d += ` C${f1(pts[i][0] + third)},${f1(pts[i][1] + m[i] * third)} ${f1(pts[i + 1][0] - third)},${f1(pts[i + 1][1] - m[i + 1] * third)} ${f1(pts[i + 1][0])},${f1(pts[i + 1][1])}`;
  }
  return d;
}

/**
 * A time-series line: keys along the bottom, values as an accent line over
 * a soft fill, three labelled gridlines, and a crosshair on hover drawn in
 * the chart rather than left to a native tooltip.
 *
 * Its words are set at their own size wherever it is drawn: the chart
 * measures the width it is given (on the zoom-aware ruler) and draws a
 * viewBox exactly that wide, so a phone does not shrink an 11px label to 6.
 * `wide` is the first guess, before there is a box to measure. The levels
 * are said on the left, in a gutter of their own, where the line cannot
 * run through them. Every point is also a row of a table that assistive
 * technology reads, since a picture's titles are not.
 */
export function LineChart({
  rows,
  say = String,
  wide = 600,
  high,
  target,
  smooth = false,
  dots = false,
  seriesLabel = String,
  seriesVocabulary,
}: {
  /** With `series` on its rows, a line per series (MultiLine). */
  rows: Array<ChartRow & { series?: unknown }>;
  say?: Say;
  wide?: number;
  high?: number;
  target?: number;
  /** A monotone curve through the points instead of straight segments. */
  smooth?: boolean;
  /** Too few filled buckets to draw a line through: the points stand alone, solid where the bucket holds something, and the shape stays a line. */
  dots?: boolean;
  seriesLabel?: (key: unknown) => string;
  /** The series column's vocabulary: its order, and each value's color, are the vocabulary's. */
  seriesVocabulary?: readonly string[];
}) {
  if (rows.some((row) => row.series !== undefined))
    return (
      <MultiLine
        rows={rows}
        say={say}
        wide={wide}
        high={high}
        target={target}
        smooth={smooth}
        seriesLabel={seriesLabel}
        vocabulary={seriesVocabulary}
      />
    );
  return <OneLine rows={rows} say={say} wide={wide} high={high} target={target} smooth={smooth} dots={dots} />;
}

function OneLine({
  rows,
  say,
  wide,
  high,
  target,
  smooth,
  dots,
}: {
  rows: ChartRow[];
  say: Say;
  wide: number;
  high?: number;
  target?: number;
  smooth: boolean;
  dots: boolean;
}) {
  const points = fillGaps(
    rows.map((r) => ({ key: r.key == null ? '—' : String(r.key), value: Number(r.value) })).filter((p) => Number.isFinite(p.value)),
  ) as Point[];
  const svg = useRef<SVGSVGElement>(null);
  const [near, setNear] = useState<number | null>(null);
  const [measured, setMeasured] = useState(0);
  /* Alone, a point has no line to join it to and no neighbour to space against: a dotted line draws even one. */
  const drawn = points.length >= 2 || (dots && points.length === 1);
  useLayoutEffect(() => {
    const element = svg.current?.parentElement;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const measure = () => setMeasured(Math.max(0, Math.round(viewportBox(element).width)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [drawn]);
  if (!drawn) return <p className="note">{sayCopy('notEnoughPointsToDraw')}</p>;

  /* The viewBox is the width the chart is drawn at, so text and strokes
     land at their own size. The height is the author's when given;
     otherwise, page-wide, a quarter of the width, capped: at a third a page-wide line stood in 220px of plot,
     most of it white over the line. */
  const W = measured > 0 ? measured : wide;
  /* Half a page wide (a pair, Dashboard.tsx) it keeps the third its neighbour has, so the two plots of a row
     stand the same height rather than one short over white. */
  const H = high
    ? Math.max(120, Math.round(high))
    : Math.max(120, W < 760 ? Math.min(Math.round(W / 3), 220) : Math.min(Math.round(W / 4), 180));
  /* A target is kept in view: a line far under its goal still shows the goal. */
  const goal = target !== undefined && Number.isFinite(target) ? target : undefined;
  const max = Math.max(...points.map((p) => p.value), 0, goal ?? 0);
  const min = Math.min(...points.map((p) => p.value), 0, goal ?? 0);
  const scale = niceScale(min, max, 2, say.tick?.steps);
  const levels = scale.levels;
  const span = scale.max - scale.min || 1;
  const gutter = Math.max(...levels.map((v) => tickWidth(tickSay(say)(v)))) + 6;
  const PAD = { top: 14, right: 14, bottom: 24, left: gutter };
  const x = (i: number) =>
    PAD.left + (points.length > 1 ? (i * (W - PAD.left - PAD.right)) / (points.length - 1) : (W - PAD.left - PAD.right) / 2);
  const y = (v: number) => PAD.top + (1 - (v - scale.min) / span) * (H - PAD.top - PAD.bottom);
  const line = linePath(
    points.map((p, i) => [x(i), y(p.value)] as const),
    smooth,
  );
  const area = `${line} L${f1(x(points.length - 1))},${f1(y(scale.min))} L${f1(x(0))},${f1(y(scale.min))} Z`;

  /* A point is named with its year wherever it stands alone — a dot's
     title, the crosshair, the table — and the axis drops the year a tick
     shares with the one before it. */
  const named = points.map((p) => periodTick(p.key));
  const marks = axisMarks(
    points.map((p) => p.key),
    x,
  );

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    // screen-px: clientX is a screen-pixel ruler too; the ratio maps it into viewBox units.
    const box = svg.current!.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    setNear(best);
  };
  const cx = near === null ? 0 : x(near);
  const cy = near === null ? 0 : y(points[near].value);
  const right = cx > W * 0.7;
  return (
    <>
      <svg
        ref={svg}
        className="chart-line"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${sayCopy('lineSummary', { count: points.length, from: say(points[0].value), to: say(points[points.length - 1].value), peak: say(Math.max(...points.map((p) => p.value))) })}${goal === undefined ? '' : sayCopy('targetAfter', { goal: say(goal) })}`}
        onPointerMove={onMove}
        onPointerLeave={() => setNear(null)}
      >
        {levels.map((v) => (
          <line key={`g${v}`} className="chart-grid" x1={PAD.left} x2={W - PAD.right} y1={f1(y(v))} y2={f1(y(v))} />
        ))}
        {levels.map((v) => (
          <text key={`t${v}`} className="chart-tick chart-y-tick" x={f1(PAD.left - 6)} y={f1(y(v) + 4)} textAnchor="end">
            {tickSay(say)(v)}
          </text>
        ))}
        {goal !== undefined && (
          <g className="chart-target">
            <line className="chart-target-line" x1={PAD.left} x2={W - PAD.right} y1={f1(y(goal))} y2={f1(y(goal))} />
            <text className="chart-target-label" x={PAD.left + 4} y={f1(y(goal) - 4)}>
              {sayCopy('target', { goal: say(goal) })}
            </text>
          </g>
        )}
        {!dots && <path className="chart-area" d={area} />}
        {!dots && <path className="chart-stroke" d={line} />}
        {points.map((p, i) => (
          <circle
            key={i}
            className={dots && p.value !== 0 ? 'chart-dot chart-dot-solid' : 'chart-dot'}
            cx={f1(x(i))}
            cy={f1(y(p.value))}
            r={dots ? 4 : 3}
          >
            <title>{`${named[i]}: ${say(p.value)}`}</title>
          </circle>
        ))}
        {marks.map(({ index, text }) => (
          <text
            key={`m${index}`}
            className="chart-tick chart-x-tick"
            x={f1(x(index))}
            y={H - 6}
            textAnchor={points.length > 1 && index === 0 ? 'start' : points.length > 1 && index === points.length - 1 ? 'end' : 'middle'}
          >
            {text}
          </text>
        ))}
        <g className="chart-cursor" {...(near === null ? { hidden: true } : {})}>
          <line className="chart-cursor-line" x1={f1(cx)} x2={f1(cx)} y1={PAD.top} y2={H - PAD.bottom} />
          <circle className="chart-cursor-dot" cx={f1(cx)} cy={f1(cy)} r={4} />
          <text
            className="chart-cursor-text"
            x={f1(right ? cx - 8 : cx + 8)}
            y={f1(Math.max(PAD.top + 10, cy - 10))}
            textAnchor={right ? 'end' : 'start'}
          >
            {near === null ? '' : `${named[near]} · ${say(points[near].value)}`}
          </text>
        </g>
      </svg>
      {/* The hider is a block round the table, not the table itself: a table is
        never shorter than its rows, so a hidden one of 700 days stood 16,000px
        tall and the pane scrolled into blank space under the dashboard. */}
      <div className="visually-hidden">
        <table className="chart-data">
          <tbody>
            {points.map((p, i) => (
              <tr key={i}>
                <th scope="row">{named[i]}</th>
                <td>{say(p.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* A line chart's series past this many are gathered into one "others" line: more lines than that tangle. */
const MAX_LINES = 5;
/* Up to this many lines are named at their ends; more names than that stack into a column of their own. */
const DIRECT_LINES = 3;
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

/**
 * Several lines over one time axis, a series each: the line of a two-key
 * breakdown ("month created_at, channel"). Each series keeps one theme token
 * on its line, its legend dot and the hover card; the legend's picker shows
 * every line or one alone. On hover a card lists every shown series at the
 * point, so two lines are compared without chasing two tooltips.
 */
function MultiLine({
  rows,
  say,
  wide,
  high,
  target,
  smooth,
  seriesLabel,
  vocabulary,
}: {
  rows: Array<ChartRow & { series?: unknown }>;
  say: Say;
  wide: number;
  high?: number;
  target?: number;
  smooth: boolean;
  seriesLabel: (key: unknown) => string;
  vocabulary?: readonly string[];
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [near, setNear] = useState<number | null>(null);
  const [measured, setMeasured] = useState(0);
  const [only, setOnly] = useState<string>('');
  const keys = [...new Set(rows.map((r) => (r.key == null ? '—' : String(r.key))))];
  if (keys.every((key) => PERIOD.test(key))) keys.sort();
  const totals = new Map<string, number>();
  const named = new Map<string, unknown>();
  for (const r of rows) {
    const id = r.series == null ? '—' : String(r.series);
    named.set(id, r.series);
    totals.set(id, (totals.get(id) ?? 0) + (Number(r.value) || 0));
  }
  const ranked = [...totals.keys()].sort((a, b) => totals.get(b)! - totals.get(a)!);
  const kept = ranked.length > MAX_LINES ? ranked.slice(0, MAX_LINES - 1) : ranked;
  /* A vocabulary's values go in its order and keep its colors, so a source is the same color here as in a donut of
     the same column; the largest still decide which lines are kept. */
  const place = (id: string) => vocabulary?.indexOf(id) ?? -1;
  if (vocabulary && kept.every((id) => place(id) >= 0)) kept.sort((a, b) => place(a) - place(b));
  const OTHERS = '\u0000others';
  const series = [...kept, ...(ranked.length > kept.length ? [OTHERS] : [])].map((id, i) => {
    const slot = place(id) >= 0 && place(id) < 8 ? place(id) : i;
    const values = keys.map(() => 0);
    for (const r of rows) {
      const own = r.series == null ? '—' : String(r.series);
      const lane = kept.includes(own) ? own : OTHERS;
      if (lane !== id) continue;
      const v = Number(r.value);
      if (Number.isFinite(v)) values[keys.indexOf(r.key == null ? '—' : String(r.key))] += v;
    }
    return {
      id,
      label: id === OTHERS ? sayCopy('others', { restCount: ranked.length - kept.length }) : seriesLabel(named.get(id)),
      color: `var(--chart-${slot + 1}, var(--accent))`,
      values,
    };
  });
  const shown = only && series.some((line) => line.id === only) ? series.filter((line) => line.id === only) : series;
  const drawn = keys.length >= 2;
  useLayoutEffect(() => {
    const element = svg.current?.parentElement;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const measure = () => setMeasured(Math.max(0, Math.round(viewportBox(element).width)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [drawn]);
  if (!drawn) return <p className="note">{sayCopy('notEnoughPointsToDraw')}</p>;
  const W = measured > 0 ? measured : wide;
  const H = high ? Math.max(120, Math.round(high)) : Math.max(120, Math.min(Math.round(W / 3), 220));
  const goal = target !== undefined && Number.isFinite(target) ? target : undefined;
  const all = shown.flatMap((line) => line.values);
  const max = Math.max(...all, 0, goal ?? 0);
  const min = Math.min(...all, 0, goal ?? 0);
  const scale = niceScale(min, max, 2, say.tick?.steps);
  const levels = scale.levels;
  const span = scale.max - scale.min || 1;
  const gutter = Math.max(...levels.map((v) => tickWidth(tickSay(say)(v)))) + 6;
  /* A few lines are named where they end, not in a key above them: the eye follows a line to its name instead of
     matching a color back to a list. Past three, or where the names would take more than a quarter of the width, the
     legend says them. */
  const nameRoom = Math.max(...shown.map((line) => tickWidth(line.label))) + 8;
  const direct = shown.length <= DIRECT_LINES && nameRoom <= W / 4;
  const PAD = { top: 14, right: direct ? nameRoom : 14, bottom: 24, left: gutter };
  const x = (i: number) => PAD.left + (i * (W - PAD.left - PAD.right)) / (keys.length - 1);
  const y = (v: number) => PAD.top + (1 - (v - scale.min) / span) * (H - PAD.top - PAD.bottom);
  const ends = direct
    ? namesAtEnds(
        shown.map((line) => y(line.values[line.values.length - 1])),
        PAD.top,
        H - PAD.bottom,
      )
    : [];
  const ticks = keys.map((key) => periodTick(key));
  const marks = axisMarks(keys, x);
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    // screen-px: clientX is a screen-pixel ruler too; the ratio maps it into viewBox units.
    const box = svg.current!.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    for (let i = 1; i < keys.length; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    setNear(best);
  };
  const cx = near === null ? 0 : x(near);
  const right = cx > W * 0.6;
  return (
    <div className="chart-multi">
      <div className="chart-multi-head">
        <ul className="chart-legend chart-multi-legend" {...(direct ? { hidden: true } : {})}>
          {shown.map((line) => (
            <li key={line.id}>
              <span className="chart-dot-key" style={{ background: line.color }} />
              <span className="chart-legend-key">{line.label}</span>
            </li>
          ))}
        </ul>
        <select
          className="chart-series-pick"
          aria-label={sayCopy('showSeries')}
          value={only}
          onChange={(event) => setOnly(event.target.value)}
        >
          <option value="">{sayCopy('allSeries')}</option>
          {series.map((line) => (
            <option key={line.id} value={line.id}>
              {line.label}
            </option>
          ))}
        </select>
      </div>
      <div className="chart-multi-plot">
        <svg
          ref={svg}
          className="chart-line"
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={sayCopy('linesSummary', {
            count: shown.length,
            points: keys.length,
            names: shown.map((line) => line.label).join(', '),
          })}
          onPointerMove={onMove}
          onPointerLeave={() => setNear(null)}
        >
          {levels.map((v) => (
            <line key={`g${v}`} className="chart-grid" x1={PAD.left} x2={W - PAD.right} y1={f1(y(v))} y2={f1(y(v))} />
          ))}
          {levels.map((v) => (
            <text key={`t${v}`} className="chart-tick chart-y-tick" x={f1(PAD.left - 6)} y={f1(y(v) + 4)} textAnchor="end">
              {tickSay(say)(v)}
            </text>
          ))}
          {goal !== undefined && (
            <g className="chart-target">
              <line className="chart-target-line" x1={PAD.left} x2={W - PAD.right} y1={f1(y(goal))} y2={f1(y(goal))} />
              <text className="chart-target-label" x={PAD.left + 4} y={f1(y(goal) - 4)}>
                {sayCopy('target', { goal: say(goal) })}
              </text>
            </g>
          )}
          {shown.map((line) => (
            <path
              key={line.id}
              className="chart-stroke chart-series-stroke"
              style={{ stroke: line.color }}
              d={linePath(
                line.values.map((v, i) => [x(i), y(v)] as const),
                smooth,
              )}
            />
          ))}
          {direct &&
            shown.map((line, i) => {
              const last = line.values.length - 1;
              return (
                <g key={`n${line.id}`} className="chart-end">
                  <circle className="chart-end-dot" style={{ fill: line.color }} cx={f1(x(last))} cy={f1(y(line.values[last]))} r={3} />
                  <text className="chart-end-name" x={f1(W - PAD.right + 8)} y={f1(ends[i] + 4)}>
                    {line.label}
                  </text>
                </g>
              );
            })}
          {marks.map(({ index, text }) => (
            <text
              key={`m${index}`}
              className="chart-tick chart-x-tick"
              x={f1(x(index))}
              y={H - 6}
              textAnchor={index === 0 ? 'start' : index === keys.length - 1 ? 'end' : 'middle'}
            >
              {text}
            </text>
          ))}
          <g className="chart-cursor" {...(near === null ? { hidden: true } : {})}>
            <line className="chart-cursor-line" x1={f1(cx)} x2={f1(cx)} y1={PAD.top} y2={H - PAD.bottom} />
            {near !== null &&
              shown.map((line) => (
                <circle
                  key={line.id}
                  className="chart-cursor-dot"
                  style={{ fill: line.color }}
                  cx={f1(cx)}
                  cy={f1(y(line.values[near]))}
                  r={4}
                />
              ))}
          </g>
        </svg>
        {near !== null && (
          /* The card stands beside the cursor, on the side with room, at a fixed top: it never moves the page. */
          <div
            className="chart-tip-card"
            aria-hidden="true"
            style={right ? { right: `${((W - cx) / W) * 100}%`, marginRight: 10 } : { left: `${(cx / W) * 100}%`, marginLeft: 10 }}
          >
            <div className="chart-tip-title">{ticks[near]}</div>
            {shown.map((line) => (
              <div key={line.id} className="chart-tip-row">
                <span className="chart-dot-key" style={{ background: line.color }} />
                <span className="chart-tip-name">{line.label}</span>
                <span className="chart-tip-value">{say(line.values[near])}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="visually-hidden">
        <table className="chart-data">
          <thead>
            <tr>
              <td />
              {shown.map((line) => (
                <th key={line.id} scope="col">
                  {line.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {keys.map((key, i) => (
              <tr key={key}>
                <th scope="row">{ticks[i]}</th>
                {shown.map((line) => (
                  <td key={line.id}>{say(line.values[i])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Whether a key is a period the grammar buckets by ("2026-08", "2026-Q3"). */
const PERIOD = /^\d{4}(-\d{2}(-\d{2})?|-Q[1-4])?$/;

/**
 * Bars: one series, a bar per group — how much each week or each stage
 * holds, where a line says how a number moved. Over calendar buckets one bar
 * is the current one, drawn in the ink while the rest stay quiet: the last
 * (the period in hand) until the pointer names another. Its value is said in
 * a pill over it, and a guide runs from it across the levels, so the reader
 * can read it off the scale without a tooltip's delay; there the pill is
 * information, not a hover effect, so it is always there. Over categories (a
 * stage, a source) no bar is the one in hand — the last is only last in the
 * vocabulary — so at rest none is inked, with no pill and no guide, until the
 * pointer names one. Nothing moves (motion rule 8).
 *
 * Periods keep their order and gain their missing buckets at zero, as a
 * line's do; categories go in their vocabulary's order, else biggest first.
 * The levels are on the left, in a gutter of their own, and every bar is a
 * row of a table assistive technology reads, as a line's points are.
 */
export function BarChart({
  rows,
  say = String,
  label = String,
  wide = 600,
  high,
  target,
  tone,
}: {
  rows: ChartRow[];
  say?: Say;
  label?: (key: unknown) => string;
  wide?: number;
  high?: number;
  target?: number;
  /** A category's display tone (a state's, a status's), where its column has them: each bar wears the ink its dot and badge wear. */
  tone?: (key: unknown) => string | undefined;
}) {
  const periods = rows.length > 0 && rows.every((r) => r.key != null && PERIOD.test(String(r.key)));
  const bars = periods
    ? (fillGaps(rows.map((r) => ({ key: String(r.key), value: Number(r.value) })).filter((p) => Number.isFinite(p.value))) as Point[]).map(
        (p) => ({ raw: p.key as unknown, value: p.value }),
      )
    : rows.map((r) => ({ raw: r.key, value: Number(r.value) })).filter((p) => Number.isFinite(p.value));
  const svg = useRef<SVGSVGElement>(null);
  const [near, setNear] = useState<number | null>(null);
  const [measured, setMeasured] = useState(0);
  useLayoutEffect(() => {
    const element = svg.current?.parentElement;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const measure = () => setMeasured(Math.max(0, Math.round(viewportBox(element).width)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [bars.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!bars.length) return <p className="note">{sayCopy('nothingToDraw')}</p>;

  /* States are bars of the meaning they carry: where every category has a tone, each wears it (the same ink the status
     dot and badge draw), shared or not, since the axis names every bar. Periods and untoned columns keep the look's hue. */
  const inks = periods || !tone ? undefined : bars.map((b) => TONE_INK[tone(b.raw) ?? '']);
  const toned = !!inks && inks.every(Boolean);
  const named = bars.map((b, i) => (periods ? periodTick(String(b.raw), i ? String(bars[i - 1].raw) : undefined) : label(b.raw)));
  const whole = bars.map((b) => (periods ? periodTick(String(b.raw)) : label(b.raw)));
  const W = measured > 0 ? measured : wide;
  const H = high ? Math.max(120, Math.round(high)) : Math.max(160, Math.min(Math.round(W / 3), 240));
  const goal = target !== undefined && Number.isFinite(target) ? target : undefined;
  const max = Math.max(...bars.map((b) => b.value), 0, goal ?? 0);
  const min = Math.min(...bars.map((b) => b.value), 0);
  const scale = niceScale(min, max, 2, say.tick?.steps);
  const levels = scale.levels;
  const span = scale.max - scale.min || 1;
  const gutter = Math.max(...levels.map((v) => tickWidth(tickSay(say)(v)))) + 6;
  /* Room over the tallest bar for the pill that names it. */
  const PAD = { top: 30, right: 6, bottom: 24, left: gutter };
  const band = (W - PAD.left - PAD.right) / bars.length;
  const barWide = Math.max(2, Math.min(56, band * 0.64));
  const x = (i: number) => PAD.left + band * i + (band - barWide) / 2;
  const mid = (i: number) => PAD.left + band * (i + 0.5);
  const y = (v: number) => PAD.top + (1 - (v - scale.min) / span) * (H - PAD.top - PAD.bottom);
  const base = y(Math.max(scale.min, 0));
  const marks = axisMarks(
    named.map((text, i) => (periods ? String(bars[i].raw) : text)),
    mid,
    { centered: true },
  );
  /* A mark is centred under its bar, and kept inside the figure at either end. */
  const markAt = (index: number, text: string) => Math.min(Math.max(mid(index), tickWidth(text) / 2), W - tickWidth(text) / 2);
  const active: number | null = near ?? (periods ? bars.length - 1 : null);
  const tip = active === null ? '' : `${whole[active]} · ${say(bars[active].value)}`;
  const tipWide = tickWidth(tip) + 12;
  const tipLeft = active === null ? 0 : Math.min(Math.max(mid(active) - tipWide / 2, PAD.left), W - PAD.right - tipWide);
  const top = active === null ? 0 : y(Math.max(bars[active].value, 0));
  const tipTop = Math.max(2, top - 26);
  const at = (e: React.PointerEvent<SVGSVGElement>) => {
    // screen-px: clientX is a screen-pixel ruler too; the ratio maps it into viewBox units.
    const box = svg.current!.getBoundingClientRect();
    if (!box.width) return bars.length - 1;
    const px = ((e.clientX - box.left) / box.width) * W;
    return Math.min(bars.length - 1, Math.max(0, Math.floor((px - PAD.left) / band)));
  };
  return (
    <>
      <svg
        ref={svg}
        className="chart-bars"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${sayCopy('barsSummary', { count: bars.length, highest: say(Math.max(...bars.map((b) => b.value))), last: whole[bars.length - 1], value: say(bars[bars.length - 1].value) })}${goal === undefined ? '' : sayCopy('targetAfter', { goal: say(goal) })}`}
        onPointerMove={(e) => setNear(at(e))}
        onPointerLeave={() => setNear(null)}
      >
        {levels.map((v) => (
          <line key={`g${v}`} className="chart-grid" x1={PAD.left} x2={W - PAD.right} y1={f1(y(v))} y2={f1(y(v))} />
        ))}
        {levels.map((v) => (
          <text key={`t${v}`} className="chart-tick chart-y-tick" x={f1(PAD.left - 6)} y={f1(y(v) + 4)} textAnchor="end">
            {tickSay(say)(v)}
          </text>
        ))}
        {active !== null && <line className="chart-bar-guide" x1={PAD.left} x2={W - PAD.right} y1={f1(top)} y2={f1(top)} />}
        {bars.map((b, i) => {
          const h = Math.abs(y(b.value) - base);
          return (
            <rect
              key={i}
              className={`chart-bar${toned ? ' is-toned' : ''}${i === active ? ' is-active' : ''}`}
              style={toned ? { ['--bar-ink' as string]: inks![i] } : undefined}
              x={f1(x(i))}
              y={f1(Math.min(y(b.value), base))}
              width={f1(barWide)}
              height={f1(Math.max(h, b.value ? 1 : 0))}
            >
              <title>{`${whole[i]}: ${say(b.value)}`}</title>
            </rect>
          );
        })}
        {goal !== undefined && (
          <g className="chart-target">
            <line className="chart-target-line" x1={PAD.left} x2={W - PAD.right} y1={f1(y(goal))} y2={f1(y(goal))} />
            <text className="chart-target-label" x={PAD.left + 4} y={f1(y(goal) - 4)}>
              {sayCopy('target', { goal: say(goal) })}
            </text>
          </g>
        )}
        {marks.map(({ index, text }) => (
          <text
            key={`m${index}`}
            className={`chart-tick chart-x-tick${index === active ? ' is-active' : ''}`}
            x={f1(markAt(index, periods ? text : named[index]))}
            y={H - 6}
            textAnchor="middle"
          >
            {periods ? text : named[index]}
          </text>
        ))}
        {active !== null && (
          <g className="chart-bar-tip" aria-hidden="true">
            <rect x={f1(tipLeft)} y={f1(tipTop)} width={f1(tipWide)} height={20} />
            <text x={f1(tipLeft + tipWide / 2)} y={f1(tipTop + 14)} textAnchor="middle">
              {tip}
            </text>
          </g>
        )}
      </svg>
      {/* The hider is a block round the table, not the table itself: a table is
        never shorter than its rows, so a hidden one of 700 days stood 16,000px
        tall and the pane scrolled into blank space under the dashboard. */}
      <div className="visually-hidden">
        <table className="chart-data">
          <tbody>
            {bars.map((b, i) => (
              <tr key={i}>
                <th scope="row">{whole[i]}</th>
                <td>{say(b.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * Stacked columns: a column per period, divided by series — how much each day
 * held and what it was made of. The bars' grammar (Bars, above): levels on the
 * left in their own gutter, periods along the bottom with their empty buckets
 * at zero, and one current column whose total and parts are said in a pill
 * over it, with a guide across the levels; the last until the pointer names
 * another. While the pointer is over the chart the pill rides with it, just
 * above it, so it never sits over the column being read. Each series keeps one theme token in every column and in the
 * legend, which says each series' total. Every column is also a row of a
 * table assistive technology reads. Nothing moves (motion rule 8).
 */
export function StackedColumns({
  rows,
  series,
  say = String,
  wide = 600,
  high,
}: {
  rows: Array<{ key: string; values: Record<string, number> }>;
  series: Array<{ key: string; label: string }>;
  say?: Say;
  wide?: number;
  high?: number;
}) {
  const columns = rows
    .map((r) => ({ key: r.key, parts: series.map((s) => Math.max(0, Number(r.values[s.key]) || 0)) }))
    .map((c) => ({ ...c, total: c.parts.reduce((n, v) => n + v, 0) }));
  const svg = useRef<SVGSVGElement>(null);
  const [near, setNear] = useState<number | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [measured, setMeasured] = useState(0);
  useLayoutEffect(() => {
    const element = svg.current?.parentElement;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const measure = () => setMeasured(Math.max(0, Math.round(viewportBox(element).width)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [columns.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!columns.length) return <p className="note">{sayCopy('nothingToDraw')}</p>;
  const periods = columns.every((c) => PERIOD.test(c.key));
  const named = columns.map((c) => (periods ? periodTick(c.key) : c.key));
  const W = measured > 0 ? measured : wide;
  const H = high ? Math.max(120, Math.round(high)) : Math.max(160, Math.min(Math.round(W / 3.5), 220));
  const max = Math.max(...columns.map((c) => c.total), 1);
  const scale = niceScale(0, max, 2, say.tick?.steps);
  const levels = scale.levels;
  const gutter = Math.max(...levels.map((v) => tickWidth(tickSay(say)(v)))) + 6;
  const PAD = { top: 30, right: 6, bottom: 24, left: gutter };
  const band = (W - PAD.left - PAD.right) / columns.length;
  const colWide = Math.max(2, Math.min(40, band * 0.64));
  const x = (i: number) => PAD.left + band * i + (band - colWide) / 2;
  const mid = (i: number) => PAD.left + band * (i + 0.5);
  const y = (v: number) => PAD.top + (1 - v / scale.max) * (H - PAD.top - PAD.bottom);
  const marks = periods
    ? axisMarks(
        columns.map((c) => c.key),
        mid,
        { centered: true },
      )
    : columns.map((c, index) => ({ index, text: c.key }));
  const markAt = (index: number, text: string) => Math.min(Math.max(mid(index), tickWidth(text) / 2), W - tickWidth(text) / 2);
  const active = near ?? columns.length - 1;
  const parts = (i: number) => series.map((s, k) => `${s.label} ${say(columns[i].parts[k])}`).join(' · ');
  const tip = `${named[active]} · ${parts(active)}`;
  const tipWide = tickWidth(tip) + 12;
  const tipLeft = Math.min(Math.max((pointer?.x ?? mid(active)) - tipWide / 2, PAD.left), W - PAD.right - tipWide);
  const top = y(columns[active].total);
  const tipTop = pointer ? Math.min(Math.max(2, pointer.y - 30), H - PAD.bottom - 22) : Math.max(2, top - 26);
  const color = (k: number) => `var(--chart-${k + 1}, var(--accent))`;
  const at = (e: React.PointerEvent<SVGSVGElement>) => {
    // screen-px: clientX is a screen-pixel ruler too; the ratio maps it into viewBox units.
    const box = svg.current!.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const px = ((e.clientX - box.left) / box.width) * W;
    setPointer({ x: px, y: ((e.clientY - box.top) / box.height) * H });
    setNear(Math.min(columns.length - 1, Math.max(0, Math.floor((px - PAD.left) / band))));
  };
  const totals = series.map((_, k) => columns.reduce((n, c) => n + c.parts[k], 0));
  return (
    <div className="chart-columns">
      <svg
        ref={svg}
        className="chart-bars"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={sayCopy('barsSummary', {
          count: columns.length,
          highest: say(max),
          last: named[columns.length - 1],
          value: say(columns[columns.length - 1].total),
        })}
        onPointerMove={at}
        onPointerLeave={() => {
          setNear(null);
          setPointer(null);
        }}
      >
        {levels.map((v) => (
          <line key={`g${v}`} className="chart-grid" x1={PAD.left} x2={W - PAD.right} y1={f1(y(v))} y2={f1(y(v))} />
        ))}
        {levels.map((v) => (
          <text key={`t${v}`} className="chart-tick chart-y-tick" x={f1(PAD.left - 6)} y={f1(y(v) + 4)} textAnchor="end">
            {tickSay(say)(v)}
          </text>
        ))}
        <line className="chart-bar-guide" x1={PAD.left} x2={W - PAD.right} y1={f1(top)} y2={f1(top)} />
        {columns.map((c, i) => {
          let base = 0;
          return (
            <g key={c.key} className={`chart-column${i === active ? ' is-active' : ''}`}>
              <title>{`${named[i]}: ${parts(i)}`}</title>
              {c.parts.map((v, k) => {
                const from = base;
                base += v;
                if (!v) return null;
                return (
                  <rect
                    key={k}
                    className="chart-column-part"
                    x={f1(x(i))}
                    y={f1(y(base))}
                    width={f1(colWide)}
                    height={f1(Math.max(1, y(from) - y(base)))}
                    style={{ fill: color(k) }}
                  />
                );
              })}
            </g>
          );
        })}
        {marks.map(({ index, text }) => (
          <text
            key={`m${index}`}
            className={`chart-tick chart-x-tick${index === active ? ' is-active' : ''}`}
            x={f1(markAt(index, text))}
            y={H - 6}
            textAnchor="middle"
          >
            {text}
          </text>
        ))}
        <g className="chart-bar-tip" aria-hidden="true">
          <rect x={f1(tipLeft)} y={f1(tipTop)} width={f1(tipWide)} height={20} />
          <text x={f1(tipLeft + tipWide / 2)} y={f1(tipTop + 14)} textAnchor="middle">
            {tip}
          </text>
        </g>
      </svg>
      <ul className="chart-legend chart-columns-legend">
        {series.map((s, k) => (
          <li key={s.key}>
            <span className="chart-swatch" style={{ background: color(k) }} />
            <span className="chart-legend-key">{s.label}</span>
            <span className="chart-legend-value">{say(totals[k])}</span>
          </li>
        ))}
      </ul>
      <div className="visually-hidden">
        <table className="chart-data">
          <tbody>
            {columns.map((c, i) => (
              <tr key={c.key}>
                <th scope="row">{named[i]}</th>
                <td>{parts(i)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * A donut with its legend: how the whole divides, said twice — arc length
 * and a labelled figure. Past six slices the tail is gathered into "others".
 */
export function DonutChart({
  rows,
  say = String,
  label = String,
  onPick,
  total,
  ordered,
  tone,
}: {
  rows: ChartRow[];
  say?: Say;
  label?: (key: unknown) => string;
  /** A slice's display tone, where its column has them: slices wear the ink their dot and badge wear when every one has its own. */
  tone?: (key: unknown) => string | undefined;
  onPick?: ((value: unknown) => void) | null;
  /** What the figure in the middle is: "Total visitors", said under it. */
  total?: string;
  /** The slices are steps of a scale, in its order: drawn in steps of one hue (rampInk), not in categorical ones. */
  ordered?: boolean;
}) {
  const all = rows
    .map((r) => ({ key: r.key == null ? '—' : label(r.key), raw: r.key, value: Number(r.value) }))
    .filter((p) => Number.isFinite(p.value) && p.value > 0);
  if (!all.length) return <p className="note">{sayCopy('nothingToDivide')}</p>;
  const MAX_SLICES = 6;
  const slices: Array<{ key: string; raw?: unknown; value: number }> = all.slice(0, MAX_SLICES);
  const rest = all.slice(MAX_SLICES);
  if (rest.length) slices.push({ key: `others (${rest.length})`, value: rest.reduce((n, p) => n + p.value, 0) });
  const whole = slices.reduce((n, p) => n + p.value, 0);
  const R = 15.9155; /* circumference 100, so dasharray speaks percent. */
  const C = 21;
  /* A step of the ramp rides in a property of its own, which the slice and its swatch both paint with. */
  /* A legend that names two slices in one ink says nothing, so slices wear their tones only where each is distinct. */
  const inks = ordered || rest.length || !tone ? undefined : slices.map((p) => TONE_INK[tone(p.raw) ?? '']);
  const toned = !!inks && inks.every(Boolean) && new Set(inks).size === inks.length;
  const color = (i: number) => (ordered ? 'var(--ramp)' : toned ? inks![i]! : `var(--chart-${i + 1}, var(--accent))`);
  const ramp = (i: number) => (ordered ? { ['--ramp' as string]: rampInk(i, slices.length) } : {});
  const opacity = (i: number) =>
    ordered || toned ? '1' : `var(--chart-series-opacity, ${(1 - i * (0.75 / Math.max(slices.length - 1, 1))).toFixed(2)})`;
  let at = 25; /* Start at 12 o'clock: dasharray's zero is 3 o'clock. */
  /* A hairline of the ground between slices, so neighbours of one hue read as two; a slice too thin to spare it keeps
     its whole arc. One slice is a ring, with nothing to part. */
  const GAP = slices.length > 1 ? 0.8 : 0;
  const rings = slices.map((p, i) => {
    const share = (100 * p.value) / whole;
    const drawn = share > GAP * 2 ? share - GAP : share;
    /* A slice is a door where the legend's button is: the same raw value,
       the same "others" exclusion. A circle is not a button by itself, so
       a drillable slice carries the button's role, name and keyboard
       behaviour, and the legend button stays as the second way in. */
    const drillable = onPick && p.raw != null && !(rest.length && i === slices.length - 1);
    const ring = (
      <circle
        key={i}
        className={`chart-slice${drillable ? ' chart-slice-drill' : ''}`}
        cx={C}
        cy={C}
        r={R}
        strokeDasharray={`${drawn.toFixed(2)} ${(100 - drawn).toFixed(2)}`}
        strokeDashoffset={at.toFixed(2)}
        style={{ ...ramp(i), stroke: color(i), opacity: opacity(i) }}
        {...(drillable
          ? {
              role: 'button',
              tabIndex: 0,
              'aria-label': `${p.key}: ${say(p.value)} (${formatPercent(share, { maximumFractionDigits: 0 })})`,
              onClick: () => onPick!(p.raw),
              onKeyDown: (event: React.KeyboardEvent) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onPick!(p.raw);
                }
              },
            }
          : {})}
      >
        <title>{`${p.key}: ${say(p.value)} (${formatPercent(share, { maximumFractionDigits: 0 })})`}</title>
      </circle>
    );
    at -= share;
    return ring;
  });
  return (
    <div className={`chart-donut-wrap${ordered ? ' is-ordered' : ''}`}>
      <svg
        className="chart-donut"
        viewBox={`0 0 ${C * 2} ${C * 2}`}
        role="img"
        aria-label={sayCopy('inAll', { whole: say(whole), map: slices.map((p) => `${p.key} ${say(p.value)}`).join(', ') })}
      >
        {rings}
        <text className="chart-donut-total" x={C} y={total ? C : C + 1.5} textAnchor="middle">
          {say(whole)}
        </text>
        {total && (
          <text className="chart-donut-caption" x={C} y={C + 4.5} textAnchor="middle">
            {total}
          </text>
        )}
      </svg>
      <ul className="chart-legend">
        {slices.map((p, i) => {
          const parts = (
            <>
              <span className="chart-swatch" style={{ ...ramp(i), background: color(i), opacity: opacity(i) }} />
              <span className="chart-legend-key">{p.key}</span>
              <span className="chart-legend-value">{say(p.value)}</span>
              <span className="chart-legend-share">{formatPercent((100 * p.value) / whole, { maximumFractionDigits: 0 })}</span>
            </>
          );
          const drillable = onPick && p.raw != null && !(rest.length && i === slices.length - 1);
          return (
            <li key={i}>
              {drillable ? (
                <button type="button" className="chart-legend-drill" onClick={() => onPick!(p.raw)}>
                  {parts}
                </button>
              ) : (
                parts
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A display tone as the ink it is drawn in (the status tokens, so a look's and a dark mode's own are worn). */
export const TONE_INK: Record<string, string> = {
  good: 'var(--status-good)',
  warn: 'var(--status-warning)',
  bad: 'var(--status-critical)',
  info: 'var(--status-info)',
  neutral: 'var(--ink-subtle)',
};

interface StackedRow {
  key: unknown;
  series: unknown;
  value: unknown;
}

/**
 * Stacked bars: each group of the first key a bar, divided by the second —
 * how each of several wholes divides, where a donut says how one does. The
 * bars share one scale (the longest total, or the target when it is past
 * it), each series keeps one theme token in every bar and in the legend,
 * and past seven series the tail is gathered into "others", the eighth
 * token. A target is a rule across every track and a word in the legend.
 */
export function StackedBars({
  rows,
  say = String,
  label = String,
  seriesLabel = String,
  target,
  limit = 10,
  onPick,
  seriesVocabulary,
  seriesOrdered,
  seriesTone,
  sayLegend,
}: {
  rows: StackedRow[];
  say?: Say;
  label?: (key: unknown) => string;
  seriesLabel?: (key: unknown) => string;
  target?: number;
  limit?: number;
  onPick?: ((value: unknown) => void) | null;
  /** The second key's declared values: the series stand in their order, as a donut's slices of the same column do. */
  seriesVocabulary?: readonly string[];
  /** The second key is a scale: its series stand in its order and in steps of one hue (rampInk). */
  seriesOrdered?: boolean;
  /** A series' tone from its column's display map. Where every series has one, and no two share it, the bars wear the
      tones (Paid good, Open warning) rather than the palette, whose order says nothing about what a value means. */
  seriesTone?: (key: string) => string | undefined;
  /** The legend's figures by one rule, given every total (compact for all or whole for all). */
  sayLegend?: (totals: readonly number[]) => Say;
}) {
  const MAX_SERIES = 7;
  const name = (v: unknown) => (v == null ? '—' : String(v));
  const bars = new Map<string, { raw: unknown; total: number; parts: Map<string, number> }>();
  const seriesTotals = new Map<string, { raw: unknown; total: number }>();
  for (const row of rows) {
    const value = Number(row.value);
    if (!Number.isFinite(value) || value <= 0) continue;
    const bar = bars.get(name(row.key)) ?? { raw: row.key, total: 0, parts: new Map() };
    bar.total += value;
    bar.parts.set(name(row.series), (bar.parts.get(name(row.series)) ?? 0) + value);
    bars.set(name(row.key), bar);
    const series = seriesTotals.get(name(row.series)) ?? { raw: row.series, total: 0 };
    series.total += value;
    seriesTotals.set(name(row.series), series);
  }
  if (!bars.size) return <p className="note">{sayCopy('nothingToStack')}</p>;
  const ranked = [...seriesTotals.entries()].sort((a, b) => b[1].total - a[1].total);
  /* The largest series are kept; where the second key declares an order, they stand in it — Urgent to Planning, a
     week to a month — rather than by their totals. */
  const rank = new Map((seriesVocabulary ?? []).map((word, at) => [word, at]));
  const place = (key: string) => rank.get(key) ?? Number.POSITIVE_INFINITY;
  const step = (a: string, b: string) => {
    const x = Number(a),
      y = Number(b);
    return Number.isFinite(x) && Number.isFinite(y) ? x - y : a < b ? -1 : a > b ? 1 : 0;
  };
  const declared = rank.size > 0 || seriesOrdered;
  const kept = ranked
    .slice(0, MAX_SERIES)
    .sort(([a, x], [b, y]) => (declared ? place(a) - place(b) || (seriesOrdered ? step(a, b) : 0) : 0) || y.total - x.total)
    .map(([key, s]) => ({ key, label: seriesLabel(s.raw), total: s.total }));
  const rest = ranked.slice(MAX_SERIES);
  const series = rest.length
    ? [...kept, { key: ' others', label: sayCopy('others', { restCount: rest.length }), total: rest.reduce((n, [, s]) => n + s.total, 0) }]
    : kept;
  const slot = (key: string) => {
    const at = kept.findIndex((s) => s.key === key);
    return at === -1 ? series.length - 1 : at;
  };
  /* Colour that means something where the column says what each value is; the palette's series colours, which are
     only distinct, stay for categories with no such tone. */
  const tones = seriesOrdered || rest.length ? undefined : series.map((s) => TONE_INK[seriesTone?.(s.key) ?? '']);
  const toned = !!tones && tones.every(Boolean) && new Set(tones).size === tones.length;
  const color = (i: number) => (seriesOrdered ? 'var(--ramp)' : toned ? tones![i]! : `var(--chart-${i + 1}, var(--accent))`);
  const ramp = (i: number) => (seriesOrdered ? { ['--ramp' as string]: rampInk(i, series.length) } : {});
  const opacity = (i: number) =>
    seriesOrdered || toned ? '1' : `var(--chart-series-opacity, ${(1 - i * (0.75 / Math.max(series.length - 1, 1))).toFixed(2)})`;
  /* Bars over periods stand in time order, the latest `limit` of them, as a
     bar chart's do; ranking them by total put Sep 10 over Aug 27 over Sep 14. */
  const timed = isPeriodRun([...bars.values()].map((bar) => bar.raw));
  const shown = timed
    ? [...bars.values()].sort((a, b) => (String(a.raw) < String(b.raw) ? -1 : 1)).slice(-limit)
    : [...bars.values()].sort((a, b) => b.total - a.total).slice(0, limit);
  const barLabel = (bar: { raw: unknown }, i: number) =>
    timed ? periodTick(String(bar.raw), i ? String(shown[i - 1].raw) : undefined) : label(bar.raw);
  const goal = target !== undefined && Number.isFinite(target) && target > 0 ? target : undefined;
  const scale = Math.max(...shown.map((bar) => bar.total), goal ?? 0);
  const share = (v: number) => `${((100 * v) / scale).toFixed(2)}%`;
  const sayTotal = sayLegend ? sayLegend(series.map((s) => s.total)) : say;
  return (
    <div className="chart-stacked">
      <ul className="chart-legend chart-stacked-legend">
        {series.map((s, i) => (
          <li key={s.key}>
            <span className="chart-swatch" style={{ ...ramp(i), background: color(i), opacity: opacity(i) }} />
            <span className="chart-legend-key">{s.label}</span>
            <span className="chart-legend-value">{sayTotal(s.total)}</span>
          </li>
        ))}
        {goal !== undefined && (
          <li className="chart-stacked-goal">
            <span className="chart-target-swatch" aria-hidden="true" />
            <span className="chart-legend-key">{sayCopy('targetLabel')}</span>
            <span className="chart-legend-value">{say(goal)}</span>
          </li>
        )}
      </ul>
      <ul
        className="chart-stacked-rows"
        aria-label={`${sayCopy('barsBySeries', { count: shown.length, series: series.map((s) => s.label).join(', ') })}${goal === undefined ? '' : sayCopy('targetAfter', { goal: say(goal) })}`}
      >
        {shown.map((bar, at) => {
          /* Each series in legend order, so a colour sits in the same place in every bar. */
          const parts = series
            .map((s, i) => ({
              s,
              i,
              value:
                s.key === ' others'
                  ? [...bar.parts.entries()]
                      .filter(([key]) => slot(key) === series.length - 1 && !kept.some((k) => k.key === key))
                      .reduce((n, [, v]) => n + v, 0)
                  : (bar.parts.get(s.key) ?? 0),
            }))
            .filter((part) => part.value > 0);
          const words = (
            <>
              <span className="chart-stacked-label">{barLabel(bar, at)}</span>
              <span className="chart-stacked-track">
                <span className="chart-stacked-fill" style={{ width: share(bar.total) }}>
                  {parts.map(({ s, i, value }) => (
                    <span
                      key={s.key}
                      className="chart-stacked-part"
                      title={`${s.label}: ${say(value)}`}
                      style={{ ...ramp(i), flexGrow: value, background: color(i), opacity: opacity(i) }}
                    />
                  ))}
                </span>
                {goal !== undefined && <span className="chart-stacked-target" style={{ left: share(goal) }} aria-hidden="true" />}
              </span>
              <span className="chart-stacked-total">{say(bar.total)}</span>
              <span className="visually-hidden">{`: ${parts.map(({ s, value }) => `${s.label} ${say(value)}`).join(', ')}`}</span>
            </>
          );
          /* A bar that goes somewhere is a button; a null group, or no drill, stays text. */
          return (
            <li key={name(bar.raw)}>
              {onPick && bar.raw != null ? (
                <button type="button" className="chart-stacked-row chart-stacked-drill" onClick={() => onPick(bar.raw)}>
                  {words}
                </button>
              ) : (
                <div className="chart-stacked-row">{words}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * A spark: the measure's shape inside a KPI card. No axes; the card's own
 * number is the label. It spans the card's width, stretched rather than
 * scaled, so a wide card draws a long trend instead of a 110px stub in its
 * corner; the stroke and the last point's dot keep their own size however
 * far it stretches (`non-scaling-stroke`, and the dot is a round cap on a
 * zero-length stroke). Under four points there is no shape to read, so
 * there is no spark.
 */
export function Sparkline({ rows, say = String }: { rows: ChartRow[]; say?: Say }) {
  const points = rows
    .map((r) => ({ key: r.key == null ? '' : String(r.key), value: Number(r.value) }))
    .filter((p) => Number.isFinite(p.value));
  if (points.length < 4) return null;
  const W = 100;
  const H = 28;
  const max = Math.max(...points.map((p) => p.value), 0);
  const min = Math.min(...points.map((p) => p.value), 0);
  const span = max - min || 1;
  const x = (i: number) => 1 + (i * (W - 2)) / (points.length - 1);
  const y = (v: number) => 3 + (1 - (v - min) / span) * (H - 6);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${f1(x(i))},${f1(y(p.value))}`).join(' ');
  const last = points[points.length - 1];
  return (
    <svg
      className="spark"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`trend: ${points.map((p) => say(p.value)).join(', ')}`}
    >
      <title>{`${points[0].key} → ${last.key}`}</title>
      <path className="spark-area" d={`${d} L${f1(x(points.length - 1))},${H} L${f1(x(0))},${H} Z`} />
      <path className="spark-stroke" d={d} vectorEffect="non-scaling-stroke" />
      <path className="spark-dot" d={`M${f1(x(points.length - 1))},${f1(y(last.value))} h0`} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
