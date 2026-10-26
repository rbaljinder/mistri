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
const appId = 'scoped-delete-cli';

function privateFree(value: unknown): void {
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!['sql', 'params', 'stack', 'cause', 'connection', 'principal'].includes(key), key);
      privateFree(child);
    }
  } else assert.doesNotMatch(JSON.stringify(value) ?? '', /PRIVATE|physical_|ordinary fallback/);
}

async function fixture(t: TestContext, withHook = true) {
  const { directory, stopping } = scratch(t, 'tablewalk-scoped-delete-cli-');
  const app = join(directory, 'app');
  mkdirSync(app);
  const data = join(directory, 'business.db');
  const db = new DatabaseSync(data);
  const fallback = join(directory, 'ordinary-fallback');
  const revoked = join(directory, 'revoked');
  const owner = join(directory, 'owner');
  /* Stopped newest first, the directory last (support/scratch.ts): every child a
     case started, then the fallback check, then the handle. */
  stopping(() => db.close());
  stopping(() => {
    assert.equal(existsSync(fallback), false, 'CLI must never use ordinary read/write/transaction fallback');
  });
  db.exec(`CREATE TABLE physical_note(id INTEGER PRIMARY KEY, owner_id TEXT NOT NULL,
      desk INTEGER NOT NULL DEFAULT 1, body TEXT NOT NULL DEFAULT 'Default note',
      status TEXT NOT NULL DEFAULT 'open', optional TEXT);
    INSERT INTO physical_note VALUES
      (1, 'pending', 1, 'Original note', 'open', NULL),
      (2, 'pending', 2, 'PRIVATE hidden note', 'open', ''),
      (3, 'pending', 1, 'Older note', 'open', NULL);`);
  const config = join(directory, 'mistri.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'ops', url: data, writable: true }] }));
  writeFileSync(
    join(app, 'app.json'),
    JSON.stringify({
      id: appId,
      name: 'Scoped deletion CLI',
      auth: {
        store: join(directory, 'auth.db'),
        signUp: 'open',
        defaultRole: 'user',
        rows: 'policy',
        roles: { user: { read: true, write: true } },
      },
      sources: { operations: { connection: 'ops' } },
      resources: { note: { physical: 'physical_note', access: 'write', delete: true } },
      views: { note: { kind: 'list', from: 'note' } },
      home: 'note',
      nav: ['note'],
    }),
  );
  const policy = join(directory, 'policy.mjs');
  writeFileSync(
    policy,
    `
    import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { SqliteAdapter } from ${JSON.stringify(pathToFileURL(join(root, 'packages/engine/src/adapters/sqlite.ts')).href)};
    for (const method of ['query', 'count', 'transaction', 'insert', 'update', 'remove', 'commandTransaction']) {
      SqliteAdapter.prototype[method] = async function () {
        writeFileSync(${JSON.stringify(fallback)}, method);
        throw new Error('PRIVATE ordinary fallback');
      };
    }
    export default { appId: ${JSON.stringify(appId)}, resolveRows(principal) {
      return { note: { groups: [[
        { column: 'desk', op: '=', value: 1 },
        { column: 'owner_id', op: '=', value: principal.id },
      ]] } };
    }${
      withHook
        ? `,
      authorizeDeletedRecord(principal, { table, key, row }) {
        return !existsSync(${JSON.stringify(revoked)}) && table === 'note'
          && principal.id === readFileSync(${JSON.stringify(owner)}, 'utf8')
          && row.owner_id === principal.id && row.id === key.id;
      }`
        : ''
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
        BETTER_AUTH_SECRET: 'scoped-delete-cli-fixture-secret-at-least-32-characters',
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
  writeFileSync(owner, identity.account);
  db.prepare('UPDATE physical_note SET owner_id = ?').run(identity.account);
  const request = async (path: string, body?: object, actor = identity) => {
    const reply = await call(`/api/${path}?app=${appId}`, body, actor);
    assert.equal(reply.headers.get('cache-control'), 'no-store');
    privateFree(reply.body);
    return reply;
  };
  const row = (id = 1) => {
    const stored = db.prepare('SELECT * FROM physical_note WHERE id = ?').get(id);
    return stored ? { ...stored } : undefined;
  };
  const erase = async () => {
    const reply = await request('delete', { table: 'note', key: { id: 1 }, confirm: true });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    // An App has no Undo: a deletion carries no token to take it back.
    assert.deepEqual(reply.body, { impact: [], deleted: true, affected: 1 });
    assert.equal(row(), undefined);
  };
  return { db, row, request, identity, erase };
}

test(
  'scoped delete CLI: real auth, a preview reserves nothing and confirmation deletes the current row',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const schema = await f.request('schema');
    assert.equal(schema.status, 200);
    assert.equal(schema.body.tables.find((table: { id: string }) => table.id === 'note').deletable, true);
    const initial = f.row();
    for (const confirmation of [{}, { confirm: false }]) {
      const preview = await f.request('delete', { table: 'note', key: { id: 1 }, ...confirmation });
      assert.equal(preview.status, 200, JSON.stringify(preview.body));
      assert.deepEqual(preview.body, { impact: [], deleted: false });
      assert.deepEqual(f.row(), initial);
    }
    // A preview is not a reservation: the row changed since is the row deleted.
    f.db.exec("UPDATE physical_note SET body = 'Changed after preview', status = 'reviewed', optional = '' WHERE id = 1");
    await f.erase();
    const revert = await f.request('revert', { confirm: true, expectedId: 1 });
    assert.equal(revert.status, 404, JSON.stringify(revert.body));
    assert.equal(f.row(), undefined);
  },
);

test('scoped delete CLI: the hook cannot bypass row scope', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const hidden = f.row(2);
  const refused = await f.request('delete', { table: 'note', key: { id: 2 }, confirm: true });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.deepEqual(f.row(2), hidden);
  await f.erase();
  assert.deepEqual(f.row(2), hidden);
});

test('scoped delete CLI: missing hook disables Delete while scoped creation remains available', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t, false);
  const schema = await f.request('schema');
  assert.equal(schema.status, 200);
  const table = schema.body.tables.find((item: { id: string }) => item.id === 'note');
  assert.equal(table.deletable, false);
  assert.equal(table.insertable, true);
  const initial = f.row();
  for (const confirmation of [{}, { confirm: false }, { confirm: true }]) {
    const reply = await f.request('delete', { table: 'note', key: { id: 1 }, ...confirmation });
    assert.equal(reply.status, 403, JSON.stringify(reply.body));
    assert.equal(reply.body.undoId, undefined);
  }
  assert.deepEqual(f.row(), initial);
  const inserted = await f.request('insert', { table: 'note', values: { id: 4, owner_id: f.identity.account } });
  assert.equal(inserted.status, 200, JSON.stringify(inserted.body));
  assert.equal(inserted.body.undoId, undefined);
  assert.ok(f.row(4));
  assert.deepEqual(f.row(), initial);
});
