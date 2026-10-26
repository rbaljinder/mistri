/** Loaner Desk acceptance, in the layers an App's tests have, through public mistri exports only:
 * unit, API, a virtual external service, and the authorization matrix (the browser layer is acceptance.spec.ts).
 * Run: node --import tsx --test test/loaner-desk-acceptance/acceptance.test.ts */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test, type TestContext } from 'node:test';
import { assertAuthorizationMatrix, createTestClock, validateTestApp } from '@mistriwork/mistri/testing';
import { kioskScan } from '../fixtures/apps/loaner-desk/jobs.ts';
import { appSource, createLoanerDeskFixture, runCommand } from './fixture.ts';
import { signDelivery } from './return-kiosk.ts';

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function fixture(t: TestContext) {
  const f = await createLoanerDeskFixture();
  t.after(() => f.close());
  return f;
}

describe('unit: the App’s own rules, without a server', () => {
  test('a kiosk delivery is read for its scan and loan, and one it cannot read is refused', () => {
    assert.deepEqual(kioskScan({ scan: 'scan-1', loan: 3 }), { scan: 'scan-1', loan: 3 });
    for (const body of [{}, { scan: 'scan-1' }, { scan: 'a b', loan: 1 }, { scan: 'scan-1', loan: 0 }, { scan: 'scan-1', loan: '3' }, null])
      assert.throws(() => kioskScan(body), Error, JSON.stringify(body));
  });

  test('a delivery is signed over its time and exact bytes, so a later attempt carries a new signature', () => {
    const clock = createTestClock('2026-03-02T09:00:00Z');
    const first = signDelivery('secret', clock.now(), '{"scan":"scan-1","loan":1}');
    assert.equal(first['x-kiosk-timestamp'], String(Date.parse('2026-03-02T09:00:00Z')));
    assert.deepEqual(signDelivery('secret', clock.now(), '{"scan":"scan-1","loan":1}'), first);
    clock.advance(1000);
    assert.notEqual(signDelivery('secret', clock.now(), '{"scan":"scan-1","loan":1}')['x-kiosk-signature'], first['x-kiosk-signature']);
  });

  test('the App loads with the production loader and matches its authority.lock', async () => {
    assert.deepEqual(await validateTestApp(appSource), { id: 'loaner-desk', name: 'Loaner Desk' });
  });
});

describe('API: commands over HTTP against a disposable database', () => {
  test('staff check an item out, return it and check it out again; a stale or ineligible submission writes nothing', async (t) => {
    const f = await fixture(t);
    const out = await runCommand(f.staff, 'checkoutEquipment', { id: 'camera' }, { borrower: 'ada', due_on: day(1) }, randomUUID());
    assert.equal(out.status, 200, await out.clone().text());
    assert.deepEqual(f.rows('SELECT status FROM equipment WHERE id = ?', 'camera'), [{ status: 'checked_out' }]);
    const [loan] = f.rows("SELECT id FROM equipment_loan WHERE status = 'open'");
    // An inactive borrower and a past due date are refused by the handler, whatever the picker offered.
    const inactive = await runCommand(
      f.staff,
      'checkoutEquipment',
      { id: 'projector' },
      { borrower: 'casey', due_on: day(1) },
      randomUUID(),
    );
    assert.equal(inactive.status, 409, await inactive.clone().text());
    const late = await runCommand(f.staff, 'checkoutEquipment', { id: 'projector' }, { borrower: 'ben', due_on: day(-1) }, randomUUID());
    assert.equal(late.status, 409, await late.clone().text());
    const back = await runCommand(f.staff, 'returnEquipment', { id: loan.id as number }, {}, randomUUID());
    assert.equal(back.status, 200, await back.clone().text());
    // A submission prepared before that return is stale now: refused, and no second loan.
    const stale = await f.staff.request('/api/commands/execute', {
      method: 'POST',
      json: {
        command: 'returnEquipment',
        commandVersion: 1,
        key: { id: loan.id },
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
        input: {},
      },
    });
    assert.equal(stale.status, 409, await stale.clone().text());
    const again = await runCommand(f.staff, 'checkoutEquipment', { id: 'camera' }, { borrower: 'ben', due_on: day(2) }, randomUUID());
    assert.equal(again.status, 200, await again.clone().text());
    assert.deepEqual(f.rows('SELECT borrower_id, status FROM equipment_loan ORDER BY id'), [
      { borrower_id: 'ada', status: 'returned' },
      { borrower_id: 'ben', status: 'open' },
    ]);
  });
});

