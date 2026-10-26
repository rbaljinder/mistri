/**
 * Ignition's review clock, end to end, on both engines: a dealership converts a
 * qualified lead, that conversion's committed fact schedules the lender's clock,
 * and when the deadline has passed the job flags the application — as a platform
 * service principal, on the lender's own row.
 *
 * What it proves, in one pass over a real deployment of the sample:
 *
 * 1. `convertLead` is a tenant command: its receipt is the dealership's, and the
 *    application it creates is the dealership's own row.
 * 2. The conversion commits exactly one event batch, and the fact carries the
 *    deadline the lender will judge — the payload holds identifiers and dates,
 *    never an applicant's details.
 * 3. The fact enqueues exactly one job, due the day after that deadline.
 * 4. The job runs `flagOverdueReview` as `service:review-clock`, and because that
 *    is a **platform** command its receipt is the lender's: realm `platform`,
 *    with no tenant of its own, while the alert it writes names the dealership's
 *    application.
 * 5. Running the clock again changes nothing: the application is flagged once.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { inspectEventDeliveries, inspectJobs, tenantJobPolicies } from '@mistriwork/mistri/maintenance';
import { COMMAND_JOURNAL_TABLES as journal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { COMMAND_EVENT_TABLES as eventTables } from '../packages/mistri/src/adapters/events/commandEventSchema.js';
import { JOB_TABLES } from '../packages/mistri/src/adapters/jobs/jobStoreSchema.js';
import { openTenantJobHost } from '../packages/mistri/src/server/tenant/tenantJobs.js';
import { liveSkip } from './live.js';
import {
  accountOf,
  BINDING,
  enrollIgnition,
  ignitionJobs,
  openIgnitionLending,
  type IgnitionDialect,
} from './support/ignitionLendingFixture.js';

const DAY = 86_400_000;
const LIVE_PG = process.env.TABLEWALK_TEST_PG;
const ENGINES: ReadonlyArray<{ dialect: IgnitionDialect; skip: false | string }> = [
  { dialect: 'sqlite', skip: false },
  { dialect: 'postgres', skip: liveSkip('postgres', LIVE_PG) },
];

/** North Motors' own admin, and one of its two seeded qualified leads. */
const DEALER = 'north-motors';
const ADMIN = accountOf('dana.ward@north.example.invalid');
const LEAD = `${DEALER}:lead:0003`;

/** PostgreSQL returns counts and exact-decimal values as text. */
const count = (value: unknown) => Number(value);

