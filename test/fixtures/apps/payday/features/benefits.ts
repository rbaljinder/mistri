import {
  breakdown,
  chart,
  count,
  dashboard,
  defineFeature,
  fields,
  listView,
  metric,
  navGroup,
  page,
  related,
  rows,
  sum,
} from '@mistriwork/mistri/app';
import type { Feature } from '../mistri-schema.d.ts';

/**
 * Benefits are oversight over seeded plans and elections: what each plan
 * costs, who is covered and whose elections are still open. Payday does not
 * model carrier feeds, open enrollment or plan administration.
 */
const perMonth = { format: 'money', unit: '/mo' } as const;

export const benefitsHome = dashboard(
  'Benefits',
  [
    metric('Covered teammates', 'benefit', { query: 'medical', width: 'third', to: 'enrollments' }),
    metric('Employer cost a month', 'benefit', {
      query: 'enrolled',
      measure: 'sum employer_cost as employer',
      width: 'third',
      to: 'enrollments',
    }),
    metric('Employee cost a month', 'benefit', {
      query: 'enrolled',
      measure: 'sum employee_cost as employee',
      width: 'third',
      to: 'enrollments',
    }),
    rows('Plans', 'benefit_plan', { show: ['name', 'kind', 'carrier', 'employee_cost', 'employer_cost'], sort: 'id' }),
    breakdown('Enrollments by plan', 'benefit', 'plan_id.name', { query: 'enrolled', width: 'half' }),
    chart('Medical coverage', 'benefit', 'coverage', {
      query: 'medical',
      shape: 'donut',
      width: 'half',
    }),
    rows('Elections waiting', 'benefit', {
      query: 'status = pending or status = waived',
      show: ['employee_id.name', 'plan_id.name', 'status', 'enrolled_on'],
      sort: 'status, enrolled_on',
    }),
  ],
  { icon: 'shield-check', description: 'What your plans cost, who is covered, and whose elections are still open.' },
);

export const benefits = defineFeature({
  id: 'benefits',
  resources: {
    benefit_plan: {
      // What a plan's elections add up to, named once so the plan page shows them as a summary beside its rail.
      rollups: {
        enrolled: count('benefit', { query: 'enrolled' }),
        company_pays: sum('benefit', 'employer_cost'),
        teammates_pay: sum('benefit', 'employee_cost'),
      },
      labels: {
        name: 'Plan',
        kind: 'Type',
        summary: 'Coverage',
        employee_cost: 'Employee pays',
        employer_cost: 'Company pays',
        company_pays: 'Company pays in all',
        teammates_pay: 'Teammates pay in all',
      },
      display: {
        kind: { tone: { medical: 'info', dental: 'info', vision: 'info', retirement: 'good' } },
        employee_cost: perMonth,
        employer_cost: perMonth,
        company_pays: perMonth,
        teammates_pay: perMonth,
      },
    },
    benefit: {
      segments: {
        enrolled: 'status = enrolled',
        // Covered under a medical plan: the benefits page's head count and its coverage chart.
        medical: 'status = enrolled and plan_id.kind = medical',
        pending: 'status = pending',
        waived: 'status = waived',
      },
      noun: 'benefit enrollment',
      recordLabel: 'plan_id.name',
      labels: { enrolled_on: 'Effective', employee_cost: 'Employee pays', employer_cost: 'Company pays' },
      display: {
        status: { tone: { enrolled: 'good', pending: 'warn', waived: 'neutral' } },
        employee_cost: perMonth,
        employer_cost: perMonth,
      },
    },
  },
  views: {
    benefits: benefitsHome,
    'benefit-plans': listView('Plans', 'benefit_plan', {
      icon: 'shield-check',
      density: 'compact',
      show: ['name', 'kind', 'carrier', 'employee_cost', 'employer_cost'],
      sort: 'id',
    }),
    enrollments: listView('Enrollments', 'benefit', {
      icon: 'users',
      density: 'compact',
      show: ['employee_id.name', 'plan_id.name', 'coverage', 'status', 'employee_cost', 'employer_cost'],
      filters: ['plan_id', 'status', 'employee_id'],
      sort: 'employee_id, plan_id',
      tabs: ['enrolled', 'pending', 'waived', { label: 'All' }],
      totals: ['employee_cost', 'employer_cost'],
    }),
  },
  pages: {
    'benefit-plan': page('benefit_plan', [
      fields(['kind', 'carrier'], { presentation: 'facts' }),
      fields(['summary'], { title: 'Coverage', columns: 1 }),
      fields(['enrolled', 'company_pays', 'teammates_pay'], { columns: 3 }),
      breakdown('Coverage tiers', 'benefit', 'coverage', { whose: 'plan_id', query: 'enrolled' }),
      related('Enrollments', 'benefit', 'plan_id', { show: ['employee_id.name', 'coverage', 'status'], sort: 'employee_id' }),
      fields(['employee_cost', 'employer_cost'], { title: 'Monthly cost, employee only', region: 'aside' }),
    ]),
    enrollment: page('benefit', [
      fields(['plan_id', 'coverage', 'status', 'enrolled_on'], { title: 'Coverage details', presentation: 'properties', width: 'half' }),
      fields(['employee_cost', 'employer_cost'], { title: 'Monthly cost', presentation: 'properties', width: 'half' }),
      related('Other elections', 'benefit', { same: ['employee_id'] }, { show: ['plan_id.name', 'coverage', 'status', 'employee_cost'] }),
      fields(['employee_id', 'employee_id.title', 'employee_id.location', 'employee_id.email'], { title: 'Teammate', region: 'aside' }),
    ]),
  },
  nav: [navGroup('benefits-menu', 'Benefits', ['benefits', 'benefit-plans', 'enrollments'], { icon: 'shield-check' })],
} satisfies Feature);
