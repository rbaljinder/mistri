// Server-only field shapes shared by the command handlers.
import { field } from '@mistriwork/mistri/commands';
import { DEALER } from './dealer.ts';
export const stock = (optional: boolean, empty = 'Leave it empty for a general question.') =>
  field.text({
    max: 8,
    case: 'upper',
    pattern: DEALER.stock,
    optional,
    message: `A stock number such as ${DEALER.stockExample}.`,
    help: `From a car’s page it is filled in for you.${optional ? ` ${empty}` : ''}`,
  });
export const contact = {
  first_name: field.text({ max: 60 }),
  last_name: field.text({ max: 60 }),
  email: field.email({ help: 'Where we will reply.' }),
  phone: field.phone({ optional: true, help: 'If you would rather we call.' }),
};
export const askAboutVehicleInput = {
  stock_number: stock(true),
  ...contact,
  message: field.textarea({
    label: 'Your question',
    max: 2000,
    help: 'Availability, a trade-in, the history, the out-the-door price: ask anything.',
  }),
};

export const requestTestDriveInput = {
  stock_number: stock(false),
  preferred_on: field.date({ label: 'Preferred day', help: 'We confirm the time by phone or email before you come in.' }),
  time_of_day: field.choice(['morning', 'afternoon', 'evening'], {
    each: (part) => ({ morning: 'Morning, 9 am to noon', afternoon: 'Afternoon, noon to 5 pm', evening: 'Evening, after 5 pm' })[part],
  }),
  ...contact,
  phone: field.phone({ help: 'So we can confirm, or tell you if the car sells first.' }),
  message: field.textarea({
    label: 'Anything we should know',
    max: 1000,
    optional: true,
    help: 'A trade-in to appraise, a car seat to try, a second driver coming along.',
  }),
};

export const applyForFinancingInput = {
  // The car
  stock_number: stock(true, 'Leave it empty to learn your budget before you choose.'),
  down_payment: field.money({
    min: 0,
    max: 200000,
    optional: true,
    help: 'Cash or trade-in equity you plan to put down. Leave it empty if you are not sure yet.',
  }),
  // About you
  first_name: field.text({ max: 60 }),
  last_name: field.text({ max: 60 }),
  email: field.email({ help: 'Where the finance manager will write.' }),
  phone: field.phone(),
  date_of_birth: field.date(),
  ssn_last4: field.text({
    label: 'Last four of your SSN',
    pattern: /\d{4}/,
    message: 'Four digits.',
    help: 'Only the last four, to match your credit file. This demonstration asks no bureau.',
  }),
  // Where you live
  street: field.text({ label: 'Street address', max: 120 }),
  city: field.text({ max: 60 }),
  state: field.text({ max: 2, case: 'upper', pattern: /[A-Z]{2}/, message: 'Two letters, such as PA.' }),
  zip: field.text({ label: 'ZIP code', pattern: /\d{5}/, message: 'Five digits.' }),
  housing: field.choice(['own', 'rent', 'family', 'other'], {
    each: (kind) => ({ own: 'I own my home', rent: 'I rent', family: 'I live with family', other: 'Something else' })[kind],
  }),
  monthly_housing: field.money({ label: 'Monthly rent or mortgage', min: 0, max: 50000 }),
  years_at_address: field.number({ label: 'Years at this address', min: 0, max: 80 }),
  // Work and income
  employment_type: field.choice(['full_time', 'part_time', 'self_employed', 'retired', 'other'], {
    label: 'Employment',
    each: (kind) =>
      ({ full_time: 'Full time', part_time: 'Part time', self_employed: 'Self-employed', retired: 'Retired', other: 'Other' })[kind],
  }),
  employer: field.text({ max: 120, optional: true }),
  job_title: field.text({ max: 80, optional: true }),
  years_employed: field.number({ label: 'Years there', min: 0, max: 60 }),
  monthly_income: field.money({ label: 'Monthly income before tax', min: 0, max: 1000000 }),
  consent: field.bool({
    label: `The details I gave are true, and ${DEALER.name} may send them to Keystone Auto Finance for a credit decision`,
  }),
};
