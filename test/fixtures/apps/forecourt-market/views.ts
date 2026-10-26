import { commandForm, listView } from '@mistriwork/mistri/app';
import type { Views } from './mistri-schema.d.ts';
import { dealerCard, savedCard, vehicleCard } from './cards.ts';
import { deskDashboard } from './dashboard.ts';
import { forecourtLanding } from './landing.ts';

/* Every room of Forecourt; navigation.ts arranges them. The marketplace is
   public, an account keeps its saved cars and inquiries, and the desk —
   staff and admins — works the inquiries and the lot. */

const DESK = ['staff', 'admin'];

export const views = {
  // The front page, signed out (landing.ts).
  welcome: forecourtLanding,

  /* ---------- the marketplace ---------- */
  // Every car not yet sold, as cards, narrowed from a rail of counted
  // facets. The address is the question:
  // /vehicles?make=Toyota,Honda&price=..25000&sort=-price.
  vehicles: listView('Cars for sale', 'vehicle', {
    icon: 'car',
    query: 'for_sale',
    presentation: vehicleCard,
    filterBar: 'rail',
    filters: ['title', 'make', 'body_type', 'price', 'year', 'mileage', 'fuel', 'drivetrain', 'transmission'],
    // The name box offers the makes and models on the lot as a buyer types; the front page's search does too.
    suggest: { title: ['make', 'model'] },
    sort: [
      { label: 'Featured first', sort: 'featured desc, listed_on desc' },
      { label: 'Newest listings', sort: 'listed_on desc' },
      { label: 'Lowest price', sort: 'price' },
      { label: 'Highest price', sort: 'price desc' },
      { label: 'Lowest mileage', sort: 'mileage' },
      { label: 'Newest model year', sort: 'year desc' },
    ],
    empty: { title: 'No cars match every filter', description: 'Clear a filter or widen the price range to see more.' },
  }),
  // The dealers' picks, for the front page: the same for everyone.
  featured: listView('Featured', 'vehicle', {
    query: 'featured = true and for_sale',
    sort: 'listed_on desc',
    presentation: vehicleCard,
  }),
  // The newest arrivals, for the front page.
  arrivals: listView('Just arrived', 'vehicle', { query: 'listed', sort: 'listed_on desc', presentation: vehicleCard }),
  dealers: listView('Dealers', 'dealer', { icon: 'storefront', sort: 'name', presentation: dealerCard }),
  // Anyone may ask about a car; from a car's page the form already names it.
  inquire: commandForm('Ask about a car', 'inquireAboutVehicle', {
    public: true,
    description:
      'A test drive, a trade-in, financing or an offer: the desk replies, usually the same day. Forecourt is a demonstration, so nobody reads what is sent.',
    submitLabel: 'Send inquiry',
    done: { title: 'Inquiry sent', description: 'Keep this reference. Sign up to follow replies on your own inquiries.' },
    prefillable: ['stock_ref', 'topic', 'message'],
  }),

  /* ---------- an account's own ---------- */
  // The saved cars as the catalog draws a car: its photo, its name and price, read through the saved row.
  saved: listView('Saved cars', 'saved_vehicle', {
    icon: 'bookmark-simple',
    query: 'active = true',
    presentation: savedCard,
    sort: 'saved_at desc',
    filterBar: 'none',
    empty: {
      title: 'No saved cars yet',
      description: 'Press Save on a car’s page to keep it here and compare it with the others.',
      action: { label: 'Browse cars', to: 'vehicles' },
    },
  }),
  'my-inquiries': listView('My inquiries', 'inquiry', {
    icon: 'chat-circle',
    roles: ['shopper'],
    show: ['vehicle_id.title', 'stage', 'topic', 'received_at'],
    sort: 'received_at desc',
    filterBar: 'none',
    empty: {
      title: 'No inquiries yet',
      description: 'Message the dealer from a car’s page and the conversation is kept here.',
      action: { label: 'Browse cars', to: 'vehicles' },
    },
  }),

  /* ---------- the desk ---------- */
  desk: deskDashboard,
  // The open inquiries as lanes of their road: a card is dragged, or moved
  // from its menu, into a stage its verbs lead to, and the verb is the write.
  // Won and lost fold to strips; each lane says what its cards are worth.
  pipeline: listView('Pipeline', 'inquiry', {
    icon: 'kanban',
    roles: DESK,
    open: 'modal',
    query: 'closed_on is empty or closed_on = last 30 days',
    board: {
      by: 'stage',
      primary: 'name',
      category: 'topic',
      lines: ['stock_ref'],
      footer: [{ column: 'received_at', icon: 'clock' }, 'owner'],
      sum: 'deal_value',
      folded: ['won', 'lost'],
    },
    filters: ['owner', 'topic', 'channel'],
  }),
  inquiries: listView('Inquiries', 'inquiry', {
    icon: 'tray',
    roles: DESK,
    show: ['name', 'vehicle_id.title', 'stage', 'topic', 'channel', 'owner', 'deal_value', 'received_at'],
    filters: ['stage', 'topic', 'channel', 'owner', 'received_at'],
    totals: ['deal_value'],
    rowActions: true,
    tabs: [
      { segment: 'open', sort: 'received_at desc' },
      { segment: 'unassigned', sort: 'received_at' },
      { segment: 'won_inquiries', sort: 'closed_on desc' },
      { segment: 'lost_inquiries', sort: 'closed_on desc' },
      { label: 'All', sort: 'received_at desc' },
    ],
  }),
  // The lot, kept in place: a price, a badge, featured or sold is an edit in the grid.
  stock: listView('Stock', 'vehicle', {
    icon: 'stack',
    roles: DESK,
    show: ['stock_ref', 'title', 'status', 'price', 'was_price', 'mileage', 'days_on_lot', 'featured', 'highlight', 'dealer_id.name'],
    editable: ['price', 'was_price', 'status', 'featured', 'highlight', 'mileage'],
    filters: ['make', 'status', 'dealer_id', 'body_type', 'listed_on'],
    tabs: [
      { segment: 'for_sale', sort: 'listed_on desc' },
      { segment: 'over_30_days', sort: 'listed_on' },
      { segment: 'reserved', sort: 'listed_on' },
      { segment: 'sold', sort: 'sold_on desc' },
      { label: 'All', sort: 'listed_on desc' },
    ],
  }),
} satisfies Views;