for (const { dialect, skip } of ENGINES)
  describe(`Ignition's review clock on ${dialect}`, { skip }, () => {
    test("one conversion schedules the lender's clock, and the overdue review is flagged once", async (t) => {
      const jobsRequest = await ignitionJobs();
      const lending = await openIgnitionLending(t, dialect, { events: true, jobs: jobsRequest });
      /* Noon UTC yesterday, and only ever forward from there. Maintenance keeps
       the real clock, so a deployment clock must stay inside the window the
       fixture's grants opened; within it this proof still moves the clock past
       the lender's seven-day deadline and the day after it, which is the whole
       point of the exercise. */
      const clock = { now: Math.floor((Date.now() - DAY) / DAY) * DAY + DAY / 2 };
      /* The deployment keeps the real clock and only the job host carries the
       moved one, as a deployment and its maintenance do: a command's evidence is
       checked against the deployment's clock, and a store refuses one that runs
       back past its own. The host is where the review date has to be reached. */
      const { enrollment } = await enrollIgnition(t, lending, { jobs: true });
      const policies = tenantJobPolicies(BINDING, jobsRequest);

      const rows = (sql: string) => lending.rows(sql);
      const total = async (table: string, where = '') => {
        const [row] = await lending.rows(`SELECT count(*) AS total FROM "${table}"${where ? ` WHERE ${where}` : ''}`);
        return count(row.total);
      };

      // 1. The dealership converts its own qualified lead.
      const prepared = await enrollment.deployment.prepare({ account: ADMIN }, [DEALER], {
        command: 'convertLead',
        commandVersion: 1,
        key: { id: LEAD },
      });
      await enrollment.deployment.execute({ account: ADMIN }, [DEALER], {
        command: 'convertLead',
        commandVersion: 1,
        key: { id: LEAD },
        expectedVersion: prepared.expectedVersion,
        idempotencyKey: 'review-clock-convert-0001',
        input: {},
      });
      const [lead] = await rows(`SELECT status, version FROM lead WHERE id = '${LEAD}'`);
      assert.equal(lead.status, 'converted');
      const [application] = await rows(`SELECT id, tenant_id, reference, status FROM loan_application WHERE lead_id = '${LEAD}'`);
      assert.equal(application.tenant_id, DEALER, "the application is the dealership's own row");
      assert.equal(application.status, 'submitted');
      // Derived from the lead's own reference: `L-2003` becomes `AL-2003`, and the
      // seeded applications sit in the `AL-1xxx` range so a conversion has room.
      assert.equal(application.reference, 'AL-2003');

      // The receipt is the dealership's: a tenant command, in its own realm.
      const [converted] = await rows(`SELECT realm, tenant_id, actor_id FROM "${journal.receipt}" WHERE command_id = 'convertLead'`);
      assert.deepEqual({ ...converted }, { realm: 'tenant', tenant_id: DEALER, actor_id: ADMIN });

      // 2. One event batch, carrying the deadline and nothing personal.
      assert.equal(await total(journal.receipt, 'manifest_json IS NOT NULL'), 1);
      const [stored] = await rows(`SELECT envelope_json FROM "${eventTables.event}"`);
      const envelope = JSON.parse(String(stored.envelope_json)) as Record<string, unknown>;
      assert.equal(envelope.name, 'application.submitted');
      assert.equal(envelope.commandId, 'convertLead');
      const payload = JSON.parse(String(envelope.payloadJson)) as { applicationId: string; reviewDueOn: string };
      assert.deepEqual(Object.keys(payload).sort(), ['applicationId', 'reviewDueOn']);
      assert.equal(payload.applicationId, String(application.id));
      const reviewDueOn = payload.reviewDueOn;
      assert.match(reviewDueOn, /^\d{4}-\d{2}-\d{2}$/);

      // 3. Exactly one job, due the day after that deadline.
      const host = await openTenantJobHost(enrollment, { now: () => clock.now, idleMs: 60_000 });
      assert.ok(host, 'an enrollment with jobs opens a host');
      t.after(() => host.stop());
      /* At least one row, and every row delivered. The length matters: a
       destination the publisher has not reached yet holds no rows at all, and
       `every` over nothing is true — which would let this loop fall straight
       through and assert a job before the fact had been delivered. */
      const settled = async () => {
        const rows = (await inspectEventDeliveries(lending.target, policies.destinations[0].policy)).rows;
        return rows.length > 0 && rows.every((row) => row.state === 'delivered');
      };
      for (let step = 0; step < 40 && !(await settled()); step++) {
        await host.tick();
        clock.now += 5_000;
      }
      assert.ok(await settled(), "the conversion's fact is delivered");
      assert.equal(await total(JOB_TABLES.job), 1);
      const [job] = (await inspectJobs(lending.target, policies.store)).rows;
      assert.equal(job.runAt, Date.parse(reviewDueOn) + DAY);

      // 4. At that moment the clock runs, as the lender's own service principal.
      clock.now = job.runAt + 60_000;
      for (let step = 0; step < 40; step++) {
        const [state] = (await inspectJobs(lending.target, policies.store)).rows;
        if (state.state === 'succeeded') break;
        await host.tick();
        clock.now += 5_000;
      }
      const [ran] = (await inspectJobs(lending.target, policies.store)).rows;
      assert.equal(ran.state, 'succeeded');

      const [flagged] = await rows(`SELECT realm, tenant_id, actor_id FROM "${journal.receipt}" WHERE command_id = 'flagOverdueReview'`);
      assert.deepEqual(
        { ...flagged },
        { realm: 'platform', tenant_id: '', actor_id: 'service:review-clock' },
        "an overdue review is the lender's concern, so its receipt is the platform realm's and holds no dealership",
      );

      const alerts = await rows(`SELECT application_id, CAST(due_on AS TEXT) AS due_on FROM review_alert`);
      assert.equal(alerts.length, 1);
      assert.deepEqual([alerts[0].application_id, alerts[0].due_on], [String(application.id), reviewDueOn]);

      // 5. The clock is idempotent: already flagged, so nothing is written twice.
      clock.now += DAY;
      await host.tick();
      assert.equal(await total('review_alert'), 1);
      assert.equal(await total(journal.receipt, "command_id = 'flagOverdueReview'"), 1);
    });
  });
