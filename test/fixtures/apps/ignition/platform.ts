// The lender's own verbs, every one a **platform-realm** command: assign a
// reviewer, record a review, record the decision, revise an application, rotate
// a dealer's intake address, close a triage submission. Server-only, registered
// in commands.ts and never imported from the App graph.
//
// Two things follow from the realm, and they are the reason this file exists
// separately from leads.ts:
//
// 1. **The author is resolved through the data, not a private file.** A
//    platform command finds its author by `lender_staff.account_id`, matching
//    the verified account id the platform hands it. That is what replaced the
//    old IGNITION_STAFF_MAP: who works for the lender is the lender's own
//    record, readable and auditable, rather than a JSON file on the server.
// 2. **What it may touch is bounded by declaration.** A platform command may
//    insert, update and remove the platform's own rows, and update a dealer's
//    rows by key — never insert or remove one, never set an ownership column,
//    never write a global table. So the lender moves an application's status
//    and owns everything about the review; the dealership owns the row's
//    existence.
import { randomBytes } from 'node:crypto';
import { defineCommand, field, int, list, literal, oneOf, refuse, shape, text, type CommandDb } from '@mistriwork/mistri/commands';
import { lending } from './lending.ts';

const isoDate = (day: Date) => day.toISOString().slice(0, 10);
const key = text({ max: 200 });

export const assignmentOutput = oneOf(
  shape({ applicationId: key, reviewerId: key, version: int({ min: 1 }), message: literal('Reviewer assigned.') }),
  shape({
    applicationIds: list(key, { min: 2, max: 200 }),
    reviewerId: key,
    versions: list(int({ min: 1 }), { min: 2, max: 200 }),
    message: literal('Reviewers assigned.'),
  }),
);
export const reviewOutput = shape({
  applicationId: key,
  version: int({ min: 1 }),
  status: text({ max: 40 }),
  message: literal('Review recorded.'),
});
export const decisionOutput = shape({
  applicationId: key,
  version: int({ min: 1 }),
  outcome: text({ max: 20 }),
  message: literal('Decision recorded.'),
});
export const revisionOutput = shape({
  applicationId: key,
  version: int({ min: 1 }),
  alertCleared: literal(true, false),
  message: literal('Application revised.'),
});
// The reason travels in the receipt: there is no column for it on the dealer's
// profile row, and an audited rotation should still say why it happened.
export const rotationOutput = shape({
  dealerId: key,
  version: int({ min: 1 }),
  label: text({ max: 200 }),
  message: literal('Intake address rotated.'),
});
export const triageOutput = shape({ submissionId: key, version: int({ min: 1 }), message: literal('Submission closed.') });

/** The lender's staff row for the verified account, when it is active and holds
 * one of `roles`. Nobody else acts: a platform membership admits someone to the
 * realm, and this says which of the lender's people they are. */
async function staffOf(db: CommandDb<typeof lending, 'lender_staff'>, actor: { id: string }, roles: readonly string[]) {
  const staff = (await db.lender_staff.find({ account_id: actor.id, active: true })) ?? refuse('forbidden');
  if (!roles.includes(String(staff.role))) refuse('forbidden');
  return staff;
}

/** Whether a desk's coverage, as the seed writes it ("North and Coastal"), names the region. */
const covers = (coverage: string, region: string) =>
  coverage.split(/\s*(?:,|and)\s*/i).some((part) => part.trim().toLowerCase() === region.toLowerCase());

