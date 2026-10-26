/*
 * The desk's one command, and its `--commands` entry. Server-only: the App
 * graph never imports this module, and this module never imports the App's.
 *
 * Who is running it is resolved through a private account-to-staff map read
 * once at registration, never from browser input — the same shape a real
 * deployment uses, because the specs assert that a manager of one desk cannot
 * assign on another's, and that refusal has to come from the handler rather
 * than from the picker that drew the option.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { defineCommand, defineCommands, defineSource, field, id, int, literal, refuse, shape } from '@mistriwork/mistri/commands';
import type { Rows } from './mistri-schema.d.ts';

const reviews = defineSource<Rows>('reviews');
const staffId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** Read only at registration; a bad map is a startup failure, never a request's. */
function loadStaffMap(path: string | undefined): ReadonlyMap<string, number> {
  if (!path || !isAbsolute(path)) throw new Error('COMMAND_DESK_STAFF_MAP must name an absolute JSON file of account ID to staff ID.');
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('COMMAND_DESK_STAFF_MAP must hold a JSON object.');
  const staff = new Map<string, number>();
  for (const [account, value] of Object.entries(parsed)) {
    if (!account.trim() || !staffId(value)) throw new Error('COMMAND_DESK_STAFF_MAP entries must be account ID to a positive staff ID.');
    staff.set(account, value);
  }
  return staff;
}

const staff = loadStaffMap(process.env.COMMAND_DESK_STAFF_MAP);

export default defineCommands({
  assignReviewer: defineCommand({
    source: reviews,
    target: 'loan_application',
    input: {
      reviewer: field.reference('reviewer', {
        by: 'id',
        labelColumn: 'name',
        query: 'active = true and role = reviewer',
        help: 'An active reviewer. The server checks the desk, whatever this picker offers.',
      }),
      reason: field.textarea({ label: 'Assignment reason', max: 500 }),
    },
    // The postimage check reads the parents the write touches, unchanged ones included.
    read: ['reviewer', 'review_team'],
    write: ['assignment_history'],
    when: 'status = submitted and reviewer_id is empty',
    output: shape({ applicationId: id(), reviewerId: id(), version: int({ min: 1 }), message: literal('Reviewer assigned.') }),
    // The one rule the declaration cannot state: a reviewer is a staff id, a
    // positive whole number, never a key's text.
    validate(input) {
      if (!staffId(input.reviewer)) refuse('invalid_input', 'reviewer');
      return { reviewer: input.reviewer, reason: input.reason };
    },
    async handle({ db, record, actor, now }, input) {
      const manager = (await db.reviewer.find({ id: staff.get(actor.id) ?? 0, role: 'manager', active: true })) ?? refuse('forbidden');
      // A manager assigns only on their own desk. The record page offered the
      // button because the application is unassigned, not because it is theirs.
      if (manager.team_id !== record.team_id) refuse('forbidden');
      const reviewer = await db.reviewer.find({ id: input.reviewer, role: 'reviewer', active: true });
      if (!reviewer || reviewer.team_id !== manager.team_id) refuse('forbidden');
      // Guarded on the revision and the empty reviewer the record was read
      // with, so a concurrent assignment refuses this one rather than doubling.
      const loan = await db.loan_application.update(record, { reviewer_id: input.reviewer });
      await db.assignment_history.insert({
        name: 'Reviewer assigned',
        application_id: loan.id,
        assigned_to: input.reviewer,
        assigned_by: manager.id,
        assigned_on: now().toISOString().slice(0, 10),
        reason: input.reason,
      });
      return { applicationId: loan.id, reviewerId: input.reviewer, version: loan.version, message: 'Reviewer assigned.' as const };
    },
  }),
});
