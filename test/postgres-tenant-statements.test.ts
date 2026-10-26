/**
 * What a tenant request costs, and what it still refuses, on Ignition
 * deployed on PostgreSQL the way an operator starts it: `prepareTenantStartup`
 * with the sample's own policy and commands, native auth in its file store,
 * and the authenticated tenant host, in this process so its statements can be
 * counted (support/sqlCount.ts) on both engines a request touches — the
 * lending database and the auth store.
 *
 * A tenant read is fenced, and each fence is a statement somewhere: the
 * membership in the snapshot the rows come from, the session at every step,
 * the membership again before release. The first case holds that it is those
 * and not more — that a list is not thirteen snapshots each describing the
 * whole catalog again, and that the session is not resolved afresh at every
 * step. The others hold that what was taken out still refuses what it
 * refused: a session signed out, or a membership revoked, while a list is
 * being read withholds that list; two dealerships on one host each read only
 * their own.
 *
 * Live and opt-in: TABLEWALK_TEST_PG names a disposable server, and the
 * fixture works in databases of its own (ignitionLendingFixture.ts).
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { PgConnectionManager, type PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { createNativeAccount } from '../packages/mistri/src/server/auth/authAccounts.js';
import type { ConnectionConfig } from '../packages/engine/src/server/connections.js';
import { createTenantAuthenticatedHttpServer } from '../packages/mistri/src/server/tenant/tenantAuthenticatedHttp.js';
import { prepareTenantStartup } from '../packages/mistri/src/server/tenant/tenantStartup.js';
import { liveSkip } from './live.js';
import { IGNITION_DIR, openIgnitionLending } from './support/ignitionLendingFixture.js';
import { countStatements, type PgClientClass } from './support/sqlCount.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
/* A pooled connection's session SETs are the pool's, paid once per physical
   connection (statement-counts.test.ts says the same). */
const SESSION = /^SET (default_transaction_read_only|statement_timeout)\b/;
const password = 'Ignition-statements-password-123!';
const list = { q: 'loan_application', limit: 500 };

async function reservePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}
type Answer = { status: number; headers: Headers; text: string; body: Record<string, unknown> };
function deferred() {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => {
      resolve = done;
    }),
    resolve,
  };
}

