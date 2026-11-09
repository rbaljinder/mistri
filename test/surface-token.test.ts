/**
 * `tokenFor` (embed/handler.ts) and the surface token it mints (auth/surfaceToken.ts): a server component's bearer for
 * one surface of a headless App, with real sign-in beneath it. It authenticates as the person who asked for it, takes
 * the surface it names exactly as `X-Mistri-Surface` does, reads grants and the session live on every request, and
 * opens no route a surface does not take — not the account's, the API's, token issuance or MCP.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { AppHost, LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { issueSurfaceToken, SurfaceTokenRefused, SURFACE_TOKEN_MAX_TTL_SECONDS } from '../packages/mistri/src/server/auth/surfaceToken.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { SURFACE_HEADER } from '../packages/mistri/src/shared/appSurfaces.js';
import { createHandler } from '../packages/mistri/src/server/handler.js';
import { createApp } from './support/createApp.js';
import { namedCommands } from './support/commandCatalog.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SECRET = 'synthetic-surface-token-secret-at-least-thirty-two-characters';
const assignInput = { reviewer: { label: 'Reviewer', type: 'reference', from: 'reviewer', by: 'id', labelColumn: 'name' } } as const;

const APP = {
  id: 'loans',
  name: 'Loans',
  track: 'receipts',
  sources: { lending: { connection: 'loans-db' } },
  resources: {
    loan: {
      access: 'write',
      actions: {
        assign: { label: 'Assign', command: { id: 'assign', version: 1, target: 'loan', input: assignInput } },
        release: { label: 'Release', command: { id: 'release', version: 1, target: 'loan', input: {} } },
      },
    },
    reviewer: {},
    hidden: {},
  },
  auth: {
    signUp: 'open',
    defaultRole: 'manager',
    roles: {
      manager: { read: true, commands: ['assign', 'release'] },
      viewer: { read: ['loan', 'reviewer'] },
    },
  },
  views: { loan: { kind: 'list', from: 'loan' } },
  home: 'loan',
  nav: ['loan'],
  ui: { headless: true },
};
/* Two surfaces: the desk reads loans and reviewers and assigns; the audit reads only the hidden table and runs nothing. */
const SURFACES = [
  { key: 'desk', at: 'surfaces/desk.surface.ts', fields: { label: 'Desk', reads: ['loan', 'reviewer'], commands: ['assign'] } },
  { key: 'audit', at: 'surfaces/audit.surface.ts', fields: { label: 'Audit', reads: ['hidden'], commands: [] } },
];

