import { calendar, defineFeature, fields, listView, machine, metric, navGroup, page, queue, related } from '@mistriwork/mistri/app';
import type { Feature } from '../mistri-schema.d.ts';

/* A request waits, then is approved or declined, and nothing moves it after.
   Approving spends the hours from the teammate's balance for the policy, in
   the same transaction, so it is a command. Declining only sets the status
   and keeps the reason on the request: a fixed verb, granted by name. */
const declineRequest = { to: 'declined', label: 'Decline request', reason: 'decision_note' } as const;
const requestMachine = machine('status', {
  pending: { on: { approveTimeOff: { to: 'approved', label: 'Approve request' }, declineRequest } },
  approved: { final: true },
  declined: { final: true },
});

export const timeOff = defineFeature({
  id: 'timeoff',
  resources: {
    time_off: {
      segments: {
        needs_review: 'status = pending',
        upcoming: 'status = approved and end_date >= today',
        approved_requests: { query: 'status = approved', label: 'Approved' },
        declined_requests: { query: 'status = declined', label: 'Declined' },
      },
      noun: 'time off request',
      access: 'write',
      recordLabel: 'employee_id.name',
      labels: {
        start_date: 'Starts',
        end_date: 'Ends',
        note: 'Request note',
      },
      display: { status: { tone: { pending: 'warn', approved: 'good', declined: 'bad' } } },
      machine: requestMachine,
      /* The teammate hears the decision whichever door made it: the command that approves, or the verb that
         declines. A machine's edge is a change of its column, so one rule covers both. */
      notify: [
        {
          on: { changes: 'status' },
          when: 'status = approved or status = declined',
          to: 'employee_id.email',
          title: 'Your time off from {start_date} was {status}',
        },
      ],
    },
    time_off_policy: {
      labels: { name: 'Policy', kind: 'Type', annual_hours: 'Hours a year', carryover_hours: 'Carryover' },
    },
    time_off_balance: {
      access: 'write',
      recordLabel: 'policy_id.name',
      labels: { accrued_hours: 'Accrued', used_hours: 'Used', available_hours: 'Available' },
    },
  },
  auth: {
    roles: {
      admin: { commands: ['approveTimeOff'], actions: { time_off: ['declineRequest'] } },
      payroll_manager: { commands: ['approveTimeOff'], actions: { time_off: ['declineRequest'] } },
    },
  },
  views: {
    timeoff: listView('Requests', 'time_off', {
      icon: 'calendar-check',
      show: ['employee_id.name', 'policy_id.name', 'start_date', 'end_date', 'hours', 'status'],
      filters: ['policy_id', 'employee_id'],
      tabs: [
        { segment: 'needs_review', sort: 'start_date' },
        { segment: 'upcoming', sort: 'start_date' },
        { segment: 'approved_requests', sort: 'start_date desc' },
        { segment: 'declined_requests', sort: 'start_date desc' },
        { label: 'All', sort: 'start_date desc' },
      ],
      empty: { title: 'No requests in this view', description: 'Choose another tab to see more time off requests.' },
    }),
    /* Each request is a bar from its first day to its last, named for the
       teammate, its status a dot before the name, its policy under it. */
    'timeoff-calendar': listView('Who’s out', 'time_off', {
      icon: 'calendar',
      query: 'status = approved or status = pending',
      presentation: calendar('start_date', 'employee_id.name', { end: 'end_date', badge: 'status', lines: ['policy_id.name'] }),
    }),
    balances: listView('Balances', 'time_off_balance', {
      icon: 'clock',
      density: 'compact',
      show: ['employee_id.name', 'policy_id.name', 'accrued_hours', 'used_hours', 'available_hours'],
      sort: 'employee_id, policy_id',
      filters: ['policy_id', 'employee_id'],
    }),
    policies: listView('Policies', 'time_off_policy', {
      icon: 'clipboard-text',
      density: 'compact',
      show: ['name', 'accrual', 'annual_hours', 'carryover_hours', 'paid'],
      sort: 'id',
    }),
  },
  pages: {
    'time-off': page(
      'time_off',
      [
        fields(['policy_id', 'hours', 'start_date', 'end_date', 'status'], { title: 'Request details', columns: 3 }),
        fields(['note'], { title: 'Request note', columns: 1, when: 'note != ""' }),
        fields(['decision_note'], { title: 'Why it was declined', columns: 1, when: 'status = declined' }),
        related(
          'Balances',
          'time_off_balance',
          { same: ['employee_id'] },
          { show: ['policy_id.name', 'accrued_hours', 'used_hours', 'available_hours'], sort: 'policy_id' },
        ),
        related(
          'Other requests',
          'time_off',
          { same: ['employee_id'] },
          { show: ['policy_id.name', 'start_date', 'hours', 'status'], sort: 'start_date desc', limit: 5 },
        ),
        fields(['employee_id', 'employee_id.title', 'employee_id.location'], { title: 'Teammate', region: 'aside' }),
      ],
      { listTabs: true },
    ),
    'time-off-policy': page(
      'time_off_policy',
      [
        fields(['kind', 'accrual', 'annual_hours', 'carryover_hours', 'paid'], {
          title: 'Policy rules',
          presentation: 'table',
          columns: 2,
        }),
        metric('Pending requests', 'time_off', { whose: 'policy_id', query: 'status = pending', width: 'half' }),
        metric('Approved this year', 'time_off', { whose: 'policy_id', query: 'status = approved', width: 'half' }),
        related('Balances', 'time_off_balance', 'policy_id', {
          show: ['employee_id.name', 'accrued_hours', 'used_hours', 'available_hours'],
          sort: 'employee_id',
        }),
        related('Requests', 'time_off', 'policy_id', {
          show: ['employee_id.name', 'start_date', 'end_date', 'hours', 'status'],
          sort: 'start_date desc',
          limit: 10,
        }),
      ],
      { listTabs: true },
    ),
    'time-off-balance': page('time_off_balance', [
      fields(['available_hours', 'accrued_hours', 'used_hours'], { title: 'Balance', columns: 3 }),
      // The teammate's requests against this balance's policy: its reference and a second key.
      related(
        'Requests against this balance',
        'time_off',
        { same: ['employee_id', 'policy_id'] },
        {
          show: ['start_date', 'end_date', 'hours', 'status'],
          sort: 'start_date desc',
          empty: {
            title: 'No requests against this balance',
            description: 'Requests for this policy appear here once the teammate makes one.',
          },
        },
      ),
      fields(['employee_id', 'policy_id', 'policy_id.accrual'], { title: 'Teammate and policy', region: 'aside' }),
    ]),
  },
  nav: [navGroup('timeoff-menu', 'Time off', ['timeoff', 'timeoff-calendar', 'balances', 'policies'], { icon: 'calendar-check' })],
} satisfies Feature);

/** Today's queue of requests waiting on a decision. */
export const timeOffTasks = listView('Time off to review', 'time_off', {
  empty: {
    title: 'All requests reviewed',
    description: 'New time off requests will appear here.',
    action: { label: 'View time off', to: 'timeoff' },
  },
  query: 'needs_review',
  sort: 'start_date',
  presentation: queue('employee_id.name', {
    badge: 'status',
    lines: ['policy_id.name'],
    properties: ['start_date', 'end_date', 'hours'],
    openLabel: 'Review request',
  }),
  open: 'modal',
});
