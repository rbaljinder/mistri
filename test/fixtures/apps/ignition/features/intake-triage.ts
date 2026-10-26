import { action, defineFeature, fields, header, listView, navGroup, page, related } from '@mistriwork/mistri/app';
import type { Feature } from '../mistri-schema.d.ts';

/* The lender's triage queue: the public submissions no dealer's intake address
   placed.

   A submission lands here when its link carried no address, or one that is
   unknown, rotated, shared by two dealers, or belongs to a suspended dealership
   — and the visitor is answered exactly as they would be if it had landed in a
   dealership, so nothing about this queue's existence leaks through the form.

   **What the lender deliberately cannot do here is move a submission into a
   dealership.** The platform realm never inserts a dealer's row, by declaration
   rather than by omission, so there is no such command to offer. Staff follow
   the applicant up using that dealership's own published link, and close the
   submission with a note saying what they did. That is the whole of triage. */

export const intakeTriage = defineFeature({
  id: 'intake-triage',
  resources: {
    intake_submission: {
      segments: {
        in_triage: 'status = triage',
        closed: 'status = closed',
      },
      display: {
        requested_amount: { format: 'money' },
        down_payment: { format: 'money' },
        annual_income: { format: 'money' },
        status: { tone: { triage: 'warn', closed: 'neutral' } },
      },
      /* Named for the work, not its consequence: following the applicant up is
         what triage is for, and recording it is what closes the submission. */
      actions: { recordFollowUp: action('Record follow-up', { command: 'closeIntakeSubmission' }) },
    },
  },
  auth: {
    roles: {
      platform_admin: { commands: ['closeIntakeSubmission'] },
      manager: { commands: ['closeIntakeSubmission'] },
    },
  },
  views: {
    triage: listView('Intake triage', 'intake_submission', {
      icon: 'tray',
      realm: 'platform',
      show: ['reference', 'applicant_name', 'vehicle_stock', 'requested_amount', 'submitted_on', 'status'],
      filters: ['reference', 'status', 'submitted_on'],
      tabs: ['in_triage', 'closed', { label: 'All' }],
    }),
  },
  pages: {
    'intake-submission': page(
      'intake_submission',
      [
        // `dealer_hint` is only ever what the applicant typed, and nothing
        // resolves it: it is a note for whoever follows the applicant up, never a
        // routing decision.
        header({ status: 'status', facts: ['reference', { column: 'dealer_hint', before: 'Named' }, 'submitted_on'] }),
        fields(['requested_amount', 'down_payment', 'term_months'], { columns: 3 }),
        fields(['applicant_email', 'applicant_phone', 'vehicle_stock', 'employer', 'annual_income'], { title: 'Applicant', columns: 2 }),
        fields(['address_line', 'city', 'state', 'postal_code'], { title: 'Address', columns: 2 }),
        related('Co-applicants', 'intake_co_applicant', 'submission_id', { show: ['position', 'name', 'email'] }),
        fields(['outcome_note'], { title: 'How it was closed', columns: 1, when: 'status = closed' }),
      ],
      { realm: 'platform' },
    ),
  },
  nav: [navGroup('lender-triage', 'Intake', ['triage'], { realm: 'platform' })],
} satisfies Feature);
