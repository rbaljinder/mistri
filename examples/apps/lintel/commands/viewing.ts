/* A visitor asks to see a listed home. Public: it runs under a public
   principal and writes one requested viewing — the one place a visitor's name
   and contact details land. A public submission is unverified input from
   anyone, so it holds nothing scarce and its answer never depends on what the
   database holds: a code that names no listed home is kept as typed. */
import { defineCommand, field, literal, publicReference, publicReferencePattern, shape, text } from '@mistriwork/mistri/commands';
import { day, lintel, stamp } from '../source.ts';

export const requestViewing = defineCommand({
  source: lintel,
  target: 'viewing',
  public: true,
  read: ['unit'],
  input: {
    code: field.text({
      label: 'Home',
      max: 8,
      case: 'upper',
      pattern: /[A-Z]{2,3}-\d{1,3}/,
      message: 'A listing code such as AC-105.',
      help: 'On every listing, such as AC-105. From a home’s page it is filled in for you.',
    }),
    name: field.text({ label: 'Your name', max: 120 }),
    email: field.email({ help: 'Where the leasing office confirms the time.' }),
    phone: field.phone({ optional: true }),
    preferred_on: field.date({ label: 'Day you would like to visit' }),
    message: field.textarea({ label: 'Anything we should know?', max: 1000, optional: true }),
  },
  output: shape({ reference: text({ pattern: publicReferencePattern('VW') }), message: literal('Viewing requested.') }),
  async handle({ db, now }, input) {
    const reference = publicReference('VW');
    const home = await db.unit.find({ code: input.code, listed: true });
    // A day already gone is read as the first day the office can show it.
    const today = day(now);
    await db.viewing.insert({
      unit_id: home?.id ?? null,
      reference,
      name: input.name,
      email: input.email,
      phone: input.phone ?? null,
      preferred_on: input.preferred_on < today ? today : input.preferred_on,
      message: home ? (input.message ?? null) : `Asked about ${input.code}. ${input.message ?? ''}`.trim(),
      status: 'requested',
      received_at: stamp(now),
    });
    return { reference, message: 'Viewing requested.' as const };
  },
});
