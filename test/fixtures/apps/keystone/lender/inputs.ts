// Server-only field shapes shared by the command handlers.
import { field } from '@mistriwork/mistri/commands';
export const STIPULATIONS = [
  { value: 'proof_of_income', label: 'Proof of income' },
  { value: 'proof_of_residence', label: 'Proof of residence' },
  { value: 'proof_of_insurance', label: 'Proof of insurance' },
  { value: 'references', label: 'References' },
  { value: 'drivers_license', label: 'Driver’s license' },
  { value: 'signed_contract', label: 'Signed contract' },
] as const;
export const assignUnderwriterInput = {
  underwriter: field.reference('lender_user', {
    by: 'id',
    labelColumn: 'name',
    query: 'active = true and role in (underwriter, credit_manager)',
    help: 'Underwriters and credit managers who are active.',
  }),
};

export const requestStipulationInput = {
  kind: field.choice(STIPULATIONS, { label: 'Condition' }),
  note: field.textarea({ max: 500, optional: true, help: 'What the dealer should send, in the words the dealer will read.' }),
};

export const clearStipulationInput = {};

export const waiveStipulationInput = { reason: field.textarea({ max: 300, help: 'Kept on the condition, where the dealer reads it.' }) };

export const decideApplicationInput = {
  outcome: field.choice([
    { value: 'approve', label: 'Approve' },
    { value: 'counter', label: 'Counter' },
    { value: 'decline', label: 'Decline' },
  ]),
  amount: field.money({ min: 1000, max: 150000, optional: true, help: 'Approve and counter: left empty, the amount requested.' }),
  apr: field.number({ label: 'APR (%)', min: 0, max: 36, step: 0.001, optional: true, help: 'Left empty, the program’s rate.' }),
  term: field.choice([36, 48, 60, 72, 84], { each: (months) => `${months} months`, optional: true }),
  reason: field.choice(
    [
      { value: 'credit_history', label: 'Credit history' },
      { value: 'debt_to_income', label: 'Debt to income' },
      { value: 'loan_to_value', label: 'Loan to value' },
      { value: 'income_unverified', label: 'Income unverified' },
      { value: 'collateral', label: 'Collateral' },
      { value: 'program_limits', label: 'Program limits' },
    ],
    { label: 'Decline reason', optional: true, help: 'Decline only: the reason the dealer is given.' },
  ),
  note: field.textarea({ max: 1000, help: 'Why, for the file: the notes tab keeps it.' }),
};

export const receiveContractInput = {};

export const auditFundingInput = {
  outcome: field.choice([
    { value: 'pass', label: 'Passed: ready to fund' },
    { value: 'reject', label: 'Rejected: back to the dealer' },
  ]),
  reason: field.textarea({ max: 300, optional: true, help: 'Rejected only: what the dealer must fix on the contract.' }),
};

export const fundLoanInput = {};

export const postPaymentInput = {};

export const returnPaymentInput = {
  payment: field.reference('payment', {
    by: 'id',
    labelColumn: 'reference',
    query: 'status = posted and received_on = last 60 days',
    help: 'A payment on this loan posted in the last 60 days.',
  }),
  reason: field.choice(
    ['Insufficient funds (R01)', 'Account closed (R02)', 'No account (R03)', 'Payment stopped (R08)', 'Check returned unpaid'],
    { label: 'Return reason' },
  ),
};

export const waiveLateFeeInput = {
  payment: field.reference('payment', {
    by: 'id',
    labelColumn: 'reference',
    query: 'late_fee > 0 and status = posted',
    help: 'A payment on this loan that carried a late fee.',
  }),
};

export const recordServicingNoteInput = {
  kind: field.choice([
    { value: 'call', label: 'Call' },
    { value: 'email', label: 'Email' },
    { value: 'promise_to_pay', label: 'Promise to pay' },
    { value: 'hardship', label: 'Hardship' },
    { value: 'note', label: 'Note' },
  ]),
  body: field.textarea({ label: 'Note', max: 1000 }),
  promise_amount: field.money({ label: 'Promised amount', optional: true, help: 'Promise to pay only.' }),
  promise_on: field.date({ label: 'Promised by', optional: true, help: 'Promise to pay only: the day the borrower said.' }),
};

export const logDealerVisitInput = {
  kind: field.choice([
    { value: 'visit', label: 'Visit' },
    { value: 'call', label: 'Call' },
    { value: 'review', label: 'Review' },
    { value: 'training', label: 'Training' },
  ]),
  happened_on: field.date({ label: 'When' }),
  summary: field.textarea({ max: 1000, help: 'What was discussed, in a sentence or two.' }),
  next_step: field.text({ max: 200, optional: true }),
};

export const setDealerStatusInput = {
  status: field.choice([
    { value: 'active', label: 'Active' },
    { value: 'on_hold', label: 'On hold' },
    { value: 'terminated', label: 'Terminated' },
  ]),
  reason: field.textarea({ max: 300, optional: true, help: 'On hold only: why new submissions are paused. The dealer reads it.' }),
};

export const rotateIntakeAddressInput = {};

export const closeIntakeSubmissionInput = {
  outcome: field.textarea({ max: 500, help: 'What became of the applicant: placed with a dealer, no response, not eligible.' }),
};

/* The credit provider's signed callback (server/jobs.ts): which application it was asked about, which of its checks
   answered, and the score it found. */
export const requestCreditCheckInput = {};
export const approveApplicationInput = { score: field.number({ integer: true, min: 300, max: 850 }) };
export const referToUnderwriterInput = {};
export const remindUnderwriterInput = {};

export const recordCreditResultInput = {
  application_id: field.text({ max: 64 }),
  check_id: field.text({ max: 128 }),
  score: field.number({ integer: true, min: 300, max: 850 }),
};
