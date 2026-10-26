/**
 * Better Auth's per-address limits are on wherever tablewalk serves, not only
 * where NODE_ENV says production, and the test seam that lifts them
 * (`MISTRI_TEST_AUTH_LIMITS=off`, auth.ts authLimitsOffForTests) holds
 * only for a server that listens on loopback.
 */
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApp } from './support/createApp.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { loadApp, type AppHost } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth, TEST_AUTH_LIMITS } from '../packages/mistri/src/server/auth/auth.js';
import { resetSignInState } from '../packages/mistri/src/server/auth/signInState.js';
import { makeDemoDatabase, seedDemoDatabase } from './make-demo-db.js';

process.env.BETTER_AUTH_SECRET = 'test-secret-that-is-at-least-thirty-two-characters-long';

describe("Better Auth's per-address limits", () => {
  let tmp: string;
  let server: Server;
  let origin = '';
  let host: AppHost;
  let loaded: Awaited<ReturnType<typeof loadApp>>;
  const saved = process.env[TEST_AUTH_LIMITS];

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'tablewalk-auth-rate-limit-'));
    const db = join(tmp, 'app.db');
    makeDemoDatabase(db);
    seedDemoDatabase(db, { scale: 3 });
    const dir = join(tmp, 'limited');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'app.json'),
      JSON.stringify({
        name: 'Limited',
        id: 'limited',
        resources: { work_order: {} },
        auth: { providers: ['email'], signUp: 'invite', store: join(tmp, 'auth.db') },
        views: { 'work-orders': { kind: 'list', from: 'work_order' } },
        home: 'work-orders',
        nav: ['work-orders'],
      }),
    );
    loaded = await loadApp(dir);
    const registry = new Registry();
    registry.add({ name: 'rw', url: db, source: 'config' });
    registry.setActive('rw');
    await registry.open('rw');
    host = { app: loaded, pages: [] };
    server = createApp({ registry, apps: [host], bound: { host: '127.0.0.1', port: 0 } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  beforeEach(() => {
    host.auth?.close();
    host.auth = undefined;
    resetSignInState();
  });

  after(() => {
    if (saved === undefined) delete process.env[TEST_AUTH_LIMITS];
    else process.env[TEST_AUTH_LIMITS] = saved;
    server?.close();
    server?.closeAllConnections();
    host.auth?.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /* A new address each time, so the per-account lockout never counts: what answers 429 is the per-address rule. */
  async function attempts(n: number): Promise<number[]> {
    const statuses: number[] = [];
    for (let i = 0; i < n; i++) {
      const res = await fetch(`${origin}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ email: `nobody-${i}@example.org`, password: 'not-the-password-1' }),
      });
      await res.arrayBuffer();
      statuses.push(res.status);
    }
    return statuses;
  }

  test('a loopback server without the seam answers 429 past the limit', async () => {
    delete process.env[TEST_AUTH_LIMITS];
    host.auth = await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin], listenHost: '127.0.0.1' });
    const statuses = await attempts(5);
    assert.deepEqual(statuses.slice(0, 3), [401, 401, 401]);
    assert.ok(
      statuses.slice(3).every((status) => status === 429),
      statuses.join(' '),
    );
  });

  test('the seam lifts the limit on loopback', async () => {
    process.env[TEST_AUTH_LIMITS] = 'off';
    host.auth = await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin], listenHost: '127.0.0.1' });
    assert.deepEqual(await attempts(5), [401, 401, 401, 401, 401]);
  });

  test('the seam is ignored, and said, for a server that listens beyond loopback', async () => {
    process.env[TEST_AUTH_LIMITS] = 'off';
    const said: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => void said.push(args.join(' '));
    try {
      host.auth = await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin], listenHost: '0.0.0.0' });
    } finally {
      console.error = error;
    }
    assert.ok(
      said.some((line) => line.includes(`${TEST_AUTH_LIMITS}=off is ignored`) && line.includes('0.0.0.0')),
      said.join('\n'),
    );
    const statuses = await attempts(5);
    assert.ok(
      statuses.slice(3).every((status) => status === 429),
      statuses.join(' '),
    );
  });
});
