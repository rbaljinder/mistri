/*
 * Quote: the browser gate's App for a stepped public form drawn as a page at a desk and on a phone — a landing whose
 * hero has points, and a five-step intake form (an address row with a listbox beside a masked box, one choice in short
 * icon cards and one in long ones, an amount on a slider, a masked phone) ending in its review and its done screen.
 * Sized to e2e/form-desk.spec.ts; the names are invented.
 */
import { applyTo, commandForm, defineApp, hero, landing, listView, step } from '@mistriwork/mistri/app';

export default defineApp({
  id: 'quote',
  name: 'Example Home Energy',
  sources: { main: { connection: 'main' } },
  /* The ceiling the command writes under, not a grant: no role holds generic write. */
  resources: { quote_request: { access: 'write', recordLabel: 'reference' } },
  auth: { providers: ['email'], defaultRole: 'staff', roles: { staff: { read: true, write: false } } },
  views: {
    welcome: landing(
      hero('Solar for your home, quoted plainly.', 'Tell us about your roof and your bill.', [applyTo('quote', 'Get my quote')], {
        badge: { text: 'About 3 minutes', icon: 'clock' },
        points: [
          { icon: 'sun', text: 'A system sized to your roof' },
          { icon: 'lightning', text: 'Battery options for outages' },
        ],
      }),
      [],
    ),
    quote: commandForm(
      'Solar quote',
      'submitQuote',
      [
        step('Address', ['street', 'unit', ['city', 'state', 'zip']], { title: 'Where would the panels go?' }),
        step('Home', ['home_type'], { title: 'What kind of home is it?' }),
        step('Energy', ['monthly_bill'], { title: 'What do you pay for power?' }),
        step('Battery', ['battery', 'backup'], { title: 'Would you like a home battery?' }),
        step('Contact', [['first_name', 'last_name'], 'phone'], { title: 'Where should we send your quote?', next: 'Review' }),
      ],
      {
        public: true,
        style: 'intake',
        submitLabel: 'Request my quote',
        done: { title: 'Your quote request is in.' },
      },
    ),
    requests: listView('Quote requests', 'quote_request'),
  },
  home: [{ view: 'welcome', signedOut: true }, { view: 'requests' }],
  nav: ['requests'],
  ui: { locale: 'en-US', currency: 'USD' },
});
