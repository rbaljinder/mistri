import { action, defineFeature, fields, listView, me, now, page, queue, related } from '@mistriwork/mistri/app';
import type { Feature } from '../mistri-schema.d.ts';

/* Timesheets are submitted by hourly teammates and approved here, one at a
   time from the sheet or several at once from Today's queue: each selected
   sheet is its own write, stamped with its approver and the moment. A sheet
   is opened and submitted where the time is kept, not in Payday, so it has
   no machine here: a graph whose first step no one in the App can take would
   be a road with its start missing. */
const approveSheet = action('Approve timesheet', {
  set: { status: 'approved', approved_by: me, approved_at: now },
  when: 'status = submitted',
  bulk: true,
});

const sheetStatus = { tone: { open: 'neutral', submitted: 'warn', approved: 'good' } } as const;

export const timeTracking = defineFeature({
  id: 'time',
  resources: {
    timesheet: {
      segments: {
        to_approve: 'status = submitted',
        in_progress: 'status = open',
        approved: 'status = approved',
      },
      access: 'write',
      recordLabel: 'employee_id.name',
      labels: {
        week_start: 'Week of',
        week_end: 'Week ends',
        regular_hours: 'Regular',
        overtime_hours: 'Overtime',
      },
      display: { status: sheetStatus },
      actions: { approve: approveSheet },
    },
    time_entry: {
      recordLabel: 'work_date',
      labels: { work_date: 'Day' },
    },
  },
  auth: { roles: { admin: { actions: { timesheet: ['approve'] } }, payroll_manager: { actions: { timesheet: ['approve'] } } } },
  views: {
    timesheets: listView('Timesheets', 'timesheet', {
      icon: 'clock',
      show: ['employee_id.name', 'week_start', 'regular_hours', 'overtime_hours', 'total_hours', 'status'],
      filters: ['employee_id', 'week_start'],
      tabs: [
        { segment: 'to_approve', sort: 'week_start' },
        { segment: 'in_progress', sort: 'week_start' },
        { segment: 'approved', sort: 'week_start desc' },
        { label: 'All', sort: 'week_start desc' },
      ],
      totals: ['regular_hours', 'overtime_hours', 'total_hours'],
      rowActions: true,
      empty: { title: 'No timesheets yet', description: 'Hourly teammates’ weekly timesheets appear here once they start tracking time.' },
    }),
  },
  pages: {
    timesheet: page('timesheet', [
      fields(['total_hours', 'regular_hours', 'overtime_hours'], { title: 'Week totals', columns: 3 }),
      related('Hours by day', 'time_entry', 'timesheet_id', { show: ['work_date', 'hours', 'note'], sort: 'work_date' }),
      fields(['week_start', 'week_end', 'submitted_on'], { title: 'Week', region: 'aside' }),
      fields(['employee_id', 'employee_id.title', 'employee_id.pay_rate', 'employee_id.location'], { title: 'Teammate', region: 'aside' }),
      fields(['approved_by', 'approved_at'], { title: 'Approval', region: 'aside', when: 'status = approved' }),
    ]),
  },
  nav: ['timesheets'],
} satisfies Feature);

/** Today's queue: a selection approves together. */
export const timesheetTasks = listView('Timesheets to approve', 'timesheet', {
  empty: {
    title: 'Timesheets are approved',
    description: 'Submitted timesheets will appear here.',
    action: { label: 'View timesheets', to: 'timesheets' },
  },
  query: 'to_approve',
  sort: 'week_start',
  presentation: queue('employee_id.name', {
    badge: 'status',
    lines: ['week_start'],
    properties: ['regular_hours', 'overtime_hours', 'total_hours'],
    openLabel: 'Review timesheet',
  }),
  open: 'modal',
});
