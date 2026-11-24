/** Responsive SVG stage funnels, 2D intensity heatmaps, multi-axis radar charts, and radial arc gauges. */
'use client';

import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cx, toDataTone, type Tone } from '../internal/cx.js';
import { chartColorAt, formatChartNumber, useContainerWidth } from './chartShared.js';

/* ========================================================================== */
/* Shared Formatting & Tone Helpers                                           */
/* ========================================================================== */

function defaultChartFormat(value: number, locale?: string): string {
  return formatChartNumber(value, locale);
}

function resolveToneStroke(tone: Tone): string {
  switch (toDataTone(tone)) {
    case 'good':
      return 'var(--status-good)';
    case 'warning':
      return 'var(--status-warning)';
    case 'critical':
      return 'var(--status-critical)';
    case 'info':
      return 'var(--status-info)';
    case 'neutral':
      return 'color-mix(in oklab, var(--ink) 78%, var(--surface))';
    case 'accent':
    default:
      return 'var(--accent)';
  }
}

/* ========================================================================== */
/* 1. HeatmapMatrix                                                           */
/* ========================================================================== */

/** Zero-based row and column coordinates of a `HeatmapMatrix` cell. */
export interface HeatmapCellCoord {
  rowIndex: number;
  colIndex: number;
}

/** Props for the `HeatmapMatrix` component. */
export interface HeatmapMatrixProps {
  rows: ReadonlyArray<string>;
  columns: ReadonlyArray<string>;
  values: ReadonlyArray<ReadonlyArray<number>>;
  locale?: string;
  formatValue?: (value: number, rowIndex: number, colIndex: number) => string;
  formatScaleValue?: (value: number) => string;
  min?: number;
  max?: number;
  showValues?: boolean;
  showScale?: boolean;
  cellHeight?: number;
  ariaLabel?: string;
  valueLabel?: string;
  intensityLabel?: string;
  lowLabel?: string;
  peakLabel?: string;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

/** Two-dimensional keyboard-navigable intensity heatmap grid with legend scale. */
export function HeatmapMatrix({
  rows = [],
  columns = [],
  values = [],
  locale,
  formatValue: explicitFormatValue,
  formatScaleValue,
  min: explicitMin,
  max: explicitMax,
  showValues = false,
  showScale = true,
  cellHeight = 30,
  ariaLabel = 'Intensity heatmap matrix',
  valueLabel = 'Value',
  intensityLabel = 'Intensity',
  lowLabel = 'Low',
  peakLabel = 'Peak',
  className,
  ref,
}: HeatmapMatrixProps) {
  const formatValue = useMemo(() => explicitFormatValue ?? ((v: number) => defaultChartFormat(v, locale)), [explicitFormatValue, locale]);
  const formatLegendBound = useMemo(
    () =>
      formatScaleValue ??
      (explicitFormatValue && explicitFormatValue.length <= 1
        ? (v: number) => explicitFormatValue(v, 0, 0)
        : (v: number) => defaultChartFormat(v, locale)),
    [explicitFormatValue, formatScaleValue, locale],
  );
  const [activeCell, setActiveCell] = useState<HeatmapCellCoord | null>(null);
  const [focusedCell, setFocusedCell] = useState<HeatmapCellCoord>({ rowIndex: 0, colIndex: 0 });
  const cellRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const safeFocusRow = rows.length > 0 ? Math.min(focusedCell.rowIndex, rows.length - 1) : 0;
  const safeFocusCol = columns.length > 0 ? Math.min(focusedCell.colIndex, columns.length - 1) : 0;

  const moveCellFocus = (nextRow: number, nextCol: number) => {
    if (rows.length === 0 || columns.length === 0) return;
    const clampedRow = Math.max(0, Math.min(rows.length - 1, nextRow));
    const clampedCol = Math.max(0, Math.min(columns.length - 1, nextCol));
    setFocusedCell({ rowIndex: clampedRow, colIndex: clampedCol });
    setActiveCell({ rowIndex: clampedRow, colIndex: clampedCol });
    cellRefs.current.get(`${clampedRow}-${clampedCol}`)?.focus();
  };

  const handleCellKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, rIdx: number, cIdx: number) => {
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        moveCellFocus(rIdx, cIdx + 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        moveCellFocus(rIdx, cIdx - 1);
        break;
      case 'ArrowDown':
        event.preventDefault();
        moveCellFocus(rIdx + 1, cIdx);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveCellFocus(rIdx - 1, cIdx);
        break;
      case 'Home':
        event.preventDefault();
        moveCellFocus(event.ctrlKey || event.metaKey ? 0 : rIdx, 0);
        break;
      case 'End':
        event.preventDefault();
        moveCellFocus(event.ctrlKey || event.metaKey ? rows.length - 1 : rIdx, columns.length - 1);
        break;
    }
  };

