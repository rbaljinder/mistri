import '@mistriwork/ui/style.css';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { AreaChart, BarChart, RadialGauge, Sparkline } from '@mistriwork/ui/charts.js';
import { AiBadge, Button, Card, CardBody, Grid, Row, SegmentedControl, Stack, StatCard, StatusDot } from '@mistriwork/ui/primitives.js';
import { CalendarView, DataTable, GanttView, KanbanBoard } from '@mistriwork/ui/views.js';

const meta = {
  title: 'Standalone Surfaces Suite',
  parameters: { layout: 'padded' },
} satisfies Meta;
export default meta;

export const TelemetryAndKpis: StoryObj = {
  render: () => (
    <Stack gap="md">
      <Grid columns={3} gap="sm">
        <StatCard
          label="Net Retention"
          value="118.4%"
          delta={{ value: '+4.2%', direction: 'up' }}
          sparkline={<Sparkline data={[98, 104, 111, 118]} />}
        />
        <StatCard label="Open Incidents" value="3" delta={{ value: '-2', direction: 'down', tone: 'good' }} />
        <StatCard label="p95 Latency" value="42 ms" hint="Denver edge" />
      </Grid>
      <Grid columns={2} gap="md">
        <Card>
          <CardBody>
            <AreaChart
              data={[
                { week: 'W1', settled: 42, queued: 9 },
                { week: 'W2', settled: 58, queued: 7 },
                { week: 'W3', settled: 67, queued: 5 },
              ]}
              xKey="week"
              series={[
                { key: 'settled', label: 'Settled' },
                { key: 'queued', label: 'Queued' },
              ]}
              height={180}
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Row justify="between" align="center">
              <BarChart
                data={[
                  { desk: 'North', count: 34 },
                  { desk: 'West', count: 28 },
                ]}
                xKey="desk"
                series={[{ key: 'count', label: 'Assigned' }]}
                height={160}
              />
              <RadialGauge value={96} arc={270} label="SLA" />
            </Row>
          </CardBody>
        </Card>
      </Grid>
    </Stack>
  ),
};

export const ScopedThemeIslands: StoryObj = {
  render: () => (
    <Grid columns={2} gap="md">
      <Card>
        <CardBody>
          <Row justify="between" align="center">
            <strong>Precision Light</strong>
            <AiBadge label="Verified" />
          </Row>
          <SegmentedControl
            defaultValue="day"
            options={[
              { value: 'day', label: 'Day' },
              { value: 'week', label: 'Week' },
            ]}
          />
        </CardBody>
      </Card>
      <div
        data-theme="dark"
        style={{
          padding: 16,
          borderRadius: 'var(--radius)',
          background: 'var(--surface)',
          color: 'var(--ink)',
          border: '1px solid var(--line)',
        }}
      >
        <Row justify="between" align="center">
          <strong>Obsidian Island</strong>
          <StatusDot tone="good">Online</StatusDot>
        </Row>
        <div style={{ marginTop: 12 }}>
          <Button variant="primary" size="sm">
            Deploy preview
          </Button>
        </div>
      </div>
    </Grid>
  ),
};

export const CompositeViews: StoryObj = {
  render: () => (
    <Stack gap="lg">
      <DataTable
        data={[
          { id: '1', unit: '302B', resident: 'Maya Okafor', status: 'Active' },
          { id: '2', unit: '114A', resident: 'Robin Bell', status: 'Renewal' },
        ]}
        columns={[
          { id: 'unit', header: 'Unit', accessor: 'unit', sortable: true },
          { id: 'resident', header: 'Resident', accessor: 'resident' },
          { id: 'status', header: 'Status', accessor: 'status' },
        ]}
        getRowId={(r) => r.id}
      />
      <KanbanBoard
        columns={[
          { id: 'todo', title: 'Queued', tone: 'neutral' },
          { id: 'active', title: 'On Site', tone: 'info' },
        ]}
        cards={[
          { id: 'c1', code: 'REP-12', title: 'Boiler pressure valve' },
          { id: 'c2', code: 'REP-19', title: 'North entry keypad' },
        ]}
        defaultValue={{ todo: ['c1'], active: ['c2'] }}
      />
      <CalendarView
        defaultSelectedDate="2026-09-14"
        events={[{ id: 'e1', title: 'Boiler inspection', date: '2026-09-14', startMinutes: 540, endMinutes: 600, tone: 'info' }]}
      />
      <GanttView
        tasks={[
          { id: 't1', code: 'M1', name: 'Roof membrane', start: 1, end: 8, tone: 'accent' },
          { id: 't2', code: 'M2', name: 'Solar array', start: 7, end: 16, tone: 'good' },
        ]}
      />
    </Stack>
  ),
};
