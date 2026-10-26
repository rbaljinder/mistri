import { defineApp, navGroup } from '@mistriwork/mistri/app';
import { appSwitcher } from '../navigation.ts';
import { pages } from './pages/index.ts';
import type { App } from './mistri-schema.d.ts';

import { resources } from './resources.ts';
import { views } from './views.ts';

/* Keystone's settings desk for the dealers it lends through: a dealership's
   owner and sales manager keep its website, price and list its cars, look
   after its team, and see how Keystone looks after them. Every row they
   read is one of their own dealership's, and that is the row policy's job
   (policy.ts, loaded with --policy), not a filter here: it finds the
   person's active owner or sales-manager seats on dealer_user from the
   verified account and scopes every table to those dealerships.

   There is one App role: whether a person is an owner or a sales manager
   is a fact of each dealership (dealer_user.role), not of the account, and
   the team commands (commands.ts) judge it on the row they act on. */
const manager = {
  read: true,
  write: ['dealer_site', 'vehicle'],
  commands: [
    'addTeamMember',
    'updateDealerContact',
    'changeTeamRole',
    'deactivateTeamMember',
    'publishWebsite',
    'unpublishWebsite',
    'listForSale',
    'takeOffTheMarket',
  ],
  fields: {
    // Branding is theirs to edit; which dealership a site belongs to is not.
    dealer_site: {
      read: [
        'id',
        'dealer_id',
        'published',
        'headline',
        'tagline',
        'about',
        'brand_color',
        'accent_color',
        'logo_text',
        'custom_domain',
        'show_prices',
        'contact_email',
        'contact_phone',
        'hours',
        'published_on',
        'version',
      ],
      write: [
        'headline',
        'tagline',
        'about',
        'brand_color',
        'accent_color',
        'logo_text',
        'custom_domain',
        'show_prices',
        'contact_email',
        'contact_phone',
        'hours',
      ],
    },
    // The sign-in link is the desk's bookkeeping, never shown.
    dealer_user: {
      read: ['id', 'dealer_id', 'name', 'email', 'phone', 'role', 'status', 'invited_on', 'joined_on', 'version'],
    },
    // A car's identity is the lot's record; its price, its flag and its words are the listing.
    vehicle: {
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
        'cost',
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
      write: ['list_price', 'featured', 'description', 'features'],
    },
  },
} as const;

export default defineApp({
  id: 'dealer',
  name: 'Keystone for Dealers',
  sources: { keystone: { connection: 'keystone' } },
  resources,
  auth: {
    rows: 'policy',
    // Keystone's dealer support invites a dealership's owner and managers; nobody signs up to a dealership.
    providers: ['email'],
    defaultRole: 'manager',
    me: { from: 'dealer_user', column: 'email' },
    roles: {
      manager,
      /* Keystone's dealer support, here only to invite people (Manage
         accounts). The policy admits no dealership's rows to it. */
      admin: { label: 'Admin', read: true },
    },
  },
  views,
  pages,
  home: 'overview',
  nav: [
    'overview',
    'website',
    navGroup('lot', 'Inventory', ['inventory', 'showroom'], { icon: 'car' }),
    'team',
    navGroup('keystone', 'Dealership', ['dealership', 'visits', 'programs'], { icon: 'buildings' }),
  ],
  ui: {
    appSwitcher,
    logo: 'storefront',
    theme: { preset: 'lumen' },
    shell: { placement: 'side', rail: true, counts: true },
    footer: { text: 'Keystone Auto Finance is a demonstration. No credit is offered and no money moves.' },
    locale: 'en-US',
    timezone: 'America/New_York',
    currency: 'USD',
    export: false,
  },
} satisfies App);
