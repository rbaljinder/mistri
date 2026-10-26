import { action, commandForm, defineFeature, listView } from '@mistriwork/mistri/app';
import type { Feature } from '../mistri-schema.d.ts';
import { inquiryPage } from '../pages/inquiry.ts';

/** Public intake and staff follow-up belong together. The App keeps the
 * resource ceilings and roles; private handlers stay in commands.ts. */
export const inquiries = defineFeature({
  id: 'inquiries',
  resources: {
    inquiry: {
      segments: {
        new: 'status = new',
        replied: 'status = replied',
      },
      actions: {
        recordReply: action('Record reply', { command: 'recordInquiryReply' }),
        closeInquiry: action('Close inquiry', { command: 'closeInquiry' }),
      },
      display: {
        status: { tone: { new: 'info', replied: 'good', closed: 'neutral' } },
        received_at: { format: 'relative' },
      },
      labels: { stock_ref: 'Stock number', received_at: 'Received' },
    },
    inquiry_activity: { labels: { actor_id: 'Recorded by', recorded_at: 'Recorded' } },
  },
  auth: {
    roles: {
      staff: { commands: ['recordInquiryReply', 'closeInquiry'] },
      admin: { commands: ['recordInquiryReply', 'closeInquiry'] },
    },
  },
  views: {
    inquire: commandForm('Inquire about a vehicle', 'inquireAboutVehicle', {
      public: true,
      description:
        'Ask the dealer about a test drive, a trade-in or financing. From a car’s page the form already knows which car you mean. Forecourt is a demonstration: nobody reads what is sent.',
      submitLabel: 'Send inquiry',
      done: {
        title: 'Inquiry recorded',
        description: 'Keep this reference. This demonstration sends no messages; staff can use it to record follow-up.',
      },
      prefillable: ['stock_ref', 'message'],
    }),
    inquiries: listView('Inquiries', 'inquiry', {
      show: ['reference', 'stock_ref', 'vehicle_id.title', 'name', 'email', 'received_at', 'status'],
      tabs: ['new', 'replied', { label: 'All' }],
    }),
  },
  pages: { inquiry: inquiryPage },
} satisfies Feature);
