/**
 * The Ignition lending fixture itself, on both engines: that it seeds the
 * sample's §5.17 shape from `schema.mjs`, provisions the reserved stores a
 * deployment provisions, and grants the realm, the four dealerships and every
 * person's memberships — without an authentication store, because a membership
 * names an account id and nothing dereferences it.
 *
 * This suite deliberately does not enroll. Enrollment is the next thing built on
 * this fixture; what is proved here is the half a suite needs before it: the
 * schema on each engine, the rows, the stores, and the memberships.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { liveSkip } from './live.js';
import { accountOf, openIgnitionLending, type IgnitionDialect } from './support/ignitionLendingFixture.js';

const LIVE_PG = process.env.TABLEWALK_TEST_PG;
const ENGINES: ReadonlyArray<{ dialect: IgnitionDialect; skip: false | string }> = [
  { dialect: 'sqlite', skip: false },
  { dialect: 'postgres', skip: liveSkip('postgres', LIVE_PG) },
];

/** PostgreSQL counts and exact-decimal values arrive as text. */
const count = (value: unknown) => Number(value);

for (const { dialect, skip } of ENGINES)
  describe(`the Ignition lending fixture on ${dialect}`, { skip }, () => {
    test("seeds the sample's own shape, provisions its stores, and grants every membership", async (t) => {
      const f = await openIgnitionLending(t, dialect, { events: true, support: true });

      // The dealerships, and the one the sample holds suspended.
      const dealers = await f.rows('SELECT id, code, status FROM dealer ORDER BY id');
      assert.deepEqual(
        dealers.map((row) => [row.id, row.status]),
        [
          ['harbor-auto', 'active'],
          ['north-motors', 'active'],
          ['parkside', 'suspended'],
          ['valley-vehicles', 'active'],
        ],
      );

      /* Every seeded table, against what schema.mjs built: the fixture inserts the
       module's own rows, so a count that disagrees means the seed lost some. */
      for (const table of [
        'dealer',
        'review_desk',
        'lender_staff',
        'vehicle_model',
        'vehicle',
        'lead',
        'loan_application',
        'application_document',
        'review_file',
        'intake_submission',
      ]) {
        const [row] = await f.rows(`SELECT count(*) AS total FROM "${table}"`);
        assert.equal(count(row.total), f.seeded[table].length, `${table} rows`);
      }

      /* Three dealerships hold the same business references, which is the sample's
       point: the same lead reference and the same application reference in each. */
      const leads = await f.rows("SELECT tenant_id FROM lead WHERE reference = 'L-2001' ORDER BY tenant_id");
      assert.deepEqual(
        leads.map((row) => row.tenant_id),
        ['harbor-auto', 'north-motors', 'valley-vehicles'],
      );
      const applications = await f.rows("SELECT tenant_id FROM loan_application WHERE reference = 'AL-1001' ORDER BY tenant_id");
      assert.deepEqual(
        applications.map((row) => row.tenant_id),
        ['harbor-auto', 'north-motors', 'valley-vehicles'],
      );

      // The realm, the tenants and the memberships the fixture granted.
      const [platform] = await f.rows(`SELECT status FROM "__mistri_tenant_tenant" WHERE id = '@platform'`);
      assert.equal(platform.status, 'active');
      const [members] = await f.rows(`SELECT count(*) AS total FROM "__mistri_tenant_membership"`);
      // One row per dealership membership, plus one per member of the lender's staff.
      assert.equal(count(members.total), 9 + 6);

      // A platform command resolves its author here, so every staff row names its account.
      const staff = await f.rows('SELECT id, account_id FROM lender_staff ORDER BY id');
      assert.equal(staff.length, 6);
      assert.ok(staff.every((row) => typeof row.account_id === 'string' && String(row.account_id).startsWith('account-')));
      assert.equal(staff.find((row) => row.id === 'staff-manager-north')?.account_id, accountOf('casey.ellis@lender.example.invalid'));

      // The applicant directory is its own database, and the source the App names.
      assert.equal(f.platformSources.length, 1);
      assert.equal(f.platformSources[0].id, 'applicants');
      assert.notDeepEqual(f.platformSources[0], f.source);
    });
  });
