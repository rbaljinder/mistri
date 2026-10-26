import { expose } from '@mistriwork/mistri/app';
import type { App } from './mistri-schema.d.ts';

/* What a storefront or a carrier's system reaches with a manager's token:
   the catalog and what is on the shelves to read, a supplier's contact
   details to keep current, the dock's one verb (ship a pick list), and the
   feed of orders shipped. Nothing here is a second rule: a token runs as its
   role, so the API refuses what that role's screen would. */
export const api = {
  version: 1,
  roles: ['manager', 'admin'],
  description: "Depot's catalog, stock and shipments, for a storefront or a carrier integration.",
  resources: {
    product: expose(['id', 'sku', 'name', 'unit', 'reorder_point', 'status', 'specs'], { filters: ['sku', 'status'], sorts: ['sku'] }),
    stock_level: expose(['id', 'product_id', 'bin_id', 'warehouse_id', 'qty'], { filters: ['product_id', 'warehouse_id'], sorts: ['id'] }),
    supplier: expose(['id', 'name', 'contact', 'email', 'phone', 'lead_time_days'], { sorts: ['name'], update: true }),
    pick_list: expose(['id', 'reference', 'sales_order_id', 'status', 'carrier', 'tracking', 'version'], {
      filters: ['status'],
      sorts: ['id'],
    }),
  },
  commands: ['shipList'],
  events: ['order.shipped'],
} satisfies App['api'];
