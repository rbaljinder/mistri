import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import {
  captureAppAuthRuntime,
  createAppAuth,
  signInInfo,
  type AppAuthRuntime,
  type AppAuthRuntimeBinding,
} from '../packages/mistri/src/server/auth/auth.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

const request = (cookie: string) => ({ headers: { cookie } }) as IncomingMessage;
const safeError = (error: unknown) => {
  assert.ok(error instanceof TenantContextError);
  assert.equal(error.message, 'The tenant context could not be verified.');
  assert.equal(Object.hasOwn(error, 'cause'), false);
  assert.equal(JSON.stringify(error).includes('PRIVATE_ELIGIBILITY'), false);
  return true;
};
const eligible = (binding: AppAuthRuntimeBinding, accountId: string) => {
  const result = binding.lookupEligibleAccount(accountId);
  assert.ok(result && !(result instanceof Promise));
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(Reflect.ownKeys(result), ['accountId']);
  assert.equal(JSON.stringify(result), JSON.stringify({ accountId }));
  return result;
};

test('current native roles are captured with eligibility, without signup defaults or public exposure', async (t) => {
  const f = await fixture(t),
    user = await f.signup();
  const observe = () => f.binding.lookupEligibleAccountRolesCurrent(user.accountId);
  for (const [stored, roles] of [
    [null, []],
    ['', []],
    [' reviewer ,admin, reviewer,, ', ['admin', 'reviewer']],
  ] as const) {
    f.db.prepare('UPDATE "user" SET role = ? WHERE id = ?').run(stored, user.accountId);
    const before = f.snapshot(),
      result = await observe();
    assert.equal(Object.getPrototypeOf(result), null);
    assert.deepEqual({ ...result }, { accountId: user.accountId, roles });
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result!.roles));
    assert.deepEqual(f.snapshot(), before);
  }
  const captured = await observe();
  f.db.prepare('UPDATE "user" SET role = ? WHERE id = ?').run('reader', user.accountId);
  assert.deepEqual((await observe())!.roles, ['reader']);
  assert.deepEqual(captured!.roles, ['admin', 'reviewer']);
  assert.equal('lookupEligibleAccountRolesCurrent' in f.runtime, false);
  assert.equal('lookupEligibleAccountRolesCurrent' in { ...f.binding }, false);
  for (const role of ['reader\u0000,admin', new Uint8Array([97])]) {
    f.db.prepare('UPDATE "user" SET role = ? WHERE id = ?').run(role, user.accountId);
    await assert.rejects(observe(), safeError);
  }
  await assert.rejects(f.binding.lookupEligibleAccountRolesCurrent('\ud800'), safeError);
  f.db.prepare('UPDATE "user" SET role = NULL, banned = 1, banExpires = NULL WHERE id = ?').run(user.accountId);
  assert.equal(await observe(), null);
  const boundary = Date.now();
  f.db.prepare('UPDATE "user" SET banExpires = ? WHERE id = ?').run(new Date(boundary).toISOString(), user.accountId);
  const clock = t.mock.method(Date, 'now', () => boundary);
  assert.equal(await observe(), null);
  clock.mock.restore();
  t.mock.method(Date, 'now', () => boundary + 1);
  assert.deepEqual({ ...(await observe()) }, { accountId: user.accountId, roles: [] });
  assert.equal(await f.binding.lookupEligibleAccountRolesCurrent('missing'), null);
  f.binding.close();
  await assert.rejects(observe(), safeError);
});

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-auth-eligibility-'));
  let binding: AppAuthRuntimeBinding | undefined, db: DatabaseSync | undefined;
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
    t.mock.restoreAll();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    binding?.close();
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const names = ['BETTER_AUTH_SECRET', 'MISTRI_AUTH_ADMIN_EMAIL', 'MISTRI_AUTH_ADMIN_PASSWORD'] as const;
  const environment = names.map((name) => [name, process.env[name]] as const);
  process.env.BETTER_AUTH_SECRET = 'synthetic-eligibility-secret-at-least-thirty-two-characters';
  delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
  delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
  let runtime: AppAuthRuntime;
  try {
    runtime = await createAppAuth(
      {
        path: join(directory, 'app.ts'),
        dir: directory,
        pages: [],
        sources: {},
        app: parseAppConfig(
          {
            id: 'eligibility',
            name: 'Eligibility',
            auth: { store: 'auth.db', signUp: 'open' },
            resources: { item: {} },
            views: { items: { kind: 'list', from: 'item' } },
            home: 'items',
          },
          'fixture',
        ),
      },
      { baseURL: origin, trustedOrigins: [origin] },
    );
    binding = captureAppAuthRuntime(runtime);
  } finally {
    for (const [name, value] of environment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  db = new DatabaseSync(runtime.store);
  const call = async (path: string, body: Record<string, unknown>, cookie = '') => {
    const response = await fetch(origin + path, {
      method: 'POST',
      signal: AbortSignal.timeout(5_000),
      headers: { origin, cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { response, text };
  };
  const signup = async (email = 'eligible@example.test') => {
    const { response, text } = await call('/api/auth/sign-up/email', {
      name: 'PRIVATE_ELIGIBILITY_NAME',
      email,
      password: 'synthetic-eligibility-password-123',
    });
    assert.equal(response.status, 200);
    const user = JSON.parse(text).user as { id: string };
    assert.equal(typeof user.id, 'string');
    return {
      accountId: user.id,
      email,
      cookie: response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; '),
    };
  };
  const snapshot = () =>
    ['user', 'account', 'session', 'verification'].map((table) => db!.prepare(`SELECT * FROM "${table}" ORDER BY id COLLATE BINARY`).all());
  return { runtime, binding, db, call, signup, snapshot };
}

test('eligibility is synchronous exact native-ID observation, with no profile/provider or HTTP exposure', async (t) => {
  const f = await fixture(t),
    user = await f.signup();
  const before = f.snapshot();
  const result = eligible(f.binding, user.accountId);
  assert.throws(() => {
    (result as { accountId: string }).accountId = 'changed';
  }, TypeError);
  const provider = f.db.prepare('SELECT id FROM account WHERE userId = ?').get(user.accountId);
  assert.ok(provider && typeof provider.id === 'string');
  const oppositeCase = user.accountId.replace(/[a-zA-Z]/g, (value) =>
    value === value.toLowerCase() ? value.toUpperCase() : value.toLowerCase(),
  );
  assert.notEqual(oppositeCase, user.accountId);
  for (const other of [user.email, provider.id, oppositeCase, 'missing', `${user.accountId}x`, "' OR 1=1 --"])
    assert.equal(f.binding.lookupEligibleAccount(other), null);
  assert.deepEqual(f.snapshot(), before);
  assert.equal('lookupEligibleAccount' in f.runtime, false);
  assert.equal('lookupEligibleAccount' in { ...f.binding }, false);
  assert.ok(Object.isFrozen(f.binding));
  assert.equal(Object.getOwnPropertyDescriptor(f.binding, 'lookupEligibleAccount')?.writable, false);
  for (const data of [f.runtime, f.binding, signInInfo(f.runtime, 'Eligibility')]) {
    const serialized = JSON.stringify(data);
    for (const secret of [user.accountId, user.email, 'PRIVATE_ELIGIBILITY_NAME', 'lookupEligibleAccount'])
      assert.equal(serialized.includes(secret), false);
  }
  const unknown = await f.call('/api/auth/lookup-eligible-account', { accountId: user.accountId });
  assert.equal(unknown.response.status, 404);
  assert.equal(unknown.text.includes(user.accountId), false);
});

test('native logout and absence of any login do not revoke account eligibility; deletion does', async (t) => {
  const f = await fixture(t),
    user = await f.signup();
  const proof = await f.binding.sessionInstance(request(user.cookie));
  assert.ok(proof);
  assert.equal((await f.call('/api/auth/sign-out', {}, user.cookie)).response.status, 200);
  assert.equal(await f.binding.sessionInstance(request(user.cookie)), null);
  assert.throws(() => f.binding.assertSessionCurrent(proof), safeError);
  const before = f.snapshot();
  eligible(f.binding, user.accountId);
  assert.deepEqual(f.snapshot(), before);
  f.db.prepare('DELETE FROM "user" WHERE id = ?').run(user.accountId);
  assert.equal(f.binding.lookupEligibleAccount(user.accountId), null);
  assert.equal(f.binding.lookupAccount(user.accountId), null);
});

test('native temporary/permanent ban and unban are observed without changing existence lookup or native data', async (t) => {
  const f = await fixture(t),
    user = await f.signup(),
    admin = await f.signup('operator@example.test');
  f.db.prepare('UPDATE "user" SET role = ? WHERE id = ?').run('admin', admin.accountId);
  // Better Auth's own ban door is closed (auth.ts closedNativeAdminPath): the accounts screen deactivates.
  const door = await f.call('/api/auth/admin/ban-user', { userId: user.accountId, banReason: 'PRIVATE_ELIGIBILITY_REASON' }, admin.cookie);
  assert.equal(door.response.status, 404);
  assert.equal(f.db.prepare('SELECT banned FROM "user" WHERE id = ?').get(user.accountId)!.banned, 0);
  for (const duration of [60, undefined]) {
    // The row a native ban writes, temporary or permanent.
    f.db
      .prepare('UPDATE "user" SET banned = 1, banReason = ?, banExpires = ? WHERE id = ?')
      .run(
        'PRIVATE_ELIGIBILITY_REASON',
        duration === undefined ? null : new Date(Date.now() + duration * 1000).toISOString(),
        user.accountId,
      );
    const before = f.snapshot();
    assert.equal(f.binding.lookupEligibleAccount(user.accountId), null);
    assert.equal(f.binding.lookupAccount(user.accountId)?.accountId, user.accountId);
    assert.deepEqual(f.snapshot(), before);
    const login = await f.call('/api/auth/sign-in/email', { email: user.email, password: 'synthetic-eligibility-password-123' });
    assert.equal(login.response.status, 403);
    f.db.prepare('UPDATE "user" SET banned = 0, banReason = NULL, banExpires = NULL WHERE id = ?').run(user.accountId);
    eligible(f.binding, user.accountId);
  }
});

test('account eligibility follows native ban expiry without broadening an issued session proof or unbanning the account', async (t) => {
  const f = await fixture(t),
    user = await f.signup();
  const proof = await f.binding.sessionInstance(request(user.cookie));
  assert.ok(proof);
  const boundary = Date.now();
  f.db
    .prepare('UPDATE "user" SET banned = 1, banExpires = ?, banReason = ? WHERE id = ?')
    .run(new Date(boundary).toISOString(), 'PRIVATE_ELIGIBILITY_REASON', user.accountId);
  const before = f.snapshot();
  let now = boundary - 1;
  const clock = t.mock.method(Date, 'now', () => now);
  try {
    for (now of [boundary - 1, boundary]) {
      assert.equal(f.binding.lookupEligibleAccount(user.accountId), null);
      assert.throws(() => f.binding.assertSessionCurrent(proof), safeError);
      const login = await f.call('/api/auth/sign-in/email', { email: user.email, password: 'synthetic-eligibility-password-123' });
      assert.equal(login.response.status, 403);
    }
    now = boundary + 1;
    eligible(f.binding, user.accountId);
    assert.throws(
      () => f.binding.assertSessionCurrent(proof),
      safeError,
      'an expired ban must not broaden an already-issued session proof',
    );
    assert.deepEqual(f.snapshot(), before, 'observations must not clear the native ban or update other account/session data');
    const login = await f.call('/api/auth/sign-in/email', { email: user.email, password: 'synthetic-eligibility-password-123' });
    assert.equal(login.response.status, 200, 'the installed native login agrees at boundary + 1ms');
  } finally {
    clock.mock.restore();
  }
  const native = f.db.prepare('SELECT banned, banExpires, banReason FROM "user" WHERE id = ?').get(user.accountId)!;
  assert.equal(native.banned, 0);
  assert.equal(native.banExpires, null);
  assert.equal(native.banReason, null);
});

test('nullable/unbanned native states remain eligible regardless of valid expiry, role, provider or email verification', async (t) => {
  const f = await fixture(t),
    user = await f.signup();
  f.db.prepare('UPDATE "user" SET role = ?, emailVerified = 0 WHERE id = ?').run('PRIVATE_ELIGIBILITY_ROLE', user.accountId);
  f.db.prepare('DELETE FROM account WHERE userId = ?').run(user.accountId);
  for (const banned of [null, 0])
    for (const expiry of [null, new Date(Date.now() + 60_000).toISOString()]) {
      f.db.prepare('UPDATE "user" SET banned = ?, banExpires = ? WHERE id = ?').run(banned, expiry, user.accountId);
      const before = f.snapshot();
      eligible(f.binding, user.accountId);
      assert.deepEqual(f.snapshot(), before);
    }
});

test('malformed native ban/expiry values fail closed with sanitized errors and no repair or existence change', async (t) => {
  const f = await fixture(t),
    user = await f.signup();
  const invalid: Array<[null | number | string | Uint8Array, null | number | string | Uint8Array]> = [
    [2, null],
    [-1, null],
    [0.5, null],
    ['', null],
    ['false', null],
    [new Uint8Array([0]), null],
    [1, ''],
    [1, 'PRIVATE_ELIGIBILITY_DATE'],
    [1, 0],
    [1, new Uint8Array([0])],
    [1, '2026-02-30T00:00:00.000Z'],
    [1, '2020'],
    [1, '2020-01-01T00:00:00'],
    [1, '2020-01-01T00:00:00.000Z\u0000'],
    [0, 'PRIVATE_ELIGIBILITY_DATE'],
    [null, 'PRIVATE_ELIGIBILITY_DATE'],
  ];
  for (const [banned, expiry] of invalid) {
    f.db.prepare('UPDATE "user" SET banned = ?, banExpires = ? WHERE id = ?').run(banned, expiry, user.accountId);
    const before = f.snapshot();
    assert.throws(() => f.binding.lookupEligibleAccount(user.accountId), safeError, `ban=${String(banned)}, expiry=${String(expiry)}`);
    assert.equal(f.binding.lookupAccount(user.accountId)?.accountId, user.accountId);
    assert.deepEqual(f.snapshot(), before);
  }
});

test('invalid account inputs and runtime clones refuse without coercion or invoking hostile reflection', async (t) => {
  const f = await fixture(t),
    user = await f.signup();
  let hooks = 0;
  const trap = () => {
    hooks++;
    throw new Error('PRIVATE_ELIGIBILITY_INPUT');
  };
  const hostile = { toString: trap, [Symbol.toPrimitive]: trap };
  const { proxy, revoke } = Proxy.revocable(f.runtime, { get: trap, ownKeys: trap, getPrototypeOf: trap });
  for (const value of ['', ' padded ', 'x'.repeat(1025), 'bad\u0000id', null, undefined, 1, hostile, proxy])
    assert.throws(() => f.binding.lookupEligibleAccount(value as string), safeError);
  for (const value of [{ ...f.runtime }, Object.create(f.runtime), { ...f.binding }, Object.create(f.binding), proxy])
    assert.throws(() => captureAppAuthRuntime(value as AppAuthRuntime), safeError);
  revoke();
  assert.throws(() => captureAppAuthRuntime(proxy), safeError);
  assert.throws(() => f.binding.lookupEligibleAccount(proxy as unknown as string), safeError);
  assert.equal(hooks, 0);
  eligible(f.binding, user.accountId);
});

test('retained eligibility refuses tampered runtime values, descriptors and prototype before lookup', async (t) => {
  const f = await fixture(t),
    user = await f.signup();
  let hooks = 0;
  for (const name of Reflect.ownKeys(f.runtime)) {
    const original = Object.getOwnPropertyDescriptor(f.runtime, name)!;
    try {
      Object.defineProperty(f.runtime, name, {
        configurable: true,
        enumerable: true,
        get: () => {
          hooks++;
          throw new Error('PRIVATE_ELIGIBILITY_RUNTIME');
        },
      });
      assert.throws(() => f.binding.lookupEligibleAccount(user.accountId), safeError);
      assert.throws(() => f.binding.lookupEligibleAccount('missing'), safeError);
      Object.defineProperty(f.runtime, name, { ...original, writable: !original.writable });
      assert.throws(() => f.binding.lookupEligibleAccount(user.accountId), safeError);
      Object.defineProperty(f.runtime, name, { ...original, value: undefined });
      assert.throws(() => f.binding.lookupEligibleAccount(user.accountId), safeError);
    } finally {
      Object.defineProperty(f.runtime, name, original);
    }
  }
  const prototype = Object.getPrototypeOf(f.runtime);
  try {
    Object.setPrototypeOf(f.runtime, {});
    assert.throws(() => f.binding.lookupEligibleAccount(user.accountId), safeError);
  } finally {
    Object.setPrototypeOf(f.runtime, prototype);
  }
  assert.equal(hooks, 0);
  eligible(f.binding, user.accountId);
});

for (const close of ['binding', 'runtime'] as const) {
  test(`eligibility retained before ${close} closure fails closed, including missing IDs`, async (t) => {
    const f = await fixture(t),
      user = await f.signup();
    const lookup = f.binding.lookupEligibleAccount;
    f[close].close();
    f[close].close();
    assert.throws(() => lookup(user.accountId), safeError);
    assert.throws(() => lookup('missing'), safeError);
    assert.throws(() => captureAppAuthRuntime(f.runtime), safeError);
  });
}

test('post-observation lifecycle check refuses both eligibility and ban denial after reentrant runtime tampering', async (t) => {
  const f = await fixture(t),
    user = await f.signup();
  const original = f.runtime.handler;
  for (const banned of [0, 1]) {
    f.db.prepare('UPDATE "user" SET banned = ? WHERE id = ?').run(banned, user.accountId);
    const clock = t.mock.method(Date, 'now', () => {
      f.runtime.handler = async () => {};
      return 1;
    });
    try {
      assert.throws(() => f.binding.lookupEligibleAccount(user.accountId), safeError);
    } finally {
      clock.mock.restore();
      f.runtime.handler = original;
    }
  }
  const clock = t.mock.method(Date, 'now', () => {
    f.binding.close();
    return 1;
  });
  try {
    assert.throws(() => f.binding.lookupEligibleAccount(user.accountId), safeError);
  } finally {
    clock.mock.restore();
  }
});

test('a missing native row cannot release null after closure during the actual SQL observation', async (t) => {
  const f = await fixture(t);
  const prepare = DatabaseSync.prototype.prepare;
  const nativePrepare = t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql);
    if (sql.includes('AS banExpiresNul')) {
      const get = statement.get;
      t.mock.method(statement, 'get', (...args: Parameters<typeof get>) => {
        const row = get.apply(statement, args);
        assert.equal(row, undefined);
        f.binding.close();
        return row;
      });
    }
    return statement;
  });
  try {
    assert.throws(() => f.binding.lookupEligibleAccount('missing'), safeError);
  } finally {
    nativePrepare.mock.restore();
  }
});

for (const present of [false, true])
  for (const owner of ['binding', 'runtime'] as const) {
    test(`current roles refuse ${present ? 'valid' : 'missing'} SQL result after ${owner} retirement`, async (t) => {
      const f = await fixture(t),
        user = await f.signup();
      const lookup = f.binding.lookupEligibleAccountRolesCurrent;
      const prepare = DatabaseSync.prototype.prepare;
      let reads = 0;
      let observedPresent: boolean | undefined;
      const instrument = t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
        const statement = prepare.call(this, sql);
        if (sql.includes('AS roleNul')) {
          const get = statement.get;
          t.mock.method(statement, 'get', (...args: Parameters<typeof get>) => {
            const row = get.apply(statement, args);
            reads++;
            observedPresent = row !== undefined;
            f[owner].close();
            return row;
          });
        }
        return statement;
      });
      try {
        await assert.rejects(lookup(present ? user.accountId : 'missing'), safeError);
        assert.equal(reads, 1);
        assert.equal(observedPresent, present);
      } finally {
        instrument.mock.restore();
      }
    });
  }

