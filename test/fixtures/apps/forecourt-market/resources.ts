import { action, computed, machine } from '@mistriwork/mistri/app';
import type { Resources } from './mistri-schema.d.ts';

/* What Forecourt says about each table, once, wherever its records appear:
   how values dress, what each caption reads, the verbs a record offers and,
   for an inquiry, the road it travels. Who may do what is app.ts's. */

/* An inquiry's road, in order: a question, a first answer, a test drive, an
   offer, and a sale — or lost, a way off it from any open stage. Every verb
   is a command (desk-commands.ts) that writes its line in the conversation;
   the board's lanes and the page's stepper read this order. The composer's
   Reply moves a new inquiry to Contacted along the same edge a call does. */
const markLost = 'lost' as const;

export const resources = {
  vehicle: {
    segments: {
      listed: 'status = listed',
      for_sale: 'status != sold',
      over_30_days: 'status = listed and days_on_lot > 30',
      reserved: 'status = reserved',
      sold: 'status = sold',
    },
    access: 'write',
    // A shared car reads as one: /vehicles/12-2023-honda-cr-v-ex-l.
    slug: true,
    favorite: true,
    computed: { days_on_lot: computed.number('today - listed_on') },
    display: {
      // The page's second figure: "$389/mo", on the terms its note says.
      est_monthly: { format: 'money', unit: '/mo' },
      horsepower: { unit: 'hp' },
      mpg_city: { unit: 'mpg' },
      mpg_highway: { unit: 'mpg' },
      range_mi: { unit: 'mi' },
      days_on_lot: { unit: 'days' },
      battery_health: { format: 'percent', ring: true },
      // One feature per line in the seed: a list on the page.
      features: { format: 'items' },
      status: { tone: { listed: 'good', reserved: 'warn', sold: 'neutral' }, values: { listed: 'For sale' } },
      listed_on: { format: 'relative' },
    },
    labels: {
      title: 'Car',
      stock_ref: 'Stock number',
      body_type: 'Body',
      drivetrain: 'Drive',
      mileage: 'Miles',
      est_monthly: 'Est.',
      // A reduction says what it was, struck through in words: "Was $24,495".
      was_price: 'Was',
      vin: 'VIN',
      mpg_city: 'City',
      mpg_highway: 'Highway',
      range_mi: 'Range',
      horsepower: 'Power',
      color: 'Exterior',
      days_on_lot: 'On the lot',
      highlight: 'Badge',
      'dealer_id.city': 'Location',
    },
    actions: {
      // Explicit account commands: nothing is kept in the browser alone.
      saveVehicle: action('Save', { command: 'saveVehicle' }),
      sendAccountInquiry: action('Message the dealer', { command: 'sendVehicleInquiry' }),
    },
  },
  // The photos: the bytes in a BLOB beside their name, type and size,
  // with a 320-pixel copy a card and the gallery strip draw.
  vehicle_photo: {
    access: 'write',
    delete: true,
    noun: 'photo',
    file: { content: 'data', name: 'file_name', type: 'content_type', size: 'byte_size', thumbnail: 'thumbnail', maxBytes: 8_000_000 },
    labels: { position: 'Order', file_name: 'File', byte_size: 'Size' },
  },
  // The front page's scene: one row, the hero's photo.
  site_image: {
    file: { content: 'data', name: 'file_name', type: 'content_type', size: 'byte_size' },
  },
  dealer: {
    display: { rating: { format: 'rating', outOf: 5 }, reviews: { format: 'number' } },
    labels: { name: 'Dealer', about: 'About the dealer' },
  },
  saved_vehicle: {
    access: 'write',
    recordLabel: 'vehicle_id.title',
    noun: { one: 'saved car', many: 'saved cars' },
    display: { saved_at: { format: 'relative' } },
    actions: { removeSaved: action('Remove', { command: 'removeSavedVehicle' }) },
  },
  inquiry: {
    segments: {
      open: 'stage != won and stage != lost',
      unassigned: 'owner is empty and stage != won and stage != lost',
      won_inquiries: { query: 'stage = won', label: 'Won' },
      lost_inquiries: { query: 'stage = lost', label: 'Lost' },
    },
    access: 'write',
    display: {
      stage: {
        tone: { new: 'info', contacted: 'neutral', test_drive: 'neutral', negotiating: 'warn', won: 'good', lost: 'bad' },
        icons: {
          new: 'envelope',
          contacted: 'chat-circle',
          test_drive: 'car',
          negotiating: 'handshake',
          won: 'check-circle',
          lost: 'x-circle',
        },
      },
      topic: {
        values: { trade_in: 'Trade-in', price: 'Offer' },
        colors: { availability: 1, test_drive: 2, trade_in: 3, financing: 4, price: 5 },
      },
      channel: { values: { web: 'Website', walk_in: 'Walk-in' } },
      lost_reason: { values: { sold_to_another: 'Sold to another buyer' } },
      // Who owns it, as a face: the board's footer and the list's column.
      owner: { format: 'avatars' },
      received_at: { format: 'relative' },
    },
    labels: {
      stock_ref: 'Stock number',
      'vehicle_id.price': 'Asking',
      deal_value: 'Value',
      lost_reason: 'Lost because',
    },
    machine: machine('stage', {
      new: { on: { replyToBuyer: 'contacted', logCall: 'contacted', bookTestDrive: 'test_drive', markLost } },
      contacted: { on: { replyToBuyer: 'contacted', bookTestDrive: 'test_drive', recordOffer: 'negotiating', markLost } },
      test_drive: { on: { replyToBuyer: 'test_drive', recordOffer: 'negotiating', markLost } },
      negotiating: { on: { replyToBuyer: 'negotiating', markSold: 'won', markLost } },
      won: { final: true },
      lost: { final: true },
    }),
    actions: {
      addNote: action('Add note', { command: 'addNote' }),
      assignInquiry: action('Assign', { command: 'assignInquiry' }),
    },
  },
  // Written only by the commands, every line in the transaction of the step it records.
  inquiry_message: {
    access: 'write',
    noun: 'message',
    display: { kind: { tone: { note: 'warn', step: 'neutral', reply: 'info', buyer: 'neutral' } } },
  },
} satisfies Resources;
