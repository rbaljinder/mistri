// Explicit --jobs entry: what Lintel does by itself. Never import this module
// from the App graph.
//
// - The rent poster posts each month's rent at six on the first, Denver time,
//   and the late-fee workflow (late-fees.ts) it starts assesses fees after the
//   grace days.
// - The lease clock ends a lease whose notice has run out (resources.ts `at`).
// - The payment processor's signed callback, `POST /api/inbound/paymentSettled`,
//   settles the charge it names, once: its payment id is the receipt's key.
// - The routing decision asks, every fifteen minutes, which technician should take each new repair nobody has
//   picked up, and offers its answer to the office on the repair's Technician field.
//
// Lintel is a row-policy App, so each of these runs as a service the policy
// names (policy.ts `services`) and writes only in the rows it gives that
// service. Set PAYMENT_CALLBACK_SECRET; the seed provisions the stores.
import { defineDecision, defineDecisions, defineInbound, defineJob, defineJobs, hmac } from '@mistriwork/mistri/jobs';
import { defineWorkflows } from '@mistriwork/mistri/workflows';
import { lateFees } from './late-fees.ts';

/** What the processor's callback says, read strictly: an unreadable body is refused before anything runs. */
export function settlement(body: unknown): { id: string; charge: number; amount: number; method: 'ach' | 'card' } {
  const value = body as Record<string, unknown> | null;
  if (!value || typeof value !== 'object') throw new Error('The body is not an object.');
  const { id, charge, amount, method, status } = value;
  if (status !== 'succeeded') throw new Error('Only a succeeded payment settles a charge.');
  if (typeof id !== 'string' || !/^pay_[A-Za-z0-9]{6,58}$/.test(id)) throw new Error('A payment id such as pay_8Kd2xQ.');
  if (typeof charge !== 'number' || !Number.isSafeInteger(charge) || charge < 1) throw new Error('A charge id.');
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 1) throw new Error('An amount in cents.');
  if (method !== 'ach' && method !== 'card') throw new Error('A method: ach or card.');
  return { id, charge, amount, method };
}

export default defineJobs(
  {
    postRent: defineJob({ every: '0 6 1 * *', timezone: 'America/Denver', runAs: 'rent-poster', command: 'postRent' }),
  },
  {
    principals: {
      'rent-poster': { roles: ['rent_poster'] },
      'lease-clock': { roles: ['lease_clock'] },
      'payment-processor': { roles: ['processor'] },
      'repair-triage': { roles: ['repair_triage'] },
    },
    /* Which technician takes a repair is the office's call, so this only suggests: a chip on the field, a mark in an
       empty cell. A model's pick would apply by itself only once `mistri decide eval --pin` pinned the model, and
       that is a decision for the office to make, not the example. With no provider key in the server's environment
       it asks no one. */
    decisions: defineDecisions({
      routeRepair: defineDecision({
        question: 'Which technician should take this repair?',
        target: 'maintenance_request',
        inputs: ['title', 'description', 'category', 'unit_id.property_id.name'],
        answer: { command: 'assignTechnician', field: 'assigned_to' },
        every: '*/15 * * * *',
        timezone: 'America/Denver',
        where: 'status = new and assigned_to is empty',
        suggest: 0.6,
        runAs: 'repair-triage',
        provider: ['jev', 'anthropic'],
      }),
    }),
    workflows: defineWorkflows({ lateFees }),
    store: { namespace: 'lintel' },
    inbound: {
      paymentSettled: defineInbound({
        verify: hmac({
          secret: 'PAYMENT_CALLBACK_SECRET',
          signature: { header: 'x-processor-signature', encoding: 'hex' },
          timestamp: { header: 'x-processor-timestamp', window: '5 minutes' },
          signed: '{timestamp}.{body}',
        }),
        runAs: 'payment-processor',
        command: 'settleCharge',
        key: (body) => settlement(body).id,
        target: (body) => ({ id: settlement(body).charge }),
        input: (body) => {
          const paid = settlement(body);
          return { reference: paid.id, amount: paid.amount, method: paid.method };
        },
      }),
    },
  },
);
