import { breakdown, chart, dashboard, defineFeature, metric, rows } from '@mistriwork/mistri/app';
import type { Feature } from '../mistri-schema.d.ts';

/* Where a dealer's day starts: what came in, who is due a call, what is on
   the desk and what Keystone owes an answer on. Every figure is this dealer's
   own, counted inside its tenant; a dealer cannot count another's.

   The month's goal (`dealer.monthly_goal`) is the lender's figure on the
   tenancy profile, which a dealer's realm does not read, and a metric's
   `target` is a number in the definition, not a column; so cars sold are
   drawn month by month rather than against the goal (README, gaps). */
const followUpsDue = 'next_follow_up_on <= today and (status = contacted or status = desking)';
const awaiting = 'status = submitted or status = in_review';

const today = dashboard('Today', [
  metric('New leads', 'lead', { query: 'status = new', width: 'third', to: 'new-leads' }),
  metric('Follow-ups due', 'lead', { query: followUpsDue, width: 'third', to: 'leads' }),
  metric('Awaiting Keystone', 'loan_application', { query: awaiting, width: 'third', to: 'applications' }),
  chart('Cars sold by month', 'vehicle', 'month sold_on', { query: 'status = sold and sold_on = last 12 months', shape: 'bar' }),
  rows('Follow-ups due', 'lead', {
    query: followUpsDue,
    sort: 'next_follow_up_on',
    show: ['first_name', 'last_name', 'next_follow_up_on'],
    limit: 8,
    width: 'half',
  }),
  rows('On the desk', 'deal', {
    query: 'status = structuring',
    sort: 'updated_at desc',
    show: ['reference', 'lead_id.last_name', 'monthly_payment'],
    limit: 8,
    width: 'half',
  }),
  rows('Stipulations to collect', 'stipulation', {
    query: 'status = requested',
    sort: 'requested_at',
    show: ['kind', 'requested_at'],
    limit: 6,
    width: 'half',
  }),
  breakdown('Where leads came from', 'lead', 'source', { query: 'created_at = last 90 days', width: 'half' }),
]);

export const todayFeature = defineFeature({
  id: 'today',
  views: { today: { ...today, icon: 'house', realm: 'tenant' } },
} satisfies Feature);