  const { minVal, maxVal } = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const row of values) {
      for (const v of row) {
        if (Number.isFinite(v)) {
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
    }
    if (!Number.isFinite(lo)) lo = 0;
    if (!Number.isFinite(hi)) hi = 100;
    const resolvedMin = explicitMin !== undefined ? explicitMin : Math.min(0, lo);
    const resolvedMax = explicitMax !== undefined ? explicitMax : hi <= resolvedMin ? resolvedMin + 1 : hi;
    return { minVal: resolvedMin, maxVal: resolvedMax };
  }, [explicitMax, explicitMin, values]);

  const span = Math.max(1e-9, maxVal - minVal);

  const activeDetails = useMemo(() => {
    if (!activeCell) return null;
    const { rowIndex, colIndex } = activeCell;
    const rowLabel = rows[rowIndex];
    const colLabel = columns[colIndex];
    if (rowLabel === undefined || colLabel === undefined) return null;
    const raw = values[rowIndex]?.[colIndex] ?? 0;
    const safeRaw = Number.isFinite(raw) ? raw : 0;
    const norm = Math.max(0, Math.min(1, (safeRaw - minVal) / span));
    return {
      rowIndex,
      colIndex,
      rowLabel,
      colLabel,
      value: safeRaw,
      formatted: formatValue(safeRaw, rowIndex, colIndex),
      pct: Math.round(norm * 100),
    };
  }, [activeCell, columns, formatValue, minVal, rows, span, values]);

  const scaleSteps = [0, 22, 46, 70, 94];

  return (
    <div ref={ref} className={cx('nx-heatmap', className)} onMouseLeave={() => setActiveCell(null)}>
      <div
        className="nx-heatmap-stage"
        role="grid"
        aria-label={ariaLabel}
        style={
          {
            '--heatmap-cols': columns.length,
            '--heatmap-cell-h': `${cellHeight}px`,
          } as CSSProperties
        }
      >
        {/* Column Headers */}
        <div className="nx-heatmap-header-row" role="row">
          <div className="nx-heatmap-corner" aria-hidden="true" />
          {columns.map((col, cIdx) => (
            <div key={`${col}-${cIdx}`} role="columnheader" className="nx-heatmap-col-label" title={col}>
              {col}
            </div>
          ))}
        </div>

        {/* Matrix Rows */}
        {rows.map((rowLabel, rIdx) => {
          const rowVals = values[rIdx] ?? [];
          return (
            <div key={`${rowLabel}-${rIdx}`} className="nx-heatmap-row" role="row">
              <div role="rowheader" className="nx-heatmap-row-label" title={rowLabel}>
                {rowLabel}
              </div>

              {columns.map((colLabel, cIdx) => {
                const rawVal = rowVals[cIdx] ?? 0;
                const val = Number.isFinite(rawVal) ? rawVal : 0;
                const norm = Math.max(0, Math.min(1, (val - minVal) / span));
                const mixPct = norm <= 0 ? 0 : Math.min(96, Math.round(10 + norm * 86));
                const isHovered = activeCell?.rowIndex === rIdx && activeCell?.colIndex === cIdx;
                const isTabStop = rIdx === safeFocusRow && cIdx === safeFocusCol;
                const highContrast = mixPct >= 58;

                const cellBg = `color-mix(in oklab, var(--accent) ${mixPct}%, var(--raised))`;
                const cellKey = `${rIdx}-${cIdx}`;

                return (
                  <button
                    key={cellKey}
                    ref={(node) => {
                      if (node) cellRefs.current.set(cellKey, node);
                      else cellRefs.current.delete(cellKey);
                    }}
                    type="button"
                    role="gridcell"
                    tabIndex={isTabStop ? 0 : -1}
                    aria-label={`${rowLabel}, ${colLabel}: ${formatValue(val, rIdx, cIdx)}`}
                    data-hovered={isHovered ? '' : undefined}
                    data-contrast={highContrast ? 'high' : undefined}
                    style={{ background: cellBg }}
                    onMouseEnter={() => setActiveCell({ rowIndex: rIdx, colIndex: cIdx })}
                    onFocus={() => {
                      setFocusedCell({ rowIndex: rIdx, colIndex: cIdx });
                      setActiveCell({ rowIndex: rIdx, colIndex: cIdx });
                    }}
                    onBlur={() => setActiveCell(null)}
                    onKeyDown={(e) => handleCellKeyDown(e, rIdx, cIdx)}
                    className="nx-heatmap-cell nx-focusable"
                  >
                    {showValues && <span className="nx-heatmap-cell-val">{formatValue(val, rIdx, cIdx)}</span>}
                  </button>
                );
              })}
            </div>
          );
        })}

        {/* Floating Cell Tooltip */}
        {activeDetails && columns.length > 0 && rows.length > 0 && (
          <div
            className="nx-chart-tooltip nx-heatmap-tooltip"
            style={{
              left: `${Math.min(82, Math.max(18, ((activeDetails.colIndex + 0.5) / columns.length) * 100))}%`,
              top: `${((activeDetails.rowIndex + 1) / (rows.length + 1)) * 100}%`,
            }}
          >
            <div className="nx-chart-tooltip-title">
              {activeDetails.rowLabel} · {activeDetails.colLabel}
            </div>
            <div className="nx-chart-tooltip-rows">
              <div className="nx-chart-tooltip-row">
                <span className="nx-chart-tooltip-key">{valueLabel}</span>
                <span className="nx-chart-tooltip-val">{activeDetails.formatted}</span>
              </div>
              <div className="nx-chart-tooltip-row">
                <span className="nx-chart-tooltip-key">{intensityLabel}</span>
                <span className="nx-chart-tooltip-val">{activeDetails.pct}%</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Intensity Legend Scale */}
      {showScale && (
        <div className="nx-heatmap-footer">
          <span className="nx-heatmap-scale-caption">
            {formatLegendBound(minVal)} ({lowLabel})
          </span>
          <div className="nx-heatmap-scale-swatches" aria-hidden="true">
            {scaleSteps.map((pct) => (
              <span
                key={pct}
                className="nx-heatmap-scale-swatch"
                style={{
                  background: `color-mix(in oklab, var(--accent) ${pct}%, var(--raised))`,
                }}
              />
            ))}
          </div>
          <span className="nx-heatmap-scale-caption">
            {formatLegendBound(maxVal)} ({peakLabel})
          </span>
        </div>
      )}
    </div>
  );
}

