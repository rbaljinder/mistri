import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import {
  COMMAND_JOURNAL_TABLES,
  CommandTransactionFailure,
  migrateSqliteCommandJournal,
} from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { sqliteAuditRows } from './support/commandTargets.js';
import { loadHttpAppPolicy, type HttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { BusinessCommandExecutionError } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { parseTestApp } from './support/commandCatalog.js';
import { commandsOf } from '../packages/mistri/src/server/stores/commandStores.js';

const appId = 'scoped-command-lifecycle';
const owners = ['private-operations', 'private-archive'] as const;
const account: Identity = { id: 'operator-one', who: 'operator@example.test', role: 'operator' };
const attempt = {
  command: 'advance',
  commandVersion: 1,
  key: { id: 1 },
  expectedVersion: 0,
  idempotencyKey: 'lifecycle-command-attempt-0001',
  input: {},
};
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
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
        timer = setTimeout(() => reject(new Error('Command lifecycle did not reach its next boundary')), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-scoped-command-lifecycle-'));
  const registry = new Registry();
  const policies: HttpAppPolicy[] = [];
  const databases: DatabaseSync[] = [];
  let server: Server | undefined;
  const entered = gate(),
    held = gate(),
    disconnected = gate();
  const events: string[] = [];
  const leases = new Map<string, { acquired: number; released: number }>();
  const control = {
    phase: undefined as 'handler' | 'commit' | undefined,
    calls: 0,
    settled: 0,
    closes: 0,
    verifications: 0,
    error: undefined as unknown,
  };
  t.after(async () => {
    held.release();
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
    db.exec(`CREATE TABLE physical_ticket (id INTEGER PRIMARY KEY, desk INTEGER NOT NULL, version INTEGER NOT NULL);
      CREATE TABLE physical_note (id INTEGER PRIMARY KEY, body TEXT);
      INSERT INTO physical_ticket VALUES (1, 1, 0), (2, 2, 0);
      INSERT INTO physical_note VALUES (1, 'Fixture only');`);
    if (owner === owners[0]) migrateSqliteCommandJournal(file);
    registry.add({ id: owner, name: owner, url: file, writable: owner === owners[0], source: 'config' });
    const { adapter } = await registry.open(owner);
    const close = adapter.close.bind(adapter);
    adapter.close = async () => {
      control.closes++;
      await close();
    };
    if (owner === owners[0]) {
      const scoped = commandsOf(adapter).scopeCommandTransaction!.bind(adapter);
      adapter.scopeCommandTransaction = async (rows, run) => {
        try {
          const result = await scoped(rows, run);
          if (control.phase === 'commit') {
            // SQLite has really committed before the acknowledgment is delayed/lost.
            events.push('committed');
            entered.release();
            await held.promise;
            throw new CommandTransactionFailure(new Error('PRIVATE lost commit acknowledgment'), 'unknown');
          }
          return result;
        } finally {
          events.push('transaction.finished');
        }
      };
    }
    const fallback = async (): Promise<never> => assert.fail('Scoped HTTP lifecycle used an ordinary adapter capability');
    adapter.query = fallback;
    adapter.count = fallback;
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
  const app = parseTestApp(
    {
      id: appId,
      name: 'Command lifecycle',
      track: 'receipts',
      auth: { rows: 'policy', roles: { operator: { read: true, commands: ['advance'] } } },
      sources: {
        operations: { connection: owners[0], default: true },
        archive: { connection: owners[1] },
      },
      resources: {
        ticket: {
          physical: 'physical_ticket',
          access: 'write',
          actions: {
            advance: {
              label: 'Advance',
              command: {
                id: 'advance',
                version: 1,
                target: 'ticket',
                input: {},
              },
            },
          },
        },
        'archive.note': { physical: 'physical_note' },
      },
      views: { ticket: { kind: 'list', from: 'ticket' } },
      home: 'ticket',
      nav: ['ticket'],
    },
    'scoped command lifecycle fixture',
  );
  const commands = defineCommands({
    advance: defineCommand({
      source: 'operations',
      target: 'ticket',
      read: ['ticket'],
      write: ['ticket'],
      input: {},
      output: { parse: (value: unknown) => ({ version: (value as { version: number }).version }) },
      async handle({ db, record }) {
        control.calls++;
        const { version } = await db.ticket.update(record, { version: Number(record.version) + 1 });
        if (control.phase === 'handler') {
          events.push('handler.wrote');
          entered.release();
          await held.promise;
        }
        return { version: Number(version) };
      },
    }),
  });
  const file = join(directory, 'policy.mjs');
  writeFileSync(
    file,
    `export default { appId: '${appId}',
    resolveRows: () => ({ ticket: { groups: [[{ column: 'desk', op: '=', value: 1 }]] }, 'archive.note': true }),
    resultReferences: { advance: () => [] } };`,
  );
  const host: AppHost = {
    app: { path: join(directory, 'app.ts'), app, pages: [], sources: {} },
    pages: [],
    auth: { spec: app.auth!, store: join(directory, 'sessions.db'), handler: async () => {}, close() {}, session: async () => account },
  };
  const deploy = async () => {
    const policy = await loadHttpAppPolicy({
      app,
      registry,
      file,
      commands,
      verifySession: async () => {
        control.verifications++;
        return account;
      },
    });
    policies.push(policy);
    return policy;
  };
  const policy = await deploy();
  const observed: HttpAppPolicy = {
    ...policy,
    withContext: (request, run) => {
      const invocation = policy.withContext(request, run);
      void invocation.then(
        () => {
          control.settled++;
        },
        (error) => {
          control.settled++;
          control.error = error;
        },
      );
      return invocation;
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const serving = { registry, bound, apps: [host], policy: observed };
  server = createApp(serving);
  server.prependListener('request', (request, response) => {
    if (request.headers['x-lifecycle-disconnect']) response.once('close', disconnected.release);
  });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  const base = `http://${bound.host}:${bound.port}`;
  const post = async (path: string) => {
    const response = await fetch(`${base}/api/commands/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mistri-account': account.id },
      body: JSON.stringify(attempt),
      signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, body: await response.json() };
  };
  const heldLeases = () => {
    assert.deepEqual(
      [...leases],
      owners.map((owner) => [owner, { acquired: 1, released: 0 }]),
    );
    assert.equal(control.closes, 0);
  };
  const state = () => ({
    version: databases[0].prepare('SELECT version FROM physical_ticket WHERE id = 1').get()!.version,
    receipts: databases[0].prepare(`SELECT count(*) AS n FROM ${COMMAND_JOURNAL_TABLES.receipt}`).get()!.n,
    audits: databases[0].prepare(`SELECT count(*) AS n FROM ${sqliteAuditRows} a`).get()!.n,
  });
  events.length = 0;
  return { base, post, policy, deploy, serving, entered, held, disconnected, control, events, leases, heldLeases, state };
}

for (const phase of ['handler', 'commit'] as const)
  for (const disconnect of [false, true]) {
    test(
      `scoped command HTTP: retirement ${phase === 'handler' ? 'before commit' : 'after commit'}${disconnect ? ' with socket loss' : ''} drains all source leases and preserves outcomes`,
      { timeout: 10_000 },
      async (t) => {
        const f = await fixture(t);
        f.control.phase = phase;
        const client = httpRequest(`${f.base}/api/commands/execute`, {
          method: 'POST',
          agent: false,
          headers: {
            'content-type': 'application/json',
            'x-mistri-account': account.id,
            ...(disconnect ? { 'x-lifecycle-disconnect': 'yes' } : {}),
          },
        });
        const response = new Promise<{ status: number; body: Record<string, unknown> } | Error>((resolve) => {
          client.once('error', resolve);
          client.once('response', (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
              body += chunk;
            });
            res.once('end', () => resolve({ status: res.statusCode!, body: JSON.parse(body) }));
          });
        });
        client.end(JSON.stringify(attempt));
        try {
          await bounded(f.entered.promise);
          f.heldLeases();
          const committed = { version: 1, receipts: 1, audits: 1 };
          const unchanged = { version: 0, receipts: 0, audits: 0 };
          assert.deepEqual(f.state(), phase === 'commit' ? committed : unchanged);
          if (disconnect) {
            client.destroy();
            await bounded(f.disconnected.promise);
            const error = await bounded(response);
            assert.ok(error instanceof Error);
            assert.equal((error as NodeJS.ErrnoException).code, 'ECONNRESET');
          }
          const retirement = f.policy.retire();
          assert.equal(f.policy.retire(), retirement);
          let retired = false;
          void retirement.then(() => {
            retired = true;
          });
          const before = f.control.verifications;
          const unavailable = await f.post('status');
          assert.equal(unavailable.status, 503);
          assert.equal(unavailable.body.outcome, 'unknown');
          assert.equal(f.control.verifications, before, 'retired deployment must refuse before resolving another policy');
          await turn();
          assert.equal(retired, false);
          assert.equal(f.control.settled, 0);
          f.heldLeases();
          f.held.release();
          await bounded(retirement);
          assert.equal(f.control.settled, 1);
          assert.ok(f.control.error instanceof BusinessCommandExecutionError);
          const outcome = phase === 'commit' ? 'unknown' : 'not_applied';
          assert.equal(f.control.error.outcome, outcome, 'retirement must preserve the executor-confirmed outcome');
          if (!disconnect) {
            const result = await bounded(response);
            assert.ok(!(result instanceof Error), 'retirement dropped an accepted request');
            assert.equal(result.body.outcome, outcome);
            assert.equal(result.status, phase === 'commit' ? 503 : 403);
            assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE|physical_ticket|acknowledgment/);
          }
          assert.deepEqual(f.state(), phase === 'commit' ? committed : unchanged);
          assert.deepEqual(
            [...f.leases],
            owners.map((owner) => [owner, { acquired: 1, released: 1 }]),
          );
          for (const owner of owners) assert.ok(f.events.indexOf(`release:${owner}`) > f.events.indexOf('transaction.finished'));
          await f.policy.retire();
          assert.equal(f.control.closes, 0, 'retirement must not close registry-owned sources');
          assert.deepEqual(
            [...f.leases],
            owners.map((owner) => [owner, { acquired: 1, released: 1 }]),
          );
          // A new deployment can reconcile the same durable attempt after retirement.
          f.control.phase = undefined;
          f.serving.policy = await f.deploy();
          const recovered = await f.post('status');
          assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
          if (phase === 'commit') {
            assert.deepEqual(recovered.body.result, { version: 1 });
            assert.equal(recovered.body.replayed, true);
          } else assert.deepEqual(recovered.body, { status: 'not_found', outcome: 'unknown' });
          assert.equal(f.control.calls, 1, 'reconciliation must not rerun the command handler');
        } finally {
          client.destroy();
          f.held.release();
        }
      },
    );
  }
