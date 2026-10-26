/** The real identity/preference owner composed with suite entry and HTTP drain. */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import type { SuiteConfiguration } from '../packages/mistri/src/server/cli/suiteConfig.js';
import { openSuiteIdentity } from '../packages/mistri/src/server/auth/suiteIdentity.js';
import { createSuite } from '../packages/mistri/src/server/http/suite.js';
import { migratePostgresAuthStore } from '../packages/mistri/src/adapters/auth/postgresAuthStore.js';
import { liveSkip } from './live.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
type Engine = 'sqlite' | 'postgres';

/* The business database, the identity store and the grant ledger: SQLite files in the directory, or three
   PostgreSQL databases of the test's own, the suite then keeping nothing on its disk. */
async function stores(t: TestContext, dir: string, engine: Engine) {
  if (engine === 'sqlite') {
    const file = join(dir, 'business.db'),
      business = new DatabaseSync(file);
    business.exec('CREATE TABLE note(id INTEGER PRIMARY KEY)');
    business.close();
    return { business: file, store: join(dir, 'identity.db'), grants: join(dir, 'grants.db') };
  }
  const [business, store, grants] = await Promise.all(['suite_business', 'suite_identity', 'suite_grants'].map(uuidPostgresDatabase));
  for (const database of [business, store, grants]) t.after(() => database.drop());
  const client = await pgClient(business.url);
  try {
    await client.query('CREATE TABLE note(id integer PRIMARY KEY)');
  } finally {
    await client.end();
  }
  await migratePostgresAuthStore(store.url);
  return { business: business.url, store: store.url, grants: grants.url };
}

