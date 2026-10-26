import { defineApp } from '@mistriwork/mistri/app';
import type { App } from './mistri-schema.d.ts';
import { sales, today } from './dashboards.ts';
import { navigation } from './navigation.ts';
import { pages } from './pages/index.ts';
import { resources } from './resources.ts';
import { views } from './views.ts';

/* Who does what. Staff sell and send: they take orders, mark them paid,
   confirm, cancel and refund, handle returns, pack and ship, and keep the
   catalog and the customers. The warehouse picks, packs, ships and receives —
   parcels, returns and deliveries from the makers — and reads a customer only
   as far as a parcel needs. The owner does all of it, and alone sets the
   discounts and counts a shelf down. Stock is never an edit for anyone: every
   unit moves through a command, into the ledger. */
const selling = [
  'createOrder',
  'confirmOrder',
  'completeOrder',
  'cancelOrder',
  'markPaid',
  'refundPayment',
  'requestReturn',
  'approveReturn',
  'rejectReturn',
  'refundReturn',
] as const;
const shipping = ['fulfillOrder', 'shipFulfillment', 'deliverFulfillment', 'receiveReturn'] as const;
const catalog = ['product', 'product_image', 'product_tag', 'tag', 'collection', 'collection_product', 'variant', 'customer'] as const;
/* An order's summary words and totals move by its commands alone; the one thing written on it by hand is its note. */
const orderNote = { sales_order: { write: ['note'] } } as const;
const owner = {
  read: true,
  write: [...catalog, 'discount', 'sales_order'],
  commands: [...selling, ...shipping, 'receiveStock', 'adjustStock'],
  fields: orderNote,
} as const;

export default defineApp({
  id: 'atelier',
  name: 'Atelier',
  sources: { atelier: { connection: 'atelier' } },
  resources,
  auth: {
    providers: ['email'],
    defaultRole: 'staff',
    roles: {
      staff: { label: 'Staff', read: true, write: [...catalog, 'sales_order'], commands: [...selling, ...shipping], fields: orderNote },
      warehouse: {
        label: 'Warehouse',
        read: true,
        commands: [...shipping, 'receiveStock'],
        // Enough of a customer to address a parcel and send its tracking: not their phone, address book or notes.
        fields: { customer: { read: ['id', 'name', 'email', 'city', 'state'] } },
      },
      owner: { ...owner, label: 'Owner' },
      // The account a first start bootstraps (MISTRI_AUTH_ADMIN_EMAIL): an owner.
      admin: { ...owner, label: 'Admin' },
    },
  },
  views: { ...views, today, sales },
  pages,
  home: [{ view: 'fulfillment', roles: ['warehouse'] }, { view: 'today' }],
  nav: navigation,
  ui: {
    logo: 'storefront',
    theme: { preset: 'lumen' },
    shell: {
      placement: 'side',
      rail: true,
      counts: true,
      new: [
        { command: 'createOrder', label: 'Order', icon: 'shopping-cart' },
        { view: 'products', icon: 'tag' },
        { view: 'customers', icon: 'users' },
      ],
      sidebar: { footer: { title: 'Atelier', description: 'SoHo · Silver Lake · Secaucus' } },
    },
    locale: 'en-US',
    timezone: 'America/New_York',
    currency: 'USD',
  },
} satisfies App);
