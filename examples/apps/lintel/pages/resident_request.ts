import { card, header, page, related, stream, timeline } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';

/* A repair as the resident who reported it reads it: its road, the conversation without the office's internal notes
   (policy.ts) and a way to write back, the parts that went into it and the home. Not a card about themselves, and not
   a history of changes: nothing there is theirs to act on. A conversation, as the office's page is (maintenance_request.ts): the
   thread last in the main column, the parts and the home beside it. */
export default page(
  'maintenance_request',
  [
    header({ status: 'status', facts: ['unit_id', 'priority', 'assigned_to', 'scheduled_on'], actions: ['messageOffice'] }),
    timeline('Conversation', [stream('request_note', 'request_id', 'sent_at', 'body', { author: 'author', detail: 'kind' })], {
      newest: 'last',
      limit: 60,
    }),
    related('Parts used', 'request_part', 'request_id', { region: 'aside', show: ['part_id', 'quantity'], sort: 'used_on', empty: 'hide' }),
    card('Home', 'unit_id', ['property_id', 'floor', 'bedrooms']),
  ],
  { layout: 'conversation', listTabs: false, roles: ['resident'] },
) satisfies Page;
