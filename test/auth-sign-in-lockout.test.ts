/**
 * A password sign-in is limited per account as well as per client
 * (packages/mistri/src/server/auth/signInLockout.ts), and the client Better Auth counts and
 * records is the one this server names (trust.ts `forwardedClient`), never a
 * header the client wrote under Better Auth's name for it.
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
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { resetSignInState, signInState } from '../packages/mistri/src/server/auth/signInState.js';
import { ATTEMPTS, LOCKED_MESSAGE } from '../packages/mistri/src/server/auth/signInLockout.js';
import { makeDemoDatabase, seedDemoDatabase } from './make-demo-db.js';

process.env.BETTER_AUTH_SECRET = 'test-secret-that-is-at-least-thirty-two-characters-long';

describe('sign-in lockout and the client address', () => {
  let tmp: string;
  let server: Server;
  let origin = '';
  let host: AppHost;
  const EMAIL = 'ada.lovelace@example.org';
  const PASSWORD = 'correct-horse-battery-staple-9';

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'tablewalk-auth-lockout-'));
    const db = join(tmp, 'app.db');
    makeDemoDatabase(db);
    seedDemoDatabase(db, { scale: 3 });
    const dir = join(tmp, 'secured');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'app.json'),
      JSON.stringify({
        name: 'Secured',
        id: 'secured',
        resources: { work_order: {} },
        auth: { providers: ['email'], signUp: 'open', store: join(tmp, 'auth.db') },
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
    const up = await post('/api/auth/sign-up/email', { name: 'Ada', email: EMAIL, password: PASSWORD });
    assert.equal(up.status, 200, up.text);
  });

  beforeEach(() => resetSignInState());

  after(() => {
    server?.close();
    server?.closeAllConnections();
    host.auth?.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      redirect: 'manual',
    });
    return { status: res.status, text: await res.text(), cookie: res.headers.getSetCookie().join('; ') };
  }
  const signIn = (email: string, password: string, headers?: Record<string, string>) =>
    post('/api/auth/sign-in/email', { email, password }, headers);

  test(`past ${ATTEMPTS} attempts an account is locked, even to its own password`, async () => {
    for (let i = 0; i < ATTEMPTS; i++) assert.equal((await signIn(EMAIL, `wrong-guess-${i}`)).status, 401);
    const locked = await signIn(EMAIL, PASSWORD);
    assert.equal(locked.status, 429, locked.text);
    assert.match(locked.text, new RegExp(LOCKED_MESSAGE.replace(/\./g, '\\.')));
    // Still locked: the lock is not one refusal.
    assert.equal((await signIn(EMAIL, PASSWORD)).status, 429);
  });

  test('an address with no account is counted and refused in the same words', async () => {
    const statuses: number[] = [];
    const texts: string[] = [];
    for (let i = 0; i <= ATTEMPTS; i++) {
      const answer = await signIn('nobody.here@example.org', `wrong-guess-${i}`);
      statuses.push(answer.status);
      texts.push(answer.text);
    }
    assert.deepEqual(statuses, [...Array(ATTEMPTS).fill(401), 429]);
    resetSignInState();
    const real: string[] = [];
    for (let i = 0; i <= ATTEMPTS; i++) real.push((await signIn(EMAIL, `wrong-guess-${i}`)).text);
    assert.deepEqual(real, texts, 'the answers do not tell an account from none');
  });

  test('a sign-in that succeeds takes the count away', async () => {
    for (let i = 0; i < ATTEMPTS - 1; i++) assert.equal((await signIn(EMAIL, `wrong-guess-${i}`)).status, 401);
    assert.equal((await signIn(EMAIL, PASSWORD)).status, 200);
    for (let i = 0; i < ATTEMPTS; i++) assert.equal((await signIn(EMAIL, `wrong-guess-${i}`)).status, 401, `attempt ${i}`);
  });

  test("the session records the client this server names, not a header written under Better Auth's name", async () => {
    // From loopback, X-Forwarded-For is a proxy's word (trust.ts trustedProxyPeer); the made-up header is overwritten.
    const signed = await signIn(EMAIL, PASSWORD, { 'x-forwarded-for': '203.0.113.7', 'x-mistri-client-address': '198.51.100.66' });
    assert.equal(signed.status, 200, signed.text);
    const res = await fetch(`${origin}/api/auth/list-sessions`, { headers: { origin, cookie: signed.cookie } });
    const sessions = (await res.json()) as Array<{ ipAddress?: string }>;
    assert.ok(
      sessions.some((session) => session.ipAddress === '203.0.113.7'),
      JSON.stringify(sessions),
    );
    assert.ok(!sessions.some((session) => session.ipAddress === '198.51.100.66'));
  });
});

test('a flood of pending OAuth requests cannot evict a sign-in lock or a counter', async () => {
  resetSignInState();
  const until = Date.now() + 600_000;
  await signInState.put('signin-lock', 'ada@example.org', { until }, until);
  await signInState.fail('signin:ada@example.org', 600_000);
  for (let i = 0; i < 60_000; i++) await signInState.put('oauth-request', `r${i}`, { n: i }, until);
  assert.deepEqual(await signInState.read('signin-lock', 'ada@example.org'), { until });
  assert.equal(await signInState.failures('signin:ada@example.org'), 1);
  assert.equal(await signInState.read('oauth-request', 'r0'), undefined, 'only other pending requests are pushed out');
  resetSignInState();
});