export const platformCommands = {
  /* A manager puts submitted applications on a reviewer, across dealerships:
     one request for a whole selection, all of it or none. This is also where
     the lender's `review_file` is created — the dealer's conversion could not
     make one — so the desk, the manager and the deadline start here. */
  assignReviewer: defineCommand({
    source: lending,
    target: 'loan_application',
    targets: 'many',
    realm: 'platform',
    input: {
      reviewer: field.reference('lender_staff', {
        by: 'id',
        labelColumn: 'name',
        query: 'active = true and role = reviewer',
        help: 'An active reviewer. The server checks the desk that covers this dealer.',
      }),
      reason: field.textarea({ label: 'Assignment reason', max: 500 }),
    },
    // `lender_staff` is in every platform command's footprint: it is how the
    // author is resolved, so a command that could not read it could not know
    // who is running it.
    /* `vehicle` and `lead` are here because the command updates the
       application, and a scoped transaction re-checks that an updated row's
       parents are still visible inside the command's own read footprint. A
       parent left out is not missing data: it is counted as zero parents and
       the write refuses. */
    read: ['lender_staff', 'dealer', 'review_desk', 'vehicle', 'lead'],
    write: ['review_file', 'assignment_history'],
    output: assignmentOutput,
    validate(input) {
      if (typeof input.reviewer !== 'string' || !input.reviewer.trim()) refuse('invalid_input', 'reviewer');
      return { reviewer: input.reviewer, reason: input.reason };
    },
    async handle({ db, records, actor, now }, input) {
      const manager = await staffOf(db, actor, ['manager', 'platform_admin']);
      const reviewer = await db.lender_staff.find({ id: input.reviewer, role: 'reviewer', active: true });
      if (!reviewer) refuse('reviewer_unavailable');
      const desks = await db.review_desk.where().limit(50);
      const assigned = [];
      for (const application of records) {
        // Already assigned: its review file exists, so this is not a fresh
        // assignment and the whole selection is refused rather than doubled.
        if (await db.review_file.count({ application_id: application.id })) refuse('duplicate_record', { key: { id: application.id } });
        const dealer = (await db.dealer.find({ id: application.tenant_id })) ?? refuse('ineligible_state', { key: { id: application.id } });
        const desk = desks.find((candidate) => covers(String(candidate.coverage), String(dealer.region)));
        if (!desk) refuse('ineligible_state', { key: { id: application.id } });
        // A reviewer works their own desk, and a manager assigns only on it.
        if (reviewer.desk_id !== desk.id || (manager.desk_id !== null && manager.desk_id !== desk.id)) {
          refuse('forbidden', { key: { id: application.id } });
        }
        assigned.push(await db.loan_application.update(application, { status: 'in_review' }));
        await db.review_file.insert({
          application_id: application.id,
          dealer_id: dealer.id,
          desk_id: desk.id,
          reviewer_id: reviewer.id,
          manager_id: manager.id,
          review_due_on: isoDate(new Date(now().getTime() + 7 * 86_400_000)),
          review_context: 'Assigned for initial review. No eligibility calculation or lending offer is performed.',
          opened_on: isoDate(now()),
        });
        await db.assignment_history.insert({
          application_id: application.id,
          assigned_to: reviewer.id,
          assigned_by: manager.id,
          assigned_on: now().toISOString(),
          reason: input.reason,
        });
      }
      return assigned.length === 1
        ? {
            applicationId: String(assigned[0].id),
            reviewerId: String(reviewer.id),
            version: Number(assigned[0].version),
            message: 'Reviewer assigned.',
          }
        : {
            applicationIds: assigned.map((row) => String(row.id)),
            reviewerId: String(reviewer.id),
            versions: assigned.map((row) => Number(row.version)),
            message: 'Reviewers assigned.',
          };
    },
  }),

  /* The reviewer records what they found on their own file. Recording a review
     is deliberately not a decision: it moves the application on, and a manager
     decides. A reviewer cannot promote themselves into that authority. */
  recordReview: defineCommand({
    source: lending,
    target: 'loan_application',
    realm: 'platform',
    input: {
      finding: field.choice(['recommend', 'more_information', 'decline'], {
        each: (value) =>
          ({ recommend: 'Recommend to a manager', more_information: 'More information needed', decline: 'Recommend declining' })[value],
      }),
      summary: field.textarea({ label: 'Review summary', max: 2000 }),
    },
    // The application's own parents, for the same reason as assignReviewer above.
    read: ['lender_staff', 'review_file', 'dealer', 'vehicle', 'lead'],
    write: ['application_review'],
    output: reviewOutput,
    async handle({ db, record: application, actor, now }, input) {
      const reviewer = await staffOf(db, actor, ['reviewer', 'manager', 'platform_admin']);
      const file = (await db.review_file.find({ application_id: application.id })) ?? refuse('ineligible_state');
      // Their own file, unless they are a manager of the desk that holds it.
      if (file.reviewer_id !== reviewer.id && file.manager_id !== reviewer.id) refuse('forbidden');
      const status = input.finding === 'more_information' ? 'documents_pending' : 'manager_review';
      await db.application_review.insert({
        application_id: application.id,
        reviewer_id: reviewer.id,
        kind: 'initial',
        status: 'complete',
        opened_on: String(file.opened_on),
        completed_on: isoDate(now()),
        summary: input.summary,
      });
      const { version } = await db.loan_application.update(application, { status });
      return reviewOutput.parse({ applicationId: String(application.id), version: Number(version), status, message: 'Review recorded.' });
    },
  }),

  /* The lender's approval, by a manager, on an application a reviewer has read.
     The decision and the status the dealership sees commit together; the
     dealer reads the outcome and never the reviewer or the notes. */
  recordDecision: defineCommand({
    source: lending,
    target: 'loan_application',
    realm: 'platform',
    input: {
      outcome: field.choice(['approved', 'declined'], {
        label: 'Decision',
        each: (value) => (value === 'approved' ? 'Approve' : 'Decline'),
      }),
      note: field.textarea({ label: 'Decision note', max: 2000, help: "Kept on the lender's record. Not an adverse-action notice." }),
    },
    read: ['lender_staff', 'review_file'],
    write: ['loan_decision'],
    output: decisionOutput,
    async handle({ db, record: application, actor, now }, input) {
      const manager = await staffOf(db, actor, ['manager', 'platform_admin']);
      const file = (await db.review_file.find({ application_id: application.id })) ?? refuse('ineligible_state');
      if (manager.desk_id !== null && file.desk_id !== manager.desk_id) refuse('forbidden');
      if (await db.loan_decision.count({ application_id: application.id })) refuse('duplicate_record');
      await db.loan_decision.insert({
        application_id: application.id,
        decided_by: manager.id,
        outcome: input.outcome,
        recorded_on: isoDate(now()),
        record_note: input.note,
      });
      const { version } = await db.loan_application.update(application, { status: input.outcome });
      return decisionOutput.parse({
        applicationId: String(application.id),
        version: Number(version),
        outcome: input.outcome,
        message: 'Decision recorded.',
      });
    },
  }),

  /* One command over the dealership's terms and the lender's own review file,
     in one transaction: a platform command may update a dealer's row by key,
     which is exactly what this needs and the most it is allowed. A review date
     moved to today or later also clears the clock's overdue flag. */
  reviseApplication: defineCommand({
    source: lending,
    target: 'loan_application',
    realm: 'platform',
    input: {
      terms: field.group(
        {
          requested_amount: field.money({ label: 'Amount to finance', min: 1, max: 10000000 }),
          down_payment: field.money({ max: 10000000, below: 'requested_amount', help: 'Less than the amount to finance.' }),
          term_months: field.choice([36, 48, 60], { label: 'Term', each: (months) => `${months} months` }),
        },
        { label: 'Financing terms' },
      ),
      review: field.group({
        due_on: field.date({
          label: 'Review due',
          help: 'On or after the day the application was submitted. A date from today on clears an overdue flag.',
        }),
        context: field.textarea({ label: 'Review context', max: 2000 }),
      }),
    },
    read: ['lender_staff', 'review_file'],
    write: ['review_file', 'review_alert'],
    when: 'status in (submitted, documents_pending, in_review, manager_review)',
    output: revisionOutput,
    async initial({ db, record: application }) {
      const file = await db.review_file.find({ application_id: application.id });
      return {
        terms: {
          requested_amount: Number(application.requested_amount),
          down_payment: Number(application.down_payment),
          term_months: Number(application.term_months) as 36 | 48 | 60,
        },
        ...(file ? { review: { due_on: String(file.review_due_on), context: String(file.review_context) } } : {}),
      };
    },
    async handle({ db, record: application, actor, now }, input) {
      const manager = await staffOf(db, actor, ['manager', 'platform_admin']);
      const file = (await db.review_file.find({ application_id: application.id })) ?? refuse('ineligible_state');
      if (manager.desk_id !== null && file.desk_id !== manager.desk_id) refuse('forbidden');
      if (input.review.due_on < String(application.submitted_on)) refuse('invalid_input', 'review.due_on');
      const { version } = await db.loan_application.update(application, {
        ...input.terms,
        // Exact decimal text, as the numeric(12, 2) columns take it.
        requested_amount: input.terms.requested_amount.toFixed(2),
        down_payment: input.terms.down_payment.toFixed(2),
      });
      await db.review_file.update(file, { review_due_on: input.review.due_on, review_context: input.review.context });
      // A review due today or later is not overdue: the clock's flag, if it
      // raised one, goes.
      let alertCleared = false;
      if (input.review.due_on >= isoDate(now())) {
        const alerts = await db.review_alert.where({ application_id: application.id }).limit(10);
        for (const alert of alerts) await db.review_alert.remove(alert);
        alertCleared = alerts.length > 0;
      }
      return revisionOutput.parse({
        applicationId: String(application.id),
        version: Number(version),
        alertCleared,
        message: 'Application revised.',
      });
    },
  }),

  /* A new intake address for one dealership. It is a routing address, not a
     credential — all it lets anyone do is submit to that dealer, which is what
     the dealer published it for — so rotating it is ordinary maintenance. The
     old link stops placing submissions the moment this commits: one already in
     flight is resolved again and lands in triage. */
  rotateIntakeAddress: defineCommand({
    source: lending,
    target: 'dealer',
    realm: 'platform',
    read: ['lender_staff'],
    input: {
      label: field.text({
        label: 'Why it is being rotated',
        max: 200,
        help: "Kept on the lender's record. The address itself is generated by the server.",
      }),
    },
    when: 'status = active',
    output: rotationOutput,
    async handle({ db, record: dealer, actor }, input) {
      await staffOf(db, actor, ['platform_admin']);
      // 128 bits from the server's own randomness, in the alphabet the address
      // column takes. Never derived from the dealership's name or code.
      const address = randomBytes(24).toString('base64url').slice(0, 32);
      const { version } = await db.dealer.update(dealer, { intake_address: address });
      // The new address is deliberately not in the result: a receipt is read
      // back later, and the address belongs on the dealership's own record.
      return rotationOutput.parse({
        dealerId: String(dealer.id),
        version: Number(version),
        label: input.label,
        message: 'Intake address rotated.',
      });
    },
  }),

  /* Triage is the lender's own queue and stays there. Closing a submission
     records what was done; staff follow the applicant up on the dealership's
     own link. The platform never inserts a dealer's row, so there is
     deliberately no "move this into a dealer" verb here. */
  closeIntakeSubmission: defineCommand({
    source: lending,
    target: 'intake_submission',
    realm: 'platform',
    read: ['lender_staff'],
    input: {
      note: field.textarea({ label: 'What was done', max: 1000, help: 'How the applicant was followed up. Nothing is sent from here.' }),
    },
    when: 'status = triage',
    output: triageOutput,
    async handle({ db, record: submission, actor }, input) {
      await staffOf(db, actor, ['platform_admin', 'manager']);
      const { version } = await db.intake_submission.update(submission, { status: 'closed', outcome_note: input.note });
      return triageOutput.parse({ submissionId: String(submission.id), version: Number(version), message: 'Submission closed.' });
    },
  }),
};
