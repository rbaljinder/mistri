import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Refusal, TransactionOutcomeUnknown } from '../packages/engine/src/adapters/adapter.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { loadHttpAppPolicy, type HttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal, history } from '../packages/engine/src/server/journal.js';
import { parseTestApp } from './support/commandCatalog.js';

const appId = 'scoped-update-http';
const owner = 'private-update-operations';
const archiveOwner = 'private-update-archive';
const account: Identity = { id: 'desk-one', who: 'editor@example.test', role: 'editor' };
const update = (extra: Record<string, unknown> = {}) => ({ table: 'ticket', key: { id: 1 }, values: { name: 'Saved ticket' }, ...extra });
function privateFree(value: unknown, path = ''): void {
  // Existing FK constraint identities are public relation addresses.
  if (/^foreignKeys\.\d+\.name$/.test(path) && value === 'physical_ticket_fk_0') return;
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!['sql', 'params', 'stack', 'cause', 'connection', 'principal'].includes(key), key);
      privateFree(child, path ? `${path}.${key}` : key);
    }
  } else assert.doesNotMatch(JSON.stringify(value) ?? '', /HIDDEN|PRIVATE|physical_|private-update-|tablewalk-row-policy-update-/);
}

async function fixture(t: TestContext, options: { commands?: boolean; secondaryWrite?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-row-policy-update-'));
  const registry = new Registry();
  const databases: DatabaseSync[] = [];
  const policies: HttpAppPolicy[] = [];
  const servers: Server[] = [];
  const control = {
    identity: { ...account } as Identity | null,
    verified: undefined as Identity | null | undefined,
    verifications: 0,
    fallbackCalls: 0,
    commits: 0,
    transactions: [] as string[][],
    fault: '' as '' | 'rollback' | 'unknown-before' | 'unknown-after',
    beforeTransaction: undefined as (() => void) | undefined,
    afterCommit: undefined as (() => Promise<void>) | undefined,
  };
  t.after(async () => {
    try {
      for (const server of servers) {
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeAllConnections();
        await closed;
      }
      for (const policy of policies) await policy.retire();
      await registry.closeAll();
    } finally {
      clearJournal(owner);
      clearJournal(archiveOwner);
      for (const db of databases) db.close();
      rmSync(directory, { recursive: true, force: true });
    }
    assert.equal(control.fallbackCalls, 0, 'No ordinary read, write, or transaction fallback');
  });
  // Active registry source differs from the App default and cannot write.
  for (const connection of [archiveOwner, owner]) {
    const file = join(directory, `${connection}.db`);
    const db = new DatabaseSync(file);
    databases.push(db);
    db.exec(`CREATE TABLE physical_reviewer(id INTEGER PRIMARY KEY, desk INTEGER NOT NULL, name TEXT);
      CREATE TABLE physical_ticket(id INTEGER PRIMARY KEY, desk INTEGER NOT NULL,
        reviewer_id INTEGER REFERENCES physical_reviewer(id), name TEXT, status TEXT, private_note TEXT);
      CREATE TABLE physical_task(id INTEGER PRIMARY KEY, desk INTEGER NOT NULL, version INTEGER NOT NULL);
      INSERT INTO physical_reviewer VALUES (1,1,'Ada'),(2,2,'HIDDEN reviewer'),(3,1,'Grace');
      INSERT INTO physical_ticket VALUES (1,1,1,'Original ticket','open','PRIVATE note'),
        (2,2,2,'HIDDEN ticket','open','PRIVATE note'),(3,1,2,'Visible with hidden parent','open','PRIVATE note'),
        (4,1,1,'Another visible ticket','open','PRIVATE note');
      INSERT INTO physical_task VALUES (1,1,0);`);
    if (options.commands && connection === owner) migrateSqliteCommandJournal(file);
    registry.add({
      id: connection,
      name: connection,
      url: file,
      source: 'config',
      writable: connection === (options.secondaryWrite ? archiveOwner : owner),
    });
  }
  const [archive, db] = databases;
  const app = parseTestApp(
    {
      id: appId,
      name: 'Scoped updates',
      sources: {
        operations: { connection: owner, default: true },
        archive: { connection: archiveOwner },
      },
      resources: {
        ticket: {
          physical: 'physical_ticket',
          access: 'write',
          fields: { read: ['id', 'desk', 'reviewer_id', 'name', 'status'], write: ['desk', 'reviewer_id', 'name'] },
        },
        reviewer: { physical: 'physical_reviewer' },
        task: {
          physical: 'physical_task',
          access: 'write',
          ...(options.commands
            ? {
                actions: { advance: { label: 'Advance', command: { id: 'advance', version: 1, target: 'task', input: {} } } },
              }
            : {}),
        },
        'archive.ticket': {
          physical: 'physical_ticket',
          access: 'write',
          fields: { read: ['id', 'desk', 'reviewer_id', 'name', 'status'], write: ['name'] },
        },
        'archive.reviewer': { physical: 'physical_reviewer' },
      },
      auth: {
        rows: 'policy',
        roles: {
          editor: { read: true, write: [options.secondaryWrite ? 'archive.ticket' : 'ticket'] },
          restricted: {
            read: true,
            write: options.secondaryWrite ? [] : ['ticket'],
            fields: {
              ticket: { read: ['id', 'desk', 'reviewer_id', 'status'], write: options.secondaryWrite ? [] : ['reviewer_id'] },
            },
          },
          nameOnly: {
            read: true,
            write: options.secondaryWrite ? [] : ['ticket'],
            fields: {
              ticket: { read: ['id', 'desk', 'reviewer_id', 'name', 'status'], write: options.secondaryWrite ? [] : ['name'] },
            },
          },
          viewer: { read: true },
          ...(options.commands ? { commandOnly: { read: true, commands: ['advance'] } } : {}),
        },
      },
      views: {
        tickets: { kind: 'list', from: 'ticket' },
        'archive-tickets': { kind: 'list', from: 'archive.ticket' },
        ...(options.commands ? { tasks: { kind: 'list', from: 'task' } } : {}),
      },
      home: 'tickets',
      nav: ['tickets', 'archive-tickets', ...(options.commands ? ['tasks'] : [])],
    },
    'scoped update HTTP fixture',
  );
  const commands = options.commands
    ? defineCommands({
        advance: defineCommand({
          source: 'operations',
          target: 'task',
          read: ['task'],
          write: ['task'],
          input: {},
          output: { parse: () => ({}) },
          async handle({ db, record }) {
            await db.task.update(record, { version: Number(record.version) + 1 });
            return {};
          },
        }),
      })
    : undefined;
  for (const connection of [owner, archiveOwner]) {
    const { adapter } = await registry.open(connection);
    assert.ok(adapter.scopeTransaction);
    const scoped = adapter.scopeTransaction.bind(adapter);
    // Install all hooks before loading: deployed adapter capabilities are captured.
    adapter.scopeTransaction = async (rows, run) => {
      const events: string[] = [];
      control.transactions.push(events);
      control.beforeTransaction?.();
      if (control.fault === 'unknown-before') throw new TransactionOutcomeUnknown('PRIVATE writer failure');
      const result = await scoped(rows, async (tx, catalog) => {
        const value = await run(
          {
            query: (request) => {
              events.push('query');
              return tx.query(request);
            },
            count: (table, filter) => {
              events.push('count');
              return tx.count(table, filter);
            },
            update: (request) => {
              events.push('update');
              return tx.update(request);
            },
            insert: (request) => {
              events.push('insert');
              return tx.insert(request);
            },
            remove: (request) => {
              events.push('remove');
              return tx.remove(request);
            },
          },
          catalog,
        );
        if (control.fault === 'rollback') throw new Refusal('PRIVATE physical_ticket rollback');
        return value;
      });
      control.commits++;
      await control.afterCommit?.();
      if (control.fault === 'unknown-after') throw new TransactionOutcomeUnknown('PRIVATE lost commit acknowledgment');
      return result;
    };
    const fallback = async (): Promise<never> => {
      control.fallbackCalls++;
      throw new Error('PRIVATE ordinary fallback');
    };
    adapter.query = fallback;
    adapter.count = fallback;
    adapter.transaction = fallback;
    adapter.update = fallback;
    adapter.insert = fallback;
    adapter.remove = fallback;
    adapter.commandTransaction = fallback;
  }
  const host: AppHost = {
    app: { app, path: join(directory, 'app.ts'), pages: [], sources: {} },
    pages: [],
    auth: {
      spec: app.auth!,
      store: join(directory, 'auth.db'),
      close() {},
      handler: async () => {},
      session: async () => control.identity,
    },
  };
  const file = join(directory, 'policy.mjs');
  writeFileSync(
    file,
    `export default { appId: ${JSON.stringify(appId)},
    ${options.commands ? 'resultReferences: { advance: () => [] },' : ''}
    resolveRows(principal) {
      const desk = principal.id === 'desk-two' ? 2 : 1;
      const eq = { groups: [[{ column: 'desk', op: '=', value: desk }]] };
      return { ticket: eq, reviewer: eq, task: eq, 'archive.ticket': eq, 'archive.reviewer': eq };
    }
  };`,
  );
  const start = async () => {
    const policy = await loadHttpAppPolicy({
      app,
      registry,
      file,
      ...(commands ? { commands } : {}),
      verifySession: async () => {
        control.verifications++;
        return control.verified === undefined ? control.identity : control.verified;
      },
    });
    policies.push(policy);
    const bound = { host: '127.0.0.1', port: 0 };
    const server = createApp({ registry, bound, apps: [host], policy });
    servers.push(server);
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    bound.port = address.port;
    const request = async (
      path: string,
      body?: unknown,
      options: { headers?: Record<string, string>; method?: string; raw?: string } = {},
    ) => {
      const url = new URL(path, `http://${bound.host}:${bound.port}`);
      if (!url.searchParams.has('app')) url.searchParams.set('app', appId);
      const response = await fetch(url, {
        method: options.method ?? (body === undefined && options.raw === undefined ? 'GET' : 'POST'),
        headers: {
          'content-type': 'application/json',
          ...(control.identity ? { 'x-mistri-account': control.identity.id } : {}),
          ...options.headers,
        },
        ...(body === undefined && options.raw === undefined ? {} : { body: options.raw ?? JSON.stringify(body) }),
        signal: AbortSignal.timeout(3000),
      });
      const payload = await response.json();
      assert.equal(response.headers.get('cache-control'), 'no-store');
      privateFree(payload);
      return { status: response.status, body: payload, headers: response.headers };
    };
    return { policy, request };
  };
  const row = (id = 1) => db.prepare('SELECT * FROM physical_ticket WHERE id = ?').get(id)!;
  const running = await start();
  // Enrollment attests every writer with a read-only callback; counters below
  // describe HTTP invocations, independently of those startup transactions.
  control.transactions.length = 0;
  control.commits = 0;
  return { app, db, archive, registry, control, row, start, ...running };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Reply = Awaited<ReturnType<Fixture['request']>>;

test('a scoped secondary-source update never touches the read-only App default', async (t) => {
  const f = await fixture(t, { secondaryWrite: true });
  const metadata = await f.request('/api/app');
  assert.deepEqual(metadata.body.app.writableTables, ['archive.ticket']);
  saved(await f.request('/api/update', update({ table: 'archive.ticket' })));
  assert.equal(f.archive.prepare('SELECT name FROM physical_ticket WHERE id=1').get()!.name, 'Saved ticket');
  assert.equal(f.row().name, 'Original ticket');
  denied(await f.request('/api/update', update()));
});

function saved(reply: Reply) {
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.errors, undefined);
  assert.equal(reply.body.affected, 1);
  // An App has no Undo: nothing to take back is offered.
  assert.equal(reply.body.undoId, undefined);
  assert.equal(reply.headers.get('x-mistri-account'), account.id);
}

function denied(reply: Reply) {
  assert.ok([400, 403, 409].includes(reply.status), JSON.stringify(reply.body));
  assert.equal(reply.body.undoId, undefined);
  assert.equal(reply.body.affected, undefined);
  assert.equal(reply.body.steps, undefined);
}

/** An App has no Undo (WR1): its revert route says so, and nothing reached the connection's journal. */
function noUndo(reply: Reply) {
  assert.equal(reply.status, 404, JSON.stringify(reply.body));
  assert.equal(reply.body.error, 'An App has no Undo.');
  assert.deepEqual(history(owner), []);
}

test(
  'enrolled generic UPDATE publishes field grants and uses the named scoped writer, and journals nothing',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t);
    const manifest = await f.request('/api/app');
    assert.equal(manifest.status, 200);
    assert.deepEqual(manifest.body.app.writableTables, ['ticket']);
    assert.equal(manifest.body.app.writableFields, undefined);
    assert.deepEqual(manifest.body.app.grantedCommands, []);
    const schema = await f.request('/api/schema');
    assert.equal(schema.status, 200);
    for (const table of schema.body.tables) {
      assert.equal(table.insertable, table.id === 'ticket', 'Only a generic writable table may offer New');
      assert.equal(table.deletable, false);
      assert.deepEqual(
        table.columns
          .filter((column: { writable: boolean }) => column.writable)
          .map((column: { name: string }) => column.name)
          .sort(),
        table.id === 'ticket' ? ['desk', 'name', 'reviewer_id'] : [],
      );
    }
    const archiveBefore = f.archive.prepare('SELECT * FROM physical_ticket ORDER BY id').all();
    saved(await f.request('/api/update', update({ expected: { name: 'Original ticket' } })));
    assert.equal(f.row().name, 'Saved ticket');
    assert.equal(f.row().private_note, 'PRIVATE note');
    assert.equal(f.control.transactions.length, 1);
    assert.ok(f.control.transactions[0].indexOf('query') >= 0);
    assert.ok(f.control.transactions[0].indexOf('query') < f.control.transactions[0].indexOf('update'));
    assert.equal(f.control.commits, 1);
    assert.deepEqual(f.archive.prepare('SELECT * FROM physical_ticket ORDER BY id').all(), archiveBefore);
    noUndo(await f.request('/api/revert', {}));
  },
);

