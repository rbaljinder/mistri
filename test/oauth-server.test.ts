/** The OAuth 2.1 authorization server an App's network API and HTTP MCP take
 * tokens from, through the real CLI over SQLite: one full flow (register →
 * authorize → consent → token → MCP → refresh → revoke), then each door it
 * keeps shut — PKCE, exact redirects, one-time codes bound to their client,
 * the resource a token is for, the role ceilings narrowed on every request,
 * refresh rotation, registration's limits and the consent page's own
 * defenses. One server serves every case that does not restart it; every
 * client registers from an address of its own, so the registration budget is
 * spent only where a case means to spend it. Nothing leaves 127.0.0.1. */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { provisionStores } from '../packages/mistri/src/server/maintenance.js';
import { provisionSqliteApiTokenStore } from '../packages/mistri/src/server/auth/provisionSqliteApiTokenStore.js';
import { captureAuthStoreExclusion } from '../packages/mistri/src/server/auth/authStoreSeparation.js';
import { SQLITE_API_TOKEN_TABLES } from '../packages/mistri/src/adapters/auth/sqliteApiTokenLayout.js';
import { sqliteOAuthStore } from '../packages/mistri/src/server/auth/oauthStore.js';
import { OAUTH_UNCONSENTED_CLIENTS, OAUTH_UNCONSENTED_SECONDS, registerClient } from '../packages/mistri/src/server/auth/oauthGrants.js';
import { redirectProblem } from '../packages/mistri/src/server/auth/oauthServer.js';
import { bearerChallenge, bindOAuthResource } from '../packages/mistri/src/server/auth/oauthResource.js';
import { oauthProblems, oauthRoleCeiling } from '../packages/mistri/src/server/api/oauthConfig.js';
import { oauthConnectionOf } from '../packages/mistri/src/server/auth/identityConfig.js';
import { ROOT, SESSION_SECRET, childEnv, cliArgs, freePort, mcpEnv, runCli } from './appApiCli.js';
import { SHOP_TABLES, writeShopApp } from './appApiShop.js';

const storeId = '5b8f7c1e-2d4a-4f6b-9c3e-1a2b3c4d5e6f';
const OAUTH = { name: 'agents', kind: 'oauth', apps: ['shop'], roles: ['operator', 'auditor'] };
const PASSWORD = 'synthetic-oauth-password-123';
const CB = 'http://127.0.0.1:9/cb';

type Fixture = Awaited<ReturnType<typeof shopFixture>>;

/** The shop App with a network API, its native store provisioned for API
 * tokens, and a config naming the authorization server (`oauth`, or none). */
async function shopFixture(oauth: Record<string, unknown> | null = OAUTH, provision = true) {
  const directory = mkdtempSync(join(tmpdir(), 'tw-oauth-'));
  const business = join(directory, 'business.db'),
    authPath = join(directory, 'auth.db');
  const db = new DatabaseSync(business);
  try {
    db.exec(SHOP_TABLES);
  } finally {
    db.close();
  }
  migrateSqliteCommandJournal(business);
  await provisionStores({ sqlite: business }, { app: { id: 'shop', source: 'business' } });
  const { appDir, config, commands } = writeShopApp(directory, { business, authStore: authPath });
  const file = join(appDir, 'app.json');
  const app = JSON.parse(readFileSync(file, 'utf8'));
  app.api.network = true;
  writeFileSync(file, JSON.stringify(app));
  const configured = JSON.parse(readFileSync(config, 'utf8'));
  if (oauth) configured.connections.push(oauth);
  writeFileSync(config, JSON.stringify(configured));
  const lock = async () => {
    rmSync(join(appDir, 'authority.lock'), { force: true });
    const loaded = await loadApp(appDir);
    writeFileSync(join(appDir, 'authority.lock'), loaded.authority!.report);
    return loaded;
  };
  const loaded = await lock();
  const names = ['BETTER_AUTH_SECRET', 'MISTRI_AUTH_ADMIN_EMAIL', 'MISTRI_AUTH_ADMIN_PASSWORD'] as const;
  const saved = names.map((name) => [name, process.env[name]] as const);
  process.env.BETTER_AUTH_SECRET = SESSION_SECRET;
  // The one account, made as an operator makes the first: sign-up is closed.
  process.env.MISTRI_AUTH_ADMIN_EMAIL = 'reader@example.org';
  process.env.MISTRI_AUTH_ADMIN_PASSWORD = PASSWORD;
  try {
    (await createAppAuth(loaded, { baseURL: 'http://127.0.0.1:1', trustedOrigins: ['http://127.0.0.1:1'] })).close();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  if (provision) provisionSqliteApiTokenStore(authPath, { appId: 'shop', storeId, exclusions: [captureAuthStoreExclusion(business)] });
  /** One statement on the sign-in store, as an operator or a clock would change it. */
  const auth = (sql: string, ...params: (string | number)[]) => {
    const handle = new DatabaseSync(authPath);
    try {
      handle.exec('PRAGMA busy_timeout = 5000');
      return handle.prepare(sql).all(...params) as Record<string, unknown>[];
    } finally {
      handle.close();
    }
  };
  /** The App's API at version `version`, its authority locked again. */
  const bump = async (version: number) => {
    const current = JSON.parse(readFileSync(file, 'utf8'));
    current.api.version = version;
    writeFileSync(file, JSON.stringify(current));
    await lock();
  };
  return { directory, appDir, config, commands, authPath, auth, bump };
}

/** The real CLI serving the App and its API on loopback. */
async function serve(f: Fixture) {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    cliArgs([
      '--config',
      f.config,
      '--app',
      f.appDir,
      '--commands',
      f.commands,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--api-reads',
      '--api-integers',
      'decimal-string',
      '--api-requests-per-minute',
      '10000',
    ]),
    { cwd: ROOT, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  const closed = new Promise<void>((done) => child.once('close', () => done()));
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`readiness timeout: ${output}`)), 60000);
    const inspect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-16000);
      if (output.includes('Listening on http://') && output.includes(' API at ')) {
        clearTimeout(timer);
        done();
      }
    };
    child.stdout!.on('data', inspect);
    child.stderr!.on('data', inspect);
    child.once('close', () => {
      clearTimeout(timer);
      fail(new Error(`closed before listening: ${output}`));
    });
  });
  // Where the server says it is (its public origin), and where this test reaches it.
  const origin = /Listening on (http:\/\/[^\s/]+)/.exec(output)![1];
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    await closed;
    clearTimeout(timer);
  };
  return { child: child as ChildProcess, port, origin, reach: `http://127.0.0.1:${port}`, output: () => output, stop };
}

