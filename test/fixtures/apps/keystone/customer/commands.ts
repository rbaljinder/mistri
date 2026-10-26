import { cancelAutopayInput, enrollAutopayInput, makePaymentInput, requestPayoffQuoteInput } from './inputs.ts';
// Explicit --commands entry. Never import this module from the App.
import { defineCommand, defineCommands, defineSource, literal, refuse, shape } from '@mistriwork/mistri/commands';
import type { Rows } from './mistri-schema.d.ts';

/* The four things a borrower does, each checked where it runs. Under the row
   policy every read and write here is already the borrower's own: the loan
   is theirs or it is not found, and a row written with another customer's
   id is refused. So the handlers copy customer_id from the loan they read,
   never from input, and never name a customer themselves. */

const keystone = defineSource<Rows>('keystone');
const DAY = 86_400_000;
const OPEN = 'status in (current, past_due, delinquent)';

// "Today" is the borrower's day at Keystone, in Eastern time, as ui.timezone says.
const today = (now: Date) => now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
const cents = (value: number) => Math.round(value * 100) / 100;
const dollars = (value: number) => value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/* A payment waits as pending until the lender posts it (the lender App's
   postPayment), which is what moves the balance: nothing here touches the
   loan. Its confirmation number is the loan's own count, PMT-<loan>-<n>,
   because a scoped command reads only the borrower's rows and so cannot
   continue Keystone's global sequence (the seeded PMT-5000001 run). */
const makePayment = defineCommand({
  target: 'loan',
  input: makePaymentInput,
  source: keystone,
  write: ['payment'],
  when: OPEN,
  initial: ({ record }) => ({
    amount: Number(record.amount_due) > 0 ? Number(record.amount_due) : Number(record.payment_amount),
    method: 'ach',
    pay_on: today(new Date()),
  }),
  output: shape({ message: literal('Payment scheduled. It shows as pending until it posts, usually the next business day.') }),
  async handle({ db, record, now }, input) {
    const day = today(now());
    if (input.pay_on < day) refuse('A payment date cannot be in the past.');
    if (input.pay_on > addDays(day, 30)) refuse('Choose a payment date within the next 30 days.');
    const owed = cents(Number(record.principal_balance) + Number(record.amount_due));
    if (input.amount > owed)
      refuse(`That is more than the ${dollars(owed)} it takes to pay this loan off. Ask for a payoff quote for the exact amount.`);
    const made = await db.payment.count({ loan_id: record.id });
    await db.payment.insert({
      customer_id: record.customer_id,
      loan_id: record.id,
      reference: `PMT-${String(record.loan_number).replace(/^KL-/, '')}-${String(made + 1).padStart(3, '0')}`,
      received_on: input.pay_on,
      amount: cents(input.amount).toFixed(2),
      method: input.method,
      channel: 'customer_portal',
      status: 'pending',
    });
    return { message: 'Payment scheduled. It shows as pending until it posts, usually the next business day.' as const };
  },
});

/* A payoff quote is good for ten days: today's balance, plus the interest
   that accrues from the last payment to the day it runs out, per diem at
   the loan's APR on a 365-day year. One open quote at a time. */
const requestPayoffQuote = defineCommand({
  target: 'loan',
  input: requestPayoffQuoteInput,
  source: keystone,
  read: ['payment'],
  write: ['payoff_quote'],
  when: OPEN,
  output: shape({ message: literal('Your payoff quote is ready. It is good for ten days, under Payoff quotes on the loan.') }),
  async handle({ db, record, now }) {
    const day = today(now());
    const open = await db.payoff_quote.where({ loan_id: record.id, status: 'issued' }).orderBy('good_through', 'desc').first();
    if (open && String(open.good_through) >= day) {
      refuse(
        `You already have a payoff quote good through ${new Date(`${open.good_through}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}.`,
      );
    }
    const last = await db.payment.where({ loan_id: record.id, status: 'posted' }).orderBy('received_on', 'desc').first();
    const since = last ? String(last.received_on) : String(record.funded_on);
    const goodThrough = addDays(day, 10);
    const balance = Number(record.principal_balance);
    const perDiem = cents((balance * Number(record.apr)) / 100 / 365);
    const amount = cents(balance + perDiem * Math.max(0, daysBetween(since, goodThrough)));
    await db.payoff_quote.insert({
      customer_id: record.customer_id,
      loan_id: record.id,
      requested_on: day,
      good_through: goodThrough,
      amount: amount.toFixed(2),
      per_diem: perDiem.toFixed(2),
      requested_via: 'customer_portal',
      status: 'issued',
    });
    return { message: 'Your payoff quote is ready. It is good for ten days, under Payoff quotes on the loan.' as const };
  },
});

// One autopay a loan: a second enrollment is refused while one is on.
const enrollAutopay = defineCommand({
  target: 'loan',
  input: enrollAutopayInput,
  source: keystone,
  write: ['autopay'],
  when: 'status in (current, past_due)',
  output: shape({ message: literal('Autopay is on. Each payment will be drafted on the day you chose.') }),
  async handle({ db, record, now }, input) {
    const on = await db.autopay.find({ loan_id: record.id, status: ['active', 'paused'] });
    if (on)
      refuse(`Autopay is already on for this loan, from ${on.bank_name} ····${on.account_last4}. Turn it off first to change the account.`);
    await db.autopay.insert({
      customer_id: record.customer_id,
      loan_id: record.id,
      bank_name: input.bank_name.trim(),
      account_type: input.account_type,
      account_last4: input.account_last4,
      draft_day: input.draft_day,
      status: 'active',
      enrolled_on: today(now()),
    });
    return { message: 'Autopay is on. Each payment will be drafted on the day you chose.' as const };
  },
});

const cancelAutopay = defineCommand({
  target: 'autopay',
  input: cancelAutopayInput,
  source: keystone,
  when: 'status in (active, paused)',
  output: shape({ message: literal('Autopay is off. Make each payment yourself from now on.') }),
  async handle({ db, record, now }) {
    await db.autopay.update(record, { status: 'cancelled', cancelled_on: today(now()) });
    return { message: 'Autopay is off. Make each payment yourself from now on.' as const };
  },
});

export default defineCommands({ makePayment, requestPayoffQuote, enrollAutopay, cancelAutopay });
