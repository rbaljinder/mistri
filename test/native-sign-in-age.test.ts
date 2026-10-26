/** Genuine native sign-in age without changing the public session proof shape. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import {
  captureAppAuthRuntime,
  captureNativeSignInAge,
  createAppAuth,
  type AppAuthRuntime,
  type AppAuthRuntimeBinding,
  type VerifiedSessionInstance,
} from '../packages/mistri/src/server/auth/auth.js';
import { migratePostgresAuthStore } from '../packages/mistri/src/adapters/auth/postgresAuthStore.js';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import { dedicatedPostgresUrl, TENANT_DIALECTS } from './support/tenantDialects.js';

const request = (cookie: string) => ({ headers: { cookie } }) as IncomingMessage;
const refused = (error: unknown) => {
  assert.ok(error instanceof TenantContextError);
  assert.equal(error.message, 'The tenant context could not be verified.');
  assert.equal(Object.hasOwn(error, 'cause'), false);
  return true;
};
interface Control extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}

async function fixture(t: TestContext, dialect: 'sqlite' | 'postgres') {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-sign-in-age-'));
  let runtime: AppAuthRuntime | undefined, binding: AppAuthRuntimeBinding | undefined;
  let db: DatabaseSync | undefined, control: Control | undefined;
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
    runtime?.close();
    db?.close();
    if (control) {
      await control.query('DROP SCHEMA IF EXISTS mistri CASCADE');
      await control.end();
    }
    rmSync(directory, { recursive: true, force: true });
  });
  let store = join(directory, 'auth.db');
  if (dialect === 'postgres') {
    store = await dedicatedPostgresUrl('signin_age');
    const specifier = 'pg';
    const pg = (await import(specifier)) as { default: { Client: new (options: unknown) => Control } };
    control = new pg.default.Client({ connectionString: store });
    await control.connect();
    await control.query('DROP SCHEMA IF EXISTS mistri CASCADE');
    await migratePostgresAuthStore(store);
  }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const environment = ['BETTER_AUTH_SECRET', 'MISTRI_AUTH_ADMIN_EMAIL', 'MISTRI_AUTH_ADMIN_PASSWORD'].map(
    (name) => [name, process.env[name]] as const,
  );
  process.env.BETTER_AUTH_SECRET = 'synthetic-sign-in-age-secret-at-least-thirty-two-characters';
  delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
  delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
  try {
    runtime = await createAppAuth(
      {
        path: join(directory, 'app.ts'),
        dir: directory,
        pages: [],
        sources: {},
        app: parseAppConfig(
          {
            id: 'signin-age',
            name: 'Age',
            auth: { store, signUp: 'open' },
            resources: { item: {} },
            views: { items: { kind: 'list', from: 'item' } },
            home: 'items',
          },
          'fixture',
        ),
      },
      { baseURL: origin, trustedOrigins: [origin] },
    );
  } finally {
    for (const [name, value] of environment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  binding = captureAppAuthRuntime(runtime);
  if (dialect === 'sqlite') db = new DatabaseSync(store);
  const response = await fetch(origin + '/api/auth/sign-up/email', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Age', email: 'age@example.test', password: 'synthetic-age-password-123' }),
  });
  assert.equal(response.status, 200);
  await response.text();
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const sql = async (text: string, values: (string | number | null)[] = []) => {
    if (control) {
      let n = 0;
      return (
        await control.query(
          text.replace(/AUTH\."(\w+)"/g, 'mistri.auth_$1').replace(/\?/g, () => `$${++n}`),
          values,
        )
      ).rows;
    }
    return db!.prepare(text.replaceAll('AUTH.', '')).all(...values);
  };
  const proof = await binding.sessionInstance(request(cookie));
  assert.ok(proof);
  const rows = await sql('SELECT "createdAt" FROM AUTH."session" WHERE id = ?', [proof.sessionId]);
  const createdAt = new Date(rows[0].createdAt as string).getTime();
  assert.ok(Number.isSafeInteger(createdAt));
  return { runtime, binding, cookie, proof, createdAt, sql, age: captureNativeSignInAge(runtime) };
}

for (const { dialect, skip } of TENANT_DIALECTS) {
  test(`${dialect}: native age is private, exact and bound to issued proof identity`, { skip }, async (t) => {
    const f = await fixture(t, dialect),
      at = f.createdAt + 300000;
    t.mock.method(Date, 'now', () => at);
    assert.equal(f.age.synchronous, dialect === 'sqlite');
    assert.ok(Object.isFrozen(f.age));
    assert.deepEqual(Object.keys(f.proof).sort(), ['expiresAt', 'identity', 'sessionId']);
    assert.equal('authenticatedAt' in f.binding, false);
    await f.age.observeRecent(f.proof, at, 300000);
    assert.throws(() => f.age.assertAge(f.proof, at + 1, 300000), refused);
    for (const timestamp of [NaN, Infinity, -1, f.createdAt - 1, f.proof.expiresAt]) {
      assert.throws(() => f.age.assertAge(f.proof, timestamp, 300000), refused);
    }
    for (const maximum of [-1, NaN, Infinity, 1.2]) assert.throws(() => f.age.assertAge(f.proof, at, maximum), refused);
    const copied = { ...f.proof };
    const proxy = new Proxy(f.proof, {
      get() {
        throw new Error('must not inspect proxy');
      },
    });
    for (const proof of [copied, proxy, {} as VerifiedSessionInstance]) {
      assert.throws(() => f.age.assertAge(proof, at, 300000), refused);
    }
    const unissued = await f.runtime.sessionInstance!(request(f.cookie));
    assert.ok(unissued);
    assert.throws(() => f.age.assertAge(unissued, at, 300000), refused);
    assert.throws(() => captureNativeSignInAge({ ...f.runtime }), refused);
    const foreign = await fixture(t, 'sqlite');
    assert.throws(() => f.age.assertAge(foreign.proof, at, 300000), refused);
    // UpdatedAt/refresh metadata cannot reset captured sign-in time.
    await f.sql('UPDATE AUTH."session" SET "updatedAt" = ? WHERE id = ?', [new Date(at).toISOString(), f.proof.sessionId]);
    await f.age.observeRecent(f.proof, at, 300000);
    await f.sql('UPDATE AUTH."session" SET "createdAt" = ? WHERE id = ?', [new Date(f.createdAt + 1).toISOString(), f.proof.sessionId]);
    await f.binding.observeSession(f.proof); // Ordinary compatibility: no age assertion.
    await assert.rejects(async () => f.age.observeRecent(f.proof, at, 300000), refused);
    f.runtime.close();
    assert.throws(() => f.age.assertAge(f.proof, at, 300000), refused);
  });

  test(`${dialect}: malformed or future native age refuses only opening; native revocation remains current`, { skip }, async (t) => {
    const f = await fixture(t, dialect),
      now = Date.now();
    for (const createdAt of [new Date(now + 60000).toISOString(), ...(dialect === 'sqlite' ? ['invalid-date'] : ['infinity'])]) {
      await f.sql('UPDATE AUTH."session" SET "createdAt" = ? WHERE id = ?', [createdAt, f.proof.sessionId]);
      const proof = await f.binding.sessionInstance(request(f.cookie));
      assert.ok(proof);
      await f.binding.observeSession(proof);
      assert.throws(() => f.age.assertAge(proof, now, 300000), refused);
    }
    await f.sql('UPDATE AUTH."session" SET "createdAt" = ? WHERE id = ?', [new Date(f.createdAt).toISOString(), f.proof.sessionId]);
    await f.age.observeRecent(f.proof, now, 300000);
    await f.sql('DELETE FROM AUTH."session" WHERE id = ?', [f.proof.sessionId]);
    await assert.rejects(async () => f.age.observeRecent(f.proof, now, 300000), refused);
  });

  test(`${dialect}: expiry and clock crossing during native observation refuse`, { skip }, async (t) => {
    const f = await fixture(t, dialect),
      boundary = f.createdAt + 300000;
    // Native checkSession reads Date.now for expiry after its real SQL returns.
    // The capability must obtain a later clock, not reuse the caller's boundary.
    let ticks = 0;
    const clock = t.mock.method(Date, 'now', () => boundary + (ticks++ === 0 ? 0 : 1));
    await assert.rejects(async () => f.age.observeRecent(f.proof, boundary, 300000), refused);
    clock.mock.restore();
    t.mock.method(Date, 'now', () => f.proof.expiresAt);
    await assert.rejects(async () => f.age.observeRecent(f.proof, f.createdAt, 300000), refused);
  });

  test(`${dialect}: native age checks retain runtime lifetime ownership`, { skip }, async (t) => {
    const f = await fixture(t, dialect),
      now = Date.now(),
      original = f.runtime.store;
    if (!f.age.synchronous) {
      const pending = f.age.observeRecent(f.proof, now, 300000);
      // The actual PG observation has started; mutate before its continuation.
      f.runtime.store = 'retargeted-private-store';
      await assert.rejects(pending, refused);
    } else {
      f.runtime.store = 'retargeted-private-store';
      assert.throws(() => f.age.observeRecent(f.proof, now, 300000), refused);
    }
    f.runtime.store = original;
    f.runtime.close();
    await assert.rejects(async () => f.age.observeRecent(f.proof, now, 300000), refused);
  });
}

test('sqlite: native createdAt NUL corruption cannot pass through a truncated TEXT projection', async (t) => {
  const f = await fixture(t, 'sqlite');
  const prefix = new Date(f.createdAt).toISOString();
  await f.sql('UPDATE AUTH."session" SET "createdAt" = ? WHERE id = ?', [prefix + '\u0000hidden', f.proof.sessionId]);
  const [row] = await f.sql('SELECT "createdAt", instr("createdAt", char(0)) AS nul FROM AUTH."session" WHERE id = ?', [f.proof.sessionId]);
  // The native projection may truncate the tail; SQL must inspect stored bytes.
  assert.ok(row.createdAt === prefix || row.createdAt === prefix + '\u0000hidden');
  t.diagnostic(row.createdAt === prefix ? 'Native TEXT projection truncates at NUL.' : 'Native TEXT projection preserves NUL.');
  assert.equal(row.nul, prefix.length + 1);
  await f.binding.observeSession(f.proof); // Existing ordinary-session behavior.
  await assert.rejects(async () => f.age.observeRecent(f.proof, Date.now(), 300000), refused);
});
