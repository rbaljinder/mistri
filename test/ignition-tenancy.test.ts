/**
 * Ignition's tenancy, on a real deployment of the sample and on both engines.
 *
 * This is the suite the sample exists for: not that a filter was written, but
 * that a dealership's context cannot reach another's rows or the lender's, and
 * that the two realms refuse each other's commands. The three active
 * dealerships deliberately hold the *same* business references, so isolation is
 * something these tests demonstrate rather than assert about distinct ids.
 *
 * 1. `mistri check` accepts the whole two-realm App against a real catalog, and
 *    prints the automation its jobs module declares.
 * 2. A dealership's catalog is its own: six tables, none of the lender's, and
 *    no ownership column — `tenant_id` is injected, never authored or read.
 * 3. Two dealerships hold `L-2001` and `AL-1001` each, and each sees only its
 *    own; the lender sees every one, and whose it is.
 * 4. Each realm refuses the other's commands, by declaration rather than by a
 *    screen omitting a button.
 * 5. A public application, saved on every step, lands in the dealership its
 *    intake address names; one whose address nothing resolves lands in the
 *    lender's triage, and the applicant is answered identically either way.
 *    The applicant's token is bound to the place it was issued in: the same
 *    token under another dealership's address continues nothing there.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { INTAKE_ADDRESSES } from '../examples/databases/ignition/schema.mjs';
import { BusinessCommandExecutionError } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { liveSkip } from './live.js';
import {
  accountOf,
  enrollIgnition,
  ignitionJobs,
  openIgnitionLending,
  type IgnitionDialect,
  type IgnitionLending,
} from './support/ignitionLendingFixture.js';
import { VALIDATE, validating } from './support/validation.js';

const run = promisify(execFile);
const LIVE_PG = process.env.TABLEWALK_TEST_PG;
const ENGINES: ReadonlyArray<{ dialect: IgnitionDialect; skip: false | string }> = [
  { dialect: 'sqlite', skip: false },
  { dialect: 'postgres', skip: liveSkip('postgres', LIVE_PG) },
];

/** The fixture's synthetic people, by the role each holds. */
const NORTH_ADMIN = accountOf('dana.ward@north.example.invalid');
const HARBOR_ADMIN = accountOf('rowan.pike@harbor.example.invalid');
const LENDER_MANAGER = accountOf('casey.ellis@lender.example.invalid');

const as = (account: string) => ({ account });
const page = (table: string) => ({ table, limit: 50, offset: 0 });
const plain = (row: object) => JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
const refused = (code: string) => (error: unknown) => error instanceof BusinessCommandExecutionError && error.code === code;

