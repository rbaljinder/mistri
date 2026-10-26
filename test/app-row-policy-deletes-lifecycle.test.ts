import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import {
  TransactionOutcomeUnknown,
  type DeleteRequest,
  type InsertRequest,
  type UpdateRequest,
} from '../packages/engine/src/adapters/adapter.js';
import { AppAccessDenied } from '../packages/mistri/src/server/app/appAccess.js';
import { loadHttpAppPolicy, type HttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

const appId = 'scoped-delete-lifecycle';
const owners = ['private-delete-operations', 'private-delete-archive'] as const;
const account: Identity = { id: 'editor-one', who: 'editor@example.test', role: 'editor' };
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const update = (body: string) => ({ table: 'note', key: { id: 1 }, values: { body } });
const remove = (id = 3, confirm = true) => ({ table: 'note', key: { id }, confirm });
interface Reply {
  status: number;
  body: {
    affected?: number;
    undoId?: number;
    reverted?: boolean;
    outcome?: string;
    deleted?: boolean | null;
    impact?: unknown[];
    key?: Record<string, unknown>;
    row?: Record<string, unknown>;
    next?: { id: number };
    writes?: Array<{ id: number; undoState?: string; revertible: boolean }>;
    errors?: Array<{ code: string; message: string }>;
  };
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Delete lifecycle did not reach its next boundary')), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function block(phase: 'precommit' | 'commit', unknown = false) {
  return { phase, unknown, entered: gate(), held: gate(), settled: gate(), disconnected: gate(), error: undefined as unknown };
}

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-scoped-delete-lifecycle-'));
  const registry = new Registry();
  const policies: HttpAppPolicy[] = [];
  const databases: DatabaseSync[] = [];
  const events: string[] = [];
  const leases = new Map<string, { acquired: number; released: number }>();
  const control = {
    block: undefined as ReturnType<typeof block> | undefined,
    writes: 0,
    transactions: 0,
    closes: 0,
    verifications: 0,
    role: 'editor',
    accountId: account.id,
    beforeTransaction: undefined as (() => void) | undefined,
  };
  let server: Server | undefined;
  t.after(async () => {
    control.block?.held.release();
    server?.closeAllConnections();
    try {
      for (const policy of policies) await bounded(policy.retire());
    } finally {
      if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await registry.closeAll();
      for (const db of databases) db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  for (const owner of owners) {
    const file = join(directory, `${owner}.db`);
    const db = new DatabaseSync(file);
    databases.push(db);
    db.exec(`CREATE TABLE physical_note (id INTEGER PRIMARY KEY, body TEXT, desk INTEGER NOT NULL DEFAULT 1, title TEXT DEFAULT 'Stored default title');
      INSERT INTO physical_note VALUES (1, 'Original', 1, 'Visible title'), (2, 'Hidden', 2, 'Hidden title'),
        (3, 'Deleted private body', 1, 'Stored original title'),
        (4, 'Other account body', 1, 'Other title'), (5, 'Pending account body', 1, 'Pending title');`);
    registry.add({ id: owner, name: owner, url: file, writable: owner === owners[0], source: 'config' });
    const { adapter } = await registry.open(owner);
    const close = adapter.close.bind(adapter);
    adapter.close = async () => {
      control.closes++;
      await close();
    };
    if (owner === owners[0]) {
      // Install once BEFORE deployment captures trusted method identities. Wrap
      // the frozen transaction rather than replacing any captured method later.
      const scoped = adapter.scopeTransaction!.bind(adapter);
      adapter.scopeTransaction = async (rows, run) => {
        const held = control.block;
        control.transactions++;
        control.beforeTransaction?.();
        let wrote = false;
        try {
          const result = await scoped(rows, (tx, catalog) => {
            const pause = async <T>(operation: Promise<T>) => {
              const result = await operation;
              wrote = true;
              control.writes++;
              events.push('transaction.wrote');
              if (held?.phase === 'precommit') {
                held.entered.release();
                await held.held.promise;
              }
              return result;
            };
            return run(
              Object.freeze({
                ...tx,
                query: async (request: Parameters<typeof tx.query>[0]) => {
                  events.push('transaction.query');
                  return tx.query(request);
                },
                insert: (request: InsertRequest) => pause(tx.insert(request)),
                remove: (request: DeleteRequest) => {
                  events.push('transaction.remove');
                  return pause(tx.remove(request));
                },
                update: (request: UpdateRequest) => pause(tx.update(request)),
              }),
              catalog,
            );
          });
          if (wrote && held?.phase === 'commit') {
            // A separate SQLite observer can now prove that COMMIT landed.
            events.push('transaction.committed');
            held.entered.release();
            await held.held.promise;
            if (held.unknown) throw new TransactionOutcomeUnknown(new Error('PRIVATE physical_note commit acknowledgment lost'));
          }
          return result;
        } finally {
          if (wrote) events.push('transaction.finished');
        }
      };
    }
    const fallback = async (): Promise<never> => assert.fail('Scoped deletes used an ordinary adapter capability');
    adapter.query = fallback;
    adapter.count = fallback;
    adapter.update = fallback;
    adapter.insert = fallback;
    adapter.remove = fallback;
    adapter.transaction = fallback;
    adapter.commandTransaction = fallback;
  }
  const lease = registry.lease.bind(registry);
  registry.lease = (owner) => {
    const counts = leases.get(owner) ?? { acquired: 0, released: 0 };
    leases.set(owner, counts);
    counts.acquired++;
    const release = lease(owner);
    return () => {
      counts.released++;
      events.push(`release:${owner}`);
      release();
    };
  };
  const app = parseAppConfig(
    {
      id: appId,
      name: 'Delete lifecycle',
      sources: {
        operations: { connection: owners[0], default: true },
        archive: { connection: owners[1] },
      },
      resources: {
        note: {
          physical: 'physical_note',
          access: 'write',
          delete: true,
          fields: { read: ['id', 'body', 'desk', 'title'], write: ['id', 'body', 'desk', 'title'] },
        },
        'archive.note': { physical: 'physical_note' },
      },
      auth: {
        rows: 'policy',
        roles: {
          editor: { read: true, write: true },
          restricted: { read: true, write: true, fields: { note: { read: ['id', 'title'], write: ['title'] } } },
        },
      },
      views: { note: { kind: 'list', from: 'note' } },
      home: 'note',
      nav: ['note'],
    },
    'scoped delete lifecycle fixture',
  );
  const file = join(directory, 'policy.mjs');
  writeFileSync(
    file,
    `let allowed = true;
    const calls = [];
    export function setAllowed(value) { allowed = value; }
    export function getCalls() { return calls.slice(); }
    export default { appId: '${appId}', resolveRows: () => ({
      note: { groups: [[{ column: 'desk', op: '=', value: 1 }]] }, 'archive.note': true }),
      authorizeDeletedRecord(principal, record) {
        calls.push({ principal, record, allowed });
        return allowed;
      } };`,
  );
  const host: AppHost = {
    app: { path: join(directory, 'app.ts'), app, pages: [], sources: {} },
    pages: [],
    auth: {
      spec: app.auth!,
      store: join(directory, 'sessions.db'),
      handler: async () => {},
      close() {},
      session: async () => ({ ...account, id: control.accountId, role: control.role }),
    },
  };
  const deploy = async () => {
    const policy = await loadHttpAppPolicy({
      app,
      registry,
      file,
      verifySession: async () => {
        control.verifications++;
        return { ...account, id: control.accountId, role: control.role };
      },
    });
    assert.ok(Object.isFrozen(policy));
    assert.ok(Object.isFrozen(policy.updates));
    const observed = Object.freeze<HttpAppPolicy>({
      ...policy,
      withContext: (request, run) => {
        const held = request.headers['x-lifecycle-held'] ? control.block : undefined;
        const invocation = policy.withContext(request, async (context) => {
          assert.ok(Object.isFrozen(context));
          assert.ok(Object.isFrozen(context.data));
          assert.ok(Object.isFrozen(context.writeFields));
          return run(context);
        });
        void invocation.then(
          () => {
            held?.settled.release();
          },
          (error) => {
            if (held) {
              held.error = error;
              held.settled.release();
            }
          },
        );
        return invocation;
      },
    });
    policies.push(observed);
    return observed;
  };
  const policy = await deploy();
  const bound = { host: '127.0.0.1', port: 0 };
  const serving = { registry, bound, apps: [host], policy };
  server = createApp(serving);
  server.prependListener('request', (request, response) => {
    if (request.headers['x-lifecycle-held']) {
      const held = control.block;
      response.once('close', () => held?.disconnected.release());
    }
  });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  const base = `http://${bound.host}:${bound.port}`;
  const post = async (path: string, body: Record<string, unknown> = {}): Promise<Reply> => {
    const response = await fetch(`${base}/api/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mistri-account': control.accountId },
      body: JSON.stringify({ app: appId, ...body }),
      signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, body: await response.json() };
  };
  const start = (path: string, body: Record<string, unknown>) => {
    const client = httpRequest(`${base}/api/${path}`, {
      method: 'POST',
      agent: false,
      headers: { 'content-type': 'application/json', 'x-mistri-account': control.accountId, 'x-lifecycle-held': 'yes' },
    });
    const response = new Promise<Reply | Error>((resolve) => {
      client.once('error', resolve);
      client.once('response', (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.once('error', resolve);
        res.once('end', () => resolve({ status: res.statusCode!, body: JSON.parse(body) }));
      });
    });
    client.end(JSON.stringify({ app: appId, ...body }));
    return { client, response };
  };
  const heldLeases = () => {
    assert.deepEqual(
      [...leases],
      owners.map((owner) => [owner, { acquired: 1, released: 0 }]),
    );
    assert.equal(control.closes, 0);
  };
  const state = () => databases[0].prepare('SELECT body FROM physical_note WHERE id = 1').get()!.body;
  const save = async (value: string) => {
    const reply = await post('update', update(value));
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.affected, 1);
    assert.equal(reply.body.undoId, undefined);
  };
  const row = (id = 3) => {
    const result = databases[0].prepare('SELECT * FROM physical_note WHERE id = ?').get(id);
    return result ? { ...result } : undefined;
  };
  return { post, start, save, policy, control, events, leases, heldLeases, state, row };
}

function successful(reply: Reply | Error): asserts reply is Reply {
  assert.ok(!(reply instanceof Error), 'accepted request lost its HTTP response');
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.doesNotMatch(JSON.stringify(reply.body), /PRIVATE|physical_note|private-delete|policy-update:|acknowledgment/);
}
function confirmedDelete(reply: Reply | Error): asserts reply is Reply {
  successful(reply);
  // An App has no Undo: a deletion carries no token to take it back.
  assert.deepEqual(reply.body, { impact: [], deleted: true, affected: 1 });
}

test('scoped deletion: socket abort before commit rolls back, and the same request then deletes', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  await f.save('First');
  const before = f.row();
  const held = (f.control.block = block('precommit'));
  const pending = f.start('delete', remove());
  try {
    await bounded(held.entered.promise);
    assert.deepEqual(f.row(), before);
    pending.client.destroy();
    await bounded(held.disconnected.promise);
    const lost = await bounded(pending.response);
    assert.ok(lost instanceof Error);
    assert.equal((lost as NodeJS.ErrnoException).code, 'ECONNRESET');
    f.heldLeases();
    held.held.release();
    await bounded(held.settled.promise);
    assert.ok(held.error instanceof AppAccessDenied);
    assert.deepEqual(f.row(), before, 'disconnect must roll back the real SQLite mutation');
    f.control.block = undefined;
    confirmedDelete(await f.post('delete', remove()));
    assert.equal(f.row(), undefined);
    assert.equal(f.state(), 'First');
  } finally {
    held.held.release();
    pending.client.destroy();
  }
});

for (const phase of ['precommit', 'commit', 'unknowncommit'] as const) {
  test(`scoped deletion: retirement during ${phase} drains all sources after settlement`, { timeout: 10_000 }, async (t) => {
    const f = await fixture(t);
    await f.save('First');
    const before = f.row();
    const held = (f.control.block = block(phase === 'precommit' ? 'precommit' : 'commit', phase === 'unknowncommit'));
    const pending = f.start('delete', remove());
    try {
      await bounded(held.entered.promise);
      assert.deepEqual(f.row(), phase === 'precommit' ? before : undefined);
      f.heldLeases();
      const retirement = f.policy.retire();
      assert.equal(f.policy.retire(), retirement);
      let retired = false;
      void retirement.then(() => {
        retired = true;
      });
      const verifications = f.control.verifications;
      assert.equal((await f.post('update', update('Late'))).status, 503);
      assert.equal(f.control.verifications, verifications, 'retirement rejects new work before session verification');
      await turn();
      assert.equal(retired, false);
      f.heldLeases();
      held.held.release();
      await bounded(retirement);
      const response = await bounded(pending.response);
      assert.ok(!(response instanceof Error));
      assert.doesNotMatch(JSON.stringify(response.body), /PRIVATE|physical_note|private-delete|acknowledgment/);
      if (phase === 'precommit') {
        assert.equal(response.status, 403);
        assert.equal(response.body.outcome, 'rejected');
        assert.equal(response.body.deleted, false);
        assert.ok(held.error instanceof AppAccessDenied);
      } else {
        successful(response);
        if (phase === 'unknowncommit') {
          assert.equal(response.body.outcome, 'unknown');
          assert.equal(response.body.deleted, null);
          assert.ok(held.error instanceof TransactionOutcomeUnknown);
        } else {
          assert.equal(held.error, undefined);
          confirmedDelete(response);
        }
      }
      assert.deepEqual(f.row(), phase === 'precommit' ? before : undefined);
      assert.equal(f.state(), 'First');
      assert.deepEqual(
        [...f.leases],
        owners.map((owner) => [owner, { acquired: 1, released: 1 }]),
      );
      for (const owner of owners) assert.ok(f.events.lastIndexOf(`release:${owner}`) > f.events.lastIndexOf('transaction.finished'));
      await f.policy.retire();
      assert.equal(f.control.closes, 0, 'retirement releases leases without closing registry-owned adapters');
      assert.deepEqual(
        [...f.leases],
        owners.map((owner) => [owner, { acquired: 1, released: 1 }]),
      );
    } finally {
      held.held.release();
      pending.client.destroy();
    }
  });
}
