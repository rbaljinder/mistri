import { card, fields, header, page, related } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';

/* A contact in the record anatomy (mistri docs pages): what they do and
   where under their name; how much the team has talked to them and when last;
   their conversations, colleagues and the account's deals as tabs; and beside
   them the account they work for and their own fields to change. */
export default page(
  'contact',
  [
    header({ facts: ['title', 'account_id', 'email', 'phone'] }),
    fields(['conversations', 'minutes_logged', 'last_contacted']),
    related('Conversation history', 'activity', 'contact_id', {
      show: ['happened_on', 'subject', 'owner_id.name', 'kind'],
      sort: 'happened_on desc',
    }),
    related(
      'Colleagues at this account',
      'contact',
      { same: ['account_id'] },
      {
        show: ['name', 'title', 'email', 'is_primary'],
      },
    ),
    related(
      'Deals at this account',
      'opportunity',
      { same: ['account_id'] },
      { show: ['name', 'amount', 'close_date', 'stage'], sort: 'close_date desc' },
    ),
    card('Works at', 'account_id', ['city', 'rating']),
    fields(['title', 'email', 'phone', 'is_primary', 'owner_id', 'created_on'], { title: 'Contact', region: 'aside' }),
  ],
  { listTabs: true },
) satisfies Page;
