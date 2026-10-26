import { custom, page, related } from '@mistriwork/mistri/app';
import { dealerMasthead } from '../components.ts';
import type { Page } from '../mistri-schema.d.ts';
import { vehicleCard } from '../vehicleCard.ts';

/* The dealership: who it is in its own colors (the masthead: its mark, name,
   tagline, where and when), then everything on its lot. The masthead is a
   custom component because the look is the App's, not the record's
   (SUITE.md G6): the brand colors are data on dealer_site. */
export const masthead = custom('', dealerMasthead, {
  record: ['name', 'street', 'city', 'state', 'zip', 'phone'],
  rows: {
    site: {
      from: 'dealer_site',
      whose: 'dealer_id',
      show: ['headline', 'tagline', 'about', 'brand_color', 'accent_color', 'logo_text', 'hours', 'contact_phone', 'contact_email'],
      limit: 1,
    },
  },
});

export const dealerPage = page('dealer', [
  masthead,
  related('On the lot', 'vehicle', 'dealer_id', {
    query: 'status in (listed, pending)',
    sort: 'featured desc, listed_on desc',
    limit: 12,
    presentation: vehicleCard,
  }),
]) satisfies Page;
