// The committed fact the desk emits, and the decision clock starts on.
// Identifiers and a moment only: it is kept until pruned and copied into the
// job it starts, so it never carries an applicant's details. No dealer id
// either: the platform reads that from the verified envelope, so a fact cannot
// claim to be another dealer's.
import { defineEvent, shape, text } from '@mistriwork/mistri/commands';

/** A dealer submitted an application; Keystone owes an answer by `dueAt` (UTC, `YYYY-MM-DD HH:MM:SS`). */
export const applicationSubmitted = defineEvent(
  'application.submitted',
  shape({
    applicationId: text(),
    dueAt: text({ pattern: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/ }),
  }),
);
