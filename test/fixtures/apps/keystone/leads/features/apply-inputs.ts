// Server-only field shapes shared by the command handlers.
import { field } from '@mistriwork/mistri/commands';
import { home, person, work } from './leads-inputs.ts';

export const startApplicationInput = {
  first_name: person.first_name,
  last_name: person.last_name,
  email: field.email({ help: 'Where the dealer will write to you. This form sends nothing.' }),
  phone: field.phone(),
};

export const saveApplicantInput = {
  you: field.group({ date_of_birth: person.date_of_birth, ssn_last4: person.ssn_last4 }),
  home: field.group(home, { label: 'Where you live' }),
  work: field.group(work, { label: 'Work and income' }),
};

export const saveVehicleInput = {
  stock_number: field.text({
    max: 20,
    optional: true,
    case: 'upper',
    pattern: /[A-Z0-9-]{2,20}/,
    message: 'Letters, digits and hyphens, as the window sticker prints it.',
    help: 'On the window sticker or the listing. Leave empty if you have not picked one yet.',
  }),
  message: field.textarea({
    label: 'What you are looking for',
    max: 1000,
    optional: true,
    help: 'The car, your budget a month, a trade-in: anything the dealer should know.',
  }),
};

export const saveCoApplicantInput = {
  co_applicant: field.group(
    { ...person, ...home, ...work },
    {
      label: 'Co-applicant',
      repeat: { max: 1 },
      description: 'Someone applying with you. Leave empty if you are applying alone.',
    },
  ),
};

export const submitApplicationInput = {
  consent: field.bool({ label: 'What I have told you is true, and the dealer and Keystone may check it' }),
};
