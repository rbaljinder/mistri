import { listView } from '@mistriwork/mistri/app';
import { dealerCard, programCard, vehicleCard } from './cards.ts';
import { keystoneLanding } from './landing.ts';
import type { Views } from './mistri-schema.d.ts';

/* The public catalog: cars, rates and dealers. A signed-out visitor reads all
   three; the account's own lists are in features/. auth.public opens whole
   tables (SUITE.md G7), so every list stands on what the public may be shown:
   a car listed or pending at a dealer Keystone is lending through today. */
const forSale = 'status in (listed, pending) and dealer_id.status = active';

export const views = {
  // The front page, signed out (landing.ts).
  welcome: keystoneLanding,
  // Every car for sale, as cards, narrowed from a rail on the left. The
  // address is the question: /marketplace/vehicles?make=Toyota,Honda&list_price=..25000&sort=-list_price.
  vehicles: listView('Cars for sale', 'vehicle', {
    icon: 'car',
    query: forSale,
    presentation: vehicleCard,
    filterBar: 'rail',
    filters: ['make', 'body', 'list_price', 'est_payment', 'mileage', 'year', 'fuel', 'condition', 'drivetrain', 'dealer_id'],
    // The dealers' own picks lead, then the newest listings.
    sort: [
      { label: 'Dealer picks first', sort: 'featured desc, listed_on desc' },
      { label: 'Newest listings', sort: 'listed_on desc' },
      { label: 'Lowest price', sort: 'list_price' },
      { label: 'Highest price', sort: 'list_price desc' },
      { label: 'Lowest monthly payment', sort: 'est_payment' },
      { label: 'Lowest mileage', sort: 'mileage' },
      { label: 'Newest model year', sort: 'year desc' },
    ],
    empty: { title: 'No cars match every filter', description: 'Clear a filter or widen the price range to see more.' },
  }),
  // The dealers' picks, for the front page: the same for everyone.
  featured: listView('Dealer picks', 'vehicle', {
    icon: 'star',
    query: `featured = true and ${forSale}`,
    sort: 'listed_on desc',
    presentation: vehicleCard,
  }),
  // Today's rates: the advertised programs, the lowest APR first.
  programs: listView('Rates', 'program', {
    icon: 'bank',
    query: 'advertised = true and active = true',
    sort: 'base_apr',
    presentation: programCard,
    // The one way a buyer narrows five rates: by the credit each is for.
    filters: ['tier'],
  }),
  dealers: listView('Dealers', 'dealer', {
    icon: 'storefront',
    query: 'status = active',
    sort: 'name',
    presentation: dealerCard,
    filters: ['state', 'kind', 'franchise_make'],
  }),
} satisfies Views;