async function serve(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-surface-token-'));
  const file = join(directory, 'loans.db');
  const seed = new DatabaseSync(file);
  seed.exec(`CREATE TABLE loan(id INTEGER PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0, reviewer INTEGER);
    CREATE TABLE reviewer(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE hidden(id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO loan VALUES (1,0,NULL), (2,0,NULL); INSERT INTO reviewer VALUES (1,'Ada'); INSERT INTO hidden VALUES (1,'secret');`);
  seed.close();
  migrateSqliteCommandJournal(file);
  const registry = new Registry();
  registry.add({ id: 'loans-db', name: 'Loans', url: file, writable: true, source: 'config' });
  const store = join(directory, 'sessions.db');
  const { app: raw, commands: catalog } = namedCommands({ ...APP, auth: { ...APP.auth, store } });
  const app = parseAppConfig(raw, 'surface token fixture', { commands: catalog, surfaces: SURFACES });
  const handle = async ({ db, record }: { db: any; record: any }, input: { reviewer?: number }) => {
    const { version } = await db.loan.update(record, { reviewer: input.reviewer ?? null });
    return { version: Number(version) };
  };
  const output = { parse: (value: unknown) => ({ version: (value as { version: number }).version }) };
  const commands = defineCommands({
    assign: defineCommand({
      source: 'lending',
      target: 'loan',
      read: ['reviewer'],
      input: assignInput,
      validate: (input): { reviewer: number } => ({ reviewer: input.reviewer as number }),
      output,
      handle,
    }),
    release: defineCommand({ source: 'lending', target: 'loan', input: {}, validate: () => ({}), output, handle }),
  });
  // The port is needed before the App's auth exists (its sign-in is told where it is served), so find one first.
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const loaded: LoadedApp = { app, path: join(directory, 'app.ts'), pages: [], sources: {} };
  // Better Auth's per-address sign-in limits are for the internet: this suite signs up from one address, as the harness does.
  const auth = await createAppAuth(loaded, {
    baseURL: origin,
    trustedOrigins: [origin],
    environment: { BETTER_AUTH_SECRET: SECRET, NODE_ENV: 'test', MISTRI_TEST_AUTH_LIMITS: 'off' },
  });
  const host: AppHost = { app: loaded, pages: [], auth };
  const bound = { host: '127.0.0.1', port };
  const server = createApp({ registry, bound, apps: [host], commands: { appId: 'loans', registry: commands } });
  server.listen(port, bound.host);
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    auth.close();
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  });

  const jsonHeaders = { 'content-type': 'application/json' };
  const signUp = async (name: string) => {
    const response = await fetch(`${origin}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { ...jsonHeaders, origin },
      body: JSON.stringify({ name, email: `${name.toLowerCase()}@example.test`, password: `${name}-fixture-password-123` }),
    });
    assert.equal(response.status, 200, await response.text());
    return response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
  };
  const mint = (cookie: string | null, surface: string, ttl?: number) =>
    auth.surfaceTokens!.mint({ headers: new Headers(cookie ? { cookie } : {}) }, { surface, ...(ttl === undefined ? {} : { ttl }) });
  const read = async (table: string, authorization: string | null, extra: Record<string, string> = {}) => {
    const response = await fetch(`${origin}/api/view/run?app=loans`, {
      method: 'POST',
      headers: { ...jsonHeaders, ...(authorization ? { authorization } : {}), ...extra },
      body: JSON.stringify({ app: 'loans', view: { base: table }, count: 'none' }),
      signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, body: (await response.json()) as { rows?: unknown[]; code?: string; error?: string } };
  };
  let runs = 0;
  const run = async (command: string, authorization: string) => {
    const response = await fetch(`${origin}/api/commands/execute?app=loans`, {
      method: 'POST',
      headers: { ...jsonHeaders, authorization },
      body: JSON.stringify({
        command,
        commandVersion: 1,
        key: { id: 1 },
        expectedVersion: 0,
        idempotencyKey: `surface-token-${String(++runs).padStart(4, '0')}`,
        input: command === 'assign' ? { reviewer: 1 } : {},
      }),
      signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, body: (await response.json()) as { code?: string; result?: unknown; error?: string } };
  };
  /* An account's role is the store's (an administrator's to change): the same row a revoked grant is. */
  const setRole = (email: string, role: string) => {
    const db = new DatabaseSync(store);
    try {
      db.prepare('UPDATE "user" SET role = ? WHERE email = ?').run(role, email);
    } finally {
      db.close();
    }
  };
  const get = async (path: string, authorization: string, init: RequestInit = {}) => {
    const response = await fetch(`${origin}${path}`, {
      ...init,
      headers: { authorization, ...jsonHeaders, ...init.headers },
      signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, body: await response.text() };
  };
  return { origin, auth, signUp, mint, read, run, setRole, get, store };
}

const bearer = (token: string) => `Bearer ${token}`;

test('a token for a surface authenticates as the person who asked, and reads inside that surface', async (t) => {
  const f = await serve(t);
  const cookie = await f.signUp('Ada');
  const token = await f.mint(cookie, 'desk');
  assert.doesNotMatch(token, /Ada|ada@/, 'the token is not the session');
  const rows = await f.read('loan', bearer(token));
  assert.equal(rows.status, 200, JSON.stringify(rows.body));
  assert.equal(rows.body.rows?.length, 2);
  // The surface is implied: no X-Mistri-Surface is sent, and the same header naming the same surface agrees.
  assert.equal((await f.read('loan', bearer(token), { [SURFACE_HEADER]: 'desk' })).status, 200);
  const ran = await f.run('assign', bearer(token));
  assert.equal(ran.status, 200, JSON.stringify(ran.body));
  assert.deepEqual(ran.body.result, { version: 1 });
});

test('a read or a command outside the token’s surface is refused 403 as a surface would refuse it', async (t) => {
  const f = await serve(t);
  const token = await f.mint(await f.signUp('Ada'), 'desk');
  const outside = await f.read('hidden', bearer(token));
  assert.equal(outside.status, 403, JSON.stringify(outside.body));
  assert.equal(outside.body.code, 'surface');
  assert.doesNotMatch(JSON.stringify(outside.body), /secret/);
  const command = await f.run('release', bearer(token));
  assert.equal(command.status, 403, JSON.stringify(command.body));
  assert.equal(command.body.code, 'surface');
});

test('a header naming another surface than the token’s is refused 403', async (t) => {
  const f = await serve(t);
  const token = await f.mint(await f.signUp('Ada'), 'desk');
  const conflict = await f.read('hidden', bearer(token), { [SURFACE_HEADER]: 'audit' });
  assert.equal(conflict.status, 403, JSON.stringify(conflict.body));
  assert.equal(conflict.body.code, 'surface');
  assert.match(String(conflict.body.error), /"desk"/);
});

test('an expired token is 401, and so is a tampered one, one made for another App, and one of another kind', async (t) => {
  const f = await serve(t);
  const cookie = await f.signUp('Ada');
  const token = await f.mint(cookie, 'desk');
  assert.equal((await f.read('loan', bearer(token))).status, 200);
  const who = (await (await fetch(`${f.origin}/api/whoami`, { headers: { cookie } })).json()) as { accountId: string };
  // The session id is in the store; a token made for the right person, session and App but already past its time.
  const db = new DatabaseSync(f.store, { readOnly: true });
  const session = db.prepare('SELECT id FROM session WHERE userId = ?').get(who.accountId) as { id: string };
  db.close();
  const claims = { app: 'loans', person: who.accountId, session: session.id, surface: 'desk' };
  const past = issueSurfaceToken(SECRET, { ...claims, expires: Date.now() - 2000 });
  const expired = await f.read('loan', bearer(past));
  assert.equal(expired.status, 401, JSON.stringify(expired.body));
  // The same claims, in time, from the same secret are good: it is the time that refused the one above.
  assert.equal((await f.read('loan', bearer(issueSurfaceToken(SECRET, { ...claims, expires: Date.now() + 30_000 })))).status, 200);
  // Tampered: the body changed to another surface, or the signature cut or altered.
  const [prefixed, signature] = token.split('.').slice(0, 3).slice(1);
  const forged = Buffer.from(
    JSON.stringify([1, 'surface', 'loans', who.accountId, session.id, 'audit', Math.floor(Date.now() / 1000) + 60]),
  ).toString('base64url');
  for (const bad of [
    `mstsf1.${forged}.${signature}`,
    `mstsf1.${prefixed}.${signature.slice(0, -2)}AA`,
    `mstsf1.${prefixed}`,
    `${token}.x`,
    'mstsf1.',
  ]) {
    assert.equal((await f.read('loan', bearer(bad))).status, 401, bad.slice(0, 24));
  }
  // Signed by another secret, or for another App: not this App's token.
  assert.equal(
    (
      await f.read(
        'loan',
        bearer(issueSurfaceToken('another-secret-of-at-least-thirty-two-characters', { ...claims, expires: Date.now() + 30_000 })),
      )
    ).status,
    401,
  );
  assert.equal(
    (await f.read('loan', bearer(issueSurfaceToken(SECRET, { ...claims, app: 'notes', expires: Date.now() + 30_000 })))).status,
    401,
  );
});

test('a token expires on its own clock: a one-second token is refused after it', async (t) => {
  const f = await serve(t);
  const token = await f.mint(await f.signUp('Ada'), 'desk', 1);
  await new Promise((resolve) => setTimeout(resolve, 2100));
  assert.equal((await f.read('loan', bearer(token))).status, 401);
});

test('grants are read live: a role taken away after the token was minted is refused', async (t) => {
  const f = await serve(t);
  const token = await f.mint(await f.signUp('Ada'), 'desk');
  assert.equal((await f.run('assign', bearer(token))).status, 200);
  // A viewer still reads the desk's tables, but holds no command grant.
  f.setRole('ada@example.test', 'viewer');
  assert.equal((await f.read('loan', bearer(token))).status, 200);
  const refused = await f.run('assign', bearer(token));
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.notEqual(refused.body.code, 'surface', 'refused by the grant, not by the surface');
  // A role the surface is not offered to ends it.
  f.setRole('ada@example.test', 'nobody');
  assert.notEqual((await f.read('loan', bearer(token))).status, 200);
});

test('signing out ends the session the token stands for, and the token with it', async (t) => {
  const f = await serve(t);
  const cookie = await f.signUp('Ada');
  const token = await f.mint(cookie, 'desk');
  assert.equal((await f.read('loan', bearer(token))).status, 200);
  const out = await fetch(`${f.origin}/api/auth/sign-out`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: f.origin, cookie },
    body: '{}',
  });
  assert.equal(out.status, 200);
  assert.equal((await f.read('loan', bearer(token))).status, 401);
});

test('a surface token opens no route a surface does not take', async (t) => {
  const f = await serve(t);
  const token = await f.mint(await f.signUp('Ada'), 'desk');
  for (const [method, path] of [
    ['GET', '/api/auth/get-session'],
    ['POST', '/api/auth/sign-out'],
    ['GET', '/api/accounts'],
    ['POST', '/api/tokens'],
    ['GET', '/api/v1/loan'],
    ['POST', '/api/mcp'],
    ['GET', '/api/whoami'],
  ] as const) {
    const answer = await f.get(path, bearer(token), { method, ...(method === 'POST' ? { body: '{}' } : {}) });
    assert.equal(answer.status, 403, `${method} ${path}`);
    assert.match(answer.body, /"code":"surface"/);
    assert.doesNotMatch(answer.body, /ada@example\.test/);
  }
});

test('no session, an unknown surface, a surface the person is not offered, and a ttl past the cap are refused at mint', async (t) => {
  const f = await serve(t);
  const cookie = await f.signUp('Ada');
  const code = async (work: Promise<unknown>) => {
    try {
      await work;
    } catch (error) {
      assert.ok(error instanceof SurfaceTokenRefused, String(error));
      return error.code;
    }
    return 'minted';
  };
  assert.equal(await code(f.mint(null, 'desk')), 'no_session');
  assert.equal(await code(f.mint('mistri-app.session_token=forged', 'desk')), 'no_session');
  assert.equal(await code(f.mint(cookie, 'elsewhere')), 'unknown_surface');
  assert.equal(await code(f.mint(cookie, '')), 'unknown_surface');
  assert.equal(await code(f.mint(cookie, 'desk', SURFACE_TOKEN_MAX_TTL_SECONDS + 1)), 'bad_ttl');
  assert.equal(await code(f.mint(cookie, 'desk', 0)), 'bad_ttl');
  assert.equal(await code(f.mint(cookie, 'desk', Number.NaN)), 'bad_ttl');
  assert.equal(await code(f.mint(cookie, 'desk', SURFACE_TOKEN_MAX_TTL_SECONDS)), 'minted');
  // A role the surface is not offered to cannot ask for it.
  f.setRole('ada@example.test', 'nobody');
  assert.equal(await code(f.mint(cookie, 'desk')), 'unknown_surface');
});

test('the mounted handler mints for the cookie it is given, and the token reads through the same handler', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-surface-token-mount-'));
  const saved = { ...process.env };
  process.env.XDG_CONFIG_HOME = join(directory, 'xdg');
  process.env.BETTER_AUTH_SECRET = SECRET;
  process.env.NODE_ENV = 'test';
  process.env.MISTRI_TEST_AUTH_LIMITS = 'off';
  process.env.MISTRI_OPEN = '0';
  // An App's `@mistriwork/mistri/app` import resolves to this checkout, as an installed package would.
  mkdirSync(join(directory, 'node_modules', '@mistriwork'), { recursive: true });
  symlinkSync(join(ROOT, 'packages', 'mistri'), join(directory, 'node_modules', '@mistriwork', 'mistri'), 'dir');
  const db = join(directory, 'tick.db');
  assert.equal(spawnSync(process.execPath, [join(ROOT, 'examples/databases/tick/seed.mjs'), db]).status, 0);
  const app = join(directory, 'app');
  mkdirSync(join(app, 'surfaces'), { recursive: true });
  writeFileSync(join(app, 'package.json'), '{ "type": "module" }\n');
  writeFileSync(
    join(app, 'app.mjs'),
    `import { defineApp } from '@mistriwork/mistri/app';
export default defineApp({
  id: 'tick', name: 'Tick', connection: 'tick', resources: { task: {} },
  auth: { providers: ['email'], signUp: 'open', defaultRole: 'member', store: ${JSON.stringify(join(directory, 'sessions.db'))}, roles: { member: { read: true } } },
  ui: { headless: true }, views: { tasks: { kind: 'list', from: 'task' } }, home: 'tasks', nav: ['tasks'],
});
`,
  );
  writeFileSync(
    join(app, 'surfaces', 'board.surface.ts'),
    "import { defineSurface } from '@mistriwork/mistri/page';\nexport default defineSurface({ label: 'Board', reads: ['task'], commands: [] });\n",
  );
  const mistri = createHandler({ config: `${db}.json`, app, basePath: '/api/mistri', publicOrigin: 'https://shop.test' });
  t.after(async () => {
    await mistri.close();
    process.env = saved;
    rmSync(directory, { recursive: true, force: true });
  });
  await mistri.ready;
  const origin = 'https://shop.test';
  const call = (path: string, init: RequestInit = {}) =>
    mistri.fetch(new Request(`${origin}/api/mistri${path}`, init), { clientAddress: '203.0.113.7' });
  const signedUp = await call('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ name: 'Ada', email: 'ada@example.test', password: 'Ada-fixture-password-123' }),
  });
  assert.equal(signedUp.status, 200, await signedUp.clone().text());
  const cookie = signedUp.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');

  // A server component's request carries the browser's cookie and nothing else.
  const token = await mistri.tokenFor(new Request(`${origin}/page`, { headers: { cookie } }), { surface: 'board', ttl: 30 });
  const rows = await call('/api/view/run?app=tick', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ app: 'tick', view: { base: 'task' }, count: 'none' }),
  });
  assert.equal(rows.status, 200, await rows.clone().text());
  assert.ok(Array.isArray(((await rows.json()) as { rows: unknown[] }).rows));

  await assert.rejects(mistri.tokenFor(new Request(`${origin}/page`), { surface: 'board' }), { code: 'no_session' });
  await assert.rejects(mistri.tokenFor(new Request(`${origin}/page`, { headers: { cookie } }), { surface: 'missing' }), {
    code: 'unknown_surface',
  });
  await assert.rejects(mistri.tokenFor(new Request(`${origin}/page`, { headers: { cookie } }), { surface: 'board', ttl: 301 }), {
    code: 'bad_ttl',
  });
});
