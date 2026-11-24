/** Responsive SVG bar, stacked-bar, mini-bar, donut, breakdown, and funnel charts. */
import { type CSSProperties, type ReactNode, type Ref, useCallback, useId, useMemo, useState } from 'react';
import { cx, isEmptyStateSpec, toDataTone, toKitTone, type EmptyStateSpec, type Tone } from '../internal/cx.js';
import { resolveLocale } from '../internal/locale.js';
import { useSurfaceSeam } from '../internal/surfaceSeam.js';
import { formatChartNumber, formatExactNumeric, readChartValue, type ChartReading } from './chartFormat.js';
import { donutArcs } from './chartPath.js';
import { AXIS_CHAR_PX, bandsAlong, barSpan, estimateTextWidth, extentOf, stackExtent, valueScale } from './chartScale.js';
import {
  ChartAccessibleTable,
  ChartLiveReadout,
  SR_ONLY_STYLE,
  SeriesLegend,
  chartColorAt,
  pageValueGutter,
  pickAxisLabels,
  toneColor,
  useChartStepping,
  useContainerWidth,
} from './chartShared.js';
import type { CartesianChartBaseProps } from './charts.js';

function roundedTopRectPath(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0 || w <= 0) return '';
  const radius = Math.min(r, w / 2, h / 2);
  return [
    `M ${x} ${y + h}`,
    `L ${x} ${y + radius}`,
    `Q ${x} ${y} ${x + radius} ${y}`,
    `L ${x + w - radius} ${y}`,
    `Q ${x + w} ${y} ${x + w} ${y + radius}`,
    `L ${x + w} ${y + h}`,
    'Z',
  ].join(' ');
}

function roundedBottomRectPath(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0 || w <= 0) return '';
  const radius = Math.min(r, w / 2, h / 2);
  return [
    `M ${x} ${y}`,
    `L ${x + w} ${y}`,
    `L ${x + w} ${y + h - radius}`,
    `Q ${x + w} ${y + h} ${x + w - radius} ${y + h}`,
    `L ${x + radius} ${y + h}`,
    `Q ${x} ${y + h} ${x} ${y + h - radius}`,
    'Z',
  ].join(' ');
}

function roundedRightRectPath(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0 || w <= 0) return '';
  const radius = Math.min(r, w / 2, h / 2);
  return [
    `M ${x} ${y}`,
    `L ${x + w - radius} ${y}`,
    `Q ${x + w} ${y} ${x + w} ${y + radius}`,
    `L ${x + w} ${y + h - radius}`,
    `Q ${x + w} ${y + h} ${x + w - radius} ${y + h}`,
    `L ${x} ${y + h}`,
    'Z',
  ].join(' ');
}

function roundedLeftRectPath(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0 || w <= 0) return '';
  const radius = Math.min(r, w / 2, h / 2);
  return [
    `M ${x + w} ${y}`,
    `L ${x + radius} ${y}`,
    `Q ${x} ${y} ${x} ${y + radius}`,
    `L ${x} ${y + h - radius}`,
    `Q ${x} ${y + h} ${x + radius} ${y + h}`,
    `L ${x + w} ${y + h}`,
    'Z',
  ].join(' ');
}

