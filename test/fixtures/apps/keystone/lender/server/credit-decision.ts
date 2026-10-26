// The credit decision, as a durable workflow. An underwriter asks for a
// check on an application; the workflow requests it from the provider, waits for
// the provider's signed callback (server/jobs.ts records it as `credit.reported`),
// approves a clear score by itself and otherwise refers the file and waits for
// the underwriters' answer, reminding them once it is late. Never import this
// module from the App graph: it is named, through jobs.ts, as the App's `jobs`.
import { StepRefused, defineWorkflow } from '@mistriwork/mistri/workflows';
import { applicationDecided, creditCheckRequested, creditReported } from './events.ts';

/** A score at or above this is approved without an underwriter. */
export const AUTO_APPROVE_SCORE = 720;

export const creditDecision = defineWorkflow({
  start: { event: creditCheckRequested, key: (event) => event.applicationId }, // one live decision per application
  listens: [creditReported, applicationDecided],
  runAs: 'underwriting-clock',
  async run(w, start) {
    const applicationId = start.applicationId;
    // The provider answers 202 with its own id for the check; the callback names it.
    const check = await w.call<{ id: string }>(
      'request-check',
      'credit-provider',
      { method: 'POST', path: '/checks', body: { applicationId } },
      { retry: { attempts: 4, backoff: '30 seconds', max: '10 minutes' } },
    );
    const result = await w.waitFor('credit-result', creditReported, { match: (event) => event.checkId === check.id, timeout: '2 days' });
    if (!result) return w.run('no-score', 'referToUnderwriter', { target: applicationId });
    if (result.score >= AUTO_APPROVE_SCORE) {
      try {
        return await w.run('auto-approve', 'approveApplication', { target: applicationId, input: { score: result.score } });
      }
      // The program cannot lend it as asked: an underwriter decides.
      catch (error) {
        if (!(error instanceof StepRefused)) throw error;
      }
    }
    await w.run('refer', 'referToUnderwriter', { target: applicationId });
    const answered = await w.waitFor('decision', applicationDecided, {
      match: (event) => event.applicationId === applicationId,
      timeout: '2 days',
    });
    if (answered) return;
    await w.run('remind', 'remindUnderwriter', { target: applicationId });
    await w.waitFor('decision-late', applicationDecided, { match: (event) => event.applicationId === applicationId, timeout: '1 day' });
  },
});
