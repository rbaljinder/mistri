/**
 * Compass — the showcase app: every knob the DSL has, in one place,
 * against the CRM database (`npm run seed:live` + a Postgres connection).
 *
 * The manifest is a table of contents; the landing screen lives in
 * revenue.ts, the opportunity page in pages/. Everything here is data —
 * the helpers are constructors, `satisfies App` checks this connection's
 * own table and column names (mistri-schema.d.ts, regenerate with
 * `tablewalk --export types`), and every grammar string is judged by the
 * server at startup with the fix named.
 */
import { defineApp, listView, navGroup } from '@mistriwork/mistri/app';
import type { App } from './mistri-schema.d.ts';
import { revenueBoard } from './revenue.ts';
import { harbor } from './harbor.ts';
import { opportunityPage } from './pages/opportunity.ts';

export default defineApp({
  name: 'Compass',

  /* ---- the display language: how values dress, everywhere ---- */
  resources: {
    opportunity: {
      segments: {
        open: 'stage != closed_won and stage != closed_lost',
        won: 'stage = closed_won',
      },
      display: {
        amount: { format: 'money' },
        probability: { format: 'percent', bar: true },
        stage: { tone: { closed_won: 'good', closed_lost: 'bad', negotiation: 'info' } },
      },
    },
    account: { display: { rating: { tone: { hot: 'good', cold: 'bad' } }, annual_revenue: { format: 'money' } } },
    lead: {
      segments: {
        working: 'status = new or status = working',
        qualified: 'status = qualified',
      },
      display: { status: { tone: { converted: 'good', qualified: 'info', lost: 'bad' } } },
    },
    product: { display: { list_price: { format: 'money' } } },
    opportunity_line: { display: { unit_price: { format: 'money' } } },
    task: { display: { status: { tone: { done: 'good' } } } },
    contact: {},
  },

  views: {
    revenue: revenueBoard,

    /* A module: standing conditions as a destination of its own,
       opening in the drawer — triage reads at a glance. */
    'closing-this-month': listView('Closing this month', 'opportunity', {
      query: 'stage != closed_won and stage != closed_lost and close_date = this month',
      show: ['name', 'account_id.name', 'amount', 'stage', 'close_date'],
      open: 'drawer',
    }),

    opportunities: listView('Opportunities', 'opportunity', {
      show: ['name', 'account_id.name', 'amount', 'probability', 'stage', 'close_date'],
      tabs: ['open', { segment: 'won', sort: 'close_date desc' }, { label: 'All' }],
      filters: ['stage', 'owner_id'],
    }),
    leads: listView('Leads', 'lead', {
      show: ['name', 'company', 'status', 'source', 'created_on'],
      tabs: ['working', 'qualified', { label: 'All' }],
      filters: ['source'],
    }),
    'my-day': listView('My day', 'task', {
      query: 'status = open',
      sort: 'due_on',
      show: ['subject', 'priority', 'due_on', 'opportunity_id.name'],
      filters: ['priority', 'is_urgent'],
    }),

    accounts: listView('Accounts', 'account', {
      show: ['name', 'industry_id.name', 'rating', 'annual_revenue', 'city'],
    }),
    contacts: listView('Contacts', 'contact', {
      show: ['name', 'account_id.name', 'title', 'email'],
    }),
    /* Products open centred: a lookup is a glance, not a walk. */
    products: listView('Products', 'product', { open: 'modal' }),
  },
  pages: { opportunity: opportunityPage },

  /* ---- home, and the nav that arranges the rest ---- */
  home: 'revenue',
  nav: [
    navGroup('sales', 'Sales', ['revenue', 'closing-this-month', 'opportunities', 'leads', 'my-day']),
    navGroup('directory', 'Directory', ['accounts', 'contacts', 'products']),
  ],

  ui: {
    customThemes: [harbor],
    /* ---- the shell ---- */
    shell: { placement: 'top' }, // one app bar: groups become menus, the record palette in it
    theme: {
      // a whitelist, not a stylesheet
      accent: '#2563eb',
      radius: '8px',
    },
  },
} satisfies App);
