import { fields, header, history, page, related } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';

/* A car as its dealer prices it: the photos, the facts a buyer reads, and
   the listing's words, edited in place; the leads it brought in; and
   beside them the price, the flag that puts it on the front page, and
   what it cost. The forward verb follows the state: List for sale. */
export const vehiclePage = page('vehicle', [
  header({
    status: 'status',
    facts: ['stock_number', 'mileage', { column: 'listed_on', before: 'Listed' }],
  }),
  related('Photos', 'vehicle_photo', 'vehicle_id', {
    presentation: 'gallery',
    show: ['caption'],
    sort: 'position',
    limit: 6,
    empty: 'hide',
  }),
  fields(['body', 'fuel', 'drivetrain', 'condition', 'exterior_color', 'interior_color', 'vin'], { presentation: 'facts' }),
  fields(['description', 'features'], { title: 'The listing', columns: 1 }),
  related('Leads on this car', 'lead', 'vehicle_id', {
    show: ['reference', 'source', 'created_at', 'status'],
    query: 'status != draft',
    sort: 'created_at desc',
    limit: 10,
    empty: { title: 'No leads yet', description: 'Inquiries and applications that name this car are listed here.' },
  }),
  fields(['list_price', 'featured', 'est_payment', 'cost'], { title: 'Price', region: 'aside' }),
  fields(['received_on', 'sold_on'], { title: 'On the lot', region: 'aside' }),
  history(undefined, { limit: 6 }),
]) satisfies Page;
