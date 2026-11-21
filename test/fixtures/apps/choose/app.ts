/*
 * Choose: the browser gate's own App for an App-wide choice — a clinic's visits, narrowed to the site the person
 * works at (`chosen.site`). Owned by the test suite; see README.md.
 */
import { defineApp, listView } from '@mistriwork/mistri/app';

export default defineApp({
  id: 'choose',
  name: 'Choose',
  sources: { clinic: { connection: 'clinic' } },
  resources: { site: { noun: 'site' }, visit: { noun: 'visit' } },
  choose: { site: { from: 'site', label: 'name' } },
  auth: {
    providers: ['email'],
    defaultRole: 'staff',
    roles: { staff: { read: true, write: false } },
  },
  views: { visits: listView('Visits', 'visit', { show: ['note'], query: 'site_id = chosen.site' }) },
  home: 'visits',
  nav: ['visits'],
  ui: { currency: 'USD', locale: 'en-US', export: false },
});
