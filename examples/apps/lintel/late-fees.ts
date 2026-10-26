// The late-fee sequence for one month's rent, as a durable workflow: started
// by the rent poster's `rent.posted`, it sleeps through the grace days and then
// assesses a fee on each rent still open. One instance a month, keyed by the
// period, however many times the rent is posted. Named through jobs.ts; never
// imported from the App graph.
import { defineWorkflow } from '@mistriwork/mistri/workflows';
import { rentPosted } from './events.ts';
import { GRACE_DAYS } from './commands/ledger.ts';

/** When a month's grace ends: six in the morning, Denver, the day after the last free day (13:00 UTC in winter). */
export const graceEnds = (dueOn: string) => new Date(Date.parse(`${dueOn}T13:00:00Z`) + (GRACE_DAYS + 1) * 86_400_000);

export const lateFees = defineWorkflow({
  start: { event: rentPosted, key: (event) => event.period },
  runAs: 'rent-poster',
  async run(w, start) {
    await w.until('grace', graceEnds(start.dueOn));
    await w.run('assess', 'assessLateFees', { input: { period: start.period } });
  },
});