type Server = Awaited<ReturnType<typeof serve>>;
type Reply = { status: number; headers: Headers; text: string; json(): any };

let f: Fixture;
let s: Server;
let cookie = '';
let addresses = 0;

before(async () => {
  f = await shopFixture();
  s = await serve(f);
  const signup = await send('/api/auth/sign-in/email', {
    json: { email: 'reader@example.org', password: PASSWORD },
    headers: { origin: s.reach },
  });
  assert.equal(signup.status, 200, signup.text + s.output());
  // Operator and editor are the App's; admin is the platform's. The ceiling is operator and auditor.
  f.auth(`UPDATE "user" SET role = 'operator,editor,admin' WHERE email = 'reader@example.org'`);
  cookie = signup.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  assert.match(cookie, /session_token=/);
});

after(async () => {
  await s?.stop();
  if (f) rmSync(f.directory, { recursive: true, force: true });
});

async function send(
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    json?: unknown;
    form?: Record<string, string | string[]>;
    server?: Server;
  } = {},
): Promise<Reply> {
  const server = options.server ?? s;
  let body: string | undefined;
  const headers: Record<string, string> = { ...options.headers };
  /* The three OAuth doors are budgeted per address (oauthServer.ts), and this suite makes far more than a minute's worth
     from one: each request comes from an address of its own unless the test names one, as `register` already does. */
  if (/\/api\/auth\/oauth\/(authorize|consent|token)/.test(path) && !headers['x-forwarded-for'])
    headers['x-forwarded-for'] = `10.8.${Math.floor(++addresses / 250)}.${addresses % 250}`;
  if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    headers['content-type'] ??= 'application/json';
  } else if (options.form) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options.form)) for (const item of [value].flat()) params.append(key, item);
    body = params.toString();
    headers['content-type'] ??= 'application/x-www-form-urlencoded';
  }
  const response = await fetch(server.reach + path, {
    method: options.method ?? (body === undefined ? 'GET' : 'POST'),
    /* A page of the App sends its Origin with the session; an agent sends neither. The page is where this
       test reaches the server, as a browser's page is where it sent its Host: the door holds them equal. */
    headers: { ...(headers.cookie ? { origin: server.reach } : {}), ...headers },
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
    ...(body === undefined ? {} : { body }),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, json: () => JSON.parse(text) };
}

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
const mcpResource = (server = s, version = 1) => `${server.origin}/api/apps/shop/v${version}/$mcp`;

/** A public client, registered from an address of its own unless `from` names one. */
async function register(redirectUris: unknown = [CB], extra: Record<string, unknown> = {}, from?: string) {
  const address = from ?? `10.9.${Math.floor(++addresses / 250)}.${addresses % 250}`;
  return send('/api/auth/oauth/register', {
    json: { client_name: 'Test agent', redirect_uris: redirectUris, ...extra },
    headers: { 'x-forwarded-for': address },
  });
}
async function client(redirect = CB) {
  const registered = await register([redirect]);
  assert.equal(registered.status, 201, registered.text);
  return registered.json().client_id as string;
}

function authorizeUrl(clientId: string, challenge: string | undefined, over: Record<string, string | undefined> = {}) {
  const params: Record<string, string | undefined> = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CB,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'state-1',
    resource: mcpResource(),
    ...over,
  };
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) query.append(key, value);
  return `/api/auth/oauth/authorize?${query}`;
}
/** Where the server sent the browser back to, read. */
const backAt = (reply: Reply) => {
  assert.equal(reply.status, 303, reply.text);
  return new URL(reply.headers.get('location')!, s.origin);
};

/** The consent page's view, then the person's answer: the redirect it answers with. */
async function consent(request: string, answer: { roles?: string[]; decision?: string } = {}) {
  const view = await send(`/api/auth/oauth/consent?request=${request}`, { headers: { cookie } });
  assert.equal(view.status, 200, view.text);
  const { nonce } = view.json();
  return send('/api/auth/oauth/consent', {
    headers: { cookie },
    form: { request, nonce, decision: answer.decision ?? 'allow', role: answer.roles ?? ['operator'] },
  });
}

