// The public financing form's handlers: one per step, and the submit.
// Registered with `public: true` in commands.ts, never
// imported from the App graph.
//
// These are the only writes anybody who is not signed in may make, and where
// they land is **not** their decision. The visitor carries an intake address on
// the link the dealership published (`/ignition/form/finance?via=…`); the
// server resolves it against the dealers' profile rows on every step, and tells
// each handler only `context.intake`: `'tenant'` or `'platform'`.
//
// Why it is built that way, and not around a typed dealer code: a typed code is
// guessable, so trusting one would let anyone place a row in any dealership, and
// refusing an unknown one would tell them which dealerships exist. So the form
// asks for no code at all. A submission whose address is missing, unknown,
// rotated, shared or belongs to a suspended dealer lands with the lender for
// triage, and every case is answered identically — the same status, the same
// body shape, the same headers. Shape refusals are the only refusals.
//
// The form is saved on every step (each step runs a command). The first step inserts
// the draft — a `lead` in the dealership, or an `intake_submission` in triage —
// with the columns the server hands it (`draft.start`); every later step gets
// the draft's key from the server (`draft.root`) and writes only that draft and
// the rows beneath it, which is all the server lets it see. The applicant's
// place is a cookie whose hash the draft keeps, bound to the place it was
// issued in: a step that arrives under another dealership's link, or none,
// finds no draft there and is told the application can no longer be continued.
//
// It holds nothing scarce either: a lead reserves no vehicle, so two applicants
// may name the same stock number and neither is refused because of the other.
import { defineCommand, field, literal, publicReference, publicReferencePattern, refuse, shape, text } from '@mistriwork/mistri/commands';
import { lending } from './lending.ts';

