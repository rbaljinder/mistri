/**
 * A breakdown's answer drawn as a chart — the one drawing a dashboard's chart
 * and a record page's chart share, so a line reads the same about a whole
 * table and about one customer. The caller asks for the groups; this measures
 * the width it has, picks the shape and says what an empty answer means.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { viewportBox } from '../core.js';
import { BarChart, DonutChart, LineChart, StackedBars } from './Chart.js';
import { Empty } from './Notes.js';
import { orderDeclared } from './groupOrder.js';
import { onDemand } from './onDemand.js';
import type { ExtraShape } from './ChartShapes.js';

export type { ExtraShape };
/* The shapes drawn by the part on demand: said beside the dashboard's preload (dashboardModel.ts), which asks for it early. */
export { EXTRA_SHAPES } from './dashboardModel.js';
const ChartShape = onDemand(() => import('./ChartShapes.js'), 'ChartShape');

interface Answer {
  columns?: string[];
  rows?: Array<Record<string, unknown>>;
}

interface ChartFigureProps {
  /** The breakdown's answer: key columns first, the measure last. Absent while it loads. */
  answer: Answer | undefined;
  shape?: 'line' | 'bar' | 'donut' | 'stacked';
  limit?: number;
  target?: number;
  height?: number;
  say: (value: unknown) => string;
  /** A first key's value as its reader says it, and the second's for stacked bars. */
  label: (key: unknown) => string;
  seriesLabel?: (key: unknown) => string;
  /** The first key's vocabulary, which a donut's slices go round in. */
  vocabulary?: readonly string[];
  /** The second key's vocabulary: a line per value keeps the color that value's slice has in a donut. */
  seriesVocabulary?: readonly string[];
  /** The first key is a scale (groupOrder.ts, isScale): its groups keep its order, and a donut's slices are steps
      of one hue. */
  scale?: boolean;
  /** The second key is a scale: stacked bars' series keep its order and are steps of one hue. */
  seriesScale?: boolean;
  /** The second key's value as its display map's tone (good, warn, bad, info, neutral), for stacked bars to draw in. */
  seriesTone?: (key: string) => string | undefined;
  /** A first-key category's tone (a state's), which bars and slices over that key wear. */
  tone?: (key: unknown) => string | undefined;
  /** How stacked bars' legend says its totals, given all of them, so one rule says every figure. */
  sayLegend?: (totals: readonly number[]) => (value: unknown) => string;
  /** A slice or a bar as a way into its rows, where the key is a plain column. */
  onPick?: ((value: unknown) => void) | null;
  /** What an answer with no groups says. */
  empty: string;
  /** A line's curve: smooth draws a monotone curve through its points. */
  curve?: 'smooth' | 'straight';
  /** A donut's words for the figure in its middle. */
  total?: string;
  /** How a donut's slices and a bar chart's categories are arranged: 'answer' keeps the order they were asked in (the
      page's chart asked for the key's natural order, or a column's), 'value' is biggest first whatever the key's
      vocabulary. Absent, the key's vocabulary or scale, else biggest first. */
  arrange?: 'answer' | 'value';
  /** A line with too few filled buckets to draw a line through keeps its shape and stands its points alone. */
  dots?: boolean;
}

