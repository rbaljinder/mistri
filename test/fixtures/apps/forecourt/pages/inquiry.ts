import { fields, page, stream, timeline } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';

export const inquiryPage = page('inquiry', [
  fields(['reference', 'status', 'received_at'], { columns: 3 }),
  fields(['name', 'email', 'phone'], { title: 'Contact', columns: 3 }),
  fields(['stock_ref', 'vehicle_id', 'message'], { title: 'Inquiry', columns: 1 }),
  timeline('Follow-up history', [stream('inquiry_activity', 'inquiry_id', 'recorded_at', 'title', { detail: 'note' })], { limit: 20 }),
]) satisfies Page;
