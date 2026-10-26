import { board, dashboard, embed, listView, metric, queue, rows } from '@mistriwork/mistri/app';
import type { Views } from './mistri-schema.d.ts';

/* Everything a Thread member can open. navigation.ts arranges them. */
export const views = {
  workspace: dashboard(
    'Workspace',
    [
      // Two cards over the one timestamp the schema has. The window phrase in
      // the query is the author's default; the reader's window pick replaces
      // it, and "previous period" is re-derived against whichever is picked.
      metric('Opened, last 30 days', 'issue', {
        query: 'created_at = last 30 days',
        over: 'created_at',
        compare: 'previous period',
        spark: true,
        width: 'half',
      }),
      metric('Closed, last 30 days', 'issue', {
        query: 'status = done and created_at = last 30 days',
        over: 'created_at',
        compare: 'previous period',
        better: 'up',
        spark: true,
        width: 'half',
      }),
      rows('Needs attention', 'issue', {
        query: 'priority = urgent and status != done and status != canceled',
        show: ['name', 'status', 'assignee_id.name', 'project_id.name'],
        limit: 6,
      }),
      // Cycle 1 is the seeded planning window; there is no automatic rollover.
      // A dashboard board takes label paths, so the card can name the assignee.
      board('Current cycle', 'issue', 'status', {
        query: 'current_cycle',
        primary: 'name',
        lines: ['assignee_id.name', 'priority'],
        limit: 3,
      }),
      // The Projects and Cycles views, drawn here read-only: their own columns,
      // stated once below, each across the page, where all four fit (at half, the last was left out).
      embed('projects', { limit: 6 }),
      embed('cycles', { limit: 3 }),
    ],
    { windows: ['last 30 days', 'last 90 days'], icon: 'house' },
  ),
  issues: listView('issue', {
    icon: 'list-checks',
    open: 'modal',
    show: ['name', 'status', 'priority', 'tags', 'assignee_id.name', 'project_id.name', 'cycle_id.name'],
    filters: ['name', 'status', 'priority', 'tags', 'assignee_id'],
    tabs: ['active', 'backlog_issues', 'done_issues', { label: 'All' }],
  }),
  // A second way to read the same issues, as a split list (preview): a
  // bounded list beside the whole issue, description included. The view key
  // is what tells it from Issues — both ask the same question of one table —
  // and is the list's address, `/thread/inbox`, so a link to a selected
  // issue, `/thread/inbox/~7`, reopens here and not as Issues' page.
  inbox: listView('Inbox', 'issue', {
    icon: 'tray',
    show: ['name', 'status', 'assignee_id.name'],
    // The list is the view's own; the split says the issue's fields beside it, the list's page, and how a row reads:
    // who it is with, its status, its priority. The keys run the issue's forward verbs on the picked issue, hints
    // beside each in its header, and are quiet while a field has focus.
    split: {
      limit: 25,
      detail: ['name', 'status', 'priority', 'assignee_id.name', 'project_id.name', 'description'],
      row: { primary: 'name', lines: ['assignee_id.name'], badge: 'status', properties: ['priority'], avatar: 'assignee_id.name' },
    },
    shortcuts: { m: 'markReady', s: 'startWork', r: 'requestReview', d: 'markDone' },
  }),
  // The planning queue: keyboard selection over what is not yet in flight,
  // offering the issue actions marked `bulk` for exactly the selected issues.
  triage: listView('Triage', 'issue', {
    icon: 'flag',
    open: 'modal',
    query: 'status = backlog or status = ready',
    show: ['name', 'status', 'priority', 'assignee_id.name'],
    presentation: queue('name', { lines: ['status', 'priority'] }),
    filters: ['priority', 'assignee_id'],
  }),
  // The cycle board: lanes are the issue machine's states in their order, and a
  // card moves only by the verb that leads to its lane from where it stands,
  // judged on the server. No lane the machine does not hold is offered.
  board: listView('Board', 'issue', {
    icon: 'kanban',
    open: 'modal',
    query: 'current_cycle',
    // A lane per state of the issue's machine, in its order; each in `rank` order: a card is dragged into
    // place, or moved with Alt+↑/↓ or its ⋯ menu, and into another lane by the verb that leads there.
    // The limits are the team's work in progress, shown on the lane heads and never enforced.
    board: { by: 'status', order: 'rank', primary: 'name', lines: ['priority'], limits: { in_progress: 4, in_review: 2 } },
    filterBar: 'none',
  }),
  // Planning: the open issues by cycle, a lane per cycle after one for none, and a row per priority.
  // The cycle is an ordinary column, so a card is dragged to another cycle or row as an edit, undoable.
  planning: listView('Planning', 'issue', {
    icon: 'calendar-check',
    open: 'modal',
    query: 'status != canceled and status != done',
    show: ['name', 'status', 'priority'],
    board: { by: 'cycle_id', order: 'rank', swimlanes: 'priority', primary: 'name', lines: ['status'] },
    filterBar: 'none',
  }),
  projects: listView('Projects', 'project', { icon: 'folder', show: ['name', 'status', 'health', 'lead_id.name', 'target_on'] }),
  cycles: listView('Cycles', 'cycle', { icon: 'calendar', show: ['name', 'starts_on', 'ends_on', 'goal'] }),
  // The split list (preview): choosing an update keeps a bounded list of
  // updates beside it and reads the whole update — body included — in the
  // detail pane, with the address naming the selected row. It is `comment`'s
  // one view, so an update opened from anywhere, the issue page's activity
  // included, opens here.
  updates: listView('Updates', 'comment', {
    icon: 'chat-circle',
    show: ['name', 'issue_id.name', 'author_id.name'],
    split: { limit: 25, detail: ['name', 'issue_id.name', 'author_id.name', 'created_at', 'body'] },
  }),
  people: listView('People', 'member', { icon: 'users', show: ['name', 'team', 'role'], open: 'drawer' }),
} satisfies Views;
