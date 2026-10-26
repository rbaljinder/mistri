import {
  calendar,
  custom,
  defineFeature,
  document,
  fields,
  listView,
  machine,
  me,
  navGroup,
  note,
  page,
  related,
} from '@mistriwork/mistri/app';
import type { Feature } from '../mistri-schema.d.ts';
import { payrollTimeline } from '../components.ts';

/* A run moves by fixed verbs of its machine, each only the status it sets
   and, for an approval, who approved it and the note it asks for: the server
   stamps 'me' inside the write, and approved_at as the run enters "approved"
   (a state's own stamp, which the platform writes). The payroll manager writes
   no pay run; `auth` below grants the verbs by name, so a read-only role
   approves without being able to edit a run's figures, and the server takes
   no other change of a run's status from anyone. Paying is the admin's word
   once the bank has the file. */
const submitRun = { to: 'review', label: 'Submit for review' } as const;
const approveRun = {
  to: 'approved',
  label: 'Approve payroll',
  set: { approved_by: me },
  reason: 'approval_note',
} as const;
const recordPayment = { to: 'paid', label: 'Record payment', confirm: true } as const;
const runMachine = machine('status', {
  draft: { on: { submitRun } },
  review: { on: { approveRun } },
  approved: { on: { recordPayment } },
  paid: { final: true },
});

const runStatus = { tone: { draft: 'neutral', review: 'warn', approved: 'good', paid: 'info' } } as const;
const usd = { format: 'money' } as const;

/* The run among its neighbours: every run's pay period on a month axis, this
   one marked. Exported, so the component types its props from it. */
export const payHistory = custom('Pay history', payrollTimeline, {
  record: ['id', 'title'],
  rows: {
    runs: { from: 'pay_run', show: ['id', 'title', 'period_start', 'period_end', 'pay_date', 'status'], sort: 'pay_date desc', limit: 18 },
  },
});