async function fixture(t: TestContext, publicRoot = false, engine: Engine = 'sqlite') {
  const dir = mkdtempSync(join(tmpdir(), 'tw-suite-entry-preferences-'));
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const where = await stores(t, dir, engine);
  const loaded = (id: string): LoadedApp => ({
    path: join(dir, id),
    pages: [],
    sources: {},
    app: parseAppConfig(
      {
        id,
        name: id,
        resources: { note: {} },
        auth: {
          providers: ['email'],
          roles: { reader: { read: true } },
          ...(id === 'alpha' && publicRoot ? { public: { read: ['note'] } } : {}),
        },
        views: { notes: { kind: 'list', from: 'note' } },
        home: 'notes',
      },
      'preference fixture',
    ),
  });
  const deployments = ['alpha', 'beta'].map((id) => ({
    app: loaded(id),
    basePath: id === 'alpha' ? '/tools' : '/tools/beta',
    environment: {},
    connections: [{ name: 'data', url: where.business }],
  }));
  const config: SuiteConfiguration = {
    port,
    basePath: '/tools',
    apps: [],
    identity: {
      id: 'shared',
      name: 'Suite',
      store: where.store,
      grants: where.grants,
      environment: { BETTER_AUTH_SECRET: 'test-suite-entry-preferences-secret-longer-than-thirty-two-characters' },
    },
  };
  let identity: Awaited<ReturnType<typeof openSuiteIdentity>> | undefined, suite: Awaited<ReturnType<typeof createSuite>> | undefined;
  t.after(async () => {
    await suite?.close();
    if (!suite) identity?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const open = async () => {
    identity = await openSuiteIdentity(config, deployments);
    suite = await createSuite(
      deployments.map((item) => ({
        id: item.app.app.id,
        open: async () => ({
          server: createServer((_req, res) => res.end(`child:${item.app.app.id}`)),
          stop: async () => {},
          close: async () => {},
        }),
      })),
      { base: '/tools', mounts: { alpha: '/', beta: '/beta' } },
      identity,
    );
    await new Promise<void>((resolve) => suite!.server.listen(port, '127.0.0.1', resolve));
  };
  await open();
  const origin = `http://127.0.0.1:${port}`;
  const call = async (path: string, headers: Record<string, string> = {}, body?: unknown, method?: string) => {
    const response = await fetch(`${origin}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      redirect: 'manual',
      headers: { origin, 'content-type': 'application/json', connection: 'close', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    return {
      status: response.status,
      text,
      body: response.headers.get('content-type')?.includes('json') && text ? JSON.parse(text) : undefined,
      location: response.headers.get('location'),
      cache: response.headers.get('cache-control'),
      cookie: response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; '),
    };
  };
  const account = async (name: string) => {
    const answer = await call(
      '/tools/api/auth/sign-up/email',
      {},
      { name, email: `${name}@example.test`, password: 'test-password-long-enough' },
    );
    assert.equal(answer.status, 200, answer.text);
    return { id: answer.body.user.id as string, headers: { cookie: answer.cookie, 'x-mistri-account': answer.body.user.id as string } };
  };
  const grant = async (subjectId: string, appId: string, roles: string[]) =>
    identity!.grants.change({
      subjectId,
      appId,
      roles,
      actorId: 'operator',
      declaredRoles: ['reader', 'admin'],
      expectedRevision: (await identity!.grants.read(subjectId, appId)).revision,
    });
  return {
    dir,
    config,
    deployments,
    call,
    account,
    grant,
    identity: () => identity!,
    restart: async () => {
      await suite!.close();
      suite = undefined;
      identity = undefined;
      await open();
    },
  };
}

for (const engine of ['sqlite', 'postgres'] as const)
  test(
    `default preferences are account-bound CAS hints, persist, and select only currently granted deployed Apps (${engine})`,
    { skip: engine === 'postgres' ? liveSkip('postgres', LIVE) : false },
    async (t) => {
      const f = await fixture(t, false, engine),
        owner = await f.account('owner'),
        peer = await f.account('peer');
      assert.equal((await f.call('/tools/')).location, '/tools/_mistri/apps?entry=1');
      await f.grant(owner.id, 'beta', ['reader']);
      assert.equal((await f.call('/tools/', owner.headers)).location, '/tools/beta/', 'the only App the account has is its entry');
      await f.grant(owner.id, 'alpha', ['admin']);
      assert.equal((await f.call('/tools/', owner.headers)).text, 'child:alpha', 'revision zero preserves root fallback');
      const path = '/tools/api/suite/preferences';
      assert.deepEqual((await f.call(path, owner.headers)).body, { accountId: owner.id, defaultApp: null, revision: 0 });
      assert.equal((await f.call(path, { cookie: owner.headers.cookie })).status, 409);
      assert.equal((await f.call(path, { ...owner.headers, 'x-mistri-account': peer.id })).status, 409);
      assert.equal((await f.call(path, { ...owner.headers, origin: 'https://foreign.invalid' })).status, 403);
      assert.equal((await f.call(path, owner.headers, { defaultApp: 'not-deployed', expectedRevision: 0 })).status, 403);
      assert.equal((await f.call(path, peer.headers, { defaultApp: 'alpha', expectedRevision: 0 })).status, 403);
      assert.equal((await f.call(path, owner.headers, { defaultApp: 'beta', expectedRevision: 0, subjectId: peer.id })).status, 400);
      assert.equal((await f.call(path, owner.headers, { defaultApp: 'beta', expectedRevision: 0 })).status, 200);
      const links = (await f.call('/tools/api/suite/apps', owner.headers)).body.apps;
      assert.equal(links.find((item: { id: string }) => item.id === 'alpha').href, '/tools/?app=alpha');
      assert.equal(links.find((item: { id: string }) => item.id === 'beta').href, '/tools/beta/');
      assert.equal(
        (await f.call('/tools/?app=alpha', owner.headers)).text,
        'child:alpha',
        'explicit root link overrides the saved beta default',
      );
      assert.equal((await f.call('/tools/?app=alpha')).location, '/tools/_mistri/apps?entry=1&app=alpha');
      assert.equal((await f.call('/tools/?app=alpha&app=alpha', owner.headers)).location, '/tools/_mistri/apps');
      assert.equal((await f.call('/tools/?app=beta', owner.headers)).location, '/tools/_mistri/apps');
      for (const method of ['GET', 'HEAD']) {
        const root = await f.call('/tools/?returnTo=https://foreign.invalid', owner.headers, undefined, method);
        assert.equal(root.location, '/tools/beta/');
        assert.equal(root.cache, 'no-store');
      }
      assert.equal((await f.call('/tools/notes', owner.headers)).text, 'child:alpha', 'deep links remain explicit');
      assert.equal((await f.call('/tools/beta/', owner.headers)).text, 'child:beta', 'switching does not mutate preference');
      assert.deepEqual((await f.call('/tools/api/suite/apps', owner.headers)).body.preference, { defaultApp: 'beta', revision: 1 });
      assert.equal((await f.call(path, owner.headers, { defaultApp: null, expectedRevision: 0 })).status, 409);
      assert.equal((await f.call('/tools/api/auth/sign-out', owner.headers, {})).status, 200);
      assert.equal((await f.call('/tools/', owner.headers)).location, '/tools/_mistri/apps?entry=1');
      const login = await f.call(
        '/tools/api/auth/sign-in/email',
        {},
        { email: 'owner@example.test', password: 'test-password-long-enough' },
      );
      assert.equal(login.status, 200);
      owner.headers.cookie = login.cookie;
      assert.equal(
        (await f.call('/tools/', owner.headers)).location,
        '/tools/beta/',
        'fixed entry continuation after fresh sign-in uses the saved default',
      );
      await f.restart();
      assert.equal((await f.call('/tools/', owner.headers)).location, '/tools/beta/');
      await f.grant(owner.id, 'beta', []);
      assert.equal((await f.call('/tools/', owner.headers)).location, '/tools/_mistri/apps', 'revoked default never falls through to root');
      assert.equal((await f.call(path, owner.headers, { defaultApp: null, expectedRevision: 1 })).status, 200);
      assert.equal((await f.call('/tools/', owner.headers)).location, '/tools/_mistri/apps', 'explicit Ask each time wins over root grant');
      assert.equal((await f.call(path, owner.headers, { defaultApp: 'alpha', expectedRevision: 2 })).status, 200);
      assert.equal((await f.call('/tools/', owner.headers)).text, 'child:alpha', 'root default does not redirect to itself');
      await f.grant(owner.id, 'beta', ['reader']);
      assert.equal((await f.call(path, owner.headers, { defaultApp: 'beta', expectedRevision: 3 })).status, 200);
      f.deployments.splice(1, 1);
      assert.equal(
        (await f.call('/tools/', owner.headers)).location,
        '/tools/_mistri/apps',
        'removed App cannot remain a default destination',
      );
      assert.deepEqual(await f.identity().preferences.read(peer.id), { defaultApp: null, revision: 0 });
    },
  );

test('an explicitly public root remains the public entry even with a saved default', async (t) => {
  const f = await fixture(t, true),
    owner = await f.account('owner');
  await f.grant(owner.id, 'beta', ['reader']);
  assert.equal((await f.call('/tools/api/suite/preferences', owner.headers, { defaultApp: 'beta', expectedRevision: 0 })).status, 200);
  assert.equal((await f.call('/tools/', owner.headers)).text, 'child:alpha');
  assert.equal((await f.call('/tools/')).text, 'child:alpha');
});

test('preferences storage refuses business/auth/grant aliases and sidecars before opening SQLite', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'tw-preference-separation-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const mode of [
    'business-hardlink',
    'business-symlink',
    'business-sidecar',
    'identity-alias',
    'grant-alias',
    'reverse-sidecar',
    'foreign-layout',
  ]) {
    const dir = join(home, mode);
    mkdirSync(dir);
    const store = join(dir, 'identity.db'),
      prefs = `${store}.preferences`,
      grants = join(dir, 'grants.db');
    const business = join(dir, 'business.db');
    const db = new DatabaseSync(business);
    db.exec('CREATE TABLE note(id INTEGER PRIMARY KEY)');
    db.close();
    const before = readFileSync(business);
    if (mode === 'business-hardlink') linkSync(business, prefs);
    if (mode === 'business-symlink') symlinkSync(business, prefs);
    if (mode === 'business-sidecar') symlinkSync(business + '-wal', prefs);
    if (mode === 'identity-alias') {
      writeFileSync(store, 'identity untouched');
      linkSync(store, prefs);
    }
    if (mode === 'grant-alias') {
      writeFileSync(grants, 'grants untouched');
      linkSync(grants, prefs);
    }
    if (mode === 'reverse-sidecar') {
      writeFileSync(prefs, 'preferences untouched');
      symlinkSync(prefs + '-wal', store);
    }
    if (mode === 'foreign-layout') {
      const foreign = new DatabaseSync(prefs);
      foreign.exec('CREATE TABLE foreign_data(id)');
      foreign.close();
    }
    const snapshot = existsSync(prefs) ? readFileSync(prefs) : undefined;
    const app: LoadedApp = {
      path: dir,
      pages: [],
      sources: {},
      app: parseAppConfig(
        {
          id: 'alpha',
          name: 'Alpha',
          resources: { note: {} },
          auth: { providers: ['email'], roles: { reader: { read: true } } },
          views: { notes: { kind: 'list', from: 'note' } },
          home: 'notes',
        },
        mode,
      ),
    };
    await assert.rejects(
      openSuiteIdentity(
        {
          port: 49999,
          basePath: '',
          apps: [],
          identity: {
            id: 'shared',
            name: 'Suite',
            store,
            grants,
            environment: { BETTER_AUTH_SECRET: 'test-separation-secret-longer-than-thirty-two-characters' },
          },
        },
        [{ app, basePath: '', environment: {}, connections: [{ name: 'data', url: business }] }],
      ),
      /separate|unavailable/,
    );
    assert.deepEqual(readFileSync(business), before);
    if (snapshot) assert.deepEqual(readFileSync(prefs), snapshot);
  }
});

test('suite tracks an asynchronous bare-root entry and prevents child dispatch after shutdown starts', async () => {
  let release!: () => void,
    arrived!: () => void,
    closed = false,
    dispatched = 0;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    entered = new Promise<void>((resolve) => {
      arrived = resolve;
    });
  const suite = await createSuite(
    [
      {
        id: 'root',
        open: async () => ({
          server: createServer((_req, res) => {
            dispatched++;
            res.end('child');
          }),
          stop: async () => {},
          close: async () => {},
        }),
      },
    ],
    { mounts: { root: '/' } },
    {
      route: () => undefined,
      entry: async (_req: IncomingMessage) => {
        arrived();
        await gate;
        assert.equal(closed, false);
        return undefined;
      },
      close: () => {
        closed = true;
      },
    },
  );
  await new Promise<void>((resolve) => suite.server.listen(0, '127.0.0.1', resolve));
  const response = fetch(`http://127.0.0.1:${(suite.server.address() as { port: number }).port}/`, { signal: AbortSignal.timeout(5000) });
  try {
    await entered;
    const stopping = suite.close();
    assert.equal(closed, false);
    release();
    assert.equal((await response).status, 503);
    await stopping;
    assert.equal(dispatched, 0);
    assert.equal(closed, true);
  } finally {
    release();
    await suite.close();
  }
});
