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
import { startLatencyProxy, type LatencyProxy } from '../e2e/support/latencyProxy.js';
import { captureCounters } from '../packages/engine/src/server/evidence.js';
import { rowScopeCounters } from '../packages/engine/src/shared/rowScope.js';
import { setServerTiming } from '../packages/engine/src/adapters/telemetry/serverTiming.js';
import { allocationMeter } from './support/allocationMeter.js';

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
const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
function deferred() {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => {
      resolve = done;
    }),
    resolve,
  };
}

/** Ignition served in this process, two dealer admins each in their own dealership; through `relay` when it is given. */
async function deploy(t: TestContext, relay?: LatencyProxy) {
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

  const routed = (url: string) => (relay ? relay.route(url) : url);
  const connections: ConnectionConfig[] = [
    { id: 'loans', name: 'loans', url: routed(lending.source.url!), source: 'config', writable: true },
    { id: 'applicants', name: 'applicants', url: routed(lending.platformSources[0].url!), source: 'config' },
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
  return { counter, enter, own, call };
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

/* What each statement is for. A message may carry several — a snapshot's BEGIN carries its relation locks, the
   catalog digest when the attestation is due, and the membership — so a message is split where a `;` begins the
   next statement, and each statement counted for its purpose. */
const PURPOSES = ['transaction', 'pin', 'catalog', 'membership', 'store', 'business', 'other'] as const;
type Purpose = (typeof PURPOSES)[number];
const purposeOf = (statement: string): Purpose =>
  /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(statement)
    ? 'transaction'
    : /^LOCK TABLE\b/i.test(statement)
      ? 'pin'
      : /mistri\."tenant_(tenant|membership)"/.test(statement)
        ? 'membership'
        : /\b(information_schema|pg_catalog|pg_class|pg_attribute|pg_namespace|pg_constraint)\b/.test(statement)
          ? 'catalog'
          : /\bmistri\.|pg_advisory/.test(statement)
            ? 'store'
            : /"public"\./.test(statement)
              ? 'business'
              : 'other';
const statementsOf = (message: string): string[] =>
  message
    .split(/;\s+(?=(?:BEGIN|COMMIT|ROLLBACK|LOCK|SELECT|WITH|INSERT|UPDATE|DELETE|SAVEPOINT|RELEASE|SET)\b)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
interface Cost {
  messages: number;
  transactions: number;
  /** Round trips, counted off the wire: what one connection sent together before the server said it was ready. */
  flights: number;
  /** Flights that were only a membership read: a round trip of its own, where it could ride a BEGIN. */
  aloneMembership: number;
  statements: Record<Purpose, number>;
}
const costOf = (messages: readonly string[], flights: number): Cost => {
  const statements = Object.fromEntries(PURPOSES.map((purpose) => [purpose, 0])) as Record<Purpose, number>;
  let transactions = 0;
  for (const message of messages) {
    for (const statement of statementsOf(message)) {
      statements[purposeOf(statement)] += 1;
      if (/^BEGIN\b/i.test(statement)) transactions += 1;
    }
  }
  return { messages: messages.length, transactions, flights, aloneMembership: 0, statements };
};
const sumOf = (costs: readonly Cost[]): Cost =>
  costs.reduce((total, cost) => ({
    messages: total.messages + cost.messages,
    transactions: total.transactions + cost.transactions,
    flights: total.flights + cost.flights,
    aloneMembership: total.aloneMembership + cost.aloneMembership,
    statements: Object.fromEntries(PURPOSES.map((purpose) => [purpose, total.statements[purpose] + cost.statements[purpose]])) as Record<
      Purpose,
      number
    >,
  }));
const sayCost = (cost: Cost) =>
  `${cost.messages} messages, ${cost.flights} flights, ${cost.transactions} transactions (` +
  PURPOSES.filter((purpose) => cost.statements[purpose])
    .map((purpose) => `${purpose} ${cost.statements[purpose]}`)
    .join(', ') +
  ')';

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
    /* A snapshot is two messages: BEGIN with the relation locks (the
       catalog digest when the attestation is due) and the membership, and
       COMMIT, which the caller does not wait for; a read rides behind the
       BEGIN. The login's admission is kept from the reads before
       (tenantAdmissionCache.ts), so a list is three snapshots: one each for
       its rows and its count, and the release fence's, so six messages and
       its two reads. A metadata read is the
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
    assert.ok(rows.business.length <= 8, `a tenant list is ${rows.business.length} business messages`);
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

  test('a list, a record page and a save stay within their budgets, by purpose and by round trip', async (t) => {
    /* Through a relay that holds nothing (delay 0), only to count each connection's flights: on a database 23 ms
       away each flight is 23 ms, so a flight is what a request's cost is measured in, not a statement. */
    const relay = await startLatencyProxy(LIVE!, 0);
    t.after(() => relay.close());
    const f = await deploy(t, relay),
      north = await f.enter('north');
    const lead = (n: number) => ({ id: `north-motors:lead:000${n}` });
    const page = (n: number) => ({ page: 'lead', key: lead(n), rows: 10 });
    /** The requests `asked` makes together, each costed on its own path; flights are the whole burst's. */
    const burst = async (asked: () => Promise<Answer[]>, paths: readonly string[]) => {
      f.counter.clear();
      const since = Date.now();
      const replies = await asked();
      for (const reply of replies) assert.equal(reply.status, 200, reply.text);
      // A COMMIT is not waited on: let the last one land before its flight is counted.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const flown = new Map<string, string[]>();
      for (const statement of relay.statements(since)) {
        const flight = `${statement.connection}:${statement.flight}`;
        flown.set(flight, [...(flown.get(flight) ?? []), ...statementsOf(statement.text)]);
      }
      const aloneMembership = [...flown.values()].filter((sent) => sent.every((statement) => purposeOf(statement) === 'membership')).length;
      const costs = paths.map((path) =>
        costOf(
          f.counter.on(path, 'postgres').filter((sql) => !SESSION.test(sql)),
          0,
        ),
      );
      return { replies, cost: { ...sumOf(costs), flights: flown.size, aloneMembership } };
    };
    const prepare = (n: number, command = 'qualifyLead') =>
      north.read('/api/commands/prepare', { command, commandVersion: 1, key: lead(n) });
    const save = async (n: number) => {
      const prepared = await burst(async () => [await prepare(n)], ['/api/commands/prepare']);
      const expectedVersion = (prepared.replies[0]!.body as { expectedVersion?: number }).expectedVersion;
      const executed = await burst(
        async () => [
          await north.read('/api/commands/execute', {
            command: 'qualifyLead',
            commandVersion: 1,
            key: lead(n),
            expectedVersion,
            idempotencyKey: `tenant-statements-qualify-000${n}`,
            input: {},
          }),
        ],
        ['/api/commands/execute'],
      );
      assert.equal(executed.replies[0]!.body.status, 'applied', executed.replies[0]!.text);
      // What the page asks once the save has answered: the record again, the converted check, the next verb.
      const settled = await burst(
        () =>
          Promise.all([
            north.read('/api/pages/compose', page(n)),
            north.read('/api/run', { q: `lead id = "${lead(n).id}" and status = converted`, limit: 1, offset: 0, count: 'none' }),
            prepare(n, 'convertLead'),
          ]),
        ['/api/pages/compose', '/api/run', '/api/commands/prepare'],
      );
      return {
        prepare: prepared.cost,
        execute: executed.cost,
        settle: settled.cost,
        total: sumOf([prepared.cost, executed.cost, settled.cost]),
      };
    };
    /** A create: the lead `save` qualified converted into an application, the command's execute costed alone. */
    const convert = async (n: number) => {
      const prepared = await prepare(n, 'convertLead');
      assert.equal(prepared.status, 200, prepared.text);
      const executed = await burst(
        async () => [
          await north.read('/api/commands/execute', {
            command: 'convertLead',
            commandVersion: 1,
            key: lead(n),
            expectedVersion: (prepared.body as { expectedVersion?: number }).expectedVersion,
            idempotencyKey: `tenant-statements-convert-000${n}`,
            input: {},
          }),
        ],
        ['/api/commands/execute'],
      );
      assert.equal(executed.replies[0]!.body.status, 'applied', executed.replies[0]!.text);
      return executed.cost;
    };
    // Warm: the readers' connections, the writer's, and the catalog's attestation are each paid once, on first use.
    await burst(async () => [await north.read('/api/run', list)], ['/api/run']);
    await burst(async () => [await north.read('/api/pages/compose', page(1))], ['/api/pages/compose']);
    await save(1);
    await convert(1);

    const listed = (await burst(async () => [await north.read('/api/run', list)], ['/api/run'])).cost;
    const record = (await burst(async () => [await north.read('/api/pages/compose', page(2))], ['/api/pages/compose'])).cost;
    const saved = await save(2);
    const created = await convert(2);
    t.diagnostic(`tenant list: ${sayCost(listed)}`);
    t.diagnostic(`record page: ${sayCost(record)}`);
    for (const step of ['prepare', 'execute', 'settle', 'total'] as const) t.diagnostic(`save ${step}: ${sayCost(saved[step])}`);
    t.diagnostic(`create execute: ${sayCost(created)}`);

    /* A member's snapshot is BEGIN, its locks and its membership in one message, the read sent behind it in the same
       flight, and a COMMIT no one waits for (tenantReadSource.ts `on`): no membership read is a round trip of its own. */
    for (const [name, cost] of [
      ['list', listed],
      ['record page', record],
      ['save', saved.total],
    ] as const)
      assert.equal(cost.aloneMembership, 0, `${name}: a membership read went alone`);
    /* A list is its rows' snapshot, its count's and its release fence's: three transactions, eight messages
       (each BEGIN carrying its membership, two reads, three COMMITs). It was eleven, each membership a message. */
    assert.ok(listed.transactions <= 3, `a tenant list is ${listed.transactions} transactions`);
    assert.ok(listed.messages <= 8, `a tenant list is ${listed.messages} messages`);
    assert.ok(listed.flights <= 7, `a tenant list is ${listed.flights} flights`);
    /* A record page: its zone, its sections, the release fence of their reads, the actions' advice in one snapshot
       with every guard sent at once, and that advice's own fence — no second admission after it
       (tenantContexts.ts, availability). It was forty-six messages in eleven transactions. */
    assert.ok(record.transactions <= 10, `a record page is ${record.transactions} transactions`);
    assert.ok(record.statements.membership <= 10, `a record page reads the membership ${record.statements.membership} times`);
    assert.ok(record.messages <= 34, `a record page is ${record.messages} messages`);
    assert.ok(record.flights <= 24, `a record page is ${record.flights} flights`);
    /* A save: prepare, execute (one pipelined transaction), and what the page reads after it. It was seventy-six
       messages in sixteen transactions. */
    assert.ok(saved.execute.transactions === 1, `an execute is ${saved.execute.transactions} transactions`);
    /* An update's execute is three round trips, the floor for a handler that reads what its UPDATE answers: the
       opening (BEGIN with its fence, the receipt lookup, the target's lock and row), the UPDATE with the row read back
       behind it, and the receipt with the COMMIT. */
    assert.ok(saved.execute.flights <= 3, `an update's execute is ${saved.execute.flights} flights`);
    /* A create (convertLead): the opening; the handler's own two reads, each waiting on the one before (the vehicle by
       its stock number, then its applications); the INSERT; the new row's lock and read back with every reference it
       makes checked in the same flight (scopedTransaction.ts); the lead read once, in full, under the lock the
       opening took, which answers its machine, its audit and its guard (keyRows.ts `widen`); its UPDATE with the read
       back; and the receipt, its event and the notification with the COMMIT. It was twenty-three: each reference two
       round trips of its own, the lead read four times. */
    assert.equal(created.transactions, 1, `a create's execute is ${created.transactions} transactions`);
    assert.ok(created.flights <= 8, `a create's execute is ${created.flights} flights`);
    assert.ok(saved.total.transactions <= 15, `a save is ${saved.total.transactions} transactions`);
    assert.ok(saved.total.messages <= 62, `a save is ${saved.total.messages} messages`);
    assert.ok(saved.total.flights <= 40, `a save is ${saved.total.flights} flights`);
    assert.equal(record.statements.catalog + listed.statements.catalog, 0, 'a warm catalog is not described again');
  });

  /* A first page past who-am-I was three requests one after another — the person's tenants, a lease, the page's boot
     on it — each its own admission (a field report: 0.6 s of a 2.4 s list on a database 23 ms away). Someone in one
     dealership is entered with all three in one (`/api/tenant/enter`, shared/tenantBoot.ts). Counted, not timed: each
     response's Server-Timing says how many flights (round trips to the database) it made, and the three apart are
     the sum of their three. It was inferred from the time a delayed relay added, which a loaded machine, or CI's
     parallel lane, moves by a round trip either way. */
  test("a first page's entry is one request, its round trips fewer than the three it folds", async (t) => {
    setServerTiming(true);
    t.after(() => setServerTiming(false));
    const f = await deploy(t),
      north = await f.enter('north');
    const identity = { cookie: north.cookie, 'x-mistri-account': north.accountId };
    const record = `/ignition/leads/${encodeURIComponent('north-motors:lead:0002')}`;
    /* The flights of every request made since the tally was last cleared. */
    let tally = 0;
    const counted = (reply: Answer) => {
      for (const match of (reply.headers.get('server-timing') ?? '').matchAll(/(?:^|, )db-[a-z-]+;[^,]*?desc="flights=(\d+)/g))
        tally += Number(match[1]);
      return reply;
    };
    const call = async (...args: Parameters<typeof f.call>) => counted(await f.call(...args));
    /* Each lease a step opens, let go once it is counted, as a page leaving lets its own go: the account's contexts are
       bounded, and a held one is not given up for another. */
    const opened: Record<string, unknown>[] = [];
    const letGo = async () => {
      for (const lease of opened.splice(0))
        await f.call(
          '/api/tenant/context/release?app=ignition',
          { tabId: lease.tabId, expectedContext: lease.context, expectedRevision: lease.revision },
          identity,
        );
    };
    const holding = (reply: Answer) => {
      const lease = 'entered' in reply.body ? object(object(reply.body.entered).context) : reply.body.tabId ? reply.body : undefined;
      if (lease) opened.push(lease);
      return reply;
    };
    /* The three as the page asked them before, one after another, the boot on the lease just opened. */
    const apart = async (path: string) => {
      const found = await call('/api/tenant/bootstrap?app=ignition', undefined, identity);
      assert.equal(found.status, 200, found.text);
      const lease = holding(await call(`/api/tenant/context/open?app=ignition&tenant=${north.tenant}`, {}, identity));
      assert.equal(lease.status, 200, lease.text);
      return call(
        `/api/boot?app=ignition&tenant=${north.tenant}`,
        { path, search: '' },
        {
          ...identity,
          'x-mistri-tab': String(lease.body.tabId),
          'x-mistri-context': String(lease.body.context),
          'x-mistri-lease-revision': String(lease.body.revision),
        },
      );
    };
    const steps: Record<string, () => Promise<Answer>> = {
      'apart (list)': () => apart('/ignition/leads'),
      'apart (record)': () => apart(record),
      'enter (list)': async () => holding(await call('/api/tenant/enter?app=ignition', { path: '/ignition/leads', search: '' }, identity)),
      'enter (record)': async () => holding(await call('/api/tenant/enter?app=ignition', { path: record, search: '' }, identity)),
    };
    for (const ask of Object.values(steps)) {
      await ask(); // warm: connections, attestation, the App's payload
      await letGo();
    }
    /* The catalog's digest is re-attested once per window, by whichever request comes then: a flight paid once, not
       per request, which a measurement can land on (as the flights test found). Counts are otherwise exact, so each
       step is asked three times and its fewest flights kept. */
    const trips: Record<string, number> = {};
    for (const [name, ask] of Object.entries(steps)) {
      const counts: number[] = [];
      for (let sample = 0; sample < 3; sample++) {
        tally = 0;
        const reply = await ask();
        assert.equal(reply.status, 200, reply.text);
        if ('entered' in reply.body) assert.ok(object(object(reply.body.entered).boot).reads, reply.text);
        counts.push(tally);
        await letGo();
      }
      trips[name] = Math.min(...counts);
      t.diagnostic(`${name}: ${trips[name]} flights (samples ${counts.join(', ')})`);
    }
    /* Entering: the boot reads on the evidence its lease's open just kept rather than admitting again, its room's
       reads are planned and asked as the App's metadata is, beside it, and a tenant's own address is one statement
       with its resolution. Flights are counted, not the depth they are waited in: the entry makes as many as the three
       it folds (measured 14 and 18), and what it saves is waiting on them one request after another, which only a
       delayed relay shows and a loaded machine blurs. So the rule here is entry <= apart, and a budget at the count
       measured, as the flights test holds; the three apart used to cost more flights and the entry was strictly less. */
    const entering = { list: 14, record: 18 };
    for (const page of ['list', 'record'] as const) {
      assert.ok(
        trips[`enter (${page})`] <= trips[`apart (${page})`],
        `entering a ${page} is ${trips[`enter (${page})`]} flights, the three apart ${trips[`apart (${page})`]}`,
      );
      assert.ok(trips[`enter (${page})`] <= entering[page], `entering a ${page} is ${trips[`enter (${page})`]} flights`);
    }
  });

  test('an enter, a list, its counts, a record page and a prepare stay within their CPU, allocation and copy budgets', async (t) => {
    /* A field load test of a tenant App found the server's own CPU the ceiling: about 20 ms a request, GC a large
       share of it, an enter up to a second. scripts/capacity-harness.mjs measures that on half a CPU; this holds
       what it found, per interaction, so a change that copies the request's evidence again, checks a kept scope
       again or rebuilds what was kept fails here rather than in the next load test. The copies and the scope
       checks are counted, so exact; CPU and bytes are measured in this process, the test's own fetch included,
       and their ceilings leave room for a slower machine: they catch a step change, not a few percent. */
    const f = await deploy(t),
      north = await f.enter('north');
    const identity = { cookie: north.cookie, 'x-mistri-account': north.accountId, 'x-mistri-app': 'ignition' };
    const lead = { id: 'north-motors:lead:0002' };
    const leases: Record<string, unknown>[] = [];
    const interactions: Record<string, () => Promise<Answer>> = {
      enter: async () => {
        const reply = await f.call('/api/tenant/enter?app=ignition', { path: '/ignition/leads', search: '' }, identity);
        leases.push(object(object(reply.body.entered).context));
        return reply;
      },
      list: () => north.read('/api/run', list),
      counts: () => north.read('/api/counts', { items: [list.q, 'lead'] }),
      record: () => north.read('/api/boot', { path: `/ignition/leads/${encodeURIComponent(lead.id)}`, search: '' }),
      prepare: () => north.read('/api/commands/prepare', { command: 'qualifyLead', commandVersion: 1, key: lead }),
    };
    const letGo = async () => {
      for (const lease of leases.splice(0))
        await f.call(
          '/api/tenant/context/release?app=ignition',
          { tabId: lease.tabId, expectedContext: lease.context, expectedRevision: lease.revision },
          identity,
        );
    };
    const ROUNDS = 12;
    const measured: Record<string, { cpuMs: number; kb: number; copied: number; checked: number }> = {};
    for (const [name, ask] of Object.entries(interactions)) {
      for (let warm = 0; warm < 3; warm++) {
        const reply = await ask();
        assert.equal(reply.status, 200, `${name}: ${reply.text}`);
      }
      await letGo();
      const copied = captureCounters.copied,
        checked = rowScopeCounters.checked,
        heap = allocationMeter(),
        cpu = process.cpuUsage();
      for (let round = 0; round < ROUNDS; round++) assert.equal((await ask()).status, 200, name);
      const used = process.cpuUsage(cpu);
      measured[name] = {
        cpuMs: (used.user + used.system) / 1000 / ROUNDS,
        kb: heap.allocated() / 1024 / ROUNDS,
        copied: (captureCounters.copied - copied) / ROUNDS,
        checked: (rowScopeCounters.checked - checked) / ROUNDS,
      };
      await letGo();
    }
    for (const [name, cost] of Object.entries(measured))
      t.diagnostic(
        `${name}: ${cost.cpuMs.toFixed(1)} ms CPU, ${cost.kb.toFixed(0)} KB allocated, ${cost.copied} objects copied, ${cost.checked} row scopes checked`,
      );
    /* Each ceiling is what was measured when it was set (rc.3, an M-series laptop: CPU ms, KB, objects copied, scopes
       checked — enter 9 / 3,100 / 180 / 0, list 2.9 / 1,220 / 70 / 0, counts 2.5 / 890 / 39 / 0, a record page
       11.5 / 5,900 / 608 / 3, a prepare 4.6 / 1,560 / 46 / 7), with room: five times the CPU, for a slower runner
       and for the gate's parallel lane beside it (three times was crossed there), half again the bytes, and a
       quarter again the copies. A prepare checked eleven scopes before its transaction
       checked each once. Raise one only with the reason beside it. */
    const budgets: Record<string, { cpuMs: number; kb: number; copied: number; checked: number }> = {
      enter: { cpuMs: 45, kb: 4700, copied: 225, checked: 1 },
      list: { cpuMs: 15, kb: 1850, copied: 90, checked: 1 },
      counts: { cpuMs: 13, kb: 1350, copied: 50, checked: 1 },
      record: { cpuMs: 58, kb: 8900, copied: 760, checked: 4 },
      prepare: { cpuMs: 23, kb: 2350, copied: 60, checked: 8 },
    };
    for (const [name, budget] of Object.entries(budgets)) {
      const cost = measured[name]!;
      for (const key of ['cpuMs', 'kb', 'copied', 'checked'] as const)
        assert.ok(cost[key] <= budget[key], `${name}: ${key} ${cost[key].toFixed(1)} over its budget of ${budget[key]}`);
    }
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
