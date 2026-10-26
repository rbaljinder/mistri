import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { captureAppAuthRuntime, createAppAuth, type AppAuthRuntimeBinding } from '../../packages/mistri/src/server/auth/auth.js';
import type { LoadedApp } from '../../packages/mistri/src/server/app/apps.js';
import { provisionSqliteTenantAdministrationJournal } from '../../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import { provisionSqliteTenantStore } from '../../packages/mistri/src/server/tenant/tenantStore.js';
import { parseAppConfig } from '../../packages/mistri/src/shared/app.js';

// Concurrent fixtures must not restore another fixture's temporary environment.
let authCreation = Promise.resolve();

export async function tenantAdministrationFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-administration-'));
  const path = join(directory, 'business.db');
  const binding = { appId: 'admin-app', source: { id: 'business', connection: 'business' }, storeId: 'admin-store' };
  let native: AppAuthRuntimeBinding | undefined;
  let closeAuth: (() => void) | undefined;
  let db: DatabaseSync | undefined, authDb: DatabaseSync | undefined;
  const cleanups: (() => Promise<void>)[] = [];
  const handlers = new Set<Promise<void>>();
  const server = createServer((req, res) => {
    if (!native) {
      res.writeHead(503);
      res.end();
      return;
    }
    const pending = native.handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    handlers.add(pending);
    void pending.then(() => handlers.delete(pending));
  });
  t.after(async () => {
    const errors: unknown[] = [];
    const attempt = async (work: () => void | Promise<void>) => {
      try {
        await work();
      } catch (error) {
        errors.push(error);
      }
    };
    // Retire service owners while their native verifier and SQLite stores live.
    for (const cleanup of cleanups.reverse()) await attempt(cleanup);
    await attempt(async () => {
      if (server.listening)
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      await Promise.all(handlers);
    });
    await attempt(() => closeAuth?.());
    await attempt(() => authDb?.close());
    await attempt(() => db?.close());
    await attempt(() => rmSync(directory, { recursive: true, force: true }));
    if (errors.length) throw new AggregateError(errors, 'Tenant administration fixture cleanup failed');
  });

  db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE business_record(id TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO business_record VALUES ('one', 'original')`);
  provisionSqliteTenantStore(path, binding);
  provisionSqliteTenantAdministrationJournal(path, binding);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const loaded: LoadedApp = {
    path: join(directory, 'app.ts'),
    dir: directory,
    pages: [],
    sources: {},
    app: parseAppConfig(
      {
        id: binding.appId,
        name: 'Administration Fixture',
        resources: { business_record: {} },
        views: { records: { kind: 'list', from: 'business_record' } },
        home: 'records',
        auth: { store: 'auth.db', signUp: 'open' },
      },
      'tenant administration fixture',
    ),
  };
  const creating = authCreation.then(async () => {
    const names = ['BETTER_AUTH_SECRET', 'MISTRI_AUTH_ADMIN_EMAIL', 'MISTRI_AUTH_ADMIN_PASSWORD'] as const;
    const environment = names.map((name) => [name, process.env[name]] as const);
    process.env.BETTER_AUTH_SECRET = 'synthetic-tenant-administration-secret-at-least-thirty-two-characters';
    delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
    delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
    try {
      return await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin] });
    } finally {
      for (const [name, value] of environment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
  authCreation = creating.then(
    () => {},
    () => {},
  );
  const auth = await creating;
  closeAuth = auth.close;
  native = captureAppAuthRuntime(auth);
  authDb = new DatabaseSync(auth.store);

  const callNative = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers({ origin, 'content-type': 'application/json' });
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    const response = await fetch(origin + path, {
      ...init,
      headers,
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000),
    });
    return { response, body: (await response.json()) as Record<string, unknown> };
  };
  const signup = async (name: string) => {
    const credentials = { name, email: `${name}@example.test`, password: `tenant-administration-${name}-password-123` };
    const signedUp = await callNative('/api/auth/sign-up/email', { method: 'POST', body: JSON.stringify(credentials) });
    assert.equal(signedUp.response.status, 200, JSON.stringify(signedUp.body));
    const signedIn = await callNative('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email: credentials.email, password: credentials.password }),
    });
    assert.equal(signedIn.response.status, 200, JSON.stringify(signedIn.body));
    const cookie = signedIn.response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    assert.ok(cookie);
    const request = { headers: { cookie, origin } } as IncomingMessage;
    const proof = await native!.sessionInstance(request);
    assert.ok(proof);
    assert.equal(proof.identity.id, (signedUp.body.user as { id: string }).id);
    return { accountId: proof.identity.id, cookie, request };
  };
  const users = { operator: await signup('operator'), target: await signup('target'), outsider: await signup('outsider') };
  return {
    directory,
    path,
    binding,
    auth,
    db,
    authDb,
    origin,
    users,
    callNative,
    addCleanup: (cleanup: () => Promise<void>) => {
      cleanups.push(cleanup);
    },
  };
}
