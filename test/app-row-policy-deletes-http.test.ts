import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Refusal, TransactionOutcomeUnknown } from '../packages/engine/src/adapters/adapter.js';
import { loadHttpAppPolicy, type HttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal, history } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

const appId = 'scoped-delete-http';
const owner = 'private-delete-operations';
const archiveOwner = 'private-delete-archive';
const account: Identity = { id: 'desk-one', who: 'editor@example.test', role: 'editor' };
const ticketFields = ['id', 'desk', 'reviewer_id', 'name', 'status', 'note', 'quantity', 'numeric_text', 'enabled', 'payload'];
const deletion = (extra: Record<string, unknown> = {}) => ({ table: 'ticket', key: { id: 1 }, ...extra });
const confirmed = (extra: Record<string, unknown> = {}) => deletion({ confirm: true, ...extra });

type HookCall = {
  principal: { id: string; appId: string; roles: string[] };
  record: { table: string; key: Record<string, string | number>; row: Record<string, unknown> };
};
type PolicyControl = {
  desk: number;
  parentDesk: number;
  allow: unknown;
  deniedKeys: number[];
  calls: HookCall[];
  handler?: (principal: HookCall['principal'], record: HookCall['record']) => unknown;
};

function privateFree(value: unknown, path = ''): void {
  // Existing relation IDs remain public, even when they contain physical names.
  if (/^foreignKeys\.\d+\.name$/.test(path) && /^physical_\w+_fk_\d+$/.test(String(value))) return;
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!['sql', 'params', 'stack', 'cause', 'connection', 'principal', 'authorizeDeletedRecord'].includes(key), key);
      privateFree(child, path ? `${path}.${key}` : key);
    }
  } else assert.doesNotMatch(JSON.stringify(value) ?? '', /HIDDEN|PRIVATE|physical_|private-delete-|tablewalk-row-policy-delete-/);
}

