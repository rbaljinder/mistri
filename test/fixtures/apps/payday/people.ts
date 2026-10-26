import { calendar, cards, count, defineFeature, fields, listView, msg, navGroup, page, related, sum } from '@mistriwork/mistri/app';
import type { Feature } from './mistri-schema.d.ts';

export const peopleCards = cards('name', {
  media: 'avatar',
  badge: 'employment_status',
  facts: ['title', 'department_id.name'],
  properties: ['location'],
});
export const employmentTones = { tone: { onboarding: 'info', active: 'good', leave: 'warn', inactive: 'neutral' } } as const;

export const people = defineFeature({
  id: 'people',
  resources: {
    employee: {
      // Everyone still on the books, on leave or not: a department's head count and the reports' breakdown of it.
      segments: { on_staff: 'employment_status != inactive' },
      noun: 'person',
      access: 'write',
      display: {
        name: { avatar: true },
        employment_status: employmentTones,
        pay_rate: { format: 'money', unit: '/hr' },
      },
      labels: {
        name: msg('people.name'),
        email: msg('people.email'),
        manager_id: msg('people.manager'),
        salary: msg('people.salary'),
        pay_rate: msg('people.payRate'),
        department_id: msg('people.team'),
        title: msg('people.jobTitle'),
        location: msg('people.location'),
        employment_status: msg('people.status'),
        start_date: msg('people.started'),
        pay_type: msg('people.payType'),
        'manager_id.title': 'Manager’s title',
        'department_id.name': msg('people.team'),
      },
      form: {
        when: { salary: 'pay_type = salary', pay_rate: 'pay_type = hourly' },
        // A new teammate starts onboarding; how they are paid is chosen, never assumed.
        defaults: { employment_status: 'onboarding' },
        steps: [
          { id: 'identity', label: 'Identity', fields: ['name', 'email', 'department_id', 'title', 'manager_id'] },
          { id: 'work', label: 'Work', fields: ['location', 'employment_status', 'start_date', 'pay_type', 'salary', 'pay_rate'] },
        ],
      },
    },
    department: {
      // The department page's figures, named once so its summary sits beside the lead's rail without wrapping.
      rollups: {
        headcount: count('employee', { query: 'on_staff' }),
        starting_soon: count('employee', { query: 'employment_status = onboarding' }),
        annual_salaries: sum('employee', 'salary'),
      },
      labels: { name: 'Department', lead_id: 'Department lead' },
    },
    onboarding_task: {
      // The tabs' captions are messages, so each segment carries its label in both languages.
      segments: {
        to_do: { query: 'status = open', label: msg('people.toDo') },
        completed: { query: 'status = done', label: msg('people.completed') },
      },
      labels: {
        employee_id: msg('people.teammate'),
        title: msg('people.task'),
      },
      display: {
        status: { tone: { open: 'warn', done: 'good' } },
        category: { tone: { paperwork: 'info', equipment: 'neutral', training: 'neutral', welcome: 'good' } },
      },
    },
    company_event: {
      labels: { event_date: 'Date', kind: 'Occasion', title: 'Event', employee_id: 'Teammate' },
      display: { kind: { tone: { anniversary: 'good', first_day: 'info', holiday: 'neutral' } } },
    },
  },
  views: {
    people: listView(msg('people.people'), 'employee', {
      icon: 'users',
      sort: 'name',
      presentation: peopleCards,
      show: ['name', 'title', 'department_id.name', 'location', 'employment_status', 'start_date'],
      filters: ['department_id', 'employment_status', 'location'],
      empty: { title: 'Your team will appear here', description: 'Add people to start building your company directory.' },
    }),
    departments: listView('Departments', 'department', {
      icon: 'buildings',
      sort: 'name',
      show: ['name', 'lead_id.name', 'cost_center'],
      density: 'compact',
    }),
    onboarding: listView('Onboarding', 'onboarding_task', {
      icon: 'list-checks',
      sort: 'due_date',
      tabs: ['to_do', 'completed', { label: msg('people.allTasks') }],
      show: ['employee_id.name', 'title', 'category', 'due_date', 'status'],
      filters: ['employee_id', 'category'],
      empty: { title: 'No tasks in this view', description: 'Choose another tab to see more onboarding tasks.' },
    }),
    'company-calendar': listView('Company calendar', 'company_event', {
      icon: 'calendar',
      presentation: calendar('event_date', 'title', { badge: 'kind' }),
    }),
  },
  pages: {
    employee: page('employee', [
      fields(['title', 'department_id.name', 'employment_status'], { presentation: 'facts' }),
      fields(['email', 'location', 'start_date'], {
        title: msg('people.basicDetails'),
        tab: msg('people.overview'),
        presentation: 'properties',
        width: 'half',
      }),
      // The manager as a card, linked to their page, is the shape this wants; see the README's platform notes.
      fields(['department_id', 'manager_id', 'manager_id.title'], {
        title: msg('people.employment'),
        tab: msg('people.overview'),
        presentation: 'properties',
        width: 'half',
      }),
      // Most people manage no one: the list is left out until someone reports to them.
      related(msg('people.directReports'), 'employee', 'manager_id', {
        tab: msg('people.overview'),
        show: ['name', 'department_id.name', 'location', 'employment_status'],
        sort: 'name',
        empty: 'hide',
      }),
      fields(['title', 'department_id', 'pay_type'], {
        title: msg('people.jobDetails'),
        tab: msg('people.jobPay'),
        presentation: 'properties',
        width: 'half',
      }),
      fields(['salary'], {
        title: msg('people.annualSalary'),
        tab: msg('people.jobPay'),
        presentation: 'properties',
        width: 'half',
        when: 'pay_type = salary',
      }),
      fields(['pay_rate'], {
        title: msg('people.hourlyPay'),
        tab: msg('people.jobPay'),
        presentation: 'properties',
        width: 'half',
        when: 'pay_type = hourly',
      }),
      related(msg('people.payHistory'), 'pay_stub', 'employee_id', {
        tab: msg('people.pay'),
        show: ['pay_date', 'pay_run_id.title', 'gross', 'net', 'status'],
        sort: 'pay_date desc',
        limit: 12,
        totals: ['gross', 'net'],
      }),
      related(msg('people.balances'), 'time_off_balance', 'employee_id', {
        tab: msg('people.timeOff'),
        show: ['policy_id.name', 'accrued_hours', 'used_hours', 'available_hours'],
        sort: 'policy_id',
      }),
      related(msg('people.requests'), 'time_off', 'employee_id', {
        tab: msg('people.timeOff'),
        show: ['policy_id.name', 'start_date', 'end_date', 'hours', 'status'],
        sort: 'start_date desc',
      }),
      related(msg('people.benefits'), 'benefit', 'employee_id', {
        tab: msg('people.benefits'),
        show: ['plan_id.name', 'coverage', 'status', 'employee_cost', 'employer_cost'],
        sort: 'plan_id',
      }),
      related(msg('people.documents'), 'document', 'employee_id', {
        tab: msg('people.documents'),
        show: ['title', 'status', 'due_date', 'signed_on'],
        sort: 'status, due_date',
      }),
      related(msg('people.onboarding'), 'onboarding_task', 'employee_id', {
        show: ['title', 'category', 'due_date', 'status'],
        tab: msg('people.onboarding'),
        sort: 'due_date',
        empty: {
          title: msg('people.onboardingEmpty'),
          description: msg('people.onboardingHint'),
          action: { label: msg('people.viewOnboarding'), to: 'onboarding' },
        },
      }),
    ]),
    department: page('department', [
      fields(['lead_id.name', 'cost_center'], { presentation: 'facts' }),
      fields(['headcount', 'starting_soon', 'annual_salaries'], { columns: 3 }),
      related('People', 'employee', 'department_id', { show: ['name', 'title', 'employment_status'], sort: 'name' }),
      fields(['lead_id', 'lead_id.title', 'lead_id.email'], { title: 'Department lead', region: 'aside' }),
    ]),
    'onboarding-task': page('onboarding_task', [
      fields(['status', 'category', 'due_date'], { title: 'Task details', presentation: 'properties' }),
      related(
        'Other tasks for this teammate',
        'onboarding_task',
        { same: ['employee_id'] },
        { show: ['title', 'due_date', 'status'], sort: 'due_date' },
      ),
      fields(['employee_id', 'employee_id.title', 'employee_id.location', 'employee_id.start_date'], {
        title: 'Teammate',
        region: 'aside',
      }),
    ]),
    'company-event': page('company_event', [
      fields(['event_date', 'kind'], { title: 'Event', presentation: 'properties' }),
      fields(['employee_id', 'employee_id.title', 'employee_id.location'], {
        title: 'Teammate',
        region: 'aside',
        when: 'employee_id is not empty',
      }),
    ]),
  },
  nav: [navGroup('people-menu', 'People', ['people', 'departments', 'onboarding', 'company-calendar'], { icon: 'users' })],
} satisfies Feature);
