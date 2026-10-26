import { card, header, history, page, related, stream, timeline } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';

/* One repair, as the office works it: its road along the head with the next
   steps, then the conversation — the resident's words, the office's replies,
   its internal notes tinted as its own — oldest first, with the composer under
   it and nothing after it, so a reply is always written at the end of the
   thread (layout: 'conversation'). Beside it, the parts used, which come off
   the storeroom's shelf as they are added, the home, the resident and the
   history. A resident reads their own repair on a page of their own
   (resident_request.ts). */
export default page(
  'maintenance_request',
  [
    header({
      status: 'status',
      facts: ['unit_id', 'priority', 'assigned_to', 'scheduled_on'],
      actions: ['scheduleVisit', 'completeRequest', 'messageOffice'],
    }),
    timeline('Conversation', [stream('request_note', 'request_id', 'sent_at', 'body', { author: 'author', detail: 'kind' })], {
      newest: 'last',
      limit: 60,
      composer: { reply: 'replyToResident', note: 'addNote' },
      tone: { kind: { internal: 'warn' } },
    }),
    related('Parts used', 'request_part', 'request_id', {
      region: 'aside',
      show: ['part_id', 'quantity'],
      sort: 'used_on',
      create: { label: 'Add part' },
      empty: 'hide',
    }),
    card('Home', 'unit_id', ['property_id', 'floor', 'bedrooms']),
    card('Resident', 'resident_id', ['phone', 'language']),
    history(),
  ],
  { layout: 'conversation', listTabs: false, roles: ['leasing', 'manager', 'admin', 'technician', 'accountant'] },
) satisfies Page;
