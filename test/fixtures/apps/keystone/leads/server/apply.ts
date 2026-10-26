import {
  saveApplicantInput,
  saveCoApplicantInput,
  saveVehicleInput,
  startApplicationInput,
  submitApplicationInput,
} from '../features/apply-inputs.ts';
import { home as homeFields, person as personFields, work as workFields } from '../features/leads-inputs.ts';
// The public credit application's handlers: one per step, and the submit.
// Registered with `public: true`; the only writes anyone signed out may make.
//
// Where they land is not the applicant's decision. The link a dealer
// publishes carries its intake address (`/leads/form/apply?via=…`); the server
// resolves it on every step and tells each handler only `intake`: 'tenant' (a
// dealer's draft lead) or 'platform' (Keystone's triage). An unknown or
// rotated address, none at all, or a dealer on hold lands in triage, and every
// case is answered the same way, so the form cannot be used to learn which
// dealers exist.
//
// A dealer keeps the whole application: a lead, and its applicant rows. Triage
// keeps what `intake_submission` has columns for (names, contact, address,
// employer and income, what they are looking for): no date of birth, no SSN,
// no co-applicant, because Keystone's triage only follows the person up.
import type { CommandInputOf } from '@mistriwork/mistri/commands';
import { defineCommand, literal, publicReference, publicReferencePattern, refuse, shape, text } from '@mistriwork/mistri/commands';

import { cents, stamp } from './dealMath.ts';
import { keystone } from './source.ts';

const saved = shape({ message: literal('Saved.') });
/* The first step writes the draft where it lands, and names the rows beneath
   it: an expired draft is purged with them when a new one starts. */
const EVERY = ['lead', 'applicant', 'lead_activity', 'intake_submission'] as const;
const PLACES = ['lead', 'intake_submission'] as const;

type Person = CommandInputOf<typeof personFields>;
type Home = CommandInputOf<typeof homeFields>;
type Work = CommandInputOf<typeof workFields>;

/** An applicant row as the schema holds it, from what the form asked. */
const applicantRow = (
  role: 'primary' | 'co_applicant',
  who: Omit<Person, 'date_of_birth' | 'ssn_last4'>,
  you: Pick<Person, 'date_of_birth' | 'ssn_last4'>,
  home: Home,
  work: Work,
  at: string,
) => ({
  role,
  first_name: who.first_name,
  last_name: who.last_name,
  email: who.email,
  phone: who.phone,
  date_of_birth: you.date_of_birth,
  ssn_last4: you.ssn_last4,
  street: home.street,
  city: home.city,
  state: home.state,
  zip: home.zip,
  housing: home.housing,
  monthly_housing: cents(home.monthly_housing),
  years_at_address: home.years_at_address.toFixed(1),
  employment_type: work.employment_type,
  employer: work.employer ?? null,
  job_title: work.job_title ?? null,
  years_employed: work.years_employed.toFixed(1),
  monthly_income: cents(work.monthly_income),
  created_at: at,
});

export const startApplication = defineCommand({
  input: startApplicationInput,
  targets: 'none',
  source: keystone,
  target: 'lead',
  public: true,
  read: EVERY,
  write: EVERY,
  output: saved,
  async handle({ db, draft, intake, now }, input) {
    if (!draft) return refuse('forbidden');
    const values = { first_name: input.first_name, last_name: input.last_name, email: input.email, phone: input.phone };
    if (intake === 'tenant') {
      // Inside the dealer the address named; `dealer_id` is injected, never written here.
      if (draft.root) await db.lead.update(await db.lead.get(draft.root), values);
      else {
        await db.lead.insert({
          ...values,
          ...draft.start,
          source: 'website',
          reference: null,
          vehicle_id: null,
          salesperson_id: null,
          message: null,
          marketplace_account_id: null,
          created_at: stamp(now()),
          last_contact_at: null,
          next_follow_up_on: null,
          lost_reason: null,
          version: 0,
        });
      }
    } else if (draft.root) await db.intake_submission.update(await db.intake_submission.get(draft.root), values);
    else await db.intake_submission.insert({ ...values, ...draft.start, created_at: stamp(now()), version: 0 });
    return { message: 'Saved.' as const };
  },
});

