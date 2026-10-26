/**
 * Over the real command line: a `--jobs` module of inbound endpoints alone
 * serves `POST /api/inbound/{name}` before any sign-in, `mistri check` prints
 * its line and warns of a secret nobody set, serving refuses it, and a
 * server whose store is behind its layout names the command that brings it
 * forward (storesCli.ts, `mistri migrate stores up`).
 */
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { provisionSqliteIntegrations } from '../packages/mistri/src/adapters/integrations/integrationStore.js';
import { storesUpCommand } from '../packages/mistri/src/server/stores/storesCli.js';
import { VALIDATE, validating } from './support/validation.js';

const ROOT = resolve('.');
/* An App's starts are mistri's (test/support/bins.ts). */
const ENTRY = join(ROOT, 'packages', 'mistri', 'src', 'server', 'index.ts');
const src = (path: string) => JSON.stringify(pathToFileURL(join(ROOT, path)).href);
const SECRET = 'cli-inbound-secret-value';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

interface Ran {
  code: number;
  out: string;
  err: string;
}
const run = (args: string[], env: Record<string, string>): Promise<Ran> =>
  new Promise((done) => {
    const child = validating(args, { ...process.env, MISTRI_OPEN: '0', ...env });
    execFile(
      process.execPath,
      ['--import', 'tsx', ENTRY, ...child.args],
      { cwd: ROOT, timeout: 120_000, env: child.env },
      (error, out, err) => done({ code: (error as { code?: number } | null)?.code ?? 0, out, err }),
    );
  });

