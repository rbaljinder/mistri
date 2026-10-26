import { fields, page, related } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';

/* One carrier, read from the API's item path (GET /carriers/{id}), and what
   it is moving. The shipments follow `shipments.carrier_id`, a reference the
   description declares, and are one more question the API documents:
   GET /shipments?carrier_id=…, its `carrier_id` filter. */
export const carrierPage = page(
  'carriers',
  [
    fields(['name', 'headquarters', 'phone', 'website', 'on_time_rate', 'active'], { columns: 3 }),
    related('Shipments', 'shipments', 'carrier_id', {
      show: ['tracking_number', 'status', 'destination_city', 'destination_state', 'eta'],
      limit: 10,
    }),
  ],
  { listTabs: false },
) satisfies Page;