export const saveApplicant = defineCommand({
  input: saveApplicantInput,
  targets: 'none',
  source: keystone,
  target: 'lead',
  public: true,
  read: EVERY,
  write: EVERY,
  output: saved,
  async handle({ db, draft, intake, now }, input) {
    if (intake === 'tenant') {
      const lead = await db.lead.get(draft!.root!);
      const row = applicantRow(
        'primary',
        { first_name: lead.first_name, last_name: lead.last_name, email: lead.email ?? '', phone: lead.phone ?? '' },
        input.you,
        input.home,
        input.work,
        stamp(now()),
      );
      const existing = await db.applicant.find({ role: 'primary' });
      if (existing) await db.applicant.update(existing, row);
      else await db.applicant.insert(row);
    } else {
      await db.intake_submission.update(await db.intake_submission.get(draft!.root!), {
        street: input.home.street,
        city: input.home.city,
        state: input.home.state,
        zip: input.home.zip,
        employer: input.work.employer ?? null,
        monthly_income: cents(input.work.monthly_income),
      });
    }
    return { message: 'Saved.' as const };
  },
});

export const saveVehicle = defineCommand({
  input: saveVehicleInput,
  targets: 'none',
  source: keystone,
  target: 'lead',
  public: true,
  read: [...PLACES, 'vehicle'],
  write: PLACES,
  output: saved,
  async handle({ db, draft, intake }, input) {
    if (intake === 'tenant') {
      // Matched inside this dealer only, and the answer is the same either
      // way: an unknown stock number is kept in the message for the dealer.
      const vehicle = input.stock_number ? await db.vehicle.find({ stock_number: input.stock_number }) : undefined;
      const forSale = vehicle && (vehicle.status === 'listed' || vehicle.status === 'in_stock');
      const note = [input.stock_number && !forSale ? `Stock ${input.stock_number}.` : '', input.message ?? ''].filter(Boolean).join(' ');
      await db.lead.update(await db.lead.get(draft!.root!), { vehicle_id: forSale ? vehicle.id : null, message: note || null });
    } else {
      const interest = [input.stock_number ? `Stock ${input.stock_number}.` : '', input.message ?? ''].filter(Boolean).join(' ');
      await db.intake_submission.update(await db.intake_submission.get(draft!.root!), { vehicle_interest: interest || null });
    }
    return { message: 'Saved.' as const };
  },
});

export const saveCoApplicant = defineCommand({
  input: saveCoApplicantInput,
  targets: 'none',
  source: keystone,
  target: 'lead',
  public: true,
  read: EVERY,
  write: EVERY,
  output: saved,
  async handle({ db, intake, now }, input) {
    if (intake !== 'tenant') return { message: 'Saved.' as const };
    // This draft's rows are the only ones the server lets a step see.
    for (const row of await db.applicant.where({ role: 'co_applicant' })) await db.applicant.remove(row);
    for (const co of input.co_applicant) {
      await db.applicant.insert(applicantRow('co_applicant', co, co, co, co, stamp(now())));
    }
    return { message: 'Saved.' as const };
  },
});

/** The receipt keeps the reference and the sentence, nothing else: the same prefix wherever it landed. */
export const applicationOutput = shape({
  reference: text({ pattern: publicReferencePattern('KS') }),
  message: literal('Application received.'),
});

export const submitApplication = defineCommand({
  input: submitApplicationInput,
  targets: 'none',
  source: keystone,
  target: 'lead',
  public: true,
  read: EVERY,
  write: [...PLACES, 'lead_activity'],
  output: applicationOutput,
  async handle({ db, draft, intake, now }, input) {
    if (!input.consent) refuse('invalid_input', 'consent');
    // Random, sixty bits: never a key or a counter, and neutral about where it landed.
    const reference = publicReference('KS');
    if (intake === 'tenant') {
      const lead = await db.lead.get(draft!.root!);
      if (!(await db.applicant.find({ role: 'primary' }))) refuse('ineligible_state');
      await db.lead.update(lead, { status: 'new', reference });
      await db.lead_activity.insert({
        lead_id: lead.id,
        kind: 'note',
        author_id: null,
        created_at: stamp(now()),
        body: "Applied online through the dealer's apply link.",
      });
    } else {
      await db.intake_submission.update(await db.intake_submission.get(draft!.root!), { status: 'open', reference });
    }
    return { reference, message: 'Application received.' as const };
  },
});

export const applyCommands = { startApplication, saveApplicant, saveVehicle, saveCoApplicant, submitApplication };