/** The whole dance for one client: a code for `roles`, with its verifier. */
async function code(clientId: string, roles: string[] = ['operator']) {
  const { verifier, challenge } = pkce();
  const sent = await send(authorizeUrl(clientId, challenge));
  const at = backAt(sent);
  assert.equal(at.origin, s.origin);
  assert.match(at.pathname, /\/sign-in$/);
  const request = at.searchParams.get('authorize')!;
  const answered = backAt(await consent(request, { roles }));
  assert.equal(answered.origin + answered.pathname, CB);
  assert.equal(answered.searchParams.get('state'), 'state-1');
  assert.equal(answered.searchParams.get('iss'), `${s.origin}/api/auth`);
  return { code: answered.searchParams.get('code')!, verifier };
}

const exchange = (clientId: string, given: { code: string; verifier?: string }, over: Record<string, string> = {}) =>
  send('/api/auth/oauth/token', {
    form: {
      grant_type: 'authorization_code',
      client_id: clientId,
      code: given.code,
      redirect_uri: CB,
      ...(given.verifier !== undefined ? { code_verifier: given.verifier } : {}),
      ...over,
    },
  });
const refresh = (clientId: string, refreshToken: string) =>
  send('/api/auth/oauth/token', { form: { grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken } });

/** A client with a grant: its tokens. */
async function granted(roles: string[] = ['operator']) {
  const clientId = await client();
  const reply = await exchange(clientId, await code(clientId, roles));
  assert.equal(reply.status, 200, reply.text);
  const body = reply.json();
  return { clientId, access: body.access_token as string, refresh: body.refresh_token as string, body };
}

let rpc = 0;
const mcp = (token: string | undefined, method: string, params: object = {}, server = s) =>
  send('/api/apps/shop/v1/$mcp', {
    server,
    json: { jsonrpc: '2.0', id: ++rpc, method, params },
    headers: { accept: 'application/json, text/event-stream', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
  });
const read = (token: string, path = '/item/1', server = s, version = 1) =>
  send(`/api/apps/shop/v${version}${path}`, { server, headers: { authorization: `Bearer ${token}` } });

test('one full flow: register, authorize, consent, token, MCP tools/list, refresh, revoke', { timeout: 60000 }, async () => {
  const registered = await register([CB]);
  assert.equal(registered.status, 201, registered.text);
  assert.equal(registered.headers.get('access-control-allow-origin'), '*');
  const metadata = registered.json();
  assert.match(metadata.client_id, /^twc1\.[0-9a-f-]{36}$/);
  assert.equal(metadata.token_endpoint_auth_method, 'none');
  assert.deepEqual(metadata.redirect_uris, [CB]);
  const clientId = metadata.client_id as string;

  const given = await code(clientId);
  const tokens = await exchange(clientId, given);
  assert.equal(tokens.status, 200, tokens.text);
  assert.equal(tokens.headers.get('cache-control'), 'no-store');
  const body = tokens.json();
  assert.equal(body.token_type, 'Bearer');
  assert.match(body.access_token, /^twa1\./);
  assert.match(body.refresh_token, /^twr1\./);
  assert.ok(body.expires_in > 3500 && body.expires_in <= 3600, String(body.expires_in));

  const init = await mcp(body.access_token, 'initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'x', version: '0' },
  });
  assert.equal(init.status, 200, init.text);
  const listed = await mcp(body.access_token, 'tools/list');
  assert.equal(listed.status, 200, listed.text);
  const tools = listed.json().result.tools as { name: string }[];
  assert.ok(
    tools.some((tool) => tool.name.startsWith('get_')),
    listed.text,
  );
  assert.equal((await read(body.access_token)).status, 200);

  // The person sees the client among their connected ones.
  const mine = await send('/api/auth/oauth/grants', { headers: { cookie } });
  assert.equal(mine.status, 200, mine.text);
  const grant = (mine.json().grants as { clientId: string; client: string; roles: string[] }[]).find((g) => g.clientId === clientId);
  assert.deepEqual(grant && { client: grant.client, roles: grant.roles }, { client: 'Test agent', roles: ['operator'] });

  const next = await refresh(clientId, body.refresh_token);
  assert.equal(next.status, 200, next.text);
  const rotated = next.json();
  assert.notEqual(rotated.refresh_token, body.refresh_token);
  assert.equal((await mcp(rotated.access_token, 'tools/list')).status, 200);

  const revoked = await send('/api/auth/oauth/revoke', { form: { client_id: clientId, token: rotated.refresh_token } });
  assert.equal(revoked.status, 200, revoked.text);
  assert.equal((await mcp(rotated.access_token, 'tools/list')).status, 401);
  assert.equal((await read(body.access_token)).status, 401);
  assert.equal((await refresh(clientId, rotated.refresh_token)).json().error, 'invalid_grant');
});

