/**
 * @mistriwork/ui's primitives rendered to markup, printed: the page e2e/ui-standalone.spec.ts serves with ui's stylesheet
 * alone. Rendered here, under tsx, because Playwright's own JSX transform makes its component-testing nodes, not
 * React's. The root tsconfig, which says `react-jsx`, does not include e2e/, so the pragma says it here.
 */
/** @jsxRuntime automatic */
import { renderToStaticMarkup } from 'react-dom/server';
import { Button } from '../../packages/ui/src/Button.tsx';
import { DateField, type DateFieldWords } from '../../packages/ui/src/DateField.tsx';
import { Field } from '../../packages/ui/src/Field.tsx';
import { Icon, registerIcons } from '../../packages/ui/src/Icon.tsx';
import { Badge, Grid, Person, SegmentedControl, StatCard, StatusDot } from '../../packages/ui/src/primitives.ts';
import {
  AccountSettingsView,
  AppShell,
  CalendarView,
  DataTable,
  GanttView,
  KanbanBoard,
  PageHeader,
  ReviewQueueView,
} from '../../packages/ui/src/views.ts';

const words: DateFieldWords = {
  timePattern: 'HH:MM',
  enterDateAndTime: (format) => `Enter a date and time as ${format}.`,
  enterDate: (format) => `Enter a date as ${format}.`,
  dateAndTimeFormat: (format) => `Date and time format: ${format}.`,
  dateFormat: (format) => `Date format: ${format}.`,
  openWithKeys: 'Alt and Down arrow opens the calendar.',
  chooseDate: (label) => `Choose date${label ? ` for ${label}` : ''}`,
  calendar: (label) => `Calendar${label ? ` for ${label}` : ''}`,
  previousMonth: 'Previous month',
  nextMonth: 'Next month',
  clear: 'Clear',
  today: 'Today',
};

import { APP_ICON_GLYPHS } from '../../packages/engine/src/shared/iconGlyphs.ts';

