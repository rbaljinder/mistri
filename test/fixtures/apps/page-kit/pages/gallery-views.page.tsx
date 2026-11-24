/** Runtime gallery page for operational workspace views (`/gallery-views`). */
import { Card, Stack, Text, definePage } from '@mistriwork/mistri/page';
import { FormColumns } from '@mistriwork/mistri/primitives';
import {
  ActivityTimeline,
  CalendarView,
  CardGridView,
  DataTable,
  FilterBar,
  GanttView,
  KanbanBoard,
  PageHeader,
  ReviewQueueView,
  SplitView,
  TreeView,
  WaterfallView,
} from '@mistriwork/mistri/views';

const ORDERS = [
  { id: 'WO-101', asset: 'Boiler Feed Pump A', technician: 'Ana Ruiz', status: 'In progress', hours: 3.5 },
  { id: 'WO-102', asset: 'Chiller Loop Valve 4', technician: 'Ben Okafor', status: 'Scheduled', hours: 2.0 },
  { id: 'WO-103', asset: 'Compressor Air Dryer', technician: 'Cy Marlow', status: 'Completed', hours: 1.5 },
];

export default definePage({
  label: 'Gallery views',
  nav: false,
  reads: ['deal'],
  head: false,
  component: GalleryViews,
});

function GalleryViews() {
  return (
    <Stack>
      <PageHeader
        title="Field operations workspace"
        description="Schedule, dispatch lanes, asset hierarchy, and triage approvals."
        back={{ label: 'Parts', href: '/parts' }}
      />

      <Card title="FilterBar & DataTable">
        <FilterBar
          ariaLabel="Work order filters"
          facets={[
            {
              id: 'status',
              label: 'Status',
              options: [
                { value: 'open', label: 'Open', count: 8 },
                { value: 'done', label: 'Completed', count: 14 },
              ],
            },
          ]}
        />
        <DataTable
          ariaLabel="Active work orders"
          data={ORDERS}
          getRowId={(r) => r.id}
          columns={[
            { id: 'id', header: 'Order', accessor: 'id', mono: true },
            { id: 'asset', header: 'Asset', accessor: 'asset', sortable: true },
            { id: 'technician', header: 'Technician', accessor: 'technician' },
            { id: 'hours', header: 'Est. hours', accessor: 'hours', align: 'right' },
          ]}
        />
      </Card>

      <Card title="CardGridView">
        <CardGridView
          ariaLabel="Station cards"
          columns={3}
          items={[
            {
              id: 's1',
              code: 'NORTH-01',
              title: 'Boiler House A',
              subtitle: 'Primary steam loop',
              status: { label: 'Nominal', tone: 'good' },
              assignee: { name: 'Ana Ruiz', role: 'Lead Millwright' },
            },
            {
              id: 's2',
              code: 'EAST-04',
              title: 'Compressor Bay',
              subtitle: 'Pneumatic header',
              status: { label: 'Inspect', tone: 'warning' },
              assignee: { name: 'Ben Okafor', role: 'Controls Tech' },
            },
          ]}
        />
      </Card>

      <Card title="KanbanBoard">
        <KanbanBoard
          ariaLabel="Dispatch board"
          columns={[
            { id: 'queued', title: 'Queued', wipLimit: 4 },
            { id: 'active', title: 'On site', tone: 'info', wipLimit: 3 },
            { id: 'done', title: 'Verified', tone: 'good' },
          ]}
          cards={[
            { id: 'k1', code: 'WO-101', title: 'Seal replacement', priority: 'high', assignee: { name: 'Ana Ruiz' } },
            { id: 'k2', code: 'WO-102', title: 'Pressure calibration', priority: 'medium', assignee: { name: 'Ben Okafor' } },
            { id: 'k3', code: 'WO-103', title: 'Filter changeout', priority: 'low', assignee: { name: 'Cy Marlow' } },
          ]}
          defaultValue={{ queued: ['k2'], active: ['k1'], done: ['k3'] }}
        />
      </Card>

      <FormColumns columns={2}>
        <Card title="CalendarView">
          <CalendarView
            defaultMode="week"
            defaultSelectedDate="2026-09-04"
            today="2026-09-04"
            scheduleHeight={320}
            events={[
              { id: 'e1', title: 'Pump alignment', date: '2026-09-04', startMinutes: 540, endMinutes: 630, tone: 'info' },
              { id: 'e2', title: 'Safety audit', date: '2026-09-05', allDay: true, tone: 'good' },
            ]}
          />
        </Card>
        <Card title="TreeView">
          <TreeView
            ariaLabel="Asset hierarchy"
            defaultExpandedIds={['campus']}
            nodes={[
              {
                id: 'campus',
                label: 'North Campus',
                badge: 2,
                children: [
                  { id: 'pump-1', label: 'Feed Pump A', tone: 'good' },
                  { id: 'valve-4', label: 'Bypass Valve 4', tone: 'warning' },
                ],
              },
            ]}
          />
        </Card>
      </FormColumns>

      <FormColumns columns={2}>
        <Card title="GanttView">
          <GanttView
            ariaLabel="Outage schedule"
            startDate="2026-09-01"
            tasks={[
              { id: 't1', name: 'Lockout & drain', owner: 'Ana Ruiz', start: 0, end: 3, progress: 100, tone: 'good' },
              { id: 't2', name: 'Impeller swap', owner: 'Ben Okafor', start: 3, end: 8, progress: 50, tone: 'info' },
            ]}
          />
        </Card>
        <Card title="WaterfallView">
          <WaterfallView
            ariaLabel="Telemetry sync trace"
            items={[
              {
                value: 'root',
                label: 'POST /api/dispatch',
                start: 0,
                duration: 140,
                service: 'gateway',
                tone: 'good',
                children: [{ value: 'db', label: 'SELECT crew_schedule', start: 12, duration: 48, service: 'sqlite', tone: 'info' }],
              },
            ]}
          />
        </Card>
      </FormColumns>

      <FormColumns columns={2}>
        <Card title="SplitView">
          <SplitView
            listAriaLabel="Dispatch queue"
            detailAriaLabel="Selected work order"
            height={280}
            items={[
              { id: 'wo-1', code: 'WO-101', title: 'Boiler Feed Pump A', subtitle: 'Zone North', tone: 'info' },
              { id: 'wo-2', code: 'WO-102', title: 'Chiller Loop Valve 4', subtitle: 'Zone East', tone: 'good' },
            ]}
            defaultValue="wo-1"
            renderDetail={(item) => <Text>{item.title} — assigned for inspection.</Text>}
          />
        </Card>
        <Card title="ActivityTimeline">
          <ActivityTimeline
            showComposer={false}
            items={[
              {
                id: 'a1',
                kind: 'event',
                author: { name: 'Ana Ruiz' },
                timestamp: '10m ago',
                action: 'marked lockout verified',
              },
              {
                id: 'a2',
                kind: 'comment',
                author: { name: 'Ben Okafor' },
                timestamp: '4m ago',
                body: 'Replacement seal kit staged at Bay 2.',
              },
            ]}
          />
        </Card>
      </FormColumns>

      <Card title="ReviewQueueView">
        <ReviewQueueView
          ariaLabel="Parts requisition approvals"
          enableShortcuts={false}
          items={[
            {
              id: 'rq-1',
              code: 'REQ-44',
              title: 'Spare mechanical seal kit',
              priority: 'high',
              requester: { name: 'Ana Ruiz', role: 'Lead Millwright' },
              summary: 'Replace scored silicon-carbide seal face on Boiler Feed Pump A.',
              diffs: [{ field: 'Quantity', before: '1', after: '2', changeType: 'modified' }],
            },
          ]}
        />
      </Card>
    </Stack>
  );
}
