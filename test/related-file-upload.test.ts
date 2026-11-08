/**
 * A related list's upload (F26): the record it hangs off is named once, by `parent: { table, key }`, and the server
 * reads that record as this actor and writes the link itself — a body that leaves the link out links to the addressed
 * record, one that names another record is refused, and a record the actor cannot read (by grant, by row policy, or by
 * a `via` scope) is one they cannot attach a file to. The columns the file rule `stamps` are the server's: the signed-in
 * person and the clock, whatever the body sends.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { appFileRules, parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { bindUploadParent, readUploadParent } from '../packages/mistri/src/server/files/uploadParent.js';
import { loadHttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';

const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255, 128]);
const account = (email: string, role = 'staff'): Identity => ({ id: email.split('@')[0], who: email, role });
const STAMPS = { uploaded_by: 'me', uploaded_at: 'now' } as const;
const fileRule = { content: 'data', name: 'file_name', type: 'content_type', size: 'byte_size', stamps: STAMPS };
const NOTE = '2000-01-01T00:00:00.000Z';

type Kind = 'plain' | 'policy' | 'via';

async function fixture(t: TestContext, kind: Kind) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-related-upload-'));
  const file = join(directory, 'desk.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE person (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL);
    INSERT INTO person VALUES (1, 'ann@example.test'), (2, 'bob@example.test');
    CREATE TABLE member (id INTEGER PRIMARY KEY, subject TEXT NOT NULL, desk INTEGER NOT NULL);
    INSERT INTO member VALUES (1, 'ann', 1), (2, 'bob', 2);
    CREATE TABLE ticket (id INTEGER PRIMARY KEY, desk INTEGER NOT NULL, name TEXT);
    INSERT INTO ticket VALUES (1, 1, 'Desk one ticket'), (2, 2, 'Desk two ticket');
    CREATE TABLE ticket_file (id INTEGER PRIMARY KEY, desk INTEGER NOT NULL DEFAULT 1, ticket_id INTEGER NOT NULL REFERENCES ticket(id),
      uploaded_by INTEGER REFERENCES person(id), uploaded_at TEXT,
      file_name TEXT, content_type TEXT, byte_size INTEGER, data BLOB);`);
  const registry = new Registry();
  registry.add({ id: 'desk', name: 'Desk', url: file, source: 'config', writable: true });
  await registry.open('desk');
  const app = parseAppConfig(
    {
      id: 'related-uploads',
      name: 'Related uploads',
      sources: { main: { connection: 'desk', default: true } },
      resources: { person: {}, member: {}, ticket: {}, ticket_file: { access: 'write', file: fileRule } },
      auth: {
        me: { from: 'person', column: 'email' },
        ...(kind === 'plain'
          ? {
              roles: { staff: { read: true, write: ['ticket_file'] }, narrow: { read: ['ticket_file', 'person'], write: ['ticket_file'] } },
            }
          : { rows: 'policy', roles: { staff: { read: true, write: ['ticket_file'] } } }),
      },
      views: { tickets: { kind: 'list', from: 'ticket' } },
      home: 'tickets',
    },
    'related uploads fixture',
  );
  const control = { identity: account('ann@example.test') as Identity | null };
  const host: AppHost = {
    app: { path: join(directory, 'app.ts'), app, pages: [], sources: {} },
    pages: [],
    auth: {
      spec: app.auth!,
      store: join(directory, 'auth.db'),
      close: async () => {},
      session: async () => control.identity,
      handler: async (_req, res) => {
        res.writeHead(204);
        res.end();
      },
    },
  };
  let policy: Awaited<ReturnType<typeof loadHttpAppPolicy>> | undefined;
  if (kind !== 'plain') {
    const policyFile = join(directory, 'policy.mjs');
    const desk = (who: string) => `{ column: 'desk', op: '=', value: ${who} === 'bob' ? 2 : 1 }`;
    writeFileSync(
      policyFile,
      kind === 'policy'
        ? `export default { appId: 'related-uploads',
  resolveRows(principal) {
    const desk = { groups: [[${desk('principal.id')}]] };
    return { person: true, member: false, ticket: desk, ticket_file: desk };
  } };`
        : // The desk a person works is a row of `member`: the tickets and files they reach are those whose desk is one of theirs.
          `export default { appId: 'related-uploads',
  resolveRows(principal) {
    const through = { groups: [[{ column: 'desk', op: 'in', via: { resource: 'member', column: 'desk' } }]] };
    return { person: true, member: { groups: [[{ column: 'subject', op: '=', value: principal.id }]] }, ticket: through, ticket_file: through };
  } };`,
    );
    policy = await loadHttpAppPolicy({ app, registry, file: policyFile, verifySession: async () => control.identity });
  }
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], ...(policy ? { policy } : {}), pages: [] });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await policy?.retire();
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  const base = `http://${bound.host}:${bound.port}`;
  const upload = async (extra: Record<string, unknown>) => {
    const response = await fetch(`${base}/api/file/upload?app=related-uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        app: 'related-uploads',
        table: 'ticket_file',
        file: { name: 'front.png', type: 'image/png', data: bytes.toString('base64') },
        ...extra,
      }),
      signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as Record<string, any> };
  };
  const files = () =>
    db
      .prepare('SELECT id, ticket_id, uploaded_by, uploaded_at, file_name FROM ticket_file ORDER BY id')
      .all()
      .map((row) => ({ ...row }));
  return { db, control, upload, files };
}

const parentOf = (id: number, extra: Record<string, unknown> = {}) => ({ table: 'ticket', key: { id }, ...extra });

for (const kind of ['plain', 'policy', 'via'] as const) {
  test(`${kind}: an upload that names no link is linked to the addressed record, and the stamps are the server's`, async (t) => {
    const f = await fixture(t, kind);
    const sent = await f.upload({ parent: parentOf(1), values: { uploaded_by: 2, uploaded_at: NOTE } });
    assert.equal(sent.status, 200, sent.text);
    const [row] = f.files();
    assert.equal(row.ticket_id, 1, 'the link is the addressed record, written by the server');
    assert.equal(row.uploaded_by, 1, "the session's person (ann), whatever the body sent");
    assert.notEqual(row.uploaded_at, NOTE, 'the clock is the server’s');
    assert.ok(Number.isFinite(Date.parse(String(row.uploaded_at))));
    // The body's own link may agree with the parent; leaving it out is no mistake.
    assert.equal((await f.upload({ parent: parentOf(1), values: { ticket_id: 1 } })).status, 200);
    assert.deepEqual(
      f.files().map((r) => r.ticket_id),
      [1, 1],
    );
    // A stamp is never the body's, even when the parent is absent.
    f.control.identity = account('bob@example.test');
    const second = await f.upload({
      parent: parentOf(kind === 'plain' ? 1 : 2),
      values: { uploaded_by: 1, ...(kind === 'plain' ? {} : { desk: 2 }) },
    });
    assert.equal(second.status, 200, second.text);
    assert.equal(f.files().at(-1)!.uploaded_by, 2);
  });

  test(`${kind}: a body link that names another record is refused, and nothing is written`, async (t) => {
    const f = await fixture(t, kind);
    const refused = await f.upload({ parent: parentOf(1), values: { ticket_id: 2 } });
    assert.equal(refused.status, 400, refused.text);
    assert.deepEqual(f.files(), []);
    // A parent that is not a record the file points at is refused too, and a malformed one.
    assert.equal((await f.upload({ parent: { table: 'member', key: { id: 1 } } })).status, 400);
    assert.equal((await f.upload({ parent: { table: 'ticket' } })).status, 400);
    assert.equal((await f.upload({ parent: { ...parentOf(1), extra: 1 } })).status, 400);
    assert.deepEqual(f.files(), []);
  });
}

test('plain: a record the grant does not let the actor read is one they cannot attach a file to', async (t) => {
  const f = await fixture(t, 'plain');
  f.control.identity = account('ann@example.test', 'narrow');
  const refused = await f.upload({ parent: parentOf(1) });
  assert.ok(refused.status === 403 || refused.status === 404, refused.text);
  assert.deepEqual(f.files(), []);
  f.control.identity = account('ann@example.test');
  assert.equal((await f.upload({ parent: parentOf(1) })).status, 200);
  assert.equal((await f.upload({ parent: parentOf(99) })).status, 404, 'no such record');
});

for (const kind of ['policy', 'via'] as const) {
  test(`${kind}: a parent outside the actor's rows is refused, and the file is not written`, async (t) => {
    const f = await fixture(t, kind);
    // Ann works desk one: ticket 2 is desk two's.
    const refused = await f.upload({ parent: parentOf(2), values: { desk: 1 } });
    assert.ok(refused.status === 403 || refused.status === 404, refused.text);
    assert.deepEqual(f.files(), []);
    // And the same ticket from the person whose desk it is.
    f.control.identity = account('bob@example.test');
    const bobs = await f.upload({ parent: parentOf(2), values: { desk: 2 } });
    assert.equal(bobs.status, 200, bobs.text);
    assert.deepEqual(
      f.files().map((row) => [row.ticket_id, row.uploaded_by]),
      [[2, 2]],
    );
  });
}

test('check: stamps name real columns that can hold them, and `me` needs a people table', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-file-stamps-'));
  const path = join(directory, 's.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE person (id INTEGER PRIMARY KEY, email TEXT);
    CREATE TABLE ticket (id INTEGER PRIMARY KEY);
    CREATE TABLE ticket_file (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES ticket(id), uploaded_by INTEGER REFERENCES person(id),
      uploaded_at TEXT, label TEXT, file_name TEXT, data BLOB);`);
  db.close();
  const adapter = new SqliteAdapter(path, 's');
  t.after(() => {
    adapter.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const schema = await adapter.introspect();
  const problems = (stamps: unknown, auth: unknown = { me: { from: 'person', column: 'email' }, roles: { staff: { read: true } } }) =>
    appFileRules(
      parseAppConfig(
        {
          id: 's',
          name: 'S',
          connection: 'c',
          resources: { person: {}, ticket: {}, ticket_file: { access: 'write', file: { content: 'data', name: 'file_name', stamps } } },
          ...(auth ? { auth } : {}),
          views: { tickets: { kind: 'list', from: 'ticket' } },
          home: 'tickets',
        },
        'x',
      ),
      schema,
    ).problems;
  assert.deepEqual(problems({ uploaded_by: 'me', uploaded_at: 'now' }), []);
  assert.match(problems({ nope: 'now' })[0], /file stamps "nope", which is not a column of ticket_file/);
  assert.deepEqual(problems({ label: 'me' }), [], 'a text column holds the account’s email');
  assert.match(problems({ uploaded_by: 'me' }, { roles: { staff: { read: true } } })[0], /file stamps "uploaded_by" with me/);
  assert.match(problems({ uploaded_by: 'now' })[0], /file stamps "uploaded_by" with now/);
  assert.throws(() => problems({ uploaded_by: 'sometimes' }), /me.*now|stamps/);
  assert.throws(() => problems({ file_name: 'now' }), /itself|fills/i);
});

test('two composite references to the parent that share a first column are told apart by all their columns', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-related-upload-composite-'));
  const path = join(directory, 'composite.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE item (tenant_id TEXT NOT NULL, item_id INTEGER NOT NULL, PRIMARY KEY (tenant_id, item_id));
    INSERT INTO item VALUES ('north', 1), ('north', 2);
    CREATE TABLE item_file (id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL, item_id INTEGER, replacement_id INTEGER, file_name TEXT,
      FOREIGN KEY (tenant_id, item_id) REFERENCES item(tenant_id, item_id),
      FOREIGN KEY (tenant_id, replacement_id) REFERENCES item(tenant_id, item_id));`);
  db.close();
  const adapter = new SqliteAdapter(path, 'c');
  t.after(() => {
    adapter.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const schema = await adapter.introspect();
  const read = (request: Parameters<typeof adapter.query>[0]) => adapter.query(request);
  const key = { tenant_id: 'north', item_id: 2 };
  const bind = (link?: string | readonly string[]) =>
    bindUploadParent(schema, 'item_file', { table: 'item', key, ...(link === undefined ? {} : { link }) }, {}, read);

  // The first column alone fits both references: refused, as ambiguous, and nothing is guessed.
  assert.deepEqual(await bind('tenant_id'), {
    status: 400,
    error: 'This list could not tell which reference of the file points at its record.',
  });
  assert.equal('error' in (await bind()), true);
  // The whole reference names one, whichever order the columns come in.
  assert.deepEqual(await bind(['tenant_id', 'item_id']), { values: { tenant_id: 'north', item_id: 2 } });
  assert.deepEqual(await bind(['replacement_id', 'tenant_id']), { values: { tenant_id: 'north', replacement_id: 2 } });
  // A set that is no reference of the file's is refused, not matched by a part of it.
  assert.equal('error' in (await bind(['item_id'])), true);
  assert.equal('error' in (await bind(['tenant_id', 'item_id', 'replacement_id'])), true);
  // The wire shape: a string, or a non-empty list of strings.
  assert.equal('error' in readUploadParent({ parent: { table: 'item', key, link: [] } }), true);
  assert.equal('error' in readUploadParent({ parent: { table: 'item', key, link: ['tenant_id', 7] } }), true);
  /* A column said twice is not a column set: it must not pass for the single-column reference on tenant_id. */
  assert.equal('error' in readUploadParent({ parent: { table: 'item', key, link: ['tenant_id', 'tenant_id'] } }), true);
  assert.deepEqual(readUploadParent({ parent: { table: 'item', key, link: ['tenant_id', 'item_id'] } }), {
    parent: { table: 'item', key, link: ['tenant_id', 'item_id'] },
  });
});
