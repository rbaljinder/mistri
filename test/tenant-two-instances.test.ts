/** Two instances of one tenant App behind a load balancer: one PostgreSQL
 * database, one sign-in store, one cache, two `tablewalk` processes.
 *
 * What a person meets when consecutive requests land on different instances:
 * a sign-in made on one is honoured by the other; a write made on one — an
 * edit, a command — is what the other's next list, record and count read; a
 * membership revoked by the operator is refused by both on their next
 * request, though each had admitted it before; and a sign-in lockout counted
 * on one is counted on the other, through the shared cache (Better Auth's own budget was each
 * process's until this file found it). Nothing of a
 * tenant's rows is kept in that cache (it holds rate windows and sign-in
 * state), and each process keeps only admission evidence that every read's
 * own snapshot fences, so no invalidation has to cross instances: this file
 * is the proof that none is missing.
 *
 * Live: TABLEWALK_TEST_PG names a server (this file makes and drops its own
 * database there). The cache is TABLEWALK_TEST_VALKEY when set, otherwise the
 * in-process double, which both processes reach over TCP like a real one. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serveCli } from './appApiCli.js';
import { startFakeValkey } from './support/fakeValkey.js';
import { tenantDepot } from './support/tenantDepot.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const VALKEY = process.env.TABLEWALK_TEST_VALKEY;

test(
  'two instances of a tenant App share one database and one cache: a write on one is what the other reads next',
  { skip: liveSkip('postgres', LIVE), timeout: 300000 },
  async (t) => {
    const fake = VALKEY ? undefined : await startFakeValkey();
    if (fake) t.after(() => fake.close());
    const depot = await tenantDepot(t, LIVE!, {
      services: [{ name: 'shared', kind: 'cache', url: VALKEY ?? fake!.url, insecure: true }],
    });
    const { call, administer } = depot;
    // One after the other: the first makes the sign-in store, the second meets it. In production,
    // where Better Auth limits its own routes: that limit is one of the things shared.
    const one = await serveCli(t, depot.args, { NODE_ENV: 'production' });
    const two = await serveCli(t, depot.args, { NODE_ENV: 'production' });
    // Ada signs up on instance one; her cookie is all instance two is shown.
    const ada = await depot.member(one, 'ada', 'north');
    const onOne = await depot.lease(one, ada, 'north'),
      onTwo = await depot.lease(two, ada, 'north');
    const list = async (on: typeof onOne) => {
      const reply = await on('/api/query', { table: 'item' });
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      return (reply.body.rows as Array<Record<string, unknown>>).map((row) => `${row.id}:${row.name}:${row.version}`).sort();
    };
    const record = async (on: typeof onOne, id: string) => {
      const reply = await on('/api/query', { table: 'item', filter: { groups: [[{ column: 'id', op: '=', value: id }]] } });
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      return (reply.body.rows as Array<Record<string, unknown>>)[0];
    };
    const count = async (on: typeof onOne) => Number((await on('/api/count', { table: 'item' })).body.count);
    // Both have read the list and the record once, so anything either kept would be stale next.
    assert.deepEqual(await list(onTwo), ['north-1:North one:0', 'north-2:North two:0']);
    assert.equal((await record(onTwo, 'north-1')).name, 'North one');
    assert.equal(await count(onTwo), 2);
    assert.deepEqual(await list(onOne), await list(onTwo));

    // An edit on one: the other's list and record read it next.
    const edited = await onOne('/api/update', { table: 'item', key: { id: 'north-1' }, values: { name: 'Renamed on one' } });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.deepEqual(await list(onTwo), ['north-1:Renamed on one:0', 'north-2:North two:0']);
    assert.equal((await record(onTwo, 'north-1')).name, 'Renamed on one');
    // An insert on two: one's list and count read it next.
    const added = await onTwo('/api/insert', { table: 'item', values: { id: 'north-3', name: 'Added on two' } });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.equal(await count(onOne), 3);
    assert.ok((await list(onOne)).includes('north-3:Added on two:0'));
    // A command on two: one's record reads the version it wrote.
    const ran = await onTwo('/api/commands/execute', {
      command: 'touch',
      commandVersion: 1,
      key: { id: 'north-2' },
      expectedVersion: 0,
      idempotencyKey: 'two-instances-0001',
      input: {},
    });
    assert.equal(ran.status, 200, JSON.stringify(ran.body));
    assert.equal(Number((await record(onOne, 'north-2')).version), 1);
    // The operator revokes Ada: both instances admitted her, and both refuse her next request.
    await administer((admin) =>
      admin.putMembership({
        tenantId: 'north',
        accountId: ada.id,
        membershipId: 'north-ada',
        status: 'revoked',
        roles: ['member'],
        validUntil: Date.now() + 600000,
        expectedVersion: '1',
      }),
    );
    for (const on of [onOne, onTwo]) {
      const refused = await on('/api/query', { table: 'item' });
      assert.ok(refused.status >= 400, `a revoked member is refused (${refused.status})`);
      assert.equal(refused.body.rows, undefined);
    }

    // Better Auth's budget for a sign-in (three in ten seconds from one address) is one budget across
    // both: four attempts, two on each, meet it, where two per process never would.
    const statuses: number[] = [];
    for (const origin of [one, two, one, two])
      statuses.push(
        (
          await call(
            origin,
            '/api/auth/sign-in/email',
            { email: 'ada@example.test', password: 'wrong-password-123!' },
            { 'x-forwarded-for': '203.0.113.9' },
          )
        ).status,
      );
    assert.deepEqual(statuses, [401, 401, 401, 429]);
  },
);
