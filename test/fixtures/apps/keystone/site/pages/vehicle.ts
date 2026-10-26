import { card, fields, headline, page, related } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';
import { vehicleCard } from '../vehicleCard.ts';

/* One car, as a buyer decides on it: the photos and the facts in one line;
   beside them the offer (the price, whether it is still for sale) with a test
   drive and a question, and the monthly figure with its terms and the
   application — each form opening with the stock number filled in; then the
   car in full, and the cars like it on this lot. A headline takes at most two
   actions, so the three ways forward are two cards, as a dealer's own site
   splits price and payment. */
export const vehiclePage = page(
  'vehicle',
  [
    related('Photos', 'vehicle_photo', 'vehicle_id', { presentation: 'gallery', show: ['caption'], sort: 'position', limit: 12 }),
    fields(['condition', 'year', 'mileage', 'drivetrain', 'fuel', 'exterior_color'], { title: 'Key facts', presentation: 'facts' }),
    // The offer: the price and the two ways to see the car, opening their forms over it with the stock number filled in.
    headline('list_price', {
      region: 'aside',
      subfigure: 'status',
      links: [
        { label: 'Schedule a test drive', to: 'test-drive', open: 'modal', prefill: { stock_number: 'stock_number' } },
        { label: 'Ask about this car', to: 'ask', open: 'modal', prefill: { stock_number: 'stock_number' }, intent: 'secondary' },
      ],
    }),
    // The payment, the way a finance office says it, and the way to it.
    headline('est_payment', {
      title: 'Financing',
      region: 'aside',
      note: 'Estimated at 72 months with 10% down through Keystone Auto Finance, before tax, title and registration. Your rate depends on your credit.',
      links: [{ label: 'Apply for financing', to: 'apply', prefill: { stock_number: 'stock_number' } }],
    }),
    card('Sold by', 'dealer_id', ['street', 'phone']),
    fields(['description'], { title: 'About this car' }),
    fields(['features'], { title: 'Features' }),
    fields(
      ['year', 'make', 'model', 'trim', 'body', 'drivetrain', 'fuel', 'exterior_color', 'interior_color', 'mileage', 'vin', 'stock_number'],
      { title: 'Specifications', presentation: 'table', columns: 2 },
    ),
    // The same body on the same lot, within a quarter of the price either way.
    related(
      'More like this',
      'vehicle',
      { same: ['body', 'dealer_id'], near: { list_price: 0.25 } },
      {
        query: 'status in (listed, pending)',
        limit: 2,
        presentation: vehicleCard,
      },
    ),
  ],
  { listTabs: false },
) satisfies Page;
