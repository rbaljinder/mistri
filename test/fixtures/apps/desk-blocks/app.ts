/*
 * Desk blocks: the browser gate's own App for the desk blocks — a conversation timeline with its composer and the
 * caller's side, a split that chooses its rows and keys, a header that names its verbs, a change calendar over its
 * freezes and holidays, and a dashboard with an author's component. Owned by the test suite, not by examples/, so a
 * public sample being reshaped cannot take the gate down. Sized to its specs and nothing more.
 */
import {
  action,
  calendar,
  component,
  custom,
  dashboard,
  defineApp,
  fields,
  header,
  listView,
  metric,
  page,
  stream,
  timeline,
} from '@mistriwork/mistri/app';
import type { App } from './mistri-schema.d.ts';

/** The urgent tickets still open, drawn by the desk's own component under the reader's window. */
export const urgentNow = custom('Urgent and open', component('urgent-queue', { module: './widgets/UrgentQueue.tsx' }), {
  width: 'half',
  rows: {
    urgent: { from: 'ticket', query: 'priority = urgent and status != solved', show: ['id', 'name', 'requester'], over: 'opened_at' },
  },
});

export default defineApp({
  id: 'desk-blocks',
  name: 'Desk blocks',
  track: 'receipts',
  sources: { desk: { connection: 'desk' } },
  resources: {
    person: {},
    ticket: {
      noun: 'ticket',
      access: 'write',
      display: { status: { tone: { open: 'warn', pending: 'info', solved: 'good' } } },
      actions: {
        reply: action('Reply', { command: 'reply' }),
        addNote: action('Add note', { command: 'addNote' }),
        solve: action('Solve', { set: { status: 'solved' }, when: 'status != solved' }),
        reopen: action('Reopen', { set: { status: 'open' }, when: 'status = solved' }),
        hold: action('Put on hold', { set: { status: 'pending' }, when: 'status = open' }),
      },
    },
    message: { access: 'write' },
    canned_reply: { noun: 'canned reply' },
    change: {},
    freeze: {},
    // Shaded behind the changes, with no view of its own: its spans are words, not links.
    holiday: {},
  },
  auth: {
    providers: ['email'],
    defaultRole: 'agent',
    roles: {
      agent: { label: 'Agent', read: true, write: false, commands: ['reply', 'addNote'], actions: { ticket: ['solve', 'reopen', 'hold'] } },
    },
  },
  views: {
    inbox: listView('Inbox', 'ticket', {
      show: ['name', 'status', 'requester'],
      split: {
        limit: 25,
        detail: ['name', 'status', 'priority'],
        row: { primary: 'name', lines: ['requester'], badge: 'status', properties: ['priority'], avatar: 'requester' },
      },
      shortcuts: { s: 'solve', h: 'hold' },
    }),
    all: listView('All tickets', 'ticket', { show: ['name', 'status', 'requester'] }),
    // The month's changes over the freezes that hold them back and the days the office is closed.
    changes: listView('Changes', 'change', {
      presentation: calendar('starts_on', 'name', {
        end: 'ends_on',
        backdrop: [
          { from: 'freeze', start: 'starts_on', end: 'ends_on', labelColumn: 'name', tone: 'warn' },
          { from: 'holiday', start: 'starts_on', end: 'ends_on', labelColumn: 'name' },
        ],
      }),
    }),
    freezes: listView('Freezes', 'freeze', { show: ['name', 'starts_on', 'ends_on'] }),
    desk: dashboard('Desk', [metric('Open tickets', 'ticket', { query: 'status != solved', over: 'opened_at' }), urgentNow], {
      windows: ['last 7 days', 'last 30 days'],
    }),
  },
  pages: {
    ticket: page(
      'ticket',
      [
        header({ actions: ['solve', 'hold'] }),
        fields(['name', 'requester', 'priority'], { columns: 3 }),
        timeline('Conversation', [stream('message', 'ticket_id', 'sent_at', 'body', { author: 'author_id' })], {
          newest: 'last',
          limit: 30,
          tone: { kind: { internal: 'warn' } },
          compact: { kind: ['system'] },
          // Canned replies fill the box and send nothing; the author is a reference, said by the agent's name.
          composer: { reply: 'reply', note: 'addNote', templates: { from: 'canned_reply', labelColumn: 'title', text: 'body' } },
          // The caller's messages against the far edge; the desk's along this one.
          side: 'author_id = record.caller_id',
        }),
        fields(['status', 'agent_id'], { region: 'aside', editable: true }),
      ],
      { listTabs: false },
    ),
  },
  home: 'inbox',
  nav: ['inbox', 'all', 'changes', 'freezes', 'desk'],
  ui: { locale: 'en-US', export: false },
} satisfies App);
