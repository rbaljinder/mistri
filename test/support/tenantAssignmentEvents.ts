import { DatabaseSync } from 'node:sqlite';
import type { LoadedApp } from '../../packages/mistri/src/server/app/apps.js';
import { defineCommand, defineCommands, withCommandVersions } from '../../packages/mistri/src/server/commands/businessCommands.js';
import { defineEvent, defineEventProjection } from '../../packages/mistri/src/server/commands/businessEvents.js';
import { int, shape, text } from '../../packages/mistri/src/server/commands/commandShapes.js';
import { COMMAND_EVENT_TABLES } from '../../packages/mistri/src/adapters/events/commandEventSchema.js';
import { COMMAND_JOURNAL_TABLES } from '../../packages/mistri/src/adapters/commands/commandJournal.js';
import { assignmentResult, tenantAssignmentCommands } from './tenantAssignmentFixture.js';
import { sqliteAuditRows, sqliteBatchRows } from './commandTargets.js';

export type TenantEventsFixture = boolean | 'missing-store' | 'insert-failure';
type AssignmentOutput = ReturnType<typeof assignmentResult>;
type ReviewerAssigned = Pick<AssignmentOutput, 'applicationId' | 'reviewerId' | 'assignmentId' | 'version'>;

const reviewerAssigned = defineEvent(
  'application.reviewer-assigned',
  shape({
    applicationId: text(),
    reviewerId: text(),
    assignmentId: text({ pattern: /^[a-f0-9]{32}$/ }),
    version: int({ min: 1 }),
  }),
);

/** The original native actor binding, validation and handler are reused intact.
 * Free-text reasons, display names and manager identity are not payload fields. */
export function tenantAssignmentEventCommands(staffByAccount: Readonly<Record<string, readonly string[]>>) {
  const original = tenantAssignmentCommands(staffByAccount);
  const { version: _version, ...definition } = original.assignReviewer;
  return withCommandVersions(
    defineCommands({
      ...original,
      assignReviewer: defineCommand({
        ...definition,
        events: {
          reviewerAssigned: defineEventProjection<AssignmentOutput, ReviewerAssigned>(reviewerAssigned, (output) => ({
            applicationId: output.applicationId,
            reviewerId: output.reviewerId,
            assignmentId: output.assignmentId,
            version: output.version,
          })),
        },
      }),
    }),
    (id) => (id === 'assignReviewer' ? 2 : 1),
  );
}

/** Clone the actual checked Ignition model; neither disk authoring nor the
 * cached version-1 model is mutated by this opt-in proof. */
export function tenantAssignmentEventApp(original: LoadedApp): LoadedApp {
  const { commands: _commands, ...metadata } = original;
  const loaded = structuredClone(metadata);
  let references = 0;
  for (const [name, resource] of Object.entries(loaded.app.resources ?? {})) {
    for (const action of resource.actions ?? []) {
      if (action.command?.id !== 'assignReviewer') continue;
      if (name !== 'loan_application' || action.command.version !== 1) throw new Error('Unexpected assignment reference');
      action.command = { ...action.command, version: 2 };
      references++;
    }
  }
  if (references !== 1) throw new Error('Expected the authored assignment reference');
  return loaded;
}

/** Installed only in a disposable child. No schema trigger or host bypass:
 * the first real event insertion fails after observing ALL staged companions
 * on its own writer. Exact-request retry proves this one-shot fault was reached. */
export function failFirstTenantEventInsert(): () => void {
  if (process.argv[2] !== '--tenant-fixture-child') throw new Error('Event fault requires the isolated fixture child');
  const prepare = DatabaseSync.prototype.prepare;
  const restore = () => {
    DatabaseSync.prototype.prepare = prepare;
  };
  DatabaseSync.prototype.prepare = function (sql) {
    if (sql.startsWith(`INSERT INTO main."${COMMAND_EVENT_TABLES.event}"`)) {
      const count = (table: string) => Reflect.apply(prepare, this, [`SELECT count(*) AS n FROM "${table}"`]).get()?.n;
      const application = Reflect.apply(prepare, this, [
        "SELECT version, reviewer_id FROM physical_loan_application WHERE id='northstar-application'",
      ]).get();
      if (
        !this.isTransaction ||
        application?.version !== 1 ||
        application.reviewer_id !== 'northstar-reviewer' ||
        ['physical_assignment_history', COMMAND_JOURNAL_TABLES.receipt].some((table) => count(table) !== 1) ||
        // The receipt's targets and its event batch are columns of the receipt row.
        Reflect.apply(prepare, this, [`SELECT count(*) AS n FROM ${sqliteAuditRows} a`]).get()?.n !== 1 ||
        Reflect.apply(prepare, this, [`SELECT count(*) AS n FROM ${sqliteBatchRows} b`]).get()?.n !== 1 ||
        count(COMMAND_EVENT_TABLES.event) !== 0
      ) {
        throw new Error('Event fault did not observe the staged command');
      }
      restore();
      throw new Error('Disposable event insertion failure');
    }
    return Reflect.apply(prepare, this, [sql]);
  };
  return restore;
}
