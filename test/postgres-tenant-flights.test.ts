/**
 * What each tenant request costs in round trips, endpoint by endpoint, on
 * Ignition deployed on PostgreSQL the way a field deployment runs it: the
 * authenticated tenant host, native auth with its sessions in a PostgreSQL
 * store of their own, and every request's flights read off its own
 * `Server-Timing` (`db-app` and `db-auth` summed), the number a load test
 * reads in production.
 *
 * Why: a field deployment on one small container against a PostgreSQL about
 * 16 ms away spent almost all of a request's time in round trips; the inbox
 * the bell asks on every page was fifteen of them. Each budget below is what
 * is measured now; they only come down.
 *
 * TABLEWALK_FLIGHTS_PRINT=1 prints each request's statements by connection and flight.
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
import { setServerTiming } from '../packages/engine/src/adapters/telemetry/serverTiming.js';
import { postgresDescriptionCounts } from '../packages/engine/src/adapters/postgres.js';
import { migratePostgresAuthStore } from '../packages/mistri/src/adapters/auth/postgresAuthStore.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { createNativeAccount } from '../packages/mistri/src/server/auth/authAccounts.js';
import type { ConnectionConfig } from '../packages/engine/src/server/connections.js';
import { createTenantAuthenticatedHttpServer } from '../packages/mistri/src/server/tenant/tenantAuthenticatedHttp.js';
import { prepareTenantStartup } from '../packages/mistri/src/server/tenant/tenantStartup.js';
import { liveSkip } from './live.js';
import { IGNITION_DIR, openIgnitionLending } from './support/ignitionLendingFixture.js';
import { uuidPostgresDatabase } from './support/tenantDialects.js';
import { provisionPostgresInbox } from '../packages/mistri/src/adapters/inbox/postgresInbox.js';
import { tenantInbox } from '../packages/mistri/src/adapters/inbox/inbox.js';
import { startLatencyProxy, type LatencyProxy, type Statement } from '../e2e/support/latencyProxy.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const PRINT = process.env.TABLEWALK_FLIGHTS_PRINT === '1';
const password = 'Ignition-flights-password-123!';

async function reservePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

interface Answer {
  status: number;
  text: string;
  body: Record<string, any>;
  /** The request's own round trips, by database role, as its Server-Timing says. */
  flights: Record<string, number>;
  total: number;
  statements: Statement[];
}

/** `db-app;dur=…;desc="flights=3 max=1"` → { app: 3 }. */
function flightsOf(header: string | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const match of (header ?? '').matchAll(/(?:^|, )db-([a-z-]+);[^,]*?desc="flights=(\d+)/g)) out[match[1]!] = Number(match[2]);
  return out;
}

/* A request that read its session from the sign-in store: the store's reads are kept for a window
   (MISTRI_AUTH_SESSION_CACHE, authStoreReads.ts), and the first request past it reads them again, two `auth` flights
   paid once a window and not by that request. On a loaded machine a measurement lands on it, as on the catalog's
   digest. Statements are the window's, any request's, so the request's own header says whether it paid. */
const refreshed = (answer: Answer): boolean =>
  (answer.flights.auth ?? 0) > 0 && answer.statements.some((statement) => /from "auth_session"/.test(statement.text));

function byFlight(statements: Statement[], width = Number(process.env.TABLEWALK_FLIGHTS_WIDTH ?? 220)): string {
  const flights = new Map<string, string[]>();
  for (const statement of statements) {
    const key = `c${statement.connection}.f${statement.flight}`;
    flights.set(key, [
      ...(flights.get(key) ?? []),
      statement.text
        .replace(/\s+/g, ' ')
        .replace(/LOCK TABLE [^;]*;/g, 'LOCK …;')
        .replace(/AS NOT MATERIALIZED \(SELECT [^)]*\)/g, '(…)')
        .slice(0, width),
    ]);
  }
  return [...flights].map(([key, list]) => `  ${key}\n${list.map((text) => `    ${text}`).join('\n')}`).join('\n');
}

