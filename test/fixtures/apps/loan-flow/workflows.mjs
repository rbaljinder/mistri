import { defineInbound, defineJobs, hmac } from '../../../../packages/mistri/src/server/jobs.ts';
import { defineWorkflow, defineWorkflows } from '../../../../packages/mistri/src/server/workflows.ts';
import { loanApplied } from './events.mjs';

export const loan = defineWorkflow({
  version: 1,
  runAs: 'underwriter',
  start: { event: loanApplied, key: (event) => event.id },
  async run(w, start) {
    await w.sleep('cooling-off', '1 second');
    // Named the way a step made in a loop is (`approve[1]`): such a name once made a request id the command door refused.
    return w.run(['approve', 1], 'approveLoan', { target: start.id });
  },
});

export default defineJobs(
  {},
  {
    principals: { intake: { roles: ['intake'] }, underwriter: { roles: ['automation'] } },
    inbound: {
      apply: defineInbound({
        verify: hmac({
          secret: 'LOAN_FLOW_SECRET',
          signature: { header: 'x-signature', encoding: 'hex' },
          timestamp: { header: 'x-timestamp', window: '5 minutes' },
        }),
        runAs: 'intake',
        command: 'applyLoan',
        key: (body) => body.key,
        input: (body) => ({ ref: body.ref }),
      }),
    },
    workflows: defineWorkflows({ loan }),
    store: { namespace: 'loanflow' },
  },
);
