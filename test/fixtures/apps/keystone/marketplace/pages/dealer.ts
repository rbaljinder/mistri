import { fields, header, page, related } from '@mistriwork/mistri/app';
import { lotCard } from '../cards.ts';
import type { Page } from '../mistri-schema.d.ts';

/* A dealer: who they are and where, and every car they have for sale, as the
   marketplace's own cards. */
export const dealerPage = page(
  'dealer',
  [
    header({ facts: ['kind', 'franchise_make', 'city', 'phone'] }),
    fields(['for_sale', 'from_price', 'joined_on']),
    related('For sale', 'vehicle', 'dealer_id', {
      query: 'status in (listed, pending)',
      sort: 'featured desc, listed_on desc',
      limit: 12,
      presentation: lotCard,
    }),
    fields(['street', 'city', 'state', 'zip', 'phone'], { title: 'Visit', region: 'aside' }),
  ],
  { listTabs: false },
) satisfies Page;