function truncateSvgLabel(text: string, maxChars: number): string {
  if (maxChars <= 1 || text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

type BreakdownPreset = 'number' | 'money' | 'percent';

function formatBreakdownPreset(
  value: number,
  preset: BreakdownPreset,
  locale: string | undefined,
  currency: string,
  seamPreset?: (value: number, preset: BreakdownPreset, locale?: string) => string,
): string {
  if (seamPreset) return seamPreset(value, preset, locale);
  const tag = resolveLocale(locale);
  if (!Number.isFinite(value)) return '0';
  if (preset === 'money') {
    return new Intl.NumberFormat(tag, {
      style: 'currency',
      currency,
      minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(value);
  }
  if (preset === 'percent') {
    return `${new Intl.NumberFormat(tag, { maximumFractionDigits: 1 }).format(value)}%`;
  }
  return new Intl.NumberFormat(tag, { maximumFractionDigits: 2 }).format(value);
}

/* A value given as a string is formatted as the same number would be: the caller's `formatValue`, then `say`, then
   the preset through the host's formatter. Strings used to take a path of their own that skipped all three, printed
   `format: 'percent'` without its sign and money in dollars whatever the App's currency. Only digits a double would
   round stay off that path, because every formatter above takes a `number`: those are said by Intl from the string
   itself, in the preset's shape and the list's `currency`, so the figure printed is the figure given. */
function formatBreakdownItemValue(
  raw: number | string,
  locale: string | undefined,
  format: BreakdownPreset | undefined,
  currency: string,
  explicitFormatValue?: (v: number) => string,
  legacySay?: (v: number) => string,
  seamPreset?: (value: number, preset: BreakdownPreset, locale?: string) => string,
): string {
  let value: number;
  if (typeof raw === 'string') {
    const reading = readChartValue(raw);
    if (reading.value === null) return raw.trim() || '0';
    if (reading.exact !== undefined) {
      if (format === 'money') {
        return formatExactNumeric(reading.exact, locale, {
          style: 'currency',
          currency,
          minimumFractionDigits: reading.exact.includes('.') ? 2 : 0,
          maximumFractionDigits: 2,
        });
      }
      if (format === 'percent') return `${formatExactNumeric(reading.exact, locale, { maximumFractionDigits: 1 })}%`;
      return formatExactNumeric(reading.exact, locale, { maximumFractionDigits: 2 });
    }
    value = reading.value;
  } else {
    value = raw;
  }
  if (explicitFormatValue) return explicitFormatValue(value);
  if (legacySay) return legacySay(value);
  if (format) return formatBreakdownPreset(value, format, locale, currency, seamPreset);
  return formatChartNumber(value, locale);
}

/* -------------------------------------------------------------------------- */
/* 3. BarChart, StackedBarChart & MiniBars                                    */
/* -------------------------------------------------------------------------- */

/** Props for the `BarChart` component. */
export interface BarChartProps extends CartesianChartBaseProps {
  orientation?: 'vertical' | 'horizontal';
}

/** Props for the `StackedBarChart` component. */
export interface StackedBarChartProps extends CartesianChartBaseProps {
  orientation?: 'vertical' | 'horizontal';
}

function BarVisualization({
  stacked,
  orientation = 'vertical',
  data = [],
  xKey,
  series = [],
  height = 240,
  showGrid = true,
  showLegend = true,
  locale,
  ariaLabel,
  seriesLabel = 'Chart series',
  totalLabel = 'Total',
  missingLabel = 'No data',
  formatValue: explicitFormatValue,
  formatX = String,
  className,
  ref: externalRef,
}: BarChartProps & { stacked: boolean }) {
  const formatValue = useMemo(() => explicitFormatValue ?? ((v: number) => formatChartNumber(v, locale)), [explicitFormatValue, locale]);
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

  const isHorizontal = orientation === 'horizontal';

  const { minBound, maxBound, spanBound, ticks, hasZeroTick } = useMemo(() => {
    /* Stacked, the figures are each row's sums above and below the zero line; otherwise every reading. An absent
       reading is in neither. */
    const readings = data.map((row) => visibleSeries.map((s) => readChartValue(row[s.key]).value));
    const figures = stacked
      ? stackExtent(readings)
      : extentOf(
          readings.flat().filter((value): value is number => value !== null),
          0,
          0,
        );
    const scale = valueScale(figures, { intervals: 4 });
    return {
      minBound: scale.min,
      maxBound: scale.max,
      spanBound: scale.span,
      ticks: scale.levels,
      hasZeroTick: scale.levels.some((t) => Math.abs(t) < 1e-9),
    };
  }, [data, visibleSeries, stacked]);

  /* Upright, the value axis is on the left and its gutter is as wide as its labels (chartShared.tsx). */
  const valueGutter = useMemo(() => pageValueGutter(ticks, formatValue, width, locale), [ticks, formatValue, width, locale]);
  const padLeft = isHorizontal ? 96 : valueGutter.pad;
  const padRight = 18;
  const padTop = 14;
  const padBottom = 28;
  const plotW = Math.max(40, width - padLeft - padRight);
  const plotH = Math.max(40, height - padTop - padBottom);

  const bands = bandsAlong(data.length, isHorizontal ? padTop : padLeft, isHorizontal ? plotH : plotW, { share: 0.68 });
  const bandSpan = bands.band;
  const bandInner = bands.bar;
  const bandPad = (bandSpan - bandInner) / 2;

  const yAt = (v: number) => padTop + plotH - ((v - minBound) / spanBound) * plotH;
  const xAt = (v: number) => padLeft + ((v - minBound) / spanBound) * plotW;
  const zeroY = yAt(0);
  const zeroX = xAt(0);

  const formattedCats = useMemo(() => data.map((row) => formatX(row[xKey] ?? '')), [data, formatX, xKey]);
  /* Vertical bars label the bands that have room, chosen from each name's own width. A name longer than half the
     plot is cut to that first, so one long category cannot leave the axis with a single label. */
  const maxVertChars = Math.max(4, Math.floor(plotW / 2 / estimateTextWidth('0', AXIS_CHAR_PX.page)));
  const vertLabels = useMemo(() => {
    const picked = new Map<number, string>();
    if (isHorizontal) return picked;
    const cut = formattedCats.map((label) => truncateSvgLabel(label, maxVertChars));
    for (const { index } of pickAxisLabels(cut, bands.mid, 0, width)) picked.set(index, cut[index]!);
    return picked;
  }, [bandSpan, formattedCats, isHorizontal, maxVertChars, padLeft, width]);

  const hoverRow = hoverIdx !== null ? data[hoverIdx] : undefined;
  const { focused, stepProps } = useChartStepping(data.length, setHoverIdx);
  const sayReading = (reading: ChartReading) =>
    reading.value === null
      ? missingLabel
      : reading.exact !== undefined
        ? formatExactNumeric(reading.exact, locale)
        : formatValue(reading.value);

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
          onMouseLeave={() => setHoverIdx(null)}
          {...stepProps}
        >
          {/* Gridlines & Value Axis */}
          {ticks.map((tick) => {
            const isZero = Math.abs(tick) < 1e-9;
            if (isHorizontal) {
              const x = xAt(tick);
              return (
                <g key={tick}>
                  {showGrid && (
                    <line
                      x1={x}
                      y1={padTop}
                      x2={x}
                      y2={padTop + plotH}
                      className="nx-chart-gridline"
                      strokeDasharray={isZero ? undefined : '3 3'}
                    />
                  )}
                  <text x={x} y={height - 6} textAnchor="middle" className="nx-chart-axis-text">
                    {formatValue(tick)}
                  </text>
                </g>
              );
            }
            const y = yAt(tick);
            return (
              <g key={tick}>
                {showGrid && (
                  <line
                    x1={padLeft}
                    y1={y}
                    x2={padLeft + plotW}
                    y2={y}
                    className="nx-chart-gridline"
                    strokeDasharray={isZero ? undefined : '3 3'}
                  />
                )}
                <text x={padLeft - 8} y={y + 3.5} textAnchor="end" className="nx-chart-axis-text">
                  {valueGutter.say(tick)}
                </text>
              </g>
            );
          })}

          {/* Explicit Zero Baseline when domain spans negative & positive without a 0 tick */}
          {minBound < 0 &&
            maxBound > 0 &&
            !hasZeroTick &&
            (isHorizontal ? (
              <line x1={zeroX} y1={padTop} x2={zeroX} y2={padTop + plotH} className="nx-chart-gridline" />
            ) : (
              <line x1={padLeft} y1={zeroY} x2={padLeft + plotW} y2={zeroY} className="nx-chart-gridline" />
            ))}

          {/* Bands & Bars */}
          {data.map((row, rIdx) => {
            const bandStart = (isHorizontal ? padTop : padLeft) + rIdx * bandSpan;
            const isHovered = hoverIdx === rIdx;
            const catLabel = formattedCats[rIdx] ?? '';
            const maxHorizChars = Math.max(4, Math.floor((padLeft - 12) / 6.8));
            const vertLabel = vertLabels.get(rIdx);

            return (
              <g key={rIdx} onMouseEnter={() => setHoverIdx(rIdx)} className="nx-chart-bar-group">
                {/* Hover Band */}
                <rect
                  x={isHorizontal ? padLeft : bandStart}
                  y={isHorizontal ? bandStart : padTop}
                  width={isHorizontal ? plotW : bandSpan}
                  height={isHorizontal ? bandSpan : plotH}
                  fill={isHovered ? 'color-mix(in oklab, var(--ink) 5%, var(--surface))' : 'transparent'}
                  rx={4}
                />

                {/* Category Label */}
                {isHorizontal ? (
                  <text x={padLeft - 8} y={bandStart + bandSpan / 2 + 4} textAnchor="end" className="nx-chart-axis-text">
                    {catLabel.length > maxHorizChars ? <title>{catLabel}</title> : null}
                    {truncateSvgLabel(catLabel, maxHorizChars)}
                  </text>
                ) : vertLabel !== undefined ? (
                  <text x={bandStart + bandSpan / 2} y={height - 6} textAnchor="middle" className="nx-chart-axis-text">
                    {vertLabel !== catLabel ? <title>{catLabel}</title> : null}
                    {vertLabel}
                  </text>
                ) : null}

                {/* Bars */}
                {(() => {
                  if (stacked) {
                    let posAcc = 0;
                    let negAcc = 0;
                    const posKeys = visibleSeries.filter((s) => (readChartValue(row[s.key]).value ?? 0) > 0);
                    const negKeys = visibleSeries.filter((s) => (readChartValue(row[s.key]).value ?? 0) < 0);
                    const topPosKey = posKeys[posKeys.length - 1]?.key;
                    const bottomNegKey = negKeys[negKeys.length - 1]?.key;

                    return visibleSeries.map((s) => {
                      /* No reading draws no bar, as a zero does; the tooltip and the table say which it was. */
                      const val = readChartValue(row[s.key]).value ?? 0;
                      if (val === 0) return null;

                      if (val > 0) {
                        const isOuter = s.key === topPosKey;
                        if (isHorizontal) {
                          const x = xAt(posAcc);
                          const w = xAt(posAcc + val) - x;
                          const y = bandStart + bandPad;
                          posAcc += val;
                          return isOuter ? (
                            <path
                              key={s.key}
                              d={roundedRightRectPath(x, y, w, bandInner, 4)}
                              fill={s.color}
                              opacity={hoverIdx === null || isHovered ? 1 : 0.72}
                            />
                          ) : (
                            <rect
                              key={s.key}
                              x={x}
                              y={y}
                              width={Math.max(0, w - 0.5)}
                              height={bandInner}
                              fill={s.color}
                              opacity={hoverIdx === null || isHovered ? 1 : 0.72}
                            />
                          );
                        }
                        const y = yAt(posAcc + val);
                        const barH = yAt(posAcc) - y;
                        const x = bandStart + bandPad;
                        posAcc += val;
                        return isOuter ? (
                          <path
                            key={s.key}
                            d={roundedTopRectPath(x, y, bandInner, barH, 4)}
                            fill={s.color}
                            opacity={hoverIdx === null || isHovered ? 1 : 0.72}
                          />
                        ) : (
                          <rect
                            key={s.key}
                            x={x}
                            y={y}
                            width={bandInner}
                            height={Math.max(0, barH - 0.5)}
                            fill={s.color}
                            opacity={hoverIdx === null || isHovered ? 1 : 0.72}
                          />
                        );
                      }

                      const isOuterNeg = s.key === bottomNegKey;
                      if (isHorizontal) {
                        const x = xAt(negAcc + val);
                        const w = xAt(negAcc) - x;
                        const y = bandStart + bandPad;
                        negAcc += val;
                        return isOuterNeg ? (
                          <path
                            key={s.key}
                            d={roundedLeftRectPath(x, y, w, bandInner, 4)}
                            fill={s.color}
                            opacity={hoverIdx === null || isHovered ? 1 : 0.72}
                          />
                        ) : (
                          <rect
                            key={s.key}
                            x={x}
                            y={y}
                            width={Math.max(0, w - 0.5)}
                            height={bandInner}
                            fill={s.color}
                            opacity={hoverIdx === null || isHovered ? 1 : 0.72}
                          />
                        );
                      }
                      const y = yAt(negAcc);
                      const barH = yAt(negAcc + val) - y;
                      const x = bandStart + bandPad;
                      negAcc += val;
                      return isOuterNeg ? (
                        <path
                          key={s.key}
                          d={roundedBottomRectPath(x, y, bandInner, barH, 4)}
                          fill={s.color}
                          opacity={hoverIdx === null || isHovered ? 1 : 0.72}
                        />
                      ) : (
                        <rect
                          key={s.key}
                          x={x}
                          y={y}
                          width={bandInner}
                          height={Math.max(0, barH - 0.5)}
                          fill={s.color}
                          opacity={hoverIdx === null || isHovered ? 1 : 0.72}
                        />
                      );
                    });
                  }

                  const groupCount = Math.max(1, visibleSeries.length);
                  const gap = groupCount > 1 ? 3 : 0;
                  const singleSpan = Math.max(2, (bandInner - gap * (groupCount - 1)) / groupCount);

                  return visibleSeries.map((s, sIdx) => {
                    const val = readChartValue(row[s.key]).value ?? 0;
                    if (val === 0) return null;
                    const offset = bandStart + bandPad + sIdx * (singleSpan + gap);
                    /* Every bar has one edge on the zero line, whichever side its value is on (chartScale.ts). */
                    const { start, length } = isHorizontal ? barSpan(xAt(val), zeroX) : barSpan(yAt(val), zeroY);
                    const shape = isHorizontal
                      ? (val > 0 ? roundedRightRectPath : roundedLeftRectPath)(start, offset, length, singleSpan, 4)
                      : (val > 0 ? roundedTopRectPath : roundedBottomRectPath)(offset, start, singleSpan, length, 4);
                    return <path key={s.key} d={shape} fill={s.color} opacity={hoverIdx === null || isHovered ? 1 : 0.72} />;
                  });
                })()}
              </g>
            );
          })}
        </svg>

        {hoverIdx !== null && hoverRow && (
          <div
            className="nx-chart-tooltip"
            style={{
              right: 14,
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
              {stacked && visibleSeries.length > 1 && (
                <div className="nx-chart-tooltip-row nx-chart-tooltip-total">
                  <span>{totalLabel}</span>
                  <span className="nx-chart-tooltip-val">
                    {formatValue(visibleSeries.reduce((sum, s) => sum + (readChartValue(hoverRow[s.key]).value ?? 0), 0))}
                  </span>
                </div>
              )}
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

/** Responsive grouped SVG bar chart supporting vertical and horizontal orientations, negative values, and accessible table output. */
export function BarChart(props: BarChartProps) {
  return <BarVisualization {...props} stacked={false} />;
}

/** Responsive stacked SVG bar chart supporting vertical and horizontal orientations, negative values, and total tooltips. */
export function StackedBarChart(props: StackedBarChartProps) {
  return <BarVisualization {...props} stacked />;
}

/** Single datum entry in `MiniBars`. */
export interface MiniBarDatum {
  label?: string;
  value: number;
  tone?: Tone;
}

/** Props for the `MiniBars` component. */
export interface MiniBarsProps {
  data: ReadonlyArray<number | MiniBarDatum>;
  /** Optional category labels read out in the screen-reader table. */
  labels?: ReadonlyArray<string>;
  /** Zero-based bar index highlighted in full ink while siblings render quieter. */
  highlight?: number;
  /** Accessible group name announced for the bar strip. */
  label?: string;
  ariaLabel?: string;
  width?: number;
  height?: number;
  tone?: Tone;
  locale?: string;
  formatValue?: (v: number) => string;
  className?: string;
  ref?: Ref<HTMLSpanElement>;
}

/** Compact inline column bar strip with optional highlight index and screen-reader value table. */
export function MiniBars(props: MiniBarsProps) {
  const {
    data,
    labels,
    highlight,
    label,
    ariaLabel,
    width,
    height = 28,
    tone,
    locale,
    formatValue: explicitFormatValue,
    className,
    ref,
  } = props;
  const legacyProps = props as unknown as {
    'aria-label'?: string;
    say?: (value: unknown) => string;
  };
  const legacySay = legacyProps.say;
  const resolvedGroupLabel = ariaLabel ?? legacyProps['aria-label'] ?? label;
  const formatHover = useMemo(
    () => explicitFormatValue ?? (legacySay ? (v: number) => legacySay(v) : (v: number) => formatChartNumber(v, locale)),
    [explicitFormatValue, legacySay, locale],
  );
  const formatCell = explicitFormatValue ?? (legacySay ? (v: number) => legacySay(v) : String);

  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const items: MiniBarDatum[] = useMemo(() => data.map((d) => (typeof d === 'number' ? { value: d } : d)), [data]);
  const vals = useMemo(() => items.map((d) => (Number.isFinite(d.value) ? d.value : 0)), [items]);
  const { min: minVal, max: maxVal } = extentOf(vals, 0, 0);
  const hasNegative = minVal < 0;
  const span = maxVal - minVal || 1;
  const zeroBottomPct = hasNegative ? (-minVal / span) * 100 : 0;
  const count = Math.max(1, items.length);
  const hovered = hoverIdx !== null ? items[hoverIdx] : undefined;

  return (
    <span
      ref={ref}
      role="group"
      aria-label={resolvedGroupLabel}
      className={cx('kit-minibars', className)}
      style={width !== undefined ? { width } : undefined}
      onMouseLeave={() => setHoverIdx(null)}
    >
      <span
        className="kit-minibars-bars"
        aria-hidden="true"
        data-signed={hasNegative ? '' : undefined}
        style={height !== 28 ? { height } : undefined}
      >
        {hasNegative && <span className="kit-minibars-zero" style={{ bottom: `${zeroBottomPct}%` }} />}
        {items.map((item, idx) => {
          const val = Number.isFinite(item.value) ? item.value : 0;
          const isLit = highlight === undefined || highlight === idx;
          const barTone = item.tone ?? tone;
          const explicitBg =
            barTone !== undefined && barTone !== 'accent'
              ? isLit
                ? toneColor(barTone)
                : `color-mix(in srgb, ${toneColor(barTone)} 35%, transparent)`
              : undefined;

          if (!hasNegative) {
            const pct = maxVal > 0 ? Math.max(4, Math.round((Math.max(val, 0) / maxVal) * 100)) : 4;
            return (
              <i
                key={idx}
                className={isLit ? 'is-lit' : undefined}
                style={{
                  height: `${pct}%`,
                  ...(explicitBg ? { background: explicitBg } : {}),
                }}
                onMouseEnter={() => setHoverIdx(idx)}
              />
            );
          }

          /* Each bar is placed from the zero line in shares of the strip's height. `top` and `height` on a
             relatively placed box resolve against that height; the percentage margins used before resolve against
             the container's width, which threw the bars clear of the zero line and out of the strip. */
          const zeroTopPct = 100 - zeroBottomPct;
          const room = val >= 0 ? zeroTopPct : zeroBottomPct;
          const magPct = Math.min(room, val === 0 ? 4 : Math.max(4, (Math.abs(val) / span) * 100));
          const posStyle: CSSProperties = {
            alignSelf: 'flex-start',
            position: 'relative',
            /* Fixed to three places: a difference of two thirds leaves 7e-15, which is not a CSS number. */
            top: `${(val >= 0 ? zeroTopPct - magPct : zeroTopPct).toFixed(3)}%`,
            height: `${magPct.toFixed(3)}%`,
            ...(val < 0
              ? { borderRadius: '0 0 calc(var(--radius-item, var(--radius)) / 4) calc(var(--radius-item, var(--radius)) / 4)' }
              : {}),
            ...(explicitBg ? { background: explicitBg } : {}),
          };
          return <i key={idx} className={isLit ? 'is-lit' : undefined} style={posStyle} onMouseEnter={() => setHoverIdx(idx)} />;
        })}
      </span>
      <table className="kit-visually-hidden">
        <tbody>
          {items.map((item, idx) => (
            <tr key={idx}>
              <th scope="row">{labels?.[idx] ?? item.label ?? String(idx + 1)}</th>
              <td>{formatCell(item.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {hoverIdx !== null && hovered && (
        <span className="nx-sparkline-readout" style={{ left: `${((hoverIdx + 0.5) / count) * 100}%` }}>
          {(labels?.[hoverIdx] ?? hovered.label) ? `${labels?.[hoverIdx] ?? hovered.label}: ` : ''}
          {formatHover(hovered.value)}
        </span>
      )}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* 4. DonutChart & BreakdownList                                              */
/* -------------------------------------------------------------------------- */

/** Slice descriptor in a `DonutChart`. */
export interface DonutSegment {
  id?: string;
  label: string;
  value: number;
  color?: string;
  tone?: Tone;
}

/** The words a `DonutChart` says to assistive technology; each falls back to English. */
export interface DonutChartWords {
  /** Column heads of the screen-reader table. */
  segment?: string;
  value?: string;
  share?: string;
  /** Said when negative values were left out of the ring, given how many. */
  notDrawn?: (count: number) => string;
}

/** Props for the `DonutChart` component. */
export interface DonutChartProps {
  data: ReadonlyArray<DonutSegment>;
  size?: number;
  thickness?: number;
  centerLabel?: ReactNode;
  centerValue?: ReactNode;
  empty?: EmptyStateSpec | ReactNode;
  showLegend?: boolean;
  locale?: string;
  ariaLabel?: string;
  formatValue?: (v: number) => string;
  activeIndex?: number | null;
  onActiveIndexChange?: (index: number | null) => void;
  words?: DonutChartWords;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

/**
 * Proportional SVG ring chart with center metric readout and an optional compact legend. A ring has no place for a
 * value below zero: negatives are left out of it and of the total, and the chart's description says how many.
 */
export function DonutChart(props: DonutChartProps) {
  const {
    data,
    size = 184,
    thickness = 20,
    centerLabel,
    centerValue,
    empty,
    showLegend = true,
    locale,
    ariaLabel = 'Donut breakdown chart',
    formatValue: explicitFormatValue,
    activeIndex: controlledActive,
    onActiveIndexChange,
    words,
    className,
    ref,
  } = props;
  const noteId = useId();
  const legacyEmptyLabel = (props as unknown as { emptyLabel?: ReactNode }).emptyLabel;
  const emptyNode = empty !== undefined ? (isEmptyStateSpec(empty) ? empty.title : empty) : (legacyEmptyLabel ?? 'No data');

  const formatValue = useMemo(() => explicitFormatValue ?? ((v: number) => formatChartNumber(v, locale)), [explicitFormatValue, locale]);
  const [internalActive, setInternalActive] = useState<number | null>(null);
  const activeIdx = controlledActive !== undefined ? controlledActive : internalActive;

  const setActive = (idx: number | null) => {
    if (controlledActive === undefined) setInternalActive(idx);
    onActiveIndexChange?.(idx);
  };

  const positiveCount = useMemo(() => data.filter((d) => Number.isFinite(d.value) && d.value > 0).length, [data]);
  const total = useMemo(
    () => data.reduce((sum, item) => sum + (Number.isFinite(item.value) && item.value > 0 ? item.value : 0), 0),
    [data],
  );

  const center = size / 2;
  const radius = Math.max(16, center - thickness / 2 - 6);
  const circumference = 2 * Math.PI * radius;
  const gapPx = positiveCount > 1 ? 2.5 : 0;

  /* The ring's division is the shared rule (chartPath.ts): a slice too thin to spare the gap keeps its whole arc. */
  const arcs = useMemo(() => {
    const ring = donutArcs(
      data.map((seg) => seg.value),
      circumference,
      gapPx,
    );
    return data.map((seg, idx) => ({
      seg,
      idx,
      val: Number.isFinite(seg.value) && seg.value > 0 ? seg.value : 0,
      frac: ring[idx]!.share,
      strokeLen: ring[idx]!.length,
      dashOffset: -ring[idx]!.start,
      color: seg.color ?? (seg.tone ? toneColor(seg.tone) : chartColorAt(idx)),
    }));
  }, [data, circumference, gapPx]);

  const candidateArc = activeIdx !== null ? arcs[activeIdx] : undefined;
  const activeArc = candidateArc && candidateArc.val > 0 ? candidateArc : undefined;
  const isEmpty = total <= 0;
  const displayValue = activeArc ? formatValue(activeArc.val) : centerValue !== undefined ? centerValue : formatValue(total);
  const displayLabel = activeArc
    ? `${activeArc.seg.label} (${Math.round(activeArc.frac * 100)}%)`
    : centerLabel !== undefined
      ? centerLabel
      : isEmpty
        ? emptyNode
        : undefined;

  const droppedCount = data.reduce((count, d) => count + (Number.isFinite(d.value) && d.value < 0 ? 1 : 0), 0);
  const droppedNote =
    droppedCount > 0
      ? (words?.notDrawn?.(droppedCount) ??
        (droppedCount === 1 ? '1 negative value is not drawn.' : `${droppedCount} negative values are not drawn.`))
      : undefined;
  /* A segment's share of the ring, or a dash where it has none to state: a negative is in no total. */
  const shareOf = (arc: (typeof arcs)[number]) =>
    Number.isFinite(arc.seg.value) && arc.seg.value < 0 ? '—' : `${(arc.frac * 100).toFixed(arc.frac > 0 && arc.frac < 0.01 ? 1 : 0)}%`;
  const sayValue = (arc: (typeof arcs)[number]) => formatValue(Number.isFinite(arc.seg.value) ? arc.seg.value : 0);

  const innerHole = Math.max(28, Math.round(radius * 2 - thickness - 12));
  const isCompact = size < 148;

  return (
    <div ref={ref} className={cx('nx-donut-wrap', className)} data-empty={isEmpty ? '' : undefined}>
      <div className="nx-donut-stage" style={{ width: size, height: size }}>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          role="img"
          aria-label={ariaLabel}
          aria-describedby={droppedNote ? noteId : undefined}
          onMouseLeave={() => setActive(null)}
        >
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke="color-mix(in oklab, var(--raised) 76%, var(--ground))"
            strokeWidth={thickness}
          />
          <g transform={`rotate(-90 ${center} ${center})`}>
            {arcs.map((arc) => {
              if (arc.strokeLen <= 0) return null;
              const isActive = activeArc?.idx === arc.idx;
              const isDimmed = activeArc !== undefined && !isActive;
              return (
                <circle
                  key={arc.seg.id ?? `${arc.seg.label}-${arc.idx}`}
                  cx={center}
                  cy={center}
                  r={radius}
                  fill="none"
                  stroke={arc.color}
                  strokeWidth={isActive ? thickness + 3 : thickness}
                  strokeDasharray={`${arc.strokeLen} ${circumference}`}
                  strokeDashoffset={arc.dashOffset}
                  opacity={isDimmed ? 0.42 : 1}
                  className="nx-donut-segment"
                  onMouseEnter={() => setActive(arc.idx)}
                />
              );
            })}
          </g>
        </svg>

        <div className="nx-donut-center" style={{ maxWidth: innerHole, overflow: 'hidden' }}>
          <div
            className="nx-donut-value"
            style={{
              ...(isCompact ? { fontSize: `${Math.max(11, Math.round(size * 0.11))}px` } : {}),
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {displayValue}
          </div>
          {displayLabel && (
            <div
              className="nx-donut-label"
              style={{
                ...(isCompact ? { fontSize: `${Math.max(9, Math.round(size * 0.075))}px` } : {}),
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {displayLabel}
            </div>
          )}
        </div>
      </div>

      {/* The legend is a key to the ring, a line a segment: swatch, name, value, share. It was a full BreakdownList,
          a meter row per segment, which stood several times the donut's height beside it. It is hidden from
          assistive technology because the table below says the same rows with their column heads. */}
      {showLegend && (
        <ul className="nx-donut-legend" aria-hidden="true" onMouseLeave={() => setActive(null)}>
          {arcs.map((arc) => (
            <li
              key={arc.seg.id ?? `${arc.seg.label}-${arc.idx}`}
              className="nx-donut-legend-row"
              data-active={activeArc?.idx === arc.idx ? '' : undefined}
              data-dimmed={activeArc !== undefined && activeArc.idx !== arc.idx ? '' : undefined}
              onMouseEnter={() => setActive(arc.idx)}
            >
              <span className="nx-chart-swatch" style={{ background: arc.color }} />
              <span className="nx-donut-legend-name">{arc.seg.label}</span>
              <span className="nx-donut-legend-value">{sayValue(arc)}</span>
              <span className="nx-donut-legend-share">{shareOf(arc)}</span>
            </li>
          ))}
        </ul>
      )}
      {/* The table stands whether or not the legend is drawn, as it does behind every other chart. */}
      {droppedNote && (
        <span id={noteId} className="visually-hidden" style={SR_ONLY_STYLE}>
          {droppedNote}
        </span>
      )}
      <ChartAccessibleTable
        headers={[words?.segment ?? 'Segment', words?.value ?? 'Value', words?.share ?? 'Share']}
        rows={arcs.map((arc) => [arc.seg.label, sayValue(arc), shareOf(arc)])}
      />
    </div>
  );
}

/** Single labeled bar row in `BreakdownList`. */
export interface BreakdownItem {
  key?: string;
  id?: string;
  label: ReactNode;
  value: number | string;
  note?: ReactNode;
  hint?: ReactNode;
  color?: string;
  tone?: Tone;
}

/** Props for the `BreakdownList` component. */
export interface BreakdownListProps {
  items: ReadonlyArray<BreakdownItem>;
  /** Explicit denominator for computing each row's bar share and percentage. */
  total?: number | string;
  /** Draw each row's percentage share beside its formatted value. */
  showPercent?: boolean;
  /** Built-in formatting preset used when `formatValue` is omitted. */
  format?: 'number' | 'money' | 'percent';
  /** Custom value formatter taking precedence over `format`. */
  formatValue?: (v: number) => string;
  /**
   * ISO 4217 code for `format: 'money'`. Read where no host formatter says money (the host's own currency wins for
   * ordinary numbers) and for a string value too large for a number. Defaults to `USD`.
   */
  currency?: string;
  tone?: Tone;
  locale?: string;
  label?: string;
  ariaLabel?: string;
  activeIndex?: number | null;
  onActiveIndexChange?: (index: number | null) => void;
  className?: string;
  style?: CSSProperties;
  ref?: Ref<HTMLUListElement>;
}

/**
 * Ranked or categorical horizontal meter list supporting explicit `total`, percentage shares, and `> 2^53` counts.
 * A count past 2^53 is given as a string and printed digit for digit in the `format` preset; `formatValue` takes a
 * `number` and so is not asked to say it.
 */
export function BreakdownList(props: BreakdownListProps) {
  const {
    items,
    total: explicitTotal,
    showPercent = false,
    format,
    formatValue: explicitFormatValue,
    currency = 'USD',
    tone,
    locale,
    label,
    ariaLabel,
    activeIndex,
    onActiveIndexChange,
    className,
    style,
    ref,
  } = props;
  const seam = useSurfaceSeam();
  const legacySay = (props as unknown as { say?: (value: number) => string }).say;

  const numericValues = useMemo(
    () =>
      /* Read by the charts' one rule (chartFormat.ts); a value that is no number draws an empty meter. */
      items.map((item) => readChartValue(item.value).value ?? 0),
    [items],
  );

  const explicitTotalNum = useMemo(() => {
    if (explicitTotal === undefined) return undefined;
    const n = Number(explicitTotal);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [explicitTotal]);

  const sumTotal = useMemo(() => numericValues.reduce((sum, v) => sum + Math.max(0, v), 0), [numericValues]);
  const shareTotal = explicitTotalNum !== undefined ? explicitTotalNum : sumTotal;

  const maxVal = useMemo(() => extentOf(numericValues, 0, 0).max, [numericValues]);
  const barDenominator = explicitTotalNum !== undefined ? explicitTotalNum : maxVal;

  return (
    <ul
      ref={ref}
      style={style}
      aria-label={ariaLabel ?? label}
      className={cx('kit-bars nx-breakdown-list', className)}
      onMouseLeave={() => onActiveIndexChange?.(null)}
    >
      {items.map((item, idx) => {
        const rowKey = item.key ?? item.id ?? (typeof item.label === 'string' ? `${item.label}-${idx}` : String(idx));
        const numVal = numericValues[idx] ?? 0;
        const posVal = Math.max(0, numVal);
        const pct = shareTotal > 0 && posVal > 0 ? Math.min(100, (posVal / shareTotal) * 100) : 0;
        const barPct = barDenominator > 0 && posVal > 0 ? Math.min(100, (posVal / barDenominator) * 100) : 0;
        const pctText = `${pct.toFixed(pct > 0 && pct < 1 ? 1 : 0)}%`;
        const rowTone = item.tone ?? tone;
        const kitTone = toKitTone(rowTone);
        const dataTone = toDataTone(rowTone);
        const showSwatch = item.color !== undefined || activeIndex !== undefined;
        const swatchColor = item.color ?? (rowTone ? toneColor(rowTone) : chartColorAt(idx));
        const fillBackground = item.color ?? (activeIndex !== undefined ? swatchColor : rowTone ? toneColor(rowTone) : undefined);

        const said = formatBreakdownItemValue(
          item.value,
          locale,
          format ?? 'number',
          currency,
          explicitFormatValue,
          legacySay,
          seam?.formatPreset,
        );
        const named =
          typeof item.label === 'string' || typeof item.label === 'number' ? String(item.label) : (item.key ?? item.id ?? String(idx + 1));
        const extra = item.note ?? item.hint;
        const noteText = typeof extra === 'string' || typeof extra === 'number' ? `, ${extra}` : '';
        const pctAria = showPercent ? ` (${pctText})` : '';
        const safeMax = barDenominator > 0 ? barDenominator : 0;
        const safeNow = Math.min(safeMax > 0 ? safeMax : posVal, posVal);
        const isActive = activeIndex === idx;
        const isDimmed = activeIndex !== null && activeIndex !== undefined && !isActive;

        return (
          <li
            key={rowKey}
            className="kit-bars-row nx-breakdown-row"
            data-active={isActive ? '' : undefined}
            data-dimmed={isDimmed ? '' : undefined}
            onMouseEnter={() => onActiveIndexChange?.(idx)}
          >
            <span className="kit-bars-label nx-breakdown-label">
              {showSwatch && <span className="nx-chart-swatch" style={{ background: swatchColor }} />}
              <span className="nx-breakdown-name">{item.label}</span>
            </span>
            <span
              className={cx('meter-wrap meter-fluid nx-breakdown-track', kitTone && `meter-${kitTone}`)}
              role="meter"
              data-tone={dataTone}
              aria-label={named}
              aria-valuemin={0}
              aria-valuemax={safeMax}
              aria-valuenow={safeNow}
              aria-valuetext={`${named}: ${said}${pctAria}${noteText}`}
            >
              <span className="pct-bar">
                <span
                  className="pct-fill nx-breakdown-fill"
                  style={{
                    width: `${barPct}%`,
                    ...(fillBackground ? { background: fillBackground } : {}),
                  }}
                />
              </span>
            </span>
            <span className="kit-bars-figure nx-breakdown-metrics">
              <span className="nx-breakdown-count">{said}</span>
              {showPercent && <span className="kit-bars-pct nx-breakdown-pct">{pctText}</span>}
            </span>
            {extra !== undefined ? <span className="kit-bars-note nx-breakdown-hint">{extra}</span> : <span className="kit-bars-note" />}
          </li>
        );
      })}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */
/* 5. FunnelChart                                                             */
/* -------------------------------------------------------------------------- */

/** Stage entry in a `FunnelChart`. */
export interface FunnelStage {
  id?: string;
  label: string;
  value: number;
  hint?: string;
  color?: string;
}

/** Column heads of a `FunnelChart`'s screen-reader table; each falls back to English. */
export interface FunnelChartWords {
  stage?: string;
  value?: string;
  overall?: string;
}

/** Props for the `FunnelChart` component. */
export interface FunnelChartProps {
  stages: ReadonlyArray<FunnelStage>;
  locale?: string;
  ariaLabel?: string;
  stepRetentionTitle?: string;
  formatStep?: (pct: number) => string;
  formatValue?: (v: number) => string;
  words?: FunnelChartWords;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

/** Multi-stage conversion funnel chart with step-to-step retention badges and accessible table output. */
export function FunnelChart({
  stages,
  locale,
  ariaLabel = 'Conversion funnel',
  stepRetentionTitle = 'Step-to-step retention',
  formatStep = (pct) => `${pct.toFixed(0)}% step`,
  formatValue: explicitFormatValue,
  words,
  className,
  ref,
}: FunnelChartProps) {
  const formatValue = useMemo(() => explicitFormatValue ?? ((v: number) => formatChartNumber(v, locale)), [explicitFormatValue, locale]);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const rawStart = stages[0]?.value ?? 0;
  const startValue = Number.isFinite(rawStart) && rawStart > 0 ? rawStart : 0;

  return (
    <div ref={ref} role="list" aria-label={ariaLabel} className={cx('nx-funnel', className)} onMouseLeave={() => setHoverIdx(null)}>
      {stages.map((stage, idx) => {
        const rawVal = Number.isFinite(stage.value) ? stage.value : 0;
        const posVal = Math.max(0, rawVal);
        const prevRaw = idx === 0 ? rawVal : (stages[idx - 1]?.value ?? 0);
        const prevPos = Number.isFinite(prevRaw) && prevRaw > 0 ? prevRaw : 0;
        const fromStartPct = startValue > 0 && posVal > 0 ? Math.min(100, (posVal / startValue) * 100) : 0;
        const stepPct = prevPos > 0 && posVal > 0 ? Math.min(100, (posVal / prevPos) * 100) : 0;
        const barWidthPct = posVal <= 0 || fromStartPct <= 0 ? 0 : Math.max(2, fromStartPct);
        const color = chartColorAt(idx, stage.color);
        const isHovered = hoverIdx === idx;

        return (
          <div
            key={stage.id ?? `${stage.label}-${idx}`}
            role="listitem"
            className="nx-funnel-stage"
            data-hovered={isHovered ? '' : undefined}
            onMouseEnter={() => setHoverIdx(idx)}
          >
            <div className="nx-funnel-meta">
              <div className="nx-funnel-title-row">
                <span className="nx-funnel-step-num">{idx + 1}</span>
                <span className="nx-funnel-label">{stage.label}</span>
                {stage.hint && <span className="nx-funnel-hint">{stage.hint}</span>}
              </div>
              <div className="nx-funnel-stats">
                {idx > 0 && (
                  <span className="nx-badge" data-tone="neutral" data-pill="" title={stepRetentionTitle}>
                    {formatStep(stepPct)}
                  </span>
                )}
                <span className="nx-funnel-value">{formatValue(rawVal)}</span>
                <span className="nx-funnel-overall">{fromStartPct.toFixed(1)}%</span>
              </div>
            </div>
            <div className="nx-funnel-bar-track" aria-hidden="true">
              <div
                className="nx-funnel-bar-fill"
                style={{
                  width: `${barWidthPct}%`,
                  background: color,
                }}
              />
            </div>
          </div>
        );
      })}
      <ChartAccessibleTable
        headers={[words?.stage ?? 'Stage', words?.value ?? 'Value', words?.overall ?? 'Overall']}
        rows={stages.map((stage) => {
          const rawVal = Number.isFinite(stage.value) ? stage.value : 0;
          const posVal = Math.max(0, rawVal);
          const pct = startValue > 0 && posVal > 0 ? Math.min(100, (posVal / startValue) * 100) : 0;
          return [stage.label, formatValue(rawVal), `${pct.toFixed(1)}%`];
        })}
      />
    </div>
  );
}
