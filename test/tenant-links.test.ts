/**
 * Capability links in a tenant App, on SQLite and on PostgreSQL: a member's command mints a link to one lead of its
 * dealer, written on the dealer's own mapped host where the suite gives it one (north) and on the shared address
 * otherwise (south). The link opens on its own tenant's host and on the shared one, and nowhere else: another tenant's
 * host gets the miss, and spends nothing. Its holder runs the link's declared commands on that one row as `link:<id>`,
 * never another tenant's row; a revoke, a removed row, a delete through the link or a suspended dealer leaves nothing
 * to open, and a revoke that lands between the page and the run runs nothing. A member who edits a lead revokes its
 * links from its page, noted in its history as theirs; one who only reads it, or belongs to another dealer, cannot.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test, type TestContext } from 'node:test';
import { COMMAND_JOURNAL_TABLES } from '../packages/mistri/src/adapters/commands/commandJournalSchema.js';
import type { LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth, type AppAuthRuntime } from '../packages/mistri/src/server/auth/auth.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { defineEvent, defineEventProjection } from '../packages/mistri/src/server/commands/businessEvents.js';
import { shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { configureFormKey } from '../packages/mistri/src/server/forms/formKey.js';
import { createTenantHostRouter } from '../packages/mistri/src/server/http/tenantHosts.js';
import { linkTokenId } from '../packages/mistri/src/server/links/linkToken.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantAuthenticatedHttpServer } from '../packages/mistri/src/server/tenant/tenantAuthenticatedHttp.js';
import { TENANT_HTTP_HEADERS as tenantHeaders } from '../packages/mistri/src/shared/tenantContext.js';
import { refusalReasons } from '../packages/engine/src/shared/refusal.js';
import { resetPublicFormLimits } from '../packages/engine/src/server/http/rateLimit.js';
import { runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { provisionSqliteCommandEventStore } from '../packages/mistri/src/adapters/events/commandEventSchema.js';
import { provisionPostgresCommandEventStore } from '../packages/mistri/src/adapters/events/postgresCommandEventStore.js';
import { provisionPostgresRecordHistory } from '../packages/mistri/src/adapters/history/postgresRecordHistory.js';
import { provisionSqliteRecordHistory } from '../packages/mistri/src/adapters/history/sqliteRecordHistory.js';
import type { TenantContextReply } from '../packages/mistri/src/shared/tenantContext.js';
import { parseTestApp } from './support/commandCatalog.js';
import { appId as supportApp, tenantSupportFixture } from './support/tenantSupportFixture.js';
import {
  dropDedicatedPostgresDatabase,
  openTenantEngine,
  TENANT_DIALECTS,
  type TenantDialect,
  type TenantEngine,
} from './support/tenantDialects.js';

const APP_ID = 'lot';
const binding = { appId: APP_ID, source: { id: 'business', connection: 'lot-db' }, storeId: 'lot-links' };
/** The mapped host the operator gives north; south has none, so its links are written on the shared address. */
const NORTH_HOST = 'north.example.test';
const KEY = 'k'.repeat(40);

const SQLITE = `PRAGMA foreign_keys = ON;
  CREATE TABLE dealer (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
  CREATE TABLE lead (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES dealer(id), name TEXT NOT NULL,
    status TEXT NOT NULL);
  INSERT INTO dealer VALUES ('north', 'North Motors'), ('south', 'South Wheels');
  INSERT INTO lead VALUES ('n-1', 'north', 'Ada', 'open'), ('n-2', 'north', 'Grace', 'open'), ('s-1', 'south', 'Hedy', 'open');`;
const POSTGRES = `
  CREATE TABLE public.dealer (id text PRIMARY KEY, name text NOT NULL);
  CREATE TABLE public.lead (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES public.dealer(id), name text NOT NULL,
    status text NOT NULL);
  INSERT INTO public.dealer VALUES ('north', 'North Motors'), ('south', 'South Wheels');
  INSERT INTO public.lead VALUES ('n-1', 'north', 'Ada', 'open'), ('n-2', 'north', 'Grace', 'open'), ('s-1', 'south', 'Hedy', 'open');`;

interface Answer {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly text: string;
  readonly body: any;
}
type Call = (path: string, init?: { body?: unknown; headers?: Record<string, string>; host?: string }) => Promise<Answer>;

