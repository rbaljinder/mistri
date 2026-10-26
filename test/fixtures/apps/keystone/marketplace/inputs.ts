// Server-only field shapes shared by the command handlers.
import { field } from '@mistriwork/mistri/commands';
export const car = (optional: boolean) =>
  field.text({
    label: 'Car',
    max: 80,
    optional,
    case: 'lower',
    pattern: /[a-z0-9]+(-[a-z0-9]+)*/,
    message: 'A listing code such as 2024-toyota-rav4-xle-st1042.',
    help: optional
      ? 'Filled in from a car’s page. Leave it empty to check your rate for any car.'
      : 'Filled in from a car’s page: the end of its address, such as 2024-toyota-rav4-xle-st1042.',
  });
export const budget = {
  zip: field.text({ label: 'ZIP code', max: 5, pattern: /[0-9]{5}/, message: 'Five digits, such as 17101.' }),
  credit_band: field.choice(
    [
      { value: 'excellent', label: 'Excellent (720 and up)' },
      { value: 'good', label: 'Good (660 to 719)' },
      { value: 'fair', label: 'Fair (600 to 659)' },
      { value: 'rebuilding', label: 'Rebuilding (under 600)' },
      { value: 'unsure', label: 'I’m not sure' },
    ],
    { label: 'Your credit', help: 'Your best guess. Nothing is asked of a credit bureau.' },
  ),
  monthly_income: field.money({ label: 'Monthly income before tax', min: 0, max: 100000 }),
  desired_payment: field.money({ label: 'Monthly payment you have in mind', min: 50, max: 5000 }),
};
export const person = {
  first_name: field.text({ max: 80 }),
  last_name: field.text({ max: 80 }),
  email: field.email({ help: 'Where Keystone and the dealer will reach you.' }),
  phone: field.phone({ optional: true }),
};
export const prequalifyInput = { vehicle: car(true), ...budget, ...person };

export const inquireInput = {
  vehicle: car(false),
  ...person,
  message: field.textarea({
    label: 'Your question',
    max: 2000,
    help: 'A test drive, a trade-in, financing: say what you would like to know.',
  }),
};
