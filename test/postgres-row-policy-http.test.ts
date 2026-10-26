/**
 * The HTTP row-policy runtime on a PostgreSQL registry entry.
 *
 * The `app-row-policy-*-http` suites prove the enrolled routes on SQLite,
 * with hooks on the adapter to observe each transaction. This file runs the
 * core cases of update, creation and deletion against a real PostgreSQL
 * source, unhooked: what is asserted is the database, read on a separate
 * control connection, before and after every route. An App has no Undo, and
 * a save that waits out another transaction's row lock is refused with 503,
 * `Retry-After` and nothing applied.
 *
 * Live and opt-in like postgres-scoped-transactions.test.ts.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal, history } from '../packages/engine/src/server/journal.js';
import { loadHttpAppPolicy, type HttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { configureLockTimeout, configureWriteOrder } from '../packages/engine/src/adapters/writeLanes.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
// An App's order: writes by record on a writer pool (writeLanes.ts).
configureWriteOrder('keyed');
const appId = 'scoped-postgres-http';
const owner = 'private-postgres-operations';
const account: Identity = { id: 'desk-one', who: 'editor@example.test', role: 'editor' };

interface Control extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}
async function client(): Promise<Control> {
  const specifier = 'pg';
  const pg = (await import(specifier)) as { default?: { Client: new (c: unknown) => Control }; Client?: new (c: unknown) => Control };
  const Client = (pg.Client ?? pg.default?.Client)!;
  const created = new Client({ connectionString: LIVE, statement_timeout: 10_000 });
  await created.connect();
  return created;
}

const RESET = [`DROP TABLE IF EXISTS public.physical_ticket, public.physical_reviewer CASCADE`];
const SETUP = [
  `CREATE TABLE public.physical_reviewer (id integer PRIMARY KEY, desk integer NOT NULL, name text)`,
  `CREATE TABLE public.physical_ticket (id serial PRIMARY KEY, desk integer NOT NULL,
     reviewer_id integer REFERENCES public.physical_reviewer (id), name text, status text DEFAULT 'open', private_note text)`,
  `INSERT INTO public.physical_reviewer VALUES (1, 1, 'Ada'), (2, 2, 'HIDDEN reviewer'), (3, 1, 'Grace')`,
  `INSERT INTO public.physical_ticket (id, desk, reviewer_id, name, status, private_note) VALUES
     (1, 1, 1, 'Original ticket', 'open', 'PRIVATE note'), (2, 2, 2, 'HIDDEN ticket', 'open', 'PRIVATE note'),
     (3, 1, 2, 'Visible with hidden parent', 'open', 'PRIVATE note'), (4, 1, 1, 'Another visible ticket', 'held', NULL)`,
  `SELECT setval(pg_get_serial_sequence('public.physical_ticket', 'id'), 4)`,
];

describe('the HTTP row-policy runtime on PostgreSQL, against a real server', { skip: liveSkip('postgres', LIVE) }, () => {
  let control: Control;
  const ticket = async (id: number) => (await control.query('SELECT * FROM public.physical_ticket WHERE id = $1', [id])).rows[0];
  const tickets = async () => (await control.query('SELECT * FROM public.physical_ticket ORDER BY id')).rows;

  before(async () => {
    control = await client();
  });
  after(async () => {
    for (const statement of RESET) await control.query(statement).catch(() => {});
    await control.end();
  });

  async function fixture(
    run: (f: {
      request(path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> & Record<string, any> }>;
    }) => Promise<void>,
  ) {
    for (const statement of [...RESET, ...SETUP]) await control.query(statement);
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-postgres-row-policy-'));
    const registry = new Registry();
    const servers: Server[] = [];
    const policies: HttpAppPolicy[] = [];
    try {
      registry.add({ id: owner, name: owner, url: LIVE!, source: 'config', writable: true });
      const app = parseAppConfig(
        {
          id: appId,
          name: 'Scoped PostgreSQL',
          auth: { rows: 'policy', roles: { editor: { read: true, write: ['ticket'] }, viewer: { read: true } } },
          sources: { operations: { connection: owner } },
          resources: {
            ticket: { physical: 'public.physical_ticket', access: 'write', delete: true },
            reviewer: { physical: 'public.physical_reviewer' },
          },
          views: { tickets: { kind: 'list', from: 'ticket' } },
          home: 'tickets',
          nav: ['tickets'],
        },
        'scoped PostgreSQL HTTP fixture',
      );
      const host: AppHost = {
        app: { app, path: join(directory, 'app.ts'), pages: [], sources: {} },
        pages: [],
        auth: { spec: app.auth!, store: join(directory, 'auth.db'), close() {}, handler: async () => {}, session: async () => account },
      };
      const file = join(directory, 'policy.mjs');
      writeFileSync(
        file,
        `export default { appId: ${JSON.stringify(appId)},
        authorizeDeletedRecord() { return true; },
        resolveRows() {
          const eq = { groups: [[{ column: 'desk', op: '=', value: 1 }]] };
          return { ticket: eq, reviewer: eq };
        }
      };`,
      );
      const policy = await loadHttpAppPolicy({ app, registry, file, verifySession: async () => account });
      policies.push(policy);
      const bound = { host: '127.0.0.1', port: 0 };
      const server = createApp({ registry, bound, apps: [host], policy });
      servers.push(server);
      server.listen(0, bound.host);
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      bound.port = address.port;
      await run({
        request: async (path, body) => {
          const url = new URL(path, `http://${bound.host}:${bound.port}`);
          url.searchParams.set('app', appId);
          const response = await fetch(url, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { 'content-type': 'application/json', 'x-mistri-account': account.id },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(10_000),
          });
          const payload = await response.json();
          // Constraint names and sequence defaults are public relation addresses
          // in the existing schema contract; row content and credentials are not.
          assert.doesNotMatch(JSON.stringify(payload), /PRIVATE|HIDDEN|postgres:/);
          return { status: response.status, body: payload };
        },
      });
    } finally {
      for (const server of servers) {
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeAllConnections();
        await closed;
      }
      for (const policy of policies) await policy.retire();
      await registry.closeAll();
      clearJournal(owner);
      rmSync(directory, { recursive: true, force: true });
    }
  }

  const written = (reply: { status: number; body: Record<string, unknown> }) => {
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.undoId, undefined, 'An App has no Undo');
  };

  test('the manifest advertises the PostgreSQL source as writable, creatable and deletable, and hides other desks', async () => {
    await fixture(async (f) => {
      const manifest = await f.request('/api/app');
      assert.equal(manifest.status, 200);
      assert.deepEqual(manifest.body.app.writableTables, ['ticket']);
      const schema = await f.request('/api/schema');
      const table = schema.body.tables.find((table: { id: string }) => table.id === 'ticket');
      assert.equal(table.insertable, true);
      assert.equal(table.deletable, true);
      const rows = await f.request('/api/query', {
        table: 'ticket',
        columns: ['id'],
        orderBy: [{ column: 'id', direction: 'asc' }],
        limit: 20,
        offset: 0,
      });
      assert.equal(rows.status, 200, JSON.stringify(rows.body));
      assert.deepEqual(
        rows.body.rows.map((row: { id: number }) => row.id),
        [1, 3, 4],
      );
    });
  });

  test('a scoped update commits on the PostgreSQL writer, journals nothing, and a stale image conflicts', async () => {
    await fixture(async (f) => {
      const before = await ticket(1);
      written(
        await f.request('/api/update', {
          table: 'ticket',
          key: { id: 1 },
          values: { name: 'Saved ticket' },
          expected: { name: 'Original ticket' },
        }),
      );
      assert.deepEqual(await ticket(1), { ...before, name: 'Saved ticket' });
      assert.deepEqual(history(owner), [], 'An App journals nothing');
      assert.equal((await f.request('/api/revert', { confirm: true, expectedId: 1 })).status, 404);
      // A hidden row refuses without a write, and a stale image conflicts.
      const hidden = await f.request('/api/update', { table: 'ticket', key: { id: 2 }, values: { name: 'Taken' } });
      assert.ok([400, 403, 409].includes(hidden.status), JSON.stringify(hidden.body));
      const stale = await f.request('/api/update', {
        table: 'ticket',
        key: { id: 1 },
        values: { name: 'Stale' },
        expected: { name: 'Original ticket' },
      });
      assert.equal(stale.status, 409, JSON.stringify(stale.body));
      assert.deepEqual(await ticket(1), { ...before, name: 'Saved ticket' });
    });
  });

  test("a scoped update that waits out another transaction's row lock is refused with 503 and Retry-After, nothing applied", async () => {
    configureLockTimeout(400);
    try {
      await fixture(async (f) => {
        const before = await ticket(3);
        const holder = await client();
        try {
          await holder.query('BEGIN');
          await holder.query('SELECT 1 FROM public.physical_ticket WHERE id = 3 FOR UPDATE');
          const reply = await f.request('/api/update', { table: 'ticket', key: { id: 3 }, values: { name: 'Locked out' } });
          assert.equal(reply.status, 503, JSON.stringify(reply.body));
          assert.deepEqual([reply.body.code, reply.body.outcome], ['row_locked', 'not_applied']);
        } finally {
          await holder.query('COMMIT').catch(() => {});
          await holder.end();
        }
        assert.deepEqual(await ticket(3), before);
      });
    } finally {
      configureLockTimeout();
    }
  });

  test('a scoped creation stores defaults and returns the stored row', async () => {
    await fixture(async (f) => {
      const before = await tickets();
      const added = await f.request('/api/insert', { table: 'ticket', values: { desk: 1, reviewer_id: 3, name: 'Created' } });
      written(added);
      assert.deepEqual(added.body.row, { id: 5, desk: 1, reviewer_id: 3, name: 'Created', status: 'open', private_note: null });
      assert.deepEqual(await ticket(5), added.body.row);
      const escaped = await f.request('/api/insert', { table: 'ticket', values: { desk: 2, name: 'Escapes' } });
      assert.ok([400, 403, 409].includes(escaped.status), JSON.stringify(escaped.body));
      const hiddenParent = await f.request('/api/insert', { table: 'ticket', values: { desk: 1, reviewer_id: 2, name: 'Hidden parent' } });
      assert.ok([400, 403, 409].includes(hiddenParent.status), JSON.stringify(hiddenParent.body));
      assert.equal((await tickets()).length, before.length + 1);
    });
  });

  test('a confirmed scoped deletion removes the row on the writer', async () => {
    await fixture(async (f) => {
      const original = await ticket(4);
      const preview = await f.request('/api/delete', { table: 'ticket', key: { id: 4 }, confirm: false });
      assert.equal(preview.status, 200, JSON.stringify(preview.body));
      assert.deepEqual(await ticket(4), original);
      const removed = await f.request('/api/delete', { table: 'ticket', key: { id: 4 }, confirm: true });
      written(removed);
      assert.equal(removed.body.deleted, true);
      assert.equal(await ticket(4), undefined);
      const hidden = await f.request('/api/delete', { table: 'ticket', key: { id: 2 }, confirm: true });
      assert.ok([400, 403, 409].includes(hidden.status), JSON.stringify(hidden.body));
      assert.equal((await ticket(2)).name, 'HIDDEN ticket');
    });
  });
});
