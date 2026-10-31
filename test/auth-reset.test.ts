/**
 * A forgotten password, reset by a one-time link through a real Better Auth
 * instance. tablewalk sends no mail, so the link's one delivery is the
 * server's log (`MISTRI_AUTH_RESET=log`): what this proves is that the link
 * goes there and nowhere else — never into an HTTP answer, which would hand
 * any account to whoever asked — that it works once, and that it ends the
 * sessions the old password held, and the API tokens and OAuth grants made
 * while it held.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApp } from './support/createApp.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { loadApp, type AppHost } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { provisionSqliteApiTokenStore } from '../packages/mistri/src/server/auth/provisionSqliteApiTokenStore.js';
import { captureAuthStoreExclusion } from '../packages/mistri/src/server/auth/sqliteStoreIdentity.js';
import { accountCredentials } from './support/accountCredentials.js';
import { makeDemoDatabase, seedDemoDatabase } from './make-demo-db.js';

process.env.BETTER_AUTH_SECRET = 'test-secret-that-is-at-least-thirty-two-characters-long';

describe('a password reset by a logged link', () => {
  let tmp: string;
  let server: Server;
  let origin = '';
  let host: AppHost;
  const logged: string[] = [];
  const log = console.log;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'tablewalk-auth-reset-'));
    const db = join(tmp, 'app.db');
    makeDemoDatabase(db);
    seedDemoDatabase(db, { scale: 3 });
    const dir = join(tmp, 'secured');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'app.json'),
      JSON.stringify({
        name: 'Secured',
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
    process.env.MISTRI_AUTH_RESET = 'log';
    try {
      // The auth file first, then its API token store beside the accounts, then the server on both.
      (await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin], development: true })).close();
      provisionSqliteApiTokenStore(join(tmp, 'auth.db'), {
        appId: loaded.app.id,
        storeId: randomUUID(),
        exclusions: [captureAuthStoreExclusion(db)],
      });
      host.auth = await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin], development: true });
    } finally {
      delete process.env.MISTRI_AUTH_RESET;
    }
    console.log = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    };
  });

  after(() => {
    console.log = log;
    server?.close();
    server?.closeAllConnections();
    host.auth?.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const call = async (path: string, init: RequestInit & { cookie?: string } = {}) => {
    const headers: Record<string, string> = { origin, ...((init.headers as Record<string, string>) ?? {}) };
    if (init.cookie) headers.cookie = init.cookie;
    if (init.body) headers['content-type'] = 'application/json';
    const res = await fetch(`${origin}${path}`, { ...init, headers, redirect: 'manual' });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return {
      status: res.status,
      json,
      text,
      location: res.headers.get('location'),
      cookie: res.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; '),
    };
  };
  const post = (path: string, body: unknown, cookie?: string) =>
    call(path, { method: 'POST', body: JSON.stringify(body), ...(cookie ? { cookie } : {}) });

  test('the door says a forgotten password is reset by a link', async () => {
    const me = await call('/api/whoami');
    assert.deepEqual((me.json.signIn as Record<string, unknown>).reset, 'link');
  });

  test('the link is logged, never answered, works once, and ends the old sessions', async () => {
    const up = await post('/api/auth/sign-up/email', { name: 'Ada', email: 'ada@example.org', password: 'first-password-1' });
    assert.equal(up.status, 200, up.text);
    const old = up.cookie;
    assert.equal((await call('/api/whoami', { cookie: old })).json.who, 'ada@example.org');

    // A token and a grant made while the old password held: whoever held it may have made them.
    const account = String((up.json.user as { id: string }).id);
    const revoked = accountCredentials(join(tmp, 'auth.db'), host.app.app.id, account);
    assert.deepEqual(revoked(), { token: false, grant: false });

    const back = `${origin}/secured/sign-in?reset=1`;
    const asked = await post('/api/auth/request-password-reset', { email: 'ada@example.org', redirectTo: back });
    assert.equal(asked.status, 200, asked.text);
    const line = logged.find((said) => said.includes('ada@example.org'));
    assert.ok(line, 'the link is written to the log');
    const link = /(https?:\/\/\S+)/.exec(line!)![1];
    const token = /reset-password\/([^?]+)/.exec(link)![1];
    // The answer says the same whether or not the address has an account, and never the link.
    assert.equal(asked.text.includes(token), false);
    const nobody = await post('/api/auth/request-password-reset', { email: 'nobody@example.org', redirectTo: back });
    assert.equal(nobody.status, 200);
    assert.deepEqual(nobody.json, asked.json);
    assert.equal(
      logged.some((said) => said.includes('nobody@example.org')),
      false,
    );

    // The link comes back to the sign-in screen, marked, with its token.
    const opened = await call(new URL(link).pathname + new URL(link).search);
    assert.equal(opened.status, 302);
    const landed = new URL(opened.location!);
    assert.equal(landed.pathname, '/secured/sign-in');
    assert.equal(landed.searchParams.get('reset'), '1');
    assert.equal(landed.searchParams.get('token'), token);

    const changed = await post('/api/auth/reset-password', { newPassword: 'second-password-2', token });
    assert.equal(changed.status, 200, changed.text);
    // Its tokens and grants end with its sessions.
    assert.deepEqual(revoked(), { token: true, grant: true });
    // Once: the same token is refused after it is spent.
    const again = await post('/api/auth/reset-password', { newPassword: 'third-password-3', token });
    assert.equal(again.status, 400);
    assert.equal(again.json.code, 'INVALID_TOKEN');
    // The old password's session is over; the old password no longer opens the door; the new one does.
    assert.equal((await call('/api/whoami', { cookie: old })).json.who, null);
    assert.equal((await post('/api/auth/sign-in/email', { email: 'ada@example.org', password: 'first-password-1' })).status, 401);
    assert.equal((await post('/api/auth/sign-in/email', { email: 'ada@example.org', password: 'second-password-2' })).status, 200);
  });
});