interface Landed {
  readonly id: string;
  readonly cookie: string;
  readonly session: string;
  readonly host: string;
}

interface Fixture {
  readonly engine: TenantEngine;
  readonly port: number;
  readonly call: Call;
  /** A member of the dealer, signed up, granted `roles` (`staff` unless named) and holding a lease on it. A request
   * without a body is a GET. */
  member(tenant: 'north' | 'south', roles?: readonly string[]): Promise<(path: string, body: unknown) => Promise<Answer>>;
  /** A member's command on one lead: `invite` mints a link and answers its URL; `revoke` revokes the lead's links. */
  mint(post: (path: string, body: unknown) => Promise<Answer>, lead: string): Promise<string>;
  /** Opens a link's URL as its holder does, on `host` (the URL's own unless named): the cookie and the page's session. */
  land(url: string, host?: string): Promise<Landed>;
  /** The link's row in the journal. */
  link(id: string): Promise<{ tenant: string; opens: number; revoked: boolean }>;
  leads(): Promise<string[]>;
  suspend(tenant: 'north' | 'south'): Promise<void>;
}

async function listenFirst(server: ReturnType<typeof createServer>) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port.');
  return address.port;
}

/** `eventful`: the command a link runs emits an event, which a link's request has no event runtime to commit. */
async function openFixture(
  t: TestContext,
  dialect: TenantDialect,
  database: string,
  variant: { readonly eventful?: boolean } = {},
): Promise<Fixture> {
  resetPublicFormLimits();
  const engine = await openTenantEngine(dialect, { sqlite: SQLITE, postgres: POSTGRES, tables: ['lead', 'dealer'], database });
  const directory = mkdtempSync(join(tmpdir(), 'mistri-tenant-links-'));
  const disposeKey = configureFormKey(APP_ID, { MISTRI_FORM_KEY: KEY });
  let auth: AppAuthRuntime | undefined;
  let owner: Awaited<ReturnType<typeof createTenantAuthenticatedHttpServer>> | undefined;
  const front = createServer();
  t.after(async () => {
    try {
      front.closeAllConnections();
      await new Promise<void>((resolve) => front.close(() => resolve()));
      owner?.server.closeAllConnections();
      await owner?.retire();
    } finally {
      disposeKey();
      auth?.close();
      await engine.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  await engine.provisionStore(binding);
  await engine.migrateCommandJournal();
  // An event-emitting command needs its store attested before anything else is judged of it.
  if (variant.eventful) {
    const events = { appId: binding.appId, storeId: binding.storeId, sourceId: binding.source.id };
    if (dialect === 'postgres') await provisionPostgresCommandEventStore(engine.url, events);
    else provisionSqliteCommandEventStore(engine.path, events);
  }
  // The lead's page keeps history, which is provisioned once and never at startup.
  if (dialect === 'postgres') await provisionPostgresRecordHistory(engine.url);
  else provisionSqliteRecordHistory(engine.path);
  await engine.maintenance(binding, async (admin) => {
    for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    await admin.putPlatform({ status: 'active', expectedVersion: null });
  });
  const port = await listenFirst(front),
    origin = `http://127.0.0.1:${port}`;
  const loaded: LoadedApp = {
    path: join(directory, 'app.ts'),
    // The lead's page keeps a history, where a revoke from it is noted.
    pages: parsePagesConfig({ pages: [{ label: 'Lead', base: 'lead', sections: [{ kind: 'history' }] }] }, 'tenant links pages'),
    sources: {},
    app: parseTestApp(
      {
        id: APP_ID,
        name: 'Lot',
        sources: { business: { connection: binding.source.connection } },
        resources: {
          dealer: { owner: 'platform' },
          lead: {
            access: 'write',
            owner: 'tenant',
            actions: { invite: { label: 'Invite', command: 'invite' }, revoke: { label: 'Revoke', command: 'revoke' } },
            links: { status: { show: ['name', 'status'], commands: ['withdraw', 'drop'] } },
          },
        },
        auth: {
          store: join(directory, 'auth.db'),
          signUp: 'open',
          rows: 'tenant',
          tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Lender' } },
          roles: {
            staff: { realm: 'tenant', read: true, commands: ['invite', 'revoke'] },
            /* Edits a lead's name, and so may revoke its links from its page. Its status is the commands' to move, so
               the role says which columns it edits. */
            clerk: { realm: 'tenant', read: true, write: ['lead'], fields: { lead: { read: ['id', 'name', 'status'], write: ['name'] } } },
          },
        },
        views: { leads: { kind: 'list', from: 'lead' } },
        nav: [{ id: 'dealership', label: 'Dealership', realm: 'tenant', children: ['leads'] }],
        home: 'leads',
      },
      'tenant links fixture',
      {
        invite: { target: 'lead', input: { link: { type: 'text' } } },
        revoke: { target: 'lead' },
        withdraw: { target: 'lead' },
        drop: { target: 'lead' },
      },
    ),
  };
  const registry = defineCommands({
    invite: defineCommand({
      source: 'business',
      target: 'lead',
      input: { link: { type: 'text' } } as never,
      output: shape({ link: text() }),
      async handle({ link }, input) {
        return { link: await link((input as { link: string }).link) };
      },
    }),
    revoke: defineCommand({
      source: 'business',
      target: 'lead',
      output: shape({ link: text() }),
      async handle({ revokeLinks }) {
        return { link: String(await revokeLinks()) };
      },
    }),
    withdraw: variant.eventful
      ? defineCommand({
          source: 'business',
          target: 'lead',
          output: shape({ id: text() }),
          events: {
            withdrawn: defineEventProjection<{ id: string }, { id: string }>(
              defineEvent('lead.withdrawn', shape({ id: text() })),
              (output) => ({ id: output.id }),
            ),
          },
          async handle({ tx, record }) {
            await tx.update({ table: 'lead', key: { id: String(record.id) }, values: { status: 'withdrawn' } });
            return { id: String(record.id) };
          },
        })
      : defineCommand({
          source: 'business',
          target: 'lead',
          async handle({ tx, record }) {
            await tx.update({ table: 'lead', key: { id: String(record.id) }, values: { status: 'withdrawn' } });
          },
        }),
    drop: defineCommand({
      source: 'business',
      target: 'lead',
      async handle({ tx, record }) {
        await tx.remove({ table: 'lead', key: { id: String(record.id) } });
      },
    }),
  });
  const names = ['BETTER_AUTH_SECRET', 'MISTRI_AUTH_ADMIN_EMAIL', 'MISTRI_AUTH_ADMIN_PASSWORD'] as const;
  const saved = names.map((name) => process.env[name]);
  process.env.BETTER_AUTH_SECRET = 'synthetic-tenant-links-secret-at-least-thirty-two-characters';
  delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
  delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
  try {
    auth = await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin, `http://${NORTH_HOST}:${port}`] });
  } finally {
    names.forEach((name, i) => {
      if (saved[i] === undefined) delete process.env[name];
      else process.env[name] = saved[i];
    });
  }
  const everything = { dealer: true, lead: true };
  const hosts = [{ host: NORTH_HOST, app: APP_ID, tenant: 'north' }];
  owner = await createTenantAuthenticatedHttpServer({
    loaded,
    auth,
    browser: true,
    publicURL: origin,
    hosts,
    bound: { host: '127.0.0.1', port, allowedHosts: [NORTH_HOST] },
    enrollment: {
      policy: defineAppTenantPolicy({
        kind: 'tenant',
        appId: APP_ID,
        storeId: binding.storeId,
        ownership: { dealer: { kind: 'platform' }, lead: { kind: 'tenant', column: 'tenant_id' } },
        resolveMembershipRows: () => everything,
        resolveRows: () => everything,
        resolvePlatformRows: () => everything,
        resultReferences: { invite: () => [], revoke: () => [], withdraw: () => [], drop: () => [] },
      }),
      source: engine.dialect === 'sqlite' ? { ...binding.source, existingPath: engine.path } : { ...binding.source, url: engine.url },
      deployment: 'links-generation',
      roles: ['staff', 'clerk'],
      maxLifetimeMs: 60000,
      commands: { registry },
    },
  });
  const router = createTenantHostRouter(hosts);
  front.on('request', (req, res) => {
    if (!router.accept(req)) {
      res.writeHead(403).end();
      return;
    }
    owner!.server.emit('request', req, res);
  });
  const call: Call = (path, init = {}) =>
    new Promise((resolve, reject) => {
      const host = init.host ?? `127.0.0.1:${port}`;
      const payload = init.body === undefined ? undefined : JSON.stringify(init.body);
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path,
          method: payload === undefined ? 'GET' : 'POST',
          headers: {
            host,
            origin: `http://${host}`,
            ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}),
            ...init.headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let body: unknown;
            try {
              body = JSON.parse(text);
            } catch {
              body = undefined;
            }
            resolve({ status: res.statusCode ?? 0, headers: res.headers, text, body });
          });
        },
      );
      req.setTimeout(10_000, () => req.destroy(new Error('timed out')));
      req.on('error', reject);
      req.end(payload);
    });
  const member: Fixture['member'] = async (tenant, roles = ['staff']) => {
    const name = `${tenant}-${randomUUID().slice(0, 8)}`;
    const signed = await call('/api/auth/sign-up/email', {
      body: { name, email: `${name}@lot.example.test`, password: `Disposable-${name}-password-123!` },
    });
    assert.equal(signed.status, 200, signed.text);
    const cookie = String([signed.headers['set-cookie']].flat()[0]).split(';')[0];
    const accountId = String(signed.body.user.id);
    await engine.maintenance(binding, (admin) =>
      admin.putMembership({
        tenantId: tenant,
        accountId,
        membershipId: `${name}-staff`,
        status: 'active',
        roles: [...roles],
        validUntil: Date.now() + 120_000,
        expectedVersion: null,
      }),
    );
    const query = new URLSearchParams({ app: APP_ID, tenant });
    const headers = { cookie, [tenantHeaders.account]: accountId };
    const opened = await call(`/api/tenant/context/open?${query}`, { body: {}, headers });
    assert.equal(opened.status, 200, opened.text);
    return (path, body) =>
      call(`${path}?${query}`, {
        body,
        headers: {
          ...headers,
          [tenantHeaders.app]: APP_ID,
          [tenantHeaders.tab]: String(opened.body.tabId),
          [tenantHeaders.context]: String(opened.body.context),
          [tenantHeaders.revision]: String(opened.body.revision),
        },
      });
  };
  const run = async (post: (path: string, body: unknown) => Promise<Answer>, command: string, lead: string, input: object) => {
    const key = { id: lead };
    const prepared = await post('/api/commands/prepare', { command, commandVersion: 1, key });
    assert.equal(prepared.status, 200, prepared.text);
    const ran = await post('/api/commands/execute', {
      command,
      commandVersion: 1,
      key,
      expectedVersion: prepared.body.expectedVersion,
      idempotencyKey: `${command}-${randomUUID()}`,
      input,
    });
    assert.equal(ran.status, 200, ran.text);
    assert.equal(ran.body.status, 'applied', ran.text);
    return ran;
  };
  const table = runtimeTable(engine.dialect, COMMAND_JOURNAL_TABLES.link);
  return {
    engine,
    port,
    call,
    member,
    async mint(post, lead) {
      const minted = await run(post, 'invite', lead, { link: 'status' });
      const url = /http:\/\/[^"]+\/l\/mstl1\.[A-Za-z0-9_.-]+/.exec(minted.text)?.[0];
      assert.ok(url, `the minting answer says the URL: ${minted.text}`);
      return url;
    },
    async land(url, host) {
      const at = new URL(url);
      const opened = await call(at.pathname, { host: host ?? at.host });
      assert.equal(opened.status, 303, opened.text);
      const id = linkTokenId(at.pathname.slice(at.pathname.lastIndexOf('/') + 1))!;
      assert.equal(opened.headers.location, `/${APP_ID}/l/${id}`);
      const cookie = String([opened.headers['set-cookie']].flat()[0]).split(';')[0];
      const page = await call(`/${APP_ID}/l/${id}`, { host: host ?? at.host, headers: { cookie } });
      assert.equal(page.status, 200, page.text);
      const session = /data-session="([^"]+)"/.exec(page.text)?.[1] ?? '';
      assert.ok(session, page.text);
      return { id, cookie, session, host: host ?? at.host };
    },
    async link(id) {
      const row = await engine.get(`SELECT tenant_id, opens, revoked_at FROM ${table} WHERE id = ?`, [id]);
      assert.ok(row, `link ${id} is kept`);
      return { tenant: String(row.tenant_id), opens: Number(row.opens), revoked: row.revoked_at !== null };
    },
    async leads() {
      return (await engine.all('SELECT id, status FROM lead ORDER BY id')).map((row) => `${row.id}:${row.status}`);
    },
    async suspend(tenant) {
      await engine.maintenance(binding, (admin) => admin.putTenant({ tenantId: tenant, status: 'suspended', expectedVersion: '1' }));
    },
  };
}

