import { defineFeature, fields, header, listView, navGroup, page, related } from '@mistriwork/mistri/app';
import type { Feature } from '../mistri-schema.d.ts';
import { reviewFileColumns } from './review-file-columns.ts';

/* Who works for the lender, and on which desk.

   `lender_staff.account_id` is the load-bearing column here: a platform command
   finds its author by matching that against the verified account id the platform
   hands it. That is what replaced the old private `IGNITION_STAFF_MAP` file —
   who works for the lender is now the lender's own record, readable on this
   screen and audited when it changes, rather than a JSON file beside the server
   that nobody could inspect.

   A platform membership admits someone to the realm; this table says which of
   the lender's people they are. Both have to line up for a command to run, and
   neither substitutes for the other. Managing these rows is maintenance, not an
   App screen: platform memberships have no administration operation and no HTTP
   surface, by design. */

export const lenderStaff = defineFeature({
  id: 'lender-staff',
  resources: {
    lender_staff: {
      display: {
        role: { tone: { platform_admin: 'info', manager: 'info', reviewer: 'neutral' } },
        active: { tone: { true: 'good', false: 'bad' }, values: { true: 'Active', false: 'Inactive' } },
      },
    },
  },
  views: {
    staff: listView('Lender staff', 'lender_staff', {
      icon: 'users',
      realm: 'platform',
      show: ['name', 'role', 'desk_id.name', 'active'],
      filters: ['role', 'desk_id', 'active'],
    }),
    desks: listView('Review desks', 'review_desk', {
      icon: 'buildings',
      realm: 'platform',
      show: ['name', 'coverage'],
    }),
  },
  pages: {
    'lender-staff-member': page(
      'lender_staff',
      [
        header({ status: 'role', facts: ['desk_id', 'active'] }),
        // Deliberately not the account id: it is an opaque deployment identity,
        // and showing it on a record invites treating it as a name.
        related('Review files', 'review_file', 'reviewer_id', {
          show: [reviewFileColumns.application, reviewFileColumns.dealer, reviewFileColumns.deadline],
        }),
        related('Reviews recorded', 'application_review', 'reviewer_id', {
          show: ['application_id.reference', 'kind', 'status', 'completed_on'],
        }),
        related('Decisions recorded', 'loan_decision', 'decided_by', {
          show: ['application_id.reference', 'outcome', 'recorded_on'],
        }),
      ],
      { listTabs: true, realm: 'platform' },
    ),
    'review-desk': page(
      'review_desk',
      [
        fields(['name', 'coverage'], { columns: 2 }),
        related('Staff', 'lender_staff', 'desk_id', { show: ['name', 'role', 'active'] }),
        related('Review files', 'review_file', 'desk_id', {
          show: [reviewFileColumns.application, reviewFileColumns.dealer, reviewFileColumns.reviewer, reviewFileColumns.deadline],
        }),
      ],
      { listTabs: true, realm: 'platform' },
    ),
  },
  nav: [navGroup('lender-people', 'People', ['staff', 'desks'], { realm: 'platform' })],
} satisfies Feature);
