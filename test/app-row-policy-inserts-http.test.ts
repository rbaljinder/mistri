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

const appId = 'scoped-insert-http';
const owner = 'private-insert-operations';
const archiveOwner = 'private-insert-archive';
const account: Identity = { id: 'desk-one', who: 'editor@example.test', role: 'editor' };
const insert = (extra: Record<string, unknown> = {}) => ({ table: 'ticket', values: {}, ...extra });
const ticketFields = ['id', 'desk', 'reviewer_id', 'name', 'status', 'note', 'quantity', 'payload'];

function privateFree(value: unknown, path = ''): void {
  // Constraint identities remain public relation addresses in the existing schema contract.
  if (/^foreignKeys\.\d+\.name$/.test(path) && /^physical_\w+_fk_\d+$/.test(String(value))) return;
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!['sql', 'params', 'stack', 'cause', 'connection', 'principal'].includes(key), key);
      privateFree(child, path ? `${path}.${key}` : key);
    }
  } else assert.doesNotMatch(JSON.stringify(value) ?? '', /HIDDEN|PRIVATE|physical_|private-insert-|tablewalk-row-policy-insert-/);
}

async function fixture(
  t: TestContext,
  options: {
    commands?: boolean;
    secondaryWrite?: boolean;
    hiddenDefaultParent?: boolean;
    incomingFK?: boolean;
    blob?: boolean;
    requiredCode?: boolean;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-row-policy-insert-'));
  const registry = new Registry();
  const databases: DatabaseSync[] = [];
  const policies: HttpAppPolicy[] = [];
  const servers: Server[] = [];
  const control = {
    identity: { ...account } as Identity | null,
    verified: undefined as Identity | null | undefined,
    transactions: [] as string[][],
    fallbackCalls: 0,
    rollback: false,
    unknownConstraint: '' as '' | 'rollback' | 'commit',
    beforeTransaction: undefined as (() => void) | undefined,
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
    assert.equal(control.fallbackCalls, 0, 'Scoped HTTP must never fall back to ordinary adapter operations');
  });
  for (const connection of [archiveOwner, owner]) {
    const file = join(directory, `${connection}.db`);
    const db = new DatabaseSync(file);
    databases.push(db);
    db.exec(`CREATE TABLE physical_reviewer(id INTEGER PRIMARY KEY, desk INTEGER NOT NULL DEFAULT 1, name TEXT);
      CREATE TABLE physical_ticket(id INTEGER PRIMARY KEY, desk INTEGER NOT NULL DEFAULT 1,
        reviewer_id INTEGER DEFAULT ${options.hiddenDefaultParent ? 2 : 1} REFERENCES physical_reviewer(id),
        name TEXT NOT NULL DEFAULT 'Default ticket' UNIQUE, status TEXT COLLATE NOCASE DEFAULT 'open', note TEXT,
        quantity INTEGER DEFAULT 7, payload ${options.blob ? "BLOB DEFAULT X'0102'" : 'TEXT DEFAULT NULL'});
      CREATE TABLE physical_limited(id INTEGER PRIMARY KEY, desk INTEGER NOT NULL DEFAULT 1,
        name TEXT DEFAULT 'Default limited', private_note TEXT DEFAULT 'PRIVATE stored default'${options.requiredCode ? ', code TEXT NOT NULL' : ''});
      CREATE TABLE physical_task(id INTEGER PRIMARY KEY, desk INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE physical_keyless(desk INTEGER DEFAULT 1, name TEXT);
      CREATE VIEW physical_ticket_view AS SELECT * FROM physical_ticket;
      INSERT INTO physical_reviewer VALUES (1,1,'Ada'),(2,2,'HIDDEN reviewer');
      INSERT INTO physical_task VALUES (1,1,0);`);
    if (options.incomingFK)
      db.exec(`CREATE TABLE physical_child(id INTEGER PRIMARY KEY, desk INTEGER DEFAULT 1,
      ticket_id INTEGER REFERENCES physical_ticket(id));`);
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
  const local = ['ticket', 'reviewer', 'limited', 'task', 'keyless', 'ticketView', ...(options.incomingFK ? ['child'] : [])];
  const generic = options.secondaryWrite ? ['archive.ticket'] : ['ticket', 'limited', 'reviewer', 'keyless', 'ticketView'];
  // Every resource is read; the generic writes and the command's task are the write ceilings.
  const ceiling = (name: string) => ([...generic, 'task'].includes(name) ? 'write' : undefined) as 'write' | undefined;
  const app = parseTestApp(
    {
      id: appId,
      name: 'Scoped inserts',
      sources: { operations: { connection: owner, default: true }, archive: { connection: archiveOwner } },
      resources: {
        ticket: { physical: 'physical_ticket', access: ceiling('ticket') },
        reviewer: { physical: 'physical_reviewer', access: ceiling('reviewer') },
        limited: {
          physical: 'physical_limited',
          access: ceiling('limited'),
          fields: { read: ['id', 'desk', 'name'], write: options.secondaryWrite ? [] : ['name'] },
        },
        task: {
          physical: 'physical_task',
          access: ceiling('task'),
          ...(options.commands
            ? {
                actions: { advance: { label: 'Advance', command: { id: 'advance', version: 1, target: 'task', input: {} } } },
              }
            : {}),
        },
        keyless: { physical: 'physical_keyless', access: ceiling('keyless') },
        ticketView: { physical: 'physical_ticket_view', access: ceiling('ticketView') },
        ...(options.incomingFK ? { child: { physical: 'physical_child', access: ceiling('child') } } : {}),
        'archive.ticket': { physical: 'physical_ticket', access: ceiling('archive.ticket') },
        'archive.reviewer': { physical: 'physical_reviewer', access: ceiling('archive.reviewer') },
      },
      auth: {
        rows: 'policy',
        roles: {
          editor: { read: true, write: generic },
          limited: {
            read: true,
            write: generic,
            fields: {
              ticket: {
                read: ticketFields.filter((field) => field !== 'note'),
                write: options.secondaryWrite ? [] : ['name'],
              },
            },
          },
          readonlyField: {
            read: true,
            write: generic,
            fields: {
              ticket: {
                read: ticketFields,
                write: options.secondaryWrite ? [] : ticketFields.filter((field) => field !== 'status'),
              },
            },
          },
          viewer: { read: true },
          ...(options.commands ? { commandOnly: { read: true, commands: ['advance'] } } : {}),
        },
      },
      views: {
        ticket: { kind: 'list', from: 'ticket' },
        'archive-ticket': { kind: 'list', from: 'archive.ticket' },
        ...(options.commands ? { task: { kind: 'list', from: 'task' } } : {}),
      },
      home: 'ticket',
      nav: ['ticket', 'archive-ticket', ...(options.commands ? ['task'] : [])],
    },
    'scoped insert HTTP fixture',
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
    adapter.scopeTransaction = async (rows, run) => {
      const events: string[] = [];
      control.transactions.push(events);
      control.beforeTransaction?.();
      const constraint = () =>
        Object.assign(new Error('PRIVATE UNIQUE constraint failed: physical_ticket.name'), { code: 'ERR_SQLITE_ERROR', errcode: 2067 });
      try {
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
          if (control.rollback) throw new Refusal('PRIVATE physical_ticket rollback');
          if (control.unknownConstraint === 'rollback') throw constraint();
          return value;
        });
        // The test can inspect durable state, but HTTP receives only an
        // uncertain transaction outcome, even with a recognizable cause.
        if (control.unknownConstraint === 'commit') throw new TransactionOutcomeUnknown(constraint());
        return result;
      } catch (error) {
        if (control.unknownConstraint === 'rollback') throw new TransactionOutcomeUnknown(error);
        throw error;
      }
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
      const eq = { groups: [[{ column: 'desk', op: '=', value: principal.id === 'desk-two' ? 2 : 1 }]] };
      return Object.fromEntries(${JSON.stringify([...local, 'archive.ticket', 'archive.reviewer'])}.map(table => [table, eq]));
    }
  };`,
  );
  const start = async () => {
    const policy = await loadHttpAppPolicy({
      app,
      registry,
      file,
      ...(commands ? { commands } : {}),
      verifySession: async () => (control.verified === undefined ? control.identity : control.verified),
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
    const request = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const url = new URL(path, `http://${bound.host}:${bound.port}`);
      if (!url.searchParams.has('app')) url.searchParams.set('app', appId);
      const response = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'content-type': 'application/json',
          ...(control.identity ? { 'x-mistri-account': control.identity.id } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(3000),
      });
      const payload = await response.json();
      assert.equal(response.headers.get('cache-control'), 'no-store');
      privateFree(payload);
      return { status: response.status, body: payload, headers: response.headers };
    };
    return { policy, request };
  };
  const running = await start();
  control.transactions.length = 0;
  const rows = () => db.prepare('SELECT * FROM physical_ticket ORDER BY id').all();
  const row = (id: number) => db.prepare('SELECT * FROM physical_ticket WHERE id = ?').get(id);
  return { db, archive, registry, control, rows, row, start, ...running };
}