const sessionHeaders = (landed: Landed) => ({ 'x-mistri-link': landed.session });
const prepare = (f: Fixture, landed: Landed, host = landed.host) =>
  f.call(`/${APP_ID}/l/${landed.id}/prepare`, { body: {}, host, headers: sessionHeaders(landed) });
const runLink = (f: Fixture, landed: Landed, command: string, expectedVersion: unknown, host = landed.host) =>
  f.call(`/${APP_ID}/l/${landed.id}/run`, {
    body: { command, expectedVersion, idempotencyKey: `${command}-${randomUUID()}`, input: {} },
    host,
    headers: sessionHeaders(landed),
  });

for (const { dialect, skip } of TENANT_DIALECTS) {
  describe(`a tenant App's capability links are held to their tenant (${dialect})`, { skip, timeout: 120_000 }, () => {
    const database = `tenant_links_${randomUUID().replaceAll('-', '')}`;
    after(async () => {
      if (dialect === 'postgres') await dropDedicatedPostgresDatabase(database);
    });

    test('a link is written on its tenant’s own host, runs its commands there as link:<id>, and nowhere else', async (t) => {
      const f = await openFixture(t, dialect, database);
      const north = await f.member('north'),
        south = await f.member('south');
      const northUrl = await f.mint(north, 'n-1');
      // North's mapped host (A-2), on the port the suite was given; south has none, so the shared address.
      assert.equal(new URL(northUrl).host, `${NORTH_HOST}:${f.port}`);
      assert.match(new URL(northUrl).pathname, new RegExp(`^/${APP_ID}/l/mstl1\\.`));
      const southUrl = await f.mint(south, 's-1');
      assert.equal(new URL(southUrl).host, `127.0.0.1:${f.port}`);

      // South's link asked on north's host is a miss, and spends nothing.
      const southId = linkTokenId(southUrl.slice(southUrl.lastIndexOf('/') + 1))!;
      const missed = await f.call(new URL(southUrl).pathname, { host: `${NORTH_HOST}:${f.port}` });
      assert.equal(missed.status, 404);
      assert.equal(missed.headers['set-cookie'], undefined);
      assert.deepEqual(await f.link(southId), { tenant: 'south', opens: 0, revoked: false });

      // North's link opens on its own host and on the shared one.
      const landed = await f.land(northUrl);
      assert.equal((await f.link(landed.id)).opens, 1);
      const shared = await f.land(northUrl, `127.0.0.1:${f.port}`);
      assert.equal(shared.id, landed.id);

      // The declared command runs on its one row, as the link's principal.
      const prepared = await prepare(f, landed);
      assert.equal(prepared.status, 200, prepared.text);
      const ran = await runLink(f, landed, 'withdraw', prepared.body.commands.withdraw.expectedVersion);
      assert.equal(ran.status, 200, ran.text);
      assert.deepEqual(await f.leads(), ['n-1:withdrawn', 'n-2:open', 's-1:open']);
      const receipt = await f.engine.get(
        `SELECT actor_id, tenant_id FROM ${runtimeTable(f.engine.dialect, COMMAND_JOURNAL_TABLES.receipt)} WHERE command_id = 'withdraw'`,
      );
      assert.equal(receipt?.actor_id, `link:${landed.id}`);
      assert.equal(receipt?.tenant_id, 'north');
    });

    test('a link’s cookie and session are refused on another tenant’s host', async (t) => {
      const f = await openFixture(t, dialect, database);
      const south = await f.member('south');
      // South's link, landed on the shared address, then replayed on north's host.
      const landed = await f.land(await f.mint(south, 's-1'));
      const page = await f.call(`/${APP_ID}/l/${landed.id}`, { host: `${NORTH_HOST}:${f.port}`, headers: { cookie: landed.cookie } });
      assert.equal(page.status, 404);
      const northHost = `${NORTH_HOST}:${f.port}`;
      assert.equal((await prepare(f, landed, northHost)).status, 404);
      const prepared = await prepare(f, landed);
      assert.equal(prepared.status, 200, prepared.text);
      const ran = await runLink(f, landed, 'withdraw', prepared.body.commands.withdraw.expectedVersion, northHost);
      assert.equal(ran.status, 404);
      assert.deepEqual(await f.leads(), ['n-1:open', 'n-2:open', 's-1:open']);
    });

    test('a revoke between the page and the run runs nothing', async (t) => {
      const f = await openFixture(t, dialect, database);
      const north = await f.member('north');
      const landed = await f.land(await f.mint(north, 'n-1'));
      const prepared = await prepare(f, landed);
      assert.equal(prepared.status, 200, prepared.text);
      await north('/api/commands/prepare', { command: 'revoke', commandVersion: 1, key: { id: 'n-1' } }).then(async (ready) => {
        assert.equal(ready.status, 200, ready.text);
        const revoked = await north('/api/commands/execute', {
          command: 'revoke',
          commandVersion: 1,
          key: { id: 'n-1' },
          expectedVersion: ready.body.expectedVersion,
          idempotencyKey: `revoke-${randomUUID()}`,
          input: {},
        });
        assert.equal(revoked.status, 200, revoked.text);
      });
      assert.equal((await f.link(landed.id)).revoked, true);
      const ran = await runLink(f, landed, 'withdraw', prepared.body.commands.withdraw.expectedVersion);
      assert.equal(ran.status, 404);
      assert.equal((await f.call(`/${APP_ID}/l/${landed.id}`, { host: landed.host, headers: { cookie: landed.cookie } })).status, 404);
      assert.deepEqual(await f.leads(), ['n-1:open', 'n-2:open', 's-1:open']);
    });

    test('a revoke racing the run either lands after it or leaves the row untouched', async (t) => {
      const f = await openFixture(t, dialect, database);
      const north = await f.member('north');
      const landed = await f.land(await f.mint(north, 'n-1'));
      const prepared = await prepare(f, landed);
      const ready = await north('/api/commands/prepare', { command: 'revoke', commandVersion: 1, key: { id: 'n-1' } });
      assert.equal(ready.status, 200, ready.text);
      const [ran, revoked] = await Promise.all([
        runLink(f, landed, 'withdraw', prepared.body.commands.withdraw.expectedVersion),
        north('/api/commands/execute', {
          command: 'revoke',
          commandVersion: 1,
          key: { id: 'n-1' },
          expectedVersion: ready.body.expectedVersion,
          idempotencyKey: `revoke-${randomUUID()}`,
          input: {},
        }),
      ]);
      if (revoked.status === 409) {
        // The run moved the record's version first: it withdrew, and the revoke, refused, left the link as it was.
        assert.equal(ran.status, 200, ran.text);
        assert.deepEqual(await f.leads(), ['n-1:withdrawn', 'n-2:open', 's-1:open']);
        assert.equal((await f.link(landed.id)).revoked, false);
        return;
      }
      assert.equal(revoked.status, 200, revoked.text);
      assert.equal((await f.link(landed.id)).revoked, true);
      if (ran.status === 200) assert.deepEqual(await f.leads(), ['n-1:withdrawn', 'n-2:open', 's-1:open']);
      else {
        /* Revoked before the run was looked up, or while it was in flight and its fence refused it: the same miss the
           link's next request gets, never a store that cannot answer. Nothing ran. */
        assert.equal(ran.status, 404, ran.text);
        assert.deepEqual(await f.leads(), ['n-1:open', 'n-2:open', 's-1:open']);
      }
    });

    test('a link to a row removed outside a command revokes and misses', async (t) => {
      const f = await openFixture(t, dialect, database);
      const north = await f.member('north');
      const landed = await f.land(await f.mint(north, 'n-1'));
      await f.engine.exec(`DELETE FROM lead WHERE id = 'n-1'`);
      const page = await f.call(`/${APP_ID}/l/${landed.id}`, { host: landed.host, headers: { cookie: landed.cookie } });
      assert.equal(page.status, 404);
      assert.equal((await f.link(landed.id)).revoked, true);
    });

    test('a suspended dealer’s link opens nothing', async (t) => {
      const f = await openFixture(t, dialect, database);
      const north = await f.member('north');
      const url = await f.mint(north, 'n-1');
      const landed = await f.land(url);
      const id = landed.id;
      await f.suspend('north');
      const opened = await f.call(new URL(url).pathname, { host: new URL(url).host });
      assert.equal(opened.status, 404);
      assert.equal((await f.call(`/${APP_ID}/l/${id}`, { host: landed.host, headers: { cookie: landed.cookie } })).status, 404);
      assert.equal((await prepare(f, landed)).status, 404);
      assert.equal((await f.link(id)).opens, 1, 'nothing is spent while the dealer is suspended');
    });

    test('a member who edits a lead revokes its links from its page, and its history says who did', async (t) => {
      const f = await openFixture(t, dialect, database);
      const north = await f.member('north'),
        clerk = await f.member('north', ['staff', 'clerk']);
      const landed = await f.land(await f.mint(north, 'n-1'));
      const second = linkTokenId((await f.mint(north, 'n-1')).split('/').pop()!)!;
      await f.mint(north, 'n-2');
      const lead = { table: 'lead', key: { id: 'n-1' } };
      // Offered where the member edits the lead, and not to one who only reads it.
      assert.deepEqual((await clerk('/api/app', undefined)).body.app.revokesLinks, ['lead']);
      assert.equal((await north('/api/app', undefined)).body.app.revokesLinks, undefined);
      // Reading the lead is not enough to count its links, nor to revoke them.
      assert.equal((await north('/api/record-links', lead)).status, 403);
      assert.equal((await north('/api/record-links/revoke', lead)).status, 403);
      assert.equal((await f.link(landed.id)).revoked, false);
      const counted = await clerk('/api/record-links', lead);
      assert.equal(counted.status, 200, counted.text);
      assert.deepEqual(counted.body, { live: 2 });
      // The route reads its own fields and nothing that names another owner.
      assert.equal((await clerk('/api/record-links/revoke', { ...lead, tenant: 'south' })).status, 403);
      const revoked = await clerk('/api/record-links/revoke', lead);
      assert.equal(revoked.status, 200, revoked.text);
      assert.deepEqual(revoked.body, { revoked: 2 });
      assert.equal((await f.link(landed.id)).revoked, true);
      assert.equal((await f.link(second)).revoked, true);
      assert.equal((await f.call(`/${APP_ID}/l/${landed.id}`, { host: landed.host, headers: { cookie: landed.cookie } })).status, 404);
      // The other lead's link is its own.
      assert.deepEqual((await clerk('/api/record-links', { table: 'lead', key: { id: 'n-2' } })).body, { live: 1 });
      // Nothing left to revoke: none counted, none revoked, nothing more noted.
      assert.deepEqual((await clerk('/api/record-links', lead)).body, { live: 0 });
      assert.deepEqual((await clerk('/api/record-links/revoke', lead)).body, { revoked: 0 });
      const history = await clerk('/api/record-history', lead);
      assert.equal(history.status, 200, history.text);
      const noted = (history.body.entries as Array<Record<string, unknown>>).filter((entry) => entry.action === 'Revoked 2 links');
      assert.equal(noted.length, 1, history.text);
      assert.deepEqual(noted[0].fields, []);
      assert.match(String(noted[0].by), /^north-/);
      assert.deepEqual(await f.leads(), ['n-1:open', 'n-2:open', 's-1:open']);
    });

    test('a member of another dealer revokes none of a lead’s links', async (t) => {
      const f = await openFixture(t, dialect, database);
      const north = await f.member('north'),
        south = await f.member('south', ['staff', 'clerk']);
      const landed = await f.land(await f.mint(north, 'n-1'));
      const lead = { table: 'lead', key: { id: 'n-1' } };
      assert.equal((await south('/api/record-links', lead)).status, 403);
      assert.equal((await south('/api/record-links/revoke', lead)).status, 403);
      assert.equal((await f.link(landed.id)).revoked, false);
      // A resource that declares no links has none to count or revoke.
      assert.equal((await south('/api/record-links', { table: 'dealer', key: { id: 'south' } })).status, 403);
    });

    test('a delete through a link removes its one row and revokes the link', async (t) => {
      const f = await openFixture(t, dialect, database);
      const north = await f.member('north');
      const landed = await f.land(await f.mint(north, 'n-1'));
      const prepared = await prepare(f, landed);
      assert.equal(prepared.status, 200, prepared.text);
      const ran = await runLink(f, landed, 'drop', prepared.body.commands.drop.expectedVersion);
      assert.equal(ran.status, 200, ran.text);
      assert.deepEqual(await f.leads(), ['n-2:open', 's-1:open']);
      assert.equal((await f.link(landed.id)).revoked, true);
      assert.equal((await f.call(`/${APP_ID}/l/${landed.id}`, { host: landed.host, headers: { cookie: landed.cookie } })).status, 404);
    });

    test('a revoke from the page racing a link’s run leaves the run after it, or a miss that ran nothing', async (t) => {
      const f = await openFixture(t, dialect, database);
      const clerk = await f.member('north', ['staff', 'clerk']);
      const landed = await f.land(await f.mint(clerk, 'n-1'));
      const prepared = await prepare(f, landed);
      assert.equal(prepared.status, 200, prepared.text);
      const [ran, revoked] = await Promise.all([
        runLink(f, landed, 'withdraw', prepared.body.commands.withdraw.expectedVersion),
        clerk('/api/record-links/revoke', { table: 'lead', key: { id: 'n-1' } }),
      ]);
      assert.equal(revoked.status, 200, revoked.text);
      assert.equal((await f.link(landed.id)).revoked, true);
      if (ran.status === 200) {
        // The run committed first; the revoke then found its link live, and said so.
        assert.deepEqual(revoked.body, { revoked: 1 });
        assert.deepEqual(await f.leads(), ['n-1:withdrawn', 'n-2:open', 's-1:open']);
      } else {
        // Revoked first, or while the run was in flight: the miss the link's next request gets, and nothing ran.
        assert.equal(ran.status, 404, ran.text);
        assert.deepEqual(revoked.body, { revoked: 1 });
        assert.deepEqual(await f.leads(), ['n-1:open', 'n-2:open', 's-1:open']);
      }
      assert.equal((await f.call(`/${APP_ID}/l/${landed.id}`, { host: landed.host, headers: { cookie: landed.cookie } })).status, 404);
    });

    test('a command a link runs that emits an event is refused when the deployment starts, by name', async (t) => {
      // The deployment's refusal says nothing to a caller; the reason is recorded for the operator who starts it.
      await assert.rejects(openFixture(t, dialect, database, { eventful: true }), (error) => {
        assert.match(
          refusalReasons(error).join('\n'),
          /Command "withdraw" is run by a link and emits events or effects, which a tenant App's link does not run/,
        );
        return true;
      });
    });
  });
}

