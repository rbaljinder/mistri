/**
 * Ignition's commands on a real deployment, on both engines: the dealership's
 * lead gate, the separation of duties inside it, and a command that spans
 * several records all-or-nothing.
 *
 * No role holds generic write in this App, so every change below is a named
 * command in exactly one realm, and every refusal is the command's own.
 *
 * 1. The gate, in order: a new lead is qualified, a qualified one converts into
 *    an application, a new one is disqualified with its reason, and the
 *    dealership withdraws the application it made.
 * 2. The gate refuses out of order, and writes nothing when it does.
 * 3. A dealership's staff may work a lead but not qualify it; its admin may.
 * 4. Several targets in one request are all or none, and one request leaves one
 *    receipt.
 *
 * One step this suite still does not assert: `assignReviewer` across two
 * dealerships, which would show the all-or-nothing rule spanning them. Every
 * one of the lender's own commands is refused at `execute` on this release with
 * a `TenantWriteFailure` that carries no cause, so there is nothing to write a
 * test against yet. It is reported as a platform defect rather than worked
 * around, and the coverage map says so rather than implying it is covered.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { COMMAND_JOURNAL_TABLES as journal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { BusinessCommandExecutionError } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { liveSkip } from './live.js';
import { accountOf, enrollIgnition, openIgnitionLending, type IgnitionDialect } from './support/ignitionLendingFixture.js';

const LIVE_PG = process.env.TABLEWALK_TEST_PG;
const ENGINES: ReadonlyArray<{ dialect: IgnitionDialect; skip: false | string }> = [
  { dialect: 'sqlite', skip: false },
  { dialect: 'postgres', skip: liveSkip('postgres', LIVE_PG) },
];

const NORTH = 'north-motors',
  HARBOR = 'harbor-auto';
const NORTH_ADMIN = accountOf('dana.ward@north.example.invalid');
const NORTH_STAFF = accountOf('kit.marsh@north.example.invalid');
/** Casey Ellis manages the North desk, which covers North and Coastal — so
 * north-motors and harbor-auto, and deliberately not valley-vehicles. */
const NORTH_DESK_MANAGER = accountOf('casey.ellis@lender.example.invalid');
const NORTH_DESK_REVIEWER = 'staff-reviewer-1';

const as = (account: string) => ({ account });
const lead = (tenant: string, n: string) => `${tenant}:lead:${n}`;
const application = (tenant: string, n: string) => `${tenant}:application:${n}`;
const one = (command: string, id: string, key: string, input: Record<string, unknown> = {}, expectedVersion = 0) => ({
  command,
  commandVersion: 1,
  key: { id },
  expectedVersion,
  idempotencyKey: key,
  input,
});
const many = (command: string, ids: readonly string[], key: string, input: Record<string, unknown> = {}) => ({
  command,
  commandVersion: 1,
  keys: ids.map((id) => ({ id })),
  expectedVersions: ids.map(() => 0),
  idempotencyKey: key,
  input,
});

