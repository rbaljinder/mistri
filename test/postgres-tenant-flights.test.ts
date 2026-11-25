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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
import { provisionPostgresTenantSandboxes } from '../packages/mistri/src/server/tenant/tenantSandboxStore.js';
import { startLatencyProxy, type LatencyProxy, type Statement } from '../e2e/support/latencyProxy.js';
import { holdPort } from './support/heldPort.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
/** How many vehicles the bulk command writes on its next run (the test sets it before each measurement). */
const bulk = globalThis as { __mistriFlightsBulkRows?: number };
const PRINT = process.env.TABLEWALK_FLIGHTS_PRINT === '1';
/* TABLEWALK_FLIGHTS_CLONING=0 serves Ignition as it is, with no resource marked for cloning: an arrival's budget holds
   either way, and this is the way to see it does. */
const CLONING = process.env.TABLEWALK_FLIGHTS_CLONING !== '0';
const password = 'Ignition-flights-password-123!';

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
   (MISTRI_AUTH_SESSION_CACHE, authStoreReads.ts), and the first request past it reads them again, one `auth` flight
   paid once a window and not by that request. On a loaded machine a measurement lands on it, as on the catalog's
   digest. Statements are the window's, any request's, so the request's own header says whether it paid. */
/** A read of the session table, whichever way it is spelled: Better Auth's `from "auth_session"`, and the tenant
 * binding's own check of the session (storeObserver.ts), which names the runtime schema, `from mistri."auth_session" s`.
 * The first alone was the pattern, and a window's refresh made only by the second paid a flight it did not recognise. */
const SESSION_READ = /\bfrom\s+(?:"?\w+"?\.)?"auth_session"/i;
const refreshed = (answer: Answer): boolean =>
  (answer.flights.auth ?? 0) > 0 && answer.statements.some((statement) => SESSION_READ.test(statement.text));

/** What to say of an answer that paid `auth` flights no session read explains: the statements, since the budget's
 * failure is otherwise a number with no way to tell a new cost from a spelling the pattern did not know. */
const unexplainedAuth = (answer: Answer): string =>
  (answer.flights.auth ?? 0) > 0 && !refreshed(answer)
    ? `\n  paid ${answer.flights.auth} auth flight(s) with no session read among the statements (SESSION_READ); all of them:\n${byFlight(answer.statements, 400)}`
    : '';

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

  const commandsFile = join(directory, 'commands.mjs');
  writeFileSync(commandsFile, bulkCommandsModule());
  const loaded = await loadApp(IGNITION_DIR);
  /* Ignition keeps no inbox, and the bell asks one on every page of an App that does: a rule on its leads makes it
     one that does, and the notices it reads are planted below. */
  const lead = loaded.app.resources!.lead!;
  const app = {
    ...loaded.app,
    auth: { ...loaded.app.auth!, store: relay.route(authStore.url) },
    /* A free-form page, which Ignition has none of: its data is one loader's and it runs another by name
       (bulkCommandsModule `loaders`), each a read of the dealership's leads. Shaped as a parsed page is
       (shared/appPageViews.ts); its component is never drawn here. */
    views: {
      ...loaded.app.views,
      pulse: {
        label: 'Pulse',
        sections: [
          { kind: 'custom', component: { id: 'page-pulse', module: './pages/pulse.page.tsx', kind: 'page' }, props: {}, width: 'full' },
        ],
        page: { reads: ['lead'], commands: [], params: ['status'], loader: 'pulse', loaders: ['pulseCount'] },
      },
    } as typeof loaded.app.views,
    resources: {
      ...loaded.app.resources,
      lead: {
        ...lead,
        notify: [{ on: { changes: ['status'] }, when: 'status = qualified', to: ['qualified_by'], title: 'Lead {reference} moved' }],
      },
      /* The bulk command's vehicles (bulkCommandsModule): a command writes only what the App lets be written. Marked
         for cloning, as an App with sandboxes marks a resource: an arrival then asks which of the person's tenants
         are sandboxes (tenantEnrollment.ts `sandboxes`), which nothing else of Ignition would. */
      vehicle: { ...loaded.app.resources!.vehicle!, access: 'write', ...(CLONING ? { clone: 'config' as const } : {}) },
    },
  };
  /* A page's loaders are the App's own, beside its commands (tenantStartup.ts): the Pulse page's, from the module below. */
  const { loaders } = (await import(pathToFileURL(commandsFile).href)) as { loaders: (typeof loaded)['loaders'] };
  const served = { ...loaded, app, loaders } as typeof loaded;
  await provisionPostgresInbox((lending.target as { postgres: string }).postgres);
  if (CLONING) {
    /* A clone's new tenant is born without a code, which Ignition's dealers must have (tenantFeatureClone.ts). */
    await lending.exec('ALTER TABLE dealer ALTER COLUMN code DROP NOT NULL');
    await provisionPostgresTenantSandboxes((lending.target as { postgres: string }).postgres);
  }
  const held = await holdPort(),
    port = held.port,
    origin = `http://127.0.0.1:${port}`;
  t.after(() => held.release());
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
    commandsFile,
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
  await held.adopt(owner.server);
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

