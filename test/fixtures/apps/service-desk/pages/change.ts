import { fields, page, related, stream, timeline } from '@mistriwork/mistri/app';

export const changePage = page(
  'change_request',
  [
    fields(['reference', 'status', 'risk', 'kind', 'service_id', 'owner_id', 'team_id', 'starts_at', 'ends_at'], { columns: 3 }),
    fields(['name', 'reason', 'implementation_plan'], {
      title: 'Implementation',
      columns: 1,
      width: 'half',
    }),
    fields(['rollback_plan', 'validation_plan', 'problem_id'], {
      title: 'Recovery and validation',
      columns: 1,
      width: 'half',
    }),
    related('Approvals', 'change_approval', 'change_id', {
      create: {
        label: 'Add reviewer',
        show: ['name', 'reviewer_id'],
      },
      show: ['name', 'reviewer_id.name', 'decision', 'rationale'],
    }),
    related('Implementation tasks', 'change_task', 'change_id', {
      create: {
        label: 'Add task',
        show: ['name', 'owner_id', 'instructions', 'due_at'],
      },
      show: ['name', 'owner_id.name', 'status', 'due_at'],
    }),
    timeline(
      'Activity',
      [
        stream('change_note', 'change_id', 'created_at', 'name', {
          detail: 'body',
        }),
      ],
      {
        limit: 12,
      },
    ),
    related('Work notes', 'change_note', 'change_id', {
      create: {
        label: 'Add change note',
        show: ['name', 'body', 'author_id'],
      },
      show: ['name', 'body', 'author_id.name', 'created_at'],
    }),
  ],
  { listTabs: true },
);
