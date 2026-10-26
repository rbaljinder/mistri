/** Real native cookies, separate SQLite preferences/grants, and held bodies. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { createAppAuth, type AppAuthRuntime } from '../packages/mistri/src/server/auth/auth.js';
import { openSuitePreferencesStore, provisionSuitePreferencesStore } from '../packages/mistri/src/server/auth/suitePreferences.js';
import { suitePreferencesHttp } from '../packages/mistri/src/server/auth/suitePreferencesHttp.js';
import { openSuiteGrantStore, provisionSuiteGrantStore } from '../packages/mistri/src/server/auth/suiteGrantStore.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

const path = '/tools/api/suite/preferences';
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tw-suite-preferences-http-'));
  const identityFile = join(directory, 'identity.db');
  const db = new DatabaseSync(`${identityFile}.preferences`),
    grantDb = new DatabaseSync(join(directory, 'grants.db'));
  provisionSuitePreferencesStore(db, 'shared');
  provisionSuiteGrantStore(grantDb, 'shared');
  const preferences = openSuitePreferencesStore(db, 'shared'),
    grants = openSuiteGrantStore(grantDb, 'shared');
  let native!: AppAuthRuntime,
    current = true;
  const deployed = new Set(['alpha', 'beta']);
  const bound = { host: '127.0.0.1', port: 0 };
  const allowedApps = (proof: { identity: { id: string } }) =>
    [...deployed].filter((appId) => {
      const { roles } = grants.readForSession(proof.identity.id, appId, { provider: undefined });
      return roles.length > 0 && roles.every((role) => ['reader', 'admin'].includes(role));
    });
  const server = createServer((req, res) => {
    const handler = req.url?.startsWith(path)
      ? suitePreferencesHttp(req, res, { native, preferences, bound, basePath: '/tools', current: () => current, allowedApps })
      : native.handler(req, res);
    void handler.catch(() => {
      res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, bound.host, resolve));
  bound.port = (server.address() as { port: number }).port;
  const origin = `http://${bound.host}:${bound.port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    native?.close();
    db.close();
    grantDb.close();
    rmSync(directory, { recursive: true, force: true });
  });
  native = await createAppAuth(
    {
      path: join(directory, 'app.ts'),
      pages: [],
      sources: {},
      app: parseAppConfig(
        {
          id: 'shared',
          name: 'Suite preferences fixture',
          auth: { signUp: 'open', store: identityFile },
          resources: { note: {} },
          views: { notes: { kind: 'list', from: 'note' } },
          home: 'notes',
        },
        'preferences fixture',
      ),
    },
    {
      baseURL: origin,
      trustedOrigins: [origin],
      environment: { BETTER_AUTH_SECRET: 'suite-preferences-test-secret-at-least-thirty-two-characters' },
    },
  );
  const call = async (url = path, init: RequestInit = {}) => {
    const response = await fetch(origin + url, { ...init, headers: { origin, ...init.headers }, signal: AbortSignal.timeout(5000) });
    const body = await response.json();
    if (url.startsWith(path)) assert.equal(response.headers.get('cache-control'), 'no-store');
    return { response, body };
  };
  const account = async (name: string) => {
    const { response, body } = await call('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, email: `${name}@example.test`, password: 'fixture-password-long-enough' }),
    });
    assert.equal(response.status, 200);
    return {
      id: body.user.id as string,
      headers: {
        cookie: response.headers
          .getSetCookie()
          .map((value) => value.split(';')[0])
          .join('; '),
        'x-mistri-account': body.user.id as string,
      },
    };
  };
  const ada = await account('ada'),
    bob = await account('bob');
  const post = (body: unknown, headers = ada.headers) =>
    call(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const grant = (subjectId: string, appId = 'alpha', roles = ['reader'], expectedRevision = 0) =>
    grants.change({ subjectId, appId, roles, expectedRevision, actorId: 'operator', declaredRoles: ['reader', 'admin', 'retired'] });
  const held = async (during: () => unknown | Promise<unknown>) => {
    const reading = deferred<void>(),
      reply = deferred<number>();
    server.prependOnceListener('request', (req) => {
      const iterator = req[Symbol.asyncIterator].bind(req);
      req[Symbol.asyncIterator] = () => {
        reading.resolve();
        return iterator();
      };
    });
    const text = JSON.stringify({ defaultApp: 'alpha', expectedRevision: 0 });
    const pending = request(
      origin + path,
      {
        method: 'POST',
        headers: { origin, ...ada.headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) },
      },
      (response) => {
        assert.equal(response.headers['cache-control'], 'no-store');
        response.resume();
        response.on('end', () => reply.resolve(response.statusCode!));
      },
    );
    pending.on('error', reply.reject);
    pending.setTimeout(5000, () => pending.destroy(new Error('Held body timed out.')));
    pending.write(text.slice(0, 1));
    try {
      await reading.promise;
      await during();
      pending.end(text.slice(1));
      return await reply.promise;
    } finally {
      pending.destroy();
    }
  };
  return {
    call,
    post,
    ada,
    bob,
    grant,
    grants,
    preferences,
    grantDb,
    held,
    deployed,
    identityFile,
    origin,
    retire: () => {
      current = false;
    },
  };
}

test(
  'native own-account preference reads and changes use explicit App grants, CAS and clear tombstones',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t),
      input = { defaultApp: 'alpha', expectedRevision: 0 };
    assert.deepEqual((await f.call(path, { headers: f.ada.headers })).body, { accountId: f.ada.id, defaultApp: null, revision: 0 });
    assert.equal((await f.post(input)).response.status, 403);
    f.grant(f.ada.id);
    const grantsBefore = f.grantDb.prepare('SELECT * FROM suite_grant_audit').all();
    const changed = await f.post(input);
    assert.equal(changed.response.status, 200);
    assert.deepEqual(changed.body, { accountId: f.ada.id, defaultApp: 'alpha', revision: 1 });
    assert.equal(changed.response.headers.get('set-cookie'), null);
    assert.equal((await f.post(input)).response.status, 409);
    assert.deepEqual((await f.call(path, { headers: f.bob.headers })).body, { accountId: f.bob.id, defaultApp: null, revision: 0 });
    assert.equal((await f.post(input, f.bob.headers)).response.status, 403);
    assert.deepEqual(f.grantDb.prepare('SELECT * FROM suite_grant_audit').all(), grantsBefore);
    f.grant(f.ada.id, 'alpha', [], 1);
    assert.equal((await f.post({ ...input, expectedRevision: 1 })).response.status, 403);
    assert.deepEqual(
      (await f.call(path, { headers: f.ada.headers })).body,
      { accountId: f.ada.id, defaultApp: 'alpha', revision: 1 },
      'stored hints survive revocation; the root owner ignores unauthorized targets',
    );
    const cleared = await f.post({ defaultApp: null, expectedRevision: 1 });
    assert.equal(cleared.response.status, 200);
    assert.deepEqual(cleared.body, { accountId: f.ada.id, defaultApp: null, revision: 2 });
    f.grant(f.ada.id, 'alpha', ['reader'], 2);
    f.deployed.delete('alpha');
    assert.equal((await f.post({ ...input, expectedRevision: 2 })).response.status, 403);
    f.grant(f.ada.id, 'beta', ['reader', 'retired']);
    assert.equal((await f.post({ defaultApp: 'beta', expectedRevision: 2 })).response.status, 403);
    assert.equal(f.preferences.read(f.ada.id).revision, 2);
  },
);

test('strict body, same-origin and exact native account fences reject confused or malformed requests', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t),
    input = { defaultApp: 'alpha', expectedRevision: 0 };
  f.grant(f.ada.id);
  assert.equal((await f.call()).response.status, 401);
  assert.equal((await f.post(input, { cookie: '', 'x-mistri-account': f.ada.id })).response.status, 401);
  for (const headers of [{ cookie: f.ada.headers.cookie }, { ...f.bob.headers, 'x-mistri-account': f.ada.id }]) {
    assert.equal((await f.call(path, { headers })).response.status, 409);
    assert.equal(
      (await f.call(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(input) }))
        .response.status,
      409,
    );
  }
  for (const method of ['GET', 'POST']) {
    assert.equal(
      (
        await f.call(path, {
          method,
          headers: { ...f.ada.headers, origin: 'http://foreign.invalid', 'content-type': 'application/json' },
          ...(method === 'POST' ? { body: JSON.stringify(input) } : {}),
        })
      ).response.status,
      403,
    );
    // fetch normalizes Host; use a real raw HTTP request for DNS rebinding.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        f.origin + path,
        {
          method,
          headers: { ...f.ada.headers, host: 'foreign.invalid', origin: 'http://foreign.invalid', 'content-type': 'application/json' },
        },
        (response) => {
          assert.equal(response.headers['cache-control'], 'no-store');
          response.resume();
          response.on('end', () => resolve(response.statusCode!));
        },
      );
      req.on('error', reject);
      req.end(method === 'POST' ? JSON.stringify(input) : undefined);
    });
    assert.equal(status, 403);
  }
  assert.equal((await f.call(path, { method: 'PUT', headers: f.ada.headers })).response.status, 405);
  assert.equal((await f.call(`${path}?subjectId=${f.bob.id}`, { headers: f.ada.headers })).response.status, 400);
  for (const body of [
    null,
    [],
    {},
    { defaultApp: 'alpha' },
    { expectedRevision: 0 },
    { ...input, subjectId: f.bob.id },
    { ...input, email: 'bob@example.test' },
    { ...input, extra: true },
    ...['', '../alpha', 'alpha\n', 'x'.repeat(65), 1, {}].map((defaultApp) => ({ ...input, defaultApp })),
    ...[-1, 0.5, '0', null, Number.MAX_SAFE_INTEGER].map((expectedRevision) => ({ ...input, expectedRevision })),
  ]) {
    assert.equal((await f.post(body)).response.status, 400, JSON.stringify(body));
  }
  for (const body of ['{', '', '{"__proto__":{}}', JSON.stringify({ defaultApp: 'x'.repeat(17 * 1024), expectedRevision: 0 })]) {
    assert.equal(
      (await f.call(path, { method: 'POST', headers: { ...f.ada.headers, 'content-type': 'application/json' }, body })).response.status,
      400,
    );
  }
  assert.equal(
    (await f.call(path, { method: 'POST', headers: { ...f.ada.headers, 'content-type': 'text/plain' }, body: JSON.stringify(input) }))
      .response.status,
    400,
  );
  assert.deepEqual(f.preferences.read(f.ada.id), { defaultApp: null, revision: 0 });
  assert.deepEqual(f.preferences.read(f.bob.id), { defaultApp: null, revision: 0 });
});

test('grant revocation, native logout and owner retirement during body awaits fence preference writes', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  f.grant(f.ada.id);
  assert.equal(await f.held(() => f.grant(f.ada.id, 'alpha', [], 1)), 403);
  f.grant(f.ada.id, 'alpha', ['reader'], 2);
  assert.equal(
    await f.held(() =>
      f.call('/api/auth/sign-out', { method: 'POST', headers: { ...f.ada.headers, 'content-type': 'application/json' }, body: '{}' }),
    ),
    409,
  );
  assert.deepEqual(f.preferences.read(f.ada.id), { defaultApp: null, revision: 0 });
  assert.equal((await f.call(path, { headers: f.ada.headers })).response.status, 401);
  f.grant(f.bob.id);
  f.retire();
  assert.equal((await f.post({ defaultApp: 'alpha', expectedRevision: 0 }, f.bob.headers)).response.status, 409);
  assert.equal((await f.call(path, { headers: f.bob.headers })).response.status, 409);
  assert.deepEqual(f.preferences.read(f.bob.id), { defaultApp: null, revision: 0 });
});
