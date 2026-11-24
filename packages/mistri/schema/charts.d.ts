/** `@mistriwork/mistri/charts`: generated self-contained declarations (`scripts/sync-ui-sdk.mjs`). @preview */
import * as React from 'react';
import type { MouseEvent, ReactNode, Ref } from 'react';
import { type EmptyStateSpec, type Tone } from './kit.js';

export { type BreakdownItem, BreakdownList, type BreakdownListProps, type ControlSize, type EmptyStateSpec, type MiniBarDatum, MiniBars, type MiniBarsProps, Sparkline, type SparklineProps, type Tone } from './kit.js';
/** A value axis: round levels over the figures, and how far up it a value stands. */
interface ValueScale extends NiceScale {
    /** `max - min`, never zero. */
    span: number;
    /** A value's share of the way from `min` to `max`. */
    share: (value: number) => number;
}
/** A run of equal bands, one a category, with a bar of `share` of the band (never wider than `widest`) centred in each. */
interface Bands {
    band: number;
    bar: number;
    /** Where band `index`'s bar starts, and where its middle is. */
    barStart: (index: number) => number;
    mid: (index: number) => number;
    /** The band a position falls in. */
    at: (position: number) => number;
}
type AxisAnchor = 'start' | 'middle' | 'end';
/** One axis label chosen to be drawn: the point it names, what it says and how its text is anchored to the point. */
interface AxisMark {
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
/** A plotted value as read from a row: where it stands on the scale, and how it is said when a number cannot hold it. */
interface ChartReading {
    /** The scale position, or `null` for a reading that is absent (missing, null, empty, or not a number). */
    value: number | null;
    /** The digits as written, kept when a `Number` would round them (beyond 2^53, or past 15 significant digits). */
    exact?: string;
}
/** Shared palette, formatting, responsive container sizing, series legend, and accessible table helpers for SVG charts. */
/** Named data series descriptor shared across cartesian SVG charts. */
export interface ChartSeries {
    key: string;
    label: string;
    color?: string;
}
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
/** Responsive SVG area chart supporting stacked series, smooth splines, interactive tooltips, and accessible table output. */
export declare function AreaChart(props: AreaChartProps): import("react").JSX.Element;
/** Responsive SVG line chart supporting multi-series toggles, smooth splines, interactive crosshairs, and accessible table output. */
export declare function LineChart(props: LineChartProps): import("react").JSX.Element;
/** Responsive SVG bar, stacked-bar, mini-bar, donut, breakdown, and funnel charts. */
/** Props for the `BarChart` component. */
export interface BarChartProps extends CartesianChartBaseProps {
    orientation?: 'vertical' | 'horizontal';
}
/** Props for the `StackedBarChart` component. */
export interface StackedBarChartProps extends CartesianChartBaseProps {
    orientation?: 'vertical' | 'horizontal';
}
/** Responsive grouped SVG bar chart supporting vertical and horizontal orientations, negative values, and accessible table output. */
export declare function BarChart(props: BarChartProps): import("react").JSX.Element;
/** Responsive stacked SVG bar chart supporting vertical and horizontal orientations, negative values, and total tooltips. */
export declare function StackedBarChart(props: StackedBarChartProps): import("react").JSX.Element;
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
export declare function DonutChart(props: DonutChartProps): import("react").JSX.Element;
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
export declare function FunnelChart({ stages, locale, ariaLabel, stepRetentionTitle, formatStep, formatValue: explicitFormatValue, words, className, ref, }: FunnelChartProps): import("react").JSX.Element;
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
export declare function HeatmapMatrix({ rows, columns, values, locale, formatValue: explicitFormatValue, formatScaleValue, min: explicitMin, max: explicitMax, showValues, showScale, cellHeight, ariaLabel, valueLabel, intensityLabel, lowLabel, peakLabel, className, ref, }: HeatmapMatrixProps): import("react").JSX.Element;
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
export declare function RadarChart({ axes, series, min: explicitMin, size: askedSize, levels, showDots, showLegend, locale, seriesLabel, formatValue: explicitFormatValue, ariaLabel, className, ref, }: RadarChartProps): import("react").JSX.Element;
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
/** Circular 180° or 270° SVG arc gauge with threshold tones and reduced-motion compliance. */
export declare function RadialGauge({ value, min, max, arc, size, thickness, label, sublabel, tone: explicitTone, thresholds, invertThresholds, showEndpoints, locale, formatValue, ariaLabel, className, ref, }: RadialGaugeProps): import("react").JSX.Element;
/**
 * Presentational stage-conversion funnel (`FunnelSteps`): renders ordered stages against the first
 * stage's length, optional side-road stages (`optional`), basis share readouts, and interactive
 * drill-through doors (`reached` / `dropped`) while holding layout height steady while counts load.
 */
interface FunnelDoorLink {
    href: string;
    onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
}
/** Interactive stage drill-through action or link on a `FunnelSteps` row. */
export interface FunnelDoor {
    link?: FunnelDoorLink;
    open?: () => void;
}
/** Single ordered stage in a `FunnelSteps` conversion funnel. */
export interface FunnelStep {
    title: string;
    optional?: boolean;
    /** Absent while the answer is on its way. */
    count?: number;
    /** The stage this one is a share of (the last required stage before it), absent on the first. */
    basis: number | null;
    reached?: FunnelDoor;
    dropped?: FunnelDoor;
}
interface FunnelWords {
    summary?: (args: {
        count: number;
        first: string;
        last: string;
    }) => string;
    openReached?: (args: {
        table: string;
        stage: string;
    }) => string;
    openDropped?: (args: {
        table: string;
        stage: string;
    }) => string;
    optional?: string;
    ofBasis?: (args: {
        share: string;
        basis: string;
    }) => string;
    dropped?: (args: {
        figure: string;
    }) => string;
    droppedTitle?: (args: {
        figure: string;
        basis: string;
        stage: string;
    }) => string;
}
/** Props for the `FunnelSteps` component. */
export interface FunnelStepsProps {
    steps: ReadonlyArray<FunnelStep>;
    /** Formatter for stage and drop counts. */
    formatValue?: (value: number) => string;
    locale?: string;
    formatShare?: (percentValue: number) => string;
    table?: string;
    label?: string;
    ariaLabel?: string;
    words?: FunnelWords;
    className?: string;
    ref?: Ref<HTMLDivElement>;
}
/** Stage-conversion funnel with basis share readouts, optional stages, and drill-through doors. */
export declare function FunnelSteps(props: FunnelStepsProps): import("react").JSX.Element;