async function fixture(
  t: TestContext,
  options: {
    hook?: boolean;
    secondaryWrite?: boolean;
    incoming?: 'empty' | 'hidden' | 'unmapped';
    blob?: boolean;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-row-policy-delete-'));
  const registry = new Registry();
  const databases: DatabaseSync[] = [];
  const policies: HttpAppPolicy[] = [];
  const servers: Server[] = [];
  const control = {
    identity: { ...account } as Identity | null,
    verified: undefined as Identity | null | undefined,
    fallbackCalls: 0,
    transactions: [] as string[][],
    fault: '' as '' | 'rollback' | 'unknown-rollback' | 'unknown-commit',
    beforeTransaction: undefined as (() => void) | undefined,
    afterInsert: undefined as (() => void) | undefined,
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
    assert.equal(control.fallbackCalls, 0, 'Scoped DELETE and restore must never use ordinary adapter operations');
  });
  // The active registry connection is deliberately different from the App default.
  for (const connection of [archiveOwner, owner]) {
    const file = join(directory, `${connection}.db`);
    const db = new DatabaseSync(file);
    databases.push(db);
    db.exec(`CREATE TABLE physical_reviewer(id INTEGER PRIMARY KEY, desk INTEGER NOT NULL, name TEXT);
      CREATE TABLE physical_ticket(id INTEGER PRIMARY KEY, desk INTEGER NOT NULL DEFAULT 1,
        reviewer_id INTEGER DEFAULT 1 REFERENCES physical_reviewer(id),
        name TEXT NOT NULL UNIQUE, status TEXT COLLATE NOCASE DEFAULT 'open', note TEXT,
        quantity INTEGER DEFAULT 7, numeric_text TEXT DEFAULT '0042', enabled BOOLEAN DEFAULT 1,
        payload ${options.blob ? 'BLOB' : 'TEXT'});
      CREATE TABLE physical_limited(id INTEGER PRIMARY KEY, desk INTEGER, name TEXT, private_note TEXT);
      CREATE TABLE physical_pair(desk INTEGER NOT NULL, code TEXT NOT NULL, name TEXT, PRIMARY KEY(desk, code));
      CREATE TABLE physical_keyless(desk INTEGER, name TEXT);
      CREATE TABLE physical_ungranted(id INTEGER PRIMARY KEY, desk INTEGER, name TEXT);
      CREATE VIEW physical_ticket_view AS SELECT * FROM physical_ticket;
      INSERT INTO physical_reviewer VALUES (1,1,'Ada'),(2,2,'HIDDEN reviewer');
      INSERT INTO physical_ticket VALUES
        (1,1,1,'Original ticket','OPEN',NULL,42,'0042',1,${options.blob ? "X'0102'" : "'payload text'"}),
        (2,2,2,'HIDDEN ticket','open','HIDDEN note',7,'0007',0,NULL),
        (3,1,1,'Another ticket','open','',0,'0000',0,NULL);
      INSERT INTO physical_limited VALUES (1,1,'Limited','PRIVATE field');
      INSERT INTO physical_pair VALUES (1,'0042','Composite ticket'),(1,'0043','Other composite');
      INSERT INTO physical_keyless VALUES (1,'No key');
      INSERT INTO physical_ungranted VALUES (1,1,'No generic grant');`);
    if (options.incoming) {
      db.exec(`CREATE TABLE physical_child(id INTEGER PRIMARY KEY, desk INTEGER,
        ticket_id INTEGER REFERENCES physical_ticket(id) ON DELETE CASCADE);`);
      if (options.incoming !== 'empty') db.exec('INSERT INTO physical_child VALUES (1,2,1)');
    }
    registry.add({
      id: connection,
      name: connection,
      url: file,
      source: 'config',
      writable: connection === (options.secondaryWrite ? archiveOwner : owner),
    });
  }
  const [archive, db] = databases;
  const mappedChild = options.incoming && options.incoming !== 'unmapped';
  const local = ['ticket', 'reviewer', 'limited', 'pair', 'keyless', 'ticketView', 'ungranted', ...(mappedChild ? ['child'] : [])];
  const generic = options.secondaryWrite ? ['archive.ticket'] : ['ticket', 'reviewer', 'limited', 'pair', 'keyless', 'ticketView'];
  // Every resource is read; the generic writes are the write ceilings.
  const ceiling = (name: string) => (generic.includes(name) ? 'write' : undefined) as 'write' | undefined;
  // Deletion is opt-in per resource: every write ceiling here also deletes,
  // so each refusal below is still the row policy's, the key's or the field's.
  const grant = (name: string) => (ceiling(name) === 'write' ? { access: 'write' as const, delete: true as const } : {});
  const app = parseAppConfig(
    {
      id: appId,
      name: 'Scoped deletes',
      sources: { operations: { connection: owner, default: true }, archive: { connection: archiveOwner } },
      resources: {
        ticket: { physical: 'physical_ticket', ...grant('ticket') },
        reviewer: { physical: 'physical_reviewer', ...grant('reviewer') },
        limited: {
          physical: 'physical_limited',
          ...grant('limited'),
          fields: { read: ['id', 'desk', 'name'], write: options.secondaryWrite ? [] : ['name'] },
        },
        pair: { physical: 'physical_pair', ...grant('pair') },
        keyless: { physical: 'physical_keyless', ...grant('keyless') },
        ticketView: { physical: 'physical_ticket_view', ...grant('ticketView') },
        ungranted: { physical: 'physical_ungranted', ...grant('ungranted') },
        ...(mappedChild ? { child: { physical: 'physical_child', ...grant('child') } } : {}),
        'archive.ticket': { physical: 'physical_ticket', ...grant('archive.ticket') },
        'archive.reviewer': { physical: 'physical_reviewer', ...grant('archive.reviewer') },
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
        },
      },
      views: { ticket: { kind: 'list', from: 'ticket' }, 'archive-ticket': { kind: 'list', from: 'archive.ticket' } },
      home: 'ticket',
      nav: ['ticket', 'archive-ticket'],
    },
    'scoped delete HTTP fixture',
  );
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
              insert: async (request) => {
                events.push('insert');
                const result = await tx.insert(request);
                control.afterInsert?.();
                return result;
              },
              remove: (request) => {
                events.push('remove');
                return tx.remove(request);
              },
            },
            catalog,
          );
          if (control.fault === 'rollback') throw new Refusal('PRIVATE physical_ticket rollback');
          if (control.fault === 'unknown-rollback') throw constraint();
          return value;
        });
        if (control.fault === 'unknown-commit') throw new TransactionOutcomeUnknown(constraint());
        await control.afterCommit?.();
        return result;
      } catch (error) {
        if (control.fault === 'unknown-rollback') throw new TransactionOutcomeUnknown(error);
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
    `export const control = { desk: 1, parentDesk: 1, allow: true, deniedKeys: [], calls: [] };
    export default { appId: ${JSON.stringify(appId)},
      ${
        options.hook === false
          ? ''
          : `authorizeDeletedRecord(principal, record) {
        control.calls.push(JSON.parse(JSON.stringify({ principal, record })));
        if (control.handler) return control.handler(principal, record);
        return control.allow && !control.deniedKeys.includes(record.key.id);
      },`
      }
      resolveRows() {
        return Object.fromEntries(${JSON.stringify([...local, 'archive.ticket', 'archive.reviewer'])}.map(table =>
          [table, { groups: [[{ column: 'desk', op: '=', value: table.endsWith('reviewer') ? control.parentDesk : control.desk }]] }]));
      }
    };`,
  );
  const policyControl: PolicyControl = (await import(pathToFileURL(file).href)).control;
  const start = async () => {
    const policy = await loadHttpAppPolicy({
      app,
      registry,
      file,
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
        signal: AbortSignal.timeout(5000),
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
  const rows = () =>
    db
      .prepare('SELECT * FROM physical_ticket ORDER BY id')
      .all()
      .map((row) => ({ ...row }));
  const row = (id: number) => {
    const stored = db.prepare('SELECT * FROM physical_ticket WHERE id = ?').get(id);
    return stored && { ...stored };
  };
  return { db, archive, registry, control, policyControl, rows, row, start, ...running };
}

type Reply = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['request']>>;
function deleted(reply: Reply): void {
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.headers.get('x-mistri-account'), account.id);
  // An App has no Undo: a deletion carries no token to take it back.
  assert.deepEqual(Object.keys(reply.body).sort(), ['affected', 'deleted', 'impact']);
  assert.equal(reply.body.deleted, true);
  assert.equal(reply.body.affected, 1);
  assert.deepEqual(reply.body.impact, []);
}
function previewed(reply: Reply) {
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.deepEqual(reply.body, { impact: [], deleted: false });
}
function denied(reply: Reply) {
  assert.ok([400, 403, 409].includes(reply.status), JSON.stringify(reply.body));
  for (const field of ['undoId', 'row', 'key', 'applied', 'before', 'after', 'affected']) assert.equal(reply.body[field], undefined, field);
}
function deleteDenied(reply: Reply) {
  denied(reply);
  assert.equal(reply.body.deleted, false);
}
/** An App has no Undo (WR1): its revert route says so, and nothing reached the connection's journal. */
function noUndo(reply: Reply) {
  assert.equal(reply.status, 404, JSON.stringify(reply.body));
  assert.equal(reply.body.error, 'An App has no Undo.');
  assert.deepEqual(history(owner), []);
}
async function metadata(f: Awaited<ReturnType<typeof fixture>>) {
  const reply = await f.request('/api/schema');
  assert.equal(reply.status, 200);
  return new Map<string, { deletable?: boolean }>(reply.body.tables.map((table: { id: string }) => [table.id, table]));
}

test('without the server-only deleted-record hook generic DELETE is 403 and metadata disables deletion', async (t) => {
  const f = await fixture(t, { hook: false });
  const original = f.rows();
  for (const table of (await metadata(f)).values()) assert.equal(table.deletable, false);
  for (const body of [deletion(), confirmed()]) {
    const reply = await f.request('/api/delete', body);
    assert.equal(reply.status, 403);
    deleteDenied(reply);
  }
  assert.deepEqual(f.rows(), original);
  noUndo(await f.request('/api/revert', {}));
});

test('DELETE metadata requires complete fields, a keyed writable table and no incoming FK', async (t) => {
  const f = await fixture(t);
  const tables = await metadata(f);
  for (const name of ['ticket', 'pair']) assert.equal(tables.get(name)?.deletable, true, name);
  for (const name of ['reviewer', 'limited', 'keyless', 'ticketView', 'ungranted', 'archive.ticket']) {
    assert.equal(tables.get(name)?.deletable, false, name);
  }
  for (const role of ['limited', 'readonlyField', 'viewer']) {
    f.control.identity = { ...account, role };
    assert.equal((await metadata(f)).get('ticket')?.deletable, false, role);
  }
});

test('omitted or false confirmation previews an empty impact array without deletion or history', async (t) => {
  const f = await fixture(t);
  const original = f.rows();
  for (const body of [deletion(), deletion({ confirm: false }), deletion({ app: appId })]) {
    previewed(await f.request('/api/delete', body));
  }
  assert.ok(f.policyControl.calls.length >= 3, 'Every preview must consult current historical authorization');
  assert.ok(f.control.transactions.every((events) => !events.includes('remove') && !events.includes('insert')));
  assert.deepEqual(f.rows(), original);
  noUndo(await f.request('/api/revert', {}));
});

test('confirmed DELETE reads and removes on one writer and journals nothing', async (t) => {
  const f = await fixture(t);
  deleted(await f.request('/api/delete', confirmed()));
  assert.equal(f.row(1), undefined);
  const writes = f.control.transactions.filter((events) => events.includes('remove'));
  assert.equal(writes.length, 1);
  assert.ok(writes[0].indexOf('query') >= 0 && writes[0].indexOf('query') < writes[0].indexOf('remove'));
  noUndo(await f.request('/api/revert', {}));
});

test('composite DELETE keys must be complete and reach the hook as the stored key types', async (t) => {
  const f = await fixture(t);
  for (const key of [{ desk: 1 }, { code: '0042' }, { desk: 1, code: '0042', name: 'Composite ticket' }]) {
    deleteDenied(await f.request('/api/delete', confirmed({ table: 'pair', key })));
  }
  deleted(await f.request('/api/delete', confirmed({ table: 'pair', key: { desk: '1', code: '0042' } })));
  const call = f.policyControl.calls.at(-1)!;
  assert.deepEqual(call.record.key, { desk: 1, code: '0042' });
  assert.equal(call.record.table, 'pair');
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM physical_pair WHERE desk = 1 AND code = '0042'").get()!.n, 0);
});

test('hidden and missing current rows refuse identically even when the deleted-record hook returns true', async (t) => {
  const f = await fixture(t);
  const original = f.rows();
  for (const confirm of [false, true]) {
    const hidden = await f.request('/api/delete', deletion({ key: { id: 2 }, confirm }));
    const missing = await f.request('/api/delete', deletion({ key: { id: 999 }, confirm }));
    deleteDenied(hidden);
    deleteDenied(missing);
    assert.equal(hidden.status, missing.status);
    assert.deepEqual(hidden.body, missing.body);
  }
  assert.deepEqual(f.rows(), original);
  assert.ok(f.policyControl.calls.every((call) => call.record.key.id !== 2 && call.record.key.id !== 999));
  noUndo(await f.request('/api/revert', {}));
});

test('DELETE requires an object, a complete scalar key and omitted or boolean confirmation', async (t) => {
  const f = await fixture(t);
  const original = f.rows();
  const malformed = [
    null,
    [],
    'ticket',
    1,
    true,
    {},
    { table: 'ticket' },
    ...[null, [], '', 1, true, {}, { id: null }, { id: true }, { id: [] }, { id: {} }, { id: 1, desk: 1 }, { name: 'Original ticket' }].map(
      (key) => confirmed({ key }),
    ),
    ...[null, 'true', 'false', 0, 1, [], {}].map((confirm) => deletion({ confirm })),
  ];
  for (const body of malformed) deleteDenied(await f.request('/api/delete', body));
  assert.deepEqual(f.rows(), original);
  noUndo(await f.request('/api/revert', {}));
});

test('unexpected fields, graph options, caller row images and forged policy claims never widen DELETE', async (t) => {
  const f = await fixture(t);
  const original = f.rows();
  for (const extra of [
    { surprise: true },
    { values: {} },
    { expected: { name: 'Forged original' } },
    { row: f.row(1) },
    { source: 'archive' },
    { conn: owner },
    { actor: account.id },
    { principal: account.id },
    { identity: account },
    { role: 'editor' },
    { rows: { ticket: true } },
    { rowPolicy: false },
    { authorizeDeletedRecord: true },
    { cascade: true },
    { graph: [] },
    { access: { write: true } },
    { writable: true },
  ]) {
    deleteDenied(await f.request('/api/delete', confirmed(extra)));
  }
  assert.deepEqual(f.rows(), original);
  assert.deepEqual(f.policyControl.calls, [], 'Client expected/row data must not reach a policy callback');
});

test('physical identities, SQL injection, views, keyless and ungranted targets refuse safely', async (t) => {
  const f = await fixture(t);
  const original = f.rows();
  for (const table of [
    'physical_ticket',
    'operations.physical_ticket',
    'ticket; DELETE FROM physical_ticket',
    'missing',
    'archive.ticket',
    'keyless',
    'ticketView',
    'ungranted',
    null,
    {},
    ['ticket'],
  ]) {
    deleteDenied(await f.request('/api/delete', confirmed({ table })));
  }
  deleteDenied(await f.request('/api/delete', confirmed({ key: { id: "1' OR 1=1 --" } })));
  assert.deepEqual(f.rows(), original);
  assert.equal((await f.request('/api/delete')).status, 403);
});

test('request selectors, stale sessions and forged identities cannot authorize DELETE', async (t) => {
  const f = await fixture(t);
  const original = f.rows();
  for (const selector of ['app=another-app', `conn=${owner}`]) denied(await f.request(`/api/delete?${selector}`, confirmed()));
  denied(await f.request('/api/delete', confirmed({ app: 'another-app' })));
  assert.equal((await f.request('/api/delete', confirmed(), { 'x-mistri-account': 'stale' })).status, 409);
  f.control.identity = null;
  assert.equal((await f.request('/api/delete', confirmed(), { 'x-role': 'editor' })).status, 401);
  f.control.identity = { ...account, role: 'viewer' };
  denied(await f.request('/api/delete?role=editor', confirmed(), { 'x-role': 'editor', 'x-mistri-role': 'editor' }));
  f.control.identity = { ...account };
  for (const verified of [null, { ...account, id: 'another-account' }, { ...account, role: 'viewer' }]) {
    f.control.verified = verified;
    assert.equal((await f.request('/api/delete', confirmed())).status, 403);
  }
  assert.deepEqual(f.rows(), original);
  assert.deepEqual(f.policyControl.calls, []);
  assert.equal(f.control.transactions.length, 0);
});

test('partial read/write fields and readonly source grants refuse preview and confirmed deletion', async (t) => {
  const f = await fixture(t);
  const original = f.rows();
  for (const role of ['limited', 'readonlyField', 'viewer']) {
    f.control.identity = { ...account, role };
    for (const confirm of [false, true]) deleteDenied(await f.request('/api/delete', deletion({ confirm })));
  }
  f.control.identity = { ...account };
  deleteDenied(await f.request('/api/delete', confirmed({ table: 'limited' })));
  f.registry.configOf(owner)!.writable = false;
  for (const confirm of [false, true]) deleteDenied(await f.request('/api/delete', deletion({ confirm })));
  assert.deepEqual(f.rows(), original);
  assert.equal(f.db.prepare('SELECT private_note FROM physical_limited').get()!.private_note, 'PRIVATE field');
});

test('an incoming FK with zero children still disables DELETE and prevents a cascade promise', async (t) => {
  const f = await fixture(t, { incoming: 'empty' });
  const original = f.rows();
  assert.equal((await metadata(f)).get('ticket')?.deletable, false);
  for (const confirm of [false, true]) deleteDenied(await f.request('/api/delete', deletion({ confirm })));
  assert.deepEqual(f.rows(), original);
  noUndo(await f.request('/api/revert', {}));
});

test('hidden or unmapped incoming children cannot be mistaken for proof that DELETE has no effects', async (t) => {
  for (const incoming of ['hidden', 'unmapped'] as const) {
    const f = await fixture(t, { incoming });
    const original = f.rows();
    assert.equal((await metadata(f)).get('ticket')?.deletable, false);
    for (const confirm of [false, true]) deleteDenied(await f.request('/api/delete', deletion({ confirm })));
    assert.deepEqual(f.rows(), original);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM physical_child').get()!.n, 1);
    assert.ok(f.control.transactions.every((events) => !events.includes('remove')));
  }
});

test('original capture occurs inside the deleting writer and the hook receives only verified identity and actual data', async (t) => {
  const f = await fixture(t);
  previewed(await f.request('/api/delete', deletion({ key: { id: '1' } })));
  f.policyControl.calls.length = 0;
  let captured: Record<string, unknown> | undefined;
  f.control.beforeTransaction = () => {
    f.control.beforeTransaction = undefined;
    f.db.exec("UPDATE physical_ticket SET name = 'Changed before writer', note = '', status = 'open' WHERE id = 1");
    captured = f.row(1);
  };
  deleted(await f.request('/api/delete', confirmed({ key: { id: '1' } })));
  assert.ok(captured);
  assert.ok(f.policyControl.calls.length > 0);
  const actual = f.policyControl.calls.at(-1)!;
  assert.deepEqual(actual.principal, { id: account.id, appId, roles: ['editor'], email: account.who });
  assert.deepEqual(actual.record, { table: 'ticket', key: { id: 1 }, row: captured });
  assert.deepEqual(Object.keys(actual.record).sort(), ['key', 'row', 'table']);
  assert.equal(f.row(1), undefined);
});

test('every new preview and confirmation rechecks hook authorization and current row scope', async (t) => {
  const f = await fixture(t);
  previewed(await f.request('/api/delete', deletion()));
  f.policyControl.allow = false;
  for (const confirm of [false, true]) deleteDenied(await f.request('/api/delete', deletion({ confirm })));
  f.policyControl.allow = true;
  f.policyControl.desk = 2;
  for (const confirm of [false, true]) deleteDenied(await f.request('/api/delete', deletion({ confirm })));
  assert.ok(f.row(1));
  noUndo(await f.request('/api/revert', {}));
});

test('hook revocation at writer entry prevents a DELETE authorized by an earlier preview', async (t) => {
  const f = await fixture(t);
  previewed(await f.request('/api/delete', deletion()));
  f.control.beforeTransaction = () => {
    f.control.beforeTransaction = undefined;
    f.policyControl.allow = false;
  };
  deleteDenied(await f.request('/api/delete', confirmed()));
  assert.ok(f.row(1));
  assert.ok(f.control.transactions.every((events) => !events.includes('remove')));
  noUndo(await f.request('/api/revert', {}));
});

test('secondary-source DELETE uses exact logical identities with a readonly default source', async (t) => {
  const f = await fixture(t, { secondaryWrite: true });
  const originalDefault = f.rows();
  const originalArchive = f.archive.prepare('SELECT * FROM physical_ticket WHERE id = 1').get();
  assert.deepEqual((await f.request('/api/app')).body.app.writableTables, ['archive.ticket']);
  assert.equal((await metadata(f)).get('archive.ticket')?.deletable, true);
  deleteDenied(await f.request('/api/delete', confirmed()));
  deleted(await f.request('/api/delete', confirmed({ table: 'archive.ticket', key: { id: '1' } })));
  assert.deepEqual(f.policyControl.calls.at(-1)!.record, { table: 'archive.ticket', key: { id: 1 }, row: { ...originalArchive } });
  assert.equal(f.archive.prepare('SELECT * FROM physical_ticket WHERE id = 1').get(), undefined);
  assert.deepEqual(f.rows(), originalDefault);
});

test('known DELETE rollback preserves rows without disclosing the private failure', async (t) => {
  const f = await fixture(t);
  const original = f.rows();
  f.control.fault = 'rollback';
  deleteDenied(await f.request('/api/delete', confirmed()));
  f.control.fault = '';
  assert.deepEqual(f.rows(), original);
});

for (const outcome of ['rollback', 'commit'] as const) {
  test(`unknown DELETE ${outcome} stays uncertain even with a recognized constraint cause`, async (t) => {
    const f = await fixture(t);
    const older = await f.request('/api/insert', { table: 'ticket', values: { name: 'Older creation' } });
    assert.equal(older.status, 200);
    f.control.fault = outcome === 'commit' ? 'unknown-commit' : 'unknown-rollback';
    const reply = await f.request('/api/delete', confirmed());
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.deleted, null);
    assert.equal(reply.body.outcome, 'unknown');
    assert.ok(reply.body.errors?.length);
    for (const field of ['key', 'row', 'applied', 'undoId', 'affected']) assert.equal(reply.body[field], undefined, field);
    assert.equal(f.row(1) === undefined, outcome === 'commit');
    f.control.fault = '';
    assert.ok(f.row(older.body.key.id));
    assert.deepEqual(history(owner), []);
  });
}

test('false, nonboolean and throwing deleted-record hooks fail closed without leaking policy values', async (t) => {
  const f = await fixture(t);
  const original = f.rows();
  for (const value of [false, 'PRIVATE truthy grant', 1, {}, Promise.resolve(true)]) {
    f.policyControl.handler = () => value;
    deleteDenied(await f.request('/api/delete', confirmed()));
  }
  f.policyControl.handler = () => {
    throw new Error('PRIVATE deleted-record policy failure');
  };
  deleteDenied(await f.request('/api/delete', confirmed()));
  assert.deepEqual(f.rows(), original);
  noUndo(await f.request('/api/revert', {}));
});
