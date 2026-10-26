// Explicit --jobs entry. Never import this module from the App graph.
//
// The decision clock: submitting a deal records `application.submitted` with
// the moment Keystone owes an answer (four business hours out), and this job
// falls due then and runs `flagLateDecision` as the service principal
// `decision-clock`, which holds the platform role `automation` and nothing
// else. A platform command is fenced on the platform row, so a dealer being
// put on hold does not stop Keystone noticing its own late answer.
import { defineJob, defineJobs } from '@mistriwork/mistri/jobs';
import { applicationSubmitted } from './events.ts';

export default defineJobs(
  {
    decisionDue: defineJob({
      on: { event: applicationSubmitted, command: 'submitToLender' },
      runAs: 'decision-clock',
      command: 'flagLateDecision',
      schedule: (event) => ({
        // A minute past the deadline, so "late" is never a matter of a clock's rounding.
        runAt: Date.parse(`${event.dueAt.replace(' ', 'T')}Z`) + 60_000,
        key: { id: event.applicationId },
        input: { due_at: event.dueAt },
      }),
    }),
  },
  {
    principals: { 'decision-clock': { roles: ['automation'] } },
    store: { namespace: 'keystone-leads' },
  },
);