/* Ignition's commands with `disqualifyLead` doing a batch's work after its own: a tenant command that disqualifies
   its lead as the real one does (the lead's machine runs it from `new`), then adds vehicles with `insertMany` and
   changes them all with `updateWhere`. The lead's update goes first so it is the one the opening sent ahead for, as
   in `execute`: the flights past execute's are the batch's own. Its rows' count is read at each run, so the same
   command is measured at 50 rows and at 200. */
const bulkCommandsModule = () => {
  const at = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  return `
import ignition from ${at('./fixtures/apps/ignition/commands.ts')};
import { disqualifyOutput } from ${at('./fixtures/apps/ignition/leads.ts')};
import { defineCommand, defineCommands, field } from ${at('../packages/mistri/src/server/commands.ts')};
import { defineLoader, defineLoaders } from ${at('../packages/mistri/src/server/commands/pageLoaders.ts')};
let run = 0;
/* The Pulse page's loaders (deploy): its data, the leads in the state its address says, and their count by name. */
export const loaders = defineLoaders({
  pulse: defineLoader({ reads: ['lead'], load: async ({ db, params }) => ({
    leads: (await db.lead.where(params.status ? { status: params.status } : {}).orderBy('id')).map((row) => row.id),
  }) }),
  pulseCount: defineLoader({ reads: ['lead'], params: ['status'], load: async ({ db, params }) => ({
    n: (await db.lead.where(params.status ? { status: params.status } : {})).length,
  }) }),
});
export default defineCommands({
  ...ignition,
  disqualifyLead: defineCommand({
    source: 'lending',
    target: 'lead',
    read: ['vehicle_model'],
    write: ['vehicle'],
    input: { reason: field.textarea({ max: 500 }) },
    output: disqualifyOutput,
    async handle({ db, record: lead }, { reason }) {
      const { version } = await db.lead.update(lead, { status: 'disqualified', disqualified_reason: reason });
      const rows = globalThis.__mistriFlightsBulkRows ?? 200;
      run += 1;
      const mileage = 900000 + run;
      const made = await db.vehicle.insertMany(Array.from({ length: rows }, (_, n) => ({
        id: 'bulk-' + run + '-' + n, stock_reference: 'BULK-' + run + '-' + n, model_id: 'model-vela-city',
        condition: 'used', mileage, price: 9000, status: 'available',
      })));
      const sold = await db.vehicle.updateWhere({ mileage }, { status: 'sold' });
      if (made.length !== rows || sold.length !== rows) throw new Error('the batch wrote ' + made.length + ' and changed ' + sold.length);
      return disqualifyOutput.parse({ leadId: String(lead.id), version: Number(version), message: 'Lead disqualified.' });
    },
  }),
});`;
};

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
     membership and every read behind it — and, its reads being one wave, its COMMIT with the release fence's own
     snapshot right behind them in the same flight (TenantReadSource.lastWave). */
  'run (list)': 1,
  counts: 1,
  'run (record)': 1,
  'run (search)': 1,
  'run (pool)': 1,
  // the same snapshot with the page and the unread count behind its BEGIN; the visibility read of their records, with COMMIT and fence behind it
  inbox: 2,
  // the release fence alone: BEGIN, the LOCK, the membership and COMMIT in one message (no suggestions read)
  'record-decisions': 1,
  /* BEGIN with the lock, the membership and the one read of every asked record behind it; COMMIT; the release
     fence. Two records or twenty, the same three: the fence does not ride the COMMIT as a list's does, since a check's
     reads past the first (a derived `when`, an availability hook) are not known to be its last wave. */
  'availability (2 records)': 3,
  'availability (20 records)': 3,
  // BEGIN, locks, the tenant and membership, the row; COMMIT
  prepare: 2,
  // the same opening, with the lead the handler reads; the write with its re-read behind it; the receipt with COMMIT
  execute: 3,
  /* The same opening and update, then 200 vehicles added by `insertMany` and changed by `updateWhere`: the INSERT
     with its parents ahead of it; its one locked read-back of every row; the where's read; the audit's before images;
     the locked read of the rows it changes; the UPDATE with its after-read; the target read again (the batch wrote
     since its update); the receipt with COMMIT. Each batch pays what its one-row form pays, and the same at 50 rows
     as at 200 (asserted below): a batch's flights do not grow with its rows. */
  executeMany: 10,
  'executeMany (50 rows)': 10,
  // admission, the second admission around the session check, its release fence: one whole snapshot each
  renew: 3,
  /* Discovery's three looks at the person's memberships, the platform's riding the second; the marks, one message
     for the tenants' names, which of them are sandboxes and the entered tenant's addresses (tenantReadSource.ts
     `readTenantMarks`); the open's two admissions and its fence; then the boot it carries, BEGIN with every read and
     its COMMIT with the release fence riding it. Nine, each a whole snapshot in one message or awaited, so none is
     left to land on either side of the answer: the count no longer turns on how parallel snapshots interleave on the
     wire, and there is no flight's allowance for it. (It was 12 to 14: the platform's membership on a snapshot beside
     the second look; the names behind a BEGIN with a COMMIT nobody waited on, counted when it happened to leave
     before the answer; the addresses on a snapshot of their own; and the bell's count carried in the boot, whose
     visibility read waited on its notices. Marked for cloning, the sandboxes were four more: the store's layout, its
     version, its rows and a COMMIT.) */
  enter: 9,
  /* Entering at a free-form page: the same nine, with the page's loads in them. Its `loader` and the named loader its
     browser says it asked last time are read on the boot's snapshot, their first reads behind its BEGIN beside the
     App's own, so a load of one wave of reads costs the entry no flight; one that reads in turns costs a flight a
     turn past the first. Asked by the page once the entry had answered, each was a request of its own, two flights
     (`pages/load`), and the page's second wait. */
  'enter (page)': 9,
  // a page's load asked alone: BEGIN with the membership and its reads; the COMMIT with the fence
  'pages/load': 2,
  /* The same for a page reloaded in its tab, which resumes the context that tab kept where the first opens one: a
     resume is admitted as an open is. */
  'enter (kept)': 9,
  /* The page's first reads, asked past the sign-in: the tenant's addresses, a whole snapshot in one message; BEGIN
     with the context's reads; and the COMMIT carrying the release fence (TenantReadRuntime `fencedTogether`) rather
     than a snapshot of the fence's own after it. Three, always: the bell's count is not among the reads (the bell asks
     for itself once the bar has drawn, `inbox` above), and it was its visibility read, waiting on its notices and
     counted in their flight or not as the answers happened to arrive, that made this three or four. */
  boot: 3,
  /* A record page's compose: its plan and every read its sections ask, on one snapshot ending with the fence, then
     the verbs' availability where the page carries checks, which keeps its own fence (availability, above). */
  'pages/compose': 7,
  /* A write's refresh: lists and counts asked in one moment, every one a bounded read, so one bounded request: BEGIN
     with the reads, and the COMMIT with the fence behind (tenantHttp.ts `boundedBatch`). */
  'batch reads': 2,
  /* The record's references: its row, then every count at once, on one snapshot whose COMMIT carries the release fence
     (tenantHttp.ts), where each read on a snapshot of its own was seven. */
  references: 3,
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
    /* A statement sent ahead that its transaction never asks is a round trip paid for nothing. A command's history
       capture read its row by its own columns, never the whole row sent for it, and warned on every save (a field
       report). */
    const leftAhead: string[] = [];
    const heard = (warning: Error) => {
      if (warning.name === 'MistriWriteAhead') leftAhead.push(warning.message);
    };
    process.on('warning', heard);
    t.after(() => process.off('warning', heard));
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
    /* The last new lead, disqualified by the bulk command and put back to new before each run. */
    const bulkLead = { id: leadIds[leadIds.length - 1]! };
    /* Another dealership's vehicles at every mileage a bulk run picks: `updateWhere` matches by mileage alone, and must
       reach north-motors' rows only (the command also throws if it changed more rows than it added). */
    const PLANTED = 20;
    for (let n = 1; n <= PLANTED; n += 1)
      await f.lending.exec(
        `INSERT INTO vehicle (id, tenant_id, stock_reference, model_id, condition, mileage, price, status)
         VALUES (?, 'harbor-auto', ?, 'model-vela-city', 'used', ?, 9000, 'available')`,
        [`harbor-bulk-${n}`, `HARBOR-BULK-${n}`, 900000 + n],
      );
    const executeMany = async (rows: number) => {
      await f.lending.exec(`UPDATE lead SET status = 'new', disqualified_reason = NULL WHERE id = ?`, [bulkLead.id]);
      const prepared = await read('/api/commands/prepare', { command: 'disqualifyLead', commandVersion: 1, key: bulkLead });
      bulk.__mistriFlightsBulkRows = rows;
      saves += 1;
      return read('/api/commands/execute', {
        command: 'disqualifyLead',
        commandVersion: 1,
        key: bulkLead,
        expectedVersion: prepared.body.expectedVersion,
        idempotencyKey: `tenant-flights-${saves}`,
        input: { reason: 'Bulk flights' },
      });
    };
    /* Every lead the member may read, whatever its state: an availability check answers true for some and false for
       others, as a list's row actions are asked. */
    const readPool = async () =>
      (
        (await read('/api/run', { q: `${leads.table} show id`, limit: 100, offset: 0, count: 'none' })).body.rows as Array<{ id: string }>
      ).map((row) => String(row.id));
    /* The dealership has a handful of leads; copies of them, each in its original's state, make twenty to ask about. */
    const seeded = await readPool();
    for (let n = 0; seeded.length + n < 20; n += 1)
      await f.lending.exec(
        `INSERT INTO lead (id, tenant_id, reference, applicant_name, applicant_email, vehicle_stock, requested_amount, down_payment,
           term_months, submitted_on, status, qualified_by, qualified_on, disqualified_reason)
         SELECT ?, tenant_id, ?, applicant_name, applicant_email, vehicle_stock, requested_amount, down_payment, term_months,
           submitted_on, status, qualified_by, qualified_on, disqualified_reason FROM lead WHERE id = ?`,
        [`flights-availability-${n}`, `FLIGHTS-AVAILABILITY-${n}`, seeded[n % seeded.length]],
      );
    const poolIds = await readPool();
    assert.ok(poolIds.length >= 20, `${poolIds.length} leads to ask availability of`);
    const availability = (keys: readonly string[]) =>
      read('/api/commands/availability', { checks: [{ command: 'qualifyLead', commandVersion: 1, keys: keys.map((id) => ({ id })) }] });
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
      'availability (2 records)': () => availability(poolIds.slice(0, 2)),
      'availability (20 records)': () => availability(poolIds.slice(0, 20)),
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
      // The page's first reads in one request (a boot that enters nothing), as the shell asks it past the sign-in.
      boot: () => read('/api/boot', { path: '/ignition/leads', search: '' }),
      'pages/compose': () => read('/api/pages/compose', { page: 'suggested:lead', key: { id: leadIds[0] } }),
      /* A write's refresh: the lists and counts a page stands in, asked in one moment (a batch of bounded reads). */
      'batch reads': () =>
        read('/api/boot', {
          reads: [
            { method: 'POST', path: '/api/run', body: { q: listQuery(leads, 0), limit: 20, offset: 0, exactCount: false } },
            { method: 'POST', path: '/api/counts', body: { items: leads.tabs.map((_, i) => listQuery(leads, i)) } },
          ],
        }),
      references: () => read('/api/references', { table: leads.table, key: { id: leadIds[0] } }),
      'executeMany (50 rows)': () => executeMany(50),
      executeMany: () => executeMany(200),
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
      'pages/load': () => read('/api/pages/load', { page: 'pulse', params: { status: 'new' }, loader: 'pulse' }),
      'enter (page)': async () => {
        const entered = await f.call(
          '/api/tenant/enter?app=ignition',
          { path: '/ignition/pulse', search: '?status=new', loaders: ['pulseCount'] },
          identity,
        );
        if (entered.status === 200) lease = entered.body.entered.context;
        return entered;
      },
      /* A reload: the page says which context its tab kept (client tenantBrowser.ts `keep`), and the host resumes it. */
      'enter (kept)': async () => {
        const entered = await f.call(
          '/api/tenant/enter?app=ignition',
          { path: '/ignition/leads', search: '', kept: { tenantId: f.tenant, tabId: String(lease.tabId) } },
          identity,
        );
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
        again < 2 &&
        (answer.statements.some((statement) => /(?:pg_catalog\.)?md5\((?:pg_catalog\.)?string_agg/.test(statement.text)) ||
          refreshed(answer));
        again++
      )
        answer = await ask();
      assert.ok(answer.status < 300, `${name}: ${answer.status} ${answer.text.slice(0, 300)}`);
      /* Still on a refresh after both retries (a bulk save on a loaded runner outlasts the window each time): the
         refresh's `auth` flight is the window's, and is discounted, as for the saves together below. */
      measured[name] = refreshed(answer) ? { ...answer, total: answer.total - answer.flights.auth! } : answer;
      const line = `${name}: ${answer.total} flights ${JSON.stringify(answer.flights)}${refreshed(answer) ? ' (one session refresh)' : ''}`;
      t.diagnostic(line);
      if (PRINT) console.log(`${line} ${answer.text.slice(0, 300)}\n${byFlight(answer.statements)}`);
    }
    /* The entry at the page carried both loads, each as the page's own request answers it. */
    const pageLoads = Object.entries(measured['enter (page)']!.body.entered.boot.reads as Record<string, { body: { data: unknown } }>)
      .filter(([key]) => key.startsWith('POST /api/pages/load?'))
      .map(([, carried]) => carried.body.data);
    const loadedAlone = (await requests['pages/load']!()).body.data as { leads: string[] };
    assert.ok(loadedAlone.leads.length > 0, 'new leads for the page to read');
    assert.deepEqual(
      pageLoads.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      [loadedAlone, { n: loadedAlone.leads.length }].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    );
    /* The App database's flights are what a batch's size could grow; a session read on the sign-in store is paid
       once per window, and a 200-row run on a loaded machine is slow enough to land on one. */
    const appFlights = (answer: Answer): number => answer.flights.app ?? 0;
    assert.ok(
      appFlights(measured.executeMany!) <= appFlights(measured['executeMany (50 rows)']!),
      `a batch's flights grow with its rows: ${JSON.stringify(measured['executeMany (50 rows)']!.flights)} at 50, ${JSON.stringify(measured.executeMany!.flights)} at 200`,
    );
    /* A page's row actions: the whole id set is read once with the command's row condition and target check,
       not once per record (commandAvailability.ts readCommandAvailability), so ten times the records cost no flight more. */
    assert.ok(
      appFlights(measured['availability (20 records)']!) <= appFlights(measured['availability (2 records)']!),
      `availability's flights grow with its records: ${JSON.stringify(measured['availability (2 records)']!.flights)} at 2, ${JSON.stringify(measured['availability (20 records)']!.flights)} at 20`,
    );
    /* A batch of bounded reads took the bounded path (its budget, above) and answers each as asking for it alone does. */
    const batchedReads = (await requests['batch reads']!()).body.reads as Record<string, { body: unknown }>;
    const batchedList = Object.entries(batchedReads).find(([name]) => name.startsWith('POST /api/run?'));
    const batchedCounts = Object.entries(batchedReads).find(([name]) => name.startsWith('POST /api/counts?'));
    assert.ok(batchedList && batchedCounts, Object.keys(batchedReads).join('\n'));
    const timeless = (body: unknown) => ({ ...(body as Record<string, unknown>), ms: undefined });
    assert.deepEqual(timeless(batchedList[1].body), timeless((await requests['run (list)']!()).body));
    assert.deepEqual(timeless(batchedCounts[1].body), timeless((await requests.counts!()).body));
    // The batch answers each record as asking for it alone does.
    const batched = (await availability(poolIds.slice(0, 20))).body.checks[0].available as boolean[];
    const alone: boolean[] = [];
    for (const id of poolIds.slice(0, 20)) alone.push((await availability([id])).body.checks[0].available[0]);
    assert.deepEqual(batched, alone);
    assert.ok(batched.includes(true) && batched.includes(false), `a mixed batch: ${JSON.stringify(batched)}`);
    const bulkRuns = await f.lending.rows(
      `SELECT count(DISTINCT mileage)::int AS runs, max(mileage) AS top FROM vehicle WHERE id LIKE 'bulk-%'`,
    );
    assert.ok(Number(bulkRuns[0]!.top) <= 900000 + PLANTED, `${bulkRuns[0]!.runs} bulk runs outran the planted mileages`);
    assert.deepEqual(
      await f.lending.rows(
        `SELECT status, count(*)::int AS n FROM vehicle WHERE tenant_id = 'harbor-auto' AND id LIKE 'harbor-bulk-%' GROUP BY status`,
      ),
      [{ status: 'available', n: PLANTED }],
      "a tenant's updateWhere reached another dealership's vehicles",
    );
    /* The bulk command leaves its lead disqualified; the saves below want it back among the open ones. */
    await f.lending.exec(`UPDATE lead SET status = 'new', disqualified_reason = NULL WHERE id = ?`, [bulkLead.id]);
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
    // emitWarning is heard on the next tick: let the last save's arrive.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(leftAhead, []);
    const over = Object.entries(measured).filter(([name, answer]) => answer.total > BUDGETS[name.replace(/ together \d+$/, '')]!);
    assert.deepEqual(
      over.map(
        ([name, answer]) =>
          `${name}: ${answer.total} > ${BUDGETS[name.replace(/ together \d+$/, '')]}\n${byFlight(answer.statements)}${unexplainedAuth(answer)}`,
      ),
      [],
    );
  });
});
