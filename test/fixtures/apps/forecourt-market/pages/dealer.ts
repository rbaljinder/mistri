import { fields, page, related } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';
import { vehicleCard } from '../cards.ts';

/* A dealer: who they are, how buyers rate them, and what they have for sale now. */
export const dealerPage = page(
  'dealer',
  [
    fields(['city', 'rating', 'reviews', 'phone'], { presentation: 'facts' }),
    fields(['about'], { title: 'About' }),
    related('For sale', 'vehicle', 'dealer_id', { query: 'for_sale', sort: 'listed_on desc', limit: 12, presentation: vehicleCard }),
  ],
  { listTabs: false },
) satisfies Page;
