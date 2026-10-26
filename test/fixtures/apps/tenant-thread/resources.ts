import { action } from '@mistriwork/mistri/app';
import type { TypedAppConfig } from '@mistriwork/mistri/app';
import type { Rows, Tables } from './schema.ts';

/* Every logical resource, bound to its `physical_` table in the one source.
   The ceiling admits `discussion` and `comment` for the command's effects;
   `project` stays read-only. Roles (app.ts) grant generic writes on `issue` only. */
export const resources = {
  project: { physical: 'physical_project', owner: 'tenant' },
  issue: {
    physical: 'physical_issue',
    owner: 'tenant',
    access: 'write',
    form: {
      show: ['business_id', 'name', 'project_id', 'status'] satisfies Tables['issue'][],
      defaults: { status: 'open' } satisfies Partial<Rows['issue']>,
    },
  },
  discussion: {
    physical: 'physical_discussion',
    owner: 'tenant',
    access: 'write',
    actions: { addDiscussion: action('Add discussion', { command: 'addDiscussion' }) },
  },
  comment: { physical: 'physical_comment', owner: 'tenant', access: 'write' },
} satisfies Required<NonNullable<TypedAppConfig<Tables>['resources']>>;
