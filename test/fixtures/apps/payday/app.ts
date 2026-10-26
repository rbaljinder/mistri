import { dashboard, defineApp, embed, listView, queue, rows } from '@mistriwork/mistri/app';
import type { App, Views } from './mistri-schema.d.ts';
import { people } from './people.ts';
import { benefits } from './features/benefits.ts';
import { company } from './features/company.ts';
import { documents } from './features/documents.ts';
import { payroll } from './features/payroll.ts';
import { reports } from './features/reports.ts';
import { timeTracking, timesheetTasks } from './features/time.ts';
import { timeOff, timeOffTasks } from './features/timeoff.ts';
import { payday } from './theme.ts';

/* Today reads like a to-do list: the next payroll first, then every review
   waiting on the payroll manager, then who is joining and what is coming up. */
const home = dashboard(
  'Let’s take care of your team',
  [
    embed('payroll-tasks', { title: 'Your next payroll', limit: 2 }),
    embed('timeoff-tasks', { title: 'Time off requests', limit: 3 }),
    embed('timesheet-tasks', { title: 'Timesheets to approve', limit: 3 }),
  ],
  {
    icon: 'house',
    description: 'Run payroll, answer requests and help new teammates get settled.',
    aside: [
      rows('Starting soon', 'employee', {
        query: 'employment_status = onboarding',
        show: ['name', 'start_date'],
        sort: 'start_date',
        limit: 4,
      }),
      rows('Onboarding to do', 'onboarding_task', {
        query: 'status = open',
        show: ['employee_id.name', 'title'],
        sort: 'due_date',
        limit: 5,
      }),
      rows('Awaiting signature', 'document', {
        query: 'status = pending',
        show: ['employee_id.name', 'title'],
        sort: 'due_date',
        limit: 5,
      }),
      rows('Coming up', 'company_event', { query: 'event_date >= today', show: ['event_date', 'title'], sort: 'event_date', limit: 6 }),
    ],
  },
);

const views = {
  home,
  'payroll-tasks': listView('Payroll to review', 'pay_run', {
    empty: {
      title: 'Payroll is up to date',
      description: 'There are no draft or review runs waiting here.',
      action: { label: 'View payroll', to: 'payroll' },
    },
    query: 'status = draft or status = review',
    sort: 'pay_date',
    presentation: queue('title', {
      badge: 'status',
      lines: ['gross_total'],
      properties: ['run_by', 'pay_date', 'employee_count'],
      openLabel: 'Review payroll',
    }),
    open: 'modal',
  }),
  'timeoff-tasks': timeOffTasks,
  'timesheet-tasks': timesheetTasks,
} satisfies Views;

export default defineApp({
  id: 'payday',
  name: 'Payday',
  sources: { payday: { connection: 'payday' } },
  resources: {
    employee: { access: 'write' },
    department: {},
    pay_run: { access: 'write' },
    pay_stub: {},
    time_off: { access: 'write' },
    time_off_policy: {},
    time_off_balance: { access: 'write' },
    timesheet: { access: 'write' },
    time_entry: {},
    benefit_plan: {},
    benefit: {},
    document: { access: 'write' },
    onboarding_task: {},
    company_event: {},
    company: { access: 'write' },
  },
  features: [people, payroll, timeOff, timeTracking, benefits, documents, reports, company],
  auth: {
    providers: ['email'],
    defaultRole: 'payroll_manager',
    roles: {
      payroll_manager: { label: 'Payroll manager', read: true, write: false },
      admin: { label: 'Admin', read: true, write: ['employee'] },
    },
  },
  views,
  home: 'home',
  nav: [
    { to: 'home', label: 'Today' },
    { feature: 'people' },
    { feature: 'payroll' },
    { feature: 'timeoff' },
    { feature: 'time' },
    { feature: 'benefits' },
    { feature: 'documents' },
    { feature: 'reports' },
  ],
  ui: {
    logo: 'wallet',
    customThemes: [payday],
    theme: { preset: 'payday' },
    shell: {
      placement: 'side',
      headerWidth: 'full',
      width: 'wide',
      gutter: 'comfortable',
      breadcrumbs: false,
      search: false,
      sidebar: { density: 'compact', footer: { title: 'Payday demo workspace', description: 'People & payroll' } },
    },
    currency: 'USD',
    locale: 'en-US',
    export: false,
  },
} satisfies App);
