import { fields, page, related } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';
import { vehicleCard } from '../vehicleCard.ts';

/* A dealer: who they are and where, and what they have for sale now, as the
   marketplace's own cards. */
export const dealerPage = page('dealer', [
  fields(['name', 'city', 'phone', 'about'], { columns: 2 }),
  related('For sale', 'vehicle', 'dealer_id', {
    query: 'status != sold',
    sort: 'listed_on desc',
    limit: 12,
    presentation: vehicleCard,
  }),
]) satisfies Page;
