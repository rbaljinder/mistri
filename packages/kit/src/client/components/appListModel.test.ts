import { expect, test } from 'vitest';
import { appListQuery, litTabFor, newRecordNoun, shownTabs, visibleQuestion, wholeQuery, type ListSpec } from './appListModel.js';

test("New makes one of the table's records: its resource's noun, else the table's own name", () => {
  // Never the list's label, which may name a layout or a workspace, and never a label singularised by rule.
  expect(newRecordNoun({}, 'lead')).toBe('lead');
  expect(newRecordNoun({}, 'work_order')).toBe('work order');
  expect(newRecordNoun({}, 'api_key')).toBe('API key');
  // Thread's Updates split lists `comment`, whose noun is "update"; Inbox lists issues.
  expect(newRecordNoun({ noun: { one: 'update', many: 'updates' } }, 'comment')).toBe('update');
  expect(newRecordNoun({ noun: { one: 'issue', many: 'issues' } }, 'issue')).toBe('issue');
  // A table named in the plural keeps its name until its resource says its noun.
  expect(newRecordNoun({}, 'statuses')).toBe('statuses');
  expect(newRecordNoun({ noun: { one: 'status', many: 'statuses' } }, 'statuses')).toBe('status');
});

test("a view's default sort is the view's: asked where nothing else sorts, and kept out of the bar", () => {
  const leads = {
    table: 'lead',
    label: 'Leads',
    sort: 'created_on desc',
    tabs: [
      { label: 'New', query: 'status = new' },
      { label: 'Oldest', query: 'status = new sort created_on' },
    ],
  } as ListSpec;
  expect(appListQuery(leads, 0)).toBe('lead status = new sort created_on desc');
  expect(visibleQuestion(leads, 'lead status = new sort created_on desc')).toBe('status = new');
  expect(wholeQuery(leads, 'status = new')).toBe('lead status = new sort created_on desc');
  // A tab's own sort wins over it, and so does the reader's.
  expect(appListQuery(leads, 1)).toBe('lead status = new sort created_on');
  expect(wholeQuery(leads, 'status = new sort name')).toBe('lead status = new sort name');
  expect(visibleQuestion(leads, 'lead status = new sort name')).toBe('status = new sort name');
});

test("a tab whose own sort is the view's lights on arrival, and its question is the tab, not a filter", () => {
  const templates = {
    table: 'ticket_template',
    label: 'Ticket templates',
    sort: 'uses desc',
    tabs: [
      { label: 'Offered', query: 'active = true sort uses desc' },
      { label: 'Recent', query: 'active = true sort last_used_at desc' },
      { label: 'All' },
    ],
  } as ListSpec;
  const tabs = shownTabs(templates);
  for (const i of [0, 1, 2]) {
    const arrived = visibleQuestion(templates, appListQuery(templates, i));
    expect(litTabFor(tabs, arrived, ['active'])).toBe(i);
  }
  // Picking a tab asks what it asks: its order back on through the view's.
  expect(wholeQuery(templates, tabs[0].query ?? '')).toBe(appListQuery(templates, 0));
  expect(wholeQuery(templates, tabs[1].query ?? '')).toBe(appListQuery(templates, 1));
});

test("a split list's authored limit is the view's: in its question, never a chip or a filter to clear", () => {
  const inbox = { table: 'issue', label: 'Inbox', limit: 25 } as ListSpec;
  expect(appListQuery(inbox)).toBe('issue limit 25');
  expect(visibleQuestion(inbox, 'issue limit 25')).toBe('');
  expect(visibleQuestion(inbox, 'issue status = open limit 25')).toBe('status = open');
  expect(wholeQuery(inbox, 'status = open')).toBe('issue status = open limit 25');
  expect(wholeQuery(inbox, '')).toBe('issue limit 25');
  // A limit the reader wrote is theirs, and stays theirs.
  expect(visibleQuestion(inbox, 'issue status = open limit 5')).toBe('status = open limit 5');
  expect(wholeQuery(inbox, 'status = open limit 5')).toBe('issue status = open limit 5');
});

