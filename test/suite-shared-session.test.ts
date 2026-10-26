/** One native suite login, with independent App grants and coordinated logout. */
import { request as httpRequest } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Registry } from '../packages/engine/src/server/connections.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth, createSuiteAppAuth, captureAppAuthRuntime } from '../packages/mistri/src/server/auth/auth.js';
import { openSuiteGrantStore, provisionSuiteGrantStore } from '../packages/mistri/src/server/auth/suiteGrantStore.js';
import { createSuite } from '../packages/mistri/src/server/http/suite.js';
import { openSuiteApp } from '../packages/mistri/src/server/http/suiteApp.js';
import { signInOf } from '../packages/mistri/src/shared/app.js';

test('a shared suite account has only explicit App roles, revocation and one sign-out', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-suite-shared-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const grantsDb = new DatabaseSync(join(dir, 'grants.db'));
  t.after(() => grantsDb.close());
  provisionSuiteGrantStore(grantsDb, 'keystone');
  const grants = openSuiteGrantStore(grantsDb, 'keystone');
  const identityDir = join(dir, 'identity');
  mkdirSync(identityDir);
  writeFileSync(
    join(identityDir, 'app.json'),
    JSON.stringify({
      id: 'keystone',
      name: 'Keystone',
      resources: { unused: {} },
      auth: { store: join(dir, 'identity.db'), signUp: 'open', providers: ['email'], roles: { user: { read: true } } },
      views: { home: { kind: 'list', from: 'unused' } },
      home: 'home',
      nav: ['home'],
    }),
  );
  const publicURL = 'http://localhost:4111';
  const environment = { BETTER_AUTH_SECRET: 'test-only-suite-secret-longer-than-thirty-two-characters' };
  const native = await createAppAuth(await loadApp(identityDir), { baseURL: publicURL, trustedOrigins: [publicURL], environment });
  t.after(() => native.close());
  const bound = { host: '127.0.0.1', port: 0, allowedHosts: ['localhost:4111'] };
  const projections = new Map<string, ReturnType<typeof createSuiteAppAuth>>();
  const apps = [];
  for (const id of ['alpha', 'beta', 'gamma']) {
    const home = join(dir, id);
    mkdirSync(home);
    const file = join(home, 'business.db');
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE note(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO note VALUES(1, '${id}')`);
    db.close();
    writeFileSync(
      join(home, 'app.json'),
      JSON.stringify({
        id,
        name: id,
        sources: { data: { connection: 'data', default: true } },
        resources: { note: { access: 'write' } },
        auth: { signUp: 'open', providers: ['email'], roles: { reader: { read: true }, writer: { read: true, write: ['note'] } } },
        views: { notes: { kind: 'list', from: 'note' } },
        home: 'notes',
        nav: ['notes'],
      }),
    );
    const app = await loadApp(home);
    const registry = new Registry({ environment });
    registry.add({ name: 'data', url: file, writable: true, source: 'config' });
    apps.push({
      id,
      open: async (basePath: string) => {
        const suiteAuth = createSuiteAppAuth(native, {
          appId: id,
          spec: signInOf(app.app.auth)!,
          roles: ['reader', 'writer', 'admin'],
          basePath,
          suiteBase: '',
          grant: grants.read,
        });
        projections.set(id, suiteAuth);
        return openSuiteApp({ app, registry, basePath, publicURL, bound, environment, suiteAuth });
      },
    });
  }
  const suite = await createSuite(apps, { mounts: { alpha: '', beta: 'beta', gamma: 'gamma' } });
  t.after(() => suite.close());
  await new Promise<void>((resolve) => suite.server.listen(0, '127.0.0.1', resolve));
  bound.port = (suite.server.address() as { port: number }).port;
  const call = async (path: string, cookie = '', body?: unknown) => {
    const response = await publicCall(bound.port, publicURL, path, {
      method: body === undefined ? 'GET' : 'POST',
      cookie,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = response.text;
    return {
      status: response.status,
      text,
      body: JSON.parse(text),
      cookie: response.setCookies.map((value) => value.split(';')[0]).join('; '),
    };
  };
  const signed = await call('/beta/api/auth/sign-up/email', '', {
    name: 'Shared Reader',
    email: 'same@example.test',
    password: 'test-password-long-enough',
  });
  assert.equal(signed.status, 200, signed.text);
  const cookie = signed.cookie,
    subjectId = signed.body.user.id;
  assert.match(cookie, /mistri-keystone.session_token=/);
  for (const base of ['', '/beta', '/gamma']) assert.equal((await call(`${base}/api/schema`, cookie)).status, 401);
  const grant = (appId: string, roles: string[], expectedRevision = 0) =>
    grants.change({ subjectId, appId, roles, actorId: 'operator', expectedRevision, declaredRoles: ['reader', 'writer', 'admin'] });
  grant('alpha', ['writer']);
  grant('beta', ['reader']);
  for (const base of ['', '/beta']) {
    const who = await call(`${base}/api/whoami`, cookie);
    assert.equal(who.body.accountId, subjectId, who.text);
    assert.equal((await call(`${base}/api/schema`, cookie)).status, 200);
  }
  const update = { table: 'note', key: { id: 1 }, values: { body: 'edited' } };
  assert.equal((await call('/api/update', cookie, update)).status, 200);
  assert.equal((await call('/beta/api/update', cookie, update)).status, 403);
  assert.equal((await call('/gamma/api/schema', cookie)).status, 401);
  assert.equal(
    (await call('/beta/api/auth/admin/list-users', cookie)).status,
    404,
    'App grants never authorize native global administration',
  );
  // A genuine proof must expire when its App grant changes, even if that grant
  // is later restored to the same roles (revision fences prevent ABA).
  const request = { headers: { cookie } } as import('node:http').IncomingMessage;
  const binding = captureAppAuthRuntime(projections.get('beta')!);
  const proof = await binding.sessionInstance(request);
  assert.ok(proof);
  grant('beta', [], 1);
  assert.throws(() => binding.assertSessionCurrent(proof));
  assert.equal((await call('/beta/api/schema', cookie)).status, 401);
  assert.equal((await call('/api/schema', cookie)).status, 200);
  grant('beta', ['reader'], 2);
  assert.throws(() => binding.assertSessionCurrent(proof));
  assert.equal((await call('/beta/api/schema', cookie)).status, 200);
  assert.equal((await call('/beta/api/auth/sign-out', cookie, {})).status, 200);
  for (const base of ['', '/beta']) assert.equal((await call(`${base}/api/schema`, cookie)).status, 401);

  const again = await call('/api/auth/sign-in/email', '', { email: 'same@example.test', password: 'test-password-long-enough' });
  assert.equal(again.status, 200, again.text);
  const racingRequest = { headers: { cookie: again.cookie } } as import('node:http').IncomingMessage;
  await native.session(racingRequest); // Prime the native per-request identity cache.
  const control = new DatabaseSync(join(dir, 'identity.db'));
  let revoke = true;
  const racing = createSuiteAppAuth(native, {
    appId: 'alpha',
    spec: projections.get('alpha')!.spec,
    roles: ['writer'],
    basePath: '',
    suiteBase: '',
    grant: (id, app) => {
      if (revoke) {
        revoke = false;
        queueMicrotask(() => control.prepare('DELETE FROM session WHERE userId = ?').run(id));
      }
      return grants.read(id, app);
    },
  });
  try {
    await assert.rejects(
      racing.session(racingRequest),
      /could not be verified/,
      'native logout during cached display identity resolution still revokes the projected request',
    );
  } finally {
    racing.close();
    control.close();
  }

  let getterRan = false;
  assert.throws(() =>
    createSuiteAppAuth(native, {
      get appId() {
        getterRan = true;
        return 'alpha';
      },
      spec: projections.get('alpha')!.spec,
      roles: ['writer'],
      basePath: '',
      suiteBase: '',
      grant: grants.read,
    }),
  );
  assert.equal(getterRan, false);
  const misplacedRegistry = new Registry({ environment });
  misplacedRegistry.add({ name: 'data', url: join(dir, 'alpha', 'business.db'), source: 'config', writable: true });
  await assert.rejects(
    openSuiteApp({
      app: await loadApp(join(dir, 'alpha')),
      registry: misplacedRegistry,
      basePath: '',
      publicURL,
      bound,
      environment,
      suiteAuth: projections.get('beta'),
    }),
    /must belong to the mounted App/,
  );
  const aliasedRegistry = new Registry({ environment });
  aliasedRegistry.add({ name: 'data', url: join(dir, 'identity.db'), source: 'config', writable: true });
  await assert.rejects(
    openSuiteApp({
      app: await loadApp(join(dir, 'alpha')),
      registry: aliasedRegistry,
      basePath: '',
      publicURL,
      bound,
      environment,
      suiteAuth: projections.get('alpha'),
    }),
    /Authentication storage must remain separate/,
    'injected shared auth cannot bypass native store/business file separation',
  );
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
