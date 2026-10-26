// How a buyer asks about a car: the public form anyone may send, and the
// signed-in buyer's own inquiry, which stays theirs to follow.
//
// A public submission is unverified input from anyone, so it holds nothing
// scarce: it reserves no car and moves no stage but the first, and its answer
// never depends on what the database holds. The car is looked up only to file
// the inquiry against it; a stock number that names no car is kept as typed.
import { defineCommand, field, literal, publicReference, publicReferencePattern, shape, text } from '@mistriwork/mistri/commands';
import { market, stamp } from './source.ts';

/** What the question is about: the desk's board tags each card with it. */
export const TOPICS = [
  { value: 'availability', label: 'Is it still available?' },
  { value: 'test_drive', label: 'Book a test drive' },
  { value: 'trade_in', label: 'Value my trade-in' },
  { value: 'financing', label: 'Financing' },
  { value: 'price', label: 'Make an offer' },
] as const;

const contact = {
  name: field.text({ label: 'Your name', max: 120 }),
  email: field.email({ help: 'Where the dealer replies. This demonstration sends nothing.' }),
  phone: field.phone({ optional: true }),
  topic: field.choice(TOPICS, { label: 'What would you like to know?' }),
  message: field.textarea({ label: 'Your message', max: 2000 }),
};

/**
 * Ask about a car, signed out. Public: it runs under a public principal and
 * writes one `new` inquiry and its first message — the one place a visitor's
 * name and contact details land.
 */
export const inquireAboutVehicle = defineCommand({
  source: market,
  target: 'inquiry',
  public: true,
  input: {
    stock_ref: field.text({
      label: 'Stock number',
      max: 16,
      case: 'upper',
      pattern: /FC-\d{4}/,
      message: 'A stock number such as FC-1042.',
      help: 'On every car’s page, such as FC-1042. From a car’s page it is filled in for you.',
    }),
    ...contact,
  },
  read: ['vehicle'],
  write: ['inquiry_message'],
  output: shape({ reference: text({ pattern: publicReferencePattern('INQ') }), message: literal('Inquiry received.') }),
  async handle({ db, now }, input) {
    // Random and neutral: it says nothing about the car or how many came before.
    const reference = publicReference('INQ');
    const vehicle = await db.vehicle.find({ stock_ref: input.stock_ref });
    const at = stamp(now);
    const inquiry = await db.inquiry.insert({
      ...input,
      reference,
      vehicle_id: vehicle?.id ?? null,
      phone: input.phone ?? null,
      received_at: at,
      status: 'new',
      stage: 'new',
      channel: 'web',
      deal_value: vehicle ? Number(vehicle.price) : null,
    });
    await db.inquiry_message.insert({ inquiry_id: inquiry.id, kind: 'buyer', author: input.name, body: input.message, sent_at: at });
    return { reference, message: 'Inquiry received.' as const };
  },
});

/**
 * A signed-in buyer's inquiry about the car they are looking at: no stock
 * number to copy, and it is theirs — listed under My inquiries with every
 * reply the desk sends. A form submission is never attached to an account
 * after the fact, whatever email it gave.
 */
export const sendVehicleInquiry = defineCommand({
  source: market,
  target: 'vehicle',
  write: ['inquiry', 'inquiry_message'],
  input: contact,
  when: 'status != sold',
  output: shape({ reference: text({ pattern: publicReferencePattern('INQ') }), inquiryId: text({ max: 64, pattern: /^\d+$/ }) }),
  async handle({ db, record, actor, now }, input) {
    const reference = publicReference('INQ');
    const at = stamp(now);
    const inquiry = await db.inquiry.insert({
      ...input,
      reference,
      account_id: actor.id,
      stock_ref: record.stock_ref,
      vehicle_id: record.id,
      phone: input.phone ?? null,
      received_at: at,
      status: 'new',
      stage: 'new',
      channel: 'account',
      deal_value: Number(record.price),
    });
    await db.inquiry_message.insert({
      inquiry_id: inquiry.id,
      kind: 'buyer',
      author: input.name,
      body: input.message,
      sent_at: at,
      account_id: actor.id,
    });
    return { reference, inquiryId: String(inquiry.id) };
  },
});
