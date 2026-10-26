// The review clock's command: flag an application whose review date has passed
// undecided. Registered through commands.ts and run only by the `reviewDue` job
// (jobs.ts) as its declared service principal; never imported from the App
// graph, and no App reference draws it, so its whole contract is written here.
//
// It is a **platform-realm** command, because an overdue review is the lender's
// concern and `review_alert` is the lender's row. The job therefore runs it as a
// platform service principal — `service:review-clock`, holding the `automation`
// role and nothing else — fenced on the `@platform` row rather than on any
// dealership's. A dealer being suspended does not stop the lender noticing that
// its own review is late; a suspended lender stops the clock entirely.
//
// The job is started by the conversion's committed fact and is due the day after
// the deadline that fact carried. By then the application may have moved on, so
// the command decides against what is stored **now**: a decided or withdrawn
// application, one whose review file has since been given a later date, or one
// already flagged is left alone, and that is still a success. Otherwise it
// records one `review_alert`. The alert is its own table, so flagging never
// bumps the application's `version` under a manager's open form.
import { defineCommand, field, literal, oneOf, refuse, shape, text } from '@mistriwork/mistri/commands';
import { lending } from './lending.ts';

const key = text({ max: 200 });

export const reviewAlertOutput = oneOf(
  shape({ applicationId: key, flagged: literal(true), reason: literal('flagged') }),
  shape({ applicationId: key, flagged: literal(false), reason: literal('decided', 'withdrawn', 'not_due', 'already_flagged') }),
);

const isoDate = (day: Date) => day.toISOString().slice(0, 10);

export const flagOverdueReview = defineCommand({
  source: lending,
  target: 'loan_application',
  realm: 'platform',
  // The deadline travels with the job, from the fact the conversion recorded,
  // because at conversion there is no review file to read it from. A job's
  // input is parsed by the same parser a form's would be.
  input: { due_on: field.date({ label: 'Review due' }) },
  read: ['review_file'],
  write: ['review_alert'],
  output: reviewAlertOutput,
  async handle({ db, record: application, actor, now }, input) {
    // A person holding the automation role still cannot run it: only the
    // clock's own principal does.
    if (actor.kind !== 'service') refuse('forbidden');
    const unchanged = (reason: 'decided' | 'withdrawn' | 'not_due' | 'already_flagged') =>
      reviewAlertOutput.parse({ applicationId: String(application.id), flagged: false, reason });
    if (application.status === 'approved' || application.status === 'declined') return unchanged('decided');
    if (application.status === 'withdrawn') return unchanged('withdrawn');
    // The review file's date wins when there is one: a revision may have moved
    // the deadline since the fact was recorded.
    const file = await db.review_file.find({ application_id: application.id });
    const dueOn = file ? String(file.review_due_on) : input.due_on;
    // Overdue once the date is behind us, not on the day itself.
    if (!(isoDate(now()) > dueOn)) return unchanged('not_due');
    if (await db.review_alert.count({ application_id: application.id })) return unchanged('already_flagged');
    await db.review_alert.insert({ application_id: application.id, due_on: dueOn, raised_on: isoDate(now()) });
    return reviewAlertOutput.parse({ applicationId: String(application.id), flagged: true, reason: 'flagged' });
  },
});