/* ========================================================================== */
/* 2. RadarChart                                                              */
/* ========================================================================== */

/** Axis descriptor in a `RadarChart`. */
export interface RadarAxis {
  label: string;
  min?: number;
  max?: number;
}

/** Plotted polygon series in a `RadarChart`. */
export interface RadarSeries {
  id?: string;
  label: string;
  values: ReadonlyArray<number>;
  color?: string;
  fillOpacity?: number;
}

/** Props for the `RadarChart` component. */
export interface RadarChartProps {
  axes: ReadonlyArray<RadarAxis>;
  series: ReadonlyArray<RadarSeries>;
  min?: number;
  size?: number;
  levels?: number;
  showDots?: boolean;
  showLegend?: boolean;
  locale?: string;
  seriesLabel?: string;
  formatValue?: (value: number) => string;
  ariaLabel?: string;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

/** Multi-axis SVG radar polygon chart with interactive series toggles and axis hover readouts. */
export function RadarChart({
  axes,
  series,
  min: explicitMin,
  size: askedSize = 290,
  levels = 4,
  showDots = true,
  showLegend = true,
  locale,
  seriesLabel = 'Radar series',
  formatValue: explicitFormatValue,
  ariaLabel = 'Multi-axis radar chart',
  className,
  ref,
}: RadarChartProps) {
  const formatValue = useMemo(() => explicitFormatValue ?? ((v: number) => defaultChartFormat(v, locale)), [explicitFormatValue, locale]);
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(() => new Set());
  const [hoverAxisIdx, setHoverAxisIdx] = useState<number | null>(null);

  const seriesWithKeys = useMemo(
    () =>
      series.map((s, idx) => ({
        ...s,
        resolvedId: s.id ?? `${s.label}-${idx}`,
        resolvedColor: chartColorAt(idx, s.color),
      })),
    [series],
  );

  const visibleSeries = useMemo(() => seriesWithKeys.filter((s) => !hiddenSeries.has(s.resolvedId)), [hiddenSeries, seriesWithKeys]);

  const toggleSeries = (id: string) => {
    setHiddenSeries((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < seriesWithKeys.length - 1) {
        next.add(id);
      }
      return next;
    });
  };

