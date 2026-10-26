import { navGroup } from '@mistriwork/mistri/app';
import type { Navigation } from './mistri-schema.d.ts';

/* The side menu, in the order a day runs: the floor's queues first, then the
   orders they come from, the stock they move, and the buying that refills it.
   A form room (Release, Start a count, New purchase order) is drawn only for
   the roles granted its command; the pick walk places itself (pages/). Setup sits in the sidebar's footer. */
export const navigation = [
  { to: 'operations', label: 'Today' },
  navGroup('floor', 'Floor', ['pick-lists', 'receiving', 'count-sheet'], { icon: 'package' }),
  navGroup('sales', 'Orders', ['orders', 'release', 'customers'], { icon: 'shopping-cart' }),
  navGroup('inventory', 'Inventory', ['products', 'catalog', 'stock', 'movements', 'cycle-counts', 'start-count'], {
    icon: 'stack',
  }),
  navGroup('buying', 'Purchasing', ['purchasing', 'purchase-orders', 'new-purchase-order', 'suppliers'], { icon: 'receipt' }),
  // The places a manager sets up, kept at the foot of the sidebar: where stock lives, and the flows orders run.
  navGroup('setup', 'Setup', ['warehouses', 'bins', 'po-flows'], { icon: 'gear', placement: 'footer' }),
] satisfies Navigation;
