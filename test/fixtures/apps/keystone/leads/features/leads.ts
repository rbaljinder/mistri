import {
  action,
  card,
  count,
  defineFeature,
  fields,
  header,
  history,
  listView,
  max,
  page,
  queue,
  related,
  stream,
  timeline,
} from '@mistriwork/mistri/app';
import type { Feature } from '../mistri-schema.d.ts';
import { dealStatus, dollars, leadStatus, perMonth } from '../vocab.ts';

/** Everything a credit application asks of one person, shared by the desk's
    own "Take credit application" and the public apply form. */

/* The lead's verbs. Every one is a command: a table a command writes changes
   only through commands (a role's generic write on it is refused at startup),
   and the lead's status, its timeline and its applicants are all written by
   the work people do, never typed. */

/* A walk-in is a lead the showroom creates. A signed-in form that creates a
   record is refused in a tenant App (SUITE.md, G9), so the walk-in starts on
   the car the customer came to see: a command targeted on the vehicle. */

/** The lead's own road, in order. Lost is a way off it, said by its tone. */

export const markLostAction = action('Mark lost', { command: 'markLeadLost' });
export const leads = defineFeature({
  id: 'leads',
  resources: {
    lead: {
      segments: {
        new: 'status = new',
        contacted: 'status = contacted',
        desking: 'status = desking',
        submitted: 'status = submitted',
        sold: 'status = sold',
        lost: 'status = lost',
        open: 'status = new or status = contacted or status = desking or status = submitted',
      },
      recordLabel: '{first_name} {last_name}',
      labels: {
        vehicle_id: 'Vehicle',
        salesperson_id: 'Salesperson',
        next_follow_up_on: 'Follow up',
        last_contact_at: 'Last contact',
        created_at: 'Came in',
        lost_reason: 'Lost because',
        reference: 'Lead',
        'vehicle_id.model': 'Vehicle',
        'salesperson_id.name': 'Salesperson',
      },
      display: {
        status: leadStatus,
        next_follow_up_on: { format: 'relative' },
        last_contact_at: { format: 'relative' },
        created_at: { format: 'relative' },
      },
      rollups: {
        touches: count('lead_activity', { whose: 'lead_id' }),
        applicants: count('applicant', { whose: 'lead_id' }),
        deals: count('deal', { whose: 'lead_id' }),
        best_payment: max('deal', 'monthly_payment', { whose: 'lead_id', query: 'status != cancelled' }),
      },
      actions: {
        startDeal: action('Start deal', { command: 'startDeal' }),
        logContact: action('Log contact', { command: 'logContact' }),
        takeApplication: action('Take credit application', { command: 'takeApplication' }),
        markLeadLost: markLostAction,
      },
    },
    lead_activity: {
      recordLabel: 'kind',
      labels: { author_id: 'By', created_at: 'When' },
      display: { created_at: { format: 'relative' } },
    },
    applicant: {
      recordLabel: '{first_name} {last_name}',
      display: { monthly_income: dollars, monthly_housing: dollars, years_at_address: { unit: 'yr' }, years_employed: { unit: 'yr' } },
      labels: { ssn_last4: 'SSN (last four)', monthly_income: 'Income a month', monthly_housing: 'Housing a month' },
    },
    vehicle: {
      actions: {
        recordWalkIn: action('Record walk-in', { command: 'recordWalkIn' }),
      },
    },
    deal: { display: { status: dealStatus, monthly_payment: perMonth } },
  },
  views: {
    leads: listView('Leads', 'lead', {
      icon: 'address-book',
      show: ['first_name', 'last_name', 'vehicle_id.model', 'salesperson_id.name', 'next_follow_up_on', 'status'],
      filters: ['source', 'next_follow_up_on', 'created_at'],
      filterBar: 'rail',
      sort: 'created_at desc',
      rowActions: true,
      tabs: [
        { segment: 'new', sort: 'created_at' },
        { segment: 'contacted', sort: 'next_follow_up_on' },
        { segment: 'desking', sort: 'next_follow_up_on' },
        'submitted',
        { segment: 'sold', sort: 'created_at desc' },
        { segment: 'lost', sort: 'created_at desc' },
        { label: 'All' },
      ],
      empty: { title: 'No leads here', description: 'Leads from the website, the marketplace and the showroom land in New.' },
    }),
    /* Someone clears New one lead at a time, from the keyboard: the name,
       what they asked about, where it came from and how long it has waited. */
    'new-leads': listView('New leads', 'lead', {
      icon: 'tray',
      query: 'status = new',
      sort: 'created_at',
      presentation: queue('last_name', {
        lines: ['first_name', 'created_at'],
        properties: ['vehicle_id', 'phone', 'message'],
        badge: 'source',
        openLabel: 'Work lead',
      }),
      empty: { title: 'Every new lead has been worked', description: 'New inquiries appear here the moment they arrive.' },
    }),
  },
  pages: {
    /* A lead opens on who it is and where it stands: the road it is on, what
       happened (the timeline), who applied and the deals desked for it, and
       beside them the car and the lead's own fields. */
    lead: page(
      'lead',
      [
        header({ status: 'status', facts: ['reference', 'source', 'created_at', 'next_follow_up_on'], destructive: ['markLeadLost'] }),
        fields(['touches', 'last_contact_at', 'best_payment']),
        timeline('Activity', [stream('lead_activity', 'lead_id', 'created_at', 'kind', { detail: 'body' })], { limit: 30 }),
        related('Applicants', 'applicant', 'lead_id', {
          show: ['first_name', 'last_name', 'role', 'monthly_income'],
          empty: {
            title: 'No credit application yet',
            description: 'Take one with "Take credit application" before the deal is submitted.',
          },
        }),
        related('Deals', 'deal', 'lead_id', {
          show: ['reference', 'vehicle_id.model', 'monthly_payment', 'status'],
          sort: 'created_on desc',
          empty: { title: 'Not desked yet', description: 'Start a deal once the customer has picked a car.' },
        }),
        card('Vehicle', 'vehicle_id', ['list_price', 'mileage', 'status']),
        fields(['phone', 'email', 'salesperson_id.name', 'message', 'lost_reason'], { title: 'Lead', region: 'aside' }),
        history(),
      ],
      { listTabs: true },
    ),
  },
} satisfies Feature);
