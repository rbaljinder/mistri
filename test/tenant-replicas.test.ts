/**
 * A tenant App's reads on a replica of its PostgreSQL source
 * (tenantReadSource.ts): lists go there under the same membership check and
 * row scope, a record's row and a write stay on the primary, a member the
 * replica has not seen yet is answered by the primary, and the browser that
 * wrote reads the primary while its marker is fresh (readRouting.ts).
 *
 * The "replica" is a copy of the source database taken once the tenants are
 * set up, its ticket titles then marked, so every row says where it was read.
 * Anything written to the primary after the copy is replication lag that
 * never ends. Both databases are this file's own (UUID-named beside
 * TABLEWALK_TEST_PG).
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { readsAs } from '../packages/engine/src/adapters/replicas.js';
import { readFreshness } from '../packages/engine/src/server/http/readRouting.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { createTenantHttpServer } from '../packages/mistri/src/server/tenant/tenantHttp.js';
import {
  createPostgresTenantAdministration,
  migratePostgresTenantStore,
} from '../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import type { TenantStoreAdministration } from '../packages/mistri/src/server/tenant/tenantStore.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { liveSkip } from './live.js';
import { parseTestApp } from './support/commandCatalog.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const appId = 'desk';
const binding = { appId, source: { id: 'business', connection: 'business-db' }, storeId: 'desk-replica-store' };

const app = parseTestApp(
  {
    id: appId,
    name: 'Desk',
    auth: { rows: 'tenant', roles: { agent: { read: true, write: ['ticket'] } } },
    sources: { business: { connection: binding.source.connection } },
    resources: {
      ticket: { owner: 'tenant', access: 'write', fields: { read: ['id', 'title'], write: ['id', 'title'] } },
    },
    views: { tickets: { kind: 'list', from: 'ticket' } },
    nav: ['tickets'],
    home: 'tickets',
  },
  'desk replica fixture',
);
const rows: RowScope = { ticket: true };
const policy = defineAppTenantPolicy({
  kind: 'tenant',
  appId,
  storeId: binding.storeId,
  ownership: { ticket: { kind: 'tenant', column: 'tenant_id' } },
  resolveMembershipRows: () => rows,
  resolveRows: () => rows,
});

type Answer = { status: number; text: string; body: Record<string, unknown>; cookie: string | null };
type Context = { tabId: string; context: string; accountId: string; tenantId: string; revision: number };

test(
  "a tenant App's lists read its replica under the same membership and row scope",
  { skip: liveSkip('postgres', LIVE), timeout: 120_000 },
  async (t) => {
    const primary = await uuidPostgresDatabase('tw_tenant_replica');
    const replicaUrl = new URL(primary.url);
    replicaUrl.pathname = `${replicaUrl.pathname}_r`;
    const closing: Array<() => Promise<void>> = [];
    t.after(async () => {
      for (const close of closing.reverse()) await close().catch(() => {});
      const admin = await pgClient(LIVE!);
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${replicaUrl.pathname.slice(1)}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
      await primary.drop();
    });

    const control = await pgClient(primary.url);
    const admin = async (run: (admin: TenantStoreAdministration) => Promise<void>) => {
      await control.query('BEGIN');
      const operations = new TransactionOperations();
      try {
        await run(createPostgresTenantAdministration(control, operations, binding));
        await operations.finish();
        await control.query('COMMIT');
      } catch (error) {
        await operations.finish().catch(() => {});
        await control.query('ROLLBACK');
        throw error;
      }
    };
    const member = (tenantId: string) =>
      admin(async (store) => {
        await store.putTenant({ tenantId, status: 'active', expectedVersion: null });
        await store.putMembership({
          tenantId,
          accountId: 'eve',
          membershipId: `${tenantId}-eve`,
          status: 'active',
          roles: ['agent'],
          validUntil: Date.now() + 3_600_000,
          expectedVersion: null,
        });
      });
    try {
      await control.query(`CREATE TABLE ticket (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, title TEXT NOT NULL);
        INSERT INTO ticket VALUES ('north-1', 'north', 'Printer jammed'), ('north-2', 'north', 'Screen flickers'),
          ('south-1', 'south', 'Badge lost'), ('east-1', 'east', 'Door stuck');`);
      await migratePostgresTenantStore(primary.url, binding);
      await migratePostgresCommandJournal(primary.url);
      await member('north');
      await member('south');
    } finally {
      await control.end();
    }
    /* The replica as it stood then, its rows marked. East joins the primary only afterwards. */
    const server = await pgClient(LIVE!);
    try {
      await server.query(`CREATE DATABASE "${replicaUrl.pathname.slice(1)}" TEMPLATE "${new URL(primary.url).pathname.slice(1)}"`);
    } finally {
      await server.end();
    }
    const marking = await pgClient(replicaUrl.href);
    try {
      await marking.query(`UPDATE ticket SET title = title || ' (replica)'`);
    } finally {
      await marking.end();
    }
    {
      const again = await pgClient(primary.url);
      try {
        await again.query('BEGIN');
        const operations = new TransactionOperations();
        const store = createPostgresTenantAdministration(again, operations, binding);
        await store.putTenant({ tenantId: 'east', status: 'active', expectedVersion: null });
        await store.putMembership({
          tenantId: 'east',
          accountId: 'eve',
          membershipId: 'east-eve',
          status: 'active',
          roles: ['agent'],
          validUntil: Date.now() + 3_600_000,
          expectedVersion: null,
        });
        await operations.finish();
        await again.query('COMMIT');
      } finally {
        await again.end();
      }
    }

    const enrollment = await createTenantEnrollment<IncomingMessage>({
      app,
      pages: [],
      policy,
      source: { ...binding.source, url: primary.url, replicas: [replicaUrl.href] },
      deployment: 'desk-replica-deployment',
      roles: ['agent'],
      maxLifetimeMs: 300_000,
      verifySession: async () => ({ id: 'eve', who: 'eve@example.invalid' }),
    });
    closing.push(() => enrollment.retire());
    const bound = { host: '127.0.0.1', port: 0 };
    const owner = createTenantHttpServer({
      app,
      enrollment,
      bound,
      verifySessionInstance: () => ({
        identity: { id: 'eve', who: 'eve@example.invalid' },
        sessionId: 'session-eve',
        expiresAt: Date.now() + 3_600_000,
      }),
    });
    closing.push(() => owner.retire());
    /* What the authenticated host does around every route (tenantAuthenticatedHttp.ts). */
    const dispatch = owner.server.listeners('request')[0] as (req: IncomingMessage, res: ServerResponse) => void;
    const front = createServer((req, res) => readsAs(readFreshness(req, res, ''), () => dispatch(req, res)));
    closing.push(async () => {
      const stopped = new Promise<void>((resolve) => front.close(() => resolve()));
      front.closeAllConnections();
      await stopped;
    });
    front.listen(0, bound.host);
    await once(front, 'listening');
    bound.port = (front.address() as { port: number }).port;

    const call = async (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Answer> => {
      const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      const text = await response.text();
      return {
        status: response.status,
        text,
        body: JSON.parse(text) as Record<string, unknown>,
        cookie: response.headers.get('set-cookie'),
      };
    };
    const select = (path: string, tenant: string) => `${path}?app=${appId}&tenant=${tenant}`;
    const open = async (tenant: string): Promise<Context> => {
      const reply = await call(select('/api/tenant/context/open', tenant), {});
      assert.equal(reply.status, 200, reply.text);
      return reply.body as unknown as Context;
    };
    const data = (path: string, lease: Context, body: unknown, cookie?: string) =>
      call(select(path, lease.tenantId), body, {
        'x-mistri-tab': lease.tabId,
        'x-mistri-context': lease.context,
        'x-mistri-lease-revision': String(lease.revision),
        'x-mistri-account': lease.accountId,
        ...(cookie ? { cookie } : {}),
      });
    const titles = async (lease: Context, cookie?: string) => {
      const reply = await data('/api/run', lease, { q: 'ticket', limit: 50, offset: 0, count: 'none' }, cookie);
      assert.equal(reply.status, 200, reply.text);
      return (reply.body.rows as Array<Record<string, unknown>>).map((row) => `${row.id}: ${row.title}`).sort();
    };
    const one = async (lease: Context, cookie?: string) => {
      const reply = await data(
        '/api/view/run',
        lease,
        {
          view: { id: 'tickets', name: '', base: 'ticket', columns: [{ path: 'id' }, { path: 'title' }], limit: 1 },
          query: 'id = "north-1"',
        },
        cookie,
      );
      assert.equal(reply.status, 200, reply.text);
      return (reply.body.rows as Array<Record<string, unknown>>)[0]?.title;
    };

    const north = await open('north');
    await t.test("a list reads the replica, and only the lease's tenant there", async () => {
      assert.deepEqual(await titles(north), ['north-1: Printer jammed (replica)', 'north-2: Screen flickers (replica)']);
      const south = await open('south');
      assert.deepEqual(await titles(south), ['south-1: Badge lost (replica)']);
    });

    await t.test("a record's own row reads the primary", async () => {
      assert.equal(await one(north), 'Printer jammed');
    });

    await t.test('a member the replica has not seen yet is answered by the primary', async () => {
      const east = await open('east');
      assert.deepEqual(await titles(east), ['east-1: Door stuck']);
    });

    await t.test('the browser that wrote reads the primary while its marker is fresh; another does not', async () => {
      const wrote = await data('/api/update', north, { table: 'ticket', key: { id: 'north-1' }, values: { title: 'Printer fixed' } });
      assert.equal(wrote.status, 200, wrote.text);
      assert.match(wrote.cookie ?? '', /^mistri_fresh=\d+; Path=\/; Max-Age=10; HttpOnly; SameSite=Lax$/);
      const cookie = wrote.cookie!.split(';')[0];
      assert.deepEqual(await titles(north, cookie), ['north-1: Printer fixed', 'north-2: Screen flickers']);
      assert.deepEqual(await titles(north), ['north-1: Printer jammed (replica)', 'north-2: Screen flickers (replica)']);
    });
  },
);