  const { fallbackMin, fallbackMax } = useMemo(() => {
    let lo = 0;
    let hi = 0;
    for (const s of series) {
      for (const v of s.values) {
        if (Number.isFinite(v)) {
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
    }
    const resolvedMin = explicitMin !== undefined && Number.isFinite(explicitMin) ? explicitMin : lo < 0 ? lo : 0;
    const resolvedMax = hi > resolvedMin ? hi : resolvedMin + 100;
    return { fallbackMin: resolvedMin, fallbackMax: resolvedMax };
  }, [explicitMin, series]);

  const padX = 68;
  const padY = 34;
  /* The web gives way to a narrow container; the words do not. The viewBox is drawn at the width there is, so an
     axis label stays at its own size on a phone, where scaling the whole picture down took a 12px label to 8. */
  const { ref: stageRef, width: stageWidth } = useContainerWidth(askedSize + padX * 2);
  const size = Math.max(120, Math.min(askedSize, stageWidth - padX * 2));
  const viewW = size + padX * 2;
  const viewH = size + padY * 2;
  const centerX = viewW / 2;
  const centerY = viewH / 2;
  const radius = Math.max(40, size / 2 - 14);
  const axisCount = axes.length;

  const angleFor = (idx: number) => -Math.PI / 2 + (idx * 2 * Math.PI) / Math.max(1, axisCount);

  const pointAt = (idx: number, ratio: number) => {
    const angle = angleFor(idx);
    const safeRatio = Math.max(0, ratio);
    return {
      x: centerX + Math.cos(angle) * radius * safeRatio,
      y: centerY + Math.sin(angle) * radius * safeRatio,
      angle,
    };
  };

  const ringPolygons = useMemo(() => {
    if (axisCount < 3) return [];
    const safeLevels = Math.max(2, levels);
    return Array.from({ length: safeLevels }, (_, levelIdx) => {
      const ratio = (levelIdx + 1) / safeLevels;
      const pts = axes
        .map((_, aIdx) => {
          const p = pointAt(aIdx, ratio);
          return `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
        })
        .join(' ');
      return { levelIdx, ratio, pts };
    });
  }, [axes, axisCount, levels, radius, centerX, centerY]);

  const seriesPolygons = useMemo(() => {
    if (axisCount < 3) return [];
    return visibleSeries.map((s) => {
      const vertices = axes.map((axis, aIdx) => {
        const rawVal = s.values[aIdx] ?? 0;
        const val = Number.isFinite(rawVal) ? rawVal : 0;
        const axisMin = axis.min !== undefined && Number.isFinite(axis.min) ? axis.min : fallbackMin;
        const axisMax =
          axis.max !== undefined && Number.isFinite(axis.max) && axis.max > axisMin ? axis.max : Math.max(axisMin + 1, fallbackMax);
        const clampedRatio = Math.max(0, Math.min(1, (val - axisMin) / (axisMax - axisMin)));
        const p = pointAt(aIdx, clampedRatio);
        return { ...p, value: val };
      });
      const polygonPoints = vertices.map((v) => `${v.x.toFixed(2)},${v.y.toFixed(2)}`).join(' ');
      return {
        series: s,
        vertices,
        polygonPoints,
      };
    });
  }, [axes, axisCount, fallbackMin, fallbackMax, visibleSeries, radius, centerX, centerY]);

  const hoveredAxis = hoverAxisIdx !== null ? axes[hoverAxisIdx] : undefined;

  return (
    <div ref={ref} className={cx('nx-chart nx-radar', className)}>
      {showLegend && seriesWithKeys.length > 0 && (
        <div className="nx-chart-legend" role="group" aria-label={seriesLabel}>
          {seriesWithKeys.map((s) => {
            const muted = hiddenSeries.has(s.resolvedId);
            return (
              <button
                key={s.resolvedId}
                type="button"
                data-muted={muted ? '' : undefined}
                aria-pressed={!muted}
                onClick={() => toggleSeries(s.resolvedId)}
                className="nx-chart-legend-item"
              >
                <span className="nx-chart-swatch" style={{ background: s.resolvedColor }} />
                <span>{s.label}</span>
              </button>
            );
          })}
        </div>
      )}

      <div ref={stageRef} className="nx-radar-stage" onMouseLeave={() => setHoverAxisIdx(null)}>
        <svg viewBox={`0 0 ${viewW} ${viewH}`} role="img" aria-label={ariaLabel} className="nx-radar-svg" style={{ maxWidth: viewW }}>
          {/* Concentric Web Polygons */}
          {ringPolygons.map((ring) => (
            <polygon
              key={ring.levelIdx}
              points={ring.pts}
              fill={ring.levelIdx % 2 === 0 ? 'color-mix(in oklab, var(--raised) 45%, transparent)' : 'none'}
              stroke={ring.levelIdx === ringPolygons.length - 1 ? 'var(--line)' : 'color-mix(in oklab, var(--line) 72%, transparent)'}
              strokeWidth={1}
            />
          ))}

          {/* Radial Spokes & Axis Labels */}
          {axes.map((axis, aIdx) => {
            const outer = pointAt(aIdx, 1);
            const labelPos = pointAt(aIdx, 1 + 17 / radius);
            const cos = Math.cos(outer.angle);
            const anchor = Math.abs(cos) < 0.16 ? 'middle' : cos > 0 ? 'start' : 'end';
            const isAxisHovered = hoverAxisIdx === aIdx;

            return (
              <g key={`${axis.label}-${aIdx}`}>
                <line
                  x1={centerX}
                  y1={centerY}
                  x2={outer.x}
                  y2={outer.y}
                  stroke={isAxisHovered ? 'var(--accent)' : 'color-mix(in oklab, var(--line) 72%, transparent)'}
                  strokeWidth={isAxisHovered ? 1.5 : 1}
                />
                <text
                  x={labelPos.x}
                  y={labelPos.y}
                  textAnchor={anchor}
                  dominantBaseline="central"
                  className="nx-radar-axis-label"
                  data-active={isAxisHovered ? '' : undefined}
                >
                  {axis.label}
                </text>
              </g>
            );
          })}

          {/* Series Polygons & Dots */}
          {seriesPolygons.map(({ series: s, vertices, polygonPoints }) => (
            <g key={s.resolvedId}>
              <polygon
                points={polygonPoints}
                fill={s.resolvedColor}
                fillOpacity={s.fillOpacity ?? 0.16}
                stroke={s.resolvedColor}
                strokeWidth={2}
                strokeLinejoin="round"
                className="nx-radar-polygon"
              />
              {showDots &&
                vertices.map((v, aIdx) => (
                  <circle
                    key={`${s.resolvedId}-${aIdx}`}
                    cx={v.x}
                    cy={v.y}
                    r={hoverAxisIdx === aIdx ? 4.25 : 3}
                    fill={s.resolvedColor}
                    stroke="var(--surface)"
                    strokeWidth={1.5}
                  />
                ))}
            </g>
          ))}

          {/* Interactive Axis Hover Targets */}
          {axes.map((axis, aIdx) => {
            const outer = pointAt(aIdx, 0.85);
            return (
              <circle
                key={`hit-${axis.label}-${aIdx}`}
                cx={outer.x}
                cy={outer.y}
                r={Math.max(16, radius * 0.24)}
                fill="transparent"
                className="nx-radar-hit"
                onMouseEnter={() => setHoverAxisIdx(aIdx)}
              />
            );
          })}
        </svg>

        {hoveredAxis && hoverAxisIdx !== null && (
          <div className="nx-chart-tooltip nx-radar-tooltip">
            <div className="nx-chart-tooltip-title">{hoveredAxis.label}</div>
            <div className="nx-chart-tooltip-rows">
              {visibleSeries.map((s) => (
                <div key={s.resolvedId} className="nx-chart-tooltip-row">
                  <span className="nx-chart-tooltip-key">
                    <span className="nx-chart-swatch" style={{ background: s.resolvedColor }} />
                    <span>{s.label}</span>
                  </span>
                  <span className="nx-chart-tooltip-val">{formatValue(s.values[hoverAxisIdx] ?? 0)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ========================================================================== */
/* 3. RadialGauge                                                             */
/* ========================================================================== */

/** Supported angular sweep in degrees for `RadialGauge`. */
export type RadialGaugeArc = 180 | 270;

/** Upper-bound tone threshold stop for `RadialGauge`. */
export interface RadialGaugeThreshold {
  /** Upper bound value (inclusive) in the `[min, max]` domain for this tone. */
  upTo: number;
  tone: Tone;
}

/** Props for the `RadialGauge` component. */
export interface RadialGaugeProps {
  value: number;
  min?: number;
  max?: number;
  arc?: RadialGaugeArc;
  size?: number;
  thickness?: number;
  label?: ReactNode;
  sublabel?: ReactNode;
  tone?: Tone;
  thresholds?: ReadonlyArray<RadialGaugeThreshold>;
  /**
   * When `tone` and `thresholds` are omitted, controls automatic threshold direction:
   * - `false` (default): higher values are healthier (`>= 75%` good, `>= 40%` warning, `< 40%` critical)
   * - `true`: lower values are healthier, e.g. CPU/queue load (`<= 60%` good, `<= 85%` warning, `> 85%` critical)
   */
  invertThresholds?: boolean;
  showEndpoints?: boolean;
  locale?: string;
  /**
   * Says the reading and both endpoints. Without it the reading is a locale number, except on the default 0–100
   * range, where it is read as a percentage: rounded to a whole number with a `%` sign. Pass a formatter for a
   * 0–100 scale that is not a percentage (a score, a temperature).
   */
  formatValue?: (value: number) => string;
  ariaLabel?: string;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

function resolveGaugeTone(
  value: number,
  ratio: number,
  explicitTone: Tone | undefined,
  thresholds: ReadonlyArray<RadialGaugeThreshold> | undefined,
  invertThresholds: boolean,
): Tone {
  if (explicitTone) return toDataTone(explicitTone) ?? 'accent';
  if (thresholds && thresholds.length > 0) {
    const sorted = [...thresholds].sort((a, b) => a.upTo - b.upTo);
    for (const t of sorted) {
      if (value <= t.upTo) return toDataTone(t.tone) ?? 'accent';
    }
    return toDataTone(sorted[sorted.length - 1]!.tone) ?? 'accent';
  }
  if (invertThresholds) {
    if (ratio <= 0.6) return 'good';
    if (ratio <= 0.85) return 'warning';
    return 'critical';
  }
  if (ratio >= 0.75) return 'good';
  if (ratio >= 0.4) return 'warning';
  return 'critical';
}

function prefersReducedGaugeMotion(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.dataset.nxMotion === 'reduced') {
    return true;
  }
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    return true;
  }
  return false;
}

/** Circular 180° or 270° SVG arc gauge with threshold tones and reduced-motion compliance. */
export function RadialGauge({
  value,
  min = 0,
  max = 100,
  arc = 270,
  size = 188,
  thickness = 14,
  label,
  sublabel,
  tone: explicitTone,
  thresholds,
  invertThresholds = false,
  showEndpoints = true,
  locale,
  formatValue,
  ariaLabel,
  className,
  ref,
}: RadialGaugeProps) {
  /* The motion preference is read after hydration, never in the first render: the server cannot know it, so a
     reader who asked for less motion got markup that disagreed with the server's and a hydration mismatch. The
     layout effect settles it before the first paint, so their arc is never seen empty. */
  const [mounted, setMounted] = useState(false);

  useLayoutEffect(() => {
    if (prefersReducedGaugeMotion()) setMounted(true);
  }, []);

  useEffect(() => {
    if (mounted) return;
    if (prefersReducedGaugeMotion() || typeof requestAnimationFrame === 'undefined') {
      setMounted(true);
      return;
    }
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, [mounted]);

  const safeMin = Number.isFinite(min) ? min : 0;
  const safeMax = Number.isFinite(max) && max > safeMin ? max : safeMin + 100;
  const safeSpan = Math.max(1e-9, safeMax - safeMin);
  const clampedValue = Number.isFinite(value) ? Math.max(safeMin, Math.min(safeMax, value)) : safeMin;
  const ratio = (clampedValue - safeMin) / safeSpan;

  const activeTone = resolveGaugeTone(clampedValue, ratio, explicitTone, thresholds, invertThresholds);
  const strokeColor = resolveToneStroke(activeTone);

  const pad = Math.ceil(thickness / 2) + 8;
  const radius = Math.max(24, size / 2 - pad);
  const cxPos = size / 2;
  const cyPos = arc === 180 ? pad + radius : size / 2;
  const svgHeight = arc === 180 ? Math.round(cyPos + pad + (showEndpoints ? 16 : 4)) : size;

  const circumference = 2 * Math.PI * radius;
  const arcLength = circumference * (arc / 360);
  const targetOffset = arcLength * (1 - ratio);
  const dashOffset = mounted ? targetOffset : arcLength;
  const startRotation = arc === 180 ? 180 : 135;

  const formattedMain = formatValue
    ? formatValue(clampedValue)
    : safeMax === 100 && safeMin === 0
      ? `${Math.round(clampedValue)}%`
      : defaultChartFormat(clampedValue, locale);

  const formattedMin = formatValue ? formatValue(safeMin) : defaultChartFormat(safeMin, locale);
  const formattedMax = formatValue ? formatValue(safeMax) : defaultChartFormat(safeMax, locale);

  const leftEndAngle = (startRotation * Math.PI) / 180;
  const rightEndAngle = ((startRotation + arc) * Math.PI) / 180;
  const leftEndX = cxPos + Math.cos(leftEndAngle) * radius;
  const leftEndY = cyPos + Math.sin(leftEndAngle) * radius;
  const rightEndX = cxPos + Math.cos(rightEndAngle) * radius;
  const rightEndY = cyPos + Math.sin(rightEndAngle) * radius;

  const resolvedAria = ariaLabel ?? (typeof label === 'string' ? `${label}: ${formattedMain}` : 'Radial gauge');

  return (
    <div ref={ref} data-arc={arc} data-tone={toDataTone(activeTone)} className={cx('nx-radial-gauge', className)} style={{ width: size }}>
      <div className="nx-radial-gauge-stage" style={{ width: size, height: svgHeight }}>
        <svg
          width={size}
          height={svgHeight}
          viewBox={`0 0 ${size} ${svgHeight}`}
          role="meter"
          aria-valuemin={safeMin}
          aria-valuemax={safeMax}
          aria-valuenow={clampedValue}
          aria-label={resolvedAria}
          className="nx-radial-gauge-svg"
        >
          <g transform={`rotate(${startRotation} ${cxPos} ${cyPos})`}>
            {/* Background Track Arc */}
            <circle
              cx={cxPos}
              cy={cyPos}
              r={radius}
              fill="none"
              stroke="color-mix(in oklab, var(--raised) 76%, var(--ground))"
              strokeWidth={thickness}
              strokeDasharray={`${arcLength} ${circumference}`}
              strokeLinecap="round"
            />
            {/* Animated Value Arc */}
            <circle
              cx={cxPos}
              cy={cyPos}
              r={radius}
              fill="none"
              stroke={strokeColor}
              strokeWidth={thickness}
              strokeDasharray={`${arcLength} ${circumference}`}
              strokeDashoffset={dashOffset}
              strokeLinecap="round"
              className="nx-radial-gauge-arc"
            />
          </g>

          {showEndpoints && (
            <>
              <text x={leftEndX} y={leftEndY + thickness * 0.95 + 8} textAnchor="middle" className="nx-radial-gauge-endpoint">
                {formattedMin}
              </text>
              <text x={rightEndX} y={rightEndY + thickness * 0.95 + 8} textAnchor="middle" className="nx-radial-gauge-endpoint">
                {formattedMax}
              </text>
            </>
          )}
        </svg>

        <div className="nx-radial-gauge-center" data-arc={arc}>
          <div className="nx-radial-gauge-value">{formattedMain}</div>
          {label !== undefined && <div className="nx-radial-gauge-label">{label}</div>}
          {sublabel !== undefined && <div className="nx-radial-gauge-sublabel">{sublabel}</div>}
        </div>
      </div>
    </div>
  );
}
