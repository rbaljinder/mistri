/*
 * Door: the browser gate's own App for what a signed-out visitor meets at a
 * public door — a landing whose hero carries a badge, photo tiles and icon
 * rows; a stock public form that asks a human check (Turnstile's local
 * stand-in, commands.ts), offers rows of a table as its choices and draws one
 * field with the App's own input component; and a public free-form page whose
 * command goes through the page's own door. Sized to e2e/public-door.spec.ts;
 * the names are invented.
 */
import { applyTo, commandForm, component, defineApp, hero, landing, listView, step } from '@mistriwork/mistri/app';

/** The color field of the public form, drawn as a row of swatches; the server still reads it as text. */
export const swatch = component('swatch', { module: './widgets/Swatch.tsx', kind: 'input' });

const photo = (key: number, alt: string) => ({ from: 'site_image', key, alt });

export default defineApp({
  id: 'door',
  name: 'Harbor Paints',
  sources: { shop: { connection: 'shop' } },
  resources: {
    make: {},
    inquiry: { access: 'write' },
    enrolment: { access: 'write' },
    site_image: { file: { content: 'data', name: 'file_name' } },
  },
  auth: {
    providers: ['email'],
    roles: { clerk: { read: true, write: false } },
    public: { read: ['make', 'site_image'] },
    challenge: 'verifyHuman',
  },
  views: {
    inquiries: listView('Inquiries', 'inquiry'),
    ask: commandForm('Ask about a paint', 'ask', [step('Paint', ['make', 'color'])], {
      public: true,
      inputs: { color: swatch },
      done: { title: 'We have your question' },
    }),
    welcome: landing(
      hero('Paint that outlasts the weather', 'Mixed to order on the harbor since 1987.', [applyTo('ask', 'Ask about a paint')], {
        badge: { text: 'Mixed while you wait', icon: 'lightning' },
        tiles: [photo(1, 'A wall of paint tins'), photo(2, 'A brush on a fresh coat'), photo(3, 'The mixing counter')],
        points: [
          { icon: 'shield-check', text: 'Ten-year finish guarantee' },
          { icon: 'clock', text: 'Ready in fifteen minutes' },
        ],
      }),
    ),
  },
  home: [{ view: 'welcome', signedOut: true }, { view: 'inquiries' }],
  nav: ['inquiries'],
});
