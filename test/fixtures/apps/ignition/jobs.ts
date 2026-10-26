// Explicit --jobs entry. Never import this module from the public App graph.
//
// The review clock: when a dealership converts a qualified lead, the committed
// fact schedules a job for the day after the lender's deadline, and the job then
// flags the application if nobody has decided it.
//
// The job runs `flagOverdueReview`, a **platform** command, so it runs as a
// platform service principal: `service:review-clock`, holding the App's
// `automation` role and nothing else. That role is a platform-realm role, and it
// has to be — a principal holding the other realm's roles is refused at startup.
// The consequences are worth knowing: the attempt is fenced on the `@platform`
// row rather than on the dealership's, so suspending one dealer does not stop
// the lender noticing its review is late, while suspending the lender stops the
// clock for everyone. The fact's tenant still bounds what the attempt may touch.
//
// Nothing about the principal signs in, so there is no account to bootstrap.
import { defineJob, defineJobs } from '@mistriwork/mistri/jobs';
import { applicationSubmitted } from './events.ts';

const DAY = 86_400_000;

export default defineJobs(
  {
    reviewDue: defineJob({
      on: { event: applicationSubmitted, command: 'convertLead' },
      runAs: 'review-clock',
      command: 'flagOverdueReview',
      /* Due at the first moment the review is overdue: the start of the day after
       the deadline the conversion recorded. The deadline travels in the input
       too, because when the job was scheduled there was no review file to read
       it from — the lender creates that when it assigns a reviewer. If one
       exists by the time the job runs, the command prefers its date, which a
       revision may have moved. */
      schedule: (event) => ({
        runAt: Date.parse(event.reviewDueOn) + DAY,
        key: { id: event.applicationId },
        input: { due_on: event.reviewDueOn },
      }),
    }),
  },
  {
    principals: { 'review-clock': { roles: ['automation'] } },
    store: { namespace: 'ignition' },
  },
);
