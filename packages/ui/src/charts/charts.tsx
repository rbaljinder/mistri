/** Responsive SVG sparkline, area, and line telemetry charts. */
import { type MouseEvent as ReactMouseEvent, type Ref, useCallback, useId, useMemo, useState } from 'react';
import { cx, type Tone } from '../internal/cx.js';
import { viewportBox, viewportScale } from '../internal/ruler.js';
import { formatChartNumber, formatExactNumeric, readChartValue, type ChartReading } from './chartFormat.js';
import { areaPath as areaBack, linePath as pathThrough } from './chartPath.js';
import { extentOf, nearestPoint, pointAlong, stackExtent, valueScale } from './chartScale.js';
import {
  ChartAccessibleTable,
  ChartLiveReadout,
  SeriesLegend,
  chartColorAt,
  pageValueGutter,
  pickAxisLabels,
  safeSvgId,
  toneColor,
  useChartStepping,
  useContainerWidth,
  type ChartSeries,
} from './chartShared.js';

export type { ChartSeries };

interface Point {
  x: number;
  y: number;
}

/* The shared path rule (chartPath.ts) through the page charts' own points and their `curve` word, written to two
   places: these are drawn at whatever size a page gives them, down to a spark a couple of dozen pixels high. */
const PATH_DIGITS = 2;
const buildLinePath = (points: ReadonlyArray<Point>, curve: 'smooth' | 'linear'): string =>
  pathThrough(
    points.map((p) => [p.x, p.y] as const),
    curve === 'smooth',
    PATH_DIGITS,
  );
const areaUnder = (line: string, firstX: number, lastX: number, levelY: number) => areaBack(line, firstX, lastX, levelY, PATH_DIGITS);

/* -------------------------------------------------------------------------- */
/* 1. Sparkline                                                               */
/* -------------------------------------------------------------------------- */

/** Props for the `Sparkline` component. */
export interface SparklineProps {
  data: ReadonlyArray<number>;
  width?: number;
  height?: number;
  tone?: Tone;
  curve?: 'smooth' | 'linear';
  fill?: boolean;
  showEndDot?: boolean;
  locale?: string;
  /** Optional group label announced around the sparkline. */
  label?: string;
  ariaLabel?: string;
  formatValue?: (v: number) => string;
  className?: string;
  ref?: Ref<HTMLSpanElement>;
}

