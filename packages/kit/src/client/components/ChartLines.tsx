/**
 * Dashboard line and sparkline charts: single-series lines, multi-series lines,
 * and KPI card sparklines, including single-point plotting when only one bucket
 * is present.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { areaPath, extentOf, nearestPoint, pointAlong } from '@mistriwork/ui/charts/core.js';
import { viewportBox } from '../core.js';
import { fillGaps } from '../chart.js';
import { say as sayCopy } from '../copy/dashboards/components/Chart.js';
import {
  axisMarks,
  doorStep,
  f1,
  levelGutter,
  levelsOver,
  linePath,
  measureOf,
  namesAtEnds,
  partialName,
  PERIOD,
  periodTick,
  sayMeasure,
  tickSay,
  tickWidth,
  type ChartRow,
  type PartialPeriods,
  type Point,
  type Say,
} from './chartAxes.js';

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
  onPick,
  partial,
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
  /** Where a point goes when it drills, by its raw key: single-series lines only — a multi-series line takes no
      drill, since one pick cannot name both a series and a point. */
  onPick?: ((value: unknown) => void) | null;
  /** Buckets the window cuts through: drawn dashed and named partial, single-series lines only. */
  partial?: PartialPeriods;
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
  return (
    <OneLine rows={rows} say={say} wide={wide} high={high} target={target} smooth={smooth} dots={dots} onPick={onPick} partial={partial} />
  );
}