test('hidden and absent UPDATE targets are indistinguishable and never journaled', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const before = f.row(2);
  const replies = [];
  for (const id of [2, 999]) {
    const reply = await f.request('/api/update', update({ key: { id } }));
    denied(reply);
    replies.push({ status: reply.status, body: reply.body });
  }
  assert.deepEqual(replies[0], replies[1]);
  assert.deepEqual(f.row(2), before);
  noUndo(await f.request('/api/revert', {}));
});

for (const [name, body] of [
  ['scope escape', update({ values: { name: 'Rejected change', desk: 2 } })],
  ['hidden FK parent', update({ values: { name: 'Rejected change', reviewer_id: 2 } })],
  ['read-only field', update({ values: { name: 'Rejected change', status: 'closed' } })],
  ['hidden field', update({ values: { private_note: 'Rejected change' } })],
  ['hidden comparison field', update({ expected: { private_note: 'probe' } })],
  ['incomplete expected fields', update({ expected: { status: 'open' } })],
  ['primary-key change', update({ values: { id: 8 } })],
  ['read-only named source', update({ table: 'archive.ticket' })],
  ['resource without generic grant', update({ table: 'task', values: { version: 1 } })],
] as const) {
  test(`UPDATE refuses ${name} without partial writes`, { timeout: 10_000 }, async (t) => {
    const f = await fixture(t);
    const before = f.db.prepare('SELECT * FROM physical_ticket ORDER BY id').all();
    denied(await f.request('/api/update', body));
    assert.deepEqual(f.db.prepare('SELECT * FROM physical_ticket ORDER BY id').all(), before);
    noUndo(await f.request('/api/revert', {}));
  });
}

