import { breakdown, chart, dashboard, defineFeature, matrix, metric, rows } from '@mistriwork/mistri/app';
import type { Feature } from '../mistri-schema.d.ts';

/* Company reporting over the same records the other rooms work: payroll cost
   from the runs, headcount from the directory, time off from the requests. */
export const reportsHome = dashboard(
  'Reports',
  [
    metric('Active headcount', 'employee', {
      query: 'employment_status = active or employment_status = leave',
      width: 'third',
      to: 'people',
    }),
    metric('Gross payroll this year', 'pay_run', {
      query: 'this_year',
      measure: 'sum gross_total as gross',
      width: 'third',
      to: 'payroll',
    }),
    metric('Employer taxes this year', 'pay_run', {
      query: 'this_year',
      measure: 'sum employer_taxes as taxes',
      width: 'third',
      to: 'payroll',
    }),
    chart('Payroll cost by month', 'pay_run', 'month pay_date', {
      query: 'this_year',
      measure: 'sum gross_total as gross',
      height: 220,
    }),
    breakdown('Headcount by department', 'employee', 'department_id.name', { query: 'on_staff', width: 'half' }),
    chart('Time off by policy', 'time_off', 'policy_id.name', {
      query: 'status = approved',
      measure: 'sum hours as hours',
      shape: 'donut',
      width: 'half',
      to: 'timeoff',
    }),
    matrix('Time off hours: policy × month', 'time_off', 'policy_id.name, month start_date', {
      query: 'status = approved and start_date = this year',
      measure: 'sum hours as hours',
      to: 'timeoff',
    }),
    rows('Open items: signatures', 'document', {
      query: 'status = pending',
      show: ['employee_id.name', 'title', 'due_date'],
      sort: 'due_date',
      limit: 6,
      width: 'half',
    }),
    rows('Open items: onboarding', 'onboarding_task', {
      query: 'status = open',
      show: ['employee_id.name', 'title', 'due_date'],
      sort: 'due_date',
      limit: 6,
      width: 'half',
    }),
  ],
  { icon: 'chart-bar', description: 'Payroll cost, headcount and time off across the company.' },
);

export const reports = defineFeature({
  id: 'reports',
  views: { reports: reportsHome },
  nav: ['reports'],
} satisfies Feature);
