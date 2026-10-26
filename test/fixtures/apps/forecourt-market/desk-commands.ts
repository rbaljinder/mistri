// The sales desk's work on an inquiry. Its stage moves only through these
// commands (resources.ts holds the road), and every one leaves a line in the
// conversation in the same transaction, so the thread is the inquiry's whole
// story: what the buyer said, what the desk answered, what it noted and each
// step it took. Who acted comes from the verified session, never the form.
import { defineCommand, field, refuse, shape, text } from '@mistriwork/mistri/commands';
import { author, day, dollars, market, stamp } from './source.ts';

const said = shape({ message: text({ max: 300 }) });
const OPEN = 'stage != won and stage != lost';
/** The people who work the desk, as the seed and the board name them. */
export const DESK = ['Maya Chen', 'Luis Ortega', 'Jordan Blake', 'Priya Nair'] as const;

/* A line of the conversation, shown to the buyer unless it is a note. */
type Line = { kind: 'reply' | 'note' | 'step'; body: string };
type Inquiry = Readonly<Record<string, unknown>>;

/** The composer's Reply: the words the desk sent the buyer. The first answer moves a new inquiry to Contacted. */
export const replyToBuyer = defineCommand({
  source: market,
  target: 'inquiry',
  write: ['inquiry_message'],
  input: { body: field.textarea({ label: 'Reply', max: 4000 }) },
  when: OPEN,
  output: said,
  async handle({ db, record, actor, now }, input) {
    await line(db, record, actor, now, { kind: 'reply', body: input.body });
    await db.inquiry.update(record, {
      ...(record.stage === 'new' ? { stage: 'contacted', status: 'replied' } : {}),
      owner: record.owner ?? author(actor),
    });
    return { message: 'Reply sent.' };
  },
});

/** The composer's Internal note: for the desk alone. A buyer reading their own inquiry never sees one. */
export const addNote = defineCommand({
  source: market,
  target: 'inquiry',
  write: ['inquiry_message'],
  input: { body: field.textarea({ label: 'Note', max: 4000 }) },
  output: said,
  async handle({ db, record, actor, now }, input) {
    await line(db, record, actor, now, { kind: 'note', body: input.body });
    return { message: 'Note added.' };
  },
});

/** A call made or taken: the first touch on a new inquiry, by phone. */
export const logCall = defineCommand({
  source: market,
  target: 'inquiry',
  write: ['inquiry_message'],
  input: { summary: field.textarea({ label: 'What was said', max: 2000 }) },
  output: said,
  async handle({ db, record, actor, now }, input) {
    await line(db, record, actor, now, { kind: 'step', body: `Called the buyer. ${input.summary}` });
    await db.inquiry.update(record, { stage: 'contacted', status: 'replied', owner: record.owner ?? author(actor) });
    return { message: 'Call logged.' };
  },
});

export const bookTestDrive = defineCommand({
  source: market,
  target: 'inquiry',
  write: ['inquiry_message'],
  input: { at: field.datetime({ label: 'When' }) },
  output: said,
  async handle({ db, record, actor, now }, input) {
    if (Date.parse(input.at) < now().getTime()) refuse('A test drive is booked for a time still to come.');
    const when = new Date(input.at).toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/New_York',
    });
    await line(db, record, actor, now, { kind: 'step', body: `Test drive booked for ${when}.` });
    await db.inquiry.update(record, {
      stage: 'test_drive',
      status: 'replied',
      test_drive_at: input.at.slice(0, 19).replace('T', ' '),
      owner: record.owner ?? author(actor),
    });
    return { message: 'Test drive booked.' };
  },
});

export const recordOffer = defineCommand({
  source: market,
  target: 'inquiry',
  read: ['vehicle'],
  write: ['inquiry_message'],
  input: { amount: field.money({ label: 'Offer', min: 500, max: 500000 }) },
  async initial({ record }) {
    return record.deal_value ? { amount: Number(record.deal_value) } : {};
  },
  output: said,
  async handle({ db, record, actor, now }, input) {
    await line(db, record, actor, now, { kind: 'step', body: `Offer recorded at ${dollars(input.amount)}.` });
    await db.inquiry.update(record, { stage: 'negotiating', status: 'replied', deal_value: Math.round(input.amount) });
    return { message: 'Offer recorded.' };
  },
});

/**
 * The sale, agreed. The car itself is marked sold in Stock, where the lot is
 * kept: a table people edit in place is never also written by a command.
 */
export const markSold = defineCommand({
  source: market,
  target: 'inquiry',
  read: ['vehicle'],
  write: ['inquiry_message'],
  input: { price: field.money({ label: 'Sold at', min: 500, max: 500000 }) },
  async initial({ record }) {
    return record.deal_value ? { price: Number(record.deal_value) } : {};
  },
  output: said,
  async handle({ db, record, actor, now }, input) {
    await line(db, record, actor, now, { kind: 'step', body: `Sold at ${dollars(input.price)}.` });
    await db.inquiry.update(record, { stage: 'won', status: 'closed', deal_value: Math.round(input.price), closed_on: day(now) });
    return { message: 'Marked sold. Mark the car sold in Stock when it leaves the lot.' };
  },
});

const LOST = [
  { value: 'bought_elsewhere', label: 'Bought elsewhere' },
  { value: 'price', label: 'Price' },
  { value: 'financing', label: 'Financing fell through' },
  { value: 'no_response', label: 'No response' },
  { value: 'sold_to_another', label: 'Sold to another buyer' },
] as const;

export const markLost = defineCommand({
  source: market,
  target: 'inquiry',
  write: ['inquiry_message'],
  input: { reason: field.choice(LOST, { label: 'Why' }), note: field.textarea({ max: 1000, optional: true }) },
  output: said,
  async handle({ db, record, actor, now }, input) {
    const why = LOST.find((option) => option.value === input.reason)!.label;
    await line(db, record, actor, now, { kind: 'step', body: `Marked lost: ${why.toLowerCase()}.${input.note ? ` ${input.note}` : ''}` });
    await db.inquiry.update(record, { stage: 'lost', status: 'closed', lost_reason: input.reason, closed_on: day(now) });
    return { message: 'Marked lost.' };
  },
});

/** Hand an open inquiry to someone on the desk, a whole selection at once from the list. */
export const assignInquiry = defineCommand({
  source: market,
  target: 'inquiry',
  targets: 'many',
  write: ['inquiry_message'],
  input: { owner: field.choice(DESK) },
  when: OPEN,
  output: said,
  async handle({ db, records, actor, now }, input) {
    for (const record of records) {
      if (record.owner === input.owner) continue;
      await line(db, record, actor, now, { kind: 'step', body: `Assigned to ${input.owner}.` });
      await db.inquiry.update(record, { owner: input.owner });
    }
    return { message: records.length === 1 ? `Assigned to ${input.owner}.` : `${records.length} inquiries assigned to ${input.owner}.` };
  },
});

/* One line of the conversation, carrying the buyer's account so their own
   thread reads it back (policy.ts), dated now. */
async function line(
  db: { inquiry_message: { insert(row: Record<string, unknown>): Promise<unknown> } },
  inquiry: Inquiry,
  actor: { name?: string; email?: string },
  now: () => Date,
  { kind, body }: Line,
) {
  await db.inquiry_message.insert({
    inquiry_id: inquiry.id,
    kind,
    author: author(actor),
    body,
    sent_at: stamp(now),
    account_id: inquiry.account_id ?? null,
  });
}
