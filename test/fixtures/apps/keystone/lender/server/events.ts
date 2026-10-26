// The committed facts the credit decision runs on (server/credit-decision.ts).
// Identifiers and a score only: each is kept until pruned and copied into the
// workflow instance it wakes, so none carries an applicant's details.
import { defineEvent, int, shape, text } from '@mistriwork/mistri/commands';

/** An underwriter asked for a credit check on an application; the workflow requests it from the provider. */
export const creditCheckRequested = defineEvent('credit.check-requested', shape({ applicationId: text({ max: 128 }) }));

/** The provider's signed callback was accepted: its check `checkId` found `score` for the application. */
export const creditReported = defineEvent(
  'credit.reported',
  shape({
    applicationId: text({ max: 128 }),
    checkId: text({ max: 128 }),
    score: int({ min: 300, max: 850 }),
  }),
);

/** An underwriter answered the application: approved, countered or declined. */
export const applicationDecided = defineEvent(
  'application.decided',
  shape({ applicationId: text({ max: 128 }), outcome: text({ max: 128 }) }),
);
