import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  captureAppAuthRuntime,
  createAppAuth,
  type AppAuthRuntime,
  type AppAuthRuntimeBinding,
} from '../packages/mistri/src/server/auth/auth.js';
import type { LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { appHostingError } from '../packages/mistri/src/server/app/appEntrypoint.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';

const request = (cookie = '') => ({ headers: { cookie } }) as IncomingMessage;
const safeError = (error: unknown) => {
  assert.ok(error instanceof TenantContextError);
  assert.equal(error.message, 'The tenant context could not be verified.');
  assert.equal(Object.hasOwn(error, 'cause'), false);
  return true;
};
const app = (directory: string): LoadedApp => ({
  path: join(directory, 'app.ts'),
  dir: directory,
  pages: [],
  sources: {},
  app: parseAppConfig(
    {
      id: 'bound-app',
      name: 'Bound App',
      resources: { item: { access: 'write' } },
      auth: {
        store: 'auth.db',
        signUp: 'open',
        roles: { user: { read: true, write: ['item'] } },
      },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
    },
    'binding fixture',
  ),
});

async function fixture(
  t: TestContext,
  mutate?: (loaded: LoadedApp, opts: { baseURL: string; trustedOrigins: string[] }) => void,
  commands?: LoadedApp['commands'],
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-auth-binding-'));
  let runtime: AppAuthRuntime | undefined, binding: AppAuthRuntimeBinding | undefined;
  const server = createServer((req, res) => {
    if (!binding) {
      res.writeHead(503);
      res.end();
      return;
    }
    void binding.handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    binding?.close();
    runtime?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const loaded = { ...app(directory), ...(commands ? { commands } : {}) },
    opts = { baseURL: origin, trustedOrigins: [origin] };
  const names = ['BETTER_AUTH_SECRET', 'MISTRI_AUTH_ADMIN_EMAIL', 'MISTRI_AUTH_ADMIN_PASSWORD'] as const;
  const environment = names.map((name) => [name, process.env[name]] as const);
  process.env.BETTER_AUTH_SECRET = 'synthetic-auth-binding-secret-at-least-thirty-two-characters';
  delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
  delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
  try {
    const pending = createAppAuth(loaded, opts);
    mutate?.(loaded, opts);
    runtime = await pending;
  } finally {
    for (const [name, value] of environment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  binding = captureAppAuthRuntime(runtime);
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(origin + path, {
      ...init,
      signal: AbortSignal.timeout(5_000),
      headers: { origin, 'content-type': 'application/json', ...init.headers },
    });
    return { response, body: (await response.json()) as Record<string, unknown> };
  };
  const signup = async () => {
    const result = await call('/api/auth/sign-up/email', {
      method: 'POST',
      body: JSON.stringify({ name: 'Binding User', email: 'binding@example.test', password: 'binding-test-password-123' }),
    });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    return result.response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
  };
  return { directory, loaded, opts, runtime, binding, origin, call, signup };
}

test('genuine capture is frozen, stable, private and does not freeze the ordinary runtime', async (t) => {
  const f = await fixture(t);
  assert.equal(captureAppAuthRuntime(f.runtime), f.binding);
  assert.deepEqual(Object.keys(f.binding).sort(), [
    'appId',
    'assertCurrent',
    'assertSessionCurrent',
    'close',
    'handler',
    'lookupAccount',
    'sessionInstance',
    'spec',
  ]);
  assert.equal(f.binding.appId, 'bound-app');
  assert.ok(Object.isFrozen(f.binding));
  assert.equal(Object.isFrozen(f.runtime), false);
  assert.ok(Object.isFrozen(f.binding.spec));
  assert.ok(Object.isFrozen(f.binding.spec.providers));
  // The grants stay on the App's auth.roles; the captured sign-in spec carries none.
  assert.equal('roles' in f.binding.spec, false);
  assert.throws(() => f.binding.spec.providers.push('google'), TypeError);
  assert.equal(await f.binding.sessionInstance(request()), null);
  assert.equal(await f.runtime.session(request()), null);
  f.binding.assertCurrent();
});

test('ordinary hosting compares detached auth policy values and still refuses actual policy changes', async (t) => {
  const f = await fixture(t),
    host = { app: f.loaded, pages: [], auth: f.runtime };
  assert.equal(appHostingError([host]), undefined);
  f.loaded.app.auth!.signUp = 'invite';
  assert.equal(appHostingError([host]), 'Application authentication changed; restart the server.');
  f.loaded.app.auth!.signUp = 'open';
  let hooks = 0;
  Object.defineProperty(f.loaded.app.auth, 'signUp', {
    enumerable: true,
    get: () => {
      hooks++;
      throw new Error('private config');
    },
  });
  assert.equal(appHostingError([host]), 'Application authentication changed; restart the server.');
  assert.equal(hooks, 0);
});

test('App identity, paths, auth policy and origins are captured before the first wait', async (t) => {
  const f = await fixture(t, (loaded, opts) => {
    loaded.app.id = 'changed-app';
    loaded.app.name = 'Changed App';
    loaded.app.auth!.store = 'wrong.db';
    loaded.app.auth!.signUp = 'invite';
    loaded.app.auth!.defaultRole = 'admin';
    loaded.app.auth!.providers.splice(0, 1, 'google');
    loaded.path = join(loaded.dir!, 'wrong', 'app.ts');
    loaded.dir = join(loaded.dir!, 'wrong');
    opts.baseURL = 'https://wrong.invalid';
    opts.trustedOrigins.splice(0, 1, 'https://wrong.invalid');
  });
  assert.equal(f.binding.appId, 'bound-app');
  assert.equal(f.binding.spec.store, 'auth.db');
  assert.equal(f.runtime.store, join(f.directory, 'auth.db'));
  assert.equal(existsSync(join(f.directory, 'wrong')), false);
  assert.equal(f.binding.spec.signUp, 'open');
  assert.deepEqual(f.binding.spec.providers, ['email']);
  assert.equal('roles' in f.binding.spec, false);
  const cookie = await f.signup();
  const verified = await f.binding.sessionInstance(request(cookie));
  assert.ok(verified);
  assert.equal(verified.identity.role, 'user');
  const profile = await f.call('/api/auth/profile?app=bound-app', {
    headers: { cookie, 'x-mistri-account': verified.identity.id },
  });
  assert.equal(profile.response.status, 200);
});

test('the captured native verifier reads the real session store and observes revocation', async (t) => {
  const f = await fixture(t),
    cookie = await f.signup();
  const verified = await f.binding.sessionInstance(request(cookie));
  assert.ok(verified && Object.isFrozen(verified) && Object.isFrozen(verified.identity));
  assert.deepEqual(Object.keys(verified).sort(), ['expiresAt', 'identity', 'sessionId']);
  const db = new DatabaseSync(f.runtime.store);
  try {
    db.prepare('DELETE FROM session WHERE id = ?').run(verified.sessionId);
  } finally {
    db.close();
  }
  assert.throws(() => f.binding.assertSessionCurrent(verified), safeError);
  assert.equal(await f.binding.sessionInstance(request(cookie)), null);
});

test('private account lookup uses exact native user IDs, returns no profile data and observes deletion', async (t) => {
  const f = await fixture(t),
    cookie = await f.signup();
  const proof = await f.binding.sessionInstance(request(cookie));
  assert.ok(proof);
  const result = f.binding.lookupAccount(proof.identity.id);
  assert.ok(result);
  assert.ok(Object.isFrozen(result));
  assert.deepEqual({ ...result }, { accountId: proof.identity.id });
  assert.equal('lookupAccount' in f.runtime, false, 'ordinary runtime must not acquire an enumeration method');
  for (const other of ['binding@example.test', 'missing-account', `${proof.identity.id}x`, "' OR 1=1 --"])
    assert.equal(f.binding.lookupAccount(other), null);
  const db = new DatabaseSync(f.runtime.store);
  try {
    const provider = db.prepare('SELECT id FROM account WHERE userId = ?').get(proof.identity.id);
    assert.ok(provider && typeof provider.id === 'string');
    assert.equal(f.binding.lookupAccount(provider.id), null);
    db.prepare('DELETE FROM "user" WHERE id = ?').run(proof.identity.id);
  } finally {
    db.close();
  }
  assert.equal(f.binding.lookupAccount(proof.identity.id), null);
});

test('final session observation accepts only this genuine binding’s issued proof, without executing hooks', async (t) => {
  const f = await fixture(t),
    cookie = await f.signup();
  const proof = await f.binding.sessionInstance(request(cookie));
  assert.ok(proof);
  f.binding.assertSessionCurrent(proof);
  assert.equal('assertSessionCurrent' in f.runtime, false);
  const ordinary = await f.runtime.sessionInstance!(request(cookie));
  assert.ok(ordinary);
  let hooks = 0;
  const hostile = {
    get sessionId() {
      hooks++;
      return proof.sessionId;
    },
  };
  for (const candidate of [null, undefined, { ...proof }, ordinary, hostile, new Proxy(proof, {})]) {
    assert.throws(() => f.binding.assertSessionCurrent(candidate as never), safeError);
  }
  assert.equal(hooks, 0);
  f.runtime.close();
  assert.throws(() => f.binding.assertSessionCurrent(proof), safeError);
});

test('final native session observation detects revocation, impersonation, account deletion and expiry shortening', async (t) => {
  const f = await fixture(t),
    cookie = await f.signup();
  const proof = await f.binding.sessionInstance(request(cookie));
  assert.ok(proof);
  const db = new DatabaseSync(f.runtime.store);
  try {
    const mutate = (
      sql: string,
      values: Array<string | number | null>,
      restoreSql: string,
      restoreValues: Array<string | number | null>,
    ) => {
      db.prepare(sql).run(...values);
      assert.throws(() => f.binding.assertSessionCurrent(proof), safeError);
      db.prepare(restoreSql).run(...restoreValues);
      f.binding.assertSessionCurrent(proof);
    };
    mutate(
      'UPDATE session SET impersonatedBy=? WHERE id=?',
      ['operator', proof.sessionId],
      'UPDATE session SET impersonatedBy=? WHERE id=?',
      [null, proof.sessionId],
    );
    mutate('UPDATE user SET banned=? WHERE id=?', [1, proof.identity.id], 'UPDATE user SET banned=? WHERE id=?', [0, proof.identity.id]);
    for (const expiresAt of [new Date(proof.expiresAt - 1000).toISOString(), new Date(Date.now() - 1000).toISOString(), 'not-a-date']) {
      mutate('UPDATE session SET expiresAt=? WHERE id=?', [expiresAt, proof.sessionId], 'UPDATE session SET expiresAt=? WHERE id=?', [
        new Date(proof.expiresAt).toISOString(),
        proof.sessionId,
      ]);
    }
    db.prepare('DELETE FROM user WHERE id=?').run(proof.identity.id);
    assert.throws(() => f.binding.assertSessionCurrent(proof), safeError);
  } finally {
    db.close();
  }
});

test('private account lookup rejects malformed inputs without coercion and sanitizes native store failure', async (t) => {
  const f = await fixture(t);
  let hooks = 0;
  const hostile = {
    toString() {
      hooks++;
      throw new Error('PRIVATE_ACCOUNT_LOOKUP');
    },
  };
  for (const invalid of ['', ' padded ', 'x'.repeat(1025), 'bad\u0000id', null, 1, hostile])
    assert.throws(() => f.binding.lookupAccount(invalid as string), safeError);
  assert.equal(hooks, 0);
  const db = new DatabaseSync(f.runtime.store);
  try {
    db.exec('ALTER TABLE "user" RENAME TO "PRIVATE_ACCOUNT_LOOKUP"');
  } finally {
    db.close();
  }
  assert.throws(() => f.binding.lookupAccount('some-user'), safeError);
});

test('a real native impersonation login is refused by strong proof without changing ordinary native auth', async (t) => {
  const f = await fixture(t),
    adminCookie = await f.signup();
  const admin = await f.binding.sessionInstance(request(adminCookie));
  assert.ok(admin);
  const target = await f.call('/api/auth/sign-up/email', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Target',
      email: 'target@example.test',
      password: 'target-test-password-123',
    }),
  });
  assert.equal(target.response.status, 200);
  const user = target.body.user as { id: string };
  const db = new DatabaseSync(f.runtime.store);
  try {
    db.prepare('UPDATE "user" SET role = ? WHERE id = ?').run('admin', admin.identity.id);
  } finally {
    db.close();
  }
  // Signing in as somebody else is not a door this App opens (auth.ts closedNativeAdminPath)...
  const asked = await f.call('/api/auth/admin/impersonate-user', {
    method: 'POST',
    headers: { cookie: adminCookie },
    body: JSON.stringify({ userId: user.id }),
  });
  assert.equal(asked.response.status, 404);
  // ...so the session it would have made is made in the store: the target's own, marked as the admin's.
  const cookie = target.response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const marked = new DatabaseSync(f.runtime.store);
  try {
    marked.prepare('UPDATE "session" SET impersonatedBy = ? WHERE userId = ?').run(admin.identity.id, user.id);
  } finally {
    marked.close();
  }
  assert.equal((await f.runtime.session(request(cookie)))?.id, user.id);
  await assert.rejects(f.binding.sessionInstance(request(cookie)), safeError);
  await assert.rejects(f.runtime.sessionInstance!(request(cookie)), safeError);
  assert.equal((await f.binding.sessionInstance(request(adminCookie)))?.identity.id, admin.identity.id);
});

test('forged, inherited, copied and proxied runtimes are refused without property hooks', async (t) => {
  const f = await fixture(t);
  let hooks = 0;
  const trap = () => {
    hooks++;
    throw new Error('private provider secret');
  };
  const hostile = Object.defineProperty({}, 'spec', { get: trap });
  const { proxy, revoke } = Proxy.revocable(f.runtime, { get: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap });
  for (const value of [null, {}, hostile, { ...f.runtime }, Object.create(f.runtime), proxy])
    assert.throws(() => captureAppAuthRuntime(value as AppAuthRuntime), safeError);
  revoke();
  assert.throws(() => captureAppAuthRuntime(proxy), safeError);
  assert.equal(hooks, 0);
  f.binding.assertCurrent();
});

for (const name of ['handler', 'sessionInstance', 'session', 'close', 'spec', 'store', 'accountProfile'] as const) {
  test(`descriptor replacement of ${name} refuses without invoking the replacement`, async (t) => {
    const f = await fixture(t);
    const original = Object.getOwnPropertyDescriptor(f.runtime, name)!;
    let hooks = 0;
    Object.defineProperty(f.runtime, name, {
      configurable: true,
      enumerable: true,
      get: () => {
        hooks++;
        throw new Error('private provider secret');
      },
    });
    try {
      assert.throws(f.binding.assertCurrent, safeError);
      assert.throws(() => captureAppAuthRuntime(f.runtime), safeError);
      await assert.rejects(f.binding.sessionInstance(request()), safeError);
      assert.throws(() => f.binding.lookupAccount('missing-user'), safeError);
      assert.equal(hooks, 0);
    } finally {
      Object.defineProperty(f.runtime, name, original);
    }
    f.binding.assertCurrent();
  });
}

test('same-value descriptor flag swaps and method/spec value swaps are refused', async (t) => {
  const f = await fixture(t);
  for (const name of ['handler', 'spec'] as const) {
    const original = Object.getOwnPropertyDescriptor(f.runtime, name)!;
    Object.defineProperty(f.runtime, name, { ...original, writable: false });
    assert.throws(f.binding.assertCurrent, safeError);
    Object.defineProperty(f.runtime, name, original);
    Object.defineProperty(f.runtime, name, { ...original, value: name === 'spec' ? structuredClone(f.binding.spec) : async () => {} });
    assert.throws(f.binding.assertCurrent, safeError);
    Object.defineProperty(f.runtime, name, original);
  }
  f.binding.assertCurrent();
});

test('captured cleanup survives a swapped close and retained methods refuse before touching requests', async (t) => {
  const f = await fixture(t);
  const original = f.runtime.close;
  let hooks = 0;
  f.runtime.close = () => {
    hooks++;
  };
  f.binding.close();
  f.binding.close();
  f.runtime.close = original;
  assert.equal(hooks, 0);
  assert.throws(f.binding.assertCurrent, safeError);
  assert.throws(() => captureAppAuthRuntime(f.runtime), safeError);
  const hostile = Object.defineProperty({}, 'headers', {
    get: () => {
      hooks++;
      throw new Error('secret');
    },
  }) as IncomingMessage;
  await assert.rejects(f.binding.sessionInstance(hostile), safeError);
  await assert.rejects(f.binding.handler(hostile, {} as Parameters<AppAuthRuntime['handler']>[1]), safeError);
  assert.throws(() => f.binding.lookupAccount('missing-user'), safeError);
  assert.equal(hooks, 0);
});

test('closing the ordinary runtime invalidates every retained private binding', async (t) => {
  const f = await fixture(t);
  f.runtime.close();
  f.runtime.close();
  assert.throws(f.binding.assertCurrent, safeError);
  await assert.rejects(f.binding.sessionInstance(request()), safeError);
  assert.throws(() => f.binding.lookupAccount('missing-user'), safeError);
});

test('descriptor tampering during native verification cannot release signed-out success', async (t) => {
  const f = await fixture(t);
  const original = f.runtime.handler;
  const incoming = Object.defineProperty({}, 'headers', {
    get: () => {
      f.runtime.handler = async () => {};
      return {};
    },
  }) as IncomingMessage;
  try {
    await assert.rejects(f.binding.sessionInstance(incoming), safeError);
  } finally {
    f.runtime.handler = original;
  }
  f.binding.assertCurrent();
});

test('close during native verification cannot release signed-out success', async (t) => {
  const f = await fixture(t);
  const incoming = Object.defineProperty({}, 'headers', {
    get: () => {
      f.binding.close();
      return {};
    },
  }) as IncomingMessage;
  await assert.rejects(f.binding.sessionInstance(incoming), safeError);
  assert.throws(f.binding.assertCurrent, safeError);
});

test('capture refusal itself does not close caller-owned auth', async (t) => {
  const f = await fixture(t);
  assert.throws(() => captureAppAuthRuntime({ ...f.runtime }), safeError);
  assert.equal(await f.runtime.sessionInstance!(request()), null);
  assert.equal(await f.binding.sessionInstance(request()), null);
});

test('hostile config, options and paths refuse before import waits or file acquisition', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-auth-binding-input-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let hooks = 0;
  const trap = () => {
    hooks++;
    throw new Error('private input secret');
  };
  for (const part of ['loaded', 'app', 'auth', 'path', 'dir', 'store', 'baseURL', 'trustedOrigins'] as const) {
    let loaded = app(directory);
    const opts = { baseURL: 'http://127.0.0.1', trustedOrigins: ['http://127.0.0.1'] };
    if (part === 'loaded') loaded = new Proxy(loaded, { get: trap, ownKeys: trap });
    else {
      const target =
        part === 'app' || part === 'path' || part === 'dir'
          ? loaded
          : part === 'auth'
            ? loaded.app
            : part === 'store'
              ? loaded.app.auth!
              : opts;
      Object.defineProperty(target, part, { enumerable: true, get: trap });
    }
    await assert.rejects(createAppAuth(loaded, opts), safeError);
  }
  const loaded = app(directory);
  loaded.path = { toString: trap } as unknown as string;
  await assert.rejects(createAppAuth(loaded, { baseURL: 'http://127.0.0.1', trustedOrigins: [] }), safeError);
  assert.equal(hooks, 0);
  assert.equal(existsSync(join(directory, 'auth.db')), false);
});

test('authentication captures loaded App data without traversing command handlers', async (t) => {
  const commands = {
    file: '/private/commands.ts',
    registry: defineCommands({
      save: defineCommand({
        source: 'desk',
        target: 'item',
        async handle() {
          throw new Error('Authentication must not execute a command');
        },
      }),
    }),
  };
  const f = await fixture(t, undefined, commands);
  assert.equal(f.binding.appId, 'bound-app');
  assert.equal(await f.binding.sessionInstance(request()), null);
});
