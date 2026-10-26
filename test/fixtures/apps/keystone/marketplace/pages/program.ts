import { fields, headline, page } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';

/* One advertised program, at /marketplace/programs/1-keystone-select: what it
   lends, to whom and for how long, with the rate as the offer and the rate
   check one click away. */
export const programPage = page(
  'program',
  [
    fields(['tier', 'max_term', 'max_amount'], { title: 'At a glance', presentation: 'facts' }),
    headline('base_apr', {
      region: 'aside',
      note: 'The lowest APR this program offers. Yours depends on your credit, the car and the term.',
      links: [{ label: 'Check your rate', to: 'prequalify', open: 'modal' }],
    }),
    fields(['description'], { title: 'Who it is for' }),
    fields(['min_score', 'max_ltv_pct', 'max_vehicle_age', 'max_mileage'], {
      title: 'Who and what it can finance',
      presentation: 'table',
      columns: 2,
    }),
  ],
  { listTabs: false },
) satisfies Page;
