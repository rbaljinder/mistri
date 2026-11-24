import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  AreaChart,
  BarChart,
  BreakdownList,
  DonutChart,
  FunnelChart,
  HeatmapMatrix,
  LineChart,
  MiniBars,
  RadarChart,
  RadialGauge,
  Sparkline,
  StackedBarChart,
  type AreaChartProps,
  type BarChartProps,
  type BreakdownItem,
  type BreakdownListProps,
  type CartesianChartBaseProps,
  type ChartSeries,
  type DonutChartProps,
  type DonutSegment,
  type FunnelChartProps,
  type FunnelStage,
  type HeatmapCellCoord,
  type HeatmapMatrixProps,
  type LineChartProps,
  type MiniBarDatum,
  type MiniBarsProps,
  type RadarAxis,
  type RadarChartProps,
  type RadarSeries,
  type RadialGaugeArc,
  type RadialGaugeProps,
  type RadialGaugeThreshold,
  type SparklineProps,
  type StackedBarChartProps,
} from './charts.js';
import { CHART_PALETTE, chartColorAt } from './charts/chartShared.js';

describe('@mistriwork/ui/charts.js telemetry suite', () => {
  it('renders all 12 zero-dependency SVG chart primitives', () => {
    expect(CHART_PALETTE).toHaveLength(6);
    expect(chartColorAt(0)).toBe('var(--chart-1, var(--accent))');
    expect(chartColorAt(1, '#2455df')).toBe('#2455df');

    const series: ChartSeries[] = [
      { key: 'settled', label: 'Settled' },
      { key: 'open', label: 'Open' },
    ];
    const rows = [
      { month: 'Jan', settled: 42, open: 8 },
      { month: 'Feb', settled: 51, open: 6 },
      { month: 'Mar', settled: 64, open: 4 },
    ];
    const base: CartesianChartBaseProps = { data: rows, xKey: 'month', series };
    const areaProps: AreaChartProps = { ...base, curve: 'smooth' };
    const lineProps: LineChartProps = { ...base, showDots: true };
    const barProps: BarChartProps = { ...base };
    const stackedProps: StackedBarChartProps = { ...base };
    const sparkProps: SparklineProps = { data: [12, 18, 15, 29], fill: true };
    const miniDatum: MiniBarDatum = { label: 'Mon', value: 14, tone: 'accent' };
    const miniProps: MiniBarsProps = { data: [miniDatum, 22, 19] };
    const segment: DonutSegment = { label: 'Active', value: 78 };
    const donutProps: DonutChartProps = { data: [segment, { label: 'Idle', value: 22 }], centerValue: '100' };
    const bItem: BreakdownItem = { label: 'ACH', value: 64 };
    const breakdownProps: BreakdownListProps = { items: [bItem, { label: 'Wire', value: 36 }] };
    const stage: FunnelStage = { label: 'Submitted', value: 120 };
    const funnelProps: FunnelChartProps = { stages: [stage, { label: 'Approved', value: 84 }] };
    const coord: HeatmapCellCoord = { rowIndex: 0, colIndex: 1 };
    const heatmapProps: HeatmapMatrixProps = {
      rows: ['Mon', 'Tue'],
      columns: ['09h', '15h'],
      values: [
        [4, 9],
        [7, 3],
      ],
    };
    const axes: RadarAxis[] = [{ label: 'Latency' }, { label: 'Throughput' }, { label: 'Uptime' }];
    const rSeries: RadarSeries[] = [{ label: 'Cluster A', values: [88, 92, 99] }];
    const radarProps: RadarChartProps = { axes, series: rSeries };
    const arc: RadialGaugeArc = 270;
    const thresholds: RadialGaugeThreshold[] = [
      { upTo: 80, tone: 'warning' },
      { upTo: 100, tone: 'good' },
    ];
    const gaugeProps: RadialGaugeProps = { value: 96, arc, thresholds, label: 'SLA' };
    expect(coord.colIndex).toBe(1);

    const { container } = render(
      <div>
        <Sparkline {...sparkProps} />
        <AreaChart {...areaProps} />
        <LineChart {...lineProps} />
        <BarChart {...barProps} />
        <StackedBarChart {...stackedProps} />
        <MiniBars {...miniProps} />
        <DonutChart {...donutProps} />
        <BreakdownList {...breakdownProps} />
        <FunnelChart {...funnelProps} />
        <HeatmapMatrix {...heatmapProps} />
        <RadarChart {...radarProps} />
        <RadialGauge {...gaugeProps} />
      </div>,
    );

    expect(container.querySelectorAll('svg').length).toBeGreaterThanOrEqual(8);
    expect(container.querySelector('.kit-minibars')).not.toBeNull();
  });
});