test('metadata: the authorization server and both protected resources, and the challenge that points at them', async () => {
  const server = await send('/.well-known/oauth-authorization-server/api/auth');
  assert.equal(server.status, 200, server.text);
  assert.equal(server.headers.get('access-control-allow-origin'), '*');
  const issuer = `${s.origin}/api/auth`;
  assert.deepEqual(server.json(), {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    authorization_response_iss_parameter_supported: true,
  });
  for (const resource of [`${s.origin}/api/apps/shop/v1`, mcpResource()]) {
    const document = await send(`/.well-known/oauth-protected-resource${resource.slice(s.origin.length)}`);
    assert.equal(document.status, 200, document.text);
    assert.deepEqual(document.json(), { resource, authorization_servers: [issuer], bearer_methods_supported: ['header'] });
  }
  assert.equal((await send('/.well-known/oauth-protected-resource/api/apps/shop/v2/$mcp')).status, 404);
  assert.equal((await send('/.well-known/oauth-protected-resource/api/apps/other/v1')).status, 404);

  const metadataAt = `${s.origin}/.well-known/oauth-protected-resource/api/apps/shop/v1/$mcp`;
  const bare = await mcp(undefined, 'tools/list');
  assert.equal(bare.status, 401);
  assert.equal(bare.headers.get('www-authenticate'), `Bearer resource_metadata="${metadataAt}"`);
  const forged = await mcp('twa1.00000000-0000-4000-8000-000000000000.forged', 'tools/list');
  assert.equal(forged.status, 401);
  assert.equal(forged.headers.get('www-authenticate'), `Bearer resource_metadata="${metadataAt}", error="invalid_token"`);
  const rest = await send('/api/apps/shop/v1/item/1');
  assert.equal(rest.status, 401);
  assert.equal(
    rest.headers.get('www-authenticate'),
    `Bearer resource_metadata="${s.origin}/.well-known/oauth-protected-resource/api/apps/shop/v1"`,
  );
});

test('PKCE: a missing challenge, the plain method and a wrong or missing verifier are refused', async () => {
  const clientId = await client();
  const missing = backAt(await send(authorizeUrl(clientId, undefined)));
  assert.equal(missing.searchParams.get('error'), 'invalid_request');
  assert.equal(missing.searchParams.get('state'), 'state-1');
  const { challenge } = pkce();
  const plain = backAt(await send(authorizeUrl(clientId, challenge, { code_challenge_method: 'plain' })));
  assert.equal(plain.searchParams.get('error'), 'invalid_request');
  const absentMethod = backAt(await send(authorizeUrl(clientId, challenge, { code_challenge_method: undefined })));
  assert.equal(absentMethod.searchParams.get('error'), 'invalid_request');

  const wrong = await code(clientId);
  const refused = await exchange(clientId, { code: wrong.code, verifier: pkce().verifier });
  assert.equal(refused.status, 400);
  assert.equal(refused.json().error, 'invalid_grant');
  // The code is spent by the wrong try: the right verifier is too late.
  assert.equal((await exchange(clientId, wrong)).json().error, 'invalid_grant');

  const unverified = await code(clientId);
  assert.equal((await exchange(clientId, { code: unverified.code })).json().error, 'invalid_grant');
});

