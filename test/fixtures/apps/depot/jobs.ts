// Explicit --jobs entry: the runner of the purchase orders' flows. Never import this module from the App graph.
//
// A flow here is rows, not code: Purchasing writes them under Flows (po_flow and
// po_flow_step, resources.ts), and this runner runs them on each purchase order
// they match — as the `automation` principal, through the App's own commands. The
// seed provisions its job store; serve with `--jobs test/fixtures/apps/depot/jobs.ts`.
import { defineJobs } from '@mistriwork/mistri/jobs';
import { defineWorkflows, flowRunner } from '@mistriwork/mistri/workflows';
import { poDecided } from './commands.ts';

export default defineJobs(
  {},
  {
    principals: { automation: { roles: ['automation'] } },
    // po.decided: what an approval step waits for, about its order.
    workflows: defineWorkflows({ purchaseFlows: flowRunner('purchase_order', { runAs: 'automation', listens: [poDecided] }) }),
    store: { namespace: 'depot' },
  },
);