const isoDate = (day: Date) => day.toISOString().slice(0, 10);
// Syntax only, after upper-casing: a public form must not query the inventory
// to disclose whether a stock number exists. Its intake address chooses a dealer.
const CODE = /[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?/;
// An amount as the numeric(12, 2) column takes it: exact decimal text, never a float.
const cents = (amount: number) => amount.toFixed(2);
const saved = shape({ message: literal('Saved.') });

/* Every step writes the draft in both places it may be — each lands in one,
   and a row in the other is `forbidden` and nothing stays — and the first
   step writes the rows beneath it too, since an expired draft is purged with
   them when a new one starts. */
const PLACES = ['lead', 'intake_submission'] as const;
const EVERY = ['lead', 'lead_co_applicant', 'intake_submission', 'intake_co_applicant'] as const;

export const startFinancing = defineCommand({
  source: lending,
  target: 'lead',
  targets: 'none',
  public: true,
  read: EVERY,
  write: EVERY,
  output: saved,
  input: {
    applicant_name: field.text({ label: 'Full name', max: 120 }),
    applicant_email: field.email({ label: 'Email', help: 'Where the dealership will write. Nothing is sent by this form.' }),
    applicant_phone: field.phone({ label: 'Phone', optional: true }),
  },
  async handle({ db, draft, intake }, input) {
    if (!draft) return refuse('forbidden');
    const values = {
      applicant_name: input.applicant_name,
      applicant_email: input.applicant_email,
      applicant_phone: input.applicant_phone ?? null,
    };
    // Change from the review: the same draft, overwritten.
    if (intake === 'tenant') {
      // Inside the dealership the address named. Ownership is injected by the
      // runtime; this handler never writes `tenant_id`, and a supplied one
      // would be refused.
      if (draft.root) await db.lead.update(await db.lead.get(draft.root), values);
      else
        await db.lead.insert({ ...values, ...draft.start, qualified_by: null, qualified_on: null, disqualified_reason: null, version: 0 });
    } else if (draft.root) await db.intake_submission.update(await db.intake_submission.get(draft.root), values);
    // With the lender, for triage. `dealer_hint` is only ever what the
    // applicant typed, and nothing resolves it; this form asks for none.
    else await db.intake_submission.insert({ ...values, ...draft.start, dealer_hint: null, outcome_note: null, version: 0 });
    return { message: 'Saved.' as const };
  },
});

export const saveFinancingAddress = defineCommand({
  source: lending,
  target: 'lead',
  targets: 'none',
  public: true,
  read: PLACES,
  write: PLACES,
  output: saved,
  input: {
    address_line: field.text({ label: 'Street address', max: 120 }),
    city: field.text({ max: 60 }),
    state: field.text({ max: 2, case: 'upper', pattern: /[A-Z]{2}/, message: 'Two letters, such as NY.' }),
    postal_code: field.text({ label: 'ZIP code', pattern: /\d{5}/, message: 'Five digits.' }),
  },
  async handle({ db, draft, intake }, input) {
    const values = { address_line: input.address_line, city: input.city, state: input.state, postal_code: input.postal_code };
    if (intake === 'tenant') await db.lead.update(await db.lead.get(draft!.root!), values);
    else await db.intake_submission.update(await db.intake_submission.get(draft!.root!), values);
    return { message: 'Saved.' as const };
  },
});

export const saveFinancingIncome = defineCommand({
  source: lending,
  target: 'lead',
  targets: 'none',
  public: true,
  read: PLACES,
  write: PLACES,
  output: saved,
  input: {
    employer: field.text({ max: 120 }),
    annual_income: field.money({ min: 1, max: 10000000 }),
  },
  async handle({ db, draft, intake }, input) {
    const values = { employer: input.employer, annual_income: cents(input.annual_income) };
    if (intake === 'tenant') await db.lead.update(await db.lead.get(draft!.root!), values);
    else await db.intake_submission.update(await db.intake_submission.get(draft!.root!), values);
    return { message: 'Saved.' as const };
  },
});

export const saveFinancingLoan = defineCommand({
  source: lending,
  target: 'lead',
  targets: 'none',
  public: true,
  read: PLACES,
  write: PLACES,
  output: saved,
  input: {
    vehicle_stock: field.text({
      label: 'Vehicle stock number',
      max: 40,
      case: 'upper',
      pattern: CODE,
      message: 'Letters, digits and hyphens, as the quotation prints it.',
      help: 'The stock number on the quotation, such as DEMO-STOCK-1001.',
    }),
    requested_amount: field.money({ label: 'Amount to finance', min: 1, max: 10000000 }),
    down_payment: field.money({ max: 10000000, below: 'requested_amount' }),
    term_months: field.choice([36, 48, 60], { label: 'Term', each: (months) => `${months} months` }),
  },
  async handle({ db, draft, intake }, input) {
    const values = {
      vehicle_stock: input.vehicle_stock,
      requested_amount: cents(input.requested_amount),
      down_payment: cents(input.down_payment),
      term_months: input.term_months,
    };
    if (intake === 'tenant') await db.lead.update(await db.lead.get(draft!.root!), values);
    else await db.intake_submission.update(await db.intake_submission.get(draft!.root!), values);
    return { message: 'Saved.' as const };
  },
});

export const saveFinancingCoApplicants = defineCommand({
  source: lending,
  target: 'lead',
  targets: 'none',
  public: true,
  read: EVERY,
  write: EVERY,
  output: saved,
  input: {
    co_applicants: field.group(
      {
        co_name: field.text({ label: 'Full name', max: 120 }),
        co_email: field.email({ label: 'Email' }),
      },
      { label: 'Co-applicants', repeat: { max: 2 }, description: 'Anyone applying with you. Leave empty if nobody is.' },
    ),
  },
  async handle({ db, intake }, input) {
    /* This draft's co-applicants are the only ones the server lets the step
       see, so replacing "all of them" replaces this application's. Each is
       addressed by its place in the application, never by a key. */
    const rows = input.co_applicants.map((row, index) => ({ position: index + 1, name: row.co_name, email: row.co_email }));
    if (intake === 'tenant') {
      for (const row of await db.lead_co_applicant.where({})) await db.lead_co_applicant.remove(row);
      for (const row of rows) await db.lead_co_applicant.insert(row);
    } else {
      for (const row of await db.intake_co_applicant.where({})) await db.intake_co_applicant.remove(row);
      for (const row of rows) await db.intake_co_applicant.insert(row);
    }
    return { message: 'Saved.' as const };
  },
});

/** The receipt keeps the reference and the sentence, nothing else. */
export const financingOutput = shape({
  reference: text({ pattern: publicReferencePattern('IGN') }),
  message: literal('Application received.'),
});

export const applyForFinancing = defineCommand({
  source: lending,
  target: 'lead',
  targets: 'none',
  public: true,
  read: EVERY,
  write: PLACES,
  input: { consent: field.bool({ label: 'The details I gave are true', accept: true }) },
  output: financingOutput,
  async handle({ db, draft, intake, now }) {
    // Server-generated, never derived from the input, and neutral about where
    // it landed: the applicant quotes it either way. Random — sixty bits,
    // never a key or a counter — so it says nothing about how many came
    // before and cannot be guessed from a neighbour's. The unique indexes on
    // both places it may land are the backstop.
    const reference = publicReference('IGN');
    const submitted = { reference, submitted_on: isoDate(now()) };
    // The whole application, again, in the submit's one transaction: the loan
    // step is what the gate reads, and the schema refuses a lead without it.
    if (intake === 'tenant') {
      const lead = await db.lead.get(draft!.root!);
      if (lead.vehicle_stock === null || lead.requested_amount === null || lead.term_months === null) refuse('ineligible_state');
      await db.lead.update(lead, { ...submitted, status: 'new' });
    } else {
      const submission = await db.intake_submission.get(draft!.root!);
      if (submission.requested_amount === null || submission.term_months === null) refuse('ineligible_state');
      await db.intake_submission.update(submission, { ...submitted, status: 'triage' });
    }
    return { reference, message: 'Application received.' as const };
  },
});

/** The form's commands, for commands.ts. */
export const financingCommands = {
  startFinancing,
  saveFinancingAddress,
  saveFinancingIncome,
  saveFinancingLoan,
  saveFinancingCoApplicants,
  applyForFinancing,
};