for (const { dialect, skip } of ENGINES)
  describe(`Ignition's commands on ${dialect}`, { skip }, () => {
    const open = async (t: Parameters<typeof openIgnitionLending>[0]) => {
      const lending = await openIgnitionLending(t, dialect, { events: true });
      const { enrollment } = await enrollIgnition(t, lending, {});
      const rows = (sql: string) => lending.rows(sql);
      const count = async (table: string, where = '') => {
        const [row] = await lending.rows(`SELECT count(*) AS total FROM "${table}"${where ? ` WHERE ${where}` : ''}`);
        return Number(row.total);
      };
      return { lending, deployment: enrollment.deployment, rows, count };
    };

    test('the gate, in order: qualify, convert, disqualify', async (t) => {
      const f = await open(t);

      // new -> qualified, recording who and when.
      await f.deployment.execute(as(NORTH_ADMIN), [NORTH], one('qualifyLead', lead(NORTH, '0001'), 'gate-qualify-0001'));
      const [qualified] = await f.rows(`SELECT status, qualified_by, version FROM lead WHERE id = '${lead(NORTH, '0001')}'`);
      assert.equal(qualified.status, 'qualified');
      assert.equal(qualified.qualified_by, NORTH_ADMIN, 'the author is the verified account, not a key into a table');
      assert.equal(Number(qualified.version), 1);

      // qualified -> converted, creating the application the lender will review.
      await f.deployment.execute(as(NORTH_ADMIN), [NORTH], one('convertLead', lead(NORTH, '0003'), 'gate-convert-0003'));
      const [converted] = await f.rows(`SELECT status FROM lead WHERE id = '${lead(NORTH, '0003')}'`);
      assert.equal(converted.status, 'converted');
      const [created] = await f.rows(
        `SELECT tenant_id, reference, status, document_status FROM loan_application WHERE lead_id = '${lead(NORTH, '0003')}'`,
      );
      assert.deepEqual(
        [created.tenant_id, created.reference, created.status, created.document_status],
        [NORTH, 'AL-2003', 'submitted', 'not_started'],
      );

      // new -> disqualified, with the reason the dealership keeps.
      await f.deployment.execute(
        as(NORTH_ADMIN),
        [NORTH],
        one('disqualifyLead', lead(NORTH, '0002'), 'gate-disqualify-0002', { reason: 'The applicant did not proceed.' }),
      );
      const [disqualified] = await f.rows(`SELECT status, disqualified_reason FROM lead WHERE id = '${lead(NORTH, '0002')}'`);
      assert.deepEqual([disqualified.status, disqualified.disqualified_reason], ['disqualified', 'The applicant did not proceed.']);

      /* The gate's fourth step: the dealership withdraws the application it has
       just created, before the lender decides. This is the step that proves a
       dealership's command reaches `loan_application` at all — the table its
       own conversion writes and the lender then reviews. */
      const [fresh] = await f.rows(`SELECT id, version FROM loan_application WHERE lead_id = '${lead(NORTH, '0003')}'`);
      await f.deployment.execute(
        as(NORTH_ADMIN),
        [NORTH],
        one(
          'withdrawApplication',
          String(fresh.id),
          'gate-withdraw-application-0003',
          { reason: 'The applicant bought elsewhere.' },
          Number(fresh.version),
        ),
      );
      const [withdrawn] = await f.rows(`SELECT status, withdrawn_reason, version FROM loan_application WHERE id = '${String(fresh.id)}'`);
      assert.deepEqual(
        [withdrawn.status, withdrawn.withdrawn_reason, Number(withdrawn.version)],
        ['withdrawn', 'The applicant bought elsewhere.', Number(fresh.version) + 1],
      );
    });

    test('the gate refuses out of order, and writes nothing when it does', async (t) => {
      const f = await open(t);
      const applications = await f.count('loan_application');

      // A new lead is not converted: it has not been qualified.
      await assert.rejects(
        f.deployment.execute(as(NORTH_ADMIN), [NORTH], one('convertLead', lead(NORTH, '0001'), 'gate-early-convert-0001')),
        (error: unknown) => error instanceof BusinessCommandExecutionError,
      );
      const [untouched] = await f.rows(`SELECT status, version FROM lead WHERE id = '${lead(NORTH, '0001')}'`);
      assert.deepEqual([untouched.status, Number(untouched.version)], ['new', 0]);
      assert.equal(await f.count('loan_application'), applications, 'no application was created');

      // A disqualified lead is terminal: it is neither qualified nor converted.
      for (const command of ['qualifyLead', 'convertLead']) {
        await assert.rejects(
          f.deployment.execute(as(NORTH_ADMIN), [NORTH], one(command, lead(NORTH, '0008'), `gate-terminal-${command}-0008`)),
          (error: unknown) => error instanceof BusinessCommandExecutionError,
        );
      }
      const [terminal] = await f.rows(`SELECT status, version FROM lead WHERE id = '${lead(NORTH, '0008')}'`);
      assert.deepEqual([terminal.status, Number(terminal.version)], ['disqualified', 0]);
    });

    test("a dealership's staff works a lead but does not qualify it", async (t) => {
      const f = await open(t);
      // Separating who confirms a deal from who handles it is the point of two roles.
      await assert.rejects(
        f.deployment.execute(as(NORTH_STAFF), [NORTH], one('qualifyLead', lead(NORTH, '0001'), 'duties-staff-qualify-0001')),
        (error: unknown) => error instanceof BusinessCommandExecutionError && error.code === 'forbidden',
      );
      const [unchanged] = await f.rows(`SELECT status FROM lead WHERE id = '${lead(NORTH, '0001')}'`);
      assert.equal(unchanged.status, 'new');

      // The same person may convert one the admin has already qualified.
      await f.deployment.execute(as(NORTH_STAFF), [NORTH], one('convertLead', lead(NORTH, '0004'), 'duties-staff-convert-0004'));
      const [converted] = await f.rows(`SELECT status FROM lead WHERE id = '${lead(NORTH, '0004')}'`);
      assert.equal(converted.status, 'converted');
    });

    test('several targets in one request are all or none, within a dealership', async (t) => {
      const f = await open(t);

      // Both of this dealership's new leads, in one request.
      await f.deployment.execute(
        as(NORTH_ADMIN),
        [NORTH],
        many('qualifyLead', [lead(NORTH, '0001'), lead(NORTH, '0002')], 'many-qualify-north-0001'),
      );
      const qualified = await f.rows(`SELECT id FROM lead WHERE tenant_id = '${NORTH}' AND status = 'qualified' ORDER BY id`);
      assert.ok(qualified.length >= 2);
      assert.equal(await f.count(journal.receipt, "command_id = 'qualifyLead'"), 1, 'one request, one receipt');

      /* The lender's own multi-target command reaches across dealerships in one
       request, which is the platform realm's whole point: a dealership's
       command is fenced to its own tenant, and this one is not. Two
       applications owned by two different dealerships, assigned together. */
      const before = await f.count('review_file');
      await f.deployment.executePlatform(
        as(NORTH_DESK_MANAGER),
        many('assignReviewer', [application(NORTH, '0009'), application(HARBOR, '0001')], 'many-assign-both-0001', {
          reviewer: NORTH_DESK_REVIEWER,
          reason: 'North desk allocation.',
        }),
      );
      assert.equal(await f.count('review_file'), before + 2, 'the lender opens one review file per application it assigned');
      /* `review_file` is the lender's own table and carries no `tenant_id` — the
       realm split is why it exists — so which dealerships were reached is read
       through the applications it points at. */
      const assigned = await f.rows(`SELECT a.tenant_id AS tenant_id FROM review_file r
      JOIN loan_application a ON a.id = r.application_id
      WHERE r.reviewer_id = '${NORTH_DESK_REVIEWER}'
        AND r.application_id IN ('${application(NORTH, '0009')}', '${application(HARBOR, '0001')}')
      ORDER BY a.tenant_id`);
      assert.deepEqual(
        assigned.map((row) => String(row.tenant_id)),
        [HARBOR, NORTH],
        'one request assigned a review file in each of two dealerships',
      );
      assert.equal(await f.count(journal.receipt, "command_id = 'assignReviewer'"), 1, 'one request, one receipt');
    });
  });
