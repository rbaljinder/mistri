import { breakdown, chart, dashboard, embed, metric, rows } from '@mistriwork/mistri/app';

/* The two front doors. Today is the office's morning: how full the buildings
   are, what rent has brought in against what is due, who is
   behind, and where every repair stands. Home is a resident's: what they owe,
   their repairs, and the one button that matters when something breaks. */

export const today = dashboard(
  'Today',
  [
    metric('Occupied homes', 'unit', { query: 'status = occupied or status = notice', to: 'units', icon: 'house', area: 'homes' }),
    metric('Vacant or turning over', 'unit', { query: 'available', to: 'units', icon: 'key', area: 'homes' }),
    // Over the window the reader picks above the cards, beside its change from the period before and its trend across
    // the window, both of which a metric over a clock draws unasked.
    metric('Rent collected', 'charge', {
      query: 'kind = rent and status = paid',
      over: 'due_on',
      measure: 'sum amount as collected',
      better: 'up',
      area: 'money',
      icon: 'bank',
    }),
    metric('Overdue', 'charge', { segment: 'overdue', measure: 'sum amount as owed', to: 'ledger', area: 'money', icon: 'warning' }),
    // Every repair by where it stands, in the road's order: a card per state, a click to its list.
    breakdown('Repairs by state', 'maintenance_request', 'status', {
      query: 'outstanding',
      shape: 'steps',
      to: 'repairs',
      notes: {
        new: 'Reported, not yet looked at',
        triaged: 'Waiting for a visit',
        scheduled: 'A technician is booked',
        in_progress: 'Being worked on',
        on_hold: 'Waiting on a part or an answer',
      },
      icon: 'wrench',
      area: 'repairs',
    }),
    // `auto` over the reader's window: a finer or coarser unit as the window and the data call for it.
    chart('Rent charged and collected', 'charge', 'auto due_on, status', {
      query: 'kind = rent',
      over: 'due_on',
      measure: 'sum amount as rent',
      shape: 'stacked',
      area: 'trend',
      icon: 'chart-bar',
    }),
    // Two lists read homes (the public listings and the rent roll): the groups open the rent roll.
    breakdown('Homes by building', 'unit', 'property_id', { to: 'units', area: 'building', icon: 'buildings' }),
    rows('Leases ending soon', 'lease', {
      segment: 'ending_soon',
      show: ['unit_id', 'resident_id', 'end_on'],
      sort: 'end_on',
      limit: 6,
      area: 'leases',
    }),
    embed('viewings', { title: 'Viewings', area: 'viewings', limit: 6, icon: 'calendar-check' }),
  ],
  {
    icon: 'gauge',
    roles: ['manager', 'admin', 'leasing'],
    heading: 'Good morning, {me.name}',
    description: 'Three buildings at a glance: who is in, what is owed and what needs fixing.',
    // The grid, so each answer stands where it reads: the two pairs of figures across the top, the road of repairs under
    // them, the chart's three quarters with the buildings beside it, and the two lists a half each.
    areas: [
      'homes   homes   money    money',
      'repairs repairs repairs repairs',
      'trend   trend   trend    building',
      'leases  leases  viewings viewings',
    ],
    // It opens on a quarter of rent cycles, so the change and the trend under the figure have something to say.
    windows: ['this month', 'last 30 days', 'last 90 days'],
    window: 'last 90 days',
  },
);

export const portal = dashboard(
  'Home',
  [
    metric('Balance due', 'charge', { query: 'unpaid', measure: 'sum amount as owed', to: 'my-charges', width: 'half', icon: 'receipt' }),
    metric('Open repairs', 'maintenance_request', { query: 'outstanding', to: 'my-requests', width: 'half', icon: 'wrench' }),
    embed('my-requests', { title: 'Your repairs', limit: 5, icon: 'wrench' }),
    embed('my-charges', { title: 'Your charges', limit: 6, icon: 'receipt' }),
  ],
  {
    icon: 'house',
    roles: ['resident'],
    heading: 'Welcome home',
    description: 'Your lease, your charges and your repairs. Something broken? Report it and the office books a visit.',
  },
);
