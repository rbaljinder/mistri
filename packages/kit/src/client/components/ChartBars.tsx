/**
 * Dashboard bar and stacked charts: single-series bars, stacked columns over
 * periods (including signed values), and horizontal stacked bars over categories.
 */
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { bandsAlong, barSpan, extentOf, stackExtent, stackSums } from '@mistriwork/ui/charts/core.js';
import { viewportBox } from '../core.js';
import { fillGaps, isPeriodRun } from '../chart.js';
import { say as sayCopy } from '../copy/dashboards/components/Chart.js';
import {
  axisMarks,
  doorStep,
  f1,
  keyWord,
  levelGutter,
  levelsOver,
  measureOf,
  partialName,
  PERIOD,
  periodTick,
  rampInk,
  sayMeasure,
  tickSay,
  tickWidth,
  TIMED_HEIGHT,
  TONE_INK,
  type ChartRow,
  type PartialPeriods,
  type Point,
  type Say,
} from './chartAxes.js';

/** How few bars count as a handful, and the most room a handful takes. */
const FEW_BARS = 6;
const FEW_HIGH = 200;

/**
 * Bars: one series, a bar per group — how much each week or each stage
 * holds, where a line says how a number moved. Over calendar buckets one bar
 * is the current one, drawn in the ink while the rest stay quiet: the last
 * (the period in hand) until the pointer names another. Its value is always
 * said, so the reader has it without a tooltip's delay: at rest as the plot's
 * headline in the corner over the levels, and in a pill over the bar the
 * pointer names. A guide runs from the bar across the levels. Over categories (a
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
  label = keyWord,
  wide = 600,
  high,
  target,
  tone,
  partial,
}: {
  rows: ChartRow[];
  say?: Say;
  label?: (key: unknown) => string;
  wide?: number;
  high?: number;
  target?: number;
  /** Buckets the window cuts through: drawn lighter with a dashed edge, and named partial. */
  partial?: PartialPeriods;
  /** A category's display tone (a state's, a status's), where its column has them: each bar wears the ink its dot and badge wear. */
  tone?: (key: unknown) => string | undefined;
}) {
  const periods = rows.length > 0 && rows.every((r) => r.key != null && PERIOD.test(String(r.key)));
  /* A row with no measure is no bar (measureOf); a period nothing was counted in is still a bar at zero (fillGaps). */
  const read = rows.flatMap((r) => {
    const measure = measureOf(r.value);
    return measure ? [{ raw: r.key, ...measure }] : [];
  });
  const bars: Array<{ raw: unknown; value: number; exact?: string }> = periods
    ? (fillGaps(read.map(({ raw, ...measure }) => ({ key: String(raw), ...measure }))) as Point[]).map(({ key, ...measure }) => ({
        raw: key,
        ...measure,
      }))
    : read;
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
  const whole = bars.map((b) => partialName(periods ? periodTick(String(b.raw)) : label(b.raw), b.raw, partial));
  const W = measured > 0 ? measured : wide;
  /* A handful of bars is read at a glance: it does not stand as tall as a month of them. */
  const few = bars.length <= FEW_BARS;
  const H = high
    ? Math.max(120, Math.min(Math.round(high), few ? FEW_HIGH : Infinity))
    : few
      ? 160
      : Math.max(160, Math.min(Math.round(W / 3), 240));
  const goal = target !== undefined && Number.isFinite(target) ? target : undefined;
  const figures = extentOf(bars.map((b) => b.value));
  const scale = levelsOver(figures, say, goal);
  const levels = scale.levels;
  /* Room over the tallest bar for the pill that names it. */
  const PAD = { top: 30, right: 6, bottom: 24, left: levelGutter(levels, say) };
  const {
    bar: barWide,
    barStart: x,
    mid,
    at: bandAt,
  } = bandsAlong(bars.length, PAD.left, W - PAD.left - PAD.right, {
    share: 0.64,
    widest: 56,
    narrowest: 2,
  });
  const y = (v: number) => PAD.top + (1 - scale.share(v)) * (H - PAD.top - PAD.bottom);
  const base = y(Math.max(scale.min, 0));
  const said = bars.map((b) => sayMeasure(say, b));
  const marks = axisMarks(
    named.map((text, i) => (periods ? String(bars[i].raw) : text)),
    mid,
    { centered: true },
  );
  /* A mark is centred under its bar, and kept inside the figure at either end. */
  const markAt = (index: number, text: string) => Math.min(Math.max(mid(index), tickWidth(text) / 2), W - tickWidth(text) / 2);
  const active: number | null = near ?? (periods ? bars.length - 1 : null);
  const tip = active === null ? '' : `${whole[active]} · ${said[active]}`;
  const tipWide = tickWidth(tip) + 12;
  const tipLeft = active === null ? 0 : Math.min(Math.max(mid(active) - tipWide / 2, PAD.left), W - PAD.right - tipWide);
  const top = active === null ? 0 : y(Math.max(bars[active].value, 0));
  const tipTop = Math.max(2, top - 26);
  const at = (e: React.PointerEvent<SVGSVGElement>) => {
    // screen-px: clientX is a screen-pixel ruler too; the ratio maps it into viewBox units.
    const box = svg.current!.getBoundingClientRect();
    if (!box.width) return bars.length - 1;
    return bandAt(((e.clientX - box.left) / box.width) * W);
  };
  return (
    <>
      <svg
        ref={svg}
        className="chart-bars"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${sayCopy('barsSummary', { count: bars.length, highest: say(figures.max), last: whole[bars.length - 1], value: said[bars.length - 1] })}${goal === undefined ? '' : sayCopy('targetAfter', { goal: say(goal) })}`}
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
          /* One edge on the zero line whichever side the value is on, and a value that is not zero never drawn as nothing. */
          const span = barSpan(y(b.value), base, b.value ? 1 : 0);
          return (
            <rect
              key={i}
              className={`chart-bar${toned ? ' is-toned' : ''}${i === active ? ' is-active' : ''}${partial?.keys.has(String(bars[i].raw)) ? ' is-partial' : ''}`}
              style={toned ? { ['--bar-ink' as string]: inks![i] } : undefined}
              x={f1(x(i))}
              y={f1(span.start)}
              width={f1(barWide)}
              height={f1(span.length)}
            >
              <title>{`${whole[i]}: ${said[i]}`}</title>
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
        {active !== null &&
          (near === null ? (
            /* At rest the period in hand is said as the plot's headline, in the room over the levels: a pill over
               its bar read as a tooltip left behind, and stood on the neighbours' tops. */
            <g className="chart-bar-tip is-rest" aria-hidden="true">
              <text x={f1(W - PAD.right)} y={14} textAnchor="end">
                {tip}
              </text>
            </g>
          ) : (
            <g className="chart-bar-tip" aria-hidden="true">
              <rect x={f1(tipLeft)} y={f1(tipTop)} width={f1(tipWide)} height={20} />
              <text x={f1(tipLeft + tipWide / 2)} y={f1(tipTop + 14)} textAnchor="middle">
                {tip}
              </text>
            </g>
          ))}
      </svg>
      {/* The hider is a block round the table, not the table itself: a table is
        never shorter than its rows, so a hidden one of 700 days stood 16,000px
        tall and the pane scrolled into blank space under the dashboard. */}
      <div className="visually-hidden">
        <table className="chart-data">
          <tbody>
            {said.map((figure, i) => (
              <tr key={i}>
                <th scope="row">{whole[i]}</th>
                <td>{figure}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** The gap between two parts of a stacked column, in the drawing's units, which are CSS pixels (it is measured). */
const PART_SEAM = 2;

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
  paint,
  legend = true,
  target,
  onPick,
}: {
  /** `raw` is the key a column goes to when it drills; a gap-filled bucket (a period nothing happened in) holds none and is no door. */
  rows: Array<{ key: string; values: Record<string, number>; raw?: unknown }>;
  series: Array<{ key: string; label: string }>;
  say?: Say;
  wide?: number;
  high?: number;
  /** A series' own paint where it is not the palette in order (a tone, a ramp step, a lighter share): its parts' style. */
  paint?: (k: number) => CSSProperties;
  /** The legend and its totals under the figure; off where the caller draws one over it. */
  legend?: boolean;
  target?: number;
  /** A column as a way into its rows, by its raw key. */
  onPick?: ((value: unknown) => void) | null;
}) {
  const columns = rows
    .map((r) => ({
      key: r.key,
      raw: r.raw,
      parts: series.map((s) => {
        const n = Number(r.values[s.key]);
        return Number.isFinite(n) ? n : 0;
      }),
    }))
    .map((c) => ({ ...c, ...stackSums(c.parts) }));
  /* Roving tabindex for the columns that drill, as a line's points have: one tab stop for the figure, the arrows
     between its doors, Home and End to its ends. */
  const doors = columns.map((c, i) => (onPick && c.raw != null ? i : -1)).filter((i) => i >= 0);
  const [roved, setRoved] = useState<number | null>(null);
  const tabbable = roved !== null && doors.includes(roved) ? roved : doors[0];
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
  const fewColumns = columns.length <= FEW_BARS;
  const H = high
    ? Math.max(120, Math.min(Math.round(high), fewColumns ? FEW_HIGH : Infinity))
    : fewColumns
      ? 160
      : Math.max(160, Math.min(Math.round(W / 3.5), 220));
  const goal = target !== undefined && Number.isFinite(target) && target > 0 ? target : undefined;
  const stacks = stackExtent(columns.map((c) => c.parts));
  const min = stacks.min;
  /* Columns that only stand up are ruled to at least one, so a week of nothing is not an axis of fractions. */
  const max = min < 0 ? stacks.max : Math.max(stacks.max, 1);
  const highest = extentOf(columns.map((c) => c.total)).max;
  const scale = levelsOver({ min, max }, say, goal);
  const levels = scale.levels;
  const PAD = { top: 30, right: 6, bottom: 24, left: levelGutter(levels, say) };
  const {
    band,
    bar: colWide,
    barStart: x,
    mid,
    at: bandAt,
  } = bandsAlong(columns.length, PAD.left, W - PAD.left - PAD.right, {
    share: 0.64,
    widest: 40,
    narrowest: 2,
  });
  const y = (v: number) => PAD.top + (1 - scale.share(v)) * (H - PAD.top - PAD.bottom);
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
  /* The readout is one line of a drawing, which cannot wrap: where every part does not fit the plot's width it says
     the parts that hold something, and where those do not fit, the column's total. Cut at the plot's edge it read
     ",300.00 · Launch £0.00" on a phone. The door's label and the table under the plot still say every part. */
  const tipRoom = W - PAD.left - PAD.right - 12;
  const held = series.flatMap((s, k) => (columns[active].parts[k] ? [`${s.label} ${say(columns[active].parts[k])}`] : []));
  const tip =
    [`${named[active]} · ${parts(active)}`, ...(held.length ? [`${named[active]} · ${held.join(' · ')}`] : [])].find(
      (said) => tickWidth(said) <= tipRoom,
    ) ?? `${named[active]} · ${say(columns[active].total)}`;
  const tipWide = tickWidth(tip) + 12;
  const tipLeft = Math.min(Math.max((pointer?.x ?? mid(active)) - tipWide / 2, PAD.left), W - PAD.right - tipWide);
  const top = y(Math.max(columns[active].up, 0));
  const tipTop = pointer ? Math.min(Math.max(2, pointer.y - 30), H - PAD.bottom - 22) : Math.max(2, top - 26);
  const color = (k: number) => `var(--chart-${k + 1}, var(--accent))`;
  const moveRoving = (to: number) => {
    setRoved(to);
    (svg.current?.querySelectorAll('.chart-column-door')[doors.indexOf(to)] as HTMLElement | undefined)?.focus?.();
  };
  const at = (e: React.PointerEvent<SVGSVGElement>) => {
    // screen-px: clientX is a screen-pixel ruler too; the ratio maps it into viewBox units.
    const box = svg.current!.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const px = ((e.clientX - box.left) / box.width) * W;
    setPointer({ x: px, y: ((e.clientY - box.top) / box.height) * H });
    setNear(bandAt(px));
  };
  const totals = series.map((_, k) => columns.reduce((n, c) => n + c.parts[k], 0));
  return (
    <div className="chart-columns">
      <svg
        ref={svg}
        className="chart-bars"
        viewBox={`0 0 ${W} ${H}`}
        /* A picture must not hold buttons (a line's points say why): where a column drills, the figure is a group. */
        role={doors.length ? 'group' : 'img'}
        aria-label={`${sayCopy('barsSummary', {
          count: columns.length,
          highest: say(min < 0 ? highest : Math.max(highest, 1)),
          last: named[columns.length - 1],
          value: say(columns[columns.length - 1].total),
        })}${goal === undefined ? '' : sayCopy('targetAfter', { goal: say(goal) })}`}
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
          let upBase = 0;
          let downBase = 0;
          const column = (
            <>
              <title>{`${named[i]}: ${parts(i)}`}</title>
              {c.parts.map((v, k) => {
                if (!v) return null;
                if (v > 0) {
                  const from = upBase;
                  upBase += v;
                  /* A part stands a hair off the one under it, so two series of near hues read as two; the column's top
                     part alone is rounded (Chart.css), so the column is one shape. */
                  const tall = y(from) - y(upBase);
                  const seam = from > 0 && tall > PART_SEAM + 1 ? PART_SEAM : 0;
                  return (
                    <rect
                      key={k}
                      className={`chart-column-part${upBase >= c.up ? ' is-top' : ''}`}
                      x={f1(x(i))}
                      y={f1(y(upBase))}
                      width={f1(colWide)}
                      height={f1(Math.max(1, tall - seam))}
                      style={paint ? paint(k) : { fill: color(k) }}
                    />
                  );
                }
                const from = downBase;
                downBase += v;
                const tall = y(downBase) - y(from);
                const seam = from < 0 && tall > PART_SEAM + 1 ? PART_SEAM : 0;
                return (
                  <rect
                    key={k}
                    className={`chart-column-part${downBase <= c.down ? ' is-bottom' : ''}`}
                    x={f1(x(i))}
                    y={f1(y(from) + seam)}
                    width={f1(colWide)}
                    height={f1(Math.max(1, tall - seam))}
                    style={paint ? paint(k) : { fill: color(k) }}
                  />
                );
              })}
            </>
          );
          const className = `chart-column${i === active ? ' is-active' : ''}`;
          if (!(onPick && c.raw != null))
            return (
              <g key={c.key} className={className}>
                {column}
              </g>
            );
          /* A column that goes somewhere is a door over its whole band, so a short column is as easy to find as a tall
             one; its focus is the house ring round the band. */
          return (
            <g
              key={c.key}
              className={`${className} chart-column-door`}
              role="button"
              tabIndex={i === tabbable ? 0 : -1}
              aria-label={`${named[i]}: ${parts(i)}`}
              onClick={() => onPick(c.raw)}
              onKeyDown={(event: React.KeyboardEvent) => {
                const key = event.key;
                if (key === 'Enter' || key === ' ') {
                  event.preventDefault();
                  onPick(c.raw);
                  return;
                }
                const to = doorStep(key, doors, i);
                if (to !== undefined) {
                  event.preventDefault();
                  moveRoving(to);
                }
              }}
            >
              {column}
              <rect
                className="chart-column-hit"
                x={f1(PAD.left + band * i)}
                y={PAD.top}
                width={f1(band)}
                height={f1(H - PAD.top - PAD.bottom)}
              />
            </g>
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
            x={f1(markAt(index, text))}
            y={H - 6}
            textAnchor="middle"
          >
            {text}
          </text>
        ))}
        {near === null && !pointer ? (
          <g className="chart-bar-tip is-rest" aria-hidden="true">
            <text x={f1(W - PAD.right)} y={14} textAnchor="end">
              {tip}
            </text>
          </g>
        ) : (
          <g className="chart-bar-tip" aria-hidden="true">
            <rect x={f1(tipLeft)} y={f1(tipTop)} width={f1(tipWide)} height={20} />
            <text x={f1(tipLeft + tipWide / 2)} y={f1(tipTop + 14)} textAnchor="middle">
              {tip}
            </text>
          </g>
        )}
      </svg>
      {legend && (
        <ul className="chart-legend chart-columns-legend">
          {series.map((s, k) => (
            <li key={s.key}>
              <span className="chart-swatch" style={{ background: color(k) }} />
              <span className="chart-legend-key">{s.label}</span>
              <span className="chart-legend-value">{say(totals[k])}</span>
            </li>
          ))}
        </ul>
      )}
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
  label = keyWord,
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
  /** The chart's visible figures (legend, each bar's total, the target) by one rule, given every one of them as stored
      (compact for all or exact for all); the titles and the hidden text stay exact. */
  sayLegend?: (figures: readonly number[]) => Say;
}) {
  const MAX_SERIES = 7;
  const OTHERS = '\u0000others';
  const name = (v: unknown) => (v == null ? '—' : String(v));
  const bars = new Map<string, { raw: unknown; total: number; parts: Map<string, number> }>();
  const seriesTotals = new Map<string, { raw: unknown; total: number }>();
  for (const row of rows) {
    const value = measureOf(row.value)?.value;
    if (value === undefined || value <= 0) continue;
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
    ? [...kept, { key: OTHERS, label: sayCopy('others', { restCount: rest.length }), total: rest.reduce((n, [, s]) => n + s.total, 0) }]
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
  const scale = extentOf(
    shown.map((bar) => bar.total),
    Infinity,
    goal ?? 0,
  ).max;
  const share = (v: number) => `${((100 * v) / scale).toFixed(2)}%`;
  const sayTotal = sayLegend
    ? sayLegend([...series.map((s) => s.total), ...shown.map((bar) => bar.total), ...(goal === undefined ? [] : [goal])])
    : say;
  /* A bar's share of one series, the tail's folded into "others". */
  const partOf = (bar: (typeof shown)[number], s: { key: string }) =>
    s.key === OTHERS
      ? [...bar.parts.entries()]
          .filter(([key]) => slot(key) === series.length - 1 && !kept.some((k) => k.key === key))
          .reduce((n, [, v]) => n + v, 0)
      : (bar.parts.get(s.key) ?? 0);
  const legend = (
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
          <span className="chart-legend-value">{sayTotal(goal)}</span>
        </li>
      )}
    </ul>
  );
  /* Time runs across the page, as it does in every other chart of a period: a column a period, at the bars' own height
     and axis, its empty periods at zero, under the legend the rows have. Rows are for categories, whose order is the
     reader's to scan down. */
  if (timed) {
    const filled = fillGaps(shown.map((bar) => ({ key: String(bar.raw), value: bar.total, bar }))) as Array<{
      key: string;
      bar?: (typeof shown)[number];
    }>;
    return (
      <div className="chart-stacked chart-stacked-timed">
        {legend}
        <StackedColumns
          rows={filled.map(({ key, bar }) => ({
            key,
            raw: bar?.raw,
            values: bar ? Object.fromEntries(series.map((s) => [s.key, partOf(bar, s)])) : {},
          }))}
          series={series}
          say={say}
          high={TIMED_HEIGHT}
          paint={(i) => ({ ...ramp(i), fill: color(i), opacity: opacity(i) })}
          legend={false}
          target={goal}
          onPick={onPick}
        />
      </div>
    );
  }
  return (
    <div className="chart-stacked">
      {legend}
      <ul
        className="chart-stacked-rows"
        aria-label={`${sayCopy('barsBySeries', { count: shown.length, series: series.map((s) => s.label).join(', ') })}${goal === undefined ? '' : sayCopy('targetAfter', { goal: say(goal) })}`}
      >
        {shown.map((bar, at) => {
          /* Each series in legend order, so a colour sits in the same place in every bar. */
          const parts = series.map((s, i) => ({ s, i, value: partOf(bar, s) })).filter((part) => part.value > 0);
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
              <span className="chart-stacked-total">{sayTotal(bar.total)}</span>
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
