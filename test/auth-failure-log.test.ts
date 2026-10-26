/**
 * A sign-in that answers 500 says so on stderr: the route, the error's name and
 * message, the App's id — and nothing the person typed or was given (email,
 * password, token, cookie). A refusal (a wrong password) is a 401 and says
 * nothing: only a failure of the server's is a line.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { authFailureLog } from '../packages/mistri/src/server/auth/authFailureLog.js';
import { createApp } from './support/createApp.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { loadApp, type AppHost } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { makeDemoDatabase, seedDemoDatabase } from './make-demo-db.js';

process.env.BETTER_AUTH_SECRET = 'test-secret-that-is-at-least-thirty-two-characters-long';

describe('a failing auth route is logged once, without secrets', () => {
  let tmp: string;
  let server: Server;
  let origin = '';
  let host: AppHost;
  let authFile = '';
  const errors: string[] = [];
  const error = console.error;
  const EMAIL = 'grace.hopper@example.org';
  const PASSWORD = 'correct-horse-battery-staple-9';

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'tablewalk-auth-failure-'));
    const db = join(tmp, 'app.db');
    makeDemoDatabase(db);
    seedDemoDatabase(db, { scale: 3 });
    const dir = join(tmp, 'secured');
    mkdirSync(dir, { recursive: true });
    authFile = join(tmp, 'auth.db');
    writeFileSync(
      join(dir, 'app.json'),
      JSON.stringify({
        name: 'Secured',
        id: 'secured',
        resources: { work_order: {} },
        auth: { providers: ['email'], signUp: 'open', store: authFile },
        views: { 'work-orders': { kind: 'list', from: 'work_order' } },
        home: 'work-orders',
        nav: ['work-orders'],
      }),
    );
    const loaded = await loadApp(dir);
    const registry = new Registry();
    registry.add({ name: 'rw', url: db, source: 'config' });
    registry.setActive('rw');
    await registry.open('rw');
    host = { app: loaded, pages: [] };
    server = createApp({ registry, apps: [host], bound: { host: '127.0.0.1', port: 0 } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    host.auth = await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin] });
  });

  after(() => {
    console.error = error;
    server?.close();
    server?.closeAllConnections();
    host.auth?.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'manual',
    });
    return { status: res.status, text: await res.text(), cookie: res.headers.getSetCookie().join('; ') };
  };
  const failureLines = () => errors.filter((line) => line.startsWith('mistri: auth '));

  test('a refusal is not a failure, and a store that fails is one line with the route, the error and the App', async () => {
    const up = await post('/api/auth/sign-up/email', { name: 'Grace', email: EMAIL, password: PASSWORD });
    assert.equal(up.status, 200, up.text);
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    };
    const wrong = await post('/api/auth/sign-in/email', { email: EMAIL, password: 'not-the-password-at-all' });
    assert.equal(wrong.status, 401, wrong.text);
    assert.deepEqual(failureLines(), [], 'a wrong password is answered, not logged');

    // The store loses its accounts table under the running server.
    const store = new DatabaseSync(authFile);
    store.exec('ALTER TABLE user RENAME TO user_gone');
    store.close();
    const failed = await post('/api/auth/sign-in/email', { email: EMAIL, password: PASSWORD });
    assert.equal(failed.status, 500, failed.text);

    const lines = failureLines();
    assert.equal(lines.length, 1, errors.join('\n'));
    assert.match(lines[0], /^mistri: auth POST \/api\/auth\/sign-in\/email answered 500 for App "secured": \S+: /);
    for (const secret of [EMAIL, 'grace.hopper', PASSWORD, 'not-the-password', 'tablewalk-secured', 'session_token']) {
      assert.equal(lines[0].includes(secret), false, `the line must not hold ${secret}`);
    }
  });
});

describe('the failure log, apart from the server', () => {
  const request = (url: string, method = 'POST') => ({ url, method }) as never;
  const response = (statusCode: number) => ({ statusCode }) as never;

  test('a handler that throws is logged and still throws; the route drops tokens, ids and the query', async () => {
    const lines: string[] = [];
    const log = authFailureLog('crm', '/crm', (line) => lines.push(line));
    await assert.rejects(
      log.watch(request('/crm/api/auth/reset-password/Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5?email=a@b.co&code=secret'), response(200), async () => {
        log.onError(new TypeError('boom for a@b.co with Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MDEyMzQ1Njc4OQ'));
        throw new Error('hook failed');
      }),
      /hook failed/,
    );
    assert.deepEqual(lines, [
      'mistri: auth POST /api/auth/reset-password/:param answered 500 for App "crm": TypeError: boom for <address> with <redacted>',
    ]);
  });

  test('a 4xx, and a 2xx, are not failures; a 5xx with no error raised still says so, once', async () => {
    const lines: string[] = [];
    const log = authFailureLog('crm', '', (line) => lines.push(line));
    await log.watch(request('/api/auth/sign-in/email'), response(401), async () => log.onError(new Error('Invalid password')));
    await log.watch(request('/api/auth/get-session', 'GET'), response(200), async () => {});
    assert.deepEqual(lines, []);
    await log.watch(request('/api/auth/sign-in/email'), response(502), async () => {});
    assert.deepEqual(lines, ['mistri: auth POST /api/auth/sign-in/email answered 502 for App "crm": no error was raised']);
  });
});
