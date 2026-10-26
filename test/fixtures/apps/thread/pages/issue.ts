import { fields, header, page, related, stream, timeline } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';

export const issuePage = page(
  'issue',
  [
    // The head draws the forward verbs; sending back and cancelling wait in More.
    header({ actions: ['markReady', 'startWork', 'requestReview', 'markDone'] }),
    // The issue's stepper is drawn here from its machine: the forward path, and
    // `canceled` left off because it is an exit, not a step.
    fields(['name', 'assignee_id', 'project_id'], { columns: 3 }),
    fields(['description'], { title: 'Description', width: 'half' }),
    // One place for the conversation: the updates as they happened, who wrote
    // them, oldest first (newest last) like a conversation and read to its end, and the way to add one, bound to this issue.
    timeline('Activity', [stream('comment', 'issue_id', 'created_at', 'name', { detail: 'body', author: 'author_id.name' })], {
      width: 'half',
      limit: 12,
      newest: 'last',
      create: { label: 'Add update', show: ['name', 'body', 'author_id'] },
    }),
    // The properties in the side panel, compact: the same editable fields, off
    // to the side of the words and the activity. Not status: the strip above
    // says where the issue stands, and it moves only through the issue actions.
    fields(['priority', 'cycle_id'], { presentation: 'summary', columns: 1, region: 'aside', editable: true }),
    // The issue's files: each one previews or downloads, is renamed or removed
    // from its row's menu, and Attach file (or a drop) adds one.
    related('Attachments', 'attachment', 'issue_id', {
      show: ['file_name', 'byte_size', 'added_at'],
      limit: 10,
      create: { label: 'Attach file' },
    }),
    related('Project issues', 'issue', { same: ['project_id'] }, { show: ['name', 'status', 'priority', 'assignee_id.name'], limit: 8 }),
  ],
  { listTabs: false },
) satisfies Page;