test("a view's standing condition is the view's: the bar and the tabs see only what follows it", () => {
  const triage = {
    table: 'issue',
    label: 'Triage',
    query: 'status = backlog or status = ready',
    tabs: [{ label: 'All' }, { label: 'Urgent', query: 'priority = urgent' }],
  } as ListSpec;
  expect(visibleQuestion(triage, appListQuery(triage, 0))).toBe('');
  expect(visibleQuestion(triage, appListQuery(triage, 1))).toBe('priority = urgent');
  expect(visibleQuestion(triage, 'issue (status = backlog or status = ready) and priority = urgent and name contains x')).toBe(
    'priority = urgent and name contains x',
  );
  expect(wholeQuery(triage, 'priority = urgent')).toBe('issue (status = backlog or status = ready) and priority = urgent');
  expect(wholeQuery(triage, '')).toBe('issue (status = backlog or status = ready)');
  const lot = { table: 'vehicle', label: 'Vehicles', query: 'status != sold' } as ListSpec;
  expect(visibleQuestion(lot, 'vehicle status != sold')).toBe('');
  expect(visibleQuestion(lot, 'vehicle status != sold sort price')).toBe('sort price');
  // The reader's own `or` after the standing condition is theirs, and a link without it shows all of it.
  expect(visibleQuestion(lot, 'vehicle status != sold or make = Ford')).toBe('status != sold or make = Ford');
  expect(visibleQuestion(lot, 'vehicle make = Ford')).toBe('make = Ford');
  expect(wholeQuery(lot, 'status != sold and make = Ford')).toBe('vehicle status != sold and make = Ford');
});

test("a view's hand order is plumbing: asked wherever nothing else sorts, never shown, and any other sort wins", () => {
  const tasks = {
    table: 'task',
    label: 'Tasks',
    order: 'position',
    tabs: [
      { label: 'Open', query: 'completed = false' },
      { label: 'Upcoming', query: 'completed = false sort due_on' },
    ],
  } as ListSpec;
  expect(appListQuery(tasks, 0)).toBe('task completed = false sort position');
  // A tab with a sort of its own reads in it.
  expect(appListQuery(tasks, 1)).toBe('task completed = false sort due_on');
  expect(visibleQuestion(tasks, 'task completed = false sort position')).toBe('completed = false');
  expect(visibleQuestion(tasks, 'task completed = false sort name')).toBe('completed = false sort name');
  expect(wholeQuery(tasks, 'completed = false')).toBe('task completed = false sort position');
  expect(wholeQuery(tasks, 'completed = false sort name desc')).toBe('task completed = false sort name desc');
  // Clearing a reader's sort puts the order back.
  expect(wholeQuery(tasks, '')).toBe('task sort position');
});

test("a question that spells out a tab's segment is said in the tab's word, and lights that tab", async () => {
  const { state } = await import('../core.js');
  const before = state.schema;
  state.schema = {
    tables: [
      {
        id: 'incident',
        name: 'incident',
        columns: [],
        segments: { active: 'status != resolved and status != closed', critical: 'priority = critical and status != closed' },
      },
    ],
  } as unknown as typeof state.schema;
  try {
    const incidents = {
      table: 'incident',
      label: 'Incidents',
      tabs: [{ label: 'Active', query: 'active' }, { label: 'Critical', query: 'critical' }, { label: 'All' }],
    } as ListSpec;
    // A dashboard's drill: the Active tab's conditions and the priority's box, in any order.
    const drilled = visibleQuestion(incidents, 'incident status != resolved and priority = critical and status != closed sort due_at');
    expect(drilled).toBe('active and priority = critical sort due_at');
    expect(litTabFor(incidents.tabs!, 'active and priority = critical', ['priority', 'status'])).toBe(0);
    // Half a segment is not the segment: it stays as written.
    expect(visibleQuestion(incidents, 'incident status != resolved')).toBe('status != resolved');
    // A tab's own question is its word.
    expect(visibleQuestion(incidents, appListQuery(incidents, 0))).toBe('active');
  } finally {
    state.schema = before;
  }
});
