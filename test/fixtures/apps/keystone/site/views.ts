import { cards, commandForm, listView, step } from '@mistriwork/mistri/app';
import { DEALER } from './dealer.ts';
import { siteLanding } from './landing.ts';
import type { Views } from './mistri-schema.d.ts';

import { vehicleCard } from './vehicleCard.ts';

/* This dealer's lot: what is for sale or about to be. A standing query is what
   is shown, not what is served (SUITE.md G7: a signed-out reader may still
   open another dealer's car by its address), so nothing here is a secret. */
// A literal, so the typed queries below can read its words (a widened string cannot be checked).
const onTheLot = `dealer_id = ${DEALER.id} and status in (listed, pending)` as const;

export const views = {
  // The front page, signed out (landing.ts).
  welcome: siteLanding,

  inventory: listView('Inventory', 'vehicle', {
    query: onTheLot,
    presentation: vehicleCard,
    // New and used are the first question on every dealer's site.
    tabs: [{ label: 'All' }, 'new', 'pre_owned', 'under_20_000'],
    filterBar: 'rail',
    filters: ['make', 'model', 'body', 'list_price', 'year', 'mileage', 'fuel', 'drivetrain'],
    sort: [
      { label: 'Newest arrivals', sort: 'listed_on desc' },
      { label: 'Lowest price', sort: 'list_price' },
      { label: 'Highest price', sort: 'list_price desc' },
      { label: 'Lowest mileage', sort: 'mileage' },
      { label: 'Newest model year', sort: 'year desc' },
    ],
    empty: { title: 'No car on the lot matches all of that', description: 'Clear a filter, or ask us to find one for you.' },
  }),

  // The dealer's picks, for the front page.
  featured: listView('Featured', 'vehicle', {
    icon: 'star',
    query: `${onTheLot} and featured = true`,
    sort: 'list_price desc',
    presentation: vehicleCard,
  }),

  // Keystone's advertised rates, as the finance office quotes them.
  financing: listView('Financing', 'program', {
    query: 'advertised = true and active = true',
    sort: 'base_apr',
    presentation: cards('name', {
      value: 'base_apr',
      badge: 'tier',
      properties: ['max_term', 'max_amount'],
    }),
    filters: [],
  }),

  // Where the dealership is: one card that opens its page.
  visit: listView('Visit us', 'dealer', {
    query: `id = ${DEALER.id}`,
    presentation: cards('name', { properties: ['street', 'city', 'phone'] }),
  }),

  // The public forms. Each writes a new lead for the dealer, in /leads.
  ask: commandForm('Ask about a car', 'askAboutVehicle', {
    public: true,
    description: `A question for ${DEALER.name}'s sales team. From a car's page the form already names the car.`,
    submitLabel: 'Send question',
    prefillable: ['stock_number'],
    done: {
      title: 'Question sent',
      description: 'Keep this reference. Our sales team usually replies the same day, and within one business day.',
    },
  }),
  'test-drive': commandForm(
    'Schedule a test drive',
    'requestTestDrive',
    [
      step('The car and the day', ['stock_number', 'preferred_on', 'time_of_day']),
      step('How to reach you', ['first_name', 'last_name', 'email', 'phone', 'message']),
    ],
    {
      public: true,
      description: 'Pick a day and we will have the car washed, charged and waiting. Nothing is on hold until we confirm with you.',
      submitLabel: 'Request test drive',
      prefillable: ['stock_number'],
      done: { title: 'Test drive requested', description: 'Keep this reference. We will call or email to confirm the time.' },
    },
  ),
  apply: commandForm(
    'Apply for financing',
    'applyForFinancing',
    [
      step('The car', ['stock_number', 'down_payment']),
      step('About you', ['first_name', 'last_name', 'email', 'phone', 'date_of_birth', 'ssn_last4']),
      step('Your home', ['street', 'city', 'state', 'zip', 'housing', 'monthly_housing', 'years_at_address']),
      // The consent closes the last step rather than standing alone: five steps and the review fit one line at a desk.
      step('Income', ['employment_type', 'employer', 'job_title', 'years_employed', 'monthly_income', 'consent']),
    ],
    {
      public: true,
      description:
        `About five minutes. ${DEALER.name}'s finance manager sends it to Keystone Auto Finance and calls you with the answer. ` +
        'A demonstration over synthetic data: no credit is offered and no bureau is asked.',
      submitLabel: 'Submit application',
      prefillable: ['stock_number'],
      done: {
        title: 'Application received',
        description: 'Keep this reference. Our finance manager will call you, usually within the hour we are open.',
      },
    },
  ),
} satisfies Views;
