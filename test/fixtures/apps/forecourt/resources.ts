import type { Resources } from './mistri-schema.d.ts';

/* What Forecourt says about each resource, once, wherever its records
   appear: how values dress, what each caption reads, and at most what may
   be done. No role writes through ordinary routes. Visitors submit the
   public inquiry command; staff record replies and closure through commands
   that preserve history with each status change. */
export const resources = {
  vehicle: {
    // Saving a vehicle is an explicit account command; no local browser star.
    access: 'write',
    // A shared car reads as one: /forecourt/vehicles/1-2021-toyota-corolla on the public side.
    slug: true,
    display: {
      price: { format: 'money' },
      // The page's second figure: "Est. $242/mo", on the terms its note says.
      est_monthly: { format: 'money', unit: '/mo' },
      mileage: { unit: 'mi' },
      battery_health: { format: 'percent' },
      // One feature per line in the seed: a list on the page, a line on a card.
      features: { format: 'items' },
      status: { tone: { listed: 'good', reserved: 'warn', sold: 'neutral' } },
      listed_on: { format: 'relative' },
    },
    labels: {
      stock_ref: 'Stock number',
      body_type: 'Body',
      drivetrain: 'Drive',
      mileage: 'Miles',
      listed_on: 'Listed',
      est_monthly: 'Est.',
      'dealer_id.city': 'Location',
      'dealer_id.about': 'About the dealer',
    },
  },
  // The studio photos: the bytes in a BLOB beside their name, type and size,
  // and a 320-pixel copy the seed renders with each. A gallery and a card draw
  // them inline, through the file route; a card and the strip, the copy.
  vehicle_photo: {
    file: { content: 'data', name: 'file_name', type: 'content_type', size: 'byte_size', thumbnail: 'thumbnail' },
  },
  // The front page's studio scene: one row, the hero's photo.
  site_image: {
    file: { content: 'data', name: 'file_name', type: 'content_type', size: 'byte_size' },
  },
  dealer: {},
  // Account-owned rows: policy.ts confines every reader and command target to
  // its verified actor, while the archive keeps command receipts replayable.
  saved_vehicle: { access: 'write' },
  // The commands' ceiling. No role holds a generic write; only staff read
  // inquiries and their history, and only named commands change them.
  // Presentation and staff grants are in features/inquiries.ts.
  inquiry: { access: 'write' },
  inquiry_activity: { access: 'write' },
} satisfies Resources;
