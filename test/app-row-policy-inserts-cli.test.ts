import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scratch } from './support/scratch.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appId = 'scoped-insert-cli';

function privateFree(value: unknown, path = ''): void {
  // FK constraint names are existing public relationship identifiers.
  if (path === 'foreignKeys.0.name' && value === 'physical_note_fk_0') return;
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!['sql', 'params', 'stack', 'cause', 'connection', 'principal'].includes(key), key);
      privateFree(child, path ? `${path}.${key}` : key);
    }
  } else assert.doesNotMatch(JSON.stringify(value) ?? '', /PRIVATE|physical_|ordinary fallback/);
}

async function fixture(t: TestContext) {
  const { directory, stopping } = scratch(t, 'tablewalk-scoped-insert-cli-');
  const app = join(directory, 'app');
  mkdirSync(app);
  const data = join(directory, 'business.db');
  const db = new DatabaseSync(data);
  const fallback = join(directory, 'ordinary-fallback');
  /* Stopped newest first, the directory last (support/scratch.ts): every child a
     case started, then the fallback check, then the handle. */
  stopping(() => db.close());
  stopping(() => {
    assert.equal(existsSync(fallback), false, 'CLI must never use ordinary read/write/transaction fallback');
  });
  db.exec(`CREATE TABLE physical_reviewer(id INTEGER PRIMARY KEY, desk INTEGER NOT NULL);
    INSERT INTO physical_reviewer VALUES (1,1),(2,2);
    CREATE TABLE physical_note(id INTEGER PRIMARY KEY, desk INTEGER NOT NULL DEFAULT 1,
      reviewer_id INTEGER DEFAULT 1 REFERENCES physical_reviewer(id),
      body TEXT NOT NULL DEFAULT 'Default note', status TEXT NOT NULL DEFAULT 'open');
    CREATE TABLE physical_limited(id INTEGER PRIMARY KEY, desk INTEGER NOT NULL DEFAULT 1,
      body TEXT NOT NULL DEFAULT 'Default body', secret TEXT DEFAULT 'PRIVATE stored value');
    INSERT INTO physical_note(id,body) VALUES (1,'Original note');`);
  const config = join(directory, 'mistri.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'ops', url: data, writable: true }] }));
  writeFileSync(
    join(app, 'app.json'),
    JSON.stringify({
      id: appId,
      name: 'Scoped insertion CLI',
      auth: {
        store: join(directory, 'auth.db'),
        signUp: 'open',
        defaultRole: 'user',
        rows: 'policy',
        roles: { user: { read: true, write: true } },
      },
      sources: { operations: { connection: 'ops' } },
      resources: {
        note: { physical: 'physical_note', access: 'write' },
        limited: { physical: 'physical_limited', access: 'write', fields: { read: ['id', 'desk', 'body'], write: ['body'] } },
        reviewer: { physical: 'physical_reviewer' },
      },
      views: { notes: { kind: 'list', from: 'note' }, limited: { kind: 'list', from: 'limited' } },
      home: 'notes',
      nav: ['notes', 'limited'],
    }),
  );
  const policy = join(directory, 'policy.mjs');
  writeFileSync(
    policy,
    `
    import { writeFileSync } from 'node:fs';
    import { SqliteAdapter } from ${JSON.stringify(pathToFileURL(join(root, 'packages/engine/src/adapters/sqlite.ts')).href)};
    for (const method of ['query', 'count', 'transaction', 'insert', 'update', 'remove', 'commandTransaction']) {
      SqliteAdapter.prototype[method] = async function () {
        writeFileSync(${JSON.stringify(fallback)}, method);
        throw new Error('PRIVATE ordinary fallback');
      };
    }
    const scope = { groups: [[{ column: 'desk', op: '=', value: 1 }]] };
    export default { appId: ${JSON.stringify(appId)}, resolveRows() {
      return { note: scope, limited: scope, reviewer: scope };
    } };
  `,
  );
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((done, reject) => reservation.close((error) => (error ? reject(error) : done())));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      join(root, 'packages/mistri/src/server/index.ts'),
      '--config',
      config,
      '--app',
      app,
      '--policy',
      policy,
      '--port',
      String(port),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        DATABASE_URL: '',
        MISTRI_OPEN: '0',
        MISTRI_PUBLIC_URL: origin,
        BETTER_AUTH_SECRET: 'scoped-insert-cli-fixture-secret-at-least-32-characters',
        MISTRI_AUTH_ADMIN_EMAIL: '',
        MISTRI_AUTH_ADMIN_PASSWORD: '',
        MISTRI_DIAGNOSTICS: '',
        XDG_CONFIG_HOME: join(directory, 'xdg'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => done({ code, signal }));
  });
  stopping(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      assert.deepEqual(await exited, { code: 0, signal: null }, output);
    } finally {
      clearTimeout(force);
    }
  });
  const deadline = Date.now() + 15_000;
  while (!output.includes('Listening on') && Date.now() < deadline) {
    assert.equal(child.exitCode, null, output);
    assert.equal(child.signalCode, null, output);
    await delay(40);
  }
  assert.match(output, /Listening on/, output);
  const call = async (path: string, body?: object, identity?: { cookie: string; account: string }) => {
    const response = await fetch(`${origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      signal: AbortSignal.timeout(8000),
      headers: {
        origin,
        'content-type': 'application/json',
        ...(identity ? { cookie: identity.cookie, 'x-mistri-account': identity.account } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body: await response.json(),
      headers: response.headers,
      cookie: response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; '),
    };
  };
  const signup = async (name: string) => {
    const reply = await call('/api/auth/sign-up/email', {
      name,
      email: `${name}@example.org`,
      password: 'fixture-password-123',
    });
    assert.equal(reply.status, 200, JSON.stringify(reply.body) + output);
    assert.match(reply.cookie, /mistri-[A-Za-z0-9_-]+\.session_token=/);
    assert.equal(typeof reply.body.user.id, 'string');
    return { cookie: reply.cookie, account: reply.body.user.id as string };
  };
  const identity = await signup('editor');
  const request = async (path: string, body?: object, actor = identity) => {
    const reply = await call(`/api/${path}?app=${appId}`, body, actor);
    assert.equal(reply.headers.get('cache-control'), 'no-store');
    privateFree(reply.body);
    return reply;
  };
  const row = (id: number) => db.prepare('SELECT * FROM physical_note WHERE id = ?').get(id);
  return { db, row, request, identity };
}

test('scoped insert CLI: real auth and defaulted creation, with no Undo', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const schema = await f.request('schema');
  assert.equal(schema.status, 200);
  for (const table of schema.body.tables) {
    assert.equal(table.insertable, ['note', 'limited'].includes(table.id));
    assert.equal(table.deletable, false);
  }
  const inserted = await f.request('insert', { table: 'note', values: {} });
  assert.equal(inserted.status, 200, JSON.stringify(inserted.body));
  assert.deepEqual(inserted.body.key, { id: 2 });
  assert.deepEqual(inserted.body.row, { id: 2, desk: 1, reviewer_id: 1, body: 'Default note', status: 'open' });
  assert.deepEqual({ ...f.row(2) }, inserted.body.row);
  assert.equal(inserted.body.undoId, undefined);
  assert.equal(inserted.headers.get('x-mistri-account'), f.identity.account);
  assert.equal((await f.request('delete', { table: 'note', key: { id: 2 }, confirm: true })).status, 403);
  // An App has no Undo: the revert route says so.
  const revert = await f.request('revert', { confirm: true, expectedId: 1 });
  assert.equal(revert.status, 404, JSON.stringify(revert.body));
  assert.ok(f.row(2));
  assert.equal(f.row(1)!.body, 'Original note');
});

test('scoped insert CLI: explicit values and stored row/FK-parent scope refuse without writes', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  for (const body of [{ table: 'note' }, { table: 'note', values: null }, { table: 'note', values: [] }]) {
    const reply = await f.request('insert', body);
    assert.equal(reply.status, 400, JSON.stringify(reply.body));
    assert.equal(reply.body.outcome, 'rejected');
  }
  for (const values of [{ desk: 2 }, { reviewer_id: 2 }]) {
    const reply = await f.request('insert', { table: 'note', values });
    assert.ok([400, 403].includes(reply.status), JSON.stringify(reply.body));
    assert.equal(reply.body.outcome, 'rejected');
    assert.equal(reply.body.undoId, undefined);
  }
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM physical_note').get()!.n, 1);
});

test('scoped insert CLI: a field-limited creation returns its projection after an update', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const updated = await f.request('update', { table: 'note', key: { id: 1 }, values: { body: 'Updated note' } });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.undoId, undefined);
  const inserted = await f.request('insert', { table: 'limited', values: { body: 'Permitted body' } });
  assert.equal(inserted.status, 200, JSON.stringify(inserted.body));
  assert.deepEqual(inserted.body.row, { id: 1, desk: 1, body: 'Permitted body' });
  assert.equal(inserted.body.undoId, undefined);
  assert.equal(f.row(1)!.body, 'Updated note');
  assert.equal(f.db.prepare('SELECT secret FROM physical_limited WHERE id=1').get()!.secret, 'PRIVATE stored value');
});
