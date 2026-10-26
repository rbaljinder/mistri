import { dashboard, listView, rows } from '@mistriwork/mistri/app';
import type { TypedAppConfig } from '@mistriwork/mistri/app';
import type { Paths, Tables } from './schema.ts';

export const views = {
  overview: dashboard('Overview', [
    rows('Open leads', 'lead', {
      query: 'status = open',
      show: ['name', 'business_id', 'location_id.name', 'status'] satisfies Paths['lead'][],
    }),
    rows('Open follow-ups', 'follow_up', {
      query: 'status = open',
      show: ['name', 'business_id', 'lead_id.name', 'status'] satisfies Paths['follow_up'][],
    }),
    rows('Locations', 'location', {
      show: ['name', 'business_id'] satisfies Paths['location'][],
    }),
  ]),
  locations: listView('Locations', 'location', {
    show: ['name', 'business_id'] satisfies Paths['location'][],
  }),
  leads: listView('Leads', 'lead', {
    show: ['name', 'business_id', 'location_id.name', 'status'] satisfies Paths['lead'][],
    filters: ['name', 'location_id', 'status'] satisfies Tables['lead'][],
  }),
  'follow-ups': listView('Follow-ups', 'follow_up', {
    show: ['name', 'business_id', 'location_id.name', 'lead_id.name', 'status'] satisfies Paths['follow_up'][],
  }),
  activity: listView('Activity', 'activity', {
    show: ['name', 'follow_up_id.name', 'body', 'created_at'] satisfies Paths['activity'][],
  }),
} satisfies NonNullable<TypedAppConfig<Tables>['views']>;