function desk(directory: string) {
  const db = join(directory, 'desk.db');
  const raw = new DatabaseSync(db);
  raw.exec(`CREATE TABLE item (id INTEGER PRIMARY KEY, status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);
    INSERT INTO item VALUES (1, 'open', 0);`);
  raw.close();
  // An inbound endpoint remembers its deliveries in the integrations store while their window is open: provisioned, never made by a start.
  provisionSqliteIntegrations(db);
  migrateSqliteCommandJournal(db);
  const dir = join(directory, 'desk');
  mkdirSync(dir);
  writeFileSync(
    join(dir, 'app.json'),
    JSON.stringify({
      id: 'desk',
      name: 'Desk',
      sources: { desk: { connection: 'desk', default: true } },
      resources: { item: { access: 'write' } },
      auth: {
        providers: ['email'],
        store: join(directory, 'auth.db'),
        roles: { integration: { read: true, service: true, commands: ['close'] } },
      },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
    }),
  );
  writeFileSync(
    join(dir, 'commands.mjs'),
    `import { defineCommand, defineCommands, field } from ${src('packages/mistri/src/server/commands.ts')};
export default defineCommands({ close: defineCommand({ source: 'desk', target: 'item', input: { note: field.text({ max: 40 }) },
  async handle({ db, record }) { await db.item.update(record, { status: 'closed' }); } }) });
`,
  );
  writeFileSync(
    join(dir, 'jobs.mjs'),
    `import { defineInbound, defineJobs, hmac } from ${src('packages/mistri/src/server/jobs.ts')};
export default defineJobs({}, { principals: { provider: { roles: ['integration'] } }, inbound: { closed: defineInbound({
  verify: hmac({ secret: 'DESK_CALLBACK_SECRET', signature: { header: 'x-signature' }, timestamp: { header: 'x-timestamp', window: '5 minutes' } }),
  runAs: 'provider', command: 'close', key: body => body.id, input: body => ({ note: body.note }), target: body => ({ id: body.item }) }) } });
`,
  );
  const config = join(directory, 'mistri.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'desk', url: db, writable: true }] }));
  const env = { XDG_CONFIG_HOME: join(directory, 'config'), BETTER_AUTH_SECRET: 'synthetic-inbound-secret-at-least-thirty-two-characters' };
  const args = [
    '--config',
    config,
    '--app',
    dir,
    '--commands',
    join(dir, 'commands.mjs'),
    '--jobs',
    join(dir, 'jobs.mjs'),
    '--host',
    '127.0.0.1',
  ];
  return { db, dir, config, env, args };
}

test(
  'a module of endpoints alone serves a signed delivery over the real CLI, and refuses to start without its secret',
  { timeout: 300_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-inbound-'));
    const children: ChildProcess[] = [];
    t.after(async () => {
      for (const child of children)
        if (child.exitCode === null) {
          const closed = once(child, 'close');
          child.kill('SIGTERM');
          await closed;
        }
      rmSync(directory, { recursive: true, force: true });
    });
    const { db, env, args } = desk(directory);

    // mistri check: the endpoint's line, and a warning rather than a refusal for a secret nobody set.
    const checked = await run([...args, VALIDATE], env);
    assert.match(
      checked.out,
      /inbound: closed POST \/api\/inbound\/closed \(hmac sha256, ±300s, secret DESK_CALLBACK_SECRET\) → close@1 as provider/,
    );
    assert.match(
      checked.out,
      /warning: inbound endpoint "closed" verifies with the secret in DESK_CALLBACK_SECRET, and that environment variable is not set/,
    );
    // Serving does not start on it.
    const refused = await run([...args, '--port', String(await freePort())], env);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /Jobs startup error: inbound endpoint "closed" verifies with the secret in DESK_CALLBACK_SECRET/);

    const port = await freePort();
    const child = spawn(process.execPath, ['--import', 'tsx', ENTRY, ...args, '--port', String(port)], {
      cwd: ROOT,
      env: { ...process.env, MISTRI_OPEN: '0', ...env, DESK_CALLBACK_SECRET: SECRET },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let log = '';
    child.stdout!.on('data', (chunk) => {
      log += String(chunk);
    });
    child.stderr!.on('data', (chunk) => {
      log += String(chunk);
    });
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => reject(new Error(`did not start: ${log}`)), 180_000);
      child.stdout!.on('data', () => {
        if (log.includes('Listening on')) {
          clearTimeout(timer);
          done();
        }
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error(`exited: ${log}`));
      });
    });
    const signedAt = Math.floor(Date.now() / 1000);
    const deliver = (payload: object, secret = SECRET, at = signedAt) => {
      const body = JSON.stringify(payload),
        timestamp = String(at);
      return fetch(`http://127.0.0.1:${port}/api/inbound/closed`, {
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/json',
          'x-timestamp': timestamp,
          'x-signature': createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex'),
        },
      });
    };
    // Nobody is signed in: the signature is the credential.
    assert.equal((await deliver({ id: 'a-1', item: 1, note: 'done' }, 'wrong')).status, 401);
    assert.equal((await deliver({ id: 'a-1', item: 1, note: 'done' })).status, 204);
    assert.equal((await deliver({ id: 'a-1', item: 1, note: 'done' })).status, 204, 'the same delivery again replays its receipt');
    assert.equal((await deliver({ id: 'a-1', item: 1, note: 'done' }, SECRET, signedAt + 1)).status, 204, 'a retry, signed anew, replays');
    assert.equal((await deliver({ id: 'a-1', item: 1, note: 'other' }, SECRET, signedAt + 2)).status, 409);
    const check = new DatabaseSync(db, { readOnly: true });
    t.after(() => check.close());
    check.exec('PRAGMA busy_timeout = 5000');
    assert.deepEqual({ ...check.prepare('SELECT status, version FROM item WHERE id = 1').get() }, { status: 'closed', version: 1 });
  },
);

test('the command that brings stores forward spells its arguments and never a password', () => {
  assert.equal(storesUpCommand({ suite: 'my suite.json' }), "mistri migrate stores up --suite 'my suite.json'");
  assert.equal(
    storesUpCommand({ target: 'postgres://app:hunter2@db.example/shop' }),
    'mistri migrate stores up postgres://app@db.example/shop',
  );
  assert.equal(storesUpCommand({ target: 'shop.db' }), 'mistri migrate stores up shop.db');
});