/** The connection file a deployment is started with, naming both sources. */
function serverConfig(t: TestContext, lending: IgnitionLending): string {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-ignition-tenancy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const where = (source: IgnitionLending['source']) => source.url ?? source.existingPath!;
  const path = join(directory, 'server.json');
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        connections: [
          { name: 'loans', url: where(lending.source), writable: true },
          // A platform-only source is read only: its connection never says writable.
          { name: 'applicants', url: where(lending.platformSources[0]), writable: false },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

for (const { dialect, skip } of ENGINES)
  describe(`Ignition's tenancy on ${dialect}`, { skip }, () => {
    test('mistri check accepts the two-realm App against a real catalog', async (t) => {
      /* Provisioned for jobs as well, because the line below starts the App with
       `--jobs`: the job stores are attested at startup and never created, so a
       database without them refuses the check for a reason that has nothing to
       do with the App's declarations. */
      const lending = await openIgnitionLending(t, dialect, { events: true, jobs: await ignitionJobs() });
      const config = serverConfig(t, lending);
      // The fixture put its own audit secret in the environment; the child inherits it.
      const { stdout } = await run(
        process.execPath,
        [
          '--import',
          'tsx',
          'packages/mistri/src/server/index.ts',
          '--config',
          config,
          '--app',
          'test/fixtures/apps/ignition',
          '--policy',
          'test/fixtures/apps/ignition/tenant-policy.ts',
          '--commands',
          'test/fixtures/apps/ignition/commands.ts',
          '--jobs',
          'test/fixtures/apps/ignition/jobs.ts',
        ],
        { timeout: 120_000, env: validating([VALIDATE]).env },
      );
      assert.match(stdout, /Ignition: ok/);
      assert.match(stdout, /jobs: reviewDue@1 on application\.submitted@1 \(convertLead@1\) → flagOverdueReview@1 as review-clock/);
    });

    test("a dealership's catalog is its own six tables, and the ownership column is not one of them", async (t) => {
      const lending = await openIgnitionLending(t, dialect, { events: true });
      const { enrollment } = await enrollIgnition(t, lending, {});
      const seen = await enrollment.deployment.withContext(as(NORTH_ADMIN), ['north-motors'], async (context) => ({
        tables: context.schema.tables.map((table) => table.id).sort(),
        columns: context.schema.tables.find((table) => table.id === 'lead')!.columns.map((column) => column.name),
      }));
      assert.deepEqual(
        seen.tables,
        ['application_document', 'lead', 'lead_co_applicant', 'loan_application', 'vehicle', 'vehicle_model'],
        "the lender's tables are absent from a dealership's catalog, not merely denied inside it",
      );
      assert.equal(
        seen.columns.includes('tenant_id'),
        false,
        'ownership is injected by the runtime: a dealership neither writes nor reads it',
      );
    });

    test('two dealerships hold the same references and each sees only its own; the lender sees both', async (t) => {
      const lending = await openIgnitionLending(t, dialect, { events: true });
      const { enrollment } = await enrollIgnition(t, lending, {});
      const leads = (account: string, tenant: string) =>
        enrollment.deployment.withContext(as(account), [tenant], async (context) =>
          (
            await context.data.query({
              ...page('lead'),
              columns: ['id', 'reference'],
              orderBy: [{ column: 'reference', direction: 'asc' }],
            })
          ).rows.map(plain),
        );

      const north = await leads(NORTH_ADMIN, 'north-motors');
      const harbor = await leads(HARBOR_ADMIN, 'harbor-auto');
      assert.ok(
        north.every((row) => String(row.id).startsWith('north-motors:')),
        'only north-motors rows',
      );
      assert.ok(
        harbor.every((row) => String(row.id).startsWith('harbor-auto:')),
        'only harbor-auto rows',
      );
      // The same business reference in both, on two different rows.
      assert.equal(north.filter((row) => row.reference === 'L-2001').length, 1);
      assert.equal(harbor.filter((row) => row.reference === 'L-2001').length, 1);
      assert.notEqual(north.find((row) => row.reference === 'L-2001')!.id, harbor.find((row) => row.reference === 'L-2001')!.id);

      // A dealership cannot open another's context at all.
      await assert.rejects(enrollment.deployment.withContext(as(NORTH_ADMIN), ['harbor-auto'], () => true));

      // The lender reads across dealerships, and sees whose each row is.
      const across = await enrollment.deployment.withPlatformContext(as(LENDER_MANAGER), async (context) =>
        (
          await context.data.query({
            ...page('lead'),
            columns: ['id', 'reference', 'tenant_id'],
            filter: { groups: [[{ column: 'reference', op: '=', value: 'L-2001' }]] },
          })
        ).rows.map(plain),
      );
      assert.deepEqual(across.map((row) => row.tenant_id).sort(), ['harbor-auto', 'north-motors', 'valley-vehicles']);
    });

    test("each realm refuses the other's commands", async (t) => {
      const lending = await openIgnitionLending(t, dialect, { events: true });
      const { enrollment } = await enrollIgnition(t, lending, {});
      // A dealership cannot assign a reviewer: that is the lender's verb.
      await assert.rejects(
        enrollment.deployment.execute(as(NORTH_ADMIN), ['north-motors'], {
          command: 'assignReviewer',
          commandVersion: 1,
          key: { id: 'north-motors:application:0001' },
          expectedVersion: 0,
          idempotencyKey: 'tenancy-dealer-assigns-0001',
          input: { reviewer: 'staff-reviewer-1', reason: "Not the dealership's to make." },
        }),
        refused('forbidden'),
      );
      /* And the lender cannot qualify a lead: that is the dealership's. The
       refusal is asserted by its effect rather than its code, because the two
       directions do not answer alike — a dealership reaching for the platform's
       verb is refused `forbidden`, while the lender reaching for a dealership's
       arrives as `temporarily_unavailable`, a permanent refusal wearing a
       transient code. The refusal is right either way; the code is reported
       rather than pinned here as though it were intended. */
      await assert.rejects(
        enrollment.deployment.executePlatform(as(LENDER_MANAGER), {
          command: 'qualifyLead',
          commandVersion: 1,
          key: { id: 'north-motors:lead:0001' },
          expectedVersion: 0,
          idempotencyKey: 'tenancy-lender-qualifies-0001',
          input: {},
        }),
        (error: unknown) => error instanceof BusinessCommandExecutionError,
      );
      const [lead] = await lending.rows("SELECT status, version FROM lead WHERE id = 'north-motors:lead:0001'");
      assert.deepEqual([lead.status, Number(lead.version)], ['new', 0], "the lender's attempt changed nothing");
    });

    test('an application saved on every step lands where its address names, and an unresolved one lands in triage', async (t) => {
      const lending = await openIgnitionLending(t, dialect, { events: true });
      const { enrollment } = await enrollIgnition(t, lending, {});
      const token = () => createHash('sha256').update(randomBytes(32)).digest('hex');
      let n = 0;
      const step = (address: string | null, id: string, phase: 'start' | 'step' | 'submit', hash: string, input: Record<string, unknown>) =>
        enrollment.deployment.submitIntake({
          form: 'finance',
          address,
          submission: `tenancy-intake-${phase}-${id}-${n++}-${hash.slice(0, 8)}`,
          input,
          draft: { phase, step: id, token: hash },
        });
      /** Every step of the form, then the submit, through one address. */
      const apply = async (address: string | null) => {
        const hash = token();
        await step(address, 'about-you', 'start', hash, {
          applicant_name: 'Mara Alder',
          applicant_email: 'mara@example.invalid',
          applicant_phone: null,
        });
        await step(address, 'address', 'step', hash, {
          address_line: '1 Demonstration Way',
          city: 'Example City',
          state: 'NY',
          postal_code: '10001',
        });
        await step(address, 'income', 'step', hash, { employer: 'Example Logistics', annual_income: 64000 });
        await step(address, 'the-loan', 'step', hash, {
          vehicle_stock: 'DEMO-STOCK-1011',
          requested_amount: 21000,
          down_payment: 2500,
          term_months: 48,
        });
        await step(address, 'co-applicant', 'step', hash, { co_applicants: [{ co_name: 'Ines Brook', co_email: 'ines@example.invalid' }] });
        return step(address, 'submit', 'submit', hash, { consent: true });
      };

      const placed = await apply(INTAKE_ADDRESSES['north-motors']);
      const triaged = await apply('nothing-resolves-this-address-00');
      // Answered identically: the same shape, and a reference either way.
      for (const result of [placed, triaged]) {
        assert.match(String((result.result as { reference: string }).reference), /^IGN-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
        assert.deepEqual(Object.keys(result.result as object).sort(), ['message', 'reference']);
      }

      const leadOf = async (reference: string) =>
        (await lending.rows(`SELECT tenant_id, status, city, resume_token_hash FROM lead WHERE reference = '${reference}'`)).map(plain);
      const triageOf = async (reference: string) =>
        (await lending.rows(`SELECT status FROM intake_submission WHERE reference = '${reference}'`)).map((row) => row.status);

      const placedReference = String((placed.result as { reference: string }).reference);
      const triagedReference = String((triaged.result as { reference: string }).reference);
      assert.deepEqual(
        await leadOf(placedReference),
        [{ tenant_id: 'north-motors', status: 'new', city: 'Example City', resume_token_hash: null }],
        'the address named the dealership, and the submit cleared the token',
      );
      assert.deepEqual(
        (
          await lending.rows(`SELECT c.tenant_id, c.name FROM lead_co_applicant c JOIN lead l ON l.id = c.lead_id
      WHERE l.reference = '${placedReference}'`)
        ).map(plain),
        [{ tenant_id: 'north-motors', name: 'Ines Brook' }],
      );
      assert.deepEqual(await triageOf(placedReference), [], 'a placed submission is not also in triage');
      assert.deepEqual(await triageOf(triagedReference), ['triage'], 'an unresolved address lands with the lender');
      assert.deepEqual(await leadOf(triagedReference), [], 'and never in a dealership');
      assert.equal(
        (
          await lending.rows(`SELECT count(*) AS n FROM intake_co_applicant c JOIN intake_submission s ON s.id = c.submission_id
      WHERE s.reference = '${triagedReference}'`)
        ).map((row) => Number(row.n))[0],
        1,
      );
    });

    test("a draft's token is bound to its dealership: another dealership's link, or none, continues nothing", async (t) => {
      const lending = await openIgnitionLending(t, dialect, { events: true });
      const { enrollment } = await enrollIgnition(t, lending, {});
      const hash = createHash('sha256').update(randomBytes(32)).digest('hex');
      const step = (address: string | null, id: string, phase: 'start' | 'step', input: Record<string, unknown>) =>
        enrollment.deployment.submitIntake({
          form: 'finance',
          address,
          submission: `tenancy-bound-${id}-${String(address).slice(0, 8)}`,
          input,
          draft: { phase, step: id, token: hash },
        });
      await step(INTAKE_ADDRESSES['north-motors'], 'about-you', 'start', {
        applicant_name: 'Otto Vane',
        applicant_email: 'otto@example.invalid',
        applicant_phone: null,
      });
      const drafts = () => lending.rows("SELECT tenant_id, city FROM lead WHERE status = 'draft'").then((rows) => rows.map(plain));
      assert.deepEqual(await drafts(), [{ tenant_id: 'north-motors', city: null }]);
      for (const address of [INTAKE_ADDRESSES['harbor-auto'], null]) {
        await assert.rejects(
          step(address, 'address', 'step', { address_line: '9 Elsewhere Road', city: 'Elsewhere', state: 'NJ', postal_code: '07001' }),
          refused('not_found'),
          String(address),
        );
        assert.deepEqual(await enrollment.deployment.resumeIntake({ form: 'finance', address, token: hash }), [], String(address));
      }
      assert.deepEqual(await drafts(), [{ tenant_id: 'north-motors', city: null }], 'nothing was written anywhere');
      assert.deepEqual(
        await lending.rows("SELECT count(*) AS n FROM intake_submission WHERE status = 'draft'").then((rows) => Number(rows[0].n)),
        0,
      );
      assert.deepEqual(
        await enrollment.deployment.resumeIntake({ form: 'finance', address: INTAKE_ADDRESSES['north-motors'], token: hash }),
        ['about-you'],
      );
    });
  });
