import { randomUUID } from 'node:crypto';
import {
  defineCommand,
  defineCommands,
  defineSource,
  literal,
  publicReference,
  publicReferencePattern,
  refuse,
  shape,
  text,
} from '@mistriwork/mistri/commands';
import type { Rows } from './schema.ts';

const source = defineSource<Rows>('business');

/** A clinic's own command: the appointment's payment, recorded, and the appointment marked paid in one transaction. */
export const recordPayment = defineCommand({
  source,
  target: 'appointment',
  read: ['appointment', 'payment', 'patient'],
  write: ['appointment', 'payment'],
  input: {
    amount_cents: { label: 'Amount (cents)', type: 'number', min: 1 },
    method: {
      label: 'Method',
      type: 'choice',
      options: [
        { value: 'card', label: 'Card' },
        { value: 'cash', label: 'Cash' },
      ],
    },
  },
  output: shape({ payment: text(), message: literal('Payment recorded.') }),
  async handle({ db, record }, value) {
    if (record.status !== 'booked') refuse(`This appointment is ${record.status}.`);
    const id = `pay-${randomUUID()}`;
    await db.payment.insert({ id, appointment_id: record.id, amount_cents: value.amount_cents, method: value.method });
    await db.appointment.update(record, { status: 'paid' });
    return { payment: id, message: 'Payment recorded.' as const };
  },
});

/** The platform's notice into one clinic, shaped as the tenant docs' seedDesk: the clinic it acts in is an input. */
export const postNotice = defineCommand({
  realm: 'platform',
  tenant: 'clinic_id',
  source,
  target: 'notice',
  targets: 'none',
  // A notice's clinic_id references clinic: a write proves the row it points at is readable.
  read: ['clinic'],
  input: { clinic_id: { label: 'Clinic', type: 'text' }, body: { label: 'Notice', type: 'text', max: 200 } },
  output: shape({ message: literal('Notice posted.') }),
  async handle({ db }, value) {
    await db.notice.insert({ id: `nt-${randomUUID()}`, body: value.body });
    return { message: 'Notice posted.' as const };
  },
});

/** A visitor's request: in the clinic whose intake address the form was opened with, else with the platform. */
export const requestVisit = defineCommand({
  source,
  target: 'visit_request',
  targets: 'none',
  public: true,
  write: ['visit_request', 'triage'],
  input: {
    name: { label: 'Name', type: 'text', max: 80 },
    phone: { label: 'Phone', type: 'text', max: 40 },
    note: { label: 'Note', type: 'text', max: 200, optional: true },
  },
  output: shape({ reference: text({ pattern: publicReferencePattern('VISIT') }), message: literal('Request received.') }),
  async handle({ db, intake }, value) {
    const row = { id: `rq-${randomUUID()}`, name: value.name, phone: value.phone, note: value.note ?? null };
    if (intake === 'tenant') await db.visit_request.insert(row);
    else await db.triage.insert(row);
    return { reference: publicReference('VISIT'), message: 'Request received.' as const };
  },
});

export default defineCommands({ recordPayment, postNotice, requestVisit });
