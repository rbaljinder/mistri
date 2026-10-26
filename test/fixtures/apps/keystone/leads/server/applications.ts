import { markStipulationReceivedInput, withdrawApplicationInput } from '../features/applications-inputs.ts';
// What the dealer does with Keystone's answer: collect the stipulations it
// asked for, or withdraw the application. Tenant-realm commands.
import { defineCommand, literal, shape, text } from '@mistriwork/mistri/commands';

import { stamp } from './dealMath.ts';
import { whoIs } from './leads.ts';
import { keystone } from './source.ts';

const key = text({ max: 200 });
const received = shape({ stipulationId: key, message: literal('Marked received.') });
const withdrawn = shape({ applicationId: key, message: literal('Application withdrawn.') });

export const applicationCommands = {
  /* The dealer has what Keystone asked for; Keystone clears it in the lender App. */
  markStipulationReceived: defineCommand({
    target: 'stipulation',
    input: markStipulationReceivedInput,
    source: keystone,
    read: ['loan_application', 'deal', 'applicant', 'vehicle', 'program'],
    when: 'status = requested',
    output: received,
    async handle({ db, record: stipulation, now }, input) {
      await db.stipulation.update(stipulation, { status: 'received', received_at: stamp(now()), note: input.note ?? stipulation.note });
      return { stipulationId: stipulation.id, message: 'Marked received.' as const };
    },
  }),

  /* The dealer's last word on an application still open with Keystone. The
     revision guard makes the race with Keystone's decision (in the lender
     App, on the same `version`) an honest one: whichever commits first, the
     other is refused as stale. The deal comes off the desk, and the lead goes
     back to desking so it can be structured again. */
  withdrawApplication: defineCommand({
    target: 'loan_application',
    input: withdrawApplicationInput,
    source: keystone,
    read: ['deal', 'applicant', 'vehicle', 'program', 'lead', 'dealer_user'],
    write: ['deal', 'lead', 'lead_activity'],
    when: 'status in (submitted, in_review, conditioned, approved, countered)',
    output: withdrawn,
    async handle({ db, record: application, actor, now }, input) {
      await db.loan_application.update(application, { status: 'withdrawn', withdrawn_reason: input.reason });
      const deal = await db.deal.get(application.deal_id);
      if (deal.status !== 'cancelled') await db.deal.update(deal, { status: 'cancelled', updated_at: stamp(now()) });
      const lead = await db.lead.get(deal.lead_id);
      if (lead.status === 'submitted') await db.lead.update(lead, { status: 'desking' });
      const me = await whoIs(db.dealer_user, actor);
      await db.lead_activity.insert({
        lead_id: lead.id,
        kind: 'status',
        author_id: me?.id ?? null,
        created_at: stamp(now()),
        body: `Withdrew ${application.reference}: ${input.reason}`,
      });
      return { applicationId: application.id, message: 'Application withdrawn.' as const };
    },
  }),
};
