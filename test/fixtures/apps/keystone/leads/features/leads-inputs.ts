// Server-only field shapes shared by the command handlers.
import { field } from '@mistriwork/mistri/commands';
export const US_STATE = { pattern: /[A-Z]{2}/, case: 'upper', message: 'Two letters, such as PA.' } as const;
export const person = {
  first_name: field.text({ max: 60 }),
  last_name: field.text({ max: 60 }),
  email: field.email(),
  phone: field.phone(),
  date_of_birth: field.date({ min: '1920-01-01', max: '2008-12-31' }),
  ssn_last4: field.text({ label: 'Last four of the SSN', pattern: /\d{4}/, message: 'Four digits.', help: 'Only the last four digits.' }),
};
export const home = {
  street: field.text({ label: 'Street address', max: 120 }),
  city: field.text({ max: 60 }),
  state: field.text({ max: 2, ...US_STATE }),
  zip: field.text({ label: 'ZIP code', pattern: /\d{5}/, message: 'Five digits.' }),
  housing: field.choice([
    { value: 'rent', label: 'Rent' },
    { value: 'own', label: 'Own' },
    { value: 'family', label: 'Live with family' },
    { value: 'other', label: 'Other' },
  ]),
  monthly_housing: field.money({ label: 'Rent or mortgage a month', min: 0, max: 50000 }),
  years_at_address: field.number({ label: 'Years at this address', min: 0, max: 80, step: 0.5 }),
};
export const work = {
  employment_type: field.choice(
    [
      { value: 'full_time', label: 'Full time' },
      { value: 'part_time', label: 'Part time' },
      { value: 'self_employed', label: 'Self-employed' },
      { value: 'retired', label: 'Retired' },
      { value: 'other', label: 'Other' },
    ],
    { label: 'Employment' },
  ),
  employer: field.text({ max: 120, optional: true }),
  job_title: field.text({ max: 80, optional: true }),
  years_employed: field.number({ label: 'Years there', min: 0, max: 60, step: 0.5 }),
  monthly_income: field.money({ label: 'Gross income a month', min: 0, max: 1000000 }),
};
export const logContactInput = {
  kind: field.choice(
    [
      { value: 'call', label: 'Call' },
      { value: 'text', label: 'Text' },
      { value: 'email', label: 'Email' },
      { value: 'visit', label: 'Visit' },
      { value: 'test_drive', label: 'Test drive' },
      { value: 'note', label: 'Note' },
    ],
    { label: 'What happened' },
  ),
  body: field.textarea({ label: 'Notes', max: 1000, help: "What was said and what the customer wants. Kept on the lead's timeline." }),
  next_follow_up_on: field.date({ label: 'Next follow-up', optional: true, help: 'Leave empty when nothing is planned.' }),
};

export const takeApplicationInput = {
  role: field.choice(
    [
      { value: 'primary', label: 'The customer' },
      { value: 'co_applicant', label: 'A co-applicant' },
    ],
    { label: 'Whose application' },
  ),
  person: field.group(person, { label: 'The applicant' }),
  home: field.group(home, { label: 'Where they live' }),
  work: field.group(work, { label: 'Work and income' }),
};

export const startDealInput = {
  vehicle: field.reference('vehicle', {
    by: 'id',
    labelColumn: 'stock_number',
    query: 'status = listed or status = in_stock',
    help: 'By stock number: a car on the lot that is not already pending a sale.',
  }),
  program: field.reference('program', {
    by: 'id',
    labelColumn: 'name',
    query: 'active = true sort min_score desc',
    label: 'Keystone program',
    help: 'The rate sheet this deal is desked against.',
  }),
  term_months: field.choice([48, 60, 66, 72, 75, 84], { label: 'Term', each: (n) => `${n} months` }),
  cash_down: field.money({ min: 0, max: 500000 }),
};

export const markLeadLostInput = {
  reason: field.choice(
    [
      { value: 'bought_elsewhere', label: 'Bought elsewhere' },
      { value: 'no_response', label: 'Stopped responding' },
      { value: 'credit', label: 'Credit' },
      { value: 'price', label: 'Price' },
      { value: 'other', label: 'Other' },
    ],
    { label: 'Why it was lost' },
  ),
  note: field.textarea({ max: 500, optional: true }),
};

export const recordWalkInInput = {
  first_name: field.text({ max: 60 }),
  last_name: field.text({ max: 60 }),
  phone: field.phone(),
  email: field.email({ optional: true }),
  source: field.choice(
    [
      { value: 'walk_in', label: 'Walked in' },
      { value: 'phone', label: 'Called' },
      { value: 'referral', label: 'Referral' },
    ],
    { label: 'How they came' },
  ),
  message: field.textarea({ label: 'What they are after', max: 1000, optional: true }),
};