test('retained current roles refuse runtime descriptor tampering without invoking getters', async (t) => {
  const f = await fixture(t),
    user = await f.signup();
  const lookup = f.binding.lookupEligibleAccountRolesCurrent;
  let hooks = 0;
  for (const name of Reflect.ownKeys(f.runtime)) {
    const original = Object.getOwnPropertyDescriptor(f.runtime, name)!;
    try {
      Object.defineProperty(f.runtime, name, {
        configurable: true,
        enumerable: original.enumerable,
        get: () => {
          hooks++;
          throw new Error('PRIVATE_ELIGIBILITY_RUNTIME');
        },
      });
      await assert.rejects(lookup(user.accountId), safeError);
      await assert.rejects(lookup('missing'), safeError);
      Object.defineProperty(f.runtime, name, { ...original, writable: !original.writable });
      await assert.rejects(lookup(user.accountId), safeError);
    } finally {
      Object.defineProperty(f.runtime, name, original);
    }
  }
  assert.equal(hooks, 0);
  assert.ok(await lookup(user.accountId));
});

test('native schema and reflection faults are sanitized before and after observation', async (t) => {
  const f = await fixture(t),
    user = await f.signup();
  const descriptor = Object.getOwnPropertyDescriptor;
  for (const failAt of [1, Reflect.ownKeys(f.runtime).length + 1]) {
    let calls = 0;
    const reflection = t.mock.method(Object, 'getOwnPropertyDescriptor', (target: unknown, key: PropertyKey) => {
      if (target === f.runtime && ++calls === failAt) throw new Error('PRIVATE_ELIGIBILITY_REFLECTION');
      return descriptor(target, key);
    });
    try {
      assert.throws(() => f.binding.lookupEligibleAccount(user.accountId), safeError);
    } finally {
      reflection.mock.restore();
    }
  }
  f.db.exec('ALTER TABLE "user" RENAME COLUMN banExpires TO "PRIVATE_ELIGIBILITY_COLUMN"');
  assert.throws(() => f.binding.lookupEligibleAccount(user.accountId), safeError);
  assert.equal(f.binding.lookupAccount(user.accountId)?.accountId, user.accountId);
});