/** Ignition served in this process, two dealer admins each in their own dealership. */
async function deploy(t: TestContext) {
  const lending = await openIgnitionLending(t, 'postgres', { events: true });
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-statements-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const previous = { xdg: process.env.XDG_CONFIG_HOME, secret: process.env.BETTER_AUTH_SECRET };
  process.env.XDG_CONFIG_HOME = directory;
  process.env.BETTER_AUTH_SECRET = 'synthetic-ignition-statements-secret-at-least-thirty-two';
  t.after(() => {
    if (previous.xdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous.xdg;
    if (previous.secret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = previous.secret;
  });

  const loaded = await loadApp(IGNITION_DIR);
  const port = await reservePort(),
    origin = `http://127.0.0.1:${port}`;
  const auth = await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin] });
  t.after(() => auth.close());
  const people = {
    north: { email: 'counted.admin@north.example.invalid', tenant: 'north-motors' },
    harbor: { email: 'counted.admin@harbor.example.invalid', tenant: 'harbor-auto' },
  };
  const accounts = new Map<string, string>();
  for (const [name, person] of Object.entries(people)) {
    const accountId = await createNativeAccount(auth, { email: person.email, name: `Counted ${name}`, password }, { by: 'maintenance' });
    accounts.set(name, accountId);
    await lending.maintenance((admin) =>
      admin.putMembership({
        tenantId: person.tenant,
        accountId,
        membershipId: `${person.tenant}:counted`,
        roles: ['dealer_admin'],
        status: 'active',
        validUntil: lending.validUntil,
        expectedVersion: null,
      }),
    );
  }

  const connections: ConnectionConfig[] = [
    { id: 'loans', name: 'loans', url: lending.source.url!, source: 'config', writable: true },
    { id: 'applicants', name: 'applicants', url: lending.platformSources[0].url!, source: 'config' },
  ];
  const prepared = await prepareTenantStartup({
    loaded,
    connections,
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
  const specifier = 'pg';
  const pg = ((await import(specifier)) as { default: { Client: PgClientClass } }).default;
  const counter = countStatements(owner.server, pg.Client);
  t.after(() => counter.restore());
  owner.server.listen(port, '127.0.0.1');
  await once(owner.server, 'listening');

  const call = async (path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> => {
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'manual',
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };
  /** Signed in, with a context open in the person's own dealership. */
  const enter = async (name: keyof typeof people) => {
    const person = people[name],
      accountId = accounts.get(name)!;
    const signedIn = await call('/api/auth/sign-in/email', { email: person.email, password });
    assert.equal(signedIn.status, 200, signedIn.text);
    const cookie = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const identity = { cookie, 'x-mistri-account': accountId };
    const select = (path: string) => `${path}?app=ignition&tenant=${person.tenant}`;
    const opened = await call(select('/api/tenant/context/open'), {}, identity);
    assert.equal(opened.status, 200, opened.text);
    const lease = {
      ...identity,
      'x-mistri-tab': String(opened.body.tabId),
      'x-mistri-context': String(opened.body.context),
      'x-mistri-lease-revision': String(opened.body.revision),
    };
    return {
      tenant: person.tenant,
      accountId,
      cookie,
      read: (path: string, body?: unknown) => call(select(path), body, lease),
      signOut: () => call('/api/auth/sign-out', {}, { cookie }),
      revoke: () =>
        lending.maintenance((admin) =>
          admin.putMembership({
            tenantId: person.tenant,
            accountId,
            membershipId: `${person.tenant}:counted`,
            roles: ['dealer_admin'],
            status: 'revoked',
            validUntil: lending.validUntil,
            expectedVersion: '1',
          }),
        ),
    };
  };
  /** The dealership's own applications, read on the control connection. */
  const own = async (tenant: string) =>
    (await lending.rows('SELECT id FROM loan_application WHERE tenant_id = ? ORDER BY id', [tenant])).map((row) => String(row.id));
  return { counter, enter, own };
}

/** Hold the first scoped read of `loan_application` on a tenant reader until released. */
function holdFirstList(t: TestContext) {
  const reached = deferred(),
    release = deferred();
  let held = false;
  const original = PgConnectionManager.prototype.withReadClient;
  const mock = t.mock.method(PgConnectionManager.prototype, 'withReadClient', function <
    T,
  >(this: PgConnectionManager, run: (client: PgQuery) => Promise<T>, destroyAfter = false, drainCancelled = false): Promise<T> {
    const lease = original.bind(this) as <Result>(
      callback: (client: PgQuery) => Promise<Result>,
      destroy?: boolean,
      drain?: boolean,
    ) => Promise<Result>;
    return lease(
      (client) =>
        run(
          Object.freeze({
            query: ((text: string, values?: unknown[]) => {
              if (
                held ||
                typeof text !== 'string' ||
                !text.startsWith('WITH "_tw_scope') ||
                !text.includes('"public"."loan_application"')
              ) {
                return client.query(text, values);
              }
              held = true;
              reached.resolve();
              return release.promise.then(() => client.query(text, values));
            }) as PgQuery['query'],
          }),
        ),
      destroyAfter,
      drainCancelled,
    );
  });
  return { reached: reached.promise, release: release.resolve, restore: () => mock.mock.restore() };
}
function withheld(reply: Answer) {
  assert.ok(reply.status >= 400, reply.text);
  assert.equal('rows' in reply.body, false, 'no row of the list is released');
}
const ids = (reply: Answer) => {
  assert.equal(reply.status, 200, reply.text);
  assert.ok(Array.isArray(reply.body.rows), reply.text);
  return (reply.body.rows as Array<Record<string, unknown>>).map((row) => String(row.id)).sort();
};

describe('tenant requests on Ignition (PostgreSQL)', { skip: liveSkip('postgres', LIVE) }, () => {
  test('a tenant list and a metadata read stay within their statement budgets', async (t) => {
    const f = await deploy(t),
      north = await f.enter('north');
    const counted = async (path: string, body?: unknown) => {
      f.counter.clear();
      const reply = await north.read(path, body);
      assert.equal(reply.status, 200, reply.text);
      return { reply, business: f.counter.on(path, 'postgres').filter((sql) => !SESSION.test(sql)), auth: f.counter.on(path, 'sqlite') };
    };
    // Warm: the first read after start may open the reader pool's connections.
    await counted('/api/run', list);

    const rows = await counted('/api/run', list);
    assert.ok(Array.isArray(rows.reply.body.rows) && rows.reply.body.rows.length > 0, rows.reply.text);
    const metadata = await counted('/api/app');
    t.diagnostic(
      `tenant /api/run: ${rows.business.length} business + ${rows.auth.length} auth statements; ` +
        `/api/app: ${metadata.business.length} + ${metadata.auth.length}`,
    );
    if (process.env.TABLEWALK_STATEMENTS_VERBOSE) {
      for (const [name, counts] of [
        ['/api/run', rows],
        ['/api/app', metadata],
      ] as const) {
        console.log(`--- ${name}`);
        for (const sql of [...counts.business, ...counts.auth.map((sql) => `[auth] ${sql}`)])
          console.log(sql.replace(/\s+/g, ' ').slice(0, 160));
      }
    }
    /* A snapshot is three messages, each one round trip: BEGIN with the
       relation locks and the catalog digest, the membership, and COMMIT,
       which the caller does not wait for. The login's admission is kept from
       the reads before (tenantAdmissionCache.ts), so a list is three
       snapshots: one each for its rows and its count, and the release
       fence's, so nine messages and its two reads. A metadata read is the
       release fence and, where the policy names a tenant's intake or public
       address (Ignition's dealer intake), that address read fresh:
       BEGIN, the address, the check that no other tenant holds it, and COMMIT.
       It is the discovery reader's, a cross-tenant source with its own lease
       and snapshot (tenantEnrollment.ts), so it cannot ride the tenant
       reader's fence. The digest names `information_schema` among the schemas
       it leaves out; a description reads from it. */
    assert.equal(
      rows.business.filter((sql) => /information_schema\.|SAVEPOINT/.test(sql)).length,
      0,
      'an unchanged catalog is neither described nor its store attested again',
    );
    assert.ok(rows.business.length <= 11, `a tenant list is ${rows.business.length} business messages`);
    assert.ok(metadata.business.length <= 3 + 4, `a tenant metadata read is ${metadata.business.length} business messages`);
    // The auth store: the session resolved once per request, then its row observed at each fence.
    assert.ok(rows.auth.length <= 20, `a tenant list is ${rows.auth.length} auth statements`);
    assert.ok(metadata.auth.length <= 10, `a tenant metadata read is ${metadata.auth.length} auth statements`);
    assert.equal(
      rows.auth.filter((sql) => /from "session" where "session"\."token"/.test(sql)).length,
      1,
      'the cookie resolved to its session once in the request',
    );
  });

  test('two dealerships on one host, their requests interleaved, each read only their own applications', async (t) => {
    const f = await deploy(t),
      north = await f.enter('north'),
      harbor = await f.enter('harbor');
    const [northOwn, harborOwn] = [await f.own(north.tenant), await f.own(harbor.tenant)];
    assert.ok(northOwn.length && harborOwn.length);
    for (let round = 0; round < 3; round++) {
      const [a, b, c, d] = await Promise.all([
        north.read('/api/run', list),
        harbor.read('/api/run', list),
        harbor.read('/api/run', list),
        north.read('/api/run', list),
      ]);
      assert.deepEqual(ids(a), northOwn);
      assert.deepEqual(ids(d), northOwn);
      assert.deepEqual(ids(b), harborOwn);
      assert.deepEqual(ids(c), harborOwn);
    }
  });

  test('a session signed out while a list is being read withholds the list, and its cookie reads nothing after', async (t) => {
    const f = await deploy(t),
      north = await f.enter('north'),
      harbor = await f.enter('harbor');
    const hold = holdFirstList(t);
    const pending = north.read('/api/run', list);
    await hold.reached;
    const out = await north.signOut();
    assert.equal(out.status, 200, out.text);
    hold.release();
    withheld(await pending);
    hold.restore();
    withheld(await north.read('/api/run', list));
    assert.deepEqual(ids(await harbor.read('/api/run', list)), await f.own(harbor.tenant), 'the other login is untouched');
  });

  test('a membership revoked while a list is being read withholds the list', async (t) => {
    const f = await deploy(t),
      north = await f.enter('north');
    assert.deepEqual(ids(await north.read('/api/run', list)), await f.own(north.tenant), 'primed: read from the cached attestation');
    const hold = holdFirstList(t);
    const pending = north.read('/api/run', list);
    await hold.reached;
    await north.revoke();
    hold.release();
    withheld(await pending);
    hold.restore();
    withheld(await north.read('/api/run', list));
  });
});
