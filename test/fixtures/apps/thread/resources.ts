import { machine } from '@mistriwork/mistri/app';
import type { Resources } from './mistri-schema.d.ts';

/* What Thread says about each resource, once, wherever its records appear:
   how values dress, the New form, and what may be done to a record. */

/** Cancelling asks why, into the issue's own note. */
const cancelIssue = { to: 'canceled', label: 'Cancel issue', reason: 'cancel_note' } as const;
export const resources = {
  issue: {
    segments: {
      active: 'status != done and status != canceled',
      backlog_issues: { query: 'status = backlog', label: 'Backlog' },
      done_issues: { query: 'status = done', label: 'Done' },
      // Cycle 1 is the seeded planning window; the home's board and the Board view read it.
      current_cycle: 'cycle_id = 1 and status != canceled',
    },
    // What one is called, once: the New button, the Inbox's detail, the Issues list and the issue page say it.
    noun: 'issue',
    access: 'write',
    // Issues are closed or canceled, never deleted; the ones you follow get a star.
    favorite: true,
    // Labels ride on the issue: chips under its title, added and removed there.
    tags: { through: 'issue_label', to: 'label', toneOf: 'tone' },
    // One colour, one meaning, in a row that shows both: amber is work under
    // way, blue is waiting on a review, and only an urgent issue is red. High
    // stays in words, so it never reads as a status.
    display: {
      status: {
        tone: {
          backlog: 'neutral',
          ready: 'neutral',
          in_progress: 'warn',
          in_review: 'info',
          done: 'good',
          canceled: 'neutral',
        },
      },
      priority: { tone: { urgent: 'bad', high: 'neutral', normal: 'neutral', low: 'neutral' } },
      // Formatted, with pictures kept as the issue's attachments and an @ for a member.
      description: { format: 'richText', images: 'attachment', mentions: { from: 'member', by: 'id', labelColumn: 'name' } },
    },
    // The one New form, wherever an issue is created: Issues, Triage, Board, Inbox.
    form: {
      show: ['name', 'description', 'priority', 'assignee_id', 'project_id', 'cycle_id'],
    },
    // An issue's life, as the server holds it: status moves only along this
    // graph, and only by these verbs — on the issue page, a queue's selection
    // (the `bulk` ones, one write each, the result said per issue), a board's
    // drag (the verb that leads to the lane) and an import alike. New issues
    // start in the first state. The states' order is the issue's: the page's
    // stepper, the board's lanes and the header's verb read it, and a verb's
    // label is its word ("Mark ready"). Cancelling asks why, and the reason is
    // kept on the issue; a reason is one issue's, so it is not offered in bulk.
    // "Cancel issue", not "Cancel": its form has a Cancel too.
    machine: machine('status', {
      backlog: { on: { markReady: { to: 'ready', bulk: true }, cancelIssue } },
      ready: { on: { startWork: { to: 'in_progress', bulk: true }, cancelIssue } },
      in_progress: { on: { requestReview: 'in_review', cancelIssue } },
      in_review: { on: { markDone: 'done', sendBack: 'in_progress', cancelIssue } },
      done: { final: true },
      canceled: { final: true },
    }),
  },
  // A comment is an update wherever Thread shows one: "New update", the Updates split's detail.
  comment: {
    noun: 'update',
    access: 'write',
    // Formatted like an issue's description, with an @ for a member.
    display: { body: { format: 'richText', mentions: { from: 'member', by: 'id', labelColumn: 'name' } } },
    form: { show: ['issue_id', 'author_id', 'name', 'body'] },
  },
  // An issue's labels are link rows, added and removed one at a time.
  issue_label: {
    access: 'write',
    delete: true,
  },
  // Files on an issue: the bytes in a BLOB, their name, type and size beside
  // them. The issue page lists them and takes new ones; a wrong one is deleted.
  attachment: {
    access: 'write',
    delete: true,
    file: { content: 'data', name: 'file_name', type: 'content_type', size: 'byte_size' },
  },
  project: {
    display: {
      status: { tone: { planned: 'neutral', active: 'info', complete: 'good' } },
      // The lead's read of how the project is going, out of five stars: picked in the form, a glance in the list.
      health: { format: 'rating', tone: { '<= 2': 'bad' } },
    },
  },
  // Listed by a view with nothing more to say: declaring them brings them into the App.
  cycle: {},
  // A label is its name: /thread/label/bug. The database keeps it NOT NULL and UNIQUE, which `mistri check` proves.
  label: { address: 'name' },
  member: {},
} satisfies Resources;
