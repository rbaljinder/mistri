import { sendInquiryInput } from '../features/inquiries-inputs.ts';
import { checkRateInput } from '../features/rate-checks-inputs.ts';
import { removeSavedVehicleInput, saveVehicleInput } from '../features/shortlist-inputs.ts';
// A signed-in customer's own commands. policy.ts scopes the rows they read to
// the verified account; these handlers take the account from `actor`, never
// from input, and act only on a car the target names.
import { defineCommand, literal, publicReference, publicReferencePattern, refuse, shape, text } from '@mistriwork/mistri/commands';

import { estimate } from './estimate.ts';
import { carForSale, keystone, newMarketplaceLead, stamp } from './keystone.ts';

export const saveVehicle = defineCommand({
  target: 'vehicle',
  input: saveVehicleInput,
  source: keystone,
  write: ['saved_vehicle'],
  output: shape({ message: literal('Saved to your shortlist.') }),
  async handle({ db, record, actor, now }) {
    const saved = await db.saved_vehicle.find({ account_id: actor.id, vehicle_id: record.id });
    if (saved?.status === 'saved') return { message: 'Saved to your shortlist.' as const };
    if (saved) await db.saved_vehicle.update(saved, { status: 'saved', saved_at: stamp(now()) });
    else await db.saved_vehicle.insert({ account_id: actor.id, vehicle_id: record.id, status: 'saved', saved_at: stamp(now()) });
    return { message: 'Saved to your shortlist.' as const };
  },
});

export const removeSavedVehicle = defineCommand({
  // vehicle: an update must see every parent its row points at, so the car is in the footprint.
  target: 'saved_vehicle',
  input: removeSavedVehicleInput,
  source: keystone,
  read: ['vehicle'],
  when: 'status = saved',
  output: shape({ message: literal('Removed from your shortlist.') }),
  async handle({ db, record }) {
    await db.saved_vehicle.update(record, { status: 'archived' });
    return { message: 'Removed from your shortlist.' as const };
  },
});

export const sendInquiry = defineCommand({
  target: 'vehicle',
  input: sendInquiryInput,
  source: keystone,
  read: ['dealer'],
  write: ['lead'],
  when: 'status in (listed, pending)',
  output: shape({ reference: text({ max: 16 }), leadId: text({ max: 120 }) }),
  async handle({ db, record, actor, now }, input) {
    const car = await carForSale(db, record.id);
    if (!car) refuse('This dealer is not taking inquiries through Keystone right now.');
    const lead = await newMarketplaceLead(db, car, now(), { ...input, account: actor.id });
    return { reference: lead.reference ?? '', leadId: lead.id };
  },
});

export const checkRate = defineCommand({
  target: 'vehicle',
  input: checkRateInput,
  source: keystone,
  read: ['dealer', 'program'],
  write: ['prequalification'],
  when: 'status in (listed, pending)',
  output: shape({ reference: text({ pattern: publicReferencePattern('PQ') }), prequalificationId: text({ max: 20, pattern: /^\d+$/ }) }),
  async handle({ db, record, actor, now }, input) {
    const car = await carForSale(db, record.id);
    const programs = await db.program.where({ advertised: true, active: true }).limit(50);
    const result = estimate(programs, input, car, now().getUTCFullYear());
    const reference = publicReference('PQ');
    const row = await db.prequalification.insert({
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
      account_id: actor.id,
      ...(result.status === 'matched'
        ? { program_id: result.program.id, estimated_amount: String(result.amount), estimated_apr: String(result.apr) }
        : {}),
      status: result.status,
      created_at: stamp(now()),
    });
    return { reference, prequalificationId: String(row.id) };
  },
});
