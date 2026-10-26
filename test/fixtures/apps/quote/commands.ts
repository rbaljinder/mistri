/*
 * The quote fixture's command, and its `--commands` entry. Server-only. It files a quote request and answers a random
 * reference; it reads nothing and echoes nothing typed.
 */
import {
  defineCommand,
  defineCommands,
  defineSource,
  field,
  literal,
  publicReference,
  publicReferencePattern,
  shape,
  text,
} from '@mistriwork/mistri/commands';

const main = defineSource('main');

const STATES = ['CA', 'CO', 'NY', 'TX'] as const;
/* Short words: at a desk they stand two or three across, the icon over the words. */
const HOMES = [
  { value: 'house', label: 'House', icon: 'house' },
  { value: 'townhouse', label: 'Townhouse', icon: 'house-line' },
  { value: 'condo', label: 'Condo', icon: 'buildings' },
] as const;
/* Long words with help: a list at any width. */
const BATTERY = [
  { value: 'yes', label: 'Yes, include a battery', icon: 'lightning', help: 'Store daytime sun for nights and outages' },
  { value: 'compare', label: 'Show me both', icon: 'arrows-left-right', help: 'Quote solar alone and with a battery' },
  { value: 'no', label: 'Solar only', icon: 'sun', help: 'I can add a battery later' },
] as const;
const BACKUP = [
  { value: 'fridge', label: 'Fridge', icon: 'lightbulb' },
  { value: 'heat', label: 'Heating', icon: 'thermometer' },
  { value: 'pump', label: 'Well pump', icon: 'drop' },
] as const;

export const submitQuote = defineCommand({
  source: main,
  target: 'quote_request',
  targets: 'none',
  public: true,
  read: [],
  write: ['quote_request'],
  input: {
    street: field.text({ label: 'Street address', max: 120 }),
    unit: field.text({ label: 'Apt or unit', max: 20, optional: true }),
    city: field.text({ max: 60 }),
    state: field.choice(STATES, { as: 'select' }),
    zip: field.text({ label: 'ZIP code', mask: '00000', message: 'Enter the 5 digits of your ZIP code.' }),
    home_type: field.choice(HOMES, { label: 'Type of home', as: 'cards' }),
    monthly_bill: field.money({ label: 'Average monthly bill', min: 50, max: 600, step: 10, as: 'slider' }),
    battery: field.choice(BATTERY, { label: 'Home battery', as: 'cards' }),
    // A bare no compares the word: the question is asked unless the answer is "Solar only".
    backup: field.choices(BACKUP, { label: 'What should keep running?', as: 'cards', when: 'battery != no', optional: true }),
    first_name: field.text({ max: 60 }),
    last_name: field.text({ max: 60 }),
    phone: field.text({ label: 'Mobile phone', mask: '(000) 000-0000' }),
  },
  output: shape({ reference: text({ pattern: publicReferencePattern('QTE') }), message: literal('Your quote request is in.') }),
  async handle({ db, now }, input) {
    const reference = publicReference('QTE');
    await db.quote_request.insert({
      reference,
      city: input.city,
      state: input.state,
      zip: input.zip,
      home_type: input.home_type,
      monthly_bill: input.monthly_bill,
      battery: input.battery,
      phone: input.phone,
      received_at: now().toISOString(),
    });
    return { reference, message: 'Your quote request is in.' as const };
  },
});

export default defineCommands({ submitQuote });
