// Private account inquiry. Anonymous form submissions remain unowned forever;
// matching a contact email never attaches an inquiry to an account.
import { randomUUID } from 'node:crypto';
import { defineCommand, shape, text } from '@mistriwork/mistri/commands';
import { inquiryFields } from './inquiry.ts';
import { market } from './market.ts';

/** The vehicle is the command's target, so a signed-in inquiry does not ask
 * the shopper to repeat its stock number or supply an account identifier. */
export const sendVehicleInquiry = defineCommand({
  source: market,
  target: 'vehicle',
  write: ['inquiry'],
  input: { name: inquiryFields.name, email: inquiryFields.email, phone: inquiryFields.phone, message: inquiryFields.message },
  output: shape({ reference: text({ max: 64 }), inquiryId: text({ max: 64, pattern: /^\d+$/ }) }),
  async handle({ db, record, actor, now }, input) {
    const reference = `INQ-${randomUUID()}`;
    const inquiry = await db.inquiry.insert({
      ...input,
      reference,
      account_id: actor.id,
      stock_ref: record.stock_ref,
      vehicle_id: record.id,
      phone: input.phone ?? null,
      received_at: now().toISOString().slice(0, 19).replace('T', ' '),
      status: 'new',
    });
    return { reference, inquiryId: String(inquiry.id) };
  },
});
