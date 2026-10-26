import { fields, page, related } from '@mistriwork/mistri/app';
import type { TypedAppConfig } from '@mistriwork/mistri/app';
import type { Paths, Tables } from './schema.ts';

/* Keyed by page id. */
export const pages = {
  location: page('location', [
    fields(['name', 'business_id'] satisfies Paths['location'][]),
    related('Leads', 'lead', 'location_id' satisfies Tables['lead'], {
      show: ['name', 'business_id', 'location_id.name', 'status'] satisfies Paths['lead'][],
      create: { label: 'New lead', show: ['business_id', 'name', 'status'] satisfies Tables['lead'][] },
    }),
  ]),
  lead: page('lead', [
    fields(['name', 'business_id', 'location_id.name', 'status'] satisfies Paths['lead'][]),
    related('Follow-ups', 'follow_up', 'lead_id' satisfies Tables['follow_up'], {
      show: ['name', 'business_id', 'status'] satisfies Paths['follow_up'][],
    }),
  ]),
  follow_up: page('follow_up', [
    fields(['name', 'business_id', 'location_id.name', 'lead_id.name', 'status'] satisfies Paths['follow_up'][]),
    related('Activity', 'activity', 'follow_up_id' satisfies Tables['activity'], {
      show: ['name', 'body', 'created_at'] satisfies Paths['activity'][],
      sort: 'created_at desc',
    }),
  ]),
  activity: page('activity', [fields(['name', 'follow_up_id.name', 'body', 'created_at'] satisfies Paths['activity'][])]),
} satisfies NonNullable<TypedAppConfig<Tables>['pages']>;
