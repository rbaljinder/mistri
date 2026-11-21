import { navGroup } from '@mistriwork/mistri/app';
import type { Navigation } from './mistri-schema.d.ts';

/* The top menu: arrangement only. An entry names a view in views.ts, a
   free-form page by its path ('sales-dashboard' and 'leads' are
   pages/*.page.tsx, placed by their own `nav`), or 'assistant', the assistant's own room (app.ts). */
export const navigation = [
  navGroup('sales', 'Sales', ['pipeline-layout', 'opportunities', 'deals-by-stage', 'pipeline', 'accounts', 'account-tree', 'contacts'], {
    icon: 'chart-line',
  }),
  navGroup('activity', 'Activity', ['tasks', 'task-calendar', 'activities'], { icon: 'calendar-check' }),
  navGroup('marketing', 'Marketing', ['campaigns', 'campaign-schedule'], { icon: 'megaphone' }),
  navGroup('catalog', 'Catalog', ['products', 'sales-team'], { icon: 'package' }),
  'assistant',
] satisfies Navigation;
