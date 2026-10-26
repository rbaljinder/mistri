import { defineApp, fromRecord } from '@mistriwork/mistri/app';
import { appSwitcher } from '../navigation.ts';
import { views } from './features/publicSite.ts';
import { dealerPage } from './pages/dealer.ts';
import { vehiclePage } from './pages/vehicle.ts';
import { resources } from './resources.ts';
import type { App } from './mistri-schema.d.ts';

/* A Keystone dealer's own website: its front page, its lot with photos and
   filters, each car's page, and three forms that become the dealer's leads in
   /leads — a question, a test drive, and an application for financing. The
   public reads it signed out; nobody signs in to shop.

   One App serves every admitted storefront. The operator's public host intent
   selects an exact dealer; policy.ts independently verifies active/published
   eligibility. Branding consumes those scoped public records. */
export default defineApp({
  id: 'site',
  name: 'Dealership website',
  sources: { keystone: { connection: 'keystone' } },
  resources,
  auth: {
    rows: 'policy',
    providers: ['email'],
    defaultRole: 'web_admin',
    /* Keystone's web team, the one role, because signed-out reads need roles
       to exist. It reads what the public reads, and the leads the forms
       wrote, to see that they arrive; it has no view of them and answers
       none (the dealer does, in /leads). It holds the leads only because the
       App's generated types are written from what some role reads, and a
       table no role reads is missing from the types the form handlers write
       through (README, "Gaps"). Invite-only, and no account is provisioned. */
    roles: {
      web_admin: {
        label: 'Web admin',
        read: ['dealer', 'dealer_site', 'vehicle', 'vehicle_photo', 'program', 'lead', 'lead_activity', 'applicant'],
        fields: {
          dealer: { read: ['id', 'name', 'street', 'city', 'state', 'zip', 'phone'] },
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
          },
        },
      },
    },
    /* What anyone reads, signed out: the cars (never what the dealer paid),
       their photos, the dealer's public face and Keystone's rates. The
       dealer's intake address is left out: nothing here links to /leads yet
       (SUITE.md G4), so there is no reason to serve it. */
    public: {
      read: ['dealer', 'dealer_site', 'vehicle', 'vehicle_photo', 'program'],
      fields: {
        dealer: { read: ['id', 'name', 'street', 'city', 'state', 'zip', 'phone'] },
        dealer_site: {
          read: [
            'id',
            'dealer_id',
            'published',
            'version',
            'headline',
            'tagline',
            'about',
            'brand_color',
            'accent_color',
            'logo_text',
            'show_prices',
            'contact_email',
            'contact_phone',
            'hours',
          ],
        },
        vehicle_photo: {
          read: ['id', 'dealer_id', 'vehicle_id', 'position', 'caption', 'file_name', 'content_type', 'byte_size', 'data', 'thumbnail'],
        },
        program: {
          read: [
            'id',
            'code',
            'name',
            'tier',
            'min_score',
            'max_ltv_pct',
            'max_term',
            'max_vehicle_age',
            'max_mileage',
            'base_apr',
            'max_amount',
            'advertised',
            'active',
            'description',
          ],
        },
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
        },
      },
    },
  },
  views,
  pages: { vehicle: vehiclePage, dealer: dealerPage },
  home: [{ view: 'welcome', signedOut: true }, { view: 'inventory' }],
  nav: ['inventory', 'financing', 'visit'],
  ui: {
    appSwitcher,
    logo: 'car',
    theme: fromRecord('dealer_site', {
      by: 'host',
      tenantField: 'dealer_id',
      publishedField: 'published',
      fallback: { preset: 'lumen' },
      fields: { accent: 'brand_color', heading: 'headline', tagline: 'tagline', about: 'about', hours: 'hours' },
    }),
    shell: { placement: 'top', width: 'wide', headerWidth: 'content', search: false, breadcrumbs: false },
    footer: {
      text: 'This dealership website and Keystone Auto Finance are demonstrations. The cars, prices and rates are made up; no credit is offered.',
      links: [{ label: 'Privacy', href: 'https://example.invalid/privacy' }],
    },
    locale: 'en-US',
    timezone: 'America/New_York',
    currency: 'USD',
    export: false,
  },
} satisfies App);
