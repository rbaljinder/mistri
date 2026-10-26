import { card, fields, header, headline, page, related } from '@mistriwork/mistri/app';
import { vehicleCard } from '../cards.ts';
import type { Page } from '../mistri-schema.d.ts';

/* One car, as a buyer decides on it. The photos first and the facts in one
   line under them; beside them the offer — the price, the monthly figure and
   its terms — with the two things to do next, each opening its form over the
   car with the car already named. Then the car in full, and last the cars
   like it at every Keystone dealer. Signed in, the header adds Save, Send the
   dealer a question and Check my rate as the account's own commands. */
export const vehiclePage = page(
  'vehicle',
  [
    // Listed or sale pending beside the name. Signed in, the account's rate check is the forward verb: it keeps the estimate on the account.
    header({ status: 'status', primary: 'checkRate' }),
    related('Photos', 'vehicle_photo', 'vehicle_id', {
      presentation: 'gallery',
      show: ['caption'],
      sort: 'position',
      limit: 12,
      empty: 'hide',
    }),
    fields(['condition', 'mileage', 'body', 'drivetrain', 'fuel', 'exterior_color'], { title: 'Key facts', presentation: 'facts' }),
    headline('list_price', {
      region: 'aside',
      subfigure: 'est_payment',
      note: 'The dealer’s advertised payment at 72 months, before tax, title and registration. Your rate depends on your credit: check it in two minutes, with no credit pull.',
      links: [
        { label: 'Check your rate', to: 'prequalify', open: 'modal', prefill: { vehicle: 'id' } },
        {
          label: 'Contact the dealer',
          to: 'inquire',
          open: 'modal',
          prefill: { vehicle: 'id' },
          defaults: { message: 'Is this car still available? I would like to see it and take a test drive.' },
        },
      ],
    }),
    // Who sells it: the dealer's name opens its page and everything it has for sale.
    card('Sold by', 'dealer_id', ['city', 'phone']),
    fields(['description'], { title: 'From the dealer' }),
    // One feature a line in the database; the display rule lays them out as a list.
    fields(['features'], { title: 'Features' }),
    fields(
      ['year', 'make', 'model', 'trim', 'body', 'drivetrain', 'fuel', 'exterior_color', 'interior_color', 'mileage', 'stock_number', 'vin'],
      { title: 'Specifications', presentation: 'table', columns: 2 },
    ),
    /* The cars a buyer would weigh against this one, at any dealer: the same
     body style within a fifth of the price, the closest first. */
    related(
      'Similar cars at Keystone dealers',
      'vehicle',
      { same: ['body'], near: { list_price: 0.2 } },
      {
        query: 'status in (listed, pending) and dealer_id.status = active',
        limit: 4,
        presentation: vehicleCard,
      },
    ),
  ],
  { listTabs: false },
) satisfies Page;