test('expected-value conflicts are explicit and sanitized', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const reply = await f.request('/api/update', update({ expected: { name: 'Stale value' } }));
  assert.equal(reply.status, 409, JSON.stringify(reply.body));
  assert.equal(reply.body.outcome, 'rejected');
  denied(reply);
  assert.equal(f.row().name, 'Original ticket');
  noUndo(await f.request('/api/revert', {}));
});

test('forged authority, source selectors and malformed keys cannot widen UPDATE', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const forged = {
    role: 'editor',
    roles: ['editor'],
    identity: account,
    principal: account.id,
    rows: { ticket: true },
    rowPolicy: false,
    access: { read: true, write: true },
    writable: true,
  };
  for (const key of [
    null,
    {},
    [],
    { id: 1, desk: 1 },
    { name: 'Original ticket' },
    { id: null },
    { id: true },
    { id: [1] },
    { id: { value: 1 } },
    { id: '1 OR 1=1' },
  ]) {
    const reply = await f.request('/api/update', update({ key }));
    assert.ok([400, 403, 409].includes(reply.status), `${JSON.stringify(key)}: ${JSON.stringify(reply.body)}`);
    denied(reply);
  }
  for (const extra of [
    { table: 'physical_ticket' },
    { conn: archiveOwner },
    { app: 'other-app' },
    { source: archiveOwner, table: 'archive.ticket' },
    { key: { id: 2 }, ...forged },
  ]) {
    denied(await f.request('/api/update', update(extra)));
  }
  f.control.identity = { ...account, role: 'viewer' };
  denied(await f.request('/api/update?role=editor', update(forged), { headers: { 'x-role': 'editor', 'x-mistri-role': 'editor' } }));
  assert.equal(f.row().name, 'Original ticket');
  assert.equal(f.row(2).name, 'HIDDEN ticket');
});

