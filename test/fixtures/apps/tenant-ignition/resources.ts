import { action } from '@mistriwork/mistri/app';
import type { TypedAppConfig } from '@mistriwork/mistri/app';
import type { Rows, Tables } from './schema.ts';

/* Every logical resource, bound to its `physical_` table in the one source.
   The ceiling admits `follow_up` and `activity` for the command's effects;
   `location` stays read-only. Roles (app.ts) grant generic writes on `lead` only. */
export const resources = {
  location: { physical: 'physical_location', owner: 'tenant' },
  lead: {
    physical: 'physical_lead',
    owner: 'tenant',
    access: 'write',
    form: {
      show: ['business_id', 'name', 'location_id', 'status'] satisfies Tables['lead'][],
      defaults: { status: 'open' } satisfies Partial<Rows['lead']>,
    },
  },
  follow_up: {
    noun: 'follow-up',
    physical: 'physical_follow_up',
    owner: 'tenant',
    access: 'write',
    actions: { recordFollowUp: action('Record follow-up', { command: 'recordFollowUp' }) },
  },
  activity: { physical: 'physical_activity', owner: 'tenant', access: 'write' },
} satisfies Required<NonNullable<TypedAppConfig<Tables>['resources']>>;
