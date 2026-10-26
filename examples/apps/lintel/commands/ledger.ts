/* The ledger. Rent is posted once a month by the rent poster (jobs.ts), a
   service the row policy names; a late fee is assessed by the late-fee
   workflow once the grace days are over; a payment is recorded by the desk or
   settled by the processor's signed callback. Every amount is whole cents.

   Posting is idempotent: a charge of a kind for a lease's month is posted
   once, so a second run (a retry, a process restarted mid-slot, the desk
   pressing Post rent after the job) finds them and posts nothing. The table's
   UNIQUE (lease_id, kind, period) is the last word. */
import { defineCommand, field, literal, publicReference, refuse, shape, text, int } from '@mistriwork/mistri/commands';
import { rentPosted } from '../events.ts';
import { cents, day, dollars, lintel, period, plural, said } from '../source.ts';

/** Days after the first that rent may be paid without a fee. */
export const GRACE_DAYS = 5;
/** The late fee, in cents. */
export const LATE_FEE = 7_500;

const monthName = (p: string) => new Date(`${p}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const lastDay = (p: string) => {
  const [y, m] = p.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

export const postRent = defineCommand({
  source: lintel,
  target: 'charge',
  targets: 'none',
  read: ['lease'],
  input: {
    period: field.text({
      label: 'Month',
      optional: true,
      pattern: /\d{4}-\d{2}/,
      message: 'A month such as 2026-11.',
      help: 'Left empty, this month.',
    }),
  },
  output: shape({
    message: text({ max: 300 }),
    period: text({ pattern: /^\d{4}-\d{2}$/ }),
    dueOn: text({ pattern: /^\d{4}-\d{2}-\d{2}$/ }),
    posted: int({ min: 0, max: 100_000 }),
  }),
  events: { posted: rentPosted },
  async handle({ db, now }, input) {
    const month = input.period ?? period(day(now));
    const first = `${month}-01`;
    // Every lease that runs some of the month, and has not yet been charged its rent for it.
    const leases = await db.lease
      .where`(status = active or status = notice) and start_on <= ${lastDay(month)} and end_on >= ${first}`.limit(1000);
    let posted = 0;
    for (const lease of leases) {
      if (await db.charge.find({ lease_id: lease.id, kind: 'rent', period: month })) continue;
      await db.charge.insert({
        lease_id: lease.id,
        kind: 'rent',
        period: month,
        description: `Rent, ${monthName(month)}`,
        due_on: first,
        amount: lease.rent,
        status: 'open',
        posted_on: day(now),
      });
      posted++;
    }
    return {
      message: posted
        ? `Posted ${plural(posted, 'rent charge')} for ${monthName(month)}.`
        : `${monthName(month)}’s rent was already posted.`,
      period: month,
      dueOn: first,
      posted,
    };
  },
});

/* The workflow's step once the grace days are over: a fee on each rent of the month still open. */
export const assessLateFees = defineCommand({
  source: lintel,
  target: 'charge',
  targets: 'none',
  read: ['lease'],
  input: { period: field.text({ label: 'Month', pattern: /\d{4}-\d{2}/, message: 'A month such as 2026-11.' }) },
  output: said,
  async handle({ db, now }, input) {
    const grace = new Date(Date.parse(`${input.period}-01T00:00:00Z`) + GRACE_DAYS * 86_400_000).toISOString().slice(0, 10);
    if (day(now) <= grace) refuse(`Rent for ${monthName(input.period)} is late only after ${grace}.`);
    const open = await db.charge.where({ period: input.period, kind: 'rent', status: 'open' }).limit(1000);
    let assessed = 0;
    for (const rent of open) {
      if (await db.charge.find({ lease_id: rent.lease_id, kind: 'late_fee', period: input.period })) continue;
      await db.charge.insert({
        lease_id: rent.lease_id,
        kind: 'late_fee',
        period: input.period,
        description: `Late fee, ${monthName(input.period)}`,
        due_on: day(now),
        amount: LATE_FEE,
        status: 'open',
        posted_on: day(now),
      });
      assessed++;
    }
    return { message: `${plural(assessed, 'late fee')} of ${dollars(LATE_FEE)} assessed for ${monthName(input.period)}.` };
  },
});

const METHODS = [
  { value: 'ach', label: 'Bank transfer (ACH)' },
  { value: 'card', label: 'Card' },
  { value: 'check', label: 'Check' },
  { value: 'cash', label: 'Cash' },
] as const;

/* A payment the desk takes: a check dropped at the office, cash at the counter. A charge is paid in full. */
export const recordPayment = defineCommand({
  source: lintel,
  target: 'charge',
  read: ['lease'],
  write: ['payment'],
  input: {
    method: field.choice(METHODS, { label: 'Paid by' }),
    reference: field.text({ label: 'Check number or receipt', max: 40, optional: true }),
  },
  output: said,
  async handle({ db, record, now }, input) {
    const received = day(now);
    await db.payment.insert({
      lease_id: record.lease_id,
      charge_id: record.id,
      received_on: received,
      amount: record.amount,
      method: input.method,
      reference: input.reference ? `${input.method.toUpperCase()}-${input.reference}` : publicReference('PMT'),
    });
    await db.charge.update(record, { status: 'paid' });
    return { message: `${dollars(record.amount)} received on ${record.description}.` };
  },
});

/* The processor's signed callback (jobs.ts): the charge it names was paid. Its own id for the payment is the
   receipt's key and the payment's reference, so a retried callback replays one write. */
export const settleCharge = defineCommand({
  source: lintel,
  target: 'charge',
  read: ['lease'],
  write: ['payment'],
  input: {
    reference: field.text({ max: 64, pattern: /pay_[A-Za-z0-9]+/, message: 'The processor’s payment id.' }),
    amount: field.number({ min: 1, step: 1, label: 'Amount in cents' }),
    method: field.choice([METHODS[0], METHODS[1]]),
  },
  output: shape({ message: literal('Settled.') }),
  async handle({ db, record, now }, input) {
    if (input.amount !== record.amount) refuse(`The processor settled ${dollars(input.amount)}; the charge is ${dollars(record.amount)}.`);
    await db.payment.insert({
      lease_id: record.lease_id,
      charge_id: record.id,
      received_on: day(now),
      amount: input.amount,
      method: input.method,
      reference: input.reference,
    });
    await db.charge.update(record, { status: 'paid' });
    return { message: 'Settled.' as const };
  },
});

/* A one-off charge on a lease: a repair a resident caused, a utility passed through. */
export const addCharge = defineCommand({
  source: lintel,
  target: 'lease',
  write: ['charge'],
  input: {
    kind: field.choice(
      [
        { value: 'utility', label: 'Utility' },
        { value: 'repair', label: 'Repair' },
        { value: 'other', label: 'Other' },
      ] as const,
      { label: 'What for' },
    ),
    description: field.text({ max: 120 }),
    amount: field.money({ min: 1, max: 10_000 }),
    due_on: field.date({ label: 'Due' }),
  },
  when: 'status = active or status = notice',
  output: said,
  async handle({ db, record, now }, input) {
    // The ledger keys a charge by its month and kind; a second one-off in a month gets its own day as the period.
    const at = day(now);
    const taken = await db.charge.find({ lease_id: record.id, kind: input.kind, period: period(input.due_on) });
    await db.charge.insert({
      lease_id: record.id,
      kind: input.kind,
      period: taken ? input.due_on : period(input.due_on),
      description: input.description,
      due_on: input.due_on,
      amount: cents(input.amount),
      // Open, the charge machine's first state, by the column's default.
      posted_on: at,
    });
    return { message: `${dollars(cents(input.amount))} charged: ${input.description}.` };
  },
});
