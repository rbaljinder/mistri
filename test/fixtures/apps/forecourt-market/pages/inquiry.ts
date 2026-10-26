import { card, fields, header, page, stream, timeline } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';

/* One inquiry, as the desk works it: its road along the head with the next
   steps, then the conversation — the buyer's words, the desk's replies, its
   notes tinted as the desk's own and each step as one quiet line — read by
   day, oldest first, with the composer under it. Beside it the car and the
   buyer. A buyer reading their own inquiry sees the same thread without the
   notes (policy.ts), and no verbs. */
export const inquiryPage = page(
  'inquiry',
  [
    header({
      status: 'stage',
      actions: ['bookTestDrive', 'recordOffer', 'markSold', 'assignInquiry', 'logCall'],
      destructive: ['markLost'],
    }),
    timeline('Conversation', [stream('inquiry_message', 'inquiry_id', 'sent_at', 'body', { author: 'author', detail: 'kind' })], {
      newest: 'last',
      limit: 60,
      composer: { reply: 'replyToBuyer', note: 'addNote' },
      tone: { kind: { note: 'warn' } },
      compact: { kind: ['step'] },
    }),
    card('Car', 'vehicle_id', ['price', 'stock_ref']),
    fields(['name', 'email', 'phone'], { title: 'Buyer', region: 'aside' }),
    fields(['owner', 'topic', 'channel', 'deal_value', 'test_drive_at', 'received_at', 'reference', 'lost_reason'], {
      title: 'Details',
      region: 'aside',
    }),
  ],
  { listTabs: false },
) satisfies Page;
