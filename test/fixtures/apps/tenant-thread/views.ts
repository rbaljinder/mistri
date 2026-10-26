import { dashboard, listView, rows } from '@mistriwork/mistri/app';
import type { TypedAppConfig } from '@mistriwork/mistri/app';
import type { Paths, Tables } from './schema.ts';

export const views = {
  overview: dashboard('Overview', [
    rows('Open issues', 'issue', {
      query: 'status = open',
      show: ['name', 'business_id', 'project_id.name', 'status'] satisfies Paths['issue'][],
    }),
    rows('Open discussions', 'discussion', {
      query: 'status = open',
      show: ['name', 'business_id', 'issue_id.name', 'status'] satisfies Paths['discussion'][],
    }),
    rows('Projects', 'project', {
      show: ['name', 'business_id'] satisfies Paths['project'][],
    }),
  ]),
  projects: listView('Projects', 'project', {
    show: ['name', 'business_id'] satisfies Paths['project'][],
  }),
  issues: listView('Issues', 'issue', {
    show: ['name', 'business_id', 'project_id.name', 'status'] satisfies Paths['issue'][],
    filters: ['name', 'project_id', 'status'] satisfies Tables['issue'][],
  }),
  discussions: listView('Discussions', 'discussion', {
    show: ['name', 'business_id', 'project_id.name', 'issue_id.name', 'status'] satisfies Paths['discussion'][],
  }),
  comments: listView('Comments', 'comment', {
    show: ['name', 'discussion_id.name', 'body', 'created_at'] satisfies Paths['comment'][],
  }),
} satisfies NonNullable<TypedAppConfig<Tables>['views']>;
