/**
 * Many people arriving at a tenant App at once (`/api/tenant/enter`): every one of them is entered, none is
 * answered busy. A capacity run had twenty-five people arrive in one second on half a core; each arrival's discovery
 * queued for readers behind all the others', sixteen waited past the pool's two-second limit and were answered 503
 * `tenant_temporarily_unavailable`, and asked again into the same queue (tenantArrivals.ts). Here a pool of one
 * reader twenty milliseconds from its database stands in for the saturated one.
 *
 * Live and opt-in: TABLEWALK_TEST_PG names a disposable server, and the fixture works in databases of its own
 * (ignitionLendingFixture.ts).
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { configureServerSettings, serverSettings } from '../packages/engine/src/adapters/serverSettings.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { createNativeAccount } from '../packages/mistri/src/server/auth/authAccounts.js';
import { createTenantAuthenticatedHttpServer } from '../packages/mistri/src/server/tenant/tenantAuthenticatedHttp.js';
import { prepareTenantStartup } from '../packages/mistri/src/server/tenant/tenantStartup.js';
import { arrivalGate, arrivalWidth } from '../packages/mistri/src/server/tenant/tenantArrivals.js';
import { startLatencyProxy } from '../e2e/support/latencyProxy.js';
import { liveSkip } from './live.js';
import { IGNITION_DIR, openIgnitionLending } from './support/ignitionLendingFixture.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const password = 'Ignition-arrivals-password-123!';
const PEOPLE = 8;

async function reservePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

/** Ignition served in this process on a one-reader pool through a relay that holds each chunk `delay` ms, and `PEOPLE` signed-in dealership staff. */
async function deploy(t: TestContext, delay: number) {
  const previous = { readers: serverSettings().readers, xdg: process.env.XDG_CONFIG_HOME, secret: process.env.BETTER_AUTH_SECRET };
  configureServerSettings({ readers: 1 });
  const directory = mkdtempSync(join(tmpdir(), 'mistri-tenant-arrivals-'));
  process.env.XDG_CONFIG_HOME = directory;
  process.env.BETTER_AUTH_SECRET = 'synthetic-ignition-arrivals-secret-at-least-thirty-two';
  t.after(() => {
    configureServerSettings({ readers: previous.readers });
    rmSync(directory, { recursive: true, force: true });
    if (previous.xdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous.xdg;
    if (previous.secret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = previous.secret;
  });
  const lending = await openIgnitionLending(t, 'postgres', { events: true });
  const relay = await startLatencyProxy(LIVE!, 0);
  t.after(() => relay.close());

  const loaded = await loadApp(IGNITION_DIR);
  const port = await reservePort(),
    origin = `http://127.0.0.1:${port}`;
  const auth = await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin] });
  t.after(() => auth.close());
  const tenants = ['north-motors', 'harbor-auto'];
  const people: Array<{ email: string; accountId: string }> = [];
  for (let i = 0; i < PEOPLE; i += 1) {
    const tenant = tenants[i % tenants.length];
    const email = `arriving.${i}@${tenant}.example.invalid`;
    const accountId = await createNativeAccount(auth, { email, name: `Arriving ${i}`, password }, { by: 'maintenance' });
    await lending.maintenance((admin) =>
      admin.putMembership({
        tenantId: tenant,
        accountId,
        membershipId: `${tenant}:arriving-${i}`,
        roles: ['dealer_staff'],
        status: 'active',
        validUntil: lending.validUntil,
        expectedVersion: null,
      }),
    );
    people.push({ email, accountId });
  }

  const prepared = await prepareTenantStartup({
    loaded,
    connections: [
      { id: 'loans', name: 'loans', url: relay.route(lending.source.url!), source: 'config', writable: true },
      { id: 'applicants', name: 'applicants', url: relay.route(lending.platformSources[0].url!), source: 'config' },
    ],
    policyFile: join(IGNITION_DIR, 'tenant-policy.ts'),
    commandsFile: join(IGNITION_DIR, 'commands.ts'),
  });
  const owner = await createTenantAuthenticatedHttpServer({
    loaded,
    auth,
    enrollment: prepared.enrollment,
    bound: { host: '127.0.0.1', port },
  });
  t.after(async () => {
    owner.server.closeAllConnections();
    await owner.retire();
  });
  owner.server.listen(port, '127.0.0.1');
  await once(owner.server, 'listening');

  const call = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(origin + path, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      redirect: 'manual',
    });
    return { status: response.status, headers: response.headers, text: await response.text() };
  };
  const identities = [];
  for (const person of people) {
    const signedIn = await call('/api/auth/sign-in/email', { email: person.email, password });
    assert.equal(signedIn.status, 200, signedIn.text);
    const cookie = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    identities.push({ cookie, 'x-mistri-account': person.accountId, 'x-mistri-app': 'ignition' });
  }
  /* Signed in at no distance; arriving at `delay`. */
  relay.setDelay(delay);
  const enter = (identity: Record<string, string>) =>
    call('/api/tenant/enter?app=ignition', { path: '/ignition/leads', search: '' }, identity);
  return { identities, enter };
}

describe('tenant arrivals on PostgreSQL', { skip: liveSkip('postgres', LIVE) }, () => {
  test('people arriving at once on a busy pool are each entered, none answered busy', { timeout: 120_000 }, async (t) => {
    const f = await deploy(t, 20);
    const answers = await Promise.all(f.identities.map((identity) => f.enter(identity)));
    const statuses = answers.map((answer) => answer.status);
    assert.deepEqual(
      statuses,
      answers.map(() => 200),
      answers
        .filter((answer) => answer.status !== 200)
        .map((answer) => `${answer.status} ${answer.text}`)
        .join('\n'),
    );
    for (const answer of answers) assert.ok((JSON.parse(answer.text) as { entered?: unknown }).entered, answer.text);
  });
});

describe('the arrival gate', () => {
  test('lets `width` in at once, the rest in arrival order as each finishes', async () => {
    const gate = arrivalGate(2, 10_000);
    const order: number[] = [];
    const signal = new AbortController().signal;
    const turns = [0, 1, 2, 3].map((i) =>
      gate.admit(signal).then((release) => {
        order.push(i);
        return release;
      }),
    );
    const [first, second] = await Promise.all(turns.slice(0, 2));
    assert.deepEqual([gate.running, gate.waiting], [2, 2]);
    second();
    second(); // a release counts once
    const third = await turns[2];
    assert.deepEqual([gate.running, gate.waiting], [2, 1]);
    first();
    const fourth = await turns[3];
    third();
    fourth();
    assert.deepEqual(order, [0, 1, 2, 3]);
    assert.deepEqual([gate.running, gate.waiting], [0, 0]);
  });

  test('answers busy one that waited too long, one past the line, and lets out one that left', async () => {
    const gate = arrivalGate(1, 30, 1);
    const signal = new AbortController().signal;
    const held = await gate.admit(signal);
    const late = gate.admit(signal);
    await assert.rejects(gate.admit(signal), { code: 'tenant_temporarily_unavailable' });
    await assert.rejects(late, { code: 'tenant_temporarily_unavailable' });
    const leaving = new AbortController();
    const left = gate.admit(leaving.signal);
    leaving.abort();
    await assert.rejects(left, { code: 'tenant_temporarily_unavailable' });
    assert.equal(gate.waiting, 0);
    held();
    assert.equal(gate.running, 0);
  });

  test('is half the readers wide, at least one', () => {
    assert.deepEqual(
      [1, 2, 3, 4, 16].map((readers) => arrivalWidth(readers)),
      [1, 1, 2, 2, 8],
    );
  });
});
