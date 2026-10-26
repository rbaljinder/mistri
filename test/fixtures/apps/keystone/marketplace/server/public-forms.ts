import { inquireInput, prequalifyInput } from '../inputs.ts';
// The two public forms' handlers. Each runs under a public principal, writes
// a request someone signed in then acts on, holds nothing scarce, and answers
// the same whatever the database holds: a listing code that names no car for
// sale is not an error the visitor can probe for.
import { defineCommand, literal, publicReference, publicReferencePattern, shape, text } from '@mistriwork/mistri/commands';

import { estimate } from './estimate.ts';
import { carForSale, keystone, newMarketplaceLead, stamp } from './keystone.ts';

export const prequalify = defineCommand({
  input: prequalifyInput,
  source: keystone,
  target: 'prequalification',
  public: true,
  read: ['vehicle', 'dealer', 'program'],
  output: shape({ reference: text({ pattern: publicReferencePattern('PQ') }), message: literal('Rate check received.') }),
  async handle({ db, now }, input) {
    // Random, never a counter: the visitor quotes it, and it says nothing about how many came before.
    const reference = publicReference('PQ');
    const car = await carForSale(db, input.vehicle);
    const programs = await db.program.where({ advertised: true, active: true }).limit(50);
    const result = estimate(programs, input, car, now().getUTCFullYear());
    await db.prequalification.insert({
      reference,
      first_name: input.first_name,
      last_name: input.last_name,
      email: input.email,
      phone: input.phone ?? null,
      zip: input.zip,
      credit_band: input.credit_band,
      monthly_income: String(input.monthly_income),
      desired_payment: String(input.desired_payment),
      vehicle_id: car?.id ?? null,
      ...(result.status === 'matched'
        ? { program_id: result.program.id, estimated_amount: String(result.amount), estimated_apr: String(result.apr) }
        : {}),
      status: result.status,
      created_at: stamp(now()),
    });
    return { reference, message: 'Rate check received.' as const };
  },
});

export const inquire = defineCommand({
  input: inquireInput,
  source: keystone,
  target: 'lead',
  public: true,
  read: ['vehicle', 'dealer'],
  write: ['lead_activity'],
  // A public form's receipt must carry a reference (the form's reply refuses
  // one without, whatever `check` accepts). It is random, and the lead's
  // timeline keeps it, so what the buyer quotes finds the dealer's lead.
  output: shape({ reference: text({ pattern: publicReferencePattern('KM') }), message: literal('Sent to the dealer.') }),
  async handle({ db, now }, input) {
    const reference = publicReference('KM');
    const car = await carForSale(db, input.vehicle);
    // No car for sale by that code: nothing to place with a dealer, and the same answer.
    if (car) await newMarketplaceLead(db, car, now(), input, `Inquiry from the Keystone marketplace, receipt ${reference}.`);
    return { reference, message: 'Sent to the dealer.' as const };
  },
});
