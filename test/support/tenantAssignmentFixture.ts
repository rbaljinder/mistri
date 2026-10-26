import { DatabaseSync } from 'node:sqlite';
import { defineCommand, defineCommands } from '../../packages/mistri/src/server/commands/businessCommands.js';
import { refuse } from '../../packages/mistri/src/server/commands/businessCommandExecution.js';
import { proofKey as opaque, captureProofStaffAccounts } from './tenantProofStaff.js';
import { assignReviewerInput } from '../fixtures/apps/tenant-ignition/assignment/inputs.js';

export const assignmentResources = ['review_staff', 'loan_application', 'assignment_history'] as const;

/** Only called for the fresh disposable proof store, before tenant enrollment. */
export function seedTenantAssignment(db: DatabaseSync) {
  db.exec(`CREATE TABLE physical_review_staff (id TEXT PRIMARY KEY NOT NULL,
    tenant_id TEXT COLLATE BINARY NOT NULL, location_id TEXT NOT NULL REFERENCES physical_location(id),
    business_id TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, active INTEGER NOT NULL,
    UNIQUE(tenant_id,business_id));
  CREATE TABLE physical_loan_application (id TEXT PRIMARY KEY NOT NULL,
    tenant_id TEXT COLLATE BINARY NOT NULL, location_id TEXT NOT NULL REFERENCES physical_location(id),
    lead_id TEXT NOT NULL REFERENCES physical_lead(id), business_id TEXT NOT NULL, name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'submitted', reviewer_id TEXT REFERENCES physical_review_staff(id),
    version INTEGER NOT NULL DEFAULT 0, UNIQUE(tenant_id,business_id));
  CREATE TABLE physical_assignment_history (id TEXT PRIMARY KEY NOT NULL DEFAULT(lower(hex(randomblob(16)))),
    tenant_id TEXT COLLATE BINARY NOT NULL, location_id TEXT NOT NULL REFERENCES physical_location(id),
    application_id TEXT NOT NULL REFERENCES physical_loan_application(id),
    assigned_to TEXT NOT NULL REFERENCES physical_review_staff(id), assigned_by TEXT NOT NULL REFERENCES physical_review_staff(id),
    name TEXT NOT NULL, reason TEXT NOT NULL, assigned_on TEXT NOT NULL);`);
  for (const tenant of ['northstar', 'riverview']) {
    const label = tenant === 'northstar' ? 'Northstar' : 'Riverview';
    const staff = db.prepare('INSERT INTO physical_review_staff VALUES (?,?,?,?,?,?,?)');
    for (const [suffix, name, role, active] of [
      ['manager', 'manager', 'manager', 1],
      ['reviewer', 'reviewer', 'reviewer', 1],
      ['reviewer-alt', 'alternate reviewer', 'reviewer', 1],
      ['inactive-reviewer', 'inactive reviewer', 'reviewer', 0],
      ['wrong-role', 'clerk', 'clerk', 1],
    ] as const)
      staff.run(`${tenant}-${suffix}`, tenant, `${tenant}-main`, `STAFF-${suffix}`, `${label} ${name}`, role, active);
    db.prepare('INSERT INTO physical_loan_application VALUES (?,?,?,?,?,?,?,?,?)').run(
      `${tenant}-application`,
      tenant,
      `${tenant}-main`,
      `${tenant}-work`,
      'APP-001',
      `${label} application`,
      'submitted',
      null,
      0,
    );
  }
  db.prepare('INSERT INTO physical_review_staff VALUES (?,?,?,?,?,?,?)').run(
    'northstar-other-reviewer',
    'northstar',
    'northstar-other',
    'STAFF-OTHER',
    'Northstar other-location reviewer',
    'reviewer',
    1,
  );
  for (const [suffix, unit, lead, status, reviewer, version, business] of [
    ['other', 'other', 'other-work', 'submitted', null, 0, 'APP-002'],
    ['closed', 'main', 'work', 'approved', null, 0, 'APP-003'],
    ['assigned', 'main', 'work', 'submitted', 'northstar-reviewer', 1, 'APP-004'],
    ['stale', 'main', 'work', 'submitted', null, 3, 'APP-005'],
    // Both parents are readable to a manager, but their locations disagree.
    // Native FK validity alone is insufficient business-process eligibility.
    ['mismatched-lead', 'main', 'other-work', 'submitted', null, 0, 'APP-006'],
  ] as const)
    db.prepare('INSERT INTO physical_loan_application VALUES (?,?,?,?,?,?,?,?,?)').run(
      `northstar-${suffix}-application`,
      'northstar',
      `northstar-${unit}`,
      `northstar-${lead}`,
      business,
      `Northstar ${suffix} application`,
      status,
      reviewer,
      version,
    );
}

