import { cards, commandForm, defineApp, listView, machine, msg } from '@mistriwork/mistri/app';
import type { App } from './mistri-schema.d.ts';

/* Foundry Market: a curated vintage marketplace and its curator desk in one App.
   Signed-out visitors wear `ui.site` (public header, search, CTA, footer sign-in) over three custom
   public pages (`pages/door.page.tsx`, `pages/browse.page.tsx`, `pages/item.page.tsx`) plus the
   built-in `catalog` cards view whose cards open `item` via `open: { page: 'item', param: 'id' }`. */

export default defineApp<App>({
  id: 'foundry',
  name: 'Foundry Market',
  connection: 'foundry',
  auth: {
    providers: ['email'],
    public: {
      read: ['listing', 'listing_photo', 'seller'],
    },
    roles: {
      curator: {
        label: msg('role.curator'),
        read: true,
        write: ['seller', 'listing_photo'],
        commands: ['reserveListing', 'releaseHold', 'markSold'],
      },
      admin: {
        label: msg('role.admin'),
        extends: 'curator',
      },
    },
  },
  resources: {
    seller: {
      access: 'write',
      recordLabel: '{name}',
    },
    listing: {
      access: 'write',
      slug: true,
      recordLabel: '{title}',
      labels: {
        price_cents: msg('listing.price'),
        was_price_cents: msg('listing.originalPrice'),
        year_made: msg('listing.year'),
        seller_id: msg('listing.workshop'),
      },
      photos: {
        from: 'listing_photo',
        whose: 'listing_id',
        sort: 'position asc',
        aspect: '3/2',
      },
      display: {
        price_cents: { format: 'money', minor: true, whole: true },
        was_price_cents: { format: 'money', minor: true, whole: true },
        status: {
          tone: { live: 'good', reserved: 'warn', sold: 'neutral' },
        },
      },
      machine: machine('status', {
        live: { on: { reserveListing: 'reserved' } },
        reserved: {
          on: {
            markSold: { to: 'sold', confirm: true },
            releaseHold: { to: 'live', confirm: true },
          },
        },
        sold: { final: true },
      }),
    },
    listing_photo: {
      access: 'write',
      file: { content: 'content', name: 'filename', type: 'mime_type', size: 'size_bytes' },
    },
    consignment: {
      access: 'write',
      recordLabel: '{item_title}',
    },
  },
  views: {
    catalog: listView(msg('view.catalog'), 'listing', {
      query: 'status = live',
      filters: ['category', 'condition', 'city', 'price_cents'],
      presentation: cards({
        primary: 'title',
        value: 'price_cents',
        facts: ['maker', 'category', 'city'],
        badge: 'condition',
      }),
      open: { page: 'item', param: 'id' },
    }),
    consign: commandForm(msg('view.consign'), 'submitConsignment', {
      description: msg('view.consignDescription'),
      public: true,
    }),
    inventory: listView(msg('view.inventory'), 'listing', {
      show: ['title', 'category', 'price_cents', 'status', 'seller_id.name', 'city'],
      filters: ['status', 'category', 'city'],
    }),
    sellers: listView(msg('view.sellers'), 'seller', {
      show: ['name', 'city', 'specialty', 'verified'],
    }),
    consignments: listView(msg('view.consignments'), 'consignment', {
      show: ['item_title', 'seller_name', 'category', 'asking_cents', 'status'],
    }),
  },
  home: [{ view: 'door', signedOut: true }, { view: 'inventory' }],
  nav: ['inventory', 'sellers', 'consignments'],
  ui: {
    locale: 'en-US',
    theme: {
      preset: 'gallery',
      accent: '#A84423',
    },
    site: {
      links: [
        { label: msg('site.linkCollection'), view: 'browse' },
        { label: msg('site.linkCatalog'), view: 'catalog' },
        { label: msg('site.linkSell'), href: '/form/consign' },
      ],
      search: {
        view: 'browse',
        param: 'q',
        placeholder: msg('site.searchPlaceholder'),
      },
      cta: {
        label: msg('site.cta'),
        href: '/form/consign',
      },
      signIn: 'footer',
      footer: {
        text: msg('site.footerText'),
        links: [
          { label: msg('site.footerBrowse'), view: 'browse' },
          { label: msg('site.footerCatalog'), view: 'catalog' },
          { label: msg('site.footerConsign'), href: '/form/consign' },
        ],
      },
    },
  },
});
