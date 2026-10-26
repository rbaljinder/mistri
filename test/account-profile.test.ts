import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { createAccountProfileHandler, type AccountProfileApi } from '../packages/mistri/src/server/auth/accountProfile.js';
import { createAppAuth, nameFromEmail, type AppAuthRuntime } from '../packages/mistri/src/server/auth/auth.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { EmailMessage, EmailTransport } from '../packages/mistri/src/server/email/email.js';

const route = '/api/auth/profile?app=profile-app';
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function serve(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function fixture(t: TestContext, mail?: EmailTransport) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-account-profile-'));
  let auth!: AppAuthRuntime;
  const origin = await serve(t, (req, res) => auth.handler(req, res));
  const saved = {
    secret: process.env.BETTER_AUTH_SECRET,
    email: process.env.MISTRI_AUTH_ADMIN_EMAIL,
    password: process.env.MISTRI_AUTH_ADMIN_PASSWORD,
  };
  process.env.BETTER_AUTH_SECRET = 'synthetic-profile-secret-at-least-thirty-two-characters';
  delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
  delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
  const store = join(directory, 'auth.db');
  try {
    auth = await createAppAuth(
      {
        path: join(directory, 'app.ts'),
        pages: [],
        sources: {},
        app: parseAppConfig(
          {
            id: 'profile-app',
            name: 'Profile fixture',
            auth: { signUp: 'open', store },
            resources: { item: {} },
            views: { items: { kind: 'list', from: 'item' } },
            home: 'items',
          },
          'profile fixture',
        ),
      },
      { baseURL: origin, trustedOrigins: [origin], ...(mail ? { mail } : {}) },
    );
  } finally {
    for (const [key, value] of [
      ['BETTER_AUTH_SECRET', saved.secret],
      ['MISTRI_AUTH_ADMIN_EMAIL', saved.email],
      ['MISTRI_AUTH_ADMIN_PASSWORD', saved.password],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  t.after(() => {
    auth.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(origin + path, { ...init, headers: { origin, 'content-type': 'application/json', ...init.headers } });
    return { response, body: (await response.json()) as Record<string, unknown> };
  };
  const signup = async (name: string) => {
    const { response, body } = await call('/api/auth/sign-up/email', {
      method: 'POST',
      body: JSON.stringify({ name, email: `${name.toLowerCase()}@example.test`, password: `${name}-fixture-password-123` }),
    });
    assert.equal(response.status, 200);
    const user = body.user as Record<string, unknown>;
    assert.equal(typeof user.id, 'string');
    return {
      cookie: response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; '),
      'x-mistri-account': String(user.id),
    };
  };
  const ada = await signup('Ada'),
    bob = await signup('Bob');
  return { auth, origin, store, call, ada, bob };
}

test('real Better Auth owns profile reads and name updates without altering identity or emitting session cookies', async (t) => {
  const f = await fixture(t);
  assert.equal(f.auth.accountProfile, true);
  const before = await f.call(route, { headers: f.ada });
  assert.equal(before.response.status, 200);
  assert.equal(before.response.headers.get('cache-control'), 'no-store');
  assert.equal(before.response.headers.get('x-mistri-account'), f.ada['x-mistri-account']);
  assert.deepEqual(before.body.profile, {
    accountId: f.ada['x-mistri-account'],
    appId: 'profile-app',
    name: 'Ada',
    email: 'ada@example.test',
    providers: ['email'],
  });
  const updated = await f.call(route, { method: 'POST', headers: f.ada, body: JSON.stringify({ name: '  Ada Lovelace  ' }) });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.outcome, 'applied');
  assert.equal(updated.response.headers.get('set-cookie'), null);
  assert.equal((updated.body.profile as Record<string, unknown>).name, 'Ada Lovelace');
  const reread = await f.call(route, { headers: f.ada });
  assert.equal((reread.body.profile as Record<string, unknown>).name, 'Ada Lovelace');
  assert.equal(((await f.call(route, { headers: f.bob })).body.profile as Record<string, unknown>).name, 'Bob');
  const db = new DatabaseSync(f.store, { readOnly: true });
  try {
    const stored = db.prepare('SELECT email, emailVerified, role, name FROM user WHERE id = ?').get(f.ada['x-mistri-account']);
    assert.deepEqual({ ...stored }, { email: 'ada@example.test', emailVerified: 0, role: 'user', name: 'Ada Lovelace' });
  } finally {
    db.close();
  }
});

test('name-only allowlist rejects other fields, malformed values and excess bodies before Better Auth mutation', async (t) => {
  const f = await fixture(t);
  for (const value of [
    null,
    [],
    {},
    { name: '' },
    { name: '   ' },
    { name: 1 },
    { name: 'x'.repeat(121) },
    { name: 'bad\nname' },
    { name: 'Valid', email: 'other@example.test' },
    { name: 'Valid', password: 'secret' },
    { name: 'Valid', role: 'admin' },
    { name: 'Valid', emailVerified: true },
    { name: 'Valid', userId: f.bob['x-mistri-account'] },
    { name: 'Valid', image: 'https://example.test/avatar' },
    { name: 'Valid', membership: 'admin' },
  ]) {
    const result = await f.call(route, { method: 'POST', headers: f.ada, body: JSON.stringify(value) });
    assert.equal(result.response.status, 400, JSON.stringify(value));
    assert.equal(result.body.outcome, 'not_applied');
  }
  assert.equal((await f.call(route, { method: 'POST', headers: f.ada, body: '{' })).response.status, 400);
  assert.equal(
    (await f.call(route, { method: 'POST', headers: f.ada, body: JSON.stringify({ name: 'x'.repeat(5000) }) })).response.status,
    413,
  );
  assert.equal(((await f.call(route, { headers: f.ada })).body.profile as Record<string, unknown>).name, 'Ada');
});

test('profile requires the exact own session, App selector, expected-account header and same-origin JSON conventions', async (t) => {
  const f = await fixture(t);
  for (const [path, init, status] of [
    [route, { headers: { 'x-mistri-account': f.ada['x-mistri-account'] } }, 401],
    [route, { headers: { cookie: f.ada.cookie } }, 409],
    [route, { headers: { ...f.bob, 'x-mistri-account': f.ada['x-mistri-account'] } }, 409],
    ['/api/auth/profile?app=other', { headers: f.ada }, 400],
    [route + '&app=profile-app', { headers: f.ada }, 400],
    [route + '&userId=' + f.bob['x-mistri-account'], { headers: f.ada }, 400],
    [route, { method: 'DELETE', headers: f.ada }, 405],
    [route, { method: 'POST', headers: { ...f.ada, origin: 'https://hostile.test' }, body: '{"name":"Bad"}' }, 403],
    [route, { method: 'POST', headers: { ...f.ada, 'sec-fetch-site': 'cross-site' }, body: '{"name":"Bad"}' }, 403],
    [route, { method: 'POST', headers: { ...f.ada, 'content-type': 'text/plain' }, body: '{"name":"Bad"}' }, 415],
  ] satisfies Array<[string, RequestInit, number]>) {
    const result = await f.call(path, init);
    assert.equal(result.response.status, status);
    assert.equal(result.body.outcome, 'not_applied');
    assert.equal(Object.hasOwn(result.body, 'profile'), false);
  }
  const noOrigin = await fetch(f.origin + route, {
    method: 'POST',
    headers: { ...f.ada, 'content-type': 'application/json' },
    body: '{"name":"Bad"}',
  });
  assert.equal(noOrigin.status, 403);
  const signedOut = await f.call('/api/auth/sign-out', { method: 'POST', headers: f.ada, body: '{}' });
  assert.equal(signedOut.response.status, 200);
  assert.equal((await f.call(route, { headers: f.ada })).response.status, 401);
  assert.equal((await f.call(route, { method: 'POST', headers: f.ada, body: '{"name":"After sign-out"}' })).response.status, 401);
});

async function controlled(t: TestContext, change: (api: AccountProfileApi) => void) {
  const user = { id: 'ada', name: 'Ada', email: 'ada@example.test' };
  const api: AccountProfileApi = {
    getSession: async () => ({ user: { ...user } }),
    listUserAccounts: async () => [{ userId: 'ada', providerId: 'github', accessToken: 'private-provider-token' }],
    updateUser: async (input) => {
      user.name = input.body.name;
      return { status: true };
    },
  };
  change(api);
  let handler!: ReturnType<typeof createAccountProfileHandler>;
  const origin = await serve(t, (req, res) => handler(req, res));
  handler = createAccountProfileHandler({
    appId: 'profile-app',
    trustedOrigins: [origin],
    api,
    headers: (given) => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(given)) if (typeof value === 'string') headers.set(key, value);
      return headers;
    },
  });
  const call = async (method = 'GET') => {
    const response = await fetch(origin + route, {
      method,
      headers: { origin, cookie: 'fixture', 'content-type': 'application/json', 'x-mistri-account': 'ada' },
      ...(method === 'POST' ? { body: '{"name":"Changed"}' } : {}),
    });
    return { response, body: (await response.json()) as Record<string, unknown> };
  };
  return { call, user };
}

test('a provider failure after dispatch is unknown even when its mutation already happened', async (t) => {
  const f = await controlled(t, (api) => {
    const update = api.updateUser;
    api.updateUser = async (input) => {
      await update(input);
      throw new Error('private-provider-token');
    };
  });
  const result = await f.call('POST');
  assert.equal(result.response.status, 503);
  assert.equal(result.body.outcome, 'unknown');
  assert.equal(f.user.name, 'Changed');
  assert.equal(JSON.stringify(result.body).includes('private-provider-token'), false);
  assert.equal(((await f.call()).body.profile as Record<string, unknown>).name, 'Changed');
});

test('pending saves block duplicate mutations and recovery reads until the original provider settles', async (t) => {
  const entered = gate(),
    release = gate();
  let mutations = 0;
  const f = await controlled(t, (api) => {
    const update = api.updateUser;
    api.updateUser = async (input) => {
      mutations++;
      entered.release();
      await release.promise;
      return update(input);
    };
  });
  const saving = f.call('POST');
  await entered.promise;
  assert.equal((await f.call('POST')).body.code, 'profile_busy');
  assert.equal((await f.call()).body.code, 'profile_busy');
  release.release();
  assert.equal((await saving).body.outcome, 'applied');
  assert.equal(mutations, 1);
  const after = await f.call();
  assert.deepEqual((after.body.profile as Record<string, unknown>).providers, ['github']);
  assert.equal(JSON.stringify(after.body).includes('private-provider-token'), false);
});

/* The bootstrapped admin was greeted "Good day, margaret.hollis" (Keystone). */
test('an account made from an email alone is named by its words', () => {
  assert.equal(nameFromEmail('margaret.hollis@example.org'), 'Margaret Hollis');
  assert.equal(nameFromEmail('ops_lead-2@example.org'), 'Ops Lead');
  assert.equal(nameFromEmail('admin@example.org'), 'Admin');
  assert.equal(nameFromEmail('42@example.org'), '42');
});

test('changing the address is offered only where the App sends mail, and is a link to the new address', async (t) => {
  const without = await fixture(t);
  assert.equal('emailChange' in ((await without.call(route, { headers: without.ada })).body.profile as object), false);
  assert.equal(
    (
      await without.call('/api/auth/change-email', {
        method: 'POST',
        headers: without.ada,
        body: JSON.stringify({ newEmail: 'ada@elsewhere.test' }),
      })
    ).response.status,
    400,
  );

  const sent: EmailMessage[] = [];
  const f = await fixture(t, {
    name: 'test',
    send: async (message) => {
      sent.push(message);
    },
  });
  assert.equal(((await f.call(route, { headers: f.ada })).body.profile as Record<string, unknown>).emailChange, true);
  sent.length = 0;
  const asked = await f.call('/api/auth/change-email', {
    method: 'POST',
    headers: f.ada,
    body: JSON.stringify({ newEmail: 'ada@elsewhere.test' }),
  });
  assert.equal(asked.response.status, 200);
  const toNew = sent.filter((message) => message.to === 'ada@elsewhere.test');
  assert.equal(toNew.length, 1);
  assert.match(toNew[0].text, /https?:\/\/\S+verify-email\?token=/);
  /* Nothing changes until the link is followed. */
  assert.equal(((await f.call(route, { headers: f.ada })).body.profile as Record<string, unknown>).email, 'ada@example.test');
});
