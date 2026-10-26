import { page, fields } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';

/* One shipment, read from the API's item path (GET /shipments/{tracking_number}). */
export const shipmentPage = page(
  'shipments',
  [
    fields(['tracking_number', 'status', 'carrier_id', 'service'], { columns: 2 }),
    fields(['origin_city', 'origin_state', 'destination_city', 'destination_state'], { title: 'Route', columns: 2, width: 'half' }),
    fields(['shipped_at', 'eta', 'delivered_at', 'signed_by', 'exception_reason'], { title: 'Delivery', columns: 1, width: 'half' }),
    // What the package is, beside where it is going.
    fields(['weight_lb', 'declared_value'], { presentation: 'summary', columns: 1, region: 'aside' }),
  ],
  { listTabs: false },
) satisfies Page;