test('redirects: an unregistered address, a prefix or an extra path is told to the person, never followed', async () => {
  const clientId = await client();
  const { challenge } = pkce();
  for (const redirect of ['http://127.0.0.1:9/other', 'http://127.0.0.1:9/c', `${CB}/extra`, `${CB}?x=1`, 'http://127.0.0.1:10/cb']) {
    const reply = await send(authorizeUrl(clientId, challenge, { redirect_uri: redirect }));
    assert.equal(reply.status, 400, redirect);
    assert.equal(reply.headers.get('location'), null);
    assert.equal(reply.headers.get('x-frame-options'), 'DENY');
    assert.match(reply.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  }
  const unknown = await send(authorizeUrl('twc1.00000000-0000-4000-8000-000000000000', challenge));
  assert.equal(unknown.status, 400);
  assert.equal(unknown.headers.get('location'), null);
  // A repeated parameter is not chosen between.
  const doubled = await send(`${authorizeUrl(clientId, challenge)}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}`);
  assert.equal(doubled.status, 400);
  assert.equal(doubled.headers.get('location'), null);
  // The exchange names the same address the code was given to.
  const given = await code(clientId);
  assert.equal((await exchange(clientId, given, { redirect_uri: `${CB}/extra` })).json().error, 'invalid_grant');
});

test('codes: one use, and a second use revokes the grant; expired; another client cannot spend one', async () => {
  const clientId = await client();
  const given = await code(clientId);
  const first = await exchange(clientId, given);
  assert.equal(first.status, 200, first.text);
  const tokens = first.json();
  assert.equal((await read(tokens.access_token)).status, 200);
  const again = await exchange(clientId, given);
  assert.equal(again.json().error, 'invalid_grant');
  assert.equal((await read(tokens.access_token)).status, 401, 'the grant the code made is revoked');
  assert.equal((await refresh(clientId, tokens.refresh_token)).json().error, 'invalid_grant');

  const late = await code(clientId);
  const digest = createHash('sha256').update(late.code, 'utf8').digest('hex');
  f.auth(`UPDATE "${SQLITE_API_TOKEN_TABLES.code}" SET expires_at = ? WHERE code_digest = ?`, Date.now() - 1000, digest);
  assert.equal((await exchange(clientId, late)).json().error, 'invalid_grant');

  const other = await client();
  const stolen = await code(clientId);
  const crossed = await exchange(other, stolen);
  assert.equal(crossed.status, 400, crossed.text);
  assert.equal(crossed.json().error, 'invalid_grant');
  assert.equal((await exchange(clientId, stolen)).json().error, 'invalid_grant', 'a code another client tried is burned');
  const unregistered = await exchange('twc1.00000000-0000-4000-8000-000000000000', await code(clientId));
  assert.equal(unregistered.status, 401);
  assert.equal(unregistered.json().error, 'invalid_client');
});

test('resource: another App, another version or an unknown resource is refused', async () => {
  const clientId = await client();
  const { challenge } = pkce();
  for (const resource of [
    `${s.origin}/api/apps/other/v1/$mcp`,
    `${s.origin}/api/apps/shop/v2/$mcp`,
    `${s.origin}/api/apps/shop/v1/item`,
    'https://evil.example/api/apps/shop/v1/$mcp',
    undefined,
  ]) {
    const at = backAt(await send(authorizeUrl(clientId, challenge, { resource })));
    assert.equal(at.searchParams.get('error'), 'invalid_target', String(resource));
  }
  const given = await code(clientId);
  const elsewhere = await exchange(clientId, given, { resource: `${s.origin}/api/apps/shop/v2` });
  assert.equal(elsewhere.status, 400);
  assert.equal(elsewhere.json().error, 'invalid_target');
  const tokens = (await exchange(clientId, await code(clientId), { resource: `${s.origin}/api/apps/shop/v1` })).json();
  assert.ok(tokens.access_token, JSON.stringify(tokens));
});

test('roles: the consent page offers only person ∩ api.roles ∩ the ceiling; a platform role is never given', async () => {
  const clientId = await client();
  const { challenge } = pkce();
  const request = backAt(await send(authorizeUrl(clientId, challenge))).searchParams.get('authorize')!;
  const view = await send(`/api/auth/oauth/consent?request=${request}`, { headers: { cookie } });
  assert.equal(view.status, 200, view.text);
  const shown = view.json();
  // editor is the person's and the API's, but not the ceiling's; admin is the platform's.
  assert.deepEqual(shown.roles, ['operator']);
  assert.equal(shown.client.name, 'Test agent');
  assert.deepEqual(shown.redirect, { scheme: 'http', host: '127.0.0.1:9' });
  assert.equal(shown.app.id, 'shop');
  // auditor is the ceiling's and the API's, but not the person's.
  const unheld = await send('/api/auth/oauth/consent', {
    headers: { cookie },
    form: { request, nonce: shown.nonce, decision: 'allow', role: 'auditor' },
  });
  assert.equal(unheld.status, 400);
  for (const role of ['admin', 'editor']) {
    const again = backAt(await send(authorizeUrl(clientId, pkce().challenge))).searchParams.get('authorize')!;
    const nonce = (await send(`/api/auth/oauth/consent?request=${again}`, { headers: { cookie } })).json().nonce;
    const answered = await send('/api/auth/oauth/consent', {
      headers: { cookie },
      form: { request: again, nonce, decision: 'allow', role: ['operator', role] },
    });
    assert.equal(answered.status, 400, role);
  }
  // Declining sends the client access_denied.
  const declined = backAt(
    await consent(backAt(await send(authorizeUrl(clientId, pkce().challenge))).searchParams.get('authorize')!, { decision: 'deny' }),
  );
  assert.equal(declined.searchParams.get('error'), 'access_denied');
  assert.equal(declined.searchParams.get('state'), 'state-1');
});

test('roles: narrowed on the next request, and a role lost ends the grant at refresh', async () => {
  f.auth(`UPDATE "user" SET role = 'operator,auditor' WHERE email = 'reader@example.org'`);
  try {
    const both = await granted(['operator', 'auditor']);
    // The auditor reads the vault; the operator does not.
    assert.equal((await read(both.access, '/vault/1')).status, 200);
    f.auth(`UPDATE "user" SET role = 'operator' WHERE email = 'reader@example.org'`);
    assert.equal((await read(both.access, '/vault/1')).status, 403, 'auditor is gone from the very next request');
    assert.equal((await read(both.access, '/item/1')).status, 200);
    const narrowed = await refresh(both.clientId, both.refresh);
    assert.equal(narrowed.status, 200, narrowed.text);
    assert.equal((await read(narrowed.json().access_token, '/vault/1')).status, 403);

    const only = await granted(['operator']);
    f.auth(`UPDATE "user" SET role = 'editor' WHERE email = 'reader@example.org'`);
    const gone = await read(only.access);
    assert.ok(gone.status === 401 || gone.status === 403, `${gone.status} ${gone.text}`);
    assert.equal((await refresh(only.clientId, only.refresh)).json().error, 'invalid_grant');
    f.auth(`UPDATE "user" SET role = 'operator,editor,admin' WHERE email = 'reader@example.org'`);
    assert.equal((await read(only.access)).status, 401, 'the grant the lost role ended stays ended');
  } finally {
    f.auth(`UPDATE "user" SET role = 'operator,editor,admin' WHERE email = 'reader@example.org'`);
  }
});

test('refresh: a reused refresh token revokes the grant; a banned account gets nothing; revocation', async () => {
  const one = await granted();
  const next = await refresh(one.clientId, one.refresh);
  assert.equal(next.status, 200, next.text);
  const rotated = next.json();
  assert.equal((await refresh(one.clientId, one.refresh)).json().error, 'invalid_grant');
  assert.equal((await read(rotated.access_token)).status, 401, 'the grant is revoked with every token it made');
  assert.equal((await refresh(one.clientId, rotated.refresh_token)).json().error, 'invalid_grant');

  const other = await client();
  const two = await granted();
  assert.equal((await refresh(other, two.refresh)).json().error, 'invalid_grant', 'another client presenting it revokes the grant');
  assert.equal((await read(two.access)).status, 401);

  const banned = await granted();
  f.auth(`UPDATE "user" SET banned = 1 WHERE email = 'reader@example.org'`);
  try {
    assert.equal((await read(banned.access)).status, 401);
    assert.equal((await refresh(banned.clientId, banned.refresh)).json().error, 'invalid_grant');
  } finally {
    f.auth(`UPDATE "user" SET banned = 0 WHERE email = 'reader@example.org'`);
  }
  assert.equal((await read(banned.access)).status, 401, 'the refresh a banned account tried revoked the grant');

  // An access token revoked alone: the refresh token still stands.
  const three = await granted();
  assert.equal((await send('/api/auth/oauth/revoke', { form: { client_id: other, token: three.access } })).status, 200);
  assert.equal((await read(three.access)).status, 200, 'another client cannot revoke it');
  assert.equal((await send('/api/auth/oauth/revoke', { form: { client_id: three.clientId, token: three.access } })).status, 200);
  assert.equal((await read(three.access)).status, 401);
  assert.equal((await refresh(three.clientId, three.refresh)).status, 200);
  assert.equal((await send('/api/auth/oauth/revoke', { form: { token: three.access } })).status, 401);

  // The person revokes from their profile.
  const four = await granted();
  const listed = (await send('/api/auth/oauth/grants', { headers: { cookie } })).json().grants as { grantId: string; clientId: string }[];
  const grantId = listed.find((g) => g.clientId === four.clientId)!.grantId;
  assert.equal(
    (await send('/api/auth/oauth/grants/revoke', { headers: { cookie, origin: 'https://evil.example' }, json: { grantId } })).status,
    403,
  );
  assert.equal((await send('/api/auth/oauth/grants/revoke', { headers: { cookie }, json: { grantId } })).status, 200);
  assert.equal((await read(four.access)).status, 401);
  assert.equal((await refresh(four.clientId, four.refresh)).json().error, 'invalid_grant');
});

test('registration: every rejected redirect class, and the per-address budget', async () => {
  for (const uri of [
    'http://example.com/cb',
    'https://app.example.com/cb#frag',
    'https://*.example.com/cb',
    'https://user:pass@app.example.com/cb',
    'myapp:/cb',
    'com.example.app://host/cb',
    'https://app.example.com/c b',
    '/relative/cb',
    `https://app.example.com/${'a'.repeat(2048)}`,
  ]) {
    const reply = await register([uri]);
    assert.equal(reply.status, 400, uri);
    assert.equal(reply.json().error, 'invalid_redirect_uri', uri);
  }
  assert.equal((await register([])).json().error, 'invalid_redirect_uri');
  assert.equal((await register([CB, CB])).json().error, 'invalid_redirect_uri');
  assert.equal((await register(Array.from({ length: 6 }, (_, i) => `${CB}${i}`))).json().error, 'invalid_redirect_uri');
  assert.equal((await register([CB], { token_endpoint_auth_method: 'client_secret_basic' })).json().error, 'invalid_client_metadata');
  assert.equal((await register([CB], { grant_types: ['client_credentials'] })).json().error, 'invalid_client_metadata');
  assert.equal((await register([CB], { response_types: ['token'] })).json().error, 'invalid_client_metadata');
  assert.equal((await register([CB], { client_name: 'Evil‮agent' })).json().error, 'invalid_client_metadata');
  for (const uri of ['https://app.example.com/cb', 'http://localhost:8123/cb', 'http://[::1]:8123/cb', 'com.example.app:/cb']) {
    assert.equal((await register([uri])).status, 201, uri);
  }

  const address = '10.200.0.1';
  for (let i = 0; i < 10; i++) assert.equal((await register([CB], {}, address)).status, 201, String(i));
  const limited = await register([CB], {}, address);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal((await register([CB])).status, 201, 'another address keeps its own budget');

  const preflight = await send('/api/auth/oauth/token', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
});

test('authorize, consent view and token are budgeted per address before anything is written', async () => {
  const clientId = await client();
  const { challenge } = pkce();
  const flood = { 'x-forwarded-for': '10.201.0.1' };
  let refused: Reply | undefined;
  for (let i = 0; i < 40 && !refused; i++) {
    const reply = await send(authorizeUrl(clientId, challenge), { headers: flood });
    if (reply.status === 429) refused = reply;
    else assert.equal(reply.status, 303, String(i));
  }
  assert.ok(refused, 'the flood is refused');
  assert.ok(Number(refused.headers.get('retry-after') ?? 0) >= 0);
  const other = await send(authorizeUrl(clientId, challenge), { headers: { 'x-forwarded-for': '10.201.0.2' } });
  assert.equal(other.status, 303, 'another address keeps its own budget');
});

test('consent: no nonce, a cross-origin form, a replayed nonce and a stranger are refused; the pages cannot be framed', async () => {
  const clientId = await client();
  const request = backAt(await send(authorizeUrl(clientId, pkce().challenge))).searchParams.get('authorize')!;
  assert.equal((await send(`/api/auth/oauth/consent?request=${request}`)).status, 401, 'signed out sees nothing');
  const nonce = (await send(`/api/auth/oauth/consent?request=${request}`, { headers: { cookie } })).json().nonce as string;
  const form = { request, nonce, decision: 'allow', role: 'operator' };
  const missing = await send('/api/auth/oauth/consent', { headers: { cookie }, form: { request, decision: 'allow', role: 'operator' } });
  assert.equal(missing.status, 403);
  assert.equal(missing.headers.get('x-frame-options'), 'DENY');
  assert.equal((await send('/api/auth/oauth/consent', { headers: { cookie, origin: 'https://evil.example' }, form })).status, 403);
  assert.equal((await send('/api/auth/oauth/consent', { headers: { cookie, 'sec-fetch-site': 'cross-site' }, form })).status, 403);
  assert.equal((await send('/api/auth/oauth/consent', { headers: { origin: s.reach }, form })).status, 401, 'a nonce without its session');
  const given = await send('/api/auth/oauth/consent', { headers: { cookie }, form });
  assert.equal(backAt(given).searchParams.has('code'), true);
  const replayed = await send('/api/auth/oauth/consent', { headers: { cookie }, form });
  assert.equal(replayed.status, 403);

  const page = await send(`/sign-in?authorize=${request}`, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  const plain = await send('/sign-in');
  assert.doesNotMatch(plain.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
});

test('the stdio App MCP serves no OAuth and takes no OAuth token', { timeout: 60000 }, async () => {
  const tokens = await granted();
  const stdio = await runCli(
    ['--app-mcp', '--api-integers', 'decimal-string', '--config', f.config, '--app', f.appDir, '--commands', f.commands],
    mcpEnv(tokens.access),
  );
  assert.notEqual(stdio.code, 0, stdio.out + stdio.err);
  assert.match(stdio.err, /not a current API token for this App/);
  assert.equal((await read(tokens.access)).status, 200, 'the same token is good where the authorization server is');
  assert.ok(!(stdio.out + stdio.err).includes(tokens.access));
});

test('startup: OAuth without the API served, or over an unprovisioned token store, is refused', { timeout: 120000 }, async () => {
  const port = String(await freePort());
  const noApi = await runCli(
    ['--config', f.config, '--app', f.appDir, '--commands', f.commands, '--host', '127.0.0.1', '--port', port],
    childEnv(),
  );
  assert.equal(noApi.code, 1, noApi.out + noApi.err);
  assert.match(noApi.err, /OAuth authorization server "agents" issues tokens for "shop"'s API, which this server does not serve/);

  const bare = await shopFixture(OAUTH, false);
  try {
    const refused = await runCli(
      [
        ...['--config', bare.config, '--app', bare.appDir, '--commands', bare.commands, '--host', '127.0.0.1', '--port', port],
        ...['--api-reads', '--api-integers', 'decimal-string', '--api-requests-per-minute', '100'],
      ],
      childEnv(),
    );
    assert.equal(refused.code, 1, refused.out + refused.err);
    assert.match(refused.err, /mistri api-token provision/);
  } finally {
    rmSync(bare.directory, { recursive: true, force: true });
  }
});

test('without an authorization server every OAuth address is a 404 and the challenge is plain', { timeout: 120000 }, async () => {
  const plain = await shopFixture(null);
  const server = await serve(plain);
  try {
    for (const path of ['/api/auth/oauth/register', '/api/auth/oauth/authorize', '/api/auth/oauth/token']) {
      assert.equal((await send(path, { server, method: path.endsWith('authorize') ? 'GET' : 'POST' })).status, 404, path);
    }
    assert.equal((await send('/.well-known/oauth-authorization-server/api/auth', { server })).status, 404);
    const bare = await mcp(undefined, 'tools/list', {}, server);
    assert.equal(bare.status, 401);
    assert.equal(bare.headers.get('www-authenticate'), 'Bearer');
  } finally {
    await server.stop();
    rmSync(plain.directory, { recursive: true, force: true });
  }
});

test('the store keeps at most a thousand clients waiting for consent, for a day', { timeout: 60000 }, async () => {
  const own = await shopFixture();
  const db = new DatabaseSync(own.authPath);
  try {
    const store = sqliteOAuthStore(db, 'shop');
    const now = Date.now();
    const insert = db.prepare(
      `INSERT INTO "${SQLITE_API_TOKEN_TABLES.client}" (client_id, name, redirect_uris_json, created_at) VALUES (?, NULL, ?, ?)`,
    );
    db.exec('BEGIN');
    for (let i = 0; i < OAUTH_UNCONSENTED_CLIENTS; i++) {
      insert.run(`twc1.00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, JSON.stringify([CB]), now - 1000);
    }
    db.exec('COMMIT');
    const id = (n: number) => `twc1.10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    assert.equal(await store((t) => registerClient(t, { clientId: id(1), name: null, redirectUris: [CB], now })), 'full');
    // A consented client does not count against the waiting ones.
    db.prepare(`UPDATE "${SQLITE_API_TOKEN_TABLES.client}" SET consented_at = ? WHERE client_id = ?`).run(
      now,
      'twc1.00000000-0000-4000-8000-000000000000',
    );
    assert.equal(await store((t) => registerClient(t, { clientId: id(2), name: null, redirectUris: [CB], now })), 'registered');
    assert.equal(await store((t) => registerClient(t, { clientId: id(3), name: null, redirectUris: [CB], now })), 'full');
    // A day on, the unconsented are pruned; the consented one is kept.
    const later = now + OAUTH_UNCONSENTED_SECONDS * 1000 + 1;
    assert.equal(await store((t) => registerClient(t, { clientId: id(4), name: null, redirectUris: [CB], now: later })), 'registered');
    const left = db
      .prepare(`SELECT client_id FROM "${SQLITE_API_TOKEN_TABLES.client}" ORDER BY client_id`)
      .all()
      .map((row) => row.client_id);
    assert.deepEqual(left, ['twc1.00000000-0000-4000-8000-000000000000', id(4)]);
  } finally {
    db.close();
    rmSync(own.directory, { recursive: true, force: true });
  }
});

test('redirectProblem: the classes refused, and redirectHosts applied strictly', () => {
  for (const [uri, reason] of [
    ['http://example.com/cb', /other than this machine/],
    ['https://a.example/cb#x', /fragment/],
    ['https://*.example/cb', /wildcard/],
    ['https://u:p@a.example/cb', /credential/],
    ['myapp:/cb', /private-use scheme/],
    ['com.example.app://host/cb', /names a host/],
    ['https://a.example/\tcb', /control/],
    ['relative', /absolute/],
    [42, /at most 2048/],
  ] as const) {
    assert.match(redirectProblem(uri, undefined) ?? '', reason, String(uri));
  }
  for (const uri of ['https://a.example/cb', 'http://127.0.0.1:1/cb', 'http://localhost/cb', 'http://[::1]:3/cb', 'com.example.app:/cb']) {
    assert.equal(redirectProblem(uri, undefined), undefined, uri);
  }
  const hosts = ['app.example.com', '127.0.0.1'];
  assert.equal(redirectProblem('https://app.example.com/cb', hosts), undefined);
  assert.equal(redirectProblem('http://127.0.0.1:9/cb', hosts), undefined);
  assert.match(redirectProblem('https://evil.example.com/cb', hosts)!, /not on one of the hosts/);
  assert.match(redirectProblem('https://app.example.com.evil.example/cb', hosts)!, /not on one of the hosts/);
  assert.match(redirectProblem('com.example.app:/cb', hosts)!, /not on one of the hosts/);
});

test('config: the oauth entry is checked, and the App it names must be able to take its tokens', async () => {
  const at = 'mistri.json connection "agents"';
  assert.deepEqual(oauthConnectionOf({ ...OAUTH, redirectHosts: ['app.example.com'] }, at), {
    ...OAUTH,
    redirectHosts: ['app.example.com'],
  });
  assert.throws(() => oauthConnectionOf({ name: 'agents', kind: 'oauth' }, at), /needs "apps"/);
  assert.throws(() => oauthConnectionOf({ name: 'agents', kind: 'oauth', apps: [] }, at), /nonempty list/);
  assert.throws(() => oauthConnectionOf({ name: 'agents', kind: 'oauth', apps: ['a', 'a'] }, at), /same entry twice/);
  assert.throws(() => oauthConnectionOf({ name: 'agents', kind: 'oauth', apps: ['a'], url: 'x' }, at), /takes no "url"/);
  assert.throws(
    () => oauthConnectionOf({ name: 'agents', kind: 'oauth', apps: ['a'], redirectHosts: ['https://a.example'] }, at),
    /redirect host/,
  );
  assert.throws(() => oauthConnectionOf({ name: 'agents', kind: 'oauth', apps: ['a'], ttl: 5 }, at), /takes no "ttl"/);

  const loaded = await loadApp(f.appDir);
  const config = oauthConnectionOf(OAUTH, at);
  assert.deepEqual(oauthProblems(loaded.app, [config]), []);
  assert.deepEqual(oauthRoleCeiling(loaded.app, config), ['operator', 'auditor']);
  assert.deepEqual(oauthRoleCeiling(loaded.app, oauthConnectionOf({ name: 'agents', kind: 'oauth', apps: ['shop'] }, at)), [
    'operator',
    'editor',
    'auditor',
  ]);
  const codes = (app: unknown, service = config) =>
    oauthProblems(app as typeof loaded.app, [service]).map((p) => p.match(/\[([a-z-]+)\]/)![1]);
  assert.deepEqual(codes({ ...loaded.app, auth: undefined }), ['oauth-no-auth']);
  assert.deepEqual(codes({ ...loaded.app, api: undefined }), ['oauth-no-api']);
  assert.deepEqual(codes({ ...loaded.app, api: { ...loaded.app.api, network: false } }), ['oauth-not-network']);
  /* A tenant App takes its tokens too, each bound to one membership (oauth-tenant.test.ts); the ceiling leaves out
     the platform realm, which reads across tenants and so is never a tenant token's role. */
  const tenantApp = {
    ...loaded.app,
    auth: { ...loaded.app.auth, rows: 'tenant', roles: { ...loaded.app.auth!.roles, auditor: { realm: 'platform' } } },
  };
  assert.deepEqual(codes(tenantApp), []);
  assert.deepEqual(oauthRoleCeiling(tenantApp as unknown as typeof loaded.app, config), ['operator']);
  assert.deepEqual(oauthRoleCeiling(loaded.app, config), ['operator', 'auditor'], 'outside a tenant App the realm is not read');
  assert.deepEqual(codes(loaded.app, oauthConnectionOf({ ...OAUTH, roles: ['owner'] }, at)), ['oauth-role-unknown']);
  assert.deepEqual(oauthProblems(loaded.app, [oauthConnectionOf({ ...OAUTH, apps: ['other'] }, at)]), []);

  const runtime = {};
  assert.equal(bearerChallenge(runtime, 'mcp', true), 'Bearer');
  bindOAuthResource(runtime, { origin: 'https://h.example', under: '/tools', appId: 'shop', version: 3 });
  assert.equal(
    bearerChallenge(runtime, 'rest', false),
    'Bearer resource_metadata="https://h.example/.well-known/oauth-protected-resource/tools/api/apps/shop/v3"',
  );
});

test('a v1 token is not a v2 token: the API moves on and the grant is for the old one', { timeout: 120000 }, async () => {
  const tokens = await granted();
  assert.equal((await read(tokens.access)).status, 200);
  await s.stop();
  await f.bump(2);
  s = await serve(f);
  assert.equal((await read(tokens.access, '/item/1', s, 2)).status, 401);
  assert.equal((await refresh(tokens.clientId, tokens.refresh)).json().error, 'invalid_grant');
  const v2 = await send(`/.well-known/oauth-protected-resource/api/apps/shop/v2/$mcp`);
  assert.equal(v2.status, 200, v2.text);
});
