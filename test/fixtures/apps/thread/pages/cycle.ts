import { breakdown, fields, page, related } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';

export const cyclePage = page('cycle', [
  fields(['starts_on', 'ends_on']),
  fields(['goal'], { columns: 1 }),
  breakdown('Delivery status', 'issue', 'status', { whose: 'cycle_id', width: 'half' }),
  related('Cycle issues', 'issue', 'cycle_id', {
    show: ['name', 'status', 'priority', 'assignee_id.name'],
    width: 'half',
  }),
]) satisfies Page;
