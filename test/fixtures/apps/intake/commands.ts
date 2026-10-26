/*
 * The intake fixture's commands, and its `--commands` entry. Server-only.
 *
 * The public one files an application and answers a random reference; it reads
 * nothing and echoes nothing typed. Its Social Security number is the
 * handler's alone (`keep: 'handler'`): it stores the last four, and the node
 * suite (test/forms-sensitive.test.ts) greps every file and log for the whole.
 * A nickname of "trip" makes the handler throw with the whole number in its
 * words, which must reach no log. The signed-in one adds a bare row.
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

const members = defineSource('members');

const ACCOUNTS = [
  { value: 'checking', label: 'Checking' },
  { value: 'savings', label: 'Savings' },
  { value: 'both', label: 'Checking and savings' },
] as const;

/* Asked in icon cards, several at once, and not kept: what is under test is how they are asked and read back. */
const EXTRAS = [
  { value: 'card', label: 'A debit card', icon: 'credit-card' },
  { value: 'overdraft', label: 'Overdraft cover', icon: 'shield-check' },
  { value: 'paper', label: 'Paper statements', icon: 'envelope' },
] as const;

export const submitApplication = defineCommand({
  source: members,
  target: 'application',
  targets: 'none',
  public: true,
  read: [],
  write: ['application'],
  input: {
    email: field.email({ case: 'lower' }),
    confirm_email: field.email({ case: 'lower', label: 'Confirm email address' }),
    first_name: field.text({ max: 60 }),
    last_name: field.text({ max: 60 }),
    date_of_birth: field.date({ label: 'Date of birth' }),
    ssn: field.text({ label: 'Social Security number', mask: '000-00-0000', optional: true, sensitive: { keep: 'handler' } }),
    account_type: field.choice(ACCOUNTS, { label: 'Account' }),
    extras: field.choices(EXTRAS, { label: 'Anything to go with it?', as: 'cards', optional: true }),
    // A yes or a no as two buttons, unanswered until pressed: a question that waits on either answer stays hidden till then.
    joint: field.bool({ label: 'Is this a joint application?', as: 'buttons', optional: true }),
    nickname: field.text({ max: 40, optional: true, label: 'What should we call you?', when: 'joint = true' }),
    alone: field.text({ max: 60, optional: true, label: 'Who should we name as your contact?', when: 'joint = false' }),
    consent: field.bool({ label: 'I agree to the terms of this application', accept: true }),
  },
  rules: [{ must: 'confirm_email = email', message: 'The email addresses do not match.' }],
  output: shape({ reference: text({ pattern: publicReferencePattern('INT') }), message: literal('Your request is in.') }),
  async handle({ db, now }, input) {
    if (input.confirm_email !== input.email) refuse('invalid_input', 'confirm_email');
    if (input.nickname === 'trip') throw new Error(`could not verify ${input.ssn}`);
    const reference = publicReference('INT');
    await db.application.insert({
      reference,
      email: input.email,
      first_name: input.first_name,
      last_name: input.last_name,
      date_of_birth: input.date_of_birth,
      account_type: input.account_type,
      joint: input.joint ?? false,
      ssn_last4: input.ssn ? input.ssn.slice(-4) : null,
      received_at: now().toISOString(),
    });
    return { reference, message: 'Your request is in.' as const };
  },
});

export const addApplication = defineCommand({
  source: members,
  target: 'application',
  targets: 'none',
  read: [],
  write: ['application'],
  input: { first_name: field.text({ max: 60 }), last_name: field.text({ max: 60 }), email: field.email({ case: 'lower' }) },
  output: shape({ message: literal('Added.') }),
  async handle({ db, now }, input) {
    await db.application.insert({
      reference: publicReference('INT'),
      email: input.email,
      first_name: input.first_name,
      last_name: input.last_name,
      date_of_birth: '1990-01-01',
      account_type: 'checking',
      joint: false,
      received_at: now().toISOString(),
    });
    return { message: 'Added.' as const };
  },
});

export default defineCommands({ submitApplication, addApplication });
