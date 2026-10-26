/** The OAuth 2.1 authorization server for a tenant App, through the real CLI on
 * both engines: the depot App with two tenants, served by the tenant host under
 * `--policy --api-reads` with the config's `oauth` entry. The consent page
 * offers the person's active memberships and nothing else; the token is that
 * one membership's, reads that tenant's rows only and is never usable in the
 * other; a choice of a tenant the person is not a member of is refused; a
 * membership changed or revoked ends the access token and the grant's
 * refresh. The PostgreSQL case skips unless TABLEWALK_TEST_PG is set, and drops
 * the databases it creates. Nothing leaves 127.0.0.1. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { migratePostgresAuthStore } from '../packages/mistri/src/adapters/auth/postgresAuthStore.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import {
  createSqliteTenantAdministration,
  provisionSqliteTenantStore,
  type TenantStoreAdministration,
} from '../packages/mistri/src/server/tenant/tenantStore.js';
import {
  createPostgresTenantAdministration,
  migratePostgresTenantStore,
} from '../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import { DEPOT_ROWS, DEPOT_STORE, DEPOT_TABLE, SESSION_SECRET, serveApi, tokenCli, writeDepotApp } from './appApiCli.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const PASSWORD = 'synthetic-oauth-tenant-password-123';
const CB = 'http://127.0.0.1:9/cb';
interface Client extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}

/** The depot deployment on one engine with the authorization server named for it, open sign-up and a network API. */
async function depot(t: TestContext, dialect: 'sqlite' | 'postgres') {
  const directory = mkdtempSync(join(tmpdir(), `tw-oauth-tenant-${dialect}-`));
  const cleanup: Array<() => unknown> = [() => rmSync(directory, { recursive: true, force: true })];
  t.after(async () => {
    for (const step of cleanup.reverse())
      await Promise.resolve()
        .then(step)
        .catch(() => {});
  });
  const store = { appId: 'depot', source: { id: 'business', connection: 'data' }, storeId: DEPOT_STORE };
  let business: string, authStore: string, physical: string;
  let maintenance: (run: (admin: TenantStoreAdministration) => Promise<void>) => Promise<void>;
  if (dialect === 'sqlite') {
    business = join(directory, 'business.db');
    authStore = join(directory, 'auth.db');
    physical = 'physical_item';
    const db = new DatabaseSync(business);
    cleanup.push(() => db.close());
    db.exec(`PRAGMA busy_timeout = 10000; ${DEPOT_TABLE(physical)}; ${DEPOT_ROWS(physical)}`);
    migrateSqliteCommandJournal(business);
    provisionSqliteTenantStore(business, store);
    maintenance = async (run) => {
      const operations = new TransactionOperations();
      db.exec('BEGIN IMMEDIATE');
      try {
        await run(createSqliteTenantAdministration(db, operations, store));
        await operations.finish();
        db.exec('COMMIT');
      } catch (error) {
        await operations.finish().catch(() => {});
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    };
  } else {
    const module = 'pg';
    const pg = (await import(module)) as { default: { Client: new (options: unknown) => Client } };
    const control = new pg.default.Client({ connectionString: LIVE, statement_timeout: 10000 });
    await control.connect();
    const names = ['auth', 'business'].map((kind) => `tw_oauth_tenant_${kind}_${randomUUID().replaceAll('-', '')}`);
    cleanup.unshift(async () => {
      for (const name of names) await control.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await control.end();
    });
    for (const name of names) await control.query(`CREATE DATABASE "${name}"`);
    [authStore, business] = names.map((name) => {
      const url = new URL(LIVE!);
      url.pathname = `/${name}`;
      return url.href;
    });
    physical = 'public.physical_item';
    const client = new pg.default.Client({ connectionString: business, statement_timeout: 10000 });
    await client.connect();
    cleanup.push(() => client.end());
    await client.query(`${DEPOT_TABLE('physical_item')}; ${DEPOT_ROWS('physical_item')}`);
    await migratePostgresCommandJournal(business);
    await migratePostgresTenantStore(business, store);
    maintenance = async (run) => {
      const operations = new TransactionOperations();
      await client.query('BEGIN');
      try {
        await run(createPostgresTenantAdministration(client, operations, store));
        await operations.finish();
        await client.query('COMMIT');
      } catch (error) {
        await operations.finish().catch(() => {});
        await client.query('ROLLBACK');
        throw error;
      }
    };
    await migratePostgresAuthStore(authStore);
  }
  await maintenance(async (admin) => {
    for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
  });
  const written = writeDepotApp(directory, { business, authStore, physical });
  const file = join(written.appDir, 'app.json');
  const app = JSON.parse(readFileSync(file, 'utf8'));
  app.auth.signUp = 'open';
  app.api.network = true;
  writeFileSync(file, JSON.stringify(app));
  const configured = JSON.parse(readFileSync(written.config, 'utf8'));
  configured.connections.push({ name: 'agents', kind: 'oauth', apps: ['depot'] });
  writeFileSync(written.config, JSON.stringify(configured));
  writeFileSync(join(written.appDir, 'authority.lock'), (await loadApp(written.appDir, { lock: 'report' })).authority!.report);
  if (dialect === 'sqlite') {
    // The native auth store as the tenant host creates it, before its token store is provisioned beside it.
    const saved = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = SESSION_SECRET;
    try {
      (
        await createAppAuth(await loadApp(written.appDir), { baseURL: 'http://127.0.0.1:1', trustedOrigins: ['http://127.0.0.1:1'] })
      ).close();
    } finally {
      if (saved === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = saved;
    }
  }
  const provisioned = await tokenCli(['provision', '--app', written.appDir, '--config', written.config, '--store-id', randomUUID()]);
  assert.equal(provisioned.code, 0, provisioned.err);
  /** A membership written as an operator writes one: `expectedVersion` null makes it. */
  const member = (tenantId: string, accountId: string, status: 'active' | 'revoked', expectedVersion: string | null, roles = ['member']) =>
    maintenance((admin) =>
      admin.putMembership({
        tenantId,
        accountId,
        membershipId: `m-${accountId}-${tenantId}`,
        status,
        roles,
        validUntil: Date.now() + 3600000,
        expectedVersion,
      }),
    );
  return { ...written, member };
}

for (const { dialect, skip } of [
  { dialect: 'sqlite' as const, skip: false as const },
  { dialect: 'postgres' as const, skip: liveSkip('postgres', LIVE) },
]) {
  test(
    `a tenant App's OAuth on ${dialect}: the token is one membership's, never another tenant's, and ends with it`,
    { skip, timeout: 600000 },
    async (t) => {
      const f = await depot(t, dialect);
      const s = await serveApi(t, { config: f.config, appDir: f.appDir }, 'depot', ['--policy', f.policy]);
      await s.started;
      const reach = new URL(s.base).origin;
      // Where the server says it is (its public origin): what a resource and an issuer are named by.
      const origin = /Listening on (http:\/\/[^\s/]+)/.exec(s.output())![1];
      const send = async (
        path: string,
        options: { headers?: Record<string, string>; json?: unknown; form?: Record<string, string | string[]> } = {},
      ) => {
        const headers: Record<string, string> = { ...options.headers };
        let body: string | undefined;
        if (options.json !== undefined) {
          body = JSON.stringify(options.json);
          headers['content-type'] = 'application/json';
        } else if (options.form) {
          const params = new URLSearchParams();
          for (const [key, value] of Object.entries(options.form)) for (const item of [value].flat()) params.append(key, item);
          body = params.toString();
          headers['content-type'] = 'application/x-www-form-urlencoded';
        }
        const response = await fetch(reach + path, {
          method: body === undefined ? 'GET' : 'POST',
          // A page of the App sends its Origin (the address it was reached at) with the session; an agent sends neither.
          headers: { ...(headers.cookie ? { origin: reach } : {}), ...headers },
          redirect: 'manual',
          signal: AbortSignal.timeout(15000),
          ...(body === undefined ? {} : { body }),
        });
        const text = await response.text();
        return { status: response.status, headers: response.headers, text, json: () => JSON.parse(text) };
      };
      /** A person signs up, and is who whoami says: their cookie and account id. */
      const person = async (name: string) => {
        const email = `${name}@example.test`;
        const made = await send('/api/auth/sign-up/email', { json: { name, email, password: PASSWORD }, headers: { origin: reach } });
        assert.equal(made.status, 200, made.text + s.output());
        const cookie = made.headers
          .getSetCookie()
          .map((value) => value.split(';')[0])
          .join('; ');
        const me = await send('/api/whoami?app=depot', { headers: { cookie } });
        assert.equal(me.status, 200, me.text);
        return { cookie, id: me.json().accountId as string };
      };
      const alice = await person('alice'),
        bob = await person('bob'),
        carol = await person('carol');
      await f.member('north', alice.id, 'active', null);
      await f.member('south', alice.id, 'active', null);
      await f.member('south', bob.id, 'active', null);

      const registered = await send('/api/auth/oauth/register', { json: { client_name: 'Depot agent', redirect_uris: [CB] } });
      assert.equal(registered.status, 201, registered.text);
      const clientId = registered.json().client_id as string;
      const resource = `${origin}/api/apps/depot/v1`;
      /** Authorize, and the pending request's id the sign-in page carries. */
      const authorize = async () => {
        const verifier = randomBytes(32).toString('base64url');
        const query = new URLSearchParams({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: CB,
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          code_challenge_method: 'S256',
          state: 'state-1',
          resource,
        });
        const sent = await send(`/api/auth/oauth/authorize?${query}`);
        assert.equal(sent.status, 303, sent.text);
        const at = new URL(sent.headers.get('location')!, origin);
        assert.match(at.pathname, /\/sign-in$/);
        return { request: at.searchParams.get('authorize')!, verifier };
      };
      const view = async (who: { cookie: string }, request: string) => {
        const answer = await send(`/api/auth/oauth/consent?request=${request}`, { headers: { cookie: who.cookie } });
        assert.equal(answer.status, 200, answer.text);
        return answer.json() as { nonce: string; roles: string[]; tenants: { id: string; name: string; roles: string[] }[] };
      };
      const answer = (who: { cookie: string }, request: string, nonce: string, tenant: string | undefined, roles = ['member']) =>
        send('/api/auth/oauth/consent', {
          headers: { cookie: who.cookie },
          form: { request, nonce, decision: 'allow', role: roles, ...(tenant === undefined ? {} : { tenant }) },
        });
      /** The whole dance for one person and one of their tenants: the tokens. */
      const tokens = async (who: { cookie: string }, tenant: string) => {
        const { request, verifier } = await authorize();
        const { nonce } = await view(who, request);
        const given = await answer(who, request, nonce, tenant);
        assert.equal(given.status, 303, given.text);
        const back = new URL(given.headers.get('location')!);
        const code = back.searchParams.get('code')!;
        const exchanged = await send('/api/auth/oauth/token', {
          form: { grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: CB, code_verifier: verifier },
        });
        assert.equal(exchanged.status, 200, exchanged.text);
        return exchanged.json() as { access_token: string; refresh_token: string };
      };
      const read = (token: string, path: string) => send(`/api/apps/depot/v1${path}`, { headers: { authorization: `Bearer ${token}` } });
      const refresh = (refreshToken: string) =>
        send('/api/auth/oauth/token', { form: { grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken } });

      // Discovery, as for any App: the server's metadata and a refused bearer pointing at it.
      const metadata = await send('/.well-known/oauth-authorization-server/api/auth');
      assert.equal(metadata.status, 200, metadata.text);
      assert.equal(metadata.json().issuer, `${origin}/api/auth`);
      const bare = await read('', '/item/north-1');
      assert.equal(bare.status, 401);
      assert.match(
        bare.headers.get('www-authenticate') ?? '',
        /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/api\/apps\/depot\/v1"/,
      );
      // The consent page is framed by nobody.
      const page = await fetch(`${reach}/sign-in?authorize=${randomUUID()}`, {
        headers: { accept: 'text/html', 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' },
        redirect: 'manual',
      });
      await page.arrayBuffer();
      assert.equal(page.headers.get('x-frame-options'), 'DENY');
      assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);

      // The choices are the person's active memberships, each with what it may give; the account's own roles are none.
      const first = await authorize();
      const offered = await view(alice, first.request);
      assert.deepEqual(offered.roles, []);
      assert.deepEqual(
        offered.tenants.map((tenant) => [tenant.id, tenant.roles]),
        [
          ['north', ['member']],
          ['south', ['member']],
        ],
      );
      // Carol is a member of nothing: nothing is offered, and naming a tenant gives nothing.
      const carolAsks = await authorize();
      const carolView = await view(carol, carolAsks.request);
      assert.deepEqual([carolView.tenants, carolView.roles], [[], []]);
      assert.equal((await answer(carol, carolAsks.request, carolView.nonce, 'north')).status, 403);
      // Bob names alice's north, where he is no member: refused, no code.
      const bobAsks = await authorize();
      const bobView = await view(bob, bobAsks.request);
      assert.deepEqual(
        bobView.tenants.map((tenant) => tenant.id),
        ['south'],
      );
      const crossed = await answer(bob, bobAsks.request, bobView.nonce, 'north');
      assert.equal(crossed.status, 403, crossed.text);
      assert.equal(crossed.headers.get('location'), null);
      // No tenant named is no answer either.
      assert.equal((await answer(alice, first.request, offered.nonce, undefined)).status, 403);

      // Alice's north token reads north's rows, and never south's.
      const north = await tokens(alice, 'north');
      assert.match(north.access_token, /^twa1\./);
      const own = await read(north.access_token, '/item/north-1');
      assert.equal(own.status, 200, own.text);
      assert.equal((await read(north.access_token, '/item/south-1')).status, 404);
      const listed = await read(north.access_token, '/item?sort=id');
      assert.deepEqual(
        (listed.json().items as { id: string }[]).map((row) => row.id),
        ['north-1', 'north-2'],
      );
      // Her south token is south's; the two are separate grants.
      const south = await tokens(alice, 'south');
      assert.equal((await read(south.access_token, '/item/south-1')).status, 200);
      assert.equal((await read(south.access_token, '/item/north-1')).status, 404);
      // A refresh keeps the membership, and reads as before.
      const renewed = await refresh(north.refresh_token);
      assert.equal(renewed.status, 200, renewed.text);
      const northNext = renewed.json() as { access_token: string; refresh_token: string };
      assert.equal((await read(northNext.access_token, '/item/north-2')).status, 200);

      // Her north membership changes (a new version): the access token stops, and the grant does not refresh.
      await f.member('north', alice.id, 'active', '1', ['member']);
      assert.notEqual((await read(northNext.access_token, '/item/north-1')).status, 200);
      const stale = await refresh(northNext.refresh_token);
      assert.equal(stale.status, 400, stale.text);
      assert.equal(stale.json().error, 'invalid_grant');
      // Ended for good: the grant was revoked, not only refused once.
      assert.equal((await refresh(northNext.refresh_token)).json().error, 'invalid_grant');
      // South is untouched by north's change.
      assert.equal((await read(south.access_token, '/item/south-2')).status, 200);

      // A code given before the membership is revoked is not exchanged after it.
      const pending = await authorize();
      const pendingView = await view(alice, pending.request);
      const given = await answer(alice, pending.request, pendingView.nonce, 'south');
      assert.equal(given.status, 303, given.text);
      const code = new URL(given.headers.get('location')!).searchParams.get('code')!;
      await f.member('south', alice.id, 'revoked', '1');
      const late = await send('/api/auth/oauth/token', {
        form: { grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: CB, code_verifier: pending.verifier },
      });
      assert.equal(late.json().error, 'invalid_grant', late.text);
      // And the revoked membership's token and grant both end.
      assert.notEqual((await read(south.access_token, '/item/south-1')).status, 200);
      assert.equal((await refresh(south.refresh_token)).json().error, 'invalid_grant');
      // Bob's own south membership still gives him a token for south.
      const bobs = await tokens(bob, 'south');
      assert.equal((await read(bobs.access_token, '/item/south-1')).status, 200);
    },
  );
}

test('a tenant App mounted under a path sends the person to its own sign-in for consent', { timeout: 600000 }, async (t) => {
  const f = await depot(t, 'sqlite');
  const s = await serveApi(t, { config: f.config, appDir: f.appDir }, 'depot', ['--policy', f.policy, '--mount', 'depot=/depot']);
  await s.started;
  const reach = new URL(s.base).origin;
  const origin = /Listening on (http:\/\/[^\s/]+)/.exec(s.output())![1];
  const send = async (path: string, init: { cookie?: string; json?: unknown; form?: Record<string, string | string[]> } = {}) => {
    const headers: Record<string, string> = init.cookie ? { cookie: init.cookie, origin: reach } : {};
    let body: string | undefined;
    if (init.json !== undefined) {
      body = JSON.stringify(init.json);
      headers['content-type'] = 'application/json';
      headers.origin = reach;
    } else if (init.form) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(init.form)) for (const item of [value].flat()) params.append(key, item);
      body = params.toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
    }
    const response = await fetch(reach + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
      ...(body === undefined ? {} : { body }),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, json: () => JSON.parse(text) };
  };
  const made = await send('/api/auth/sign-up/email', { json: { name: 'alice', email: 'alice@example.test', password: PASSWORD } });
  assert.equal(made.status, 200, made.text + s.output());
  const cookie = made.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const me = await send('/api/whoami?app=depot', { cookie });
  assert.equal(me.status, 200, me.text);
  await f.member('north', me.json().accountId, 'active', null);

  const registered = await send('/api/auth/oauth/register', { json: { client_name: 'Depot agent', redirect_uris: [CB] } });
  assert.equal(registered.status, 201, registered.text);
  const clientId = registered.json().client_id as string;
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CB,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: 'mounted',
    resource: `${origin}/api/apps/depot/v1`,
  });
  const sent = await send(`/api/auth/oauth/authorize?${query}`, { cookie });
  assert.equal(sent.status, 303, sent.text);
  const at = new URL(sent.headers.get('location')!, origin);
  // The App's own sign-in, under its mount: the root's /sign-in is no App's.
  assert.equal(at.pathname, '/depot/sign-in');
  const page = await fetch(`${reach}${at.pathname}${at.search}`, {
    headers: { accept: 'text/html', 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', cookie },
    redirect: 'manual',
  });
  const html = await page.text();
  assert.equal(page.status, 200, html.slice(0, 400));
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  const request = at.searchParams.get('authorize')!;
  const view = await send(`/api/auth/oauth/consent?request=${request}`, { cookie });
  assert.equal(view.status, 200, view.text);
  const given = await send('/api/auth/oauth/consent', {
    cookie,
    form: { request, nonce: view.json().nonce, decision: 'allow', role: ['member'], tenant: 'north' },
  });
  assert.equal(given.status, 303, given.text);
  const code = new URL(given.headers.get('location')!).searchParams.get('code')!;
  const exchanged = await send('/api/auth/oauth/token', {
    form: { grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: CB, code_verifier: verifier },
  });
  assert.equal(exchanged.status, 200, exchanged.text);
});
