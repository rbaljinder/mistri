import { breakdown, fields, metric, page, related } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';

export const projectPage = page('project', [
  fields(['status', 'health', 'lead_id', 'target_on']),
  // Prose on a line of its own: a summary's cell would cut it at its measure.
  fields(['summary'], { columns: 1 }),
  breakdown('Issue status', 'issue', 'status', { whose: 'project_id', width: 'half' }),
  metric('Open issues', 'issue', { whose: 'project_id', query: 'status != done and status != canceled', width: 'half' }),
  related('Issues', 'issue', 'project_id', {
    show: ['name', 'status', 'priority', 'assignee_id.name', 'cycle_id.name'],
  }),
  // The project's plan: its issues under their cycle, in rank order. A row is dragged (or moved by Alt and an arrow)
  // to another cycle or its place in one, an ordinary edit of `cycle_id` and `rank`.
  related('Plan', 'issue', 'project_id', {
    group: { by: 'cycle_id', show: ['starts_on', 'ends_on'], sort: 'starts_on', empty: 'Unplanned' },
    show: ['name', 'status', 'priority'],
    sort: 'rank',
    limit: 6,
  }),
]) satisfies Page;