export const payroll = defineFeature({
  id: 'payroll',
  resources: {
    pay_run: {
      segments: {
        needs_review: 'status = review',
        drafts: 'status = draft',
        approved_runs: { query: 'status = approved', label: 'Approved' },
        history: 'status = paid',
        // Submitted this year, at any step past the draft: the reports' payroll figures.
        this_year: 'pay_date = this year and status != draft',
      },
      noun: 'payroll run',
      access: 'write',
      labels: {
        reference: 'Run reference',
        title: 'Payroll period',
        period_start: 'Period starts',
        period_end: 'Period ends',
        employee_count: 'Employees',
        gross_total: 'Gross pay',
        deductions_total: 'Deductions',
        net_total: 'Net pay',
      },
      display: { status: runStatus, employee_taxes: usd, employer_taxes: usd },
      machine: runMachine,
    },
    pay_stub: {
      noun: 'pay statement',
      recordLabel: 'employee_id.name',
      labels: {
        pay_run_id: 'Payroll run',
        status: 'Statement status',
        gross: 'Gross pay',
        federal_tax: 'Federal income tax',
        state_tax: 'State income tax',
        social_security: 'Social Security',
        benefits: 'Benefit premiums',
        retirement: '401(k) contribution',
        net: 'Net pay',
      },
      display: {
        status: { tone: { draft: 'neutral', pending: 'warn', paid: 'good' } },
        bonus: usd,
        gross: usd,
        federal_tax: usd,
        state_tax: usd,
        social_security: usd,
        medicare: usd,
        benefits: usd,
        retirement: usd,
        net: usd,
      },
    },
  },
  auth: {
    roles: {
      admin: { actions: { pay_run: ['submitRun', 'approveRun', 'recordPayment'] } },
      payroll_manager: { actions: { pay_run: ['submitRun', 'approveRun'] } },
    },
  },
  views: {
    payroll: listView('Payroll', 'pay_run', {
      icon: 'wallet',
      show: ['title', 'pay_date', 'run_by', 'employee_count', 'gross_total', 'net_total', 'status'],
      tabs: [
        'needs_review',
        'drafts',
        'approved_runs',
        { segment: 'history', sort: 'pay_date desc' },
        { label: 'All', sort: 'pay_date desc' },
      ],
      totals: ['gross_total', 'net_total'],
      empty: { title: 'No payroll runs in this view', description: 'Choose another tab to see more payroll runs.' },
    }),
    /* A run across its pay period, its stage a dot and a word, its pay date under it. */
    'payroll-calendar': listView('Payroll calendar', 'pay_run', {
      icon: 'calendar',
      presentation: calendar('period_start', 'title', { end: 'period_end', badge: 'status', lines: ['pay_date'] }),
    }),
    'pay-statements': listView('Pay statements', 'pay_stub', {
      icon: 'receipt',
      density: 'compact',
      show: ['employee_id.name', 'pay_date', 'gross', 'net', 'status'],
      sort: 'pay_date desc',
      filters: ['employee_id', 'pay_date', 'status'],
      totals: ['gross', 'net'],
    }),
  },
  pages: {
    'pay-run': page('pay_run', [
      fields(['gross_total', 'net_total', 'pay_date'], { title: 'Payroll summary', columns: 3 }),
      payHistory,
      related('Pay statements', 'pay_stub', 'pay_run_id', { show: ['employee_id.name', 'gross', 'net'], limit: 25 }),
      fields(['gross_total', 'employee_taxes', 'deductions_total', 'net_total', 'employer_taxes'], {
        title: 'Where the money goes',
        region: 'aside',
      }),
      fields(['reference', 'period_start', 'period_end', 'run_by', 'employee_count'], { title: 'Pay period', region: 'aside' }),
      fields(['approved_by', 'approved_at', 'approval_note'], {
        title: 'Approval details',
        region: 'aside',
        when: 'status = approved or status = paid',
      }),
    ]),
    'pay-stub': page('pay_stub', [
      fields(['gross', 'net', 'pay_date'], { title: 'Statement totals', columns: 3 }),
      fields(['regular_hours', 'overtime_hours', 'bonus', 'gross'], { title: 'Earnings', presentation: 'properties', width: 'half' }),
      fields(['federal_tax', 'state_tax', 'social_security', 'medicare'], {
        title: 'Taxes withheld',
        presentation: 'properties',
        width: 'half',
      }),
      fields(['benefits', 'retirement', 'net'], { title: 'Deductions and take-home pay', presentation: 'properties', width: 'half' }),
      fields(['pay_run_id', 'pay_run_id.period_start', 'pay_run_id.period_end', 'status'], { title: 'Pay period', region: 'aside' }),
      fields(['employee_id', 'employee_id.title', 'employee_id.location'], { title: 'Teammate', region: 'aside' }),
    ]),
    /* The statement on paper: More → Payslip on a pay statement, at /payday/pay-statements/<id>/payslip.
       Whoever may read the statement may print it; nobody else is shown it. */
    payslip: document(
      'pay_stub',
      [
        fields(['employee_id', 'employee_id.title', 'employee_id.location'], { title: 'Employee', presentation: 'facts', width: 'third' }),
        fields(['pay_run_id.period_start', 'pay_run_id.period_end', 'pay_date', 'status'], {
          title: 'Pay period',
          presentation: 'properties',
          width: 'third',
        }),
        fields(['net', 'gross'], { title: 'Net pay', width: 'third' }),
        fields(['regular_hours', 'overtime_hours', 'bonus', 'gross'], { title: 'Earnings', presentation: 'table', width: 'half' }),
        fields(['federal_tax', 'state_tax', 'social_security', 'medicare'], {
          title: 'Taxes withheld',
          presentation: 'properties',
          width: 'half',
        }),
        fields(['benefits', 'retirement', 'net'], { title: 'Deductions and take-home pay', presentation: 'table', width: 'half' }),
        note('Figures are synthetic. Payday calculates nothing and files nothing; keep this statement for your records.', {
          variant: 'quiet',
        }),
      ],
      {
        label: 'Payslip',
        number: 'id',
        description: 'Payday Demo Workspace, Inc.\n100 Market Street, Suite 400, San Francisco, CA 94105\nEIN 12-3456789',
      },
    ),
  },
  nav: [navGroup('payroll-menu', 'Payroll', ['payroll', 'payroll-calendar', 'pay-statements'], { icon: 'wallet' })],
} satisfies Feature);
