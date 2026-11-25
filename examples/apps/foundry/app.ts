import { cards, commandForm, defineApp, listView, machine } from '@mistriwork/mistri/app';

/* Foundry Market: a curated vintage marketplace and its curator desk in one App.
   Signed-out visitors wear `ui.site` (public header, search, CTA, footer sign-in) over three custom
   public pages (`pages/door.page.tsx`, `pages/browse.page.tsx`, `pages/item.page.tsx`) plus the
   built-in `catalog` cards view whose cards open `item` via `open: { page: 'item', param: 'id' }`. */

export default defineApp({
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
        label: 'Curator',
        read: true,
        write: ['seller', 'listing_photo'],
        commands: ['reserveListing', 'releaseHold', 'markSold'],
      },
      admin: {
        label: 'Admin',
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
        price_cents: 'Price',
        was_price_cents: 'Original price',
        year_made: 'Year',
        seller_id: 'Workshop',
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
    catalog: listView('Catalog', 'listing', {
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
    consign: commandForm('Sell on Foundry', 'submitConsignment', {
      description: 'Submit vintage optics, analog hi-fi, or mid-century furniture for curated listing.',
      public: true,
    }),
    inventory: listView('Inventory', 'listing', {
      show: ['title', 'category', 'price_cents', 'status', 'seller_id.name', 'city'],
      filters: ['status', 'category', 'city'],
    }),
    sellers: listView('Sellers', 'seller', {
      show: ['name', 'city', 'specialty', 'verified'],
    }),
    consignments: listView('Submissions', 'consignment', {
      show: ['item_title', 'seller_name', 'category', 'asking_cents', 'status'],
    }),
  },
  home: [{ view: 'door', signedOut: true }, { view: 'inventory' }],
  nav: ['inventory', 'sellers', 'consignments'],
  ui: {
    theme: {
      preset: 'gallery',
      accent: '#A84423',
    },
    site: {
      links: [
        { label: 'Collection', view: 'browse' },
        { label: 'Catalog', view: 'catalog' },
        { label: 'Sell on Foundry', href: '/form/consign' },
      ],
      search: {
        view: 'browse',
        param: 'q',
        placeholder: 'Search Leica, Braun, walnut…',
      },
      cta: {
        label: 'List a piece',
        href: '/form/consign',
      },
      signIn: 'footer',
      footer: {
        text: '© 2026 Foundry Market — Curated vintage optics, analog audio & mid-century design',
        links: [
          { label: 'Browse collection', view: 'browse' },
          { label: 'Catalog view', view: 'catalog' },
          { label: 'Consign a piece', href: '/form/consign' },
        ],
      },
    },
  },
});
