/** A file upload under a row policy is an insert like any other: the policy
 * that judges a row judges the file's, on the server, whatever the browser
 * drew; and removing a file is a delete the same policy judges. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { loadHttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';

const appId = 'policy-uploads';
const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255, 128]);
const account = (id: string, role = 'staff'): Identity => ({ id, who: `${id}@example.test`, role });

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-policy-uploads-'));
  const file = join(directory, 'lot.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE car (id INTEGER PRIMARY KEY, desk INTEGER NOT NULL, name TEXT);
    CREATE TABLE photo (id INTEGER PRIMARY KEY, desk INTEGER NOT NULL, car_id INTEGER NOT NULL REFERENCES car(id),
      file_name TEXT, content_type TEXT, byte_size INTEGER, data BLOB, thumbnail BLOB);
    INSERT INTO car VALUES (1, 1, 'Desk one car'), (2, 2, 'Desk two car');
    INSERT INTO photo (id, desk, car_id, file_name, content_type, byte_size, data) VALUES
      (10, 1, 1, 'one.png', 'image/png', 3, X'010203'), (20, 2, 2, 'two.png', 'image/png', 3, X'040506');`);
  const registry = new Registry();
  registry.add({ id: 'lot', name: 'Lot', url: file, source: 'config', writable: true });
  await registry.open('lot');
  const app = parseAppConfig(
    {
      id: appId,
      name: 'Policy uploads',
      sources: { lot: { connection: 'lot', default: true } },
      resources: {
        car: {},
        photo: {
          access: 'write',
          delete: true,
          file: { content: 'data', name: 'file_name', type: 'content_type', size: 'byte_size', thumbnail: 'thumbnail' },
        },
      },
      auth: {
        rows: 'policy',
        roles: { staff: { read: true, write: ['photo'] }, viewer: { read: true } },
      },
      views: { cars: { kind: 'list', from: 'car' } },
      home: 'cars',
    },
    'policy uploads fixture',
  );
  const control = { identity: account('desk-one') as Identity | null };
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
  const policyFile = join(directory, 'policy.mjs');
  // Each desk reaches its own cars and photos; a delete is the policy's to allow as well.
  writeFileSync(
    policyFile,
    `export const control = { allowDelete: true };
  export default {
    appId: '${appId}',
    authorizeDeletedRecord() { return control.allowDelete; },
    resolveRows(principal) {
      const desk = { groups: [[{ column: 'desk', op: '=', value: principal.id === 'desk-two' ? 2 : 1 }]] };
      return { car: desk, photo: desk };
    }
  };`,
  );
  const policyControl = (await import(pathToFileURL(policyFile).href)).control as { allowDelete: boolean };
  const policy = await loadHttpAppPolicy({ app, registry, file: policyFile, verifySession: async () => control.identity });
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], policy, pages: [] });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await policy.retire();
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
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${base}${path}?app=${appId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as Record<string, any> };
  };
  const upload = (values: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    post('/api/file/upload', {
      app: appId,
      table: 'photo',
      values,
      file: { name: 'front.png', type: 'image/png', data: bytes.toString('base64') },
      ...extra,
    });
  const photos = () =>
    db
      .prepare('SELECT id, desk, car_id, file_name FROM photo ORDER BY id')
      .all()
      .map((row) => ({ ...row }));
  const catalog = async () => {
    const response = await fetch(`${base}/api/schema?app=${appId}`, { signal: AbortSignal.timeout(5000) });
    const schema = (await response.json()) as { tables: Array<{ id: string; insertable?: boolean; deletable?: boolean }> };
    return schema.tables.find((table) => table.id === 'photo');
  };
  return { db, control, policyControl, base, post, upload, photos, catalog };
}

test('a principal the policy lets insert uploads a file, written under the policy and not echoed back', async (t) => {
  const f = await fixture(t);
  const meta = await fetch(`${f.base}/api/app?app=${appId}`).then((response) => response.json());
  assert.equal(meta.app.resources.photo.file.upload, undefined, 'no upload flag rides with the file; the catalog says who may add');
  assert.equal((await f.catalog())?.insertable, true);
  const sent = await f.upload({ desk: 1, car_id: 1 });
  assert.equal(sent.status, 200, sent.text);
  assert.ok(Number.isSafeInteger(sent.body.key?.id));
  assert.equal(sent.body.row.file_name, 'front.png');
  assert.equal(sent.body.row.data, undefined, 'the bytes are not sent back');
  assert.equal(sent.body.applied.data, undefined);
  assert.ok(sent.text.length < 2000);
  const stored = f.db
    .prepare('SELECT desk, car_id, file_name, content_type, byte_size, hex(data) AS hex FROM photo WHERE id = ?')
    .get(sent.body.key.id)!;
  assert.deepEqual(
    { ...stored },
    {
      desk: 1,
      car_id: 1,
      file_name: 'front.png',
      content_type: 'image/png',
      byte_size: bytes.length,
      hex: bytes.toString('hex').toUpperCase(),
    },
  );
  // Read back through the policy's own file read.
  const read = await fetch(`${f.base}/api/file?${new URLSearchParams({ app: appId, table: 'photo', key: JSON.stringify(sent.body.key) })}`);
  assert.equal(read.status, 200);
  assert.deepEqual(Buffer.from(await read.arrayBuffer()), bytes);
  // The upload's own checks still hold under the policy: the file's columns are the file's.
  const forged = await f.upload({ desk: 1, car_id: 1, file_name: 'forged.png' });
  assert.equal(forged.status, 400);
  assert.equal(f.photos().length, 3);
});

test('a principal the policy refuses is refused by the server, called directly', async (t) => {
  const f = await fixture(t);
  f.control.identity = account('desk-one', 'viewer');
  assert.equal((await f.catalog())?.insertable, false, 'the catalog offers no Add to a reader who may not insert');
  const before = f.photos();
  for (const attempt of [
    await f.upload({ desk: 1, car_id: 1 }),
    // Naming a table that holds no files, or one the reader cannot see, says nothing more.
    await f.post('/api/file/upload', { app: appId, table: 'car', values: { desk: 1 }, file: { name: 'a.txt', data: 'aGk=' } }),
    await f.post('/api/file/upload', { app: appId, table: 'missing', values: {}, file: { name: 'a.txt', data: 'aGk=' } }),
  ]) {
    assert.equal(attempt.status, 403, attempt.text);
    assert.equal(attempt.body.outcome, 'rejected');
    assert.doesNotMatch(attempt.text, /front\.png|files/);
  }
  // A staff member's table that holds no files is refused, and so is an extra body key, as on any insert.
  f.control.identity = account('desk-one');
  assert.equal(
    (await f.post('/api/file/upload', { app: appId, table: 'car', values: { desk: 1 }, file: { name: 'a.txt', data: 'aGk=' } })).status,
    403,
  );
  assert.equal((await f.upload({ desk: 1, car_id: 1 }, { conn: 'lot' })).status, 403);
  assert.equal((await f.upload({ desk: 1, car_id: 1 }, { key: { id: 99 } })).status, 403);
  // Signed out, nothing is uploaded.
  f.control.identity = null;
  assert.notEqual((await f.upload({ desk: 1, car_id: 1 })).status, 200);
  assert.deepEqual(f.photos(), before);
});

test("an upload into another partition's rows is refused: the stored row and its parent are the policy's", async (t) => {
  const f = await fixture(t);
  const before = f.photos();
  // Desk one stamping desk two's partition, or hanging a file on desk two's car.
  for (const values of [
    { desk: 2, car_id: 2 },
    { desk: 1, car_id: 2 },
    { desk: 2, car_id: 1 },
  ]) {
    // A row outside the principal's rows is the scoped writer's refusal, said as any insert's (400, rejected).
    const attempt = await f.upload(values);
    assert.equal(attempt.status, 400, `${JSON.stringify(values)}: ${attempt.text}`);
    assert.equal(attempt.body.outcome, 'rejected');
    assert.doesNotMatch(attempt.text, /Desk two|two\.png|outside/);
  }
  assert.deepEqual(f.photos(), before);
  // Desk two adds to its own car, and still not to desk one's.
  f.control.identity = account('desk-two');
  assert.equal((await f.upload({ desk: 2, car_id: 2 })).status, 200);
  assert.equal((await f.upload({ desk: 2, car_id: 1 })).status, 400);
  assert.equal(f.photos().length, before.length + 1);
});

test("removing a file is a delete the same policy judges: one's own partition, a deleting role, the policy's word", async (t) => {
  const f = await fixture(t);
  const remove = (id: number) => f.post('/api/delete', { app: appId, table: 'photo', key: { id }, confirm: true });
  assert.equal((await f.catalog())?.deletable, true);
  // Another desk's file is not there to remove.
  assert.equal((await remove(20)).status, 403);
  // A reader who may not write may not remove.
  f.control.identity = account('desk-one', 'viewer');
  assert.equal((await f.catalog())?.deletable, false);
  assert.equal((await remove(10)).status, 403);
  // The policy's own refusal holds as well.
  f.control.identity = account('desk-one');
  f.policyControl.allowDelete = false;
  assert.equal((await remove(10)).status, 403);
  assert.deepEqual(
    f.photos().map((row) => row.id),
    [10, 20],
  );
  f.policyControl.allowDelete = true;
  const removed = await remove(10);
  assert.equal(removed.status, 200, removed.text);
  assert.equal(removed.body.deleted, true);
  assert.deepEqual(
    f.photos().map((row) => row.id),
    [20],
  );
});