export function ChartFigure({
  answer,
  shape,
  limit,
  target,
  height,
  say,
  label,
  seriesLabel,
  vocabulary,
  seriesVocabulary,
  scale,
  seriesScale,
  seriesTone,
  tone,
  sayLegend,
  onPick,
  empty,
  curve,
  total,
  dots,
  arrange,
}: ChartFigureProps) {
  const stacked = shape === 'stacked';
  const donut = shape === 'donut';
  const bars = shape === 'bar';
  const host = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(0);
  const columns = answer?.columns ?? [];
  /* A donut's slices go round in the order its groups are read, as a
     breakdown's bars do; so do bars over categories. Bars over periods keep
     the calendar's order. A line over a key with declared choices (a stage)
     walks them in their declared order, not the answer's alphabetical one.
     A scale (an age in days, a priority) keeps its own order everywhere. */
  const periods = (answer?.rows ?? []).every((row) => /^\d{4}(-\d{2}(-\d{2})?|-Q[1-4])?$/.test(String(row[columns[0]])));
  const answered =
    arrange === 'answer' && (donut || bars)
      ? (answer?.rows ?? []).slice(0, limit)
      : arrange === 'value' && (donut || (bars && !periods))
        ? orderDeclared(answer?.rows ?? [], columns[0], columns[1]).slice(0, limit)
        : donut || (bars && !periods) || (!stacked && !periods && columns.length < 3 && ((vocabulary?.length ?? 0) > 0 || Boolean(scale)))
          ? orderDeclared(answer?.rows ?? [], columns[0], columns[1], vocabulary, scale).slice(0, limit)
          : (answer?.rows ?? []);
  /* A line over a two-key answer is a line per value of the second key. */
  const multi = !stacked && !donut && !bars && columns.length >= 3;
  const rows = answered.map((r) => ({
    key: r[columns[0]],
    value: r[columns[stacked || multi ? 2 : 1]],
    series: stacked || multi ? r[columns[1]] : undefined,
  }));
  /* The viewBox matches the width the chart actually has — measured,
     because a guess from the declared section width scales tick text
     with the monitor. By the time the data is back the host has layout. */
  useLayoutEffect(() => {
    const element = host.current;
    if (!element || !answer || !rows.length) return;
    const measure = () => setWide(Math.max(0, Math.round(viewportBox(element).width)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [answer]); // eslint-disable-line react-hooks/exhaustive-deps
  if (answer && !rows.length) return <Empty text={empty} />;
  /* Before the answer, the chart's room at about the height it will draw at, ruled as its gridlines will be: an empty
     host was nothing tall, and the chart arriving pushed every section under it down. */
  if (!answer) return <ChartWait shape={stacked ? 'rows' : donut ? 'donut' : 'plot'} height={height} rows={limit} />;
  return (
    <div className="chart-host" ref={host}>
      {answer &&
        wide > 0 &&
        (donut ? (
          <DonutChart rows={rows} say={say} label={label} onPick={onPick} total={total} ordered={scale} tone={tone} />
        ) : bars ? (
          <BarChart rows={rows} say={say} label={label} wide={wide} high={height} target={target} tone={tone} />
        ) : stacked ? (
          <StackedBars
            rows={rows}
            say={say}
            target={target}
            limit={limit}
            label={label}
            seriesLabel={seriesLabel}
            onPick={onPick}
            seriesVocabulary={seriesVocabulary}
            seriesOrdered={seriesScale}
            seriesTone={seriesTone}
            sayLegend={sayLegend}
          />
        ) : (
          <LineChart
            rows={rows}
            say={say}
            wide={wide}
            high={height}
            target={target}
            smooth={curve === 'smooth'}
            dots={dots}
            seriesLabel={seriesLabel}
            seriesVocabulary={seriesVocabulary}
            onPick={onPick}
          />
        ))}
    </div>
  );
}

interface ChartShapeFigureProps {
  shape: ExtraShape;
  answer: Answer | undefined;
  say: (value: unknown) => string;
  sayX?: (value: unknown) => string;
  names?: { x: string; y: string };
  label: (key: unknown) => string;
  seriesLabel?: (key: unknown) => string;
  vocabulary?: readonly string[];
  seriesVocabulary?: readonly string[];
  limit?: number;
  target?: number;
  height?: number;
  empty: string;
}

/** One of the further shapes, measured as the others are and drawn by the part on demand. */
export function ChartShapeFigure({ answer, empty, height, ...rest }: ChartShapeFigureProps) {
  const host = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(0);
  const rows = answer?.rows ?? [];
  useLayoutEffect(() => {
    const element = host.current;
    if (!element || !answer || !rows.length) return;
    const measure = () => setWide(Math.max(0, Math.round(viewportBox(element).width)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [answer]); // eslint-disable-line react-hooks/exhaustive-deps
  if (answer && !rows.length) return <Empty text={empty} />;
  if (!answer) return <ChartWait shape="plot" height={height} />;
  return (
    <div className="chart-host" ref={host}>
      {answer && wide > 0 && <ChartShape {...rest} answer={answer} wide={wide} high={height} />}
    </div>
  );
}

/**
 * A chart's room while it is read: a plot at the line's own measure (a third of its width, 160px to 240px, or the
 * section's `height`), a stack at a row a group, a donut at its disc. Quiet gridlines and no sweep: a chart is a
 * figure, and a moving placeholder in it read as data dancing (docs/design.md, Motion, rule 8).
 */
function ChartWait({ shape, height, rows }: { shape: 'plot' | 'rows' | 'donut'; height?: number; rows?: number }) {
  const style =
    shape === 'rows'
      ? { height: `${Math.min(Math.max(rows ?? 4, 2), 8) * 30 + 32}px` }
      : shape === 'donut'
        ? { height: '200px' }
        : height
          ? { height: `${Math.max(120, Math.round(height))}px` }
          : undefined;
  return <div className={`chart-host chart-wait chart-wait-${shape}`} style={style} role="status" aria-busy="true" />;
}
