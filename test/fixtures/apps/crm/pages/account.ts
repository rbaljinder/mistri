import { chart, current, fields, header, page, related } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';

/* An account in the record anatomy (mistri docs pages): its rating beside
   its name and where it sits under it; what it is worth now and has been
   worth, and what is waiting on it; what it has bought, month by month; its
   people, deals, conversations, tasks and subsidiaries as tabs; and beside
   them the person to call, then the rest of what is known about it. */
export default page(
  'account',
  [
    header({ status: 'rating', facts: ['industry_id', 'city', 'country', 'owner_id'] }),
    fields(['open_deals', 'open_pipeline', 'won_value', 'open_tasks']),
    // The dashboard's bookings chart, narrowed to this account's won deals.
    chart('Bookings by month', 'opportunity', 'month close_date', {
      whose: 'account_id',
      query: 'stage = closed_won',
      measure: 'sum amount as won',
      height: 180,
    }),
    related('Contacts', 'contact', 'account_id', {
      show: ['name', 'title', 'email', 'is_primary'],
      sort: 'is_primary desc',
    }),
    related('Opportunities', 'opportunity', 'account_id', {
      show: ['name', 'amount', 'close_date', 'stage'],
      sort: 'close_date desc',
    }),
    related('Recent activity', 'activity', 'account_id', {
      show: ['happened_on', 'subject', 'contact_id.name', 'kind'],
      sort: 'happened_on desc',
    }),
    related('Open tasks', 'task', 'account_id', {
      query: 'status = open',
      show: ['subject', 'due_on', 'owner_id.name', 'priority'],
      sort: 'due_on',
    }),
    related('Subsidiaries', 'account', 'parent_account_id', {
      show: ['name', 'city', 'annual_revenue', 'rating'],
      empty: 'hide',
    }),
    current('Primary contact', 'contact', 'account_id', {
      query: 'is_primary = true',
      sort: 'created_on',
      show: ['title', 'email', 'phone'],
      empty: { title: 'No primary contact', description: "Mark one of the account's contacts as primary." },
    }),
    fields(['annual_revenue', 'employees', 'website', 'parent_account_id', 'created_on'], { title: 'Company', region: 'aside' }),
  ],
  { listTabs: true },
) satisfies Page;
