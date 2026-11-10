import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { field } from '../packages/mistri/src/server/commands/commandFields.js';
import { literal, shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { resetPublicFormLimits } from '../packages/engine/src/server/http/rateLimit.js';
import { loadHttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import { parseTestApp } from './support/commandCatalog.js';

const PNG = (fill = 1, size = 32) => {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
};
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const MB = 1024 * 1024;

/** A row-policy App whose enrolled public form takes photos into one fixed destination (desk 1). */
async function fixture(t: TestContext, options: { saved?: boolean } = {}) {
  resetPublicFormLimits();
  const directory = mkdtempSync(join(tmpdir(), 'mistri-policy-files-'));
  const file = join(directory, 'data.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE inbox(id INTEGER PRIMARY KEY, name TEXT NOT NULL, desk INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE inbox_file(id INTEGER PRIMARY KEY, desk INTEGER NOT NULL DEFAULT 1, file_name TEXT NOT NULL, content_type TEXT,
      byte_size INTEGER, data BLOB);`);
  migrateSqliteCommandJournal(file);
  const registry = new Registry();
  registry.add({ id: 'data', name: 'Data', url: file, source: 'config', writable: true });
  const input = { name: { label: 'Name', type: 'text' }, photos: field.files('inbox_file', { max: 12, accept: 'image/*' }) } as const;
  const form = { kind: 'form', public: true, label: 'Contact', command: { id: 'contact', version: 1, input } };
  const app = parseTestApp(
    {
      id: 'intake',
      name: 'Intake',
      sources: { main: { connection: 'data' } },
      auth: { rows: 'policy', roles: { staff: { read: true } } },
      resources: {
        inbox: { access: 'write' },
        inbox_file: {
          access: 'write',
          file: { content: 'data', name: 'file_name', type: 'content_type', size: 'byte_size', maxBytes: 20 * MB },
        },
      },
      views: {
        inbox: { kind: 'list', from: 'inbox' },
        contact: form,
        // Saved on every step: its files stay closed, as the ordinary host's are.
        draft: form,
      },
      home: 'inbox',
      nav: ['inbox'],
    },
    'HTTP policy files fixture',
  );
  // Parsing a real saved form takes its steps and roots; the policy's startup reads only that it is one.
  if (options.saved)
    (app.views.draft as { save?: unknown }).save = {
      draft: { column: 'name', value: 'draft' },
      resume: { by: 'link' },
      abandoned: 'purge',
    };
  const state = { calls: 0 };
  const commands = defineCommands({
    contact: defineCommand({
      targets: 'none',
      source: 'main',
      target: 'inbox',
      public: true,
      write: ['inbox', 'inbox_file'],
      input,
      output: shape({ reference: text(), message: literal('Received.') }),
      async handle({ db }, value) {
        state.calls++;
        await db.inbox.insert({ name: value.name });
        for (const photo of value.photos) await db.inbox_file.insertFile(photo, { desk: 1 });
        return { reference: `CONTACT-${state.calls}`, message: 'Received.' };
      },
    }),
  });
  const host: AppHost = {
    app: { path: join(directory, 'app.ts'), app, pages: [], sources: {} },
    pages: [],
    auth: {
      spec: app.auth!,
      store: join(directory, 'auth.db'),
      close: async () => {},
      session: async () => null as Identity | null,
      handler: async (_req, res) => {
        res.writeHead(204);
        res.end();
      },
    },
  };
  const policyFile = join(directory, 'policy.mjs');
  writeFileSync(
    policyFile,
    `export default {
    appId: 'intake', resolveRows() { throw new Error('Public intake must not resolve account rows'); }, resultReferences: {},
    publicForms: { contact: { rows: { inbox: { groups: [[{ column: 'desk', op: '=', value: 1 }]] },
      inbox_file: { groups: [[{ column: 'desk', op: '=', value: 1 }]] } }, resultReferences: () => [] } }
  };`,
  );
  const policy = await loadHttpAppPolicy({ app, registry, file: policyFile, commands, verifySession: async () => null }).catch(
    async (error: unknown) => {
      await registry.closeAll();
      db.close();
      rmSync(directory, { recursive: true, force: true });
      throw error;
    },
  );
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
  /** Holds a file as the visitor holding `cookie`; answers the status, body and the cookie to send next. */
  const hold = async (cookie: string | undefined, bytes: Uint8Array, name = 'a.png', extra: object = {}, key = 'contact') => {
    const response = await fetch(`${base}/api/forms/${key}/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ field: 'photos', file: { name, type: 'image/png', data: base64(bytes) }, ...extra }),
      signal: AbortSignal.timeout(20000),
    });
    const set = response.headers.get('set-cookie')?.split(';')[0];
    return { status: response.status, body: (await response.json()) as Record<string, unknown>, cookie: set ?? cookie };
  };
  const submit = async (cookie: string | undefined, photos: string[], submission: string) => {
    const response = await fetch(`${base}/api/forms/contact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ input: { name: 'Visitor', photos }, submission }),
      signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, text: await response.text() };
  };
  return { state, hold, submit, base, db };
}

const count = (db: DatabaseSync, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

test('a public upload under row policy is held and taken into the fixed destination, with an empty receipt', async (t) => {
  const f = await fixture(t);
  const bytes = PNG(7, 64);
  const held = await f.hold(undefined, bytes);
  assert.equal(held.status, 200);
  assert.match(held.cookie ?? '', /^mistri_files_contact=/);
  const id = held.body.id as string;
  const sent = await f.submit(held.cookie, [id], 'public-submission-0001');
  assert.equal(sent.status, 200);
  const receipt = JSON.parse(sent.text) as Record<string, unknown>;
  assert.deepEqual(Object.keys(receipt).sort(), ['message', 'receipt', 'reference']);
  assert.ok(!sent.text.includes(id));
  const rows = f.db.prepare('SELECT desk, file_name, byte_size, data FROM inbox_file').all() as Array<{
    desk: number;
    file_name: string;
    byte_size: number;
    data: Uint8Array;
  }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.desk, 1);
  assert.equal(rows[0]!.byte_size, bytes.byteLength);
  assert.deepEqual(new Uint8Array(rows[0]!.data), bytes);
  assert.equal(count(f.db, 'inbox'), 1);
  // An id is used once.
  assert.equal((await f.submit(held.cookie, [id], 'public-submission-0002')).status, 400);
  assert.equal(count(f.db, 'inbox_file'), 1);
});

test("the destination is not the request's: a body naming a command or destination changes nothing", async (t) => {
  const f = await fixture(t);
  const held = await f.hold(undefined, PNG(), 'a.png', { command: 'other', desk: 2, table: 'inbox' });
  assert.equal(held.status, 200);
  assert.equal((await f.submit(held.cookie, [held.body.id as string], 'public-submission-0003')).status, 200);
  assert.equal((f.db.prepare('SELECT desk FROM inbox_file').get() as { desk: number }).desk, 1);
});

test('per-visitor caps hold under row policy: 413 over 10 MB a file, the 11th file and more than 25 MB refused', async (t) => {
  const f = await fixture(t);
  const huge = await f.hold(undefined, PNG(1, 10 * MB + 1));
  assert.equal(huge.status, 413, JSON.stringify(huge.body));
  let cookie: string | undefined;
  for (let at = 0; at < 10; at++) {
    const held = await f.hold(cookie, PNG(at + 1, 64));
    assert.equal(held.status, 200, `file ${at + 1}`);
    cookie = held.cookie;
  }
  assert.equal((await f.hold(cookie, PNG(99, 64))).status, 429);
  // Another visitor's count is their own, and 25 MB is the byte ceiling.
  let big: string | undefined;
  for (const size of [10 * MB, 10 * MB]) {
    const held = await f.hold(big, PNG(3, size));
    assert.equal(held.status, 200);
    big = held.cookie;
  }
  assert.equal((await f.hold(big, PNG(4, 6 * MB))).status, 429);
});

test('another visitor cannot take a staged file: nothing is written and the receipt never names it', async (t) => {
  const f = await fixture(t);
  const a = await f.hold(undefined, PNG(5));
  const b = await f.hold(undefined, PNG(6));
  assert.notEqual(a.cookie, b.cookie);
  const stolen = await f.submit(b.cookie, [a.body.id as string], 'public-submission-0004');
  assert.equal(stolen.status, 400);
  assert.ok(!stolen.text.includes(a.body.id as string));
  assert.equal(count(f.db, 'inbox_file'), 0);
  assert.equal(count(f.db, 'inbox'), 0);
  // With no cookie at all, nothing is taken either.
  assert.equal((await f.submit(undefined, [a.body.id as string], 'public-submission-0005')).status, 400);
  assert.equal(count(f.db, 'inbox_file'), 0);
  // The owner still can.
  assert.equal((await f.submit(a.cookie, [a.body.id as string], 'public-submission-0006')).status, 200);
  assert.equal(count(f.db, 'inbox_file'), 1);
});

test('a field the command does not declare is not held under row policy', async (t) => {
  const f = await fixture(t);
  const held = await f.hold(undefined, PNG(), 'a.png', { field: 'name' });
  assert.equal(held.status, 404);
});

test('a form saved on every step is not served under row policy at all, so it holds no files', async (t) => {
  // The policy refuses to start with one (the route's own `isSavedForm` refusal stays as the second wall).
  await assert.rejects(() => fixture(t, { saved: true }), /could not start under its row policy/);
});
