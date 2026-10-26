import { defineApp } from '@mistriwork/mistri/app';
import type { App } from './mistri-schema.d.ts';
import { dealerPage } from './pages/dealer.ts';
import { inquiries } from './features/inquiries.ts';
import { shortlist } from './features/shortlist.ts';
import { accountInquiries } from './features/account-inquiries.ts';
import { vehiclePage } from './pages/vehicle.ts';
import { resources } from './resources.ts';
import { marketplace, showroom } from './theme.ts';
import { views } from './views.ts';

/* Forecourt: a used-vehicle marketplace that anyone may browse and staff
   sign in to. The App's identity, its one source, what each resource is at
   most, who reads what signed in and signed out, where each visitor starts,
   the menu and the look. authority.lock beside this file records every
   grant, and mistri check fails the moment that changes. */
export default defineApp({
  id: 'forecourt',
  name: 'Forecourt',
  sources: { market: { connection: 'forecourt' } },
  resources,
  features: [inquiries, shortlist, accountInquiries],
  auth: {
    rows: 'policy',
    providers: ['email'],
    signUp: 'open',
    defaultRole: 'shopper',
    /* Anyone may make an account, as on any marketplace — so the role a new
       account gets must be the *smallest* one, not the staff role. A shopper
       reads the catalog and their own saved vehicles/account inquiries; the
       anonymous sales inbox belongs to staff, whom an administrator grants. Sign-up being open and
       the default role being privileged is the pair that leaks an inbox, so
       the two are written next to each other deliberately. */
    roles: {
      shopper: {
        read: ['vehicle', 'vehicle_photo', 'dealer', 'site_image'],
        write: false,
        fields: { dealer: { read: ['id', 'name', 'city', 'phone', 'about'] } },
      },
      staff: { read: true, write: false },
      admin: { read: true, write: false },
    },
    /* Signed out, a visitor browses the marketplace — the vehicles, their
       photos, the dealers (of a dealer, not the sales inbox) and the front
       page's photo — and never the inquiries. Writing one is the public
       form's alone. */
    public: {
      read: ['vehicle', 'vehicle_photo', 'dealer', 'site_image'],
      fields: { dealer: { read: ['id', 'name', 'city', 'phone', 'about'] } },
    },
  },
  views,
  pages: { vehicle: vehiclePage, dealer: dealerPage },
  // Staff start with inquiries; shoppers start with their own saved vehicles.
  home: [{ view: 'welcome', signedOut: true }, { view: 'inquiries', roles: ['staff', 'admin'] }, { view: 'shortlist' }],
  // A visitor's menu is what the public reads: Vehicles and Dealers.
  nav: ['vehicles', 'dealers', 'shortlist', 'inquiries'],
  ui: {
    logo: 'car',
    /* Marketplace (theme.ts) is the App's default: Sage's soft cards and
       shadows under a confident blue, which is how a marketplace reads to
       someone deciding on a car. Showroom — Canvas in a deep racing green,
       the dealer's own colours — stays registered beside it, and the
       reader's picker still offers both and the built-in looks. */
    customThemes: [showroom, marketplace],
    theme: { preset: 'marketplace' },
    shell: { placement: 'top', width: 'wide', headerWidth: 'content', search: false },
    /* Under every room, the landing's included, the way a marketplace carries
       its terms and its contact on the pages people actually read. */
    footer: {
      text: 'A demonstration marketplace. The cars, the dealers, the photos and the prices are made up.',
      links: [
        { label: 'How Forecourt works', href: 'https://example.invalid/how-it-works' },
        { label: 'Contact a dealer', href: 'mailto:sales@example.invalid' },
        { label: 'Terms', href: 'https://example.invalid/terms' },
        { label: 'Privacy', href: 'https://example.invalid/privacy' },
      ],
    },
    currency: 'USD',
    locale: 'en-US',
    export: false,
  },
} satisfies App);