if (process.argv.includes('--surfaces')) {
  registerIcons(APP_ICON_GLYPHS);
  process.stdout.write(
    renderToStaticMarkup(
      <div className="nx-root">
        <AppShell
          sidebarProps={{
            workspaces: [{ id: 'ops', name: 'Operations' }],
            activeWorkspaceId: 'ops',
            activeItemId: 'overview',
            items: [{ id: 'overview', label: 'Overview' }],
          }}
          breadcrumbs={[{ label: 'Operations' }, { label: 'Schedule' }]}
          header={<PageHeader title="Operations Schedule" description="Desktop and mobile responsive shell" />}
        >
          <Grid columns={3} gap="sm" data-testid="kpi-grid">
            <StatCard label="Active Units" value="148" trend={[120, 134, 148, 152]} />
            <StatCard label="SLA" value="99.4%" delta={{ value: '+0.4%', tone: 'good' }} />
            <StatCard label="Escalations" value="0" />
          </Grid>
          <SegmentedControl
            defaultValue="table"
            options={[
              { value: 'table', label: 'Table' },
              { value: 'calendar', label: 'Calendar' },
              { value: 'gantt', label: 'Gantt' },
            ]}
          />
          <DataTable
            selectable
            rowActions={() => [{ id: 'inspect', label: 'Inspect', onSelect: () => {} }]}
            data={[
              {
                id: '1',
                ref: 'TKT-1042',
                title: 'Replace boiler pressure relief valve in Building B',
                requester: 'Ada Stone',
                assignee: 'Marcus Chen',
                priority: 'Urgent',
                status: 'In Progress',
                sla: '2h 15m',
              },
              {
                id: '2',
                ref: 'TKT-1043',
                title: 'Annual fire panel inspection and sensor calibration',
                requester: 'Elena Rostova',
                assignee: 'Priya Nair',
                priority: 'Medium',
                status: 'Scheduled',
                sla: '1d 4h',
              },
            ]}
            columns={[
              { id: 'ref', header: 'Ticket', accessor: 'ref', sortable: true, width: 96, mono: true },
              { id: 'title', header: 'Subject', accessor: 'title', sortable: true },
              { id: 'requester', header: 'Requester', accessor: 'requester', width: 120 },
              { id: 'assignee', header: 'Assignee', cell: (r) => <Person name={r.assignee} size="xs" />, width: 132 },
              {
                id: 'priority',
                header: 'Priority',
                sortable: true,
                width: 90,
                cell: (r) => <Badge tone={r.priority === 'Urgent' ? 'critical' : 'warning'}>{r.priority}</Badge>,
              },
              { id: 'status', header: 'Status', width: 118, cell: (r) => <StatusDot tone="info">{r.status}</StatusDot> },
              { id: 'sla', header: 'SLA', accessor: 'sla', align: 'right', width: 84, mono: true },
            ]}
            getRowId={(r) => r.id}
          />
          <div data-testid="kanban-wrap">
            <KanbanBoard
              columns={[
                { id: 'triage', title: 'Triage', tone: 'neutral' },
                { id: 'open', title: 'Open', tone: 'info' },
                { id: 'working', title: 'In Progress', tone: 'warning' },
                { id: 'review', title: 'Review', tone: 'accent' },
                { id: 'done', title: 'Resolved', tone: 'good' },
              ]}
              cards={[
                { id: 'k1', code: 'TKT-101', title: 'Lobby intercom audio drop', priority: 'high', assignee: { name: 'Ada Stone' } },
                { id: 'k2', code: 'TKT-102', title: 'Roof membrane inspection', priority: 'medium', assignee: { name: 'Marcus Chen' } },
                { id: 'k3', code: 'TKT-103', title: 'Elevator cab lighting', priority: 'low', assignee: { name: 'Priya Nair' } },
              ]}
              defaultValue={{ triage: ['k1'], open: ['k2'], working: ['k3'], review: [], done: [] }}
            />
          </div>
          <div data-testid="review-wrap">
            <ReviewQueueView
              items={[
                {
                  id: 'rq-1',
                  code: 'APR-204',
                  title: 'Emergency HVAC compressor replacement quote',
                  category: 'Vendor Quote',
                  priority: 'high',
                  submittedAt: '14m ago',
                  requester: { name: 'Marcus Chen', role: 'Lead Technician' },
                  summary: 'Replace failed rooftop compressor unit on West Wing loop before weekend freeze.',
                  diffs: [
                    { field: 'Approved vendor', before: 'Unassigned', after: 'Northstar Mechanical Services LLC', changeType: 'modified' },
                    { field: 'Authorized ceiling', before: '$2,500.00', after: '$6,840.00', changeType: 'modified' },
                  ],
                },
              ]}
            />
          </div>
          <div data-testid="account-wrap">
            <AccountSettingsView
              profile={{
                name: 'Ada Stone',
                email: 'ada@northwind.example',
                role: 'Owner',
                workspaceName: 'Operations',
                twoFactorEnabled: true,
                passkeyRegistered: true,
                passkeyLabel: 'Hardware Security Key · Added Oct 14',
              }}
              sessions={[
                {
                  id: 'sess-current',
                  deviceType: 'laptop',
                  client: 'Chrome on macOS',
                  ip: '198.51.100.42',
                  location: 'Chicago, US',
                  lastActive: 'Active now',
                  current: true,
                },
                {
                  id: 'sess-mobile',
                  deviceType: 'mobile',
                  client: 'Safari on iOS',
                  ip: '203.0.113.89',
                  location: 'Chicago, US',
                  lastActive: '2 hours ago',
                },
              ]}
              availableScopes={[
                { value: 'records:read', label: 'records:read' },
                { value: 'records:write', label: 'records:write' },
                { value: 'workflows:run', label: 'workflows:run' },
              ]}
              tokens={[
                {
                  id: 'tok-sync',
                  name: 'Dispatch Sync Worker',
                  prefix: 'token_9f4e2a••••••••',
                  scopes: ['records:read', 'records:write'],
                  createdAt: 'Jan 12, 2026',
                  expiresAt: 'Jan 12, 2027',
                  lastUsed: '4 minutes ago',
                },
              ]}
              members={[
                { id: 'mem-1', name: 'Ada Stone', email: 'ada@northwind.example', role: 'Owner', status: 'active' },
                { id: 'mem-2', name: 'Marcus Chen', email: 'marcus@northwind.example', role: 'Admin', status: 'active' },
              ]}
              domains={[
                {
                  id: 'dom-1',
                  domain: 'ops.northwind.example',
                  cnameTarget: 'cname.example.com',
                  verified: true,
                  tlsStatus: 'active',
                  primary: true,
                },
              ]}
            />
          </div>
          <CalendarView
            defaultSelectedDate="2026-09-14"
            events={[{ id: 'ev1', title: 'Inspection', date: '2026-09-14', startMinutes: 540, endMinutes: 600 }]}
          />
          <GanttView tasks={[{ id: 'g1', name: 'Phase 1', start: 1, end: 8 }]} />
          <div data-theme="dark" data-testid="dark-island">
            <span>Scoped dark island</span>
          </div>
        </AppShell>
      </div>,
    ),
  );
} else {
  registerIcons({ check: [['M0 0h256v256H0z'], ['M0 0h256v256H0z']] });
  process.stdout.write(
    renderToStaticMarkup(
      <main>
        <Button variant="primary">Save</Button>
        <Button variant="secondary" size="sm" data-host="">
          Cancel
        </Button>
        <Field label="Name" hint="As it is written.">
          {(control) => <input {...control} data-slot="input" />}
        </Field>
        <Icon name="check" />
        <DateField
          id="due"
          ariaLabel="Due"
          value="2026-09-13"
          onValueChange={() => {}}
          locale="en-US"
          words={words}
          calendarIcon={<Icon name="check" />}
        />
      </main>,
    ),
  );
}
