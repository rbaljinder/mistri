// Private staff operations. Each status change and its history entry commit
// together; account identity and timestamps come from the command context.
import { defineCommand, field, literal, shape } from '@mistriwork/mistri/commands';
import { market } from './market.ts';

export const recordInquiryReply = defineCommand({
  source: market,
  target: 'inquiry',
  read: ['vehicle'],
  write: ['inquiry_activity'],
  input: {
    note: field.textarea({
      label: 'Reply summary',
      max: 2000,
      help: 'Record the reply you already sent. This action does not send email.',
    }),
  },
  when: 'status in (new, replied)',
  output: shape({ message: literal('Reply recorded.') }),
  async handle({ db, record, actor, now }, input) {
    await db.inquiry.update(record, { status: 'replied' });
    await db.inquiry_activity.insert({
      inquiry_id: record.id,
      title: 'Reply recorded',
      note: input.note,
      actor_id: actor.id,
      recorded_at: now().toISOString(),
    });
    return { message: 'Reply recorded.' as const };
  },
});

export const closeInquiry = defineCommand({
  source: market,
  target: 'inquiry',
  read: ['vehicle'],
  write: ['inquiry_activity'],
  input: { note: field.textarea({ label: 'Resolution', max: 2000, help: 'Explain how this inquiry was resolved.' }) },
  when: 'status in (new, replied)',
  output: shape({ message: literal('Inquiry closed.') }),
  async handle({ db, record, actor, now }, input) {
    await db.inquiry.update(record, { status: 'closed' });
    await db.inquiry_activity.insert({
      inquiry_id: record.id,
      title: 'Inquiry closed',
      note: input.note,
      actor_id: actor.id,
      recorded_at: now().toISOString(),
    });
    return { message: 'Inquiry closed.' as const };
  },
});
