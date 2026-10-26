/*
 * The saved application's commands, and its `--commands` entry. Server-only.
 *
 * Each step's handler writes its own table: the first inserts the root with
 * the columns the platform hands it (`draft.start`), every later one replaces
 * this application's rows beneath it — the only rows the server lets it see —
 * and the submit re-reads the whole application, moves it out of its draft
 * state and returns a random receipt. None of them answers anything typed.
 */
import {
  defineCommand,
  defineCommands,
  defineSource,
  field,
  literal,
  publicReference,
  publicReferencePattern,
  refuse,
  shape,
  text,
} from '@mistriwork/mistri/commands';

const lending = defineSource('lending');
const saved = shape({ message: literal('Saved.') });
const ALL = ['application', 'applicant_address', 'income', 'co_applicant'] as const;

export const startApplication = defineCommand({
  source: lending,
  target: 'application',
  targets: 'none',
  public: true,
  read: ALL,
  write: ALL,
  output: saved,
  input: {
    first_name: field.text({ max: 60 }),
    last_name: field.text({ max: 60 }),
    email: field.email(),
  },
  async handle({ db, draft }, input) {
    if (!draft) return refuse('forbidden');
    // Change from the review: the same root, overwritten.
    if (draft.root) await db.application.update(await db.application.get(draft.root), input);
    else await db.application.insert({ ...input, ...draft.start });
    return { message: 'Saved.' as const };
  },
});

export const saveAddress = defineCommand({
  source: lending,
  target: 'application',
  targets: 'none',
  public: true,
  input: {
    line1: field.text({ label: 'Street address', max: 120 }),
    city: field.text({ max: 60 }),
    postal_code: field.text({ label: 'ZIP code', pattern: /\d{5}/, message: 'Five digits.' }),
  },
  read: ['application', 'applicant_address'],
  write: ['application', 'applicant_address'],
  output: saved,
  async handle({ db }, input) {
    for (const row of await db.applicant_address.where({})) await db.applicant_address.remove(row);
    await db.applicant_address.insert({ ...input });
    return { message: 'Saved.' as const };
  },
});

export const saveIncome = defineCommand({
  source: lending,
  target: 'application',
  targets: 'none',
  public: true,
  input: {
    employer: field.text({ max: 120 }),
    annual_income: field.money({ min: 1, max: 10000000 }),
  },
  read: ['application', 'income'],
  write: ['application', 'income'],
  output: saved,
  async handle({ db }, input) {
    for (const row of await db.income.where({})) await db.income.remove(row);
    await db.income.insert({ ...input });
    return { message: 'Saved.' as const };
  },
});

export const saveCoApplicants = defineCommand({
  source: lending,
  target: 'application',
  targets: 'none',
  public: true,
  input: {
    co_applicants: field.group(
      {
        co_name: field.text({ label: 'Full name', max: 120 }),
        co_email: field.email({ label: 'Email' }),
      },
      { label: 'Co-applicants', repeat: { max: 2 } },
    ),
  },
  read: ['application', 'co_applicant'],
  write: ['application', 'co_applicant'],
  output: saved,
  async handle({ db }, input) {
    for (const row of await db.co_applicant.where({})) await db.co_applicant.remove(row);
    // A co-applicant is addressed by its position in this application, never by a key.
    for (const [index, row] of input.co_applicants.entries()) {
      await db.co_applicant.insert({ position: index + 1, name: row.co_name, email: row.co_email });
    }
    return { message: 'Saved.' as const };
  },
});

export const submitApplication = defineCommand({
  source: lending,
  target: 'application',
  targets: 'none',
  public: true,
  read: ALL,
  write: ['application'],
  input: {
    consent: field.bool({ label: 'The details I gave are true' }),
  },
  output: shape({ reference: text({ pattern: publicReferencePattern('APP') }), message: literal('Application received.') }),
  async handle({ db, draft, now }, input) {
    if (!input.consent) refuse('invalid_input', 'consent');
    const root = await db.application.get(draft!.root!);
    // The whole application, again, in the submit's one transaction.
    if (!(await db.applicant_address.count({})) || !(await db.income.count({}))) refuse('ineligible_state');
    const reference = publicReference('APP');
    await db.application.update(root, { status: 'submitted', reference, submitted_at: now().toISOString() });
    return { reference, message: 'Application received.' as const };
  },
});

export default defineCommands({ startApplication, saveAddress, saveIncome, saveCoApplicants, submitApplication });