function OneLine({
  rows,
  say,
  wide,
  high,
  target,
  smooth,
  dots,
  onPick,
  partial,
}: {
  rows: ChartRow[];
  say: Say;
  wide: number;
  high?: number;
  target?: number;
  smooth: boolean;
  dots: boolean;
  onPick?: ((value: unknown) => void) | null;
  partial?: PartialPeriods;
}) {
  const points = fillGaps(
    rows.flatMap((r) => {
      const measure = measureOf(r.value);
      return measure ? [{ key: r.key == null ? '—' : String(r.key), ...measure, raw: r.key }] : [];
    }),
  ) as Point[];
  const svg = useRef<SVGSVGElement>(null);
  const [near, setNear] = useState<number | null>(null);
  const [measured, setMeasured] = useState(0);
  /* Roving tabindex for drillable points: one tab stop for the whole
     line, not one per point. The tabbable point is the roved-to one, or
     the first drillable one where the roved-to one stopped drilling;
     arrows move among drillable points only, Home and End take the
     first and last. */
  const drillableAt = points.map((p, i) => (onPick && p.raw != null ? i : -1)).filter((i) => i >= 0);
  const [roved, setRoved] = useState<number | null>(null);
  const tabbable = roved !== null && drillableAt.includes(roved) ? roved : drillableAt[0];
  const moveRoving = (at: number) => {
    setRoved(at);
    const el = svg.current?.querySelectorAll('.chart-point-drill')[drillableAt.indexOf(at)];
    (el as HTMLElement | undefined)?.focus?.();
  };
  /* Even a single point is plotted cleanly at the center of the axis; only empty data has nothing to draw. */
  const drawn = points.length >= 1;
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

  const asDots = dots || points.length === 1;
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
  const scale = levelsOver(extentOf(points.map((p) => p.value)), say, goal);
  const levels = scale.levels;
  const PAD = { top: 14, right: 14, bottom: 24, left: levelGutter(levels, say) };
  const x = (i: number) => pointAlong(i, points.length, PAD.left, W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - scale.share(v)) * (H - PAD.top - PAD.bottom);
  const line = linePath(
    points.map((p, i) => [x(i), y(p.value)] as const),
    smooth,
  );
  const area = areaPath(line, x(0), x(points.length - 1), y(scale.min));
  /* Every figure is said from its own digits where a number would round them (sayMeasure). */
  const said = points.map((p) => sayMeasure(say, p));
  const peak = points.reduce((most, p) => (p.value > most.value ? p : most));

  /* A point is named with its year wherever it stands alone — a dot's
     title, the crosshair, the table — and the axis drops the year a tick
     shares with the one before it. */
  const named = points.map((p) => partialName(periodTick(p.key), p.key, partial));
  const marks = axisMarks(
    points.map((p) => p.key),
    x,
  );
  /* A window cuts only its first and last bucket: the line is solid through the whole ones and dashed to and from a
     partial one, so a week still in hand does not read as the measure falling. */
  const cut = points.map((p) => Boolean(partial?.keys.has(p.key)));
  const last = points.length - 1;
  const whole: [number, number] = [cut[0] ? 1 : 0, cut[last] ? last - 1 : last];
  const hasWhole = whole[1] - whole[0] >= 1;
  const through = (from: number, to: number) =>
    linePath(
      points.slice(from, to + 1).map((p, i) => [x(from + i), y(p.value)] as const),
      smooth,
    );

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    // screen-px: clientX is a screen-pixel ruler too; the ratio maps it into viewBox units.
    const box = svg.current!.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    setNear(nearestPoint(px, points.length, PAD.left, W - PAD.left - PAD.right));
  };
  const cx = near === null ? 0 : x(near);
  const cy = near === null ? 0 : y(points[near].value);
  const right = cx > W * 0.7;
  /* A picture must not hold buttons: where any point drills, the figure
     is a group holding buttons, not an image — axe's nested-interactive
     fails a button inside role="img", as a donut's does. Where nothing
     drills it stays an image, as before. */
  const anyDrillable = onPick && points.some((p) => p.raw != null);
  return (
    <>
      <svg
        ref={svg}
        className="chart-line"
        viewBox={`0 0 ${W} ${H}`}
        role={anyDrillable ? 'group' : 'img'}
        aria-label={`${sayCopy('lineSummary', { count: points.length, from: said[0], to: said[points.length - 1], peak: sayMeasure(say, peak) })}${goal === undefined ? '' : sayCopy('targetAfter', { goal: say(goal) })}`}
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
        {!asDots && <path className="chart-area" d={area} />}
        {!asDots && (hasWhole || !cut.some(Boolean)) && <path className="chart-stroke" d={hasWhole ? through(whole[0], whole[1]) : line} />}
        {!asDots && cut.some(Boolean) && !hasWhole && <path className="chart-stroke is-partial" d={line} />}
        {!asDots && hasWhole && whole[0] > 0 && <path className="chart-stroke is-partial" d={through(0, whole[0])} />}
        {!asDots && hasWhole && whole[1] < last && <path className="chart-stroke is-partial" d={through(whole[1], last)} />}
        {points.map((p, i) => {
          const dot = (
            <circle
              className={`${asDots && p.value !== 0 ? 'chart-dot chart-dot-solid' : 'chart-dot'}${cut[i] ? ' is-partial' : ''}`}
              cx={f1(x(i))}
              cy={f1(y(p.value))}
              r={asDots ? 4 : 3}
            >
              <title>{`${named[i]}: ${said[i]}`}</title>
            </circle>
          );
          /* A point drills where a door is wanted: the same raw value a
             legend button would carry. A dot is too small a target to be
             the button itself, so a drillable point is a group holding the
             dot and a wider transparent hit disc — one tab stop, not two,
             and roving tabindex keeps the whole line to that one stop.
             Gap-filled buckets hold no raw key and are no door, as a
             donut's "others" slice is none. */
          const drillable = onPick && p.raw != null;
          if (!drillable) return <g key={i}>{dot}</g>;
          return (
            <g
              key={i}
              className="chart-point-drill"
              role="button"
              tabIndex={i === tabbable ? 0 : -1}
              aria-label={`${named[i]}: ${said[i]}`}
              onClick={() => onPick!(p.raw)}
              onKeyDown={(event: React.KeyboardEvent) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onPick!(p.raw);
                } else {
                  const at = doorStep(event.key, drillableAt, i);
                  if (at !== undefined) {
                    event.preventDefault();
                    moveRoving(at);
                  }
                }
              }}
            >
              <circle className="chart-point-hit" cx={f1(x(i))} cy={f1(y(p.value))} r={12} />
              {dot}
            </g>
          );
        })}
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
            {near === null ? '' : `${named[near]} · ${said[near]}`}
          </text>
        </g>
      </svg>
      {/* The hider is a block round the table, not the table itself: a table is
        never shorter than its rows, so a hidden one of 700 days stood 16,000px
        tall and the pane scrolled into blank space under the dashboard. */}
      <div className="visually-hidden">
        <table className="chart-data">
          <tbody>
            {said.map((figure, i) => (
              <tr key={i}>
                <th scope="row">{named[i]}</th>
                <td>{figure}</td>
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
    totals.set(id, (totals.get(id) ?? 0) + (measureOf(r.value)?.value ?? 0));
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
      const measure = measureOf(r.value);
      if (measure) values[keys.indexOf(r.key == null ? '—' : String(r.key))] += measure.value;
    }
    return {
      id,
      label: id === OTHERS ? sayCopy('others', { restCount: ranked.length - kept.length }) : seriesLabel(named.get(id)),
      color: `var(--chart-${slot + 1}, var(--accent))`,
      values,
    };
  });
  const shown = only && series.some((line) => line.id === only) ? series.filter((line) => line.id === only) : series;
  const hasFinite = rows.some((r) => measureOf(r.value) !== undefined);
  const drawn = keys.length >= 1 && hasFinite;
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
  const single = keys.length === 1;
  const W = measured > 0 ? measured : wide;
  const H = high ? Math.max(120, Math.round(high)) : Math.max(120, Math.min(Math.round(W / 3), 220));
  const goal = target !== undefined && Number.isFinite(target) ? target : undefined;
  const scale = levelsOver(extentOf(shown.flatMap((line) => line.values)), say, goal);
  const levels = scale.levels;
  const gutter = levelGutter(levels, say);
  /* A few lines are named where they end, not in a key above them: the eye follows a line to its name instead of
     matching a color back to a list. Past three, or where the names would take more than a quarter of the width, the
     legend says them. */
  const nameRoom = Math.max(...shown.map((line) => tickWidth(line.label))) + 8;
  const direct = !single && shown.length <= DIRECT_LINES && nameRoom <= W / 4;
  const PAD = { top: 14, right: direct ? nameRoom : 14, bottom: 24, left: gutter };
  const x = (i: number) => pointAlong(i, keys.length, PAD.left, W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - scale.share(v)) * (H - PAD.top - PAD.bottom);
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
    setNear(nearestPoint(px, keys.length, PAD.left, W - PAD.left - PAD.right));
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
          {single
            ? shown.map((line) => (
                <circle
                  key={line.id}
                  className="chart-dot chart-dot-solid chart-series-dot"
                  style={{ fill: line.color, stroke: line.color }}
                  cx={f1(x(0))}
                  cy={f1(y(line.values[0]))}
                  r={4}
                >
                  <title>{`${ticks[0]} · ${line.label}: ${say(line.values[0])}`}</title>
                </circle>
              ))
            : shown.map((line) => (
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
              textAnchor={keys.length > 1 && index === 0 ? 'start' : keys.length > 1 && index === keys.length - 1 ? 'end' : 'middle'}
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

/** A spark needs this many periods above zero to be a line; fewer are bars (Sparkline). */
const SPARK_LEAST = 4;

/**
 * A spark: the measure's shape inside a KPI card. No axes; the card's own
 * number is the label. It spans the card's width, stretched rather than
 * scaled, so a wide card draws a long trend instead of a 110px stub in its
 * corner; the stroke and the last point's dot keep their own size however
 * far it stretches (`non-scaling-stroke`, and the dot is a round cap on a
 * zero-length stroke). A single point draws its dot over the baseline; two or
 * three points, or runs with fewer than four periods above zero, draw thin bars
 * over the baseline; an all-zero multi-point run draws none.
 */
export function Sparkline({ rows, say = String }: { rows: ChartRow[]; say?: Say }) {
  const points = rows.flatMap((r) => {
    const measure = measureOf(r.value);
    return measure ? [{ key: r.key == null ? '' : String(r.key), ...measure }] : [];
  });
  if (points.length < 1) return null;
  const W = 100;
  const H = 28;
  /* The card's number is read against zero, so zero is in the spark's range, as it is on every value axis. */
  const { min, max } = extentOf(
    points.map((p) => p.value),
    0,
    0,
  );
  const span = max - min || 1;
  const x = (i: number) => pointAlong(i, points.length, 1, W - 2);
  const said = points.map((p) => sayMeasure(say, p));
  const y = (v: number) => 3 + (1 - (v - min) / span) * (H - 6);
  if (points.length === 1) {
    const base = y(0);
    const pt = points[0];
    return (
      <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`trend: ${said[0]}`}>
        <title>{pt.key}</title>
        <path className="spark-base" d={`M1,${f1(base)} H${W - 1}`} vectorEffect="non-scaling-stroke" />
        <path className="spark-dot" d={`M${f1(x(0))},${f1(y(pt.value))} h0`} vectorEffect="non-scaling-stroke" />
      </svg>
    );
  }
  const filled = points.filter((p) => p.value !== 0).length;
  if (filled === 0) return null;
  if (filled < SPARK_LEAST) {
    const base = y(0);
    return (
      <svg
        className="spark spark-sparse"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`trend: ${said.join(', ')}`}
      >
        <title>{`${points[0].key} → ${points[points.length - 1].key}`}</title>
        <path className="spark-base" d={`M1,${f1(base)} H${W - 1}`} vectorEffect="non-scaling-stroke" />
        {points.map((p, i) =>
          p.value ? (
            <path key={i} className="spark-bar" d={`M${f1(x(i))},${f1(base)} V${f1(y(p.value))}`} vectorEffect="non-scaling-stroke" />
          ) : null,
        )}
      </svg>
    );
  }
  const d = linePath(points.map((p, i) => [x(i), y(p.value)] as const));
  const last = points[points.length - 1];
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`trend: ${said.join(', ')}`}>
      <title>{`${points[0].key} → ${last.key}`}</title>
      <path className="spark-area" d={`${d} L${f1(x(points.length - 1))},${H} L${f1(x(0))},${H} Z`} />
      <path className="spark-stroke" d={d} vectorEffect="non-scaling-stroke" />
      <path className="spark-dot" d={`M${f1(x(points.length - 1))},${f1(y(last.value))} h0`} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