/* The record page's links belong to a member of one dealer: neither the platform realm nor a support session reaches
   them, whatever grants the operator holds there: the route refuses the realm before it asks about the record, so the
   App needs declare no link for it. */
for (const { dialect, skip } of TENANT_DIALECTS) {
  test(`${dialect}: a platform-realm or support-session request to a record's links is denied`, { skip, timeout: 120_000 }, async (t) => {
    const f = await tenantSupportFixture(t, dialect);
    const { avery } = f.accounts;
    const own = { cookie: avery.cookie, 'x-mistri-account': avery.accountId };
    const lender = (await f.call(`/api/tenant/context/open?app=${supportApp}&realm=platform`, { body: {}, headers: own }))
      .body as unknown as TenantContextReply;
    assert.equal(lender.realm, 'platform');
    const opened = await f.open(avery, 'north', 'dealer_admin');
    assert.equal(opened.status, 200, opened.text);
    const lease = opened.body.context as TenantContextReply;
    assert.equal(lease.realm, 'support');
    const lead = { table: 'lead', key: { id: 'n1' } };
    for (const path of ['/api/record-links', '/api/record-links/revoke']) {
      const platform = await f.onLease(avery, lender, path, lead, { realm: 'platform' });
      assert.equal(platform.status, 403, `${path} as the platform: ${platform.text}`);
      const support = await f.onLease(avery, lease, path, lead, { realm: 'support', tenant: 'north' });
      assert.equal(support.status, 403, `${path} on a support session: ${support.text}`);
    }
  });
}