type Reply = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['request']>>;
function inserted(reply: Reply) {
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.errors, undefined);
  assert.ok(Number.isSafeInteger(reply.body.key?.id));
  assert.equal(reply.body.row.id, reply.body.key.id);
  assert.equal(reply.headers.get('x-mistri-account'), account.id);
  // An App has no Undo: a creation carries no token to take it back.
  assert.deepEqual(Object.keys(reply.body).sort(), ['key', 'row', 'applied'].sort());
  return reply.body as { key: { id: number }; row: Record<string, unknown>; applied: Record<string, unknown> };
}
function denied(reply: Reply, input?: unknown) {
  assert.ok([400, 403, 409].includes(reply.status), `${JSON.stringify(input)}: ${JSON.stringify(reply.body)}`);
  assert.equal(reply.body.undoId, undefined);
  assert.equal(reply.body.row, undefined);
  assert.equal(reply.body.applied, undefined);
  assert.equal(reply.body.steps, undefined);
}
/** An App has no Undo (WR1): its revert route says so, and nothing reached the connection's journal. */
function noUndo(reply: Reply) {
  assert.equal(reply.status, 404, JSON.stringify(reply.body));
  assert.equal(reply.body.error, 'An App has no Undo.');
  assert.deepEqual(history(owner), []);
}

