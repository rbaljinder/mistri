import { breakdown, chart, dashboard, embed, metric, rows } from '@mistriwork/mistri/app';

/* The two front doors. Today is the office's morning: how full the buildings
   are, what rent has brought in against what is due, who is
   behind, and where every repair stands. Home is a resident's: what they owe,
   their repairs, and the one button that matters when something breaks. */

export const today = dashboard(
  'Today',
  [
    // Of every home: the goal counts the same homes with no condition, so the card says the share lived in, on a meter.
    metric('Occupied homes', 'unit', {
      query: 'status = occupied or status = notice',
      target: { measure: 'count' },
      to: 'units',
      icon: 'house',
      area: 'figures',
    }),
    metric('Vacant or turning over', 'unit', { query: 'available', to: 'units', icon: 'key', area: 'figures' }),
    // Over the window the reader picks above the cards, beside its change from the period before and its trend across
    // the window, both of which a metric over a clock draws unasked.
    metric('Rent collected', 'charge', {
      query: 'kind = rent and status = paid',
      over: 'due_on',
      measure: 'sum amount as collected',
      // Exact, as the strip's other figures are: one notation across a row of figures.
      better: 'up',
      area: 'figures',
      icon: 'bank',
    }),
    metric('Overdue', 'charge', { segment: 'overdue', measure: 'sum amount as owed', to: 'ledger', area: 'figures', icon: 'warning' }),
    // Every repair by where it stands, in the road's order: a card per state, a click to its list.
    breakdown('Repairs by status', 'maintenance_request', 'status', {
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
    // What needs someone today, as two worklists under the figures: each leads with the record's own name, so a row is
    // a name, a line and a value, and opens its record.
    rows('Urgent repairs', 'maintenance_request', {
      segment: 'urgent',
      show: ['title', 'unit_id', 'reported_on'],
      sort: 'reported_on',
      limit: 5,
      icon: 'warning',
      area: 'urgent',
    }),
    rows('Overdue charges', 'charge', {
      segment: 'overdue',
      show: ['description', 'lease_id', 'amount'],
      sort: 'due_on',
      limit: 5,
      icon: 'receipt',
      area: 'overdue',
    }),
  ],
  {
    icon: 'gauge',
    roles: ['manager', 'admin', 'leasing'],
    heading: 'Good morning, {me.name}',
    description: 'Three buildings at a glance: who is in, what is owed and what needs fixing.',
    // The grid, so each answer stands where it reads: the four figures in one strip across the top, what needs someone
    // under them, the road of repairs, the chart's three quarters with the buildings beside it, and the two lists a
    // half each.
    areas: [
      'figures figures figures  figures',
      'urgent  urgent  overdue  overdue',
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
    metric('Open repairs', 'maintenance_request', {
      query: 'underway',
      to: 'my-requests',
      width: 'half',
      icon: 'wrench',
    }),
    rows('Repairs in progress', 'maintenance_request', {
      query: 'underway',
      show: ['title', 'status', 'scheduled_on'],
      sort: 'reported_on',
      limit: 5,
      icon: 'wrench',
    }),
    embed('my-charges', { title: 'Your charges', limit: 6, icon: 'receipt' }),
  ],
  {
    icon: 'house',
    roles: ['resident'],
    heading: 'Welcome home',
    description: 'What you owe and how your repairs stand. Something broken? Report it and the office books a visit.',
  },
);
