import { fields, page, related } from '@mistriwork/mistri/app';
import type { TypedAppConfig } from '@mistriwork/mistri/app';
import { pages as parentPages } from '../pages.ts';
import type { Paths, Tables } from './schema.ts';

/* Keyed by page id; the parent's pages keep their ids and order. */
export const pages = {
  ...parentPages,
  lead: {
    ...parentPages.lead,
    listTabs: true,
    sections: [
      ...(parentPages.lead.sections ?? []),
      related('Applications', 'loan_application', 'lead_id' satisfies Tables['loan_application'], {
        show: ['name', 'business_id', 'status', 'reviewer_id.name'] satisfies Paths['loan_application'][],
      }),
    ],
  },
  loan_application: page('loan_application', [
    fields(['name', 'business_id', 'location_id', 'lead_id', 'status', 'reviewer_id', 'version'] satisfies Paths['loan_application'][]),
    // Related lists intentionally omit id; the framework fetches navigation keys.
    related('Assignments', 'assignment_history', 'application_id' satisfies Tables['assignment_history'], {
      show: ['name', 'assigned_to.name', 'assigned_by.name', 'reason', 'assigned_on'] satisfies Paths['assignment_history'][],
      sort: 'assigned_on desc',
    }),
  ]),
  review_staff: page(
    'review_staff',
    [
      fields(['name', 'business_id', 'location_id', 'role', 'active'] satisfies Paths['review_staff'][]),
      related('Assigned applications', 'loan_application', 'reviewer_id' satisfies Tables['loan_application'], {
        show: ['name', 'business_id', 'lead_id.name', 'status'] satisfies Paths['loan_application'][],
      }),
      related('Assignments', 'assignment_history', 'assigned_to' satisfies Tables['assignment_history'], {
        show: ['name', 'application_id.name', 'assigned_by.name', 'reason', 'assigned_on'] satisfies Paths['assignment_history'][],
        sort: 'assigned_on desc',
      }),
    ],
    { listTabs: true },
  ),
  assignment_history: page('assignment_history', [
    fields([
      'name',
      'application_id',
      'location_id',
      'assigned_to',
      'assigned_by',
      'reason',
      'assigned_on',
    ] satisfies Paths['assignment_history'][]),
  ]),
} satisfies NonNullable<TypedAppConfig<Tables>['pages']>;
