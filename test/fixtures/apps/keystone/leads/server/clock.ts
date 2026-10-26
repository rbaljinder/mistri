// The decision clock's command: flag an application Keystone has not answered
// by the moment the submission promised. Run only by the `decisionDue` job
// (jobs.ts) as its service principal; no App reference draws it, so its
// contract is written here.
//
// A platform-realm command: a late answer is Keystone's concern and the alert
// is Keystone's row. It decides against what is stored when it runs, so an
// application decided or withdrawn meanwhile is left alone, and that is still
// a success.
import { defineCommand, literal, oneOf, refuse, shape, text } from '@mistriwork/mistri/commands';
import { stamp } from './dealMath.ts';
import { keystone } from './source.ts';

const key = text({ max: 200 });

export const lateOutput = oneOf(
  shape({ applicationId: key, flagged: literal(true), reason: literal('flagged') }),
  shape({ applicationId: key, flagged: literal(false), reason: literal('answered', 'not_due', 'already_flagged') }),
);

export const flagLateDecision = defineCommand({
  realm: 'platform',
  source: keystone,
  target: 'loan_application',
  input: { due_at: { type: 'text', label: 'Answer due', max: 19 } },
  read: [],
  write: ['decision_alert'],
  output: lateOutput,
  async handle({ db, record: application, actor, now }, input) {
    // Someone holding the role still cannot run it: only the clock does.
    if (actor.kind !== 'service') refuse('forbidden');
    const unchanged = (reason: 'answered' | 'not_due' | 'already_flagged') =>
      lateOutput.parse({ applicationId: String(application.id), flagged: false, reason });
    if (application.status !== 'submitted' && application.status !== 'in_review') return unchanged('answered');
    if (stamp(now()) < input.due_at) return unchanged('not_due');
    if (await db.decision_alert.count({ application_id: application.id, due_at: input.due_at })) return unchanged('already_flagged');
    await db.decision_alert.insert({
      application_id: application.id,
      dealer_id: application.dealer_id,
      raised_at: stamp(now()),
      due_at: input.due_at,
      resolved_at: null,
    });
    return lateOutput.parse({ applicationId: String(application.id), flagged: true, reason: 'flagged' });
  },
});