test('wrong App/connection, stale account, anonymous and verifier mismatches refuse updates', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  for (const path of ['/api/update', '/api/revert']) {
    const body = path === '/api/update' ? update() : { confirm: true, expectedId: 1 };
    for (const selector of ['app=other-app', `conn=${owner}`]) denied(await f.request(`${path}?${selector}`, body));
    assert.equal((await f.request(path, body, { headers: { 'x-mistri-account': 'stale' } })).status, 409);
    f.control.identity = null;
    assert.equal((await f.request(path, { ...body, identity: account }, { headers: { 'x-role': 'editor' } })).status, 401);
    f.control.identity = { ...account };
  }
  assert.equal(f.control.verifications, 0);
  for (const verified of [null, { ...account, id: 'desk-two' }, { ...account, role: 'viewer' }]) {
    f.control.verified = verified;
    for (const [path, body] of [
      ['/api/update', update()],
      ['/api/revert', {}],
    ] as const) {
      assert.equal((await f.request(path, body)).status, 403);
    }
  }
  assert.equal(f.control.transactions.length, 0);
  assert.equal(f.row().name, 'Original ticket');
});

test('generic editors may INSERT permitted fields while DELETE and unreviewed routes remain 403', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const before = f.db.prepare('SELECT * FROM physical_ticket ORDER BY id').all();
  for (const path of ['/api/delete', '/api/undo', '/api/undo/prepare', '/api/sql', '/api/history']) {
    assert.equal((await f.request(path, update({ confirm: true, text: 'DELETE FROM physical_ticket' }))).status, 403, path);
  }
  for (const path of ['/api/update', '/api/insert', '/api/revert']) assert.equal((await f.request(path)).status, 403, path);
  assert.deepEqual(f.db.prepare('SELECT * FROM physical_ticket ORDER BY id').all(), before);
  noUndo(await f.request('/api/revert', {}));
  const inserted = await f.request('/api/insert', { table: 'ticket', values: { desk: 1, reviewer_id: 1, name: 'New ticket' } });
  assert.equal(inserted.status, 200, JSON.stringify(inserted.body));
  assert.deepEqual(inserted.body.row, { id: 5, desk: 1, reviewer_id: 1, name: 'New ticket', status: null });
  assert.equal(inserted.body.undoId, undefined, 'Projected creation cannot promise a whole-row delete inverse');
  assert.equal(f.row(5).name, 'New ticket');
  assert.equal(f.control.transactions.filter((events) => events.includes('insert')).length, 1);
});

