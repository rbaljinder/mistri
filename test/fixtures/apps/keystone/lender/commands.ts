import {
  assignUnderwriterInput,
  auditFundingInput,
  clearStipulationInput,
  closeIntakeSubmissionInput,
  decideApplicationInput,
  recordCreditResultInput,
  requestCreditCheckInput,
  approveApplicationInput,
  referToUnderwriterInput,
  remindUnderwriterInput,
  fundLoanInput,
  logDealerVisitInput,
  postPaymentInput,
  receiveContractInput,
  recordServicingNoteInput,
  requestStipulationInput,
  returnPaymentInput,
  rotateIntakeAddressInput,
  setDealerStatusInput,
  waiveLateFeeInput,
  waiveStipulationInput,
} from './inputs.ts';
/* The lender's business commands. Registered through the explicit --commands
   entry, never imported from the App graph.

   Every one runs in one transaction on the keystone source and guards the
   revision of the row it acts on. A refusal says why in the reader's words
   and leaves nothing written. Who acted is the staff row whose email the
   signed-in account carries (auth.me in app.ts), never a field of the form.

   Some write a dealer's own rows (the application, its deal, lead and
   vehicle, its conditions). That is an ordinary write here: the lender is
   not a tenant App. Each such row is found from a row already read, and
   `dealer_id` always comes from there, never from input (SUITE.md, "Cross-App
   flows"). */
import { randomBytes } from 'node:crypto';
import { defineCommand, defineCommands, defineSource, number, refuse, shape, text, type WriteTable } from '@mistriwork/mistri/commands';
import { applicationDecided, creditCheckRequested, creditReported } from './server/events.ts';
import type { Rows } from './mistri-schema.d.ts';

const source = defineSource<Rows>('keystone');
const said = shape({ message: text({ max: 300 }) });
/** What a command that records a fact says back: the message, and the identifiers its event is projected from. */
const reported = shape({
  message: text({ max: 300 }),
  applicationId: text({ max: 64 }),
  checkId: text({ max: 128 }),
  score: number({ min: 300, max: 850 }),
});
const decided = shape({ message: text({ max: 300 }), applicationId: text({ max: 64 }), outcome: text({ max: 16 }) });
const requested = shape({ message: text({ max: 300 }), applicationId: text({ max: 64 }) });

/* ---------- small arithmetic, in the seed's own terms ---------- */

const DAY = 86_400_000;
/** A moment as the schema stores it: UTC to the second. */
const stamp = (at: Date) => at.toISOString().replace('T', ' ').slice(0, 19);
const day = (at: Date) => at.toISOString().slice(0, 10);
const toMs = (moment: string) => Date.parse(`${moment.replace(' ', 'T')}${moment.length > 10 ? 'Z' : 'T00:00:00Z'}`);
const round = (n: number) => Math.round(n * 100) / 100;
/** Money is written as decimal text: numeric on PostgreSQL, exact. */
const cents = (n: number) => round(n).toFixed(2);
const dollars = (n: number | string) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A level-payment schedule, as the seed amortizes one: the last installment takes what is left. */
function amortize(principal: number, apr: number, term: number) {
  const r = apr / 1200;
  const payment = round(r === 0 ? principal / term : (principal * r) / (1 - (1 + r) ** -term));
  let balance = principal;
  const rows: { n: number; principal: number; interest: number; amount: number }[] = [];
  for (let n = 1; n <= term; n++) {
    const interest = round(balance * r);
    const toPrincipal = n === term ? round(balance) : round(Math.min(balance, payment - interest));
    rows.push({ n, principal: toPrincipal, interest, amount: round(toPrincipal + interest) });
    balance = round(balance - toPrincipal);
  }
  return { payment, rows };
}

/** The same day of the month `n` months on, held to the 28th so every month has it. */
function addMonths(from: number, n: number, dueDay: number): number {
  const at = new Date(from);
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + n, dueDay);
}

/* A one-page PDF of plain lines, the same shape as the seed's documents
   (test/fixtures/databases/keystone/pdf.mjs), copied rather than imported: an
   App's server modules stay inside its directory. */
