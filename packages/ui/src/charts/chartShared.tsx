/** Shared palette, formatting, responsive container sizing, series legend, and accessible table helpers for SVG charts. */
import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from 'react';
import { toDataTone, type Tone } from '../internal/cx.js';
import { viewportBox } from '../internal/ruler.js';
import { compactAround } from './chartFormat.js';
import { AXIS_CHAR_PX, estimateTextWidth, stepTarget, thinAxisLabels, valueAxisGutter, type AxisMark } from './chartScale.js';

/** Named data series descriptor shared across cartesian SVG charts. */
export interface ChartSeries {
  key: string;
  label: string;
  color?: string;
}

export const CHART_PALETTE = [
  'var(--chart-1, var(--accent))',
  'var(--chart-2, var(--status-good))',
  'var(--chart-3, var(--status-warning))',
  'var(--chart-4, var(--status-critical))',
  'var(--chart-5, var(--status-info))',
  'var(--chart-6, var(--ai))',
] as const;

export function chartColorAt(index: number, custom?: string): string {
  if (custom) return custom;
  return CHART_PALETTE[index % CHART_PALETTE.length] ?? CHART_PALETTE[0];
}

export function toneColor(tone: Tone = 'accent'): string {
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
      return 'color-mix(in srgb, var(--ink) 78%, var(--surface))';
    case 'accent':
    default:
      return 'var(--chart-1, var(--accent))';
  }
}

/* The rules with no drawing in them (reading a value, scales, axis labels, paths) are `core.ts`'s, which the kit's
   dashboard charts read too; what follows binds them to the page charts' own face and gutter. `formatChartNumber`
   is passed on for the callers that took it from here. */
export { formatChartNumber } from './chartFormat.js';

const axisLabelWidth = (text: string) => estimateTextWidth(text, AXIS_CHAR_PX.page);

/* A value axis's gutter in the page charts: never narrower than the 46px it once always was (short labels keep the
   plot where it was) and never more than about a quarter of the chart. Labels wider than that are said in the
   compact form between whatever the caller's format puts round the digits ("$12K") rather than clipped. */
const VALUE_GUTTER_FLOOR = 46;
const VALUE_GUTTER_CEILING = 88;

export function pageValueGutter(
  ticks: ReadonlyArray<number>,
  format: (tick: number) => string,
  chartWidth: number,
  locale?: string,
): { pad: number; say: (tick: number) => string } {
  return valueAxisGutter(ticks, format, {
    width: axisLabelWidth,
    inset: 10,
    whole: true,
    floor: VALUE_GUTTER_FLOOR,
    ceiling: Math.max(VALUE_GUTTER_FLOOR, Math.min(VALUE_GUTTER_CEILING, Math.round(chartWidth * 0.24))),
    shorten: () => compactAround(ticks, format, locale),
  });
}

/* Which of an axis's labels the page charts draw: a label is centred on its point unless that would run it past
   the drawing's edge (`lo`, `hi`), where it is anchored at its start or its end instead. */
export function pickAxisLabels(labels: ReadonlyArray<string>, xAt: (index: number) => number, lo: number, hi: number): AxisMark[] {
  const several = labels.length > 1;
  return thinAxisLabels(labels.length, xAt, {
    text: (index) => labels[index] ?? '',
    width: axisLabelWidth,
    gap: 10,
    anchor: (_index, x, w) => (several && x - w / 2 < lo ? 'start' : several && x + w / 2 > hi ? 'end' : 'middle'),
  });
}

export function safeSvgId(rawId: string): string {
  return rawId.replace(/[^a-zA-Z0-9_-]/g, '');
}

export function useContainerWidth(fallback = 560) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number>(fallback);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const next = Math.round(viewportBox(el).width);
      if (next > 0) setWidth(next);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return { ref, width };
}

/* A chart's readout was reachable by pointer alone. The plot is one tab stop; arrows step the same crosshair the
   pointer moves, Home and End take the ends, Escape puts it away. One stop rather than one per point, as the kit's
   line chart roves, so a long series is not a long tab sequence. `focused` lets the caller announce the point only
   to someone stepping by keyboard, not on every pointer move. */
export function useChartStepping(count: number, setActive: (update: (prev: number | null) => number | null) => void) {
  const [focused, setFocused] = useState(false);
  const onKeyDown = (event: ReactKeyboardEvent<Element>) => {
    /* Escape puts the readout away; every other step is the shared rule's (chartScale.ts), read from wherever the
       crosshair is when the key lands. */
    const key = event.key;
    const escape = key === 'Escape';
    if (!escape && stepTarget(key, null, count) === undefined) return;
    const move = (prev: number | null) => (escape ? null : (stepTarget(key, prev, count) ?? prev));
    event.preventDefault();
    setActive(move);
  };
  return {
    focused,
    stepProps: {
      tabIndex: 0,
      onKeyDown,
      onFocus: () => {
        setFocused(true);
        if (count > 0) setActive((prev) => prev ?? 0);
      },
      onBlur: () => {
        setFocused(false);
        setActive(() => null);
      },
    },
  };
}

/** The stepped-to point, said aloud: a live region that exists before its text changes, as announcements need. */
export function ChartLiveReadout({ text }: { text: string }) {
  return (
    <div className="visually-hidden" style={SR_ONLY_STYLE} aria-live="polite" aria-atomic="true">
      {text}
    </div>
  );
}

export const SR_ONLY_STYLE: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

export function ChartAccessibleTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  if (rows.length === 0) return null;
  return (
    <div className="visually-hidden" style={SR_ONLY_STYLE}>
      <table className="chart-data">
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={i} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rIdx) => (
            <tr key={rIdx}>
              <th scope="row">{row[0]}</th>
              {row.slice(1).map((cell, cIdx) => (
                <td key={cIdx}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SeriesLegend({
  series,
  hiddenKeys,
  onToggle,
  ariaLabel = 'Chart series',
}: {
  series: ChartSeries[];
  hiddenKeys: Set<string>;
  onToggle: (key: string) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="nx-chart-legend" role="group" aria-label={ariaLabel}>
      {series.map((s, idx) => {
        const hidden = hiddenKeys.has(s.key);
        const color = chartColorAt(idx, s.color);
        return (
          <button
            key={s.key}
            type="button"
            className="nx-chart-legend-item"
            data-muted={hidden ? '' : undefined}
            aria-pressed={!hidden}
            onClick={() => onToggle(s.key)}
          >
            <span className="nx-chart-swatch" style={{ background: color }} />
            <span>{s.label}</span>
          </button>
        );
      })}
    </div>
  );
}
