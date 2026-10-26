import { listView } from '@mistriwork/mistri/app';
import type { TypedAppConfig } from '@mistriwork/mistri/app';
import { views as parentViews } from '../views.ts';
import type { Paths, Tables } from './schema.ts';

export const views = {
  ...parentViews,
  applications: listView('Applications', 'loan_application', {
    show: ['name', 'business_id', 'location_id.name', 'lead_id.name', 'status', 'reviewer_id.name'] satisfies Paths['loan_application'][],
    filters: ['name', 'location_id', 'status', 'reviewer_id'] satisfies Tables['loan_application'][],
  }),
  'review-staff': listView('Review staff', 'review_staff', {
    show: ['name', 'business_id', 'location_id.name', 'role', 'active'] satisfies Paths['review_staff'][],
    filters: ['name', 'location_id', 'role'] satisfies Tables['review_staff'][],
  }),
  'assignment-history': listView('Assignment history', 'assignment_history', {
    show: [
      'name',
      'application_id.name',
      'assigned_to.name',
      'assigned_by.name',
      'reason',
      'assigned_on',
    ] satisfies Paths['assignment_history'][],
  }),
} satisfies NonNullable<TypedAppConfig<Tables>['views']>;
