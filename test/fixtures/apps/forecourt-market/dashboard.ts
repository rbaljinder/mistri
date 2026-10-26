import { breakdown, chart, dashboard, funnel, metric, rows } from '@mistriwork/mistri/app';

/* The desk's morning: what is open and new, what sold, what the lot is
   worth and how long it has stood, where inquiries come from week by week,
   how far they get, and why the ones that went nowhere did. */
const OPEN = 'stage != won and stage != lost';

export const deskDashboard = dashboard(
  'Desk',
  [
    metric('Open inquiries', 'inquiry', { query: OPEN, width: 'third', to: 'pipeline' }),
    metric('New inquiries', 'inquiry', { query: 'received_at = last 7 days', compare: 'previous period', better: 'up', width: 'third' }),
    metric('Cars sold', 'vehicle', {
      query: 'status = sold',
      over: 'sold_on',
      compare: 'previous period',
      better: 'up',
      spark: true,
      width: 'third',
    }),
    metric('Stock value', 'vehicle', { query: 'for_sale', measure: 'sum price as value', width: 'third', to: 'stock' }),
    metric('Average days on the lot', 'vehicle', {
      query: 'for_sale',
      measure: 'avg days_on_lot as days',
      unit: 'days',
      width: 'third',
    }),
    // Week by week, how the questions arrive: the site, an account, the phone and the showroom.
    chart('Inquiries by week', 'inquiry', 'week received_at, channel', {
      query: 'received_at = last 12 weeks',
      shape: 'stacked',
      width: 'two-thirds',
    }),
    // The road as a flow, its stages in their order: how many reached each, as a share of the one before.
    funnel(
      'How far inquiries get',
      'inquiry',
      [
        { label: 'Received' },
        { label: 'Contacted', query: 'stage in (contacted, test_drive, negotiating, won)' },
        { label: 'Test drive', query: 'stage in (test_drive, negotiating, won)' },
        { label: 'Negotiating', query: 'stage in (negotiating, won)' },
        { label: 'Won', query: 'stage = won' },
      ],
      { query: 'stage != lost', over: 'received_at', width: 'third', to: 'inquiries' },
    ),
    chart('Sales by month', 'vehicle', 'month sold_on', {
      query: 'status = sold and sold_on = last 6 months',
      measure: 'sum price as sales',
      shape: 'bar',
      width: 'half',
    }),
    chart('Why we lose', 'inquiry', 'lost_reason', {
      query: 'stage = lost',
      shape: 'donut',
      total: 'Lost',
      over: 'received_at',
      width: 'half',
      to: 'inquiries',
    }),
    breakdown('Stock by make', 'vehicle', 'make', { query: 'for_sale', limit: 10, width: 'half', to: 'stock' }),
    breakdown('Days on the lot, by make', 'vehicle', 'make', {
      query: 'for_sale',
      measure: 'avg days_on_lot as days',
      limit: 10,
      width: 'half',
      to: 'stock',
    }),
    rows('Test drives coming up', 'inquiry', {
      query: 'stage = test_drive',
      show: ['name', 'vehicle_id.title', 'test_drive_at', 'owner'],
      sort: 'test_drive_at',
      limit: 6,
      width: 'half',
    }),
    rows('Longest on the lot', 'vehicle', {
      query: 'listed',
      show: ['title', 'price', 'days_on_lot', 'dealer_id.name'],
      sort: 'listed_on',
      limit: 6,
      width: 'half',
    }),
  ],
  {
    icon: 'gauge',
    // A buyer reads inquiries and cars too (their own, by the policy), so reach alone would list the desk for them.
    roles: ['staff', 'admin'],
    heading: 'Good to see you, {me.name}',
    description: 'The desk at a glance: open inquiries, this week’s arrivals and what the lot is doing.',
    filters: ['owner'],
    windowControl: 'button',
    windows: ['last 30 days', 'last 90 days', 'this year'],
  },
);
