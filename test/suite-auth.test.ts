/** Two real Better Auth stores and two data registries on one listener. */
import { request as httpRequest } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Registry } from '../packages/engine/src/server/connections.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { createSuite } from '../packages/mistri/src/server/http/suite.js';
import { openSuiteApp } from '../packages/mistri/src/server/http/suiteApp.js';

test('suite refuses SQLite auth stores aliased to any captured business file or sidecar before migrating', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-suite-auth-fence-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const business = join(directory, 'business.db');
  const db = new DatabaseSync(business);
  db.exec("CREATE TABLE note(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO note VALUES(1, 'intact');");
  db.close();
  const appDir = join(directory, 'app');
  mkdirSync(appDir);
  const appFile = join(appDir, 'app.json');
  const bound = { host: '127.0.0.1', port: 4111, allowedHosts: [] };
  const aliases = [
    business,
    join(directory, 'alias.db'),
    join(directory, 'hardlink.db'),
    `${business}-wal`,
    `${business}-shm`,
    `${business}-journal`,
  ];
  symlinkSync(business, aliases[1]);
  linkSync(business, aliases[2]);
  for (const [index, store] of aliases.entries()) {
    writeFileSync(
      appFile,
      JSON.stringify({
        name: 'Fence',
        sources: { data: { connection: 'data', default: true } },
        resources: { note: {} },
        auth: { providers: ['email'], signUp: 'open', store, roles: { user: { read: true } } },
        views: { notes: { kind: 'list', from: 'note' } },
        home: 'notes',
        nav: ['notes'],
      }),
    );
    const environment = { SUITE_DATA: business, BETTER_AUTH_SECRET: 'separate-private-secret-longer-than-thirty-two-characters' };
    const registry = new Registry({ environment });
    registry.add({ id: 'other', name: 'other', url: join(directory, 'other.db'), source: 'config' });
    // The first business connection also exists; the dangerous file is second.
    const other = new DatabaseSync(join(directory, 'other.db'));
    other.close();
    registry.add({ id: 'data', name: 'data', url: index % 2 ? 'sqlite:${SUITE_DATA}' : '${SUITE_DATA}', source: 'config' });
    environment.SUITE_DATA = '/do-not-use-mutated-environment.db';
    await assert.rejects(
      openSuiteApp({ app: await loadApp(appDir), registry, basePath: '', publicURL: 'http://localhost:4111', environment, bound }),
      /Authentication storage must remain separate/,
    );
    const check = new DatabaseSync(business, { readOnly: true });
    try {
      assert.equal(check.prepare('SELECT body FROM note WHERE id=1').get()?.body, 'intact');
      assert.equal(check.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='user'").get()?.n, 0);
    } finally {
      check.close();
    }
  }
});

