import { defineApp } from '@mistriwork/mistri/app';
import { appSwitcher } from '../navigation.ts';
import { inquiries } from './features/inquiries.ts';
import { publicForms } from './features/public-forms.ts';
import { rateChecks } from './features/rate-checks.ts';
import { shortlist } from './features/shortlist.ts';
import { dealerPage } from './pages/dealer.ts';
import { programPage } from './pages/program.ts';
import { vehiclePage } from './pages/vehicle.ts';
import { resources } from './resources.ts';
import type { App } from './mistri-schema.d.ts';
import { keystone } from './theme.ts';
import { views } from './views.ts';

/* Keystone's marketplace: where the dealers' cars and Keystone's rates meet
   the people who will buy them (test/fixtures/apps/keystone/SUITE.md). Anyone may
   browse; an account keeps a shortlist and follows its own inquiries and rate
   checks. authority.lock beside this file records every grant, and
   mistri check fails the moment that changes. */

/* Column ceilings, the same for every reader here, signed out or in. What the
   dealer paid for a car is the dealer's own figure; a dealer's terms with
   Keystone and its private apply address are the lender's. None is served by
   this App. (A resource's `hidden` would say it once, but the generated types
   drop a hidden column and then refuse the `hidden` that names it.) */
const vehiclePublic = {
  read: [
    'id',
    'dealer_id',
    'stock_number',
    'vin',
    'year',
    'make',
    'model',
    'trim',
    'body',
    'fuel',
    'drivetrain',
    'mileage',
    'exterior_color',
    'interior_color',
    'condition',
    'list_price',
    'est_payment',
    'featured',
    'status',
    'received_on',
    'listed_on',
    'sold_on',
    'description',
    'features',
    'version',
  ],
} as const;
const dealerPublic = {
  read: ['id', 'name', 'kind', 'franchise_make', 'status', 'street', 'city', 'state', 'zip', 'phone', 'joined_on'],
} as const;
const catalog = { vehicle: vehiclePublic, dealer: dealerPublic };

export default defineApp({
  id: 'marketplace',
  name: 'Keystone',
  sources: { keystone: { connection: 'keystone' } },
  resources,
  features: [publicForms, shortlist, inquiries, rateChecks],
  auth: {
    // Forecourt's model: the catalog is public, and policy.ts confines the
    // shortlist, the inquiries and the rate checks to the verified account.
    rows: 'policy',
    providers: ['email'],
    signUp: 'open',
    /* Anyone may make an account, so the role a stranger gets is the smallest
       one: the catalog and their own rows. Keystone's marketing desk is
       granted by an administrator. The two lines sit together on purpose. */
    defaultRole: 'customer',
    roles: {
      customer: { label: 'Customer', read: ['vehicle', 'vehicle_photo', 'dealer', 'program'], write: false, fields: catalog },
      marketplace_admin: {
        label: 'Marketplace admin',
        read: ['vehicle', 'vehicle_photo', 'dealer', 'program', 'lead_activity'],
        write: false,
        fields: catalog,
      },
    },
    // Signed out: the cars, their photos, the dealers' public face and the rate sheet. Nothing a person sent.
    public: {
      read: ['vehicle', 'vehicle_photo', 'dealer', 'program'],
      fields: catalog,
    },
  },
  views,
  pages: { vehicle: vehiclePage, program: programPage, dealer: dealerPage },
  home: [{ view: 'welcome', signedOut: true }, { view: 'prequalifications', roles: ['marketplace_admin'] }, { view: 'vehicles' }],
  nav: ['vehicles', 'programs', 'dealers', 'shortlist', 'inquiries', 'prequalifications'],
  ui: {
    appSwitcher,
    logo: 'key',
    customThemes: [keystone],
    theme: { preset: 'keystone' },
    shell: { placement: 'top', width: 'wide', headerWidth: 'content', search: false },
    footer: {
      text: 'Keystone Auto Finance is a demonstration. The cars, dealers, rates and photos are made up, and no credit is offered.',
      links: [
        { label: 'How Keystone lends', href: 'https://example.invalid/keystone/how-we-lend' },
        { label: 'Contact Keystone', href: 'mailto:hello@keystone.example.test' },
        { label: 'Terms', href: 'https://example.invalid/keystone/terms' },
        { label: 'Privacy', href: 'https://example.invalid/keystone/privacy' },
      ],
    },
    currency: 'USD',
    locale: 'en-US',
    timezone: 'America/New_York',
    export: false,
  },
} satisfies App);
