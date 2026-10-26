// Explicit --jobs entry, optional: the credit provider's signed callback and the
// credit decision it completes. Never import this module from the App graph.
//
// The provider calls `POST /api/inbound/creditResult` when a check completes.
// The platform verifies the exact bytes and the time under the secret named
// here, then runs `recordCreditResult` as the service principal
// `credit-provider`, which holds the `integration` role and nothing else. The
// provider's own id for the check is the receipt's key, so its retry replays
// the receipt and writes nothing twice. The command records `credit.reported`,
// which wakes the `creditDecision` workflow (credit-decision.ts) waiting on it;
// that workflow asks for the check through the `credit-provider` webhook
// connection of the config file. Set CREDIT_CALLBACK_SECRET (in a suite,
// through the App's `environment`) and name this file as the App's `jobs`.
import { defineInbound, defineJobs, hmac } from '@mistriwork/mistri/jobs';
import { defineWorkflows } from '@mistriwork/mistri/workflows';
import { creditDecision } from './credit-decision.ts';

export default defineJobs(
  {},
  {
    principals: {
      'credit-provider': { roles: ['integration'] },
      'underwriting-clock': { roles: ['automation'] },
    },
    workflows: defineWorkflows({ creditDecision }),
    inbound: {
      creditResult: defineInbound({
        verify: hmac({
          secret: 'CREDIT_CALLBACK_SECRET',
          signature: { header: 'x-credit-signature', encoding: 'hex' },
          timestamp: { header: 'x-credit-timestamp', window: '5 minutes' },
          signed: '{timestamp}.{body}',
        }),
        runAs: 'credit-provider',
        command: 'recordCreditResult',
        key: (body) => body.id,
        input: (body) => {
          // A pending or failed check is not a result; the command bounds the score itself.
          if (body.status !== 'complete') throw new Error('The check is not complete.');
          return { application_id: body.applicationId, check_id: body.id, score: body.score };
        },
      }),
    },
  },
);