/** Ignition served in this process through `relay`, one dealer admin in north-motors, sessions in PostgreSQL. */
async function deploy(t: TestContext, relay: LatencyProxy) {
  setServerTiming(true);
  t.after(() => setServerTiming(false));
  const lending = await openIgnitionLending(t, 'postgres', { events: true });
  const directory = mkdtempSync(join(tmpdir(), 'mistri-tenant-flights-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const previous = { xdg: process.env.XDG_CONFIG_HOME, secret: process.env.BETTER_AUTH_SECRET };
  process.env.XDG_CONFIG_HOME = directory;
  process.env.BETTER_AUTH_SECRET = 'synthetic-ignition-flights-secret-at-least-thirty-two';
  t.after(() => {
    if (previous.xdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous.xdg;
    if (previous.secret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = previous.secret;
  });
  const authStore = await uuidPostgresDatabase('flights_auth');
  t.after(() => authStore.drop());
  await migratePostgresAuthStore(authStore.url);

  const loaded = await loadApp(IGNITION_DIR);
  /* Ignition keeps no inbox, and the bell asks one on every page of an App that does: a rule on its leads makes it
     one that does, and the notices it reads are planted below. */
  const lead = loaded.app.resources!.lead!;
  const app = {
    ...loaded.app,
    auth: { ...loaded.app.auth!, store: relay.route(authStore.url) },
    resources: {
      ...loaded.app.resources,
      lead: {
        ...lead,
        notify: [{ on: { changes: ['status'] }, when: 'status = qualified', to: ['qualified_by'], title: 'Lead {reference} moved' }],
      },
    },
  };
  const served = { ...loaded, app } as typeof loaded;
  await provisionPostgresInbox((lending.target as { postgres: string }).postgres);
  const port = await reservePort(),
    origin = `http://127.0.0.1:${port}`;
  const auth = await createAppAuth(served, { baseURL: origin, trustedOrigins: [origin], listenHost: '127.0.0.1' });
  t.after(() => auth.close());
  const email = 'flights.admin@north.example.invalid',
    tenant = 'north-motors';
  const accountId = await createNativeAccount(auth, { email, name: 'Flights admin', password }, { by: 'maintenance' });
  await lending.maintenance((admin) =>
    admin.putMembership({
      tenantId: tenant,
      accountId,
      membershipId: `${tenant}:flights`,
      roles: ['dealer_admin'],
      status: 'active',
      validUntil: lending.validUntil,
      expectedVersion: null,
    }),
  );
  const connections: ConnectionConfig[] = [
    { id: 'loans', name: 'loans', url: relay.route(lending.source.url!), source: 'config', writable: true },
    { id: 'applicants', name: 'applicants', url: relay.route(lending.platformSources[0].url!), source: 'config' },
  ];
  /* The start, from its first statement to the open port: what it reads of the two catalogs is counted below. */
  const booting = { at: Date.now(), described: postgresDescriptionCounts().described };
  const prepared = await prepareTenantStartup({
    loaded: served,
    connections,
    policyFile: join(IGNITION_DIR, 'tenant-policy.ts'),
    commandsFile: join(IGNITION_DIR, 'commands.ts'),
  });
  const owner = await createTenantAuthenticatedHttpServer({
    loaded: served,
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
  const boot = {
    statements: relay.statements(booting.at),
    described: postgresDescriptionCounts().described - booting.described,
  };

  const jar = new Map<string, string>();
  const call = async (path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> => {
    await new Promise((done) => setTimeout(done, 60));
    const since = Date.now();
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        origin,
        ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'manual',
    });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const eq = pair!.indexOf('=');
      if (eq > 0) jar.set(pair!.slice(0, eq).trim(), pair!.slice(eq + 1));
    }
    const text = await response.text();
    // A COMMIT is not waited on: let the last one land before the window closes.
    await new Promise((done) => setTimeout(done, 40));
    const timing = response.headers.get('server-timing');
    return {
      status: response.status,
      text,
      body: text.startsWith('{') ? (JSON.parse(text) as Record<string, any>) : {},
      flights: flightsOf(timing),
      total: Object.values(flightsOf(timing)).reduce((sum, n) => sum + n, 0),
      statements: relay.statements(since),
    };
  };
  const signedIn = await call('/api/auth/sign-in/email', { email, password });
  assert.equal(signedIn.status, 200, signedIn.text);
  /* Notices in the person's inbox in north-motors: unread ones about leads they can read, the bell's count. */
  type Client = { connect(): Promise<void>; query(text: string, values?: unknown[]): Promise<unknown>; end(): Promise<void> };
  const pg = (await import('pg' as string)) as { default: { Client: new (options: unknown) => Client } };
  const store = new pg.default.Client({ connectionString: (lending.target as { postgres: string }).postgres });
  await store.connect();
  try {
    for (let n = 1; n <= 6; n += 1)
      await store.query(
        `INSERT INTO mistri."inbox_notice" (app, recipient, at, resource, key_json, title, uses_json, actor, actor_name, action)
         VALUES ($1, $2, $3, 'lead', $4, $5, '[]', 'someone@north.example.invalid', 'Someone', 'Qualify')`,
        [
          tenantInbox('ignition', tenant),
          email,
          new Date(Date.UTC(2026, 9, n)).toISOString(),
          JSON.stringify({ id: `${tenant}:lead:000${n}` }),
          `Lead ${n} moved`,
        ],
      );
  } finally {
    await store.end();
  }
  return { call, accountId, tenant, lending, boot };
}

/* The App's lists and an update command, read from its payload as scripts/capacity-harness.mjs reads them. */
function listsOf(app: any): Array<{ table: string; show: string[]; tabs: string[] }> {
  return Object.values(app.views ?? {})
    .filter((view: any) => view?.table)
    .map((view: any) => ({
      table: view.table,
      show: view.show ?? [],
      tabs: (view.tabs?.length ? view.tabs : [{ query: '' }]).map((tab: any) => tab.query ?? ''),
    }));
}
/**
 * Flights per endpoint, warm, one at a time: what each one's round trips are
 * for. A COMMIT is sent after the answer and counted.
 */
const BUDGETS: Record<string, number> = {
  /* A list, its counts, a record, a search, a pool: one snapshot for the request (withBoundedReads) — BEGIN with the
     membership and every read behind it — then its COMMIT with the release fence's own snapshot in one message. */
  'run (list)': 2,
  counts: 2,
  'run (record)': 2,
  'run (search)': 2,
  'run (pool)': 2,
  // the same snapshot with the page and the unread count behind its BEGIN; the visibility read of their records; COMMIT and fence
  inbox: 3,
  // the release fence alone: BEGIN, the LOCK, the membership and COMMIT in one message (no suggestions read)
  'record-decisions': 1,
  // BEGIN, locks, the tenant and membership, the row; COMMIT
  prepare: 2,
  // the same opening; the handler's read of the lead; the write with its re-read; the receipt with COMMIT
  execute: 4,
  // admission, the second admission around the session check, its release fence: one whole snapshot each
  renew: 3,
  /* Discovery's memberships, the platform's and the tenant's names, beside the open's two admissions and its
     fence, the tenant's addresses, then the boot's own snapshot (BEGIN with every read, the inbox's visibility,
     COMMIT) and its fence: 14, a flight or two more as the parallel snapshots interleave on the wire. */
  enter: 16,
};
/* The first of a catalog description's six statements (adapters/postgresCatalog.ts). */
const DESCRIBES = /\bAS approx_rows\b/;
/* What a runtime store's full attestation reads of the catalog: its relations' layout (postgresRelations.ts), and who
   owns, may use or holds objects in the runtime schema beside them (postgresRuntimeSchemaProblems). */
const STORE_LAYOUT = /\bc\.relrowsecurity AS rls\b/;
const STORE_OWNERS = /^\s*WITH me AS \(SELECT r\.oid, r\.rolsuper\b/;
const listQuery = (list: { table: string; show: string[]; tabs: string[] }, tab: number) =>
  `${list.table} ${list.tabs[tab] ?? ''}${list.show.length ? ` show ${list.show.join(', ')}, id` : ''}`.replace(/\s+/g, ' ').trim();

describe('tenant request flights on Ignition (PostgreSQL)', { skip: liveSkip('postgres', LIVE) }, () => {
  test('each endpoint a page asks stays within its round-trip budget', async (t) => {
    const relay = await startLatencyProxy(LIVE!, 0);
    t.after(() => relay.close());
    const f = await deploy(t, relay);
    /* A start describes each database's catalog once: startup's two checks, its trial enrollment and the host's, each
       read source, the first scoped transaction and each platform source's two snapshots each described it afresh —
       sixteen descriptions of these two databases, six round trips apiece. Every other reader finds the one kept under
       the digest it reads in its own snapshot (sharedDescriptions, adapters/postgres.ts). */
    const described = f.boot.statements.filter((statement) => DESCRIBES.test(statement.text)).length;
    t.diagnostic(`start: ${f.boot.statements.length} statements, ${described} catalog descriptions`);
    assert.equal(described, 2, 'the tenant source and the platform source are each described once at the start');
    assert.equal(f.boot.described, 2);
    /* Each runtime store is attested once at the start, under the catalog version the first attesting transaction
       read, and every other adapter and snapshot of the database that reads the same version finds it attested
       (sharedAttestations, postgresTransactionHandle.ts): 42 layout reads and 32 ownership checks when each adapter
       attested for itself. The tenant, administration, invitation and support stores' checks, one each; what each
       adapter still reads for itself is the store's meta row, which binds it to this App. */
    const owners = f.boot.statements.filter((statement) => STORE_OWNERS.test(statement.text));
    const layouts = f.boot.statements.filter((statement) => STORE_LAYOUT.test(statement.text) && statement.params?.[2] === 'mistri');
    t.diagnostic(`start: ${layouts.length} store layout reads, ${owners.length} ownership checks`);
    assert.deepEqual(owners.map((statement) => statement.params?.[1]).sort(), ['admin_', 'invitation_', 'support_', 'tenant_']);
    // The invitation store's layout is also read twice to ask whether it is there at all, which attests nothing.
    const shared = ['admin_', 'support_', 'tenant_'];
    assert.deepEqual(
      layouts
        .map((statement) => statement.params?.[0])
        .filter((prefix) => shared.includes(prefix!))
        .sort(),
      shared,
      'each shared store layout is read once',
    );
    const who = await f.call('/api/whoami?app=ignition');
    assert.equal(who.status, 200, who.text);
    const identity = { 'x-mistri-account': f.accountId, 'x-mistri-app': 'ignition' };
    const enter = () => f.call('/api/tenant/enter?app=ignition', { path: '/ignition/leads', search: '' }, identity);
    const first = await enter();
    assert.equal(first.status, 200, first.text);
    let lease = first.body.entered.context;
    const leased = () => ({
      ...identity,
      'x-mistri-tab': String(lease.tabId),
      'x-mistri-context': String(lease.context),
      'x-mistri-lease-revision': String(lease.revision),
    });
    const select = (path: string) => `${path}${path.includes('?') ? '&' : '?'}app=ignition&tenant=${f.tenant}`;
    const read = (path: string, body?: unknown) => f.call(select(path), body, leased());
    const app = await read('/api/app');
    assert.equal(app.status, 200, app.text);
    const lists = listsOf(app.body.app);
    const leads = lists.find((list) => list.table === 'lead') ?? lists[0]!;
    const ids = await read('/api/run', { q: `${leads.table} status = new show id`, limit: 100, offset: 0, count: 'none' });
    const leadIds = (ids.body.rows as Array<{ id: string }>).map((row) => String(row.id));
    assert.ok(leadIds.length >= 2, `${leadIds.length} new leads to qualify`);
    let saves = 0;
    const requests: Record<string, () => Promise<Answer>> = {
      'run (list)': () => read('/api/run', { q: listQuery(leads, 0), limit: 20, offset: 0, exactCount: false }),
      counts: () => read('/api/counts', { items: leads.tabs.map((_, i) => listQuery(leads, i)) }),
      'run (record)': () =>
        read('/api/run', {
          q: `${leads.table} id = "${leadIds[0]}"${leads.show.length ? ` show ${leads.show.join(', ')}, id` : ''}`,
          limit: 1,
          offset: 0,
          exactCount: false,
        }),
      'run (search)': () => read('/api/run', { q: `${leads.table} id contains north`, limit: 20, offset: 0, exactCount: false }),
      'run (pool)': () => read('/api/run', { q: `${leads.table} show id`, limit: 100, offset: 0, count: 'none' }),
      inbox: () => read('/api/inbox', { limit: 1 }),
      'record-decisions': () => read('/api/record-decisions', { table: leads.table, key: { id: leadIds[0] } }),
      prepare: () => read('/api/commands/prepare', { command: 'qualifyLead', commandVersion: 1, key: { id: leadIds[1] } }),
      execute: async () => {
        const key = { id: leadIds[0] };
        // Back to new, outside the App, so the same lead qualifies again.
        await f.lending.exec(`UPDATE lead SET status = 'new', qualified_by = NULL, qualified_on = NULL WHERE id = ?`, [key.id]);
        const prepared = await read('/api/commands/prepare', { command: 'qualifyLead', commandVersion: 1, key });
        saves += 1;
        return read('/api/commands/execute', {
          command: 'qualifyLead',
          commandVersion: 1,
          key,
          expectedVersion: prepared.body.expectedVersion,
          idempotencyKey: `tenant-flights-${saves}`,
          input: {},
        });
      },
      renew: async () => {
        const renewed = await f.call(
          select('/api/tenant/context/renew'),
          { tabId: lease.tabId, expectedContext: lease.context, expectedRevision: lease.revision },
          identity,
        );
        if (renewed.status === 200 && renewed.body.context) lease = renewed.body;
        return renewed;
      },
      enter: async () => {
        const entered = await enter();
        if (entered.status === 200) lease = entered.body.entered.context;
        return entered;
      },
    };
    /* As a page asks them: a list and its tab counts at once. */
    const pairs = async () => {
      const [rows, counts] = await Promise.all([requests['run (list)']!(), requests.counts!()]);
      return { rows, counts };
    };
    await pairs();
    const pair = await pairs();
    for (const [name, answer] of Object.entries(pair)) {
      const line = `${name} beside its pair: ${answer.total} flights ${JSON.stringify(answer.flights)}`;
      t.diagnostic(line);
      if (PRINT) console.log(`${line}\n${byFlight(answer.statements)}`);
    }
    const measured: Record<string, Answer> = {};
    for (const [name, ask] of Object.entries(requests)) {
      await ask(); // warm: a pool's connections, the catalog's attestation, each paid once
      /* The catalog's attestation stands for a window (EPOCHLESS_TTL_MS) and the first snapshot after it reads the
         digest again: a flight paid once per window, not per request. On a loaded machine a measurement can land
         on it, and is asked again. */
      let answer = await ask();
      for (
        let again = 0;
        again < 2 && (answer.statements.some((statement) => /md5\(string_agg/.test(statement.text)) || refreshed(answer));
        again++
      )
        answer = await ask();
      assert.ok(answer.status < 300, `${name}: ${answer.status} ${answer.text.slice(0, 300)}`);
      measured[name] = answer;
      const line = `${name}: ${answer.total} flights ${JSON.stringify(answer.flights)}`;
      t.diagnostic(line);
      if (PRINT) console.log(`${line} ${answer.text.slice(0, 300)}\n${byFlight(answer.statements)}`);
    }
    /* Saves at once, as a dealership's people make them, each its own lead: each pays its own round trips still.
       Waiting on a writer, a lane or a lock is time, never another flight. One at a time, the budget could not
       see that. (A field deployment's saves read 7 round trips at the median under 25 people on rc.3 and 9 on rc.4:
       the load test had changed which command it saved with, not the platform — the two commands take 7 and 9 on
       either release, statement for statement.) */
    const together = (
      await f.lending.rows(`SELECT id FROM lead WHERE tenant_id = ? AND status IN ('new', 'qualified') ORDER BY id LIMIT 4`, [f.tenant])
    ).map((row) => String(row.id));
    assert.equal(together.length, 4, 'four leads to qualify at once');
    await f.lending.exec(`UPDATE lead SET status = 'new', qualified_by = NULL, qualified_on = NULL WHERE id = ANY (?)`, [together]);
    const versions: unknown[] = [];
    for (const id of together)
      versions.push((await read('/api/commands/prepare', { command: 'qualifyLead', commandVersion: 1, key: { id } })).body.expectedVersion);
    const saved = await Promise.all(
      together.map((id, at) =>
        read('/api/commands/execute', {
          command: 'qualifyLead',
          commandVersion: 1,
          key: { id },
          expectedVersion: versions[at],
          idempotencyKey: `tenant-flights-together-${at}`,
          input: {},
        }),
      ),
    );
    /* The window's one session refresh (refreshed, above), which one of the four pays when the saves land past the
       cache's window, as they do on a loaded machine, is not theirs: it is discounted from that one save. Two or more
       paying it is a cache that stopped holding, and stays counted. */
    const refreshes = saved.filter(refreshed);
    for (const [at, answer] of saved.entries()) {
      assert.ok(answer.status < 300, `execute together ${at}: ${answer.status} ${answer.text.slice(0, 300)}`);
      const counted =
        refreshes.length === 1 && refreshes[0] === answer ? { ...answer, total: answer.total - answer.flights.auth! } : answer;
      measured[`execute together ${at}`] = counted;
      t.diagnostic(
        `execute together ${at}: ${answer.total} flights ${JSON.stringify(answer.flights)}${counted === answer ? '' : ' (one session refresh)'}`,
      );
    }
    // A warm request trusts the description its digest or epoch finds: none describes the catalog again.
    assert.deepEqual(
      Object.entries(measured)
        .filter(([, answer]) => answer.statements.some((statement) => DESCRIBES.test(statement.text)))
        .map(([name]) => name),
      [],
    );
    const over = Object.entries(measured).filter(([name, answer]) => answer.total > BUDGETS[name.replace(/ together \d+$/, '')]!);
    assert.deepEqual(
      over.map(
        ([name, answer]) => `${name}: ${answer.total} > ${BUDGETS[name.replace(/ together \d+$/, '')]}\n${byFlight(answer.statements)}`,
      ),
      [],
    );
  });
});
