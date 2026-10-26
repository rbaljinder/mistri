import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth, type AppAuthRuntime } from '../packages/mistri/src/server/auth/auth.js';
import { openSuiteGrantStore, provisionSuiteGrantStore } from '../packages/mistri/src/server/auth/suiteGrantStore.js';
import { suiteRootDestination } from '../packages/mistri/src/server/auth/suiteRootEntry.js';

function app(fields: Record<string, unknown> = {}): LoadedApp {
  return {
    path: 'test-root-entry',
    pages: [],
    sources: {},
    app: parseAppConfig(
      {
        id: 'lender',
        name: 'Lender',
        resources: { note: {} },
        auth: { providers: ['email'], signUp: 'open', roles: { reader: { read: true } } },
        views: { notes: { kind: 'list', from: 'note' } },
        home: 'notes',
        ...fields,
      },
      'root-entry test',
    ),
  };
}

const request = (url = '/', cookie = '', method = 'GET') =>
  ({
    url,
    method,
    headers: { cookie, host: 'untrusted.example', 'x-forwarded-host': 'also-untrusted.example' },
  }) as unknown as IncomingMessage;

async function fixture(t: TestContext, basePath = '') {
  const directory = mkdtempSync(join(tmpdir(), 'tw-suite-root-'));
  const db = new DatabaseSync(join(directory, 'grants.db'));
  provisionSuiteGrantStore(db, 'shared');
  const grants = openSuiteGrantStore(db, 'shared');
  let native: AppAuthRuntime | undefined, control: DatabaseSync | undefined;
  const server = createServer((req, res) => {
    void native!.handler(req, res).catch(() => res.destroy());
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    native?.close();
    control?.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const store = join(directory, 'identity.db');
  native = await createAppAuth(
    app({
      id: 'shared',
      name: 'Suite',
      auth: {
        store,
        providers: ['email'],
        signUp: 'open',
        roles: { user: { read: true } },
      },
    }),
    {
      baseURL: `${origin}${basePath}`,
      trustedOrigins: [origin],
      environment: { BETTER_AUTH_SECRET: 'test-suite-root-entry-secret-longer-than-thirty-two-characters' },
    },
  );
  control = new DatabaseSync(store);
  const call = async (path: string, body: unknown, cookie = '') => {
    const response = await fetch(`${origin}${basePath}/api/auth/${path}`, {
      method: 'POST',
      headers: { origin, cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return {
      body: value,
      cookie: response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; '),
    };
  };
  const signed = await call('sign-up/email', { name: 'Owner', email: 'owner@example.test', password: 'test-password-long-enough' });
  const subjectId = signed.body.user.id as string;
  const grant = (appId: string, roles: string[], declaredRoles = ['reader', 'user', 'admin']) =>
    grants.change({
      subjectId,
      appId,
      roles,
      declaredRoles,
      actorId: 'operator',
      expectedRevision: grants.read(subjectId, appId).revision,
    });
  return {
    native,
    grants,
    db,
    control,
    subjectId,
    cookie: signed.cookie,
    grant,
    call,
    options: { native, grants, rootApp: app(), basePath },
  };
}

test('protected suite root chooses Apps for signed-out and child-only accounts; explicit root grants and revocation are current', async (t) => {
  const f = await fixture(t);
  assert.equal(await suiteRootDestination(request(), f.options), '/_mistri/apps?entry=1');
  assert.equal(
    await suiteRootDestination(request('/', f.cookie), f.options),
    '/_mistri/apps',
    'native default role is not a root App grant',
  );
  f.grant('dealer', ['admin']);
  assert.equal(
    await suiteRootDestination(request('/', f.cookie), f.options),
    '/_mistri/apps',
    'owner of a child need not have Lender access',
  );
  f.grant('lender', ['reader']);
  const before = f.db.prepare('SELECT * FROM suite_grant_audit ORDER BY rowid').all();
  for (const method of ['GET', 'HEAD']) {
    assert.equal(await suiteRootDestination(request('/', f.cookie, method), f.options), undefined);
  }
  assert.deepEqual(f.db.prepare('SELECT * FROM suite_grant_audit ORDER BY rowid').all(), before, 'selection never changes grants');
  f.grant('lender', []);
  assert.equal(await suiteRootDestination(request('/', f.cookie), f.options), '/_mistri/apps');
  f.grant('lender', ['reader', 'retired'], ['reader', 'retired']);
  assert.equal(
    await suiteRootDestination(request('/', f.cookie), f.options),
    '/_mistri/apps',
    'no narrowing a partly invalid current grant',
  );
  f.grant('lender', ['admin']);
  assert.equal(await suiteRootDestination(request('/', f.cookie), f.options), undefined, 'explicit root administration is assignable');
  const cached = request('/', f.cookie);
  await f.native.session(cached);
  await f.call('sign-out', {}, f.cookie);
  assert.equal(
    await suiteRootDestination(cached, f.options),
    '/_mistri/apps?entry=1',
    'logout retires even a previously cached display identity',
  );
});

test('a foreign native account with the same email cannot select the authorized root App', async (t) => {
  const local = await fixture(t),
    foreign = await fixture(t);
  assert.notEqual(local.subjectId, foreign.subjectId);
  local.grant('lender', ['reader']);
  foreign.grant('lender', ['reader']);
  assert.equal(await suiteRootDestination(request('/', local.cookie), local.options), undefined);
  assert.equal(await suiteRootDestination(request('/', foreign.cookie), local.options), '/_mistri/apps?entry=1');
});

test('base-path roots use only the local chooser, preserving non-root methods and deep links', async (t) => {
  const f = await fixture(t, '/tools/team');
  for (const path of ['/tools/team', '/tools/team/', '/tools/team?returnTo=https://evil.test', '/tools/team/?returnTo=//evil.test']) {
    for (const method of ['GET', 'HEAD']) {
      assert.equal(await suiteRootDestination(request(path, '', method), f.options), '/tools/team/_mistri/apps?entry=1');
      assert.equal(await suiteRootDestination(request(path, f.cookie, method), f.options), '/tools/team/_mistri/apps');
    }
  }
  f.grant('lender', ['reader']);
  assert.equal(await suiteRootDestination(request('/tools/team/', f.cookie), f.options), undefined);
  // Closing the native owner proves these paths do not even consult it.
  f.native.close();
  for (const path of [
    '/',
    '/tools',
    '/tools/team/notes',
    '/tools/team/api/schema',
    '/tools/team/api/auth/sign-in/email',
    '/tools/team/_mistri/apps',
    '/tools/team/dealer/',
    '/tools/team//',
    '/tools/team/notes/..',
    '/tools/%74eam',
    'https://evil.test/tools/team',
    '//evil.test/tools/team',
  ]) {
    assert.equal(await suiteRootDestination(request(path), f.options), undefined, path);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    assert.equal(await suiteRootDestination(request('/tools/team/', '', method), f.options), undefined);
  }
});

test('one exact root-App selector overrides preferences only with a current root grant', async (t) => {
  const f = await fixture(t, '/tools/team');
  f.grant('lender', ['reader']);
  f.grant('dealer', ['reader']);
  const options = {
    ...f.options,
    preferences: { read: () => ({ defaultApp: 'dealer', revision: 1 }) },
    deployments: [
      { app: app(), href: '/tools/team/?app=lender' },
      { app: app({ id: 'dealer' }), href: '/tools/team/dealer/' },
    ],
  };
  assert.equal(await suiteRootDestination(request('/tools/team/', f.cookie), options), '/tools/team/dealer/');
  assert.equal(await suiteRootDestination(request('/tools/team/?app=lender', f.cookie), options), undefined);
  assert.equal(await suiteRootDestination(request('/tools/team/?app=lender'), options), '/tools/team/_mistri/apps?entry=1&app=lender');
  assert.equal(
    await suiteRootDestination(request('/tools/team/?app=lender&returnTo=https://foreign.test'), options),
    '/tools/team/_mistri/apps?entry=1&app=lender',
  );
  for (const suffix of [
    'app=dealer',
    'app=',
    'app=lender&app=lender',
    'app=lender&app=dealer',
    '%61pp=lender&app=lender',
    'app=https://foreign.test',
  ]) {
    for (const cookie of ['', f.cookie])
      assert.equal(await suiteRootDestination(request(`/tools/team/?${suffix}`, cookie), options), '/tools/team/_mistri/apps');
  }
  assert.equal(
    await suiteRootDestination(request('/tools/team/notes?app=dealer', f.cookie), options),
    undefined,
    'deep-link dispatch stays with the App',
  );
  f.grant('lender', []);
  assert.equal(await suiteRootDestination(request('/tools/team/?app=lender', f.cookie), options), '/tools/team/_mistri/apps');
  assert.equal(await suiteRootDestination(request('/tools/team/', f.cookie), options), '/tools/team/dealer/');
});

test('missing root routes to chooser while unauthenticated and public roots retain their own entry without session lookup', async (t) => {
  const f = await fixture(t);
  f.native.close();
  assert.equal(await suiteRootDestination(request(), { ...f.options, rootApp: undefined }), '/_mistri/apps');
  const publicRoots = [
    app({ auth: undefined }),
    app({ auth: { providers: ['email'], roles: { reader: { read: true } }, public: { read: ['note'] } } }),
    app({
      views: {
        notes: { kind: 'list', from: 'note' },
        welcome: { kind: 'landing', hero: { heading: 'Welcome', actions: [{ label: 'Sign in', signIn: true }] } },
      },
      home: [{ view: 'welcome', signedOut: true }, { view: 'notes' }],
    }),
  ];
  for (const rootApp of publicRoots) {
    for (const method of ['GET', 'HEAD']) {
      assert.equal(await suiteRootDestination(request('/', f.cookie, method), { ...f.options, rootApp }), undefined);
    }
  }
});

test('malformed grant results never authorize a root; store and session failures propagate', async (t) => {
  const f = await fixture(t);
  f.grant('lender', ['reader']);
  const sparse = ['reader'];
  sparse.length = 2;
  for (const roles of [[], ['reader', 'unknown'], ['reader', 'reader'], sparse, ['reader', undefined], ['reader', 1], 'reader', null]) {
    const grants = { readForSession: () => ({ revision: 1, roles }) } as unknown as typeof f.options.grants;
    assert.equal(await suiteRootDestination(request('/', f.cookie), { ...f.options, grants }), '/_mistri/apps');
  }
  const unavailable = new Error('grant store unavailable');
  await assert.rejects(
    suiteRootDestination(request('/', f.cookie), {
      ...f.options,
      grants: {
        readForSession() {
          throw unavailable;
        },
      },
    }),
    (error) => error === unavailable,
  );
  const racing = {
    readForSession(subjectId: string, appId: string, via: { provider: string | undefined }) {
      const value = f.grants.readForSession(subjectId, appId, via);
      f.control.prepare('DELETE FROM session WHERE userId = ?').run(subjectId);
      return value;
    },
  };
  await assert.rejects(
    suiteRootDestination(request('/', f.cookie), { ...f.options, grants: racing }),
    /could not be verified/,
    'proof is rechecked after reading the grant',
  );
  f.native.close();
  await assert.rejects(suiteRootDestination(request('/', f.cookie), f.options), /could not be verified/);
});