describe('virtual service: the return kiosk calls back, signed', () => {
  test('a scan returns the loan once, a retried delivery replays it, and a forged one changes nothing', async (t) => {
    const f = await fixture(t);
    const out = await runCommand(f.staff, 'checkoutEquipment', { id: 'camera' }, { borrower: 'ada', due_on: day(1) }, randomUUID());
    assert.equal(out.status, 200, await out.clone().text());
    const [loan] = f.rows("SELECT id FROM equipment_loan WHERE status = 'open'");
    const kiosk = (path: string, body?: unknown) =>
      fetch(`${f.kiosk.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }).then((response) => response.json());

    // Signed with another secret, the delivery is refused before any command runs.
    f.kiosk.scenario('wrong-secret');
    const forged = await kiosk('/scans', { loan: loan.id });
    assert.deepEqual(await kiosk('/dispatch'), { statuses: { [forged.id]: 401 } });
    assert.deepEqual(f.rows('SELECT status FROM equipment_loan'), [{ status: 'open' }]);

    f.kiosk.scenario(null);
    assert.deepEqual(await kiosk('/dispatch'), { statuses: { [forged.id]: 204 } });
    assert.deepEqual(f.rows('SELECT status FROM equipment_loan'), [{ status: 'returned' }]);
    assert.deepEqual(f.rows('SELECT status FROM equipment WHERE id = ?', 'camera'), [{ status: 'available' }]);

    // The kiosk retries a minute later, re-signed: the scan id keys the receipt, so nothing runs twice.
    f.kiosk.clock.advance(60_000);
    assert.deepEqual(await kiosk(`/scans/${forged.id}/redeliver`), { status: 204 });
    assert.deepEqual(f.rows('SELECT status FROM equipment_loan'), [{ status: 'returned' }]);
    // Too far from the App's clock, a delivery is refused however it is signed.
    f.kiosk.clock.advance(10 * 60_000);
    assert.deepEqual(await kiosk(`/scans/${forged.id}/redeliver`), { status: 401 });
    f.kiosk.verify({ method: 'POST', path: '/scans' }, { times: 1 });
  });
});

describe('security: who may read and do what', () => {
  test('the authorization matrix holds for every role, signed out and through the callback', async (t) => {
    const f = await fixture(t);
    const out = await runCommand(f.staff, 'checkoutEquipment', { id: 'camera' }, { borrower: 'ada', due_on: day(1) }, randomUUID());
    assert.equal(out.status, 200, await out.clone().text());
    const [loan] = f.rows("SELECT id FROM equipment_loan WHERE status = 'open'");
    const checkout = (key = randomUUID()) => ({
      method: 'POST',
      json: {
        command: 'checkoutEquipment',
        commandVersion: 1,
        key: { id: 'projector' },
        expectedVersion: 0,
        idempotencyKey: key,
        input: { borrower: 'ada', due_on: day(1) },
      },
    });
    await assertAuthorizationMatrix([
      { name: 'signed out cannot read the schema', client: f.anonymous, path: '/api/schema', status: 401 },
      { name: 'signed out cannot check out', client: f.anonymous, path: '/api/commands/execute', request: checkout(), status: [401, 403] },
      {
        name: 'viewer reads loans',
        client: f.viewer,
        path: '/api/query',
        request: { method: 'POST', json: { table: 'equipment_loan', columns: ['id', 'status'] } },
        status: 200,
        inspect: async (response) => assert.deepEqual((await response.json()).rows, [{ id: loan.id, status: 'open' }]),
      },
      { name: 'viewer cannot check out', client: f.viewer, path: '/api/commands/execute', request: checkout(), status: 403 },
      {
        name: 'viewer cannot return',
        client: f.viewer,
        path: '/api/commands/prepare',
        request: { method: 'POST', json: { command: 'returnEquipment', commandVersion: 1, key: { id: loan.id } } },
        status: 403,
      },
      {
        name: 'staff have no generic writes',
        client: f.staff,
        path: '/api/update',
        request: { method: 'POST', json: { table: 'equipment', key: { id: 'projector' }, values: { status: 'checked_out' } } },
        status: [401, 403],
      },
      { name: 'staff cannot manage accounts', client: f.staff, path: '/api/accounts?app=loaner-desk', status: 403 },
      {
        name: 'an unsigned callback is refused',
        client: f.anonymous,
        path: '/api/inbound/kioskReturn',
        request: { method: 'POST', json: { scan: 'forged-1', loan: loan.id } },
        status: 401,
      },
    ]);
    // Nothing a refused row asked for happened.
    assert.deepEqual(f.rows('SELECT id, status FROM equipment ORDER BY id'), [
      { id: 'camera', status: 'checked_out' },
      { id: 'projector', status: 'available' },
    ]);
    // A matrix that cannot fail proves nothing: one deliberately wrong expectation must be reported.
    await assert.rejects(
      assertAuthorizationMatrix([
        {
          name: 'deliberately wrong: viewer may check out',
          client: f.viewer,
          path: '/api/commands/execute',
          request: checkout(),
          status: 200,
        },
      ]),
      /deliberately wrong/,
    );
  });
});
