import { sendToDealerInput } from '../features/rate-checks-inputs.ts';
// Keystone's marketing desk: a matched rate check with a car goes to that
// car's dealer as a new lead (SUITE.md, cross-App flow 3). The dealer is read
// from the car in the transaction, never chosen. `program` is read because an
// update must see every parent the rate check points at.
import { defineCommand, literal, refuse, shape } from '@mistriwork/mistri/commands';

import { carForSale, keystone, newMarketplaceLead } from './keystone.ts';

const money = (value: string | null) =>
  value === null ? 'no estimate' : Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export const sendToDealer = defineCommand({
  target: 'prequalification',
  input: sendToDealerInput,
  source: keystone,
  read: ['vehicle', 'dealer', 'program'],
  write: ['lead'],
  when: 'status = matched and vehicle_id is not empty',
  output: shape({ message: literal('Sent to the dealer.') }),
  async handle({ db, record, now }) {
    const car = await carForSale(db, record.vehicle_id);
    if (!car) refuse('The car on this rate check is no longer for sale at a Keystone dealer.');
    const lead = await newMarketplaceLead(db, car, now(), {
      first_name: record.first_name,
      last_name: record.last_name,
      email: record.email,
      phone: record.phone,
      message: `Checked their rate on the Keystone marketplace (${record.reference}): up to ${money(record.estimated_amount)} from ${record.estimated_apr === null ? '—' : Number(record.estimated_apr)}% APR.`,
      account: record.account_id,
    });
    await db.prequalification.update(record, { status: 'sent_to_dealer', lead_id: lead.id });
    return { message: 'Sent to the dealer.' as const };
  },
});
