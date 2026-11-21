import { card, current, fields, header, page, related, today } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';

/* A deal in the record anatomy (mistri docs pages): its stage beside its
   name and whose deal it is, what it is worth and when it closes under it; the
   road it has travelled and what is quoted and logged against it; its quote,
   activity, tasks and the account's other deals as tabs; and beside them the
   account, what happens next and the deal's own fields to change. The road
   is the resource's machine: the stepper stands over the summary without
   being placed, and Lost is a way off the road, not a step on it. */
export default page(
  'opportunity',
  [
    header({ status: 'stage', facts: ['account_id', 'amount', 'close_date'] }),
    fields(['lines', 'units', 'activities', 'open_tasks']),
    related('Quote lines', 'opportunity_line', 'opportunity_id', {
      show: ['line_no', 'product_sku', 'qty', 'unit_price'],
      sort: 'line_no',
    }),
    related('Activity on this deal', 'activity', 'opportunity_id', {
      show: ['happened_on', 'subject', 'contact_id.name', 'kind'],
      sort: 'happened_on desc',
    }),
    // A task added here is this deal's, and its account's too.
    related('Open tasks', 'task', 'opportunity_id', {
      query: 'status = open',
      show: ['subject', 'due_on', 'owner_id.name', 'priority'],
      sort: 'due_on',
      create: {
        label: 'Add task',
        show: ['subject', 'owner_id', 'due_on'],
        defaults: { created_on: today },
        prefill: { account_id: 'account_id' },
      },
    }),
    related(
      'Other deals on this account',
      'opportunity',
      { same: ['account_id'] },
      {
        show: ['name', 'amount', 'close_date', 'stage'],
        sort: 'close_date desc',
      },
    ),
    card('Account', 'account_id', ['city', 'rating']),
    current('Next task', 'task', 'opportunity_id', {
      query: 'status = open',
      sort: 'due_on',
      show: ['due_on', 'owner_id', 'priority'],
      empty: { title: 'Nothing scheduled', description: 'No open task on this deal.' },
    }),
    fields(['account_id', 'owner_id', 'stage', 'amount', 'probability', 'close_date', 'created_on'], { title: 'Deal', region: 'aside' }),
  ],
  { listTabs: true },
) satisfies Page;
