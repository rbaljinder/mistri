// The lending database's committed facts. Server-only: the command module that
// emits them (leads.ts) and the jobs module that starts on them (jobs.ts)
// import this; the public App graph never does.
//
// A payload holds identifiers and dates only, never an applicant's details: it
// is retained until pruned and copied into the job it starts. It also holds no
// tenant id — the platform reads that from the verified envelope, never from a
// payload, so a fact cannot claim to be another dealer's.
import { date, defineEvent, shape, text } from '@mistriwork/mistri/commands';

/**
 * A dealer converted a qualified lead, so there is a new application due for
 * review on `reviewDueOn`.
 *
 * The date is the lender's deadline as it stood at conversion, computed by the
 * conversion rather than stored on the dealer's row: the review clock is the
 * lender's concern, and a dealer's application carries none of the lender's
 * columns. Once a reviewer is assigned the deadline lives on the platform's
 * `review_file`, where a revision may move it, and the clock decides against
 * whatever is stored then.
 */
export const applicationSubmitted = defineEvent('application.submitted', shape({ applicationId: text({ max: 64 }), reviewDueOn: date() }));
