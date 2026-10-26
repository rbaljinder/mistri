import { calendar, gantt, listView, tree } from '@mistriwork/mistri/app';
import type { Views } from './mistri-schema.d.ts';
import { pipelineLayout, salesDashboard } from './dashboard.ts';

/* Everything a Compass rep can open; navigation.ts arranges them. Column
   captions are the resources' (resources.ts), so a view's `show` lists
   columns and label paths only. */
export const views = {
  'sales-dashboard': salesDashboard,
  'pipeline-layout': pipelineLayout,
  leads: listView('Leads', 'lead', {
    icon: 'address-book',
    // Work a lead from the list: its own actions from a menu at the end of the row.
    rowActions: true,
    show: ['name', 'company', 'status', 'source', 'owner_id.name', 'created_on'],
    filters: ['status', 'source', 'created_on'],
    // Newest first on every tab, unless the reader sorts another way.
    sort: 'created_on desc',
    tabs: ['new', 'working', 'qualified', 'converted', 'lost', { label: 'All' }],
  }),
  opportunities: listView('Opportunities', 'opportunity', {
    icon: 'handshake',
    show: ['name', 'account_id.name', 'stage', 'amount', 'probability', 'weighted', 'close_date', 'owner_id.name', 'team'],
    filters: ['stage', 'close_date', 'owner_id', 'account_id.industry_id'],
    // The pipeline's value under the rows, over the whole tab, not the page — and at its odds, a computed column.
    totals: ['amount', 'weighted'],
    tabs: [
      { segment: 'open_pipeline', sort: 'close_date' },
      { segment: 'closing_soon', sort: 'close_date' },
      { segment: 'won', sort: 'close_date desc' },
      { segment: 'lost', sort: 'close_date desc' },
      { label: 'All', sort: 'close_date desc' },
    ],
  }),
  // The open deals as lanes of the stage machine: a card is dragged, or moved from its ⋯ menu or with Alt+←/→,
  // into a stage its verbs lead to — a lane it cannot enter dims while it is dragged — and the verb is the write.
  pipeline: listView('Pipeline', 'opportunity', {
    icon: 'kanban',
    open: 'modal',
    query: 'open_pipeline',
    board: {
      by: 'stage',
      primary: 'name',
      lines: ['amount'],
      footer: [{ column: 'close_date', icon: 'calendar' }, 'team'],
      // Where a deal ends, not work in hand: the closed stages are strips a reader opens.
      folded: ['closed_won', 'closed_lost'],
    },
    filterBar: 'none',
  }),
  accounts: listView('Accounts', 'account', {
    icon: 'buildings',
    show: ['name', 'industry_id.name', 'rating', 'city', 'open_deals', 'open_pipeline', 'owner_id.name'],
    filters: ['rating', 'country', 'industry_id', { has: 'opportunity', filter: 'stage' }, 'created_on'],
    tabs: [
      { segment: 'hot', sort: 'annual_revenue desc' },
      { segment: 'in_play', sort: 'open_pipeline desc' },
      { segment: 'new_this_quarter', sort: 'created_on desc' },
      { label: 'All', sort: 'name' },
    ],
  }),
  'account-tree': listView('Account hierarchy', 'account', {
    icon: 'buildings',
    // Each account under its parent company: a group's subsidiaries fold under it.
    presentation: tree('parent_account_id', 'name', { lines: ['city'] }),
  }),
  contacts: listView('Contacts', 'contact', {
    icon: 'user',
    show: ['name', 'title', 'account_id.name', 'email', 'phone', 'is_primary'],
    filters: ['is_primary', 'created_on'],
    sort: 'name',
    tabs: ['primary_contacts', { label: 'All' }],
    open: 'drawer',
  }),
  tasks: listView('Tasks', 'task', {
    icon: 'list-checks',
    show: ['subject', 'status', 'priority', 'due_on', 'owner_id.name', 'account_id.name'],
    // Triage happens in the list: a task's priority, due date and owner change
    // in place, and "Set field…" hands a whole selection to one person.
    editable: ['priority', 'due_on', 'owner_id'],
    // Worked by narrowing (open or done, whose, due when), so the filters are a
    // rail of counted facets beside the rows rather than a bar above them.
    filterBar: 'rail',
    filters: ['status', 'priority', 'is_urgent', 'due_on', 'owner_id'],
    tabs: [
      { segment: 'overdue', sort: 'due_on' },
      { segment: 'due_this_week', sort: 'due_on' },
      { segment: 'open', sort: 'due_on' },
      { segment: 'done', sort: 'due_on desc' },
      { label: 'All', sort: 'due_on desc' },
    ],
  }),
  activities: listView('Activities', 'activity', {
    icon: 'chat-circle',
    show: ['happened_on', 'kind', 'subject', 'account_id.name', 'contact_id.name', 'owner_id.name', 'minutes'],
    filters: ['kind', 'happened_on'],
    sort: 'happened_on desc',
    tabs: ['last_30_days', 'calls', 'meetings_demos', { label: 'All' }],
  }),
  'task-calendar': listView('Task calendar', 'task', {
    icon: 'calendar',
    // The same tasks on their due dates: the tabs narrow what the month shows.
    presentation: calendar('due_on', 'subject', {}),
    tabs: [
      { segment: 'open', sort: 'due_on' },
      { label: 'All', sort: 'due_on' },
    ],
  }),
  'campaign-schedule': listView('Campaign schedule', 'campaign', {
    icon: 'calendar',
    // The year's campaigns as spans, a row per kind, so what overlaps is seen at a glance.
    presentation: gantt('starts_on', 'ends_on', 'name', { by: 'kind' }),
  }),
  campaigns: listView('Campaigns', 'campaign', {
    icon: 'megaphone',
    show: ['name', 'kind', 'starts_on', 'ends_on', 'budget'],
    filters: ['kind', 'starts_on'],
    tabs: [
      { segment: 'running', sort: 'ends_on' },
      { segment: 'upcoming', sort: 'starts_on' },
      { segment: 'finished', sort: 'ends_on desc' },
      { label: 'All', sort: 'starts_on desc' },
    ],
  }),
  products: listView('Products', 'product', {
    icon: 'package',
    // A catalog is read as a ledger: tighter rows, more of it on screen.
    density: 'compact',
    show: ['sku', 'name', 'family', 'list_price', 'is_active'],
    filters: ['family', 'is_active'],
    sort: 'family',
    tabs: ['active', { label: 'All' }],
  }),
  'sales-team': listView('Sales team', 'sales_rep', {
    icon: 'users',
    show: ['name', 'title', 'region', 'manager_id.name', 'quota'],
    filters: ['region'],
    sort: 'name',
    tabs: ['amer', 'emea', 'apac', { label: 'All' }],
  }),
} satisfies Views;
