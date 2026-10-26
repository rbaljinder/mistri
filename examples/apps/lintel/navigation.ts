import { navGroup } from '@mistriwork/mistri/app';
import type { Navigation } from './mistri-schema.d.ts';

/* The side menu: arrangement only. Each reader sees the rooms their role
   opens — the office its morning, leasing, the books and the repairs; a
   technician their visits and the storeroom; a resident their home, charges
   and repairs; a visitor what is to let. */
export const navigation = [
  { to: 'today', label: 'Today' },
  { to: 'portal', label: 'Home' },
  'my-requests',
  'my-charges',
  'report',
  'listings',
  navGroup('leasing', 'Leasing', ['units', 'leases', 'occupancy', 'residents', 'viewings'], { icon: 'key' }),
  navGroup('books', 'Books', ['ledger', 'payments', 'post-rent'], { icon: 'receipt' }),
  navGroup('maintenance', 'Maintenance', ['my-repairs', 'repair-board', 'repairs', 'parts', 'deliveries'], { icon: 'wrench' }),
] satisfies Navigation;
