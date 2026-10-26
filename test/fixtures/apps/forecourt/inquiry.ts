// The inquiry form's command: what a visitor is asked, and what the question
// does to the marketplace. Registered in commands.ts, beside the App, which
// names it and never imports it.
//
// A submission is unverified input from anyone, so it holds nothing scarce:
// it reserves no vehicle and marks nothing sold, and its answer never
// depends on what the database holds. The vehicle is looked up only to file
// the inquiry against it; a reference that names no vehicle is kept as typed
// for the dealer to read, and the visitor hears the same thing either way.
import { defineCommand, field, literal, publicReference, publicReferencePattern, shape, text } from '@mistriwork/mistri/commands';
import { market } from './market.ts';

/* What a visitor is asked. A public form reads no directory to fill a list,
   so the vehicle is named by the stock reference its page shows; its shape,
   and the email's, are checked in the browser before anything is sent, and
   again here by the same parser. The account inquiry asks the same fields. */
export const inquiryFields = {
  stock_ref: field.text({
    label: 'Stock number',
    max: 16,
    case: 'upper',
    pattern: /FC-\d{4}/,
    message: 'A stock number such as FC-1042.',
    help: 'The stock number on the car’s page, such as FC-1042. From a car’s page it is filled in for you.',
  }),
  name: field.text({ label: 'Your name', max: 120 }),
  email: field.email({ help: 'Where the dealer will reply. Nothing is sent by this form.' }),
  phone: field.phone({ optional: true }),
  message: field.textarea({
    label: 'Your question',
    max: 2000,
    help: 'A test drive, a trade-in or financing: say what you would like to know.',
  }),
};

/** The receipt keeps the reference and the sentence, nothing else. */
export const inquiryOutput = shape({ reference: text({ pattern: publicReferencePattern('INQ') }), message: literal('Inquiry received.') });

/**
 * Inquire about a vehicle. Public: it runs under a public principal and
 * writes one row, a `new` inquiry — the one place a visitor's name and
 * contact details land. It reads `vehicle` only to file the inquiry against
 * the vehicle whose stock reference was typed; its footprint says so.
 */
export const inquireAboutVehicle = defineCommand({
  // What was typed is the input's to judge: the stock number's shape,
  // upper-cased, and the email's. The handler starts from a valid input.
  source: market,
  target: 'inquiry',
  public: true,
  input: inquiryFields,
  read: ['vehicle'],
  output: inquiryOutput,
  async handle({ db, now }, input) {
    // Server-generated, random and neutral: the visitor quotes it, and it says
    // nothing about the vehicle or how many inquiries came before. Sixty
    // random bits; the unique index is the backstop for a collision.
    const reference = publicReference('INQ');
    const vehicle = await db.vehicle.find({ stock_ref: input.stock_ref });
    await db.inquiry.insert({
      ...input,
      reference,
      vehicle_id: vehicle?.id ?? null,
      phone: input.phone ?? null,
      received_at: now().toISOString().slice(0, 19).replace('T', ' '),
      status: 'new',
    });
    return { reference, message: 'Inquiry received.' };
  },
});
