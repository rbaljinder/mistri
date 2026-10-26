/**
 * Live sync on a tenant App, on the tenant proof (two tenants with equal
 * business ids, a member scoped to one location in each, a manager to both
 * in one): a member's stream on their lease is told of the changes in their
 * tenant and their scope, and of nothing in another tenant or outside their
 * scope — asserted on the bytes the stream carries.
 */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startTenantProof, type TenantProofFixture } from '../e2e/support/tenantProofServer.js';

type Context = { appId: string; accountId: string; tenantId: string; tabId: string; context: string; revision: number };
interface Event {
  event: string;
  data: any;
}

async function login(f: TenantProofFixture, role: 'member' | 'manager') {
  const account = f.accounts[role];
  const response = await fetch(`${f.origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { origin: f.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email: account.email, password: account.password }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const headers = (c: Context) => ({
    cookie,
    origin: f.origin,
    'x-mistri-account': c.accountId,
    'x-mistri-tab': c.tabId,
    'x-mistri-context': c.context,
    'x-mistri-lease-revision': String(c.revision),
  });
  const post = async (path: string, tenant: string, body: unknown, extra: Record<string, string> = { cookie, origin: f.origin }) => {
    const reply = await fetch(`${f.origin}${path}?app=${f.appId}&tenant=${tenant}`, {
      method: 'POST',
      headers: { ...extra, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    return { status: reply.status, body: (await reply.json()) as Record<string, any> };
  };
  const open = async (tenant: string): Promise<Context> => {
    const reply = await post('/api/tenant/context/open', tenant, {});
    assert.equal(reply.status, 200);
    return reply.body as Context;
  };
  const execute = async (c: Context, target: string, idempotencyKey: string) => {
    const reply = await post(
      '/api/commands/execute',
      c.tenantId,
      { command: f.model.command, commandVersion: 1, key: { id: target }, expectedVersion: 0, idempotencyKey, input: { body: 'Live.' } },
      headers(c),
    );
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.status, 'applied', JSON.stringify(reply.body));
    return reply.body.result as { eventId: string };
  };
  return { cookie, headers, open, execute };
}

async function follow(t: TestContext, f: TenantProofFixture, headers: Record<string, string>, tenant: string) {
  const controller = new AbortController();
  const response = await fetch(`${f.origin}/api/live?app=${f.appId}&tenant=${tenant}`, { headers, signal: controller.signal });
  let text = '';
  const done = (async () => {
    if (response.status !== 200 || !response.body) return;
    const decoder = new TextDecoder();
    try {
      for await (const chunk of response.body) text += decoder.decode(chunk as Uint8Array, { stream: true });
    } catch {
      /* aborted */
    }
  })();
  t.after(async () => {
    controller.abort();
    await done;
  });
  const events = (): Event[] =>
    text
      .split('\n\n')
      .filter((block) => block.startsWith('event: '))
      .map((block) => ({ event: block.slice(7, block.indexOf('\n')), data: JSON.parse(block.slice(block.indexOf('data: ') + 6)) }));
  const changes = () => events().filter((event) => event.event === 'change');
  const until = async (test: () => boolean, ms = 5000) => {
    const deadline = Date.now() + ms;
    while (!test() && Date.now() < deadline) await delay(20);
    assert.ok(test(), `timed out; the stream said: ${text}`);
  };
  if (response.status === 200) await until(() => events().some((event) => event.event === 'hello'));
  return { response, text: () => text, events, changes, until };
}

const SETTLE = 900;

test('a tenant member is told of changes in their own tenant and scope, and of none in another', { timeout: 120_000 }, async (t) => {
  const f = await startTenantProof('ignition', { live: true });
  t.after(() => f.stop());
  const member = await login(f, 'member');
  const manager = await login(f, 'manager');
  const north = await member.open('northstar');
  const south = await member.open('riverview');
  const managing = await manager.open('northstar');
  const managingSouth = await manager.open('riverview');

  const northern = await follow(t, f, member.headers(north), 'northstar');
  const southern = await follow(t, f, member.headers(south), 'riverview');
  // The lease the stream is on is said, as on every read of it.
  assert.equal(northern.response.headers.get('x-mistri-tenant'), 'northstar');
  assert.equal(northern.response.headers.get('x-mistri-context'), north.context);

  // A row of the member's tenant outside their scope (another location): nothing, and no byte names it.
  await manager.execute(managing, f.rows.north.otherTarget, 'live-other-target-0001');
  await delay(SETTLE);
  assert.deepEqual(northern.changes(), [], northern.text());
  assert.deepEqual(southern.changes(), [], southern.text());
  assert.doesNotMatch(northern.text() + southern.text(), /northstar-other|follow_up_id|tenant_id|location_id/);

  // In their scope: the target and the activity the command wrote, by key; the other tenant's stream hears nothing.
  const done = await manager.execute(managing, f.rows.north.target, 'live-main-target-0001');
  await northern.until(() => northern.changes().length === 1);
  const [told] = northern.changes();
  assert.deepEqual(told.data.tables, {
    [f.model.target]: { keys: [{ id: f.rows.north.target }], kinds: ['update'] },
    [f.model.event]: { keys: [{ id: done.eventId }], kinds: ['insert'] },
  });
  assert.equal(told.data.self, undefined);
  await delay(SETTLE);
  assert.deepEqual(southern.changes(), [], 'the same location in another tenant is another record');

  // The other tenant's own change reaches its stream alone.
  await manager.execute(managingSouth, f.rows.south.target, 'live-south-target-0001');
  await southern.until(() => southern.changes().length === 1);
  assert.deepEqual(Object.keys(southern.changes()[0].data.tables).sort(), [f.model.event, f.model.target].sort());
  await delay(SETTLE);
  assert.equal(northern.changes().length, 1);

  /* A read on the lease says the tables it answered from, as an App's own reads do, so a change asks again only the
     reads it touched. Without it the page asked every list and count on it again for every change. */
  const read = await fetch(`${f.origin}/api/run?app=${f.appId}&tenant=northstar`, {
    method: 'POST',
    headers: { ...member.headers(north), 'content-type': 'application/json' },
    body: JSON.stringify({ q: f.model.target, limit: 5, offset: 0 }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(read.status, 200, await read.clone().text());
  // A superset: the tables its row policy reads through are named with it (liveReads.ts).
  assert.ok(read.headers.get('mistri-reads')?.split(',').includes(f.model.target), String(read.headers.get('mistri-reads')));

  // A stream asks for its lease: none, or another account's, is refused, and says nothing.
  const bare = await fetch(`${f.origin}/api/live?app=${f.appId}&tenant=northstar`, {
    headers: { cookie: member.cookie, origin: f.origin },
  });
  assert.equal(bare.status, 400);
  const borrowed = await fetch(`${f.origin}/api/live?app=${f.appId}&tenant=northstar`, {
    headers: { ...member.headers(north), cookie: manager.cookie },
  });
  assert.ok(borrowed.status >= 400 && borrowed.status < 500, String(borrowed.status));
  assert.doesNotMatch(await borrowed.text(), /event:/);
});

test(
  'a tenant App that does not ask for live sync serves no stream, though its database holds the store',
  { timeout: 120_000 },
  async (t) => {
    const f = await startTenantProof('ignition', { live: 'unasked' });
    t.after(() => f.stop());
    const member = await login(f, 'member');
    const manager = await login(f, 'manager');
    const north = await member.open('northstar');
    const managing = await manager.open('northstar');
    const stream = await follow(t, f, member.headers(north), 'northstar');
    assert.equal(stream.response.status, 204);
    await manager.execute(managing, f.rows.north.target, 'live-unasked-target-0001');
    const again = await follow(t, f, member.headers(north), 'northstar');
    assert.equal(again.response.status, 204, 'a write does not turn it on');
  },
);