test('INSERT metadata requires a generic writable table with a primary key and excludes views', async (t) => {
  const f = await fixture(t);
  const schema = await f.request('/api/schema');
  assert.equal(schema.status, 200);
  const tables = new Map<string, { insertable?: boolean; deletable?: boolean }>(
    schema.body.tables.map((table: { id: string }) => [table.id, table]),
  );
  for (const name of ['ticket', 'limited', 'reviewer']) assert.equal(tables.get(name)?.insertable, true, name);
  for (const name of ['keyless', 'ticketView', 'task', 'archive.ticket']) assert.equal(tables.get(name)?.insertable, false, name);
  for (const table of tables.values()) assert.equal(table.deletable, false, 'Public Delete remains unavailable');
});

test('INSERT metadata leaves out a table whose writable columns cannot make a row', async (t) => {
  /* "limited" writes only its name, and a new row also needs a code no
     grant writes (and none reads): its rows can be edited, never made. */
  const f = await fixture(t, { requiredCode: true });
  const schema = await f.request('/api/schema');
  assert.equal(schema.status, 200);
  const tables = new Map<string, { insertable?: boolean }>(schema.body.tables.map((table: { id: string }) => [table.id, table]));
  assert.equal(tables.get('limited')?.insertable, false);
  assert.equal(tables.get('ticket')?.insertable, true);
});

test('explicit empty values stores defaults on one scoped transaction and journals nothing', async (t) => {
  const f = await fixture(t);
  const added = inserted(await f.request('/api/insert', insert()));
  assert.deepEqual(added.applied, {});
  assert.deepEqual(added.row, {
    id: added.key.id,
    desk: 1,
    reviewer_id: 1,
    name: 'Default ticket',
    status: 'open',
    note: null,
    quantity: 7,
    payload: null,
  });
  assert.deepEqual({ ...f.row(added.key.id) }, added.row);
  assert.equal(f.control.transactions.filter((events) => events.includes('insert')).length, 1);
  noUndo(await f.request('/api/revert', {}));
});

test('explicit null, empty text and numeric coercion preserve actual stored values', async (t) => {
  const f = await fixture(t);
  const added = inserted(
    await f.request('/api/insert', insert({ values: { name: '', status: null, note: '', quantity: '0042', reviewer_id: null } })),
  );
  assert.deepEqual(added.applied, { name: '', status: null, note: '', quantity: 42, reviewer_id: null });
  assert.equal(added.row.status, null);
  assert.equal(added.row.note, '');
  assert.equal(added.row.quantity, 42);
  assert.deepEqual({ ...f.row(added.key.id) }, added.row);
});

test('an explicit row scope escape rolls back the stored INSERT and creates no history', async (t) => {
  const f = await fixture(t);
  denied(await f.request('/api/insert', insert({ values: { desk: 2, name: 'Rejected' } })));
  assert.deepEqual(f.rows(), []);
  noUndo(await f.request('/api/revert', {}));
});

test('database defaults cannot insert outside the verified account scope', async (t) => {
  const f = await fixture(t);
  f.control.identity = { ...account, id: 'desk-two' };
  denied(await f.request('/api/insert', insert()));
  assert.deepEqual(f.rows(), []);
  noUndo(await f.request('/api/revert', {}));
});