/** Compact inline SVG trend line with single-point fallback, optional area fill, and screen-reader value summary. */
export function Sparkline(props: SparklineProps) {
  const {
    data,
    width = 96,
    height = 28,
    tone = 'accent',
    curve = 'smooth',
    fill = true,
    showEndDot = false,
    locale,
    label,
    ariaLabel,
    formatValue: explicitFormatValue,
    className,
    ref,
  } = props;
  const legacyProps = props as unknown as {
    'aria-label'?: string;
    say?: (value: unknown) => string;
  };
  const legacySay = legacyProps.say;
  const explicitAriaLabel = ariaLabel ?? legacyProps['aria-label'];
  const formatValue = useMemo(
    () => explicitFormatValue ?? (legacySay ? (v: number) => legacySay(v) : (v: number) => formatChartNumber(v, locale)),
    [explicitFormatValue, legacySay, locale],
  );
  const summarySay = explicitFormatValue ?? (legacySay ? (v: number) => legacySay(v) : String);
  const resolvedSvgAriaLabel =
    explicitAriaLabel ?? (data.length > 0 ? `trend: ${data.map((v) => summarySay(v)).join(', ')}` : 'Sparkline trend');
  const uid = safeSvgId(useId());
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const color = toneColor(tone);

  const { points, linePath, areaPath } = useMemo(() => {
    if (data.length === 0) return { points: [] as Point[], linePath: '', areaPath: '' };
    const padX = 3;
    const padY = 4;
    const clean = data.map((v) => (Number.isFinite(v) ? v : 0));
    const { min, max } = extentOf(clean);
    const isFlat = max === min;
    const span = max - min || 1;
    const innerW = Math.max(1, width - padX * 2);
    const innerH = Math.max(1, height - padY * 2);

    const pts: Point[] = clean.map((v, i) => ({
      x: data.length === 1 ? width / 2 : pointAlong(i, data.length, padX, innerW),
      y: isFlat ? height / 2 : padY + innerH - ((v - min) / span) * innerH,
    }));

    /* One reading is a level, not a trend: a short flat stroke through the dot says "a sparkline, holding here". A
       dot alone in an unmarked box read as a stray mark beside its neighbours. */
    if (pts.length === 1) {
      const only = pts[0]!;
      const reach = Math.min(innerW / 2, 14);
      return {
        points: pts,
        linePath: `M ${(only.x - reach).toFixed(2)} ${only.y} L ${(only.x + reach).toFixed(2)} ${only.y}`,
        areaPath: '',
      };
    }

    const line = buildLinePath(pts, curve);
    const first = pts[0]!;
    const last = pts[pts.length - 1]!;
    const baselineY = isFlat || min >= 0 ? height - 1 : max <= 0 ? 1 : padY + innerH - ((0 - min) / span) * innerH;
    const area = areaUnder(line, first.x, last.x, baselineY);
    return { points: pts, linePath: line, areaPath: area };
  }, [data, width, height, curve]);

  const handleMove = (e: ReactMouseEvent<SVGSVGElement>) => {
    if (data.length === 0) return;
    const rect = viewportBox(e.currentTarget);
    if (data.length === 1) {
      setHoverIdx(0);
      return;
    }
    setHoverIdx(nearestPoint(e.clientX / viewportScale() - rect.left, data.length, 0, rect.width || 1));
  };

  const activePoint = hoverIdx !== null ? points[hoverIdx] : undefined;
  const lastPoint = points[points.length - 1];
  const isSinglePoint = points.length === 1;

  return (
    <span
      ref={ref}
      role={label ? 'group' : undefined}
      aria-label={label}
      className={cx('spark-host kit-spark nx-sparkline', className)}
      style={{ width, height }}
    >
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={resolvedSvgAriaLabel}
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        {fill && areaPath && (
          <defs>
            <linearGradient id={`nx-spark-${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.28} />
              <stop offset="100%" stopColor={color} stopOpacity={0.0} />
            </linearGradient>
          </defs>
        )}
        {fill && areaPath && <path d={areaPath} fill={`url(#nx-spark-${uid})`} />}
        {linePath && (
          <path
            d={linePath}
            fill="none"
            stroke={color}
            strokeWidth={1.75}
            strokeOpacity={isSinglePoint ? 0.35 : undefined}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {(showEndDot || isSinglePoint) && lastPoint && hoverIdx === null && (
          <circle cx={lastPoint.x} cy={lastPoint.y} r={isSinglePoint ? 2.75 : 2.25} fill={color} />
        )}
        {activePoint && (
          <>
            <line
              x1={activePoint.x}
              y1={1}
              x2={activePoint.x}
              y2={height - 1}
              stroke="var(--line-strong)"
              strokeDasharray="2 2"
              strokeWidth={1}
            />
            <circle cx={activePoint.x} cy={activePoint.y} r={3} fill={color} stroke="var(--surface)" strokeWidth={1.5} />
          </>
        )}
      </svg>
      {hoverIdx !== null && data[hoverIdx] !== undefined && activePoint && (
        <span className="nx-sparkline-readout" style={{ left: `${(activePoint.x / width) * 100}%` }}>
          {formatValue(data[hoverIdx]!)}
        </span>
      )}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* 2. AreaChart & LineChart                                                   */
/* -------------------------------------------------------------------------- */

/** Base props shared across cartesian SVG charts (`AreaChart`, `LineChart`, `BarChart`, `StackedBarChart`). */
export interface CartesianChartBaseProps {
  data: ReadonlyArray<Record<string, string | number>>;
  xKey: string;
  series: ReadonlyArray<ChartSeries>;
  height?: number;
  showGrid?: boolean;
  showLegend?: boolean;
  locale?: string;
  ariaLabel?: string;
  seriesLabel?: string;
  totalLabel?: string;
  /** Said in the tooltip and the screen-reader table where a row has no reading for a series. Defaults to "No data". */
  missingLabel?: string;
  formatValue?: (v: number) => string;
  formatX?: (v: string | number) => string;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

/** Props for the `AreaChart` component. */
export interface AreaChartProps extends CartesianChartBaseProps {
  curve?: 'smooth' | 'linear';
  stacked?: boolean;
  showDots?: boolean;
}

/** Props for the `LineChart` component. */
export interface LineChartProps extends CartesianChartBaseProps {
  curve?: 'smooth' | 'linear';
  showDots?: boolean;
}

interface SeriesPath {
  series: ChartSeries & { color: string };
  topPoints: Array<Point | null>;
  lines: string[];
  areas: string[];
  lonePoints: Point[];
}

function CartesianLineOrArea({
  mode,
  data = [],
  xKey,
  series = [],
  height = 240,
  curve = 'smooth',
  stacked = false,
  showGrid = true,
  showLegend = true,
  showDots = false,
  locale,
  ariaLabel,
  seriesLabel = 'Chart series',
  missingLabel = 'No data',
  formatValue: explicitFormatValue,
  formatX = String,
  className,
  ref: externalRef,
}: AreaChartProps & { mode: 'area' | 'line' }) {
  const formatValue = useMemo(() => explicitFormatValue ?? ((v: number) => formatChartNumber(v, locale)), [explicitFormatValue, locale]);
  const uid = safeSvgId(useId());
  const { ref, width } = useContainerWidth(560);
  const setHostRef = useCallback(
    (node: HTMLDivElement | null) => {
      ref.current = node;
      if (typeof externalRef === 'function') externalRef(node);
      else if (externalRef) (externalRef as { current: HTMLDivElement | null }).current = node;
    },
    [externalRef, ref],
  );
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(() => new Set());

  const toggleKey = (key: string) => {
    setHiddenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else if (next.size < series.length - 1) next.add(key);
      return next;
    });
  };

  const visibleSeries = useMemo(
    () => series.map((s, idx) => ({ ...s, color: chartColorAt(idx, s.color) })).filter((s) => !hiddenKeys.has(s.key)),
    [series, hiddenKeys],
  );

  /* The value scale is worked out before the plot's box: the left gutter is as wide as the scale's own labels
     (chartShared.tsx), and the box is what is left. */
  const yScale = useMemo(() => {
    if (data.length === 0 || visibleSeries.length === 0) return null;

    /* Stacked, the figures are each row's sums above and below the zero line; otherwise every reading. An absent
       reading is in neither. */
    const readings = data.map((row) => visibleSeries.map((s) => readChartValue(row[s.key]).value));
    const figures =
      mode === 'area' && stacked
        ? stackExtent(readings)
        : extentOf(
            readings.flat().filter((value): value is number => value !== null),
            0,
            0,
          );
    const scale = valueScale(figures, { intervals: 4 });
    return { yTicks: scale.levels, yMin: scale.min, yMax: scale.max, ySpan: scale.span };
  }, [data, visibleSeries, mode, stacked]);

  const valueGutter = useMemo(
    () => pageValueGutter(yScale?.yTicks ?? [0, 5, 10], formatValue, width, locale),
    [yScale, formatValue, width, locale],
  );
  const padLeft = valueGutter.pad;
  const padRight = 16;
  const padTop = 14;
  const padBottom = 28;
  const plotW = Math.max(40, width - padLeft - padRight);
  const plotH = Math.max(40, height - padTop - padBottom);

  const geometry = useMemo(() => {
    if (!yScale) {
      return {
        yMin: 0,
        yMax: 10,
        ySpan: 10,
        yTicks: [0, 5, 10],
        zeroY: padTop + plotH,
        hasZeroTick: true,
        paths: [] as SeriesPath[],
        xPositions: [] as number[],
      };
    }

    const { yTicks, yMin, yMax, ySpan } = yScale;
    const xPositions = data.map((_, i) => pointAlong(i, data.length, padLeft, plotW));

    const yAt = (v: number) => padTop + plotH - ((v - yMin) / ySpan) * plotH;
    const zeroY = yAt(0);
    const hasZeroTick = yTicks.some((t) => Math.abs(t) < 1e-9);
    const posRunning = Array.from({ length: data.length }, () => 0);
    const negRunning = Array.from({ length: data.length }, () => 0);

    const paths: SeriesPath[] = visibleSeries.map((s) => {
      /* A row with no reading for this series is a hole in it: the stroke stops at the point before and starts
         again at the point after. Plotted as 0 it drew a dive to the baseline that no one measured. In a stack the
         hole adds nothing to the running total, so the series above keep their own heights. */
      const topPoints: Array<Point | null> = [];
      const basePoints: Array<Point | null> = [];
      data.forEach((row, idx) => {
        const val = readChartValue(row[s.key]).value;
        if (val === null) {
          topPoints.push(null);
          basePoints.push(null);
          return;
        }
        let base = 0;
        if (mode === 'area' && stacked) {
          const running = val >= 0 ? posRunning : negRunning;
          base = running[idx]!;
          running[idx] = base + val;
        }
        topPoints.push({ x: xPositions[idx]!, y: yAt(base + val) });
        basePoints.push({ x: xPositions[idx]!, y: yAt(base) });
      });

      const lines: string[] = [];
      const areas: string[] = [];
      const lonePoints: Point[] = [];
      let start = 0;
      while (start < topPoints.length) {
        if (!topPoints[start]) {
          start++;
          continue;
        }
        let end = start;
        while (end + 1 < topPoints.length && topPoints[end + 1]) end++;
        const runTop = topPoints.slice(start, end + 1) as Point[];
        if (runTop.length === 1) {
          lonePoints.push(runTop[0]!);
        } else {
          const line = buildLinePath(runTop, curve);
          lines.push(line);
          if (mode === 'area') {
            if (stacked) {
              const revBase = (basePoints.slice(start, end + 1) as Point[]).reverse();
              areas.push(`${line} ${buildLinePath(revBase, curve).replace(/^M/, 'L')} Z`);
            } else {
              const first = runTop[0]!;
              const last = runTop[runTop.length - 1]!;
              areas.push(areaUnder(line, first.x, last.x, zeroY));
            }
          }
        }
        start = end + 1;
      }

      return { series: s, topPoints, lines, areas, lonePoints };
    });

    return { yMin, yMax, ySpan, yTicks, zeroY, hasZeroTick, paths, xPositions };
  }, [data, visibleSeries, yScale, mode, stacked, padLeft, plotW, plotH, curve]);

  const handlePointerMove = (e: ReactMouseEvent<SVGSVGElement>) => {
    if (data.length === 0) return;
    if (data.length === 1) {
      setHoverIdx(0);
      return;
    }
    const rect = viewportBox(e.currentTarget);
    setHoverIdx(nearestPoint(e.clientX / viewportScale() - rect.left, data.length, padLeft, plotW));
  };

  const formattedXLabels = useMemo(() => data.map((row) => formatX(row[xKey] ?? '')), [data, formatX, xKey]);
  const xLabelPicks = useMemo(
    () => pickAxisLabels(formattedXLabels, (i) => pointAlong(i, formattedXLabels.length, padLeft, plotW), padLeft - 8, padLeft + plotW + 8),
    [formattedXLabels, plotW],
  );

  const { focused, stepProps } = useChartStepping(data.length, setHoverIdx);
  const sayReading = (reading: ChartReading) =>
    reading.value === null
      ? missingLabel
      : reading.exact !== undefined
        ? formatExactNumeric(reading.exact, locale)
        : formatValue(reading.value);

  const hoverX = hoverIdx !== null ? geometry.xPositions[hoverIdx] : undefined;
  const hoverRow = hoverIdx !== null ? data[hoverIdx] : undefined;
  const flipTooltip = hoverX !== undefined && hoverX > padLeft + plotW * 0.62;
  return (
    <div ref={setHostRef} className={cx('nx-chart', className)}>
      {showLegend && series.length > 1 && (
        <SeriesLegend series={[...series]} hiddenKeys={hiddenKeys} onToggle={toggleKey} ariaLabel={seriesLabel} />
      )}
      <div className="nx-chart-stage" style={{ height }}>
        {/* The name is said once, on the picture: the host div carried it too, role-less, where it names nothing. */}
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={ariaLabel ?? series.map((s) => s.label).join(', ')}
          className="nx-chart-svg nx-focusable"
          onMouseMove={handlePointerMove}
          onMouseLeave={() => setHoverIdx(null)}
          {...stepProps}
        >
          {mode === 'area' && (
            <defs>
              {geometry.paths.map(({ series: s }) => (
                <linearGradient key={s.key} id={`nx-area-${uid}-${safeSvgId(s.key)}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={s.color} stopOpacity={stacked ? 0.34 : 0.24} />
                  <stop offset="100%" stopColor={s.color} stopOpacity={stacked ? 0.08 : 0.01} />
                </linearGradient>
              ))}
            </defs>
          )}

          {/* Horizontal Grid & Y-Axis Labels */}
          {geometry.yTicks.map((tick) => {
            const y = padTop + plotH - ((tick - geometry.yMin) / geometry.ySpan) * plotH;
            return (
              <g key={tick}>
                {showGrid && (
                  <line
                    x1={padLeft}
                    y1={y}
                    x2={padLeft + plotW}
                    y2={y}
                    className="nx-chart-gridline"
                    strokeDasharray={Math.abs(tick) < 1e-9 ? undefined : '3 3'}
                  />
                )}
                <text x={padLeft - 8} y={y + 3.5} textAnchor="end" className="nx-chart-axis-text">
                  {valueGutter.say(tick)}
                </text>
              </g>
            );
          })}

          {/* Explicit Zero Baseline when domain spans negative & positive without a 0 tick */}
          {geometry.yMin < 0 && geometry.yMax > 0 && !geometry.hasZeroTick && (
            <line x1={padLeft} y1={geometry.zeroY} x2={padLeft + plotW} y2={geometry.zeroY} className="nx-chart-gridline" />
          )}

          {/* X-Axis Labels */}
          {xLabelPicks.map(({ index, anchor }) => (
            <text key={index} x={geometry.xPositions[index] ?? padLeft} y={height - 6} textAnchor={anchor} className="nx-chart-axis-text">
              {formattedXLabels[index]}
            </text>
          ))}

          {/* Area Fills */}
          {mode === 'area' &&
            geometry.paths.flatMap(({ series: s, areas }) =>
              areas.map((area, aIdx) => (
                <path key={`area-${s.key}-${aIdx}`} className="nx-chart-area" d={area} fill={`url(#nx-area-${uid}-${safeSvgId(s.key)})`} />
              )),
            )}

          {/* Series Strokes, Optional Dots & Points Standing Alone Between Gaps */}
          {geometry.paths.map(({ series: s, lines, topPoints, lonePoints }) => (
            <g key={`line-${s.key}`}>
              {lines.map((line, lIdx) => (
                <path
                  key={lIdx}
                  className="nx-chart-stroke"
                  d={line}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
              {showDots
                ? topPoints.map((pt, pIdx) =>
                    pt ? (
                      <circle
                        key={pIdx}
                        className="nx-chart-dot"
                        cx={pt.x}
                        cy={pt.y}
                        r={2.5}
                        fill="var(--surface)"
                        stroke={s.color}
                        strokeWidth={1.75}
                      />
                    ) : null,
                  )
                : lonePoints.map((pt, pIdx) => (
                    <circle key={pIdx} cx={pt.x} cy={pt.y} r={3.5} fill={s.color} stroke="var(--surface)" strokeWidth={1.75} />
                  ))}
            </g>
          ))}

          {/* Interactive Crosshair & Active Markers */}
          {hoverIdx !== null && hoverX !== undefined && (
            <g className="nx-chart-crosshair">
              <line
                x1={hoverX}
                y1={padTop}
                x2={hoverX}
                y2={padTop + plotH}
                stroke="var(--line-strong)"
                strokeDasharray="3 3"
                strokeWidth={1}
              />
              {geometry.paths.map(({ series: s, topPoints }) => {
                const pt = topPoints[hoverIdx];
                if (!pt) return null;
                return (
                  <g key={`hover-${s.key}`}>
                    <circle cx={pt.x} cy={pt.y} r={6} fill={s.color} fillOpacity={0.18} />
                    <circle cx={pt.x} cy={pt.y} r={3.5} fill={s.color} stroke="var(--surface)" strokeWidth={1.75} />
                  </g>
                );
              })}
            </g>
          )}
        </svg>

        {hoverIdx !== null && hoverRow && hoverX !== undefined && (
          <div
            className="nx-chart-tooltip"
            data-flip={flipTooltip ? '' : undefined}
            style={{
              left: flipTooltip ? undefined : Math.min(width - 170, hoverX + 12),
              right: flipTooltip ? Math.max(8, width - hoverX + 12) : undefined,
              top: padTop + 4,
            }}
          >
            <div className="nx-chart-tooltip-title">{formatX(hoverRow[xKey] ?? '')}</div>
            <div className="nx-chart-tooltip-rows">
              {visibleSeries.map((s) => {
                const reading = readChartValue(hoverRow[s.key]);
                return (
                  <div key={s.key} className="nx-chart-tooltip-row">
                    <span className="nx-chart-tooltip-key">
                      <span className="nx-chart-swatch" style={{ background: s.color }} />
                      <span>{s.label}</span>
                    </span>
                    <span className="nx-chart-tooltip-val">{sayReading(reading)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
      <ChartLiveReadout
        text={
          focused && hoverRow
            ? `${formatX(hoverRow[xKey] ?? '')}: ${visibleSeries.map((s) => `${s.label} ${sayReading(readChartValue(hoverRow[s.key]))}`).join(', ')}`
            : ''
        }
      />
      <ChartAccessibleTable
        headers={[xKey, ...visibleSeries.map((s) => s.label)]}
        rows={data.map((row) => [formatX(row[xKey] ?? ''), ...visibleSeries.map((s) => sayReading(readChartValue(row[s.key])))])}
      />
    </div>
  );
}

/** Responsive SVG area chart supporting stacked series, smooth splines, interactive tooltips, and accessible table output. */
export function AreaChart(props: AreaChartProps) {
  return <CartesianLineOrArea {...props} mode="area" />;
}

/** Responsive SVG line chart supporting multi-series toggles, smooth splines, interactive crosshairs, and accessible table output. */
export function LineChart(props: LineChartProps) {
  return <CartesianLineOrArea {...props} mode="line" />;
}
