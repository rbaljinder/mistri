import { action, card, defineFeature, fields, header, listView, page } from '@mistriwork/mistri/app';
import type { Feature, Page } from '../mistri-schema.d.ts';

/** Signed in, an inquiry is about the car the customer is looking at: the car
 * is the target, so nobody types a listing code, and the lead it writes carries
 * the verified account so the customer can follow it (server/inquiry.ts). */

const inquiryPage = page(
  'lead',
  [
    header({
      status: 'status',
      facts: [{ column: 'created_at', before: 'Sent' }, 'dealer_id.name', { column: 'last_contact_at', before: 'Dealer last replied' }],
    }),
    card('The car', 'vehicle_id', ['list_price', 'est_payment'], { region: 'main' }),
    fields(['message'], { title: 'Your message' }),
    card('The dealer', 'dealer_id', ['name', 'city', 'phone']),
  ],
  { listTabs: false },
) satisfies Page;

export const inquiries = defineFeature({
  id: 'inquiries',
  resources: {
    vehicle: {
      actions: {
        sendInquiry: action('Send the dealer a question', { command: 'sendInquiry' }),
      },
    },
  },
  auth: {
    roles: {
      customer: {
        read: ['lead'],
        commands: ['sendInquiry'],
        // The customer's own lead, as far as it is theirs: the car, the dealer, where it stands and when.
        fields: { lead: { read: ['id', 'reference', 'vehicle_id', 'dealer_id', 'status', 'message', 'created_at', 'last_contact_at'] } },
      },
      marketplace_admin: {
        read: ['lead'],
        commands: ['sendInquiry'],
        // The desk sees who the marketplace sent a dealer and where it stands; the apply form's resume columns are the server's.
        fields: {
          lead: {
            read: [
              'id',
              'reference',
              'dealer_id',
              'source',
              'status',
              'first_name',
              'last_name',
              'email',
              'phone',
              'vehicle_id',
              'message',
              'marketplace_account_id',
              'created_at',
              'last_contact_at',
              'next_follow_up_on',
              'lost_reason',
            ],
          },
        },
      },
    },
  },
  views: {
    inquiries: listView('Your inquiries', 'lead', {
      icon: 'chat-circle',
      sort: 'created_at desc',
      show: ['vehicle_id', 'dealer_id.name', 'reference', 'created_at', 'status'],
      empty: {
        title: 'No inquiries yet',
        description: 'Ask a dealer about a car from its page, and follow the answer here.',
        action: { label: 'Browse cars for sale', to: 'vehicles' },
      },
    }),
  },
  pages: { inquiry: inquiryPage },
} satisfies Feature);