test('hidden and missing explicit FK parents both refuse without disclosing parent state', async (t) => {
  const f = await fixture(t);
  for (const reviewer_id of [2, 999]) {
    denied(await f.request('/api/insert', insert({ values: { reviewer_id } })), { reviewer_id });
    assert.deepEqual(f.rows(), []);
    noUndo(await f.request('/api/revert', {}));
  }
});

test('an omitted FK whose stored default is hidden refuses and rolls back', async (t) => {
  const f = await fixture(t, { hiddenDefaultParent: true });
  denied(await f.request('/api/insert', insert({ values: { name: 'Rejected default parent' } })));
  assert.deepEqual(f.rows(), []);
  noUndo(await f.request('/api/revert', {}));
});

test('explicit null FK overrides a hidden default parent', async (t) => {
  const f = await fixture(t, { hiddenDefaultParent: true });
  const added = inserted(await f.request('/api/insert', insert({ values: { reviewer_id: null } })));
  assert.equal(f.row(added.key.id)!.reviewer_id, null);
});

test('INSERT requires an explicit plain values object, including for DEFAULT VALUES', async (t) => {
  const f = await fixture(t);
  for (const body of [{ table: 'ticket' }, null, [], 'ticket', ...[null, [], '', 1, true].map((values) => insert({ values }))]) {
    denied(await f.request('/api/insert', body), body);
  }
  assert.deepEqual(f.rows(), []);
  noUndo(await f.request('/api/revert', {}));
});

test('unknown body fields, source selectors, actor claims and separate keys cannot widen INSERT', async (t) => {
  const f = await fixture(t);
  for (const extra of [
    { surprise: true },
    { key: { id: 50 } },
    { expected: {} },
    { column: 'name', value: 'Forged' },
    { source: archiveOwner },
    { conn: owner },
    { actor: account.id },
    { principal: account.id },
    { identity: account },
    { role: 'editor' },
    { rows: { ticket: true } },
    { rowPolicy: false },
    { access: { write: true } },
    { writable: true },
  ]) {
    denied(await f.request('/api/insert', insert(extra)));
  }
  assert.deepEqual(f.rows(), []);
  noUndo(await f.request('/api/revert', {}));
});

test('physical, injected, missing, readonly and ungranted table targets refuse INSERT', async (t) => {
  const f = await fixture(t);
  for (const table of [
    'physical_ticket',
    'ticket; DELETE FROM physical_ticket',
    'missing',
    'archive.ticket',
    'task',
    'keyless',
    'ticketView',
    null,
    {},
    ['ticket'],
  ]) {
    denied(await f.request('/api/insert', insert({ table })));
  }
  assert.deepEqual(f.rows(), []);
  assert.deepEqual(f.archive.prepare('SELECT * FROM physical_ticket').all(), []);
});

test('unknown, nested and field-protected values never produce a partial INSERT', async (t) => {
  const f = await fixture(t);
  for (const values of [{ name: 'Rejected', unknown: 1 }, { name: { text: 'Rejected' } }, { name: ['Rejected'] }]) {
    denied(await f.request('/api/insert', insert({ values })), values);
  }
  for (const values of [{ name: 'Rejected', private_note: 'Forged' }, { name: 'Rejected', desk: 2 }, { id: 91 }]) {
    denied(await f.request('/api/insert', insert({ table: 'limited', values })));
  }
  assert.deepEqual(f.rows(), []);
  assert.deepEqual(f.db.prepare('SELECT * FROM physical_limited').all(), []);
  noUndo(await f.request('/api/revert', {}));
});

test('field-limited INSERT returns a projection of stored defaults', async (t) => {
  const f = await fixture(t);
  const added = inserted(await f.request('/api/insert', insert({ table: 'limited', values: { name: 'Visible limited' } })));
  assert.deepEqual(added.row, { id: added.key.id, desk: 1, name: 'Visible limited' });
  assert.deepEqual(added.applied, { name: 'Visible limited' });
  assert.equal(
    f.db.prepare('SELECT private_note FROM physical_limited WHERE id = ?').get(added.key.id)!.private_note,
    'PRIVATE stored default',
  );
});

test('a fully readable row with a readonly default field can be inserted', async (t) => {
  const f = await fixture(t);
  f.control.identity = { ...account, role: 'readonlyField' };
  const added = inserted(await f.request('/api/insert', insert({ values: { name: 'Readonly status' } })));
  assert.equal(added.row.status, 'open');
  assert.deepEqual(Object.keys(added.row).sort(), [...ticketFields].sort());
});