type AssignmentResult = {
  applicationId: string;
  reviewerId: string;
  assignmentId: string;
  managerId: string;
  version: number;
  message: string;
};
export function assignmentResult(value: unknown): AssignmentResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid assignment result');
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).length !== 6 ||
    !opaque(data.applicationId) ||
    !opaque(data.reviewerId) ||
    !opaque(data.managerId) ||
    typeof data.assignmentId !== 'string' ||
    !/^[a-f0-9]{32}$/.test(data.assignmentId) ||
    !Number.isSafeInteger(data.version) ||
    (data.version as number) < 1 ||
    data.message !== 'Reviewer assigned.'
  )
    throw new Error('Invalid assignment result');
  return {
    applicationId: data.applicationId,
    reviewerId: data.reviewerId,
    assignmentId: data.assignmentId,
    managerId: data.managerId,
    version: data.version as number,
    message: data.message,
  };
}

/** Private, copied native-account bindings; source/tenant scope stays runtime-owned.
 * A shared account may have distinct staff records in its different tenants. */
export function tenantAssignmentCommands(staffByAccount: Readonly<Record<string, readonly string[]>>) {
  const bindings = captureProofStaffAccounts(staffByAccount);
  return defineCommands({
    assignReviewer: defineCommand({
      // A required reviewer and a reason of at most 500 characters, parsed by the
      // platform. A reviewer is also opaque text.
      source: 'business',
      target: 'loan_application',
      input: assignReviewerInput,
      read: ['review_staff', 'location', 'lead'],
      write: ['assignment_history'],
      when: 'status = submitted and reviewer_id is empty',
      validate(input) {
        if (!opaque(input.reviewer)) throw new Error('Invalid assignment input');
        return { reviewer: input.reviewer, reason: input.reason };
      },
      output: { parse: assignmentResult },
      async handle(context, input) {
        const { db, record: application, actor, now } = context;
        if (!bindings.has(actor.id)) refuse('forbidden');
        const locationId = application.location_id,
          leadId = application.lead_id;
        if (!opaque(locationId) || !opaque(leadId)) refuse('forbidden');
        const managerId = await bindings.manager(context, locationId);
        const lead = await db.lead.find({ id: leadId });
        if (!lead || lead.location_id !== locationId) refuse('forbidden');
        const reviewer = await db.review_staff.find({ id: input.reviewer });
        if (!reviewer || reviewer.role !== 'reviewer' || reviewer.active !== 1 || reviewer.location_id !== locationId)
          refuse('reviewer_unavailable');
        // Status written unchanged, so the guard holds it with the revision and the empty reviewer.
        const { version } = await db.loan_application.update(application, { reviewer_id: input.reviewer, status: 'submitted' });
        const history = await db.assignment_history.insert({
          location_id: locationId,
          application_id: application.id,
          assigned_to: input.reviewer,
          assigned_by: managerId,
          name: 'Reviewer assigned',
          reason: input.reason,
          assigned_on: now().toISOString(),
        });
        return assignmentResult({
          applicationId: application.id,
          reviewerId: input.reviewer,
          assignmentId: history.id,
          managerId,
          version,
          message: 'Reviewer assigned.',
        });
      },
    }),
  });
}
