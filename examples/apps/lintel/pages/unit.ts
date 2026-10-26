import { fields, header, headline, page, related } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';
import { homeCard } from '../views.ts';

/* One home, as a visitor reads a listing and the office reads the rent roll:
   the building's photos large; beside them the asking rent and the way to see
   it, the viewing form opened over the page with this home's code already in
   it. Under them, at the page's full width, the facts, the words, and — for
   the office — who has lived here and what has been fixed. A showcase
   (layout: 'showcase') draws the price straight after the photos on a phone,
   not after every list. */
export default page(
  'unit',
  [
    header({ status: 'status', facts: ['property_id', 'available_on'] }),
    related('Photos', 'property_photo', { same: ['property_id'] }, { presentation: 'gallery', sort: 'position', limit: 6 }),
    headline('market_rent', {
      region: 'aside',
      subfigure: 'rent_per_sqft',
      note: 'Water, trash and recycling included. No application fee.',
      links: [
        { label: 'Ask for a viewing', to: 'request-viewing', open: 'modal', prefill: { code: 'code' } },
        // A resident's own report, in a dialog over their home; nobody who is not granted the command is offered it.
        { label: 'Report a problem', to: 'report', open: 'modal' },
      ],
    }),
    fields(['bedrooms', 'bathrooms', 'sqft', 'floor', 'code'], { title: 'The home', presentation: 'table', columns: 3 }),
    fields(['description'], { title: 'About it' }),
    related('Leases', 'lease', 'unit_id', {
      show: ['resident_id', 'start_on', 'end_on', 'status'],
      sort: 'start_on desc',
      limit: 6,
      empty: 'hide',
    }),
    related('Repairs', 'maintenance_request', 'unit_id', {
      show: ['title', 'status', 'reported_on'],
      sort: 'reported_on desc',
      limit: 6,
      empty: 'hide',
    }),
    related('More homes here', 'unit', { same: ['property_id'] }, { query: 'advertised', limit: 3, presentation: homeCard }),
  ],
  { layout: 'showcase', listTabs: false },
) satisfies Page;
