import { defineMessages } from '@mistriwork/mistri/app';

/**
 * Foundry Market's message catalog (`ui.locale: 'en-US'`).
 * Nested groups flatten to dotted keys (`door.headline`, `site.footerText`, etc.) so manifest captions
 * (`msg('...')`) and custom pages (`useMessage('...')`) stay checked by `mistri check` and ready for
 * additional language catalogs (`messages/es.ts`, etc.).
 */
const en = defineMessages('en', {
  role: {
    curator: 'Curator',
    admin: 'Admin',
  },
  listing: {
    price: 'Price',
    originalPrice: 'Original price',
    year: 'Year',
    workshop: 'Workshop',
  },
  view: {
    catalog: 'Catalog',
    consign: 'Sell on Foundry',
    consignDescription: 'Submit vintage optics, analog hi-fi, or mid-century furniture for curated listing.',
    inventory: 'Inventory',
    sellers: 'Sellers',
    consignments: 'Submissions',
  },
  site: {
    linkCollection: 'Collection',
    linkCatalog: 'Catalog',
    linkSell: 'Sell on Foundry',
    searchPlaceholder: 'Search Leica, Braun, walnut…',
    cta: 'List a piece',
    footerText: '© 2026 Foundry Market — Curated vintage optics, analog audio & mid-century design',
    footerBrowse: 'Browse collection',
    footerCatalog: 'Catalog view',
    footerConsign: 'Consign a piece',
  },
  command: {
    buyerName: 'Your full name',
    buyerEmail: 'Email address',
    sellerName: 'Your name or workshop',
    itemTitle: 'Piece title & year',
    askingPrice: 'Target asking price (USD)',
    notes: 'Condition & provenance',
  },
  door: {
    label: 'Foundry Market',
    description: 'Curated vintage optics, analog audio, and mid-century design from independent workshops.',
    eyebrow: 'Verified independent workshops · Pacific Northwest & California',
    headline: 'Objects built to outlast every room they enter.',
    lead: 'Serviced rangefinders, restored Scandinavian seating, and bench-tested hi-fi. Every piece is photographed in studio, authenticated by its specialist, and held atomically the moment you claim it.',
    explore: 'Explore the collection',
    sell: 'Sell a piece',
    browseByCategory: 'Browse by category',
    freshEyebrow: 'Fresh from the bench',
    freshHeading: 'Available on Foundry now',
    filterAll: 'Filter all {count, plural, one {# piece} other {# pieces}} →',
    monthlyEstimate: 'or {amount}/mo',
  },
  browse: {
    label: 'Collection',
    description: 'Filter curated vintage optics, mid-century furniture, audio, and lighting.',
    eyebrow: 'Foundry collection',
    heading: 'Browse curated pieces',
    sortPriceAsc: 'Price: Low to High',
    sortPriceDesc: 'Price: High to Low',
    sortYearAsc: 'Year: Oldest First',
    showingCount: 'Showing {count, plural, one {# available piece} other {# available pieces}}',
    emptyTitle: 'No pieces match',
    emptyDescription: 'Try clearing a filter or broadening your search.',
    monthly: '{amount}/mo',
  },
  item: {
    label: 'Listing',
    description: 'Studio photography, provenance, and instant atomic hold for a single piece.',
    breadcrumbAria: 'Breadcrumb',
    breadcrumbHome: 'Home',
    breadcrumbCollection: 'Collection',
    notFoundTitle: 'Piece not found',
    notFoundDescription: 'This listing may have been removed or moved.',
    monthlyNote: 'Estimated {amount}/mo over 12 months · Insured courier included',
    holdTitle: '48-hour atomic hold',
    cancel: 'Cancel',
    buyerNamePlaceholder: 'Elena Vance',
    buyerEmailPlaceholder: 'elena@studio.org',
    confirmHold: 'Confirm 48h hold',
    holdDone: 'Piece reserved. Check your confirmation reference.',
    holdGuarantee: 'Backed by atomic db.listing.claim() — commits only while this piece is still live.',
    reserveCta: 'Reserve this piece (48h hold)',
    unavailableStatus: 'Currently {status} — no longer available for hold',
    workshopEyebrow: 'Authenticated workshop',
    curatorNotes: 'Curator notes',
    provenance: 'Provenance & service',
    alsoOnFoundry: 'Also on Foundry',
  },
});

export default en;

declare module '@mistriwork/mistri/app' {
  interface AppMessages extends Record<keyof typeof en.entries, string> {}
}
