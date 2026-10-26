import { navGroup } from '@mistriwork/mistri/app';
import type { Navigation } from './mistri-schema.d.ts';

/* The side menu in the order a day runs: the orders and the parcels they
   become first, then the catalog they are sold from, the stock behind it, and
   the customers and offers. A form room (New order) is drawn only for the
   roles granted its command. */
export const navigation = [
  { to: 'today', label: 'Today' },
  navGroup('selling', 'Selling', ['orders', 'new-order', 'fulfillment', 'returns', 'payments', 'refunds'], { icon: 'receipt' }),
  navGroup('catalog', 'Catalog', ['products', 'lookbook', 'variants', 'collections', 'tags'], { icon: 'tag' }),
  navGroup('stock', 'Stock', ['inventory', 'low-stock', 'movements', 'locations'], { icon: 'stack' }),
  navGroup('people', 'Marketing', ['customers', 'discounts'], { icon: 'users' }),
  { to: 'sales', label: 'Sales' },
] satisfies Navigation;
