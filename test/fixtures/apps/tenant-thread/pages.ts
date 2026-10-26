import { fields, page, related } from '@mistriwork/mistri/app';
import type { TypedAppConfig } from '@mistriwork/mistri/app';
import type { Paths, Tables } from './schema.ts';

/* Keyed by page id. */
export const pages = {
  project: page('project', [
    fields(['name', 'business_id'] satisfies Paths['project'][]),
    related('Issues', 'issue', 'project_id' satisfies Tables['issue'], {
      show: ['name', 'business_id', 'project_id.name', 'status'] satisfies Paths['issue'][],
      create: { label: 'New issue', show: ['business_id', 'name', 'status'] satisfies Tables['issue'][] },
    }),
  ]),
  issue: page('issue', [
    fields(['name', 'business_id', 'project_id.name', 'status'] satisfies Paths['issue'][]),
    related('Discussions', 'discussion', 'issue_id' satisfies Tables['discussion'], {
      show: ['name', 'business_id', 'status'] satisfies Paths['discussion'][],
    }),
  ]),
  discussion: page('discussion', [
    fields(['name', 'business_id', 'project_id.name', 'issue_id.name', 'status'] satisfies Paths['discussion'][]),
    related('Comments', 'comment', 'discussion_id' satisfies Tables['comment'], {
      show: ['name', 'body', 'created_at'] satisfies Paths['comment'][],
      sort: 'created_at desc',
    }),
  ]),
  comment: page('comment', [fields(['name', 'discussion_id.name', 'body', 'created_at'] satisfies Paths['comment'][])]),
} satisfies NonNullable<TypedAppConfig<Tables>['pages']>;