test('constraint refusals sanitize physical SQL errors and keep the preceding INSERT', async (t) => {
  const f = await fixture(t);
  const added = inserted(await f.request('/api/insert', insert()));
  for (const values of [{ name: null }, { name: 'Default ticket' }, { quantity: 'not a number' }]) {
    denied(await f.request('/api/insert', insert({ values })), values);
  }
  assert.deepEqual(
    f.rows().map((row) => row.id),
    [added.key.id],
  );
});

test('same-named secondary-source INSERT works with a readonly default and never touches its database', async (t) => {
  const f = await fixture(t, { secondaryWrite: true });
  assert.deepEqual((await f.request('/api/app')).body.app.writableTables, ['archive.ticket']);
  const added = inserted(await f.request('/api/insert', insert({ table: 'archive.ticket' })));
  assert.equal(f.archive.prepare('SELECT name FROM physical_ticket WHERE id = ?').get(added.key.id)!.name, 'Default ticket');
  assert.deepEqual(f.rows(), []);
  denied(await f.request('/api/insert', insert()));
  assert.deepEqual(f.rows(), []);
});

test('request selectors, stale sessions and forged identity headers cannot authorize INSERT', async (t) => {
  const f = await fixture(t);
  for (const selector of ['app=other-app', `conn=${owner}`]) denied(await f.request(`/api/insert?${selector}`, insert()));
  denied(await f.request('/api/insert', insert({ app: 'other-app' })));
  assert.equal((await f.request('/api/insert', insert(), { 'x-mistri-account': 'stale' })).status, 409);
  f.control.identity = null;
  assert.equal((await f.request('/api/insert', insert({ identity: account }), { 'x-role': 'editor' })).status, 401);
  f.control.identity = { ...account, role: 'viewer' };
  denied(await f.request('/api/insert?role=editor', insert(), { 'x-role': 'editor', 'x-mistri-role': 'editor' }));
  f.control.identity = { ...account };
  for (const verified of [null, { ...account, id: 'desk-two' }, { ...account, role: 'viewer' }]) {
    f.control.verified = verified;
    assert.equal((await f.request('/api/insert', insert())).status, 403);
  }
  assert.deepEqual(f.rows(), []);
  assert.equal(f.control.transactions.length, 0);
});

test('DELETE and unreviewed mutation/history routes remain refused after a complete INSERT', async (t) => {
  const f = await fixture(t);
  const added = inserted(await f.request('/api/insert', insert()));
  for (const path of ['/api/delete', '/api/undo', '/api/undo/prepare', '/api/sql', '/api/history']) {
    assert.equal((await f.request(path, { table: 'ticket', key: added.key, confirm: true, expectedId: 1 })).status, 403, path);
  }
  assert.equal((await f.request('/api/insert')).status, 403);
  assert.ok(f.row(added.key.id));
  noUndo(await f.request('/api/revert', { confirm: true, expectedId: 1 }));
  assert.ok(f.row(added.key.id));
});

test('commands-only grants enable neither generic INSERT nor DELETE', async (t) => {
  const f = await fixture(t, { commands: true });
  f.control.identity = { ...account, role: 'commandOnly' };
  const manifest = await f.request('/api/app');
  assert.deepEqual(manifest.body.app.grantedCommands, ['advance']);
  assert.deepEqual(manifest.body.app.writableTables, []);
  for (const path of ['/api/insert', '/api/delete']) assert.equal((await f.request(path, insert())).status, 403);
  assert.deepEqual(f.rows(), []);
  assert.equal(f.control.transactions.length, 0);
});

test('a scoped INSERT rolled back after the callback exposes no private failure', async (t) => {
  const f = await fixture(t);
  f.control.rollback = true;
  denied(await f.request('/api/insert', insert()));
  f.control.rollback = false;
  assert.deepEqual(f.rows(), []);
  noUndo(await f.request('/api/revert', {}));
});

for (const outcome of ['rollback', 'commit'] as const) {
  test(`INSERT with an unknown ${outcome} wrapping a recognized constraint stays unknown`, async (t) => {
    const f = await fixture(t);
    const older = inserted(await f.request('/api/insert', insert({ values: { name: 'Older' } })));
    f.control.unknownConstraint = outcome;
    const reply = await f.request('/api/insert', insert({ values: { name: 'Unconfirmed creation' } }));
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.outcome, 'unknown');
    assert.ok(reply.body.errors?.length);
    for (const field of ['key', 'row', 'applied', 'undoId', 'affected']) assert.equal(reply.body[field], undefined, field);
    assert.deepEqual(
      f.rows().map((row) => row.name),
      outcome === 'commit' ? ['Older', 'Unconfirmed creation'] : ['Older'],
    );
    f.control.unknownConstraint = '';
    assert.ok(f.row(older.key.id));
    assert.deepEqual(history(owner), []);
  });
}
