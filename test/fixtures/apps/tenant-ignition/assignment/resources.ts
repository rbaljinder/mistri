import { action } from '@mistriwork/mistri/app';
import type { TypedAppConfig } from '@mistriwork/mistri/app';
import { resources as parentResources } from '../resources.ts';
import type { Tables } from './schema.ts';

/* The parent's four resources, then the three this variant adds. The ceiling
   admits `loan_application` and `assignment_history` for assignReviewer's effects. */
export const resources = {
  ...parentResources,
  review_staff: { physical: 'physical_review_staff', owner: 'tenant' },
  loan_application: {
    noun: 'application',
    physical: 'physical_loan_application',
    owner: 'tenant',
    access: 'write',
    actions: {
      assignReviewer: action('Assign reviewer', {
        command: 'assignReviewer',
      }),
    },
  },
  assignment_history: { noun: 'assignment', physical: 'physical_assignment_history', owner: 'tenant', access: 'write' },
} satisfies Required<NonNullable<TypedAppConfig<Tables>['resources']>>;
