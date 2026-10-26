import { card, fields, headline, page, related } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';
import { vehicleCard } from '../vehicleCard.ts';

/* One vehicle, as a buyer reads it. Beside the photos, the offer: the price,
   what it would cost a month and on what terms, and the two ways to ask —
   each opening the inquiry form with this car already named, so nobody
   copies a stock number by hand. Under the photos, the facts in one line;
   then the car told in full — the dealer's words, its features, its specs,
   its history — every part in the open, nothing to unfold; and last, the
   cars like it. */
export const vehiclePage = page(
  'vehicle',
  [
    // The photos as a gallery: a lead image with its steps and counter, thumbnails, each opening the lightbox.
    related('Photos', 'vehicle_photo', 'vehicle_id', { presentation: 'gallery', show: ['caption'], sort: 'position', limit: 12 }),
    // The facts a buyer scans first, in one line under the photos.
    fields(['year', 'mileage', 'fuel', 'transmission', 'drivetrain', 'dealer_id.city'], { title: 'Key facts', presentation: 'facts' }),
    // The offer, in the side panel, where a headline draws as a card.
    headline('price', {
      region: 'aside',
      subfigure: 'est_monthly',
      note: 'Estimated at 10% down and 60 months at 7.9% APR, before tax, title and registration. Your rate depends on your credit.',
      links: [
        { label: 'Inquire about this car', to: 'inquire', open: 'modal', prefill: { stock_ref: 'stock_ref' } },
        {
          label: 'Schedule a test drive',
          to: 'inquire',
          open: 'modal',
          prefill: { stock_ref: 'stock_ref' },
          defaults: { message: 'I would like to schedule a test drive. These days and times suit me:' },
        },
      ],
    }),
    // Who sells it: the dealer's name opens the dealer's page and everything it has for sale.
    card('Sold by', 'dealer_id', ['city', 'phone']),
    fields(['description'], { title: 'Overview' }),
    // One feature per line in the database; the display rule lays them out as a list.
    fields(['features'], { title: 'Features' }),
    fields(['make', 'model', 'trim', 'year', 'body_type', 'color', 'engine', 'drivetrain', 'transmission', 'fuel', 'doors', 'seats'], {
      title: 'Specs',
      presentation: 'table',
      columns: 2,
    }),
    // Battery health is an electric car's alone; the sheet leaves out a row the car does not have.
    fields(['owners', 'service_records', 'keys', 'battery_health', 'mileage', 'listed_on', 'stock_ref'], {
      title: 'History',
      presentation: 'table',
      columns: 2,
    }),
    /* The cars a buyer would weigh against this one, not yet sold: the same body
     type, within a quarter of its price either way, the closest price first.
     The dealer's other cars are one step away, through "Sold by". */
    related(
      'Similar vehicles',
      'vehicle',
      { same: ['body_type'], near: { price: 0.25 } },
      {
        query: 'status != sold',
        limit: 4,
        presentation: vehicleCard,
      },
    ),
  ],
  { listTabs: false },
) satisfies Page;
