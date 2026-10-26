import { activity, breakdown, chart, dashboard, embed, metric, note, rows } from '@mistriwork/mistri/app';

/* The two boards. Home is the credit and operations floor's: what waits on
   underwriting, how the answers have gone, the money out the door against
   the month's goal and the book it has built. Delinquency is servicing's:
   who is behind, by how far, and who promised what. */

const OPEN = 'status in (submitted, in_review, conditioned)';
const LIVE = 'status in (current, past_due, delinquent)';

/* The month's funding goal, in dollars. The dealers' own goals are counted in
   loans (dealer.monthly_goal), and a metric's target is a number written here,
   not a figure read from the data. */
const MONTHLY_FUNDING_GOAL = 250_000;

export const home = dashboard(
  'Home',
  [
    metric('Waiting for a decision', 'loan_application', { query: OPEN, width: 'third', icon: 'tray', to: 'queue' }),
    metric('Approved', 'loan_application', {
      query: 'status in (approved, countered, funded) and decided_at = last 30 days',
      over: 'decided_at',
      compare: 'previous period',
      better: 'up',
      width: 'third',
      icon: 'check-circle',
    }),
    metric('Declined', 'loan_application', {
      query: 'status = declined and decided_at = last 30 days',
      over: 'decided_at',
      compare: 'previous period',
      better: 'down',
      width: 'third',
      icon: 'x-circle',
    }),
    metric('Funded this month', 'funding', {
      query: 'status = funded and funded_on = this month',
      measure: 'sum amount',
      target: MONTHLY_FUNDING_GOAL,
      width: 'third',
      icon: 'bank',
      to: 'funded',
    }),
    metric('Portfolio balance', 'loan', { query: LIVE, measure: 'sum principal_balance', width: 'third', icon: 'wallet', to: 'loans' }),
    metric('Balance 30+ days past due', 'loan', {
      query: 'days_past_due >= 30 and status in (past_due, delinquent)',
      measure: 'sum principal_balance',
      width: 'third',
      icon: 'warning',
      to: 'collections',
    }),
    chart('Funded by dealer by month', 'funding', 'month funded_on, dealer_id.name', {
      query: 'status = funded and funded_on = last 12 months',
      measure: 'sum amount',
      shape: 'stacked',
      height: 240,
      icon: 'chart-bar',
    }),
    breakdown('The book by program tier', 'loan', 'application_id.program_id.tier', {
      query: LIVE,
      measure: 'sum principal_balance',
      width: 'half',
      icon: 'stack',
    }),
    chart('Decisions by outcome', 'loan_application', 'status', {
      query: 'status in (approved, countered, declined, funded) and decided_at = last 90 days',
      over: 'decided_at',
      shape: 'donut',
      width: 'half',
      icon: 'chart-pie',
    }),
    embed('queue', { title: 'Next in the queue', tab: 'all-open', limit: 6, icon: 'tray', width: 'half' }),
    rows('Late decisions', 'loan_application', {
      query: 'open_alerts > 0',
      show: ['reference', 'decision_due'],
      sort: 'decision_due',
      limit: 6,
      icon: 'hourglass',
      width: 'half',
    }),
    rows('Ready to fund', 'funding', {
      query: 'status = ready',
      show: ['application_id', 'dealer_id.name', 'amount'],
      sort: 'contract_received_on',
      limit: 5,
      icon: 'bank',
      width: 'half',
    }),
    activity(
      'Latest decisions and fundings',
      {
        loan_application: { icon: 'file-text' },
        funding: { icon: 'bank' },
        stipulation: { icon: 'list-checks' },
      },
      { limit: 6, icon: 'clock', width: 'half' },
    ),
    note(
      'Approved and Declined count decisions in the window you pick, against the window before it. Funded this month is the ' +
        'money wired to dealers since the first, against the month’s goal of $250,000. The book and its 30-day delinquency are ' +
        'balances today, whatever the window.',
      { title: 'Reading this board' },
    ),
  ],
  {
    icon: 'gauge',
    heading: 'Good day, {me.name}',
    description: 'Underwriting, funding and the book at Keystone Auto Finance.',
    windows: ['last 30 days', 'last 90 days', 'last 12 months'],
  },
);

export const delinquency = dashboard(
  'Delinquency',
  [
    metric('1–29 days', 'loan', { query: 'days_past_due >= 1 and days_past_due < 30', icon: 'clock' }),
    metric('30–59 days', 'loan', { query: 'days_past_due >= 30 and days_past_due < 60', icon: 'warning' }),
    metric('60–89 days', 'loan', { query: 'days_past_due >= 60 and days_past_due < 90', icon: 'warning' }),
    metric('90+ days', 'loan', { query: 'days_past_due >= 90 and status != charged_off', icon: 'fire' }),
    metric('Balance past due', 'loan', {
      query: 'days_past_due > 0 and status in (past_due, delinquent)',
      measure: 'sum principal_balance',
      icon: 'wallet',
    }),
    metric('Payments returned', 'payment', {
      query: 'status = returned and received_on = last 30 days',
      compare: 'previous period',
      better: 'down',
      icon: 'x-circle',
    }),
    embed('collections', { title: 'Collections', limit: 10, icon: 'phone', interactive: true }),
    breakdown('Balance behind, by dealer', 'loan', 'dealer_id.name', {
      query: 'days_past_due > 0 and status in (past_due, delinquent)',
      measure: 'sum principal_balance',
      width: 'half',
      limit: 8,
      icon: 'storefront',
    }),
    chart('Payments returned by month', 'payment', 'month received_on', {
      query: 'status = returned and received_on = last 12 months',
      shape: 'bar',
      width: 'half',
      icon: 'x-circle',
    }),
    rows('Promises due this week', 'servicing_note', {
      query: 'kind = promise_to_pay and promise_on = next 7 days',
      show: ['loan_id', 'promise_amount', 'promise_on'],
      sort: 'promise_on',
      limit: 6,
      icon: 'handshake',
      width: 'half',
    }),
    rows('Returned, last 30 days', 'payment', {
      query: 'status = returned and received_on = last 30 days',
      show: ['loan_id', 'amount', 'returned_reason'],
      sort: 'received_on desc',
      limit: 6,
      icon: 'x-circle',
      width: 'half',
    }),
  ],
  {
    icon: 'warning',
    description: 'Who is behind and by how far, counted in loans; the worklist below is the same buckets.',
  },
);
