import { navGroup } from '@mistriwork/mistri/app';
import type { Navigation } from './mistri-schema.d.ts';

/* The top menu: arrangement only. Every entry names a view in views.ts — or
   'assistant', the assistant's own room (app.ts) — and a group's icon marks
   its button in the top bar, beside its views' own. */
export const navigation = [
  navGroup(
    'sales',
    'Sales',
    ['sales-dashboard', 'pipeline-layout', 'leads', 'opportunities', 'pipeline', 'accounts', 'account-tree', 'contacts'],
    {
      icon: 'chart-line',
    },
  ),
  navGroup('activity', 'Activity', ['tasks', 'task-calendar', 'activities'], { icon: 'calendar-check' }),
  navGroup('marketing', 'Marketing', ['campaigns', 'campaign-schedule'], { icon: 'megaphone' }),
  navGroup('catalog', 'Catalog', ['products', 'sales-team'], { icon: 'package' }),
  'assistant',
] satisfies Navigation;