const escapePdf = (s: string) => s.replace(/[\\()]/g, (ch) => `\\${ch}`).replace(/[^\x20-\x7e]/g, '?');
function onePagePdf(title: string, lines: readonly string[]): Buffer {
  const body = [
    'BT',
    '/F1 10 Tf',
    '72 740 Td',
    '(KEYSTONE AUTO FINANCE) Tj',
    '/F1 18 Tf',
    '0 -30 Td',
    `(${escapePdf(title)}) Tj`,
    '/F1 11 Tf',
    '14 TL',
    '0 -12 Td',
    ...lines.flatMap((line) => ['T*', `(${escapePdf(line)}) Tj`]),
    '/F1 8 Tf',
    'T*',
    'T*',
    '(A synthetic document from the Keystone sample. No credit was extended.) Tj',
    'ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/* ---------- who is acting ---------- */

type Staff = Rows['lender_user'];
/** The staff row of the signed-in account, matched by its verified email. */
async function staffOf(
  db: { lender_user: { find(where: object): Promise<Staff | undefined> } },
  actor: { email?: string },
): Promise<Staff> {
  const me = actor.email ? await db.lender_user.find({ email: actor.email.toLowerCase(), active: true }) : undefined;
  if (!me) refuse('Your account is not on Keystone’s staff list, so it cannot act here.');
  return me;
}

/* ---------- the loan's standing, recomputed from its schedule ---------- */

type LoanDb = { loan: WriteTable<Rows['loan']>; installment: WriteTable<Rows['installment']> };

/**
 * Says where a loan stands from its schedule, as the seed does: the oldest
 * unpaid installment past its day sets the days past due (30 or more is
 * delinquent), the next one falling due is `due`, and what is owed is every
 * past-due installment and that one. A loan whose balance is gone is paid
 * off and the rest of its schedule closed. Returns the loan as written.
 */
async function restate(db: LoanDb, loan: Rows['loan'], now: Date): Promise<Rows['loan']> {
  const today = day(now);
  const schedule = await db.installment.where({ loan_id: loan.id }).orderBy('number').limit(200);
  const open = schedule.filter((i) => i.status !== 'paid' && i.status !== 'closed');
  if (Number(loan.principal_balance) <= 0) {
    for (const inst of open) await db.installment.update(inst, { status: 'closed' });
    return db.loan.update(loan, {
      principal_balance: '0.00',
      status: 'paid_off',
      paid_off_on: today,
      next_due_on: null,
      amount_due: '0.00',
      days_past_due: 0,
    });
  }
  let next: Rows['installment'] | undefined;
  let owed = 0;
  for (const inst of open) {
    const status = inst.due_on < today ? 'past_due' : next ? 'upcoming' : 'due';
    if (status === 'past_due') owed += Number(inst.amount);
    if (status === 'due') {
      next = inst;
      owed += Number(inst.amount);
    }
    if (inst.status !== status) await db.installment.update(inst, { status });
  }
  const oldest = open.find((i) => i.due_on < today);
  const behind = oldest ? Math.round((toMs(today) - toMs(oldest.due_on)) / DAY) : 0;
  const status = loan.status === 'charged_off' ? 'charged_off' : behind >= 30 ? 'delinquent' : behind > 0 ? 'past_due' : 'current';
  return db.loan.update(loan, {
    status,
    days_past_due: behind,
    next_due_on: (oldest ?? next)?.due_on ?? null,
    amount_due: cents(owed),
    paid_off_on: null,
  });
}

/* ================================================================ underwriting */

/* Picks up applications for an underwriter. A new submission has no file
   yet: the tenant command that submitted it cannot write a lender's row, so
   the file is opened here, with the bureau "pulled" — synthetic figures drawn
   from the application's own key, the same every time. */
export const assignUnderwriter = defineCommand({
  target: 'loan_application',
  targets: 'many',
  input: assignUnderwriterInput,
  source,
  read: ['lender_user', 'applicant'],
  write: ['underwriting_file'],
  when: 'status in (submitted, in_review, conditioned)',
  output: said,
  async handle({ db, records, now }, input) {
    const who = await db.lender_user.get({ id: Number(input.underwriter) });
    if (!who.active || !['underwriter', 'credit_manager'].includes(who.role)) refuse(`${who.name} does not underwrite.`);
    const at = stamp(now());
    for (const app of records) {
      const file = await db.underwriting_file.find({ application_id: app.id });
      if (file) {
        if (file.underwriter_id === who.id) refuse(`${app.reference} is already ${who.name}’s.`);
        await db.underwriting_file.update(file, { underwriter_id: who.id, assigned_at: at });
      } else {
        const applicant = await db.applicant.get({ id: app.applicant_id });
        const seed = [...app.id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
        const pick = (lo: number, hi: number, salt: number) => lo + ((seed >>> salt) % (hi - lo + 1));
        const score = pick(560, 800, 0);
        await db.underwriting_file.insert({
          application_id: app.id,
          dealer_id: app.dealer_id,
          underwriter_id: who.id,
          assigned_at: at,
          decided_by: null,
          bureau: (['Equifax', 'Experian', 'TransUnion'] as const)[seed % 3],
          score,
          pulled_at: at,
          open_tradelines: pick(2, 24, 3),
          auto_tradelines: pick(0, 3, 5),
          revolving_utilization_pct: String(score > 700 ? pick(2, 35, 7) : pick(20, 95, 7)),
          delinquencies_24m: score > 700 ? pick(0, 1, 9) : pick(0, 5, 9),
          public_records: score < 580 ? 1 : 0,
          inquiries_6m: pick(0, 6, 11),
          monthly_debt: cents(Number(applicant.monthly_income) * (0.08 + pick(0, 20, 13) / 100)),
          decision_due_at: stamp(new Date(toMs(app.submitted_at) + 4 * 3_600_000)),
        });
      }
      if (app.status === 'submitted') await db.loan_application.update(app, { status: 'in_review' });
    }
    return { message: `${plural(records.length, 'application')} assigned to ${who.name}.` };
  },
});

/* The bureau's answer, arriving from outside: the credit provider's signed
   callback (server/jobs.ts, an inbound endpoint) runs this as the service
   principal `credit-provider`, which holds the `integration` role and nothing
   else. It names no record: the provider knows the application it was asked
   about, and the file is found from that. A redelivery never reaches here
   twice — the provider's own id for the check is the receipt's key. */
export const recordCreditResult = defineCommand({
  target: 'underwriting_file',
  targets: 'none',
  input: recordCreditResultInput,
  source,
  write: ['underwriting_file'],
  output: reported,
  // The fact the credit decision (server/credit-decision.ts) waits for.
  events: {
    reported: creditReported,
  },
  async handle({ db, now }, input) {
    const file = await db.underwriting_file.find({ application_id: input.application_id });
    if (!file) refuse('The provider answered for an application that has no underwriting file.');
    await db.underwriting_file.update(file, { score: input.score, pulled_at: stamp(now()) });
    return {
      message: `Score ${input.score} recorded for check ${input.check_id}.`,
      applicationId: input.application_id,
      checkId: input.check_id,
      score: input.score,
    };
  },
});

/* The credit check an underwriter asks for on a file they hold. The command only
   records that it was asked, as a fact: the credit decision workflow
   (server/credit-decision.ts) starts on it, requests the check from the
   provider, waits for the signed callback and decides or refers. */
export const requestCreditCheck = defineCommand({
  target: 'loan_application',
  input: requestCreditCheckInput,
  source,
  read: ['underwriting_file'],
  when: 'status in (submitted, in_review, conditioned)',
  output: requested,
  events: {
    asked: creditCheckRequested,
  },
  async handle({ db, record }) {
    if (!(await db.underwriting_file.find({ application_id: record.id })))
      refuse(`${record.reference} has no underwriter yet; assign one first.`);
    return { message: `A credit check is on its way for ${record.reference}.`, applicationId: record.id };
  },
});

/* What the credit decision does for a clear score, as the `automation` principal:
   the approval as asked, at the program's rate, which opens the funding that
   waits for the dealer's contract. A request the program cannot lend is
   refused, and the workflow refers it to an underwriter instead. */
export const approveApplication = defineCommand({
  target: 'loan_application',
  input: approveApplicationInput,
  source,
  read: ['program', 'dealer'],
  write: ['decision_alert', 'funding', 'deal'],
  when: 'status in (submitted, in_review, conditioned)',
  output: said,
  async handle({ db, record, now }, input) {
    const at = stamp(now());
    const program = record.program_id === null ? undefined : await db.program.find({ id: record.program_id });
    const deal = await db.deal.get({ id: record.deal_id });
    const amount = Number(record.requested_amount),
      term = record.requested_term;
    const apr = program ? Number(program.base_apr) : Number(deal.apr);
    if (program && amount > Number(program.max_amount))
      refuse(`${program.name} lends at most ${dollars(program.max_amount)}; an underwriter decides this one.`);
    const { payment } = amortize(amount, apr, term);
    await db.loan_application.update(record, {
      status: 'approved',
      decided_at: at,
      approved_amount: cents(amount),
      approved_apr: apr.toFixed(3),
      approved_term: term,
      approved_payment: cents(payment),
    });
    await db.deal.update(deal, { status: 'approved', updated_at: at });
    const dealer = await db.dealer.get({ id: record.dealer_id });
    const reserve = (amount * Number(dealer.reserve_pct)) / 100;
    await db.funding.insert({
      application_id: record.id,
      dealer_id: record.dealer_id,
      status: 'awaiting_contract',
      contract_received_on: null,
      audited_by: null,
      funded_on: null,
      amount: cents(amount + reserve),
      dealer_reserve: cents(reserve),
      reject_reason: null,
    });
    for (const alert of await db.decision_alert.where({ application_id: record.id, resolved_at: null }).limit(20)) {
      await db.decision_alert.update(alert, { resolved_at: at });
    }
    return { message: `${record.reference} approved automatically on a score of ${input.score}.` };
  },
});

/* A score that is not clear, or none: the file goes to the underwriters' queue. */
export const referToUnderwriter = defineCommand({
  target: 'loan_application',
  input: referToUnderwriterInput,
  source,
  when: 'status in (submitted, in_review, conditioned)',
  output: said,
  async handle({ db, record }) {
    if (record.status === 'submitted') await db.loan_application.update(record, { status: 'in_review' });
    return { message: `${record.reference} is referred to the underwriters.` };
  },
});

/* An answer that is late: the file is listed on Late decisions until it is answered. */
export const remindUnderwriter = defineCommand({
  target: 'loan_application',
  input: remindUnderwriterInput,
  source,
  write: ['decision_alert'],
  when: 'status in (submitted, in_review, conditioned)',
  output: said,
  async handle({ db, record, now }) {
    const at = stamp(now());
    if (!(await db.decision_alert.find({ application_id: record.id, resolved_at: null }))) {
      await db.decision_alert.insert({
        application_id: record.id,
        dealer_id: record.dealer_id,
        raised_at: at,
        due_at: at,
        resolved_at: null,
      });
    }
    return { message: `${record.reference} is late: the underwriters are reminded.` };
  },
});

/* A condition asked of the dealer. Asked before the answer, it conditions the
   application; asked of an approval, it must be cleared before funding. */
export const requestStipulation = defineCommand({
  target: 'loan_application',
  input: requestStipulationInput,
  source,
  write: ['stipulation'],
  when: 'status in (in_review, conditioned, approved, countered)',
  output: said,
  async handle({ db, record, now }, input) {
    if (await db.stipulation.find({ dealer_id: record.dealer_id, application_id: record.id, kind: input.kind })) {
      refuse(`${record.reference} already has that condition; clear or waive it rather than asking twice.`);
    }
    await db.stipulation.insert({
      dealer_id: record.dealer_id,
      application_id: record.id,
      kind: input.kind,
      status: 'requested',
      requested_at: stamp(now()),
      received_at: null,
      cleared_at: null,
      note: input.note ?? null,
    });
    if (record.status === 'in_review') await db.loan_application.update(record, { status: 'conditioned' });
    return { message: `Asked of the dealer on ${record.reference}.` };
  },
});

export const clearStipulation = defineCommand({
  target: 'stipulation',
  input: clearStipulationInput,
  source,
  when: 'status = received',
  output: said,
  async handle({ db, record, now }) {
    await db.stipulation.update(record, { status: 'cleared', cleared_at: stamp(now()) });
    return { message: 'Condition cleared.' };
  },
});

export const waiveStipulation = defineCommand({
  target: 'stipulation',
  input: waiveStipulationInput,
  source,
  when: 'status in (requested, received)',
  output: said,
  async handle({ db, record, now }, input) {
    await db.stipulation.update(record, { status: 'waived', cleared_at: stamp(now()), note: `Waived: ${input.reason}` });
    return { message: 'Condition waived.' };
  },
});

/* The answer the dealer is owed. An underwriter decides the files they hold;
   a credit manager may decide any. An approval opens the funding that waits
   for the dealer's contract; any answer settles the decision clock's alerts. */
export const decideApplication = defineCommand({
  target: 'loan_application',
  input: decideApplicationInput,
  source,
  read: ['lender_user', 'program', 'dealer'],
  write: ['underwriting_file', 'underwriting_note', 'decision_alert', 'funding', 'deal'],
  when: 'status in (in_review, conditioned)',
  output: decided,
  // The answer a credit decision that referred the file is waiting for (server/credit-decision.ts).
  events: {
    decided: applicationDecided,
  },
  async initial({ record, db }) {
    const program = record.program_id === null ? undefined : await db.program.find({ id: record.program_id });
    return {
      amount: Number(record.requested_amount),
      ...(program ? { apr: Number(program.base_apr) } : {}),
      ...([36, 48, 60, 72, 84].includes(record.requested_term) ? { term: record.requested_term as 36 | 48 | 60 | 72 | 84 } : {}),
    };
  },
  async handle({ db, record, actor, now }, input) {
    const me = await staffOf(db, actor);
    const file = await db.underwriting_file.find({ application_id: record.id });
    if (!file) refuse(`${record.reference} has no underwriter yet; assign one first.`);
    if (me.role === 'underwriter' && file.underwriter_id !== me.id) {
      const holder = file.underwriter_id === null ? undefined : await db.lender_user.find({ id: file.underwriter_id });
      refuse(`${holder?.name ?? 'Another underwriter'} holds ${record.reference}; a credit manager may decide it instead.`);
    }
    const at = stamp(now());
    if (input.outcome === 'decline') {
      if (!input.reason) refuse('invalid_input', 'reason');
      await db.loan_application.update(record, { status: 'declined', decided_at: at, decline_reason: input.reason });
    } else {
      if (input.reason) refuse('invalid_input', 'reason');
      const program = record.program_id === null ? undefined : await db.program.find({ id: record.program_id });
      const deal = await db.deal.get({ id: record.deal_id });
      const amount = input.amount ?? Number(record.requested_amount);
      const apr = input.apr ?? (program ? Number(program.base_apr) : Number(deal.apr));
      const term = input.term ?? record.requested_term;
      if (
        input.outcome === 'counter' &&
        amount === Number(record.requested_amount) &&
        term === record.requested_term &&
        apr === (program ? Number(program.base_apr) : Number(deal.apr))
      ) {
        refuse('A counter changes the amount, the rate or the term; this is the application as asked. Approve it instead.');
      }
      if (program && amount > Number(program.max_amount)) {
        refuse(`${program.name} lends at most ${dollars(program.max_amount)}; counter lower, or decline.`);
      }
      const { payment } = amortize(amount, apr, term);
      await db.loan_application.update(record, {
        status: input.outcome === 'approve' ? 'approved' : 'countered',
        decided_at: at,
        approved_amount: cents(amount),
        approved_apr: apr.toFixed(3),
        approved_term: term,
        approved_payment: cents(payment),
      });
      await db.deal.update(deal, { status: 'approved', updated_at: at });
      if (input.outcome === 'approve') {
        const dealer = await db.dealer.get({ id: record.dealer_id });
        const reserve = (amount * Number(dealer.reserve_pct)) / 100;
        await db.funding.insert({
          application_id: record.id,
          dealer_id: record.dealer_id,
          status: 'awaiting_contract',
          contract_received_on: null,
          audited_by: null,
          funded_on: null,
          amount: cents(amount + reserve),
          dealer_reserve: cents(reserve),
          reject_reason: null,
        });
      }
    }
    await db.underwriting_file.update(file, { decided_by: me.id });
    await db.underwriting_note.insert({ application_id: record.id, author_id: me.id, created_at: at, body: input.note });
    for (const alert of await db.decision_alert.where({ application_id: record.id, resolved_at: null }).limit(20)) {
      await db.decision_alert.update(alert, { resolved_at: at });
    }
    const said = { approve: 'approved', counter: 'countered', decline: 'declined' }[input.outcome];
    return { message: `${record.reference} ${said}. The dealer sees the answer now.`, applicationId: record.id, outcome: input.outcome };
  },
});

/* ================================================================ funding */

/* The signed contract in hand. The dealer says a deal is contracted in its
   own App; until it has, there is nothing to receive. */
export const receiveContract = defineCommand({
  target: 'funding',
  input: receiveContractInput,
  source,
  read: ['loan_application', 'deal'],
  when: 'status in (awaiting_contract, rejected)',
  output: said,
  async handle({ db, record, now }) {
    const app = await db.loan_application.get({ id: record.application_id });
    const deal = await db.deal.get({ id: app.deal_id });
    if (deal.status !== 'contracted') refuse(`The dealer has not marked ${deal.reference} contracted yet.`);
    await db.funding.update(record, { status: 'in_audit', contract_received_on: day(now()), reject_reason: null });
    return { message: `Contract for ${app.reference} received and in audit.` };
  },
});

export const auditFunding = defineCommand({
  target: 'funding',
  input: auditFundingInput,
  source,
  read: ['lender_user', 'loan_application'],
  when: 'status = in_audit',
  output: said,
  async handle({ db, record, actor }, input) {
    const me = await staffOf(db, actor);
    const app = await db.loan_application.get({ id: record.application_id });
    if (input.outcome === 'reject') {
      if (!input.reason) refuse('invalid_input', 'reason');
      await db.funding.update(record, { status: 'rejected', reject_reason: input.reason, audited_by: me.id });
      return { message: `Contract for ${app.reference} rejected; the dealer is told why.` };
    }
    if (input.reason) refuse('invalid_input', 'reason');
    await db.funding.update(record, { status: 'ready', audited_by: me.id });
    return { message: `Contract for ${app.reference} passed audit and is ready to fund.` };
  },
});

/* The money moves. In one transaction: the borrower (found by email, or
   made from the applicant), the loan and its schedule, the three welcome
   documents, and the funded words on the funding, the application, the deal,
   the lead and the car. Every condition must be cleared or waived first. */
export const fundLoan = defineCommand({
  target: 'funding',
  input: fundLoanInput,
  source,
  read: ['applicant', 'dealer', 'stipulation'],
  write: ['loan_application', 'deal', 'lead', 'vehicle', 'customer', 'loan', 'installment', 'loan_document'],
  /* The documents' bytes stay out of the audit trail: a command's trail is held to 64 KiB, and three PDFs beside a
     schedule of up to 84 installments pass it (the attempt is refused as an invalid result otherwise). */
  audit: { redact: ['data'] },
  when: 'status = ready',
  output: said,
  async handle({ db, record, now }) {
    const app = await db.loan_application.get({ id: record.application_id });
    if (app.status !== 'approved' || app.approved_amount === null || app.approved_apr === null || app.approved_term === null) {
      refuse(`${app.reference} is ${app.status.replace(/_/g, ' ')}, not approved.`);
    }
    const open = await db.stipulation.count({ application_id: app.id, status: ['requested', 'received'] });
    if (open) refuse(`${app.reference} has ${plural(open, 'condition')} not yet cleared or waived.`);
    const deal = await db.deal.get({ id: app.deal_id });
    const applicant = await db.applicant.get({ id: app.applicant_id });
    const vehicle = await db.vehicle.get({ id: app.vehicle_id });
    const lead = await db.lead.get({ id: deal.lead_id });
    const dealer = await db.dealer.get({ id: app.dealer_id });
    const at = now(),
      today = day(at);

    const customer =
      (await db.customer.find({ email: applicant.email })) ??
      (await db.customer.insert({
        applicant_id: applicant.id,
        account_id: null,
        first_name: applicant.first_name,
        last_name: applicant.last_name,
        email: applicant.email,
        phone: applicant.phone,
        street: applicant.street,
        city: applicant.city,
        state: applicant.state,
        zip: applicant.zip,
        paperless: true,
        preferred_contact: 'email',
        customer_since: today,
      }));

    const principal = Number(app.approved_amount),
      apr = Number(app.approved_apr),
      term = app.approved_term;
    const { payment, rows } = amortize(principal, apr, term);
    const fundedMs = toMs(today);
    const dueDay = Math.min(28, at.getUTCDate());
    const dueOn = (n: number) => day(new Date(addMonths(fundedMs, n, dueDay)));
    const last = await db.loan.where().orderBy('loan_number', 'desc').limit(1);
    const loanNumber = `KL-${last.length ? Number(last[0].loan_number.slice(3)) + 1 : 200001}`;
    const loan = await db.loan.insert({
      loan_number: loanNumber,
      application_id: app.id,
      customer_id: customer.id,
      dealer_id: app.dealer_id,
      vehicle_description: `${vehicle.year} ${vehicle.make} ${vehicle.model} ${vehicle.trim}`,
      vin: vehicle.vin,
      principal: cents(principal),
      apr: apr.toFixed(3),
      term_months: term,
      payment_amount: cents(payment),
      funded_on: today,
      first_due_on: dueOn(1),
      maturity_on: dueOn(term),
      principal_balance: cents(principal),
      interest_paid: '0.00',
      next_due_on: dueOn(1),
      amount_due: cents(rows[0].amount),
      days_past_due: 0,
      status: 'current',
      paid_off_on: null,
      charged_off_on: null,
    });
    for (const row of rows) {
      await db.installment.insert({
        customer_id: customer.id,
        loan_id: loan.id,
        number: row.n,
        due_on: dueOn(row.n),
        amount: cents(row.amount),
        principal: cents(row.principal),
        interest: cents(row.interest),
        status: row.n === 1 ? 'due' : 'upcoming',
        paid_on: null,
      });
    }
    const who = `${customer.first_name} ${customer.last_name}`;
    const document = async (kind: 'contract' | 'truth_in_lending' | 'welcome_letter', title: string, lines: string[]) => {
      const data = onePagePdf(title, [who, `Loan ${loanNumber}`, `${loan.vehicle_description}, VIN ${loan.vin}`, '', ...lines]);
      await db.loan_document.insert({
        customer_id: customer.id,
        loan_id: loan.id,
        kind,
        title,
        issued_on: today,
        content_type: 'application/pdf',
        file_name: `${loanNumber.toLowerCase()}-${kind.replace(/_/g, '-')}-${today}.pdf`,
        byte_size: data.byteLength,
        // bytea as PostgreSQL's hex text: a write's values must be JSON (its audit record is), and a Buffer is not.
        data: `\\x${data.toString('hex')}`,
      });
    };
    await document('contract', 'Retail installment contract', [
      `Amount financed ${dollars(principal)}`,
      `APR ${apr.toFixed(2)}%`,
      `${term} monthly payments of ${dollars(payment)}`,
      `First payment due ${loan.first_due_on}`,
      `Sold by ${dealer.name}`,
    ]);
    await document('truth_in_lending', 'Truth in Lending disclosure', [
      `Annual percentage rate ${apr.toFixed(2)}%`,
      `Finance charge ${dollars(rows.reduce((s, r) => s + r.interest, 0))}`,
      `Amount financed ${dollars(principal)}`,
      `Total of payments ${dollars(rows.reduce((s, r) => s + r.amount, 0))}`,
    ]);
    await document('welcome_letter', 'Welcome to Keystone Auto Finance', [
      `Your first payment of ${dollars(payment)} is due ${loan.first_due_on}.`,
      'Sign in to your account to set up autopay, see your balance and download documents.',
    ]);

    await db.funding.update(record, { status: 'funded', funded_on: today });
    await db.loan_application.update(app, { status: 'funded' });
    await db.deal.update(deal, { status: 'funded', updated_at: stamp(at) });
    if (lead.status !== 'sold') await db.lead.update(lead, { status: 'sold', lost_reason: null });
    if (vehicle.status !== 'sold') await db.vehicle.update(vehicle, { status: 'sold', sold_on: today });
    return { message: `${loanNumber} funded: ${dollars(record.amount)} wired to ${dealer.name}.` };
  },
});

/* ================================================================ servicing */

/* Every pending payment on each selected loan, oldest first, paid against its
   oldest unpaid installments; what is left over goes to principal. */
export const postPayment = defineCommand({
  target: 'loan',
  targets: 'many',
  input: postPaymentInput,
  source,
  write: ['payment', 'installment'],
  when: 'status in (current, past_due, delinquent, charged_off)',
  output: said,
  async handle({ db, records, now }) {
    let posted = 0;
    for (const start of records) {
      let loan = start;
      const pending = await db.payment.where({ loan_id: loan.id, status: 'pending' }).orderBy('received_on').limit(50);
      if (!pending.length) refuse(`${loan.loan_number} has no payment waiting to post.`);
      for (const pay of pending) {
        let left = Number(pay.amount),
          toPrincipal = 0,
          toInterest = 0;
        const open = await db.installment
          .where({ loan_id: loan.id, status: ['past_due', 'due', 'upcoming'] })
          .orderBy('number')
          .limit(200);
        for (const inst of open) {
          if (left + 0.005 < Number(inst.amount)) break;
          await db.installment.update(inst, { status: 'paid', paid_on: pay.received_on });
          left = round(left - Number(inst.amount));
          toPrincipal += Number(inst.principal);
          toInterest += Number(inst.interest);
        }
        toPrincipal = round(toPrincipal + left);
        await db.payment.update(pay, { status: 'posted', principal: cents(toPrincipal), interest: cents(toInterest) });
        loan = await db.loan.update(loan, {
          principal_balance: cents(Math.max(0, Number(loan.principal_balance) - toPrincipal)),
          interest_paid: cents(Number(loan.interest_paid) + toInterest),
        });
        posted++;
      }
      await restate(db, loan, now());
    }
    return { message: `${plural(posted, 'payment')} posted on ${plural(records.length, 'loan')}.` };
  },
});

/* A payment the bank sent back: what it paid is owed again. */
export const returnPayment = defineCommand({
  target: 'loan',
  input: returnPaymentInput,
  source,
  write: ['payment', 'installment'],
  when: 'status in (current, past_due, delinquent, paid_off)',
  output: said,
  async initial({ record, db }) {
    const [pay] = await db.payment.where({ loan_id: record.id, status: 'posted' }).orderBy('received_on', 'desc').limit(1);
    return pay ? { payment: pay.id } : {};
  },
  async handle({ db, record, now }, input) {
    const pay = await db.payment.get({ id: Number(input.payment) });
    if (pay.loan_id !== record.id) refuse(`${pay.reference} was paid on another loan, not ${record.loan_number}.`);
    if (pay.status !== 'posted') refuse(`${pay.reference} is ${pay.status}, not posted.`);
    // The installments it paid are owed again: those it was posted against, the latest first.
    const paid = await db.installment.where({ loan_id: record.id, status: 'paid', paid_on: pay.received_on }).limit(12);
    for (const inst of paid) await db.installment.update(inst, { status: 'upcoming', paid_on: null });
    await db.payment.update(pay, { status: 'returned', returned_reason: input.reason, principal: '0.00', interest: '0.00' });
    const loan = await db.loan.update(record, {
      principal_balance: cents(Number(record.principal_balance) + Number(pay.principal)),
      interest_paid: cents(Math.max(0, Number(record.interest_paid) - Number(pay.interest))),
      status: record.status === 'paid_off' ? 'current' : record.status,
    });
    const after = await restate(db, loan, now());
    return { message: `${pay.reference} returned. ${record.loan_number} owes ${dollars(after.amount_due)}.` };
  },
});

/* A late fee forgiven: the money already paid goes to principal instead. */
export const waiveLateFee = defineCommand({
  target: 'loan',
  input: waiveLateFeeInput,
  source,
  write: ['payment', 'installment'],
  when: 'status in (current, past_due, delinquent)',
  output: said,
  async initial({ record, db }) {
    const recent = await db.payment.where({ loan_id: record.id, status: 'posted' }).orderBy('received_on', 'desc').limit(120);
    const pay = recent.find((row) => Number(row.late_fee) > 0);
    return pay ? { payment: pay.id } : {};
  },
  async handle({ db, record, now }, input) {
    const pay = await db.payment.get({ id: Number(input.payment) });
    if (pay.loan_id !== record.id) refuse(`${pay.reference} was paid on another loan, not ${record.loan_number}.`);
    const fee = Number(pay.late_fee);
    if (!(fee > 0)) refuse(`${pay.reference} carried no late fee.`);
    await db.payment.update(pay, { late_fee: '0.00', principal: cents(Number(pay.principal) + fee) });
    const loan = await db.loan.update(record, { principal_balance: cents(Math.max(0, Number(record.principal_balance) - fee)) });
    await restate(db, loan, now());
    return { message: `${dollars(fee)} late fee on ${pay.reference} waived and applied to principal.` };
  },
});

export const recordServicingNote = defineCommand({
  target: 'loan',
  input: recordServicingNoteInput,
  source,
  read: ['lender_user'],
  write: ['servicing_note'],
  output: said,
  async handle({ db, record, actor, now }, input) {
    const me = await staffOf(db, actor);
    const promise = input.kind === 'promise_to_pay';
    if (promise && !input.promise_on) refuse('invalid_input', 'promise_on');
    if (!promise && (input.promise_on || input.promise_amount)) refuse('invalid_input', input.promise_on ? 'promise_on' : 'promise_amount');
    if (promise && input.promise_on! < day(now())) refuse('A promise to pay is for today or later.');
    await db.servicing_note.insert({
      loan_id: record.id,
      author_id: me.id,
      created_at: stamp(now()),
      kind: input.kind,
      body: input.body,
      promise_amount: promise && input.promise_amount !== undefined ? cents(input.promise_amount) : null,
      promise_on: promise ? input.promise_on! : null,
    });
    return { message: `Noted on ${record.loan_number}.` };
  },
});

/* ================================================================ dealers */

export const logDealerVisit = defineCommand({
  target: 'dealer',
  input: logDealerVisitInput,
  source,
  read: ['lender_user'],
  write: ['dealer_visit'],
  output: said,
  async handle({ db, record, actor, now }, input) {
    const me = await staffOf(db, actor);
    if (input.happened_on > day(now())) refuse('A visit is logged once it has happened; put one ahead of time in the next step.');
    await db.dealer_visit.insert({
      dealer_id: record.id,
      lender_user_id: me.id,
      happened_on: input.happened_on,
      kind: input.kind,
      summary: input.summary,
      next_step: input.next_step ?? null,
    });
    return { message: `${input.kind[0].toUpperCase()}${input.kind.slice(1)} with ${record.name} logged.` };
  },
});

/* A dealer's standing. On hold pauses new submissions from it everywhere; the
   dealers' App also needs the tenant suspended in its own store, an operator
   step (SUITE.md, gap G14). */
export const setDealerStatus = defineCommand({
  target: 'dealer',
  input: setDealerStatusInput,
  source,
  output: said,
  async handle({ db, record }, input) {
    if (input.status === record.status) refuse(`${record.name} is already ${record.status.replace(/_/g, ' ')}.`);
    if (input.status === 'on_hold' && !input.reason) refuse('invalid_input', 'reason');
    if (input.status !== 'on_hold' && input.reason) refuse('invalid_input', 'reason');
    if (record.status === 'terminated') refuse(`${record.name}’s relationship has ended; it is not reopened here.`);
    await db.dealer.update(record, { status: input.status, on_hold_reason: input.status === 'on_hold' ? input.reason! : null });
    return { message: `${record.name} is ${input.status.replace(/_/g, ' ')}.` };
  },
});

/* 128 random bits: the dealer's apply form moves to a new address at once,
   and the old one places nothing. The receipt says it changed, never what to. */
export const rotateIntakeAddress = defineCommand({
  target: 'dealer',
  input: rotateIntakeAddressInput,
  source,
  when: 'status != terminated',
  output: said,
  async handle({ db, record }) {
    await db.dealer.update(record, { intake_address: randomBytes(16).toString('hex') });
    return { message: `${record.name}’s apply form has a new address; the old link no longer places applications.` };
  },
});

export const closeIntakeSubmission = defineCommand({
  target: 'intake_submission',
  input: closeIntakeSubmissionInput,
  source,
  when: 'status in (open, followed_up)',
  output: said,
  async handle({ db, record, now }, input) {
    await db.intake_submission.update(record, { status: 'closed', closed_at: stamp(now()), outcome_note: input.outcome });
    return { message: `${record.reference} closed.` };
  },
});

export default defineCommands({
  assignUnderwriter,
  recordCreditResult,
  requestCreditCheck,
  approveApplication,
  referToUnderwriter,
  remindUnderwriter,
  requestStipulation,
  clearStipulation,
  waiveStipulation,
  decideApplication,
  receiveContract,
  auditFunding,
  fundLoan,
  postPayment,
  returnPayment,
  waiveLateFee,
  recordServicingNote,
  logDealerVisit,
  setDealerStatus,
  rotateIntakeAddress,
  closeIntakeSubmission,
});
