import { defineApp } from '@mistriwork/mistri/app';
import type { App } from './mistri-schema.d.ts';
import { navigation } from './navigation.ts';
import { pages } from './pages/index.ts';
import { resources } from './resources.ts';
import { midnight } from './theme.ts';
import { views } from './views.ts';

/* Forecourt: a used-car marketplace anyone may browse, buyers sign up to,
   and a sales desk works. authority.lock beside this file records every
   grant, and `mistri check` fails the moment that changes. */

/* What the public and a buyer read of a dealer: their face, not their inbox. */
const dealerFace = { read: ['id', 'name', 'city', 'phone', 'about', 'rating', 'reviews'] } as const;
const marketplace = ['vehicle', 'vehicle_photo', 'dealer', 'site_image'] as const;
const accountCommands = ['saveVehicle', 'removeSavedVehicle', 'sendVehicleInquiry'] as const;
const deskCommands = [
  'replyToBuyer',
  'addNote',
  'logCall',
  'bookTestDrive',
  'recordOffer',
  'markSold',
  'markLost',
  'assignInquiry',
] as const;
/* The desk keeps the lot in place — price, badge, featured, sold — and its
   photos. Inquiries and their conversation move by commands alone. */
const desk = {
  read: true,
  write: ['vehicle', 'vehicle_photo'],
  commands: [...accountCommands, ...deskCommands],
  fields: {
    vehicle: { write: ['price', 'was_price', 'status', 'featured', 'highlight', 'mileage', 'sold_on', 'description'] },
  },
} as const;

export default defineApp({
  id: 'forecourt',
  name: 'Forecourt',
  sources: { market: { connection: 'forecourt' } },
  resources,
  auth: {
    rows: 'policy',
    providers: ['email'],
    signUp: 'open',
    /* Anyone may make an account, so the role a stranger gets is the smallest
       one: the catalog, their own saved cars and their own inquiries. The
       desk is granted by an administrator. The two lines sit together on purpose. */
    defaultRole: 'shopper',
    roles: {
      shopper: {
        label: 'Buyer',
        read: [...marketplace, 'saved_vehicle', 'inquiry', 'inquiry_message'],
        write: false,
        commands: accountCommands,
        fields: { dealer: dealerFace },
      },
      staff: { label: 'Sales desk', ...desk },
      // The account a first start bootstraps (MISTRI_AUTH_ADMIN_EMAIL): the desk, and the accounts.
      admin: { label: 'Admin', ...desk },
    },
    // Signed out: the cars, their photos, the dealers' public face and the front page's photo. Never an inquiry.
    public: { read: marketplace, fields: { dealer: dealerFace } },
  },
  views,
  pages,
  home: [{ view: 'welcome', signedOut: true }, { view: 'desk', roles: ['staff', 'admin'] }, { view: 'vehicles' }],
  nav: navigation,
  ui: {
    logo: 'car',
    // Midnight: Lumen under an ink-navy bar, with one amber for the buyer's next move (theme.ts).
    theme: { preset: 'midnight' },
    customThemes: [midnight],
    shell: { placement: 'top', width: 'wide', headerWidth: 'content', search: false },
    footer: {
      text: 'Forecourt is a demonstration. The cars, dealers and prices are made up; the photos are public-domain pictures of each model.',
      links: [
        { label: 'How Forecourt works', href: 'https://example.invalid/forecourt/how-it-works' },
        { label: 'Contact the desk', href: 'mailto:desk@forecourt.example.test' },
        { label: 'Terms', href: 'https://example.invalid/forecourt/terms' },
        { label: 'Privacy', href: 'https://example.invalid/forecourt/privacy' },
      ],
    },
    locale: 'en-US',
    timezone: 'America/New_York',
    currency: 'USD',
    export: false,
  },
} satisfies App);
