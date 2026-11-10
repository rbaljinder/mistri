/**
 * A public form's file holds on an ordinary App, over HTTP (formRoutes.ts `publicFileHold`, stagedFileHttp.ts): the
 * bytes one address may send in a day, counted before the share every visitor holds; the App's human check asked as
 * the submission asks it; and an unclaimed file kept an hour, not the day a signed-in person's is.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { COMMAND_STAGED_TABLE } from '../packages/mistri/src/adapters/commands/commandStaging.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { defineChallenges } from '../packages/mistri/src/server/commands/challenges.js';
import { field } from '../packages/mistri/src/server/commands/commandFields.js';
import { literal, shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { PUBLIC_STAGED_FILE_TTL_MS } from '../packages/mistri/src/server/commands/stagedFiles.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { PUBLIC_FILE_BYTE_WINDOWS, resetPublicFormLimits } from '../packages/engine/src/server/http/rateLimit.js';
import { parseTrustedProxies } from '../packages/engine/src/server/http/trust.js';
import { createApp } from './support/createApp.js';
import { parseTestApp } from './support/commandCatalog.js';

const MB = 1024 * 1024;
const PNG = (fill = 1, size = 32) => {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
};
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

async function fixture(t: TestContext, options: { challenge?: boolean } = {}) {
  resetPublicFormLimits();
  const directory = mkdtempSync(join(tmpdir(), 'mistri-public-holds-'));
  const file = join(directory, 'repairs.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE repair (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE repair_photo (id INTEGER PRIMARY KEY, repair_id INTEGER NOT NULL REFERENCES repair(id), file_name TEXT NOT NULL,
      content_type TEXT, byte_size INTEGER, data BLOB);`);
  migrateSqliteCommandJournal(file);
  const registry = new Registry();
  registry.add({ id: 'repairs-db', name: 'Repairs', url: file, writable: true, source: 'config' });
  const input = { title: field.text(), photos: field.files('repair_photo', { max: 12, accept: 'image/*' }) };
  const raw = {
    id: 'repairs',
    name: 'Repairs',
    sources: { main: { connection: 'repairs-db', default: true } },
    resources: {
      repair: { access: 'write' },
      repair_photo: {
        access: 'write',
        file: { content: 'data', name: 'file_name', type: 'content_type', size: 'byte_size', maxBytes: 20 * MB },
      },
    },
    auth: { roles: { tech: { read: true } }, ...(options.challenge ? { challenge: 'verifyHuman' } : {}) },
    views: {
      repairs: { kind: 'list', from: 'repair' },
      report: { kind: 'form', label: 'Report', public: true, done: { title: 'Thanks' }, command: { id: 'report', version: 1, input } },
    },
    home: 'repairs',
  };
  const app = parseTestApp(raw, 'public file holds fixture');
  const commands = defineCommands({
    report: defineCommand({
      source: 'main',
      target: 'repair',
      targets: 'none',
      write: ['repair', 'repair_photo'],
      public: true,
      input,
      output: shape({ reference: text(), message: literal('Received.') }),
      async handle({ db }, value) {
        const repair = await db.repair.insert({ title: value.title });
        for (const photo of value.photos) await db.repair_photo.insertFile(photo, { repair_id: repair.id as number });
        return { reference: `REPAIR-${repair.id as number}`, message: 'Received.' };
      },
    }),
  });
  const host: AppHost = {
    app: {
      app,
      path: join(directory, 'app.ts'),
      pages: [],
      sources: {},
      ...(options.challenge
        ? { challenges: defineChallenges({ verifyHuman: { verify: async (token: string) => token === 'person' } }) }
        : {}),
    },
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
  const bound = { host: '127.0.0.1', port: 0, trustedProxies: parseTrustedProxies([]).ranges };
  const server = createApp({ registry, bound, apps: [host], commands: { appId: 'repairs', registry: commands } });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
    resetPublicFormLimits();
  });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://${bound.host}:${address.port}`;
  /** Holds a file from `from` (the loopback peer forwards for it) as the visitor holding `cookie`. */
  const hold = async (from: string, cookie: string | undefined, bytes: Uint8Array, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}/api/forms/report/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': from, ...(cookie ? { cookie } : {}), ...headers },
      body: JSON.stringify({ field: 'photos', file: { name: 'a.png', type: 'image/png', data: base64(bytes) } }),
      signal: AbortSignal.timeout(20000),
    });
    const setCookie = response.headers.get('set-cookie');
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
      cookie: setCookie?.split(';')[0] ?? cookie,
      setCookie,
    };
  };
  const held = () => (db.prepare(`SELECT count(*) AS n FROM "${COMMAND_STAGED_TABLE}"`).get() as { n: number }).n;
  return { hold, held, db };
}

test('one address sends at most its day of bytes, however many cookies it throws away; another address is not refused for it', async (t) => {
  const f = await fixture(t);
  const day = PUBLIC_FILE_BYTE_WINDOWS[0]!.limit;
  const each = 10 * MB;
  // A fresh cookie every time: the per-visitor share never fills, so only the address's own count can stop it.
  for (let at = 0; at < day / each; at++)
    assert.equal((await f.hold('203.0.113.7', undefined, PNG(at + 1, each))).status, 200, `file ${at + 1}`);
  const refused = await f.hold('203.0.113.7', undefined, PNG(9, each));
  assert.equal(refused.status, 429);
  assert.equal(refused.body.code, 'too_many_files');
  assert.equal(f.held(), day / each);
  const first = await f.hold('203.0.113.8', undefined, PNG(1));
  assert.equal(first.status, 200);
  assert.equal((await f.hold('203.0.113.8', first.cookie, PNG(2))).status, 200);
});

test("the App's human check is asked of a file hold as of the submission: no answer, no file held", async (t) => {
  const f = await fixture(t, { challenge: true });
  for (const headers of [{}, { 'x-mistri-challenge': 'robot' }] as Record<string, string>[]) {
    const refused = await f.hold('203.0.113.9', undefined, PNG(), headers);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'challenge_failed');
  }
  assert.equal(f.held(), 0);
  assert.equal((await f.hold('203.0.113.9', undefined, PNG(), { 'x-mistri-challenge': 'person' })).status, 200);
  assert.equal(f.held(), 1);
});

test('an unclaimed public file is kept an hour, and the cookie that names it no longer', async (t) => {
  const f = await fixture(t);
  const before = Date.now();
  const held = await f.hold('203.0.113.10', undefined, PNG());
  assert.equal(held.status, 200, JSON.stringify(held.body));
  assert.equal(PUBLIC_STAGED_FILE_TTL_MS, 60 * 60 * 1000);
  assert.match(held.setCookie ?? '', /Max-Age=3600(;|$)/);
  const { expires_at } = f.db.prepare(`SELECT expires_at FROM "${COMMAND_STAGED_TABLE}"`).get() as { expires_at: number };
  assert.ok(expires_at >= before + PUBLIC_STAGED_FILE_TTL_MS && expires_at <= Date.now() + PUBLIC_STAGED_FILE_TTL_MS, String(expires_at));
});
