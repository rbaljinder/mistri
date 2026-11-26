import { defineMessages } from '@mistriwork/mistri/app';

/**
 * Foundry Market's message catalog (`ui.locale: 'en-US'`).
 * Manifest captions use `msg('...')` and custom pages use `useMessage('...')` so every visible string
 * is checked by `mistri check` and ready for additional language catalogs (`messages/es.ts`, etc.).
 */
const en = defineMessages('en', {
  'role.curator': 'Curator',
  'role.admin': 'Admin',

  'listing.price': 'Price',
  'listing.originalPrice': 'Original price',
  'listing.year': 'Year',
  'listing.workshop': 'Workshop',

  'view.catalog': 'Catalog',
  'view.consign': 'Sell on Foundry',
  'view.consignDescription': 'Submit vintage optics, analog hi-fi, or mid-century furniture for curated listing.',
  'view.inventory': 'Inventory',
  'view.sellers': 'Sellers',
  'view.consignments': 'Submissions',

  'site.linkCollection': 'Collection',
  'site.linkCatalog': 'Catalog',
  'site.linkSell': 'Sell on Foundry',
  'site.searchPlaceholder': 'Search Leica, Braun, walnut…',
  'site.cta': 'List a piece',
  'site.footerText': '© 2026 Foundry Market — Curated vintage optics, analog audio & mid-century design',
  'site.footerBrowse': 'Browse collection',
  'site.footerCatalog': 'Catalog view',
  'site.footerConsign': 'Consign a piece',

  'command.buyerName': 'Your full name',
  'command.buyerEmail': 'Email address',
  'command.sellerName': 'Your name or workshop',
  'command.itemTitle': 'Piece title & year',
  'command.askingPrice': 'Target asking price (USD)',
  'command.notes': 'Condition & provenance',

  'door.label': 'Foundry Market',
  'door.description': 'Curated vintage optics, analog audio, and mid-century design from independent workshops.',
  'door.eyebrow': 'Verified independent workshops · Pacific Northwest & California',
  'door.headline': 'Objects built to outlast every room they enter.',
  'door.lead':
    'Serviced rangefinders, restored Scandinavian seating, and bench-tested hi-fi. Every piece is photographed in studio, authenticated by its specialist, and held atomically the moment you claim it.',
  'door.explore': 'Explore the collection',
  'door.sell': 'Sell a piece',
  'door.browseByCategory': 'Browse by category',
  'door.freshEyebrow': 'Fresh from the bench',
  'door.freshHeading': 'Available on Foundry now',
  'door.filterAll': 'Filter all {count, plural, one {# piece} other {# pieces}} →',
  'door.monthlyEstimate': 'or {amount}/mo',

  'browse.label': 'Collection',
  'browse.description': 'Filter curated vintage optics, mid-century furniture, audio, and lighting.',
  'browse.eyebrow': 'Foundry collection',
  'browse.heading': 'Browse curated pieces',
  'browse.sortPriceAsc': 'Price: Low to High',
  'browse.sortPriceDesc': 'Price: High to Low',
  'browse.sortYearAsc': 'Year: Oldest First',
  'browse.showingCount': 'Showing {count, plural, one {# available piece} other {# available pieces}}',
  'browse.emptyTitle': 'No pieces match',
  'browse.emptyDescription': 'Try clearing a filter or broadening your search.',
  'browse.monthly': '{amount}/mo',

  'item.label': 'Listing',
  'item.description': 'Studio photography, provenance, and instant atomic hold for a single piece.',
  'item.breadcrumbAria': 'Breadcrumb',
  'item.breadcrumbHome': 'Home',
  'item.breadcrumbCollection': 'Collection',
  'item.notFoundTitle': 'Piece not found',
  'item.notFoundDescription': 'This listing may have been removed or moved.',
  'item.monthlyNote': 'Estimated {amount}/mo over 12 months · Insured courier included',
  'item.holdTitle': '48-hour atomic hold',
  'item.cancel': 'Cancel',
  'item.buyerNamePlaceholder': 'Elena Vance',
  'item.buyerEmailPlaceholder': 'elena@studio.org',
  'item.confirmHold': 'Confirm 48h hold',
  'item.holdDone': 'Piece reserved. Check your confirmation reference.',
  'item.holdGuarantee': 'Backed by atomic db.listing.claim() — commits only while this piece is still live.',
  'item.reserveCta': 'Reserve this piece (48h hold)',
  'item.unavailableStatus': 'Currently {status} — no longer available for hold',
  'item.workshopEyebrow': 'Authenticated workshop',
  'item.curatorNotes': 'Curator notes',
  'item.provenance': 'Provenance & service',
  'item.alsoOnFoundry': 'Also on Foundry',
});

export default en;

declare module '@mistriwork/mistri/app' {
  interface AppMessages extends Record<keyof typeof en.entries, string> {}
}
