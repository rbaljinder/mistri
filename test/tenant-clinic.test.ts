/**
 * The clinic fixture (test/fixtures/apps/clinic), a multi-module tenant App converted from a single-tenant one,
 * served as a deployment serves it and driven through the public test kit (`host.tenant`, `host.platform`): every
 * guarantee the tenant docs make, asserted through the App's own doors, on SQLite and on PostgreSQL.
 */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { liveSkip } from './live.js';
import { TEST_CONTROL_HEADER, TEST_CONTROL_PATHS } from '../packages/mistri/src/server/testing/control.ts';
import { startClinic, type Engine } from './support/clinicFixture.ts';

const LIVE = process.env.TABLEWALK_TEST_PG;
const ids = (rows: readonly Record<string, unknown>[]) => rows.map((row) => String(row.id)).sort();

async function evidence(t: TestContext, engine: Engine) {
  const { host } = await startClinic(t, engine);
  const north = await host.tenant('north', { roles: ['reception'] });
  const south = await host.tenant('south', { roles: ['owner'] });
  const operator = await host.platform({ roles: ['operator'] });

  await t.test("the test host's setup routes answer its token alone", async () => {
    for (const headers of [{}, { [TEST_CONTROL_HEADER]: 'x'.repeat(64) }] as Record<string, string>[]) {
      for (const path of Object.values(TEST_CONTROL_PATHS)) {
        const answer = await fetch(new URL(path, host.url), {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ tenant: 'north', roles: ['owner'], table: 'clinic', rows: [{ id: 'west', name: 'West' }] }),
        });
        assert.notEqual(answer.status, 200, path);
      }
    }
    // Nor does a member's own session reach them: a lease is no token.
    const answer = await north.request(TEST_CONTROL_PATHS.membership, { method: 'POST', json: { tenant: 'south', roles: ['owner'] } });
    assert.notEqual(answer.status, 200);
    const clinics = await operator.rows('clinic');
    assert.ok(clinics.ok);
    assert.ok(!ids(clinics.value).includes('west'));
  });

  await t.test('a membership is of one tenant: another is refused, and so is the platform realm', async () => {
    const elsewhere = await north.enter('south');
    assert.equal(elsewhere.ok, false);
    assert.equal(elsewhere.status, 403);
    assert.equal((await north.enter('@platform')).ok, false);
    // A platform member is no member of a clinic.
    assert.equal((await operator.enter('north')).ok, false);
    // The roles are held to the realm: a tenant role is no platform membership.
    await assert.rejects(host.platform({ roles: ['reception'] }));
  });

  await t.test('each clinic lists its own rows and none of another', async () => {
    for (const [table, mine, theirs] of [
      ['appointment', ['ap-north-1', 'ap-north-2'], ['ap-south-1']],
      ['patient', ['pt-north-ada', 'pt-north-ben'], ['pt-south-cy']],
      ['service', ['sv-north-checkup', 'sv-north-internal'], ['sv-south-checkup']],
    ] as const) {
      const ours = await north.rows(table);
      assert.ok(ours.ok, ours.ok ? '' : ours.message);
      assert.deepEqual(ids(ours.value), [...mine]);
      const others = await south.rows(table);
      assert.ok(others.ok, others.ok ? '' : others.message);
      assert.deepEqual(ids(others.value), [...theirs]);
    }
    // The ownership column is the server's: no row names it.
    const rows = await north.rows('appointment');
    assert.ok(rows.ok && rows.value.every((row) => !('clinic_id' in row)));
  });

  await t.test("another clinic's record is not found, as one that does not exist", async () => {
    assert.ok((await north.record('appointment', { id: 'ap-north-1' })).ok);
    for (const id of ['ap-south-1', 'ap-nowhere']) {
      const read = await north.record('appointment', { id });
      assert.equal(read.ok, false);
      assert.equal(read.status, 404);
      assert.equal(read.ok ? undefined : read.code, 'not_found');
    }
  });

  await t.test("a clinic's command runs in its own clinic and is refused on another's record", async () => {
    const foreign = await north.prepare('recordPayment', { id: 'ap-south-1' });
    assert.equal(foreign.ok, false);
    assert.equal(foreign.status, 403, foreign.ok ? '' : foreign.message);
    // Nor by skipping the prepare: an execute with a guessed version is refused before anything is written.
    const guessed = await north.request(`/api/commands/execute`, {
      method: 'POST',
      json: {
        command: 'recordPayment',
        commandVersion: 1,
        key: { id: 'ap-south-1' },
        expectedVersion: 0,
        idempotencyKey: 'clinic-foreign-execute-0001',
        input: { amount_cents: 9000, method: 'card' },
      },
    });
    assert.equal(guessed.status, 403, await guessed.text());
    const southBefore = await south.rows('appointment', { where: 'status = paid' });
    assert.ok(southBefore.ok);
    assert.deepEqual(southBefore.value, []);

    const paid = await north.command('recordPayment', { id: 'ap-north-1' }, { amount_cents: 12000, method: 'card' });
    assert.ok(paid.ok, paid.ok ? '' : paid.message);
    const payments = await north.rows('payment');
    assert.ok(payments.ok);
    assert.equal(payments.value.length, 1);
    assert.equal(payments.value[0].appointment_id, 'ap-north-1');
    const theirs = await south.rows('payment');
    assert.ok(theirs.ok);
    assert.deepEqual(theirs.value, []);
    const after = await north.rows('appointment', { where: 'status = paid' });
    assert.ok(after.ok);
    assert.deepEqual(ids(after.value), ['ap-north-1']);
  });

  await t.test("the platform reads every clinic's rows, and its command writes only the clinic it names", async () => {
    const clinics = await operator.rows('clinic');
    assert.ok(clinics.ok, clinics.ok ? '' : clinics.message);
    assert.deepEqual(ids(clinics.value), ['east', 'north', 'south']);
    const appointments = await operator.rows('appointment');
    assert.ok(appointments.ok, appointments.ok ? '' : appointments.message);
    assert.deepEqual(ids(appointments.value), ['ap-north-1', 'ap-north-2', 'ap-south-1']);

    const posted = await operator.command('postNotice', {}, { clinic_id: 'south', body: 'Closed on Friday.' });
    assert.ok(posted.ok, posted.ok ? '' : posted.message);
    const southNotices = await south.rows('notice');
    assert.ok(southNotices.ok);
    assert.deepEqual(
      southNotices.value.map((row) => row.body),
      ['Closed on Friday.'],
    );
    const northNotices = await north.rows('notice');
    assert.ok(northNotices.ok);
    assert.deepEqual(northNotices.value, []);
    // The platform's command is not a clinic's: a member of one is refused it.
    const refused = await north.prepare('postNotice', {});
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 403);
    // A clinic the platform never provisioned is refused, and nothing lands.
    const unknown = await operator.command('postNotice', {}, { clinic_id: 'west', body: 'Nowhere.' });
    assert.equal(unknown.ok, false);
    const notices = await operator.rows('notice');
    assert.ok(notices.ok);
    assert.equal(notices.value.length, 1);
  });

  await t.test('a support visit reads as the dealer role it assumes, writes nothing, stays in its clinic and is logged', async () => {
    // The role must be one the grant offers.
    const owner = await operator.support('north', { role: 'owner', reason: 'Checking the owner view' });
    assert.equal(owner.ok, false);
    assert.equal(owner.status, 403);
    // A tenant's member opens no visit at all.
    assert.equal((await north.support('south', { role: 'reception', reason: 'Not mine to open' })).ok, false);

    const opened = await operator.support('north', { role: 'reception', reason: 'Payment did not show for Ada' });
    assert.ok(opened.ok, opened.ok ? '' : opened.message);
    const visit = opened.value;
    assert.equal(visit.visit.dealerRole, 'reception');
    assert.equal(visit.visit.reason, 'Payment did not show for Ada');
    const read = await visit.rows('appointment');
    assert.ok(read.ok, read.ok ? '' : read.message);
    assert.deepEqual(ids(read.value), ['ap-north-1', 'ap-north-2']);
    // Another clinic's record is not in reach inside the visit, by its id or by any address of it.
    const foreign = await visit.rows('appointment', { where: 'id = ap-south-1' });
    assert.ok(foreign.ok, foreign.ok ? '' : foreign.message);
    assert.deepEqual(foreign.value, []);
    // The same filter finds the visited clinic's own record, so the empty answer above is the boundary's.
    const own = await visit.rows('appointment', { where: 'id = ap-north-1' });
    assert.ok(own.ok);
    assert.deepEqual(ids(own.value), ['ap-north-1']);
    assert.equal((await visit.record('appointment', { id: 'ap-south-1' })).ok, false);
    // A visit writes nothing: neither a command the role may run nor an edit.
    const write = await visit.prepare('recordPayment', { id: 'ap-north-2' });
    assert.equal(write.ok, false);
    assert.equal(write.status, 403);
    const edit = await visit.update('patient', { id: 'pt-north-ada' }, { phone: '555-9999' });
    assert.equal(edit.ok, false);
    assert.equal(edit.status, 403);
    // Nor reaches another clinic by its own lease's selector.
    assert.equal((await visit.enter('south')).ok, false);

    const exited = await visit.exit();
    assert.ok(exited.ok, exited.ok ? '' : exited.message);
    // The ended visit's lease reads nothing more.
    assert.equal((await visit.rows('appointment')).ok, false);

    // The clinic's owner reads its own log of visits: who, why, how it ended; another clinic's owner reads none.
    const northOwner = await host.tenant('north', { roles: ['owner'] });
    const log = await northOwner.request('/api/tenant/support/log');
    assert.equal(log.status, 200, await log.clone().text());
    const text = await log.text();
    assert.match(text, /Payment did not show for Ada/);
    assert.match(text, /reception/);
    const southLog = await south.request('/api/tenant/support/log');
    assert.equal(southLog.status, 200);
    assert.doesNotMatch(await southLog.text(), /Payment did not show for Ada/);
    // The platform's audit names the visit among every clinic's.
    const sessions = await operator.request('/api/tenant/support/sessions');
    assert.equal(sessions.status, 200, await sessions.clone().text());
    assert.match(await sessions.text(), /Payment did not show for Ada/);
    // A reception member holds no support log.
    assert.notEqual((await north.request('/api/tenant/support/log')).status, 200);
  });
}

test('the clinic fixture on SQLite keeps every tenant guarantee', { timeout: 240000 }, (t) => evidence(t, 'sqlite'));
test('the clinic fixture on PostgreSQL keeps every tenant guarantee', { skip: liveSkip('postgres', LIVE), timeout: 240000 }, (t) =>
  evidence(t, 'postgres'),
);
