import { fields, page, related, stream, timeline } from '@mistriwork/mistri/app';

export const incidentPage = page(
  'incident',
  [
    fields(['reference', 'status', 'priority', 'caller_id', 'service_id', 'assignee_id', 'team_id', 'opened_at', 'due_at'], { columns: 3 }),
    fields(['name', 'description', 'resolution'], {
      title: 'Incident details',
      columns: 1,
    }),
    fields(['asset_id', 'problem_id', 'sla_id.name', 'sla_id.response_minutes', 'sla_id.resolution_minutes', 'sla_id.calendar'], {
      title: 'Service context',
      columns: 1,
      region: 'aside',
    }),
    timeline(
      'Activity',
      [
        stream('incident_note', 'incident_id', 'created_at', 'name', {
          detail: 'body',
        }),
      ],
      {
        limit: 12,
      },
    ),
    related('Work notes', 'incident_note', 'incident_id', {
      create: {
        label: 'Add work note',
        show: ['name', 'body', 'author_id'],
      },
      show: ['name', 'body', 'author_id.name', 'created_at'],
    }),
    related('Related incidents', 'incident', { same: ['service_id'] }, { show: ['reference', 'name', 'status', 'priority'], limit: 6 }),
    related('Knowledge', 'knowledge_article', { same: ['service_id'] }, { show: ['name', 'summary'], query: 'status = published' }),
    related(
      'Service changes',
      'change_request',
      { same: ['service_id'] },
      { show: ['reference', 'name', 'status', 'starts_at'], limit: 6 },
    ),
  ],
  { listTabs: true },
);
