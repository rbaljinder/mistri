/**
 * The landing screen, in its own file: an app is a module graph, hot
 * reload evaluates it whole. Every section names its own table; `over`
 * opts a section into the reader's time window; `compare: 'previous period'` derives the
 * shifted window from the query's own phrase.
 */
import { dashboard, metric, chart, breakdown, board, rows } from '@mistriwork/mistri/app';
import type { TypedDashboardView } from '@mistriwork/mistri/app';
import type { Tables } from './mistri-schema.d.ts';

export const revenueBoard = dashboard(
  'Revenue',
  [
    // consecutive metrics coalesce into one KPI strip
    metric('Open pipeline, all dates', 'opportunity', {
      query: 'stage != closed_won and stage != closed_lost',
      measure: 'sum amount as pipeline',
    }),
    /* The spark sits where the clock points backwards: won deals have
     close dates in the past, so the 12-month trend has something to
     say. (An open-pipeline spark would look forward and decline.) */
    metric('Won', 'opportunity', {
      query: 'stage = closed_won',
      measure: 'sum amount as won',
      over: 'close_date',
      spark: true,
    }),
    metric('New leads, 30 days', 'lead', {
      query: 'created_on = last 30 days',
      compare: 'previous period',
    }),

    chart('Bookings, last 12 months', 'opportunity', 'month close_date', {
      query: 'stage = closed_won and close_date = last 12 months',
      measure: 'sum amount as won',
      width: 'half',
    }),
    chart('Leads by source', 'lead', 'source', {
      shape: 'donut',
      width: 'half',
      over: 'created_on',
    }),

    /* The pipeline read: lanes in stage's own declared order, cards
     opening through the same seam as a row click. */
    board('Open pipeline, all dates', 'opportunity', 'stage', {
      query: 'stage != closed_won and stage != closed_lost',
      primary: 'name',
      lines: ['account_id.name'],
      sort: 'close_date',
      limit: 5,
    }),

    breakdown('Revenue by owner', 'opportunity', 'owner_id.name', {
      measure: 'sum amount as value',
      width: 'half',
      over: 'close_date',
      to: 'opportunities',
    }),
    rows('Upcoming open deals', 'opportunity', {
      query: 'stage != closed_won and stage != closed_lost and close_date >= today',
      show: ['name', 'account_id.name', 'amount', 'stage', 'close_date'],
      sort: 'close_date',
      limit: 8,
      width: 'half',
    }),
  ],
  {
    windows: ['last 30 days', 'last 90 days', 'this year'],
    filters: ['stage', 'owner_id'],
  },
) satisfies TypedDashboardView<Tables>;
