/** Runtime gallery page for all 13 chart primitives including negative, single-point, and >2^53 edge data (`/gallery-charts`). */
import {
  AreaChart,
  BarChart,
  BreakdownList,
  DonutChart,
  FunnelChart,
  FunnelSteps,
  HeatmapMatrix,
  LineChart,
  MiniBars,
  RadarChart,
  RadialGauge,
  Sparkline,
  StackedBarChart,
} from '@mistriwork/mistri/charts';
import { Card, Cluster, Stack, definePage } from '@mistriwork/mistri/page';
import { FormColumns } from '@mistriwork/mistri/primitives';

const EDGE_SERIES = [{ key: 'net', label: 'Net thermal delta' }];
const EDGE_POINTS = [
  { x: 'Mon', net: -5 },
  { x: 'Tue', net: 0 },
  { x: 'Wed', net: 10 },
  { x: 'Thu', net: -2 },
  { x: 'Fri', net: 14 },
];

const DENSE_POINTS = Array.from({ length: 16 }, (_, idx) => ({
  x: `2026-09-${String(idx + 1).padStart(2, '0')}`,
  load: (idx % 5) * 8 - 4,
}));

export default definePage({
  label: 'Gallery charts',
  nav: false,
  reads: ['deal'],
  component: GalleryCharts,
});

function GalleryCharts() {
  return (
    <Stack>
      <Cluster min="16rem">
        <Card title="Sparkline (mixed & single point)">
          <Sparkline ariaLabel="Net delta trend" data={[-5, 0, 10, 4, 12]} />
          <Sparkline ariaLabel="Single reading" data={[7]} />
        </Card>
        <Card title="MiniBars (negative & positive)">
          <MiniBars ariaLabel="Bay variance" data={[-5, 0, 10, -3, 8]} />
        </Card>
        <Card title="RadialGauge">
          <RadialGauge label="SLA compliance" value={94.2} max={100} formatValue={(v) => `${v}%`} tone="good" />
        </Card>
      </Cluster>

      <FormColumns columns={2}>
        <Card title="LineChart (negative baseline & dense x-axis)">
          <LineChart
            ariaLabel="Daily thermal variance"
            data={DENSE_POINTS}
            xKey="x"
            series={[{ key: 'load', label: 'Delta °C' }]}
            height={220}
          />
        </Card>
        <Card title="AreaChart (single point & mixed)">
          <AreaChart ariaLabel="Net energy flow" data={EDGE_POINTS} xKey="x" series={EDGE_SERIES} height={220} />
        </Card>
        <Card title="BarChart (negative values)">
          <BarChart ariaLabel="Net margin by day" data={EDGE_POINTS} xKey="x" series={EDGE_SERIES} height={220} />
        </Card>
        <Card title="StackedBarChart">
          <StackedBarChart
            ariaLabel="Work orders by shift"
            data={[
              { shift: 'Day', preventive: 14, corrective: 4 },
              { shift: 'Swing', preventive: 9, corrective: 6 },
              { shift: 'Night', preventive: 5, corrective: 2 },
            ]}
            xKey="shift"
            series={[
              { key: 'preventive', label: 'Preventive' },
              { key: 'corrective', label: 'Corrective' },
            ]}
            height={220}
          />
        </Card>
        <Card title="DonutChart (filters non-positive slices)">
          <DonutChart
            ariaLabel="Ticket mix"
            data={[
              { label: 'Completed', value: 42 },
              { label: 'Scheduled', value: 18 },
              { label: 'Zero slice', value: 0 },
              { label: 'Negative adjustment', value: -5 },
            ]}
          />
        </Card>
        <Card title="BreakdownList (total, showPercent & >2^53)">
          <BreakdownList
            ariaLabel="Quota consumption"
            total={100}
            showPercent
            items={[
              { id: 'north', label: 'North Campus', value: 45, note: '9007199254740993' },
              { id: 'south', label: 'South Depot', value: 30 },
              { id: 'credit', label: ' Rebate adjustment', value: -5 },
            ]}
          />
        </Card>
        <Card title="FunnelChart & FunnelSteps">
          <FunnelChart
            ariaLabel="Conversion funnel"
            stages={[
              { label: 'Dispatched', value: 120 },
              { label: 'On site', value: 96 },
              { label: 'Resolved first visit', value: 84 },
              { label: 'Zero stage', value: 0 },
            ]}
          />
          <FunnelSteps
            ariaLabel="Step conversion"
            steps={[
              { title: 'Logged', count: 50, basis: null },
              { title: 'Verified', count: 35, basis: 50 },
            ]}
          />
        </Card>
        <Card title="RadarChart & HeatmapMatrix">
          <RadarChart
            ariaLabel="Crew readiness dimensions"
            axes={[{ label: 'Safety' }, { label: 'Response' }, { label: 'First-fix' }, { label: 'Notes' }]}
            series={[{ id: 'north', label: 'North Crew', values: [92, 85, 88, 79] }]}
          />
          <HeatmapMatrix
            ariaLabel="Hourly dispatch density"
            rows={['Mon', 'Tue', 'Wed']}
            columns={['08:00', '12:00', '16:00']}
            values={[
              [2, 8, 5],
              [4, 12, 9],
              [1, 6, 3],
            ]}
          />
        </Card>
      </FormColumns>
    </Stack>
  );
}
