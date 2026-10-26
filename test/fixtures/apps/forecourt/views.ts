import { listView } from '@mistriwork/mistri/app';
import type { Views } from './mistri-schema.d.ts';
import { forecourtLanding } from './landing.ts';

import { vehicleCard } from './vehicleCard.ts';

/* The public catalog; features/inquiries.ts adds intake and staff follow-up. */
export const views = {
  // The front page, signed out (landing.ts).
  welcome: forecourtLanding,
  // The marketplace: every vehicle not yet sold, as cards. The filters are
  // the list's own, and the landing's search writes the same conditions.
  vehicles: listView('Vehicles', 'vehicle', {
    query: 'status != sold',
    presentation: vehicleCard,
    // The marketplace itself is worth keeping to hand, and so is a car.
    favorite: true,
    tabs: [{ label: 'All' }, 'hybrid_and_electric', 'suvs', 'under_10_000'],
    // A buyer narrows by ticking and bounding, so the filters are a rail on the
    // left of the cards: a make or a body is a checklist with its counts, a price
    // or the miles a Min/Max range, the model year a checklist of the years.
    filterBar: 'rail',
    filters: ['make', 'model', 'body_type', 'price', 'year', 'mileage', 'fuel', 'transmission'],
    // The orders a buyer asks for, by name: newest listings first, the order a buyer
    // coming back expects, until another is chosen, which is then the address's `sort`.
    sort: [
      { label: 'Newest listings', sort: 'listed_on desc' },
      { label: 'Lowest price', sort: 'price' },
      { label: 'Highest price', sort: 'price desc' },
      { label: 'Lowest mileage', sort: 'mileage' },
      { label: 'Newest model year', sort: 'year desc' },
    ],
  }),
  // The dealers' picks, for the front page: an honest query, the same for
  // everyone — featured and not yet sold — with no personalization.
  recommended: listView('Recommended', 'vehicle', {
    query: 'featured = true and status != sold',
    presentation: vehicleCard,
  }),
  dealers: listView('Dealers', 'dealer', { show: ['name', 'city', 'phone'] }),
} satisfies Views;