test('command-only grants publish no generic writable resources and never enable CRUD', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, { commands: true });
  f.control.identity = { ...account, role: 'commandOnly' };
  const manifest = await f.request('/api/app');
  assert.equal(manifest.status, 200);
  assert.deepEqual(manifest.body.app.grantedCommands, ['advance']);
  assert.deepEqual(manifest.body.app.writableTables, []);
  for (const path of ['/api/update', '/api/insert', '/api/delete']) {
    assert.equal((await f.request(path, update({ confirm: true }))).status, 403, path);
  }
  noUndo(await f.request('/api/revert', { confirm: true, expectedId: 1 }));
  assert.equal(f.row().name, 'Original ticket');
  assert.equal(f.control.transactions.filter((events) => events.includes('update')).length, 0);
});

test('confirmed rollback sanitizes private row-policy errors', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  f.control.fault = 'rollback';
  denied(await f.request('/api/update', update()));
  f.control.fault = '';
  assert.equal(f.control.commits, 0);
  assert.equal(f.row().name, 'Original ticket');
  noUndo(await f.request('/api/revert', {}));
});

for (const fault of ['unknown-before', 'unknown-after'] as const) {
  test(`UPDATE ${fault} remains HTTP 200 outcome unknown`, { timeout: 10_000 }, async (t) => {
    const f = await fixture(t);
    f.control.fault = fault;
    const reply = await f.request('/api/update', update());
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.outcome, 'unknown');
    assert.ok(reply.body.errors?.length);
    assert.equal(reply.body.undoId, undefined);
    assert.equal(reply.body.affected, undefined);
    assert.equal(f.row().name, fault === 'unknown-after' ? 'Saved ticket' : 'Original ticket');
    f.control.fault = '';
    assert.deepEqual(history(owner), []);
  });
}
