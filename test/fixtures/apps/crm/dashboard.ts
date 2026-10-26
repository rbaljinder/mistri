import { breakdown, chart, dashboard, funnel, matrix, metric, note, rows } from '@mistriwork/mistri/app';

export const salesDashboard = dashboard(
  'Sales dashboard',
  [
    // The board's introduction: a ground of its own across the width, and the one next step it points at.
    note('Work the leads that came in this week before they cool: the newest are first, with their source and owner.', {
      title: 'Pipeline review',
      variant: 'banner',
      eyebrow: 'This week',
      action: { label: 'Open leads', to: 'leads' },
    }),
    metric('Open pipeline', 'opportunity', {
      query: 'open_pipeline',
      measure: 'sum amount as pipeline',
      width: 'third',
      over: 'close_date',
    }),
    metric('Won', 'opportunity', {
      query: 'stage = closed_won and close_date = last 90 days',
      measure: 'sum amount as won',
      compare: 'previous period',
      width: 'third',
      better: 'up',
      over: 'close_date',
      spark: true,
    }),
    metric('New leads', 'lead', {
      query: 'created_on = last 30 days',
      compare: 'previous period',
      width: 'third',
      better: 'up',
      over: 'created_on',
    }),
    chart('Bookings by month', 'opportunity', 'month close_date', {
      query: 'stage = closed_won and close_date = last 12 months',
      measure: 'sum amount as won',
    }),
    // Two keys draw a line per source; a smooth curve never overshoots a month's count.
    chart('New leads by source', 'lead', 'month created_on, source', {
      query: 'created_on = last 12 months',
      curve: 'smooth',
    }),
    breakdown('Pipeline by stage', 'opportunity', 'stage', {
      query: 'open_pipeline',
      measure: 'sum amount as value',
      width: 'half',
      over: 'close_date',
      to: 'opportunities',
    }),
    chart('Leads by source', 'lead', 'source', { width: 'half', shape: 'donut', total: 'Leads', over: 'created_on' }),
    // The pipeline as a flow, its stages in their order: how many deals reached each, as a share of the one before.
    funnel(
      'Pipeline funnel',
      'opportunity',
      [
        { label: 'Prospecting' },
        { label: 'Qualification', query: 'stage in (qualification, proposal, negotiation, closed_won)' },
        { label: 'Proposal', query: 'stage in (proposal, negotiation, closed_won)' },
        { label: 'Negotiation', query: 'stage in (negotiation, closed_won)' },
        { label: 'Won', query: 'stage = closed_won' },
      ],
      {
        query: 'not_lost',
        width: 'half',
        over: 'close_date',
        to: 'opportunities',
      },
    ),
    // Each rep as a dot: how many deals across, what they are worth up, so a rep with few large deals stands apart.
    chart('Reps: deals and value', 'opportunity', 'owner_id.name', {
      query: 'not_lost',
      shape: 'scatter',
      x: 'count',
      measure: 'sum amount as value',
      width: 'half',
      over: 'close_date',
      to: 'opportunities',
    }),
    // An activity logs its minutes; a month's total is a time taken, said "3d 18h", not a count of minutes.
    chart('Time with customers', 'activity', 'month happened_on', {
      query: 'happened_on = last 12 months',
      measure: 'sum minutes * 60 as time',
      format: 'duration',
      shape: 'bar',
      width: 'half',
      over: 'happened_on',
    }),
    // What the open pipeline is worth at its stages' odds, as a share of what it is worth outright.
    breakdown('Pipeline confidence by rep', 'opportunity', 'owner_id.name', {
      query: 'open_pipeline',
      measure: 'sum weighted / sum amount * 100 as confidence',
      format: 'percent',
      limit: 8,
      width: 'half',
      over: 'close_date',
      to: 'opportunities',
    }),
    matrix('Pipeline: stage × month', 'opportunity', 'stage, month close_date', {
      measure: 'sum amount as value',
      query: 'close_date = this year',
      to: 'opportunities',
    }),
    rows('Closing soon', 'opportunity', {
      query: 'stage != closed_won and stage != closed_lost and close_date = next 30 days',
      show: ['name', 'account_id.name', 'account_id.rating', 'stage', 'amount', 'close_date', 'team'],
      sort: 'close_date',
      limit: 8,
    }),
    rows('Overdue tasks', 'task', {
      query: 'status = open and due_on < today',
      show: ['subject', 'priority', 'due_on', 'owner_id.name'],
      sort: 'due_on',
      limit: 8,
      width: 'half',
    }),
    rows('Hot accounts', 'account', {
      query: 'rating = hot',
      show: ['name', 'industry_id.name', 'city', 'owner_id.name'],
      sort: 'name',
      limit: 8,
      width: 'half',
      over: 'created_on',
    }),
    note(
      'Pipeline counts every open opportunity; Won compares the last 90 days against the 90 before, ' +
        'with its monthly trend drawn in the card, and New leads the last 30 days against the 30 before.\n\n' +
        'Pick a window above — 30 days, 90 days or this year — to narrow the pipeline, won, leads, stage and account ' +
        'sections; each card title says the window it counts, and Won and New leads then compare against the period ' +
        'before the one picked. Closing soon always looks 30 days ahead.',
      { title: 'Reading this board' },
    ),
  ],
  {
    icon: 'gauge',
    filters: ['owner_id', 'stage'],
    // One button that opens the windows, beside the filters, rather than a row of them.
    windowControl: 'button',
    // The offered windows, spelled in the query grammar; the note above names them.
    windows: ['last 30 days', 'last 90 days', 'this year'],
  },
);

/* The same pipeline placed on a grid (e2e/dashboard-row-height.spec.ts): a strip across the top, a chart beside a
   column that stacks two breakdowns and runs down two rows, and the list under the chart. Not in the menu. */
export const pipelineLayout = dashboard(
  'Pipeline layout',
  [
    metric('Open pipeline', 'opportunity', { query: 'open_pipeline', measure: 'sum amount as pipeline', area: 'kpis' }),
    metric('New leads', 'lead', {
      query: 'created_on = last 30 days',
      compare: 'previous period',
      better: 'up',
      over: 'created_on',
      area: 'kpis',
    }),
    metric('Won', 'opportunity', {
      query: 'stage = closed_won',
      measure: 'sum amount as won',
      over: 'close_date',
      spark: true,
      area: 'kpis',
    }),
    chart('Bookings by month', 'opportunity', 'month close_date', {
      query: 'stage = closed_won and close_date = last 12 months',
      measure: 'sum amount as won',
      area: 'trend',
    }),
    breakdown('Pipeline by stage', 'opportunity', 'stage', {
      query: 'open_pipeline',
      measure: 'sum amount as value',
      to: 'opportunities',
      area: 'side',
    }),
    breakdown('Leads by source', 'lead', 'source', { to: 'leads', area: 'side' }),
    rows('Closing soon', 'opportunity', {
      query: 'stage != closed_won and stage != closed_lost and close_date = next 30 days',
      show: ['name', 'account_id.name', 'stage', 'amount', 'close_date'],
      sort: 'close_date',
      limit: 6,
      area: 'work',
    }),
  ],
  {
    icon: 'gauge',
    areas: ['kpis  kpis  kpis', 'trend trend side', 'work  work  side'],
  },
);
