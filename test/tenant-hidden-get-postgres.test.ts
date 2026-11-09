/**
 * A command's typed get of a row that belongs to another tenant is, on PostgreSQL, the very refusal a key that
 * does not exist gets: the same words, the same code, nothing that says the row is there (a field report; the
 * SQLite and single-database cases are in tenant-member-gaps.test.ts and scoped-command-execution.test.ts).
 * Skipped unless TABLEWALK_TEST_PG is set; owns a UUID-named database beside it and drops it.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { test } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { createTenantHttpServer } from '../packages/mistri/src/server/tenant/tenantHttp.js';
import {
  createPostgresTenantAdministration,
  migratePostgresTenantStore,
} from '../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import { liveSkip } from './live.js';
import { parseTestApp } from './support/commandCatalog.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';

const LIVE = process.env.TABLEWALK_TEST_PG;

test(
  "a typed get of another tenant's row is the very refusal a key that does not exist gets, on PostgreSQL",
  { skip: liveSkip('postgres', LIVE), timeout: 120_000 },
  async (t) => {
    const appId = 'hidden-get';
    const binding = { appId, source: { id: 'business', connection: `${appId}-db` }, storeId: `${appId}-store` };
    const peeked: Record<string, unknown> = {};
    const app = parseTestApp(
      {
        id: appId,
        name: 'Hidden get',
        auth: { rows: 'tenant', roles: { agent: { read: true, commands: ['peek'] } } },
        sources: { business: { connection: binding.source.connection } },
        resources: { ticket: { owner: 'tenant', access: 'write', fields: { read: ['id', 'title'], write: ['id', 'title'] } } },
        views: { tickets: { kind: 'list', from: 'ticket' } },
        nav: ['tickets'],
        home: 'tickets',
      },
      'hidden get fixture',
    );
    const rows: RowScope = { ticket: true };
    const policy = defineAppTenantPolicy({
      kind: 'tenant',
      appId,
      storeId: binding.storeId,
      ownership: { ticket: { kind: 'tenant', column: 'tenant_id' } },
      resolveMembershipRows: () => rows,
      resolveRows: () => rows,
      resultReferences: { peek: () => [] },
    });
    const registry = defineCommands({
      peek: defineCommand({
        source: 'business',
        target: 'ticket',
        targets: 'none',
        read: ['ticket'],
        input: {},
        output: { parse: (value: unknown) => value },
        async handle({ db: records }) {
          for (const id of ['north-1', 'south-1', 'no-such-ticket']) {
            try {
              peeked[id] = { returned: await records.ticket.get(id) };
            } catch (error) {
              const { code, message, outcome, field, key } = error as Record<string, unknown>;
              peeked[id] = { thrown: { name: (error as Error).constructor.name, code, message, outcome, field, key } };
            }
          }
          return {};
        },
      }),
    });
    const database = await uuidPostgresDatabase('tw_hidden_get');
    const closing: Array<() => Promise<void>> = [];
    t.after(async () => {
      for (const close of closing.reverse()) await close().catch(() => {});
      await database.drop();
    });
    const control = await pgClient(database.url);
    closing.push(() => control.end());
    await control.query(`CREATE TABLE ticket (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, title TEXT NOT NULL);
      INSERT INTO ticket VALUES ('north-1', 'north', 'Printer jammed'), ('south-1', 'south', 'South secret');`);
    await migratePostgresTenantStore(database.url, binding);
    await migratePostgresCommandJournal(database.url);
    await control.query('BEGIN');
    const operations = new TransactionOperations();
    const store = createPostgresTenantAdministration(control, operations, binding);
    for (const tenantId of ['north', 'south']) {
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
    }
    await operations.finish();
    await control.query('COMMIT');
    const enrollment = await createTenantEnrollment<IncomingMessage>({
      app,
      pages: [],
      policy,
      source: { ...binding.source, url: database.url },
      deployment: `${appId}-deployment`,
      roles: ['agent'],
      maxLifetimeMs: 300_000,
      commands: { registry },
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
    closing.push(async () => {
      const stopped = new Promise<void>((resolve) => owner.server.close(() => resolve()));
      owner.server.closeAllConnections();
      await stopped;
      await owner.retire();
    });
    owner.server.listen(0, bound.host);
    await once(owner.server, 'listening');
    bound.port = (owner.server.address() as { port: number }).port;
    const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
      const response = await fetch(`http://${bound.host}:${bound.port}${path}?app=${appId}&tenant=north`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      return { status: response.status, text, body: JSON.parse(text) as Record<string, unknown> };
    };
    const opened = await post('/api/tenant/context/open', {});
    assert.equal(opened.status, 200, opened.text);
    const lease = opened.body as { tabId: string; context: string; accountId: string; revision: number };
    const receipt = await post(
      '/api/commands/execute',
      { command: 'peek', commandVersion: 1, key: {}, expectedVersion: 0, idempotencyKey: 'peek-attempt-0001', input: {} },
      {
        'x-mistri-tab': lease.tabId,
        'x-mistri-context': lease.context,
        'x-mistri-lease-revision': String(lease.revision),
        'x-mistri-account': lease.accountId,
      },
    );
    assert.equal(receipt.status, 200, receipt.text);
    assert.equal(receipt.body.status, 'applied', receipt.text);
    assert.ok('returned' in (peeked['north-1'] as object), 'the tenant reads its own row');
    assert.deepEqual(peeked['south-1'], peeked['no-such-ticket']);
    assert.equal(((peeked['south-1'] as { thrown: { message: string } }).thrown ?? {}).message, 'The record was not found.');
  },
);
