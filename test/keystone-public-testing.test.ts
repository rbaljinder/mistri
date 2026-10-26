/** Real Keystone acceptance through the published testing API, with owned PostgreSQL. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { assertAuthorizationMatrix, validateTestApp } from '@mistriwork/mistri/testing';
import { createKeystoneFixture } from '../test/keystone-acceptance/keystone-fixture.mjs';

// The unit layer needs no database, so it runs wherever the suite does.
test('Lender and Dealer load with the production loader and match their authority.lock', async () => {
  for (const [id, name] of [
    ['lender', 'Keystone'],
    ['dealer', 'Keystone for Dealers'],
  ])
    assert.deepEqual(await validateTestApp(fileURLToPath(new URL(`../test/fixtures/apps/keystone/${id}`, import.meta.url))), { id, name });
});

test(
  'Keystone credit callback reaches Lender while Dealer isolation and cross-App grants hold',
  {
    skip: !process.env.TABLEWALK_TEST_PG && process.env.TABLEWALK_REQUIRE_LIVE !== '1',
    timeout: 120000,
  },
  async (t) => {
    const fixture = await createKeystoneFixture(process.env.TABLEWALK_TEST_PG);
    t.after(() => fixture.close());
    const { host, lender, dealer, lenderId, dealerId, file, provider } = fixture;
    const lenderHeaders = { 'x-mistri-account': lenderId },
      dealerHeaders = { 'x-mistri-account': dealerId };
    await assertAuthorizationMatrix([
      { name: 'lender schema', client: lender, path: '/lender/api/schema', request: { headers: lenderHeaders }, status: 200 },
      {
        name: 'dealer cannot bypass lender grant',
        client: dealer,
        path: '/lender/api/schema',
        request: { headers: dealerHeaders },
        status: [401, 403, 404],
      },
      {
        name: 'dealer cannot invoke lender command directly',
        client: dealer,
        path: '/lender/api/commands/prepare',
        request: {
          method: 'POST',
          headers: dealerHeaders,
          json: { command: 'assignUnderwriter', commandVersion: 1, key: { id: file.application_id } },
        },
        status: [401, 403, 404],
      },
      {
        name: 'lender cannot bypass dealer grant',
        client: lender,
        path: '/dealer/api/schema',
        request: { headers: lenderHeaders },
        status: [401, 403, 404],
      },
      {
        name: 'dealer sees only its linked tenant',
        client: dealer,
        path: '/dealer/api/query',
        status: 200,
        request: { method: 'POST', headers: dealerHeaders, json: { table: 'dealer', columns: ['id'] } },
        inspect: async (response) => assert.deepEqual((await response.json()).rows, [{ id: fixture.dealerTenant }]),
      },
    ]);
    await assert.rejects(
      assertAuthorizationMatrix([
        {
          name: 'intentionally broken cross-App expectation',
          client: dealer,
          path: '/lender/api/schema',
          request: { headers: dealerHeaders },
          status: 200,
        },
      ]),
      /intentionally broken/,
    );
    const id = await fixture.checkCredit();
    assert.equal((await (await fetch(`${provider.url}/checks/${id}`)).json()).status, 'pending');
    provider.clock.advance(1000);
    const complete = await (await fetch(`${provider.url}/checks/${id}`)).json();
    assert.equal(complete.status, 'complete');
    assert.deepEqual(await (await fetch(`${provider.url}/dispatch`, { method: 'POST' })).json(), { delivered: 1 });
    const read = await lender.request('/lender/api/query', {
      method: 'POST',
      headers: lenderHeaders,
      json: { table: 'underwriting_file', columns: ['id', 'score'], filter: { groups: [[{ column: 'id', op: '=', value: file.id }]] } },
    });
    assert.equal(read.status, 200, await read.clone().text());
    assert.deepEqual((await read.json()).rows, [{ id: file.id, score: complete.score }]);
    provider.verify({ method: 'POST', path: '/checks', body: { partial: { applicationId: file.application_id } } }, { times: 1 });
    // The callback woke the credit decision, and 760 is clear: the application is approved, and the instance is over.
    const { database } = fixture;
    // Approval commits before the instance is closed, so a slow runner can see one without the other: wait for both.
    for (const deadline = Date.now() + 30_000; Date.now() < deadline; await new Promise((done) => setTimeout(done, 100))) {
      const approved =
        (await database.query('SELECT status FROM loan_application WHERE id=$1', [file.application_id])).rows[0].status === 'approved';
      if (approved && (await database.query("SELECT 1 FROM mistri.workflow_instance WHERE state <> 'completed'")).rows.length === 0) break;
    }
    assert.equal(
      (await database.query('SELECT status FROM loan_application WHERE id=$1', [file.application_id])).rows[0].status,
      'approved',
    );
    assert.equal(
      (await database.query('SELECT count(*)::int AS n FROM funding WHERE application_id=$1', [file.application_id])).rows[0].n >= 1,
      true,
      'approval opens funding',
    );
    const instances = (await database.query('SELECT workflow, key, state FROM mistri.workflow_instance')).rows;
    assert.deepEqual(instances, [{ workflow: 'creditDecision', key: file.application_id, state: 'completed' }]);
    // Delivered twice, the callback still ran its command once: the receipt answers the second.
    assert.deepEqual(await (await fetch(`${provider.url}/dispatch`, { method: 'POST' })).json(), { delivered: 0 });
    await host.grant({ appId: 'lender', subjectId: lenderId, roles: [], expectedRevision: 1 });
    await assertAuthorizationMatrix([
      {
        name: 'revoked lender grant',
        client: lender,
        path: '/lender/api/schema',
        request: { headers: lenderHeaders },
        status: [401, 403, 404],
      },
    ]);
  },
);