test('suite Apps isolate real accounts, cookies, data and logout with explicit deployment environments', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-suite-auth-'));
  const processSecret = process.env.BETTER_AUTH_SECRET;
  const definitions = [];
  for (const id of ['lender', 'dealer']) {
    const dir = join(directory, id);
    mkdirSync(dir);
    const file = join(dir, 'business.db');
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE note(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO note VALUES(1, '${id}'), (2, 'private');`);
    db.close();
    writeFileSync(
      join(dir, 'app.json'),
      JSON.stringify({
        name: id,
        sources: { data: { connection: 'data', default: true } },
        resources: { note: { access: 'write' } },
        auth: {
          ...(id === 'dealer' ? { rows: 'policy' } : {}),
          providers: ['email'],
          signUp: 'open',
          store: join(dir, 'auth.db'),
          roles: { user: { read: true, write: ['note'] } },
        },
        views: { notes: { kind: 'list', from: 'note' } },
        home: 'notes',
        nav: ['notes'],
      }),
    );
    const policyFile = id === 'dealer' ? join(dir, 'policy.mjs') : undefined;
    if (policyFile)
      writeFileSync(
        policyFile,
        `export default { appId: 'dealer', resolveRows() {
      return { note: { groups: [[{ column: 'id', op: '=', value: 1 }]] } };
    } };`,
      );
    const environment = { SUITE_DATA: file, BETTER_AUTH_SECRET: `${id}-a-separate-private-secret-longer-than-thirty-two-characters` };
    const registry = new Registry({ environment });
    registry.add({ id: 'data', name: 'data', url: '${SUITE_DATA}', source: 'config', writable: true });
    environment.SUITE_DATA = '/should-not-be-read-after-registry-capture';
    registry.setActive('data');
    definitions.push({ id, app: await loadApp(dir), registry, file, policyFile, environment });
  }
  // Authentication URLs use a stable public origin; the actual local socket
  // may still be ephemeral, behind a proxy that keeps the public Host.
  const publicURL = 'http://localhost:4111';
  const bound = { host: '127.0.0.1', port: 0, allowedHosts: ['localhost:4111'] };
  const suite = await createSuite(
    definitions.map((definition) => ({
      id: definition.id,
      open: (basePath) => openSuiteApp({ ...definition, basePath, publicURL, bound }),
    })),
    { mounts: { lender: '', dealer: 'dealer' } },
  );
  t.after(async () => {
    await suite.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => suite.server.listen(0, '127.0.0.1', resolve));
  bound.port = (suite.server.address() as { port: number }).port;
  const call = async (path: string, cookie = '', body?: object) => {
    const res = await publicCall(bound.port, publicURL, path, {
      method: body ? 'POST' : 'GET',
      cookie,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = res.text;
    return {
      status: res.status,
      text,
      json: JSON.parse(text),
      cookies: res.setCookies,
      cookie: res.setCookies.map((value) => value.split(';')[0]).join('; '),
    };
  };
  const signup = { name: 'Suite Reader', email: 'reader@example.test', password: 'a-password-for-test-only' };
  const lender = await call('/api/auth/sign-up/email', '', signup);
  assert.equal(lender.status, 200, lender.text);
  assert.ok(lender.cookies.some((value) => value.includes('mistri-lender.session_token=') && value.includes('Path=/')));
  assert.equal((await call('/dealer/api/schema', lender.cookie)).status, 401, 'root cookie does not sign in to the child');
  assert.equal((await call('/dealer/api/auth/sign-in/email', '', signup)).status, 401, 'account was not created in the child store');
  const dealer = await call('/dealer/api/auth/sign-up/email', '', signup);
  assert.equal(dealer.status, 200, dealer.text);
  assert.ok(dealer.cookies.some((value) => value.includes('mistri-dealer.session_token=') && value.includes('Path=/dealer')));
  assert.equal(
    (await call('/dealer/api/schema', lender.cookie)).status,
    401,
    'a root session does not borrow the matching-email child account after that account exists',
  );
  assert.equal((await call('/api/schema', dealer.cookie)).status, 401, 'a child session does not borrow the matching-email root account');
  assert.equal(
    (await call('/dealer/api/update', lender.cookie, { table: 'note', key: { id: 1 }, values: { body: 'borrowed-child-write' } })).status,
    401,
    "a root session cannot borrow the matching-email child account's write grant",
  );
  const both = `${lender.cookie}; ${dealer.cookie}`;
  for (const [base, id] of [
    ['', 'lender'],
    ['/dealer', 'dealer'],
  ]) {
    const who = await call(`${base}/api/whoami`, both);
    assert.equal(who.json.appId, id);
    assert.equal(who.json.who, signup.email);
    const updated = await call(`${base}/api/update`, both, { table: 'note', key: { id: 1 }, values: { body: `${id}-updated` } });
    assert.equal(updated.status, 200, updated.text);
  }
  const refused = await call('/dealer/api/update', both, { table: 'note', key: { id: 2 }, values: { body: 'not allowed' } });
  assert.notEqual(refused.status, 200, 'the sub-App retains its row policy behind the suite listener');
  for (const definition of definitions) {
    const db = new DatabaseSync(definition.file, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT body FROM note WHERE id=1').get()?.body, `${definition.id}-updated`);
      assert.equal(db.prepare('SELECT body FROM note WHERE id=2').get()?.body, 'private');
    } finally {
      db.close();
    }
  }
  assert.equal((await call('/dealer/api/auth/sign-out', both, {})).status, 200);
  assert.equal((await call('/dealer/api/schema', both)).status, 401);
  assert.equal((await call('/api/schema', both)).status, 200, 'child logout does not end the parent session');
  assert.equal(process.env.BETTER_AUTH_SECRET, processSecret, 'startup never changes process credentials');
});

/* The browser is at the public origin, behind a proxy that keeps its Host (--allowed-host), while the socket
   is ephemeral: fetch cannot name a Host, so the request is made with one. Its Origin is its Host, as a page's is. */
function publicCall(port: number, publicURL: string, path: string, init: { method: string; cookie: string; body?: string }) {
  const host = new URL(publicURL).host;
  return new Promise<{ status: number; text: string; setCookies: string[] }>((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: init.method,
        headers: { host, origin: publicURL, cookie: init.cookie, 'content-type': 'application/json' },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text, setCookies: [res.headers['set-cookie'] ?? []].flat() }));
      },
    );
    req.on('error', reject);
    req.end(init.body);
  });
}
