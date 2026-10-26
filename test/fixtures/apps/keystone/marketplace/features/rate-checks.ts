import { action, card, defineFeature, fields, header, headline, listView, page } from '@mistriwork/mistri/app';
import type { Feature, Page } from '../mistri-schema.d.ts';

/** Signed in, a rate check is about the car on screen and is the account's
 * own: it answers with the estimate on a page only that account reads. */

/** Keystone's marketing desk sends a matched estimate with a car to that car's dealer, as a new lead. */

const rateCheckPage = page(
  'prequalification',
  [
    header({
      status: 'status',
      facts: [
        { column: 'created_at', before: 'Checked' },
        { column: 'credit_band', before: 'Credit' },
        { column: 'desired_payment', before: 'Payment in mind' },
      ],
    }),
    headline('estimated_amount', {
      region: 'aside',
      subfigure: 'estimated_apr',
      note: 'An estimate from what you told us, with no credit pull. The dealer’s application to Keystone decides the rate.',
    }),
    card('The program', 'program_id', ['max_term', 'base_apr']),
    card('The car', 'vehicle_id', ['list_price', 'est_payment'], { region: 'main' }),
    fields(['first_name', 'last_name', 'email', 'phone', 'zip', 'monthly_income'], {
      title: 'What you told us',
      presentation: 'table',
      columns: 2,
    }),
  ],
  { listTabs: false },
) satisfies Page;

export const checkRateAction = action('Check my rate for this car', { command: 'checkRate' });
export const rateChecks = defineFeature({
  id: 'rate-checks',
  resources: {
    vehicle: {
      actions: {
        checkRate: checkRateAction,
      },
    },
    prequalification: {
      segments: {
        matched: 'status = matched',
        sent_to_a_dealer: 'status = sent_to_dealer',
        no_match: 'status in (no_match, expired)',
      },
      actions: {
        sendToDealer: action('Send to the dealer', { command: 'sendToDealer' }),
      },
    },
  },
  auth: {
    roles: {
      customer: {
        read: ['prequalification'],
        commands: ['checkRate'],
        fields: {
          prequalification: {
            read: [
              'id',
              'reference',
              'first_name',
              'last_name',
              'email',
              'phone',
              'zip',
              'credit_band',
              'monthly_income',
              'desired_payment',
              'vehicle_id',
              'program_id',
              'estimated_amount',
              'estimated_apr',
              'status',
              'created_at',
              'version',
            ],
          },
        },
      },
      marketplace_admin: { read: ['prequalification'], commands: ['checkRate', 'sendToDealer'] },
    },
  },
  views: {
    prequalifications: listView('Rate checks', 'prequalification', {
      icon: 'gauge',
      sort: 'created_at desc',
      show: ['reference', 'vehicle_id', 'credit_band', 'estimated_amount', 'estimated_apr', 'created_at', 'status'],
      tabs: ['matched', 'sent_to_a_dealer', 'no_match', { label: 'All' }],
      filters: ['credit_band', 'program_id', 'created_at'],
      rowActions: true,
      empty: {
        title: 'No rate checks here',
        description: 'Check your rate from any car’s page and your estimate is kept here.',
        action: { label: 'Browse cars for sale', to: 'vehicles' },
      },
    }),
  },
  pages: { 'rate-check': rateCheckPage },
} satisfies Feature);
