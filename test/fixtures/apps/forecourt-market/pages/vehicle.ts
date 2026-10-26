import { card, fields, headline, page, related } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';
import { vehicleCard } from '../cards.ts';

/* One car, as a buyer reads it. The photos large; beside them the offer —
   the price, what it would cost a month and on what terms, and the two ways
   to ask, each opening the inquiry form with this car already named — and
   who sells it. Under the photos, the facts in one line, then the car told
   in full: the dealer's words, its features, its specification and its
   history, every part in the open; and last, the cars like it. Staff see
   the questions asked about it and add photos; the public does neither. */
export const vehiclePage = page(
  'vehicle',
  [
    /* The photos large, for everyone. The Add photo is the desk's: a reader
       who may not write photos is drawn the same gallery without it, and the
       server refuses their upload as policy.ts refuses any insert. */
    related('Photos', 'vehicle_photo', 'vehicle_id', {
      presentation: 'gallery',
      show: ['caption'],
      sort: 'position',
      limit: 12,
      // A photo the desk adds goes after the lot's own, and is captioned later.
      create: { label: 'Add photo', defaults: { position: 99, caption: '' } },
    }),
    fields(['mileage', 'body_type', 'fuel', 'drivetrain', 'transmission', 'dealer_id.city'], {
      title: 'Key facts',
      presentation: 'table',
      columns: 3,
    }),
    // The price, and the price it was struck through beside it when it has come down.
    headline('price', {
      region: 'aside',
      was: 'was_price',
      subfigure: 'est_monthly',
      note: 'Estimated at 10% down over 60 months at 7.9% APR, before tax, title and registration. Your rate depends on your credit.',
      /* Both open over the car rather than leaving for the form's page: the
         price, the photographs and the mileage are the reason anyone is
         filling one in, and the address still opens the form on its own. */
      links: [
        { label: 'Ask about this car', to: 'inquire', open: 'modal', prefill: { stock_ref: 'stock_ref' } },
        {
          label: 'Book a test drive',
          to: 'inquire',
          intent: 'secondary',
          open: 'modal',
          prefill: { stock_ref: 'stock_ref' },
          defaults: { topic: 'test_drive', message: 'I would like to test drive this car. These days and times suit me:' },
        },
      ],
    }),
    card('Sold by', 'dealer_id', ['rating', 'city', 'phone']),
    fields(['description'], { title: 'Overview' }),
    fields(['features'], { title: 'Features' }),
    fields(
      [
        'make',
        'model',
        'trim',
        'year',
        'body_type',
        'engine',
        'horsepower',
        'transmission',
        'drivetrain',
        'fuel',
        'mpg_city',
        'mpg_highway',
        'range_mi',
        'battery_health',
        'color',
        'interior',
        'doors',
        'seats',
      ],
      { title: 'Specifications', presentation: 'table', columns: 2 },
    ),
    // An electric car's battery reads in the specification; the sheet leaves out a row the car does not have.
    fields(['owners', 'service_records', 'keys', 'mileage', 'vin', 'listed_on', 'stock_ref'], {
      title: 'History',
      presentation: 'table',
      columns: 2,
    }),
    // The desk's alone: who has asked about this car. A reader who may not read inquiries is not drawn it.
    related('Inquiries', 'inquiry', 'vehicle_id', {
      show: ['name', 'stage', 'owner', 'received_at'],
      sort: 'received_at desc',
      limit: 8,
      empty: 'hide',
    }),
    /* The cars a buyer would weigh against this one, not yet sold: the same
       body, within a quarter of its price either way, the closest first. */
    related(
      'Similar cars',
      'vehicle',
      { same: ['body_type'], near: { price: 0.25 } },
      { query: 'for_sale', limit: 4, presentation: vehicleCard },
    ),
  ],
  { listTabs: false },
) satisfies Page;
