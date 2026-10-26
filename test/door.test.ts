// test-package: shared — the door's one table, sent to every dispatcher of both products (scripts/test-owners.mjs).
/**
 * The one door (http/trust.ts `doorRefusal`): every HTTP surface asks it, and
 * this file is the list of them. Each row names a module, the rule it asks
 * with — what it checks, and what it leaves out and why — and, where the
 * surface can be stood up here, a foreign Host and a cross-origin write sent
 * to it, which it must refuse as the door does.
 *
 * Three parts. The rule itself, as a table. The census: no surface calls the
 * door's parts (`hostRefusal`, `originRefusal`, `crossOriginRefusal`) on its
 * own, every module that calls the door is a row here, and each row's rules
 * are the ones its source asks — so a surface that changes what it checks
 * changes this file in the same commit. And the surfaces themselves, asked.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { doorRefusal, vouchForOrigin, type Bound, type DoorRule } from '../packages/engine/src/server/http/trust.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { DISPATCHERS } from '../packages/engine/src/server/http/router.js';
import { createSuite } from '../packages/mistri/src/server/http/suite.js';
import { createHandler } from '../packages/mistri/src/server/handler.js';
import { createAnalyticsBeaconHttp } from '../packages/mistri/src/server/analytics/beaconHttp.js';
import { createFlagHttp } from '../packages/mistri/src/server/flags/http.js';
import { createFlagValuesHttp } from '../packages/mistri/src/server/flags/valuesHttp.js';
import { createExperimentHttp } from '../packages/mistri/src/server/experiments/http.js';
import { createExperimentExposureHttp, EXPERIMENT_EXPOSURES_PATH } from '../packages/mistri/src/server/experiments/exposureHttp.js';
import { createExperimentVisitorHttp } from '../packages/mistri/src/server/experiments/visitorHttp.js';
import { suiteGrantHttp } from '../packages/mistri/src/server/auth/suiteGrantHttp.js';
import { suiteLinkHttp } from '../packages/mistri/src/server/auth/suiteLinkHttp.js';
import { suitePreferencesHttp } from '../packages/mistri/src/server/auth/suitePreferencesHttp.js';
import { admitApiRequest, apiAdmission } from '../packages/mistri/src/server/api/apiHttpAdmission.js';
import { createTenantAdministrationHttp } from '../packages/mistri/src/server/tenant/tenantAdministrationHttp.js';
import { createTenantInvitationHttp } from '../packages/mistri/src/server/tenant/tenantInvitationHttp.js';
import { createTenantAuthenticatedHttpServer } from '../packages/mistri/src/server/tenant/tenantAuthenticatedHttp.js';
import { provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createAppAuth, type AppAuthRuntime } from '../packages/mistri/src/server/auth/auth.js';
import { loadApp, type AppHost, type LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { ANALYTICS_BEACON_PATH } from '../packages/mistri/src/shared/appAnalytics.js';
import { APP_FLAG_VALUES_PATH, EXPERIMENT_VISITOR_PATH } from '../packages/mistri/src/shared/appFlagValues.js';
import { ADMINISTRATION_HTTP_ROOT } from '../packages/mistri/src/shared/tenantAdministration.js';
import { INVITATION_HTTP_ROOT } from '../packages/mistri/src/shared/tenantInvitations.js';
import { inPackages } from './support/packages.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FOREIGN = 'evil.example';
const STRANGER = 'http://evil.example';

/* --------------------------------------------------------------------------------------------- the rule */

const asked = (headers: Record<string, string>, method = 'POST') => ({ method, headers }) as unknown as IncomingMessage;
const bound: Bound = { host: '127.0.0.1', port: 4111 };
const own = { host: '127.0.0.1:4111' };
const json = { 'content-type': 'application/json' };

describe('the rule', () => {
  const cases: Array<[string, Record<string, string>, DoorRule, string | null]> = [
    ['a foreign Host, read', { host: FOREIGN }, { writing: false }, 'host'],
    ['a foreign Host, even where the Origin is not asked', { host: FOREIGN }, { writing: true, origin: 'none', json: false }, 'host'],
    ['a read from another page, by default', { ...own, origin: STRANGER }, { writing: false }, null],
    [
      'a read from another page, where reads are the account’s own',
      { ...own, origin: STRANGER },
      { writing: false, origin: 'always' },
      'origin',
    ],
    ['a write from another page', { ...own, origin: STRANGER, ...json }, { writing: true }, 'origin'],
    ['a write from its own page', { ...own, origin: 'http://127.0.0.1:4111', ...json }, { writing: true }, null],
    ['a write with no Origin (curl)', { ...own, ...json }, { writing: true }, null],
    ['a form-encoded write', { ...own, 'content-type': 'application/x-www-form-urlencoded' }, { writing: true }, 'json'],
    ['a form-encoded write where the body is not asked', { ...own, 'content-type': 'text/plain' }, { writing: true, json: false }, null],
    [
      'a provider’s cross-site POST, where the surface proves its caller',
      { ...own, origin: STRANGER, 'sec-fetch-site': 'cross-site' },
      { writing: true, origin: 'none', json: false },
      null,
    ],
    [
      'a cross-site fetch, where the surface asks',
      { ...own, 'sec-fetch-site': 'cross-site', ...json },
      { writing: true, sameSite: true },
      'site',
    ],
    ['a cross-site fetch, where it does not', { ...own, 'sec-fetch-site': 'cross-site', ...json }, { writing: true }, null],
    [
      'a cross-site read, where reads are asked',
      { ...own, 'sec-fetch-site': 'cross-site' },
      { writing: false, origin: 'always', sameSite: true },
      'site',
    ],
  ];
  for (const [name, headers, rule, check] of cases) {
    test(name, () => assert.equal(doorRefusal(asked(headers), bound, rule)?.check ?? null, check));
  }

  test("an Origin the embed door vouched for passes a write's door, and never one that asks on reads", () => {
    const req = asked({ ...own, origin: 'https://host.example', ...json });
    vouchForOrigin(req);
    assert.equal(doorRefusal(req, bound, { writing: true }), null);
    assert.equal(doorRefusal(req, bound, { writing: true, origin: 'always' })?.check, 'origin');
  });

  test('the Host is asked before anything else, so a rebinding page learns nothing more', () => {
    const refusal = doorRefusal(asked({ host: FOREIGN, origin: STRANGER, 'sec-fetch-site': 'cross-site' }), bound, {
      writing: true,
      origin: 'always',
      sameSite: true,
    });
    assert.equal(refusal?.check, 'host');
    assert.match(refusal!.error, /only answers on 127\.0\.0\.1:4111/);
  });
});

/* --------------------------------------------------------------------------------------------- the census */

/**
 * Every module that asks the door, and the rules it asks with, as its source
 * spells them. `why` is what each leaves out, where it leaves something out.
 */
const SURFACES: Record<string, { rules: string[]; why: string }> = {
  'packages/engine/src/server/http/door.ts': {
    rules: ['{ writing: false }', '{ writing: true }'],
    why: 'The engine door both products’ dispatchers hold — the database browser’s (http/browserHandler.ts), which has no session part, and the App framework’s (http/handler.ts, and embed/handler.ts and a suite’s Apps through it): the Host first, then a write’s Origin and body after the product’s session part (an App’s, gate.ts) has said whether its Origin is vouched for.',
  },
  'packages/mistri/src/server/http/gate.ts': {
    rules: ["{ writing: writes(req), origin: ownProof ? 'none' : 'writes', sameSite: true, json: false }"],
    why: 'Better Auth’s routes, answered inside an App’s session part: as a tenant’s native auth holds them (the rule auth.ts `authHoldsOwnProof` names for both).',
  },
  'packages/mistri/src/server/http/server.ts': {
    rules: ["{ writing: writes(req), origin: 'none', json: false }"],
    why: 'An inbound endpoint (a defineInbound, or an integration’s webhooks lowered onto one) and an unsubscribe link prove themselves (a signature, a signed token) before the gate: the Host only, as the tenant server holds them.',
  },
  'packages/mistri/src/server/tenant/tenantHttp.ts': { rules: ['{ writing: changesSomething(req) }'], why: 'A tenant App’s data server.' },
  'packages/mistri/src/server/tenant/tenantAuthenticatedHttp.ts': {
    rules: [
      'proven',
      'proven',
      'proven',
      '{ writing: false }',
      "{ writing: writes(req), origin: ownProof ? 'none' : 'writes', sameSite: true, json: false }",
    ],
    why: 'Mail, an unsubscribe link and an integration’s webhook prove themselves (a signature, a signed token): the Host only. Then the Host for everything; each dispatcher further in holds its write’s line. Native auth asks the fetch site and Origin on a write but not a JSON body (sign-out is bodyless, a callback a form POST), and not the Origin where a route holds its own proof.',
  },
  'packages/mistri/src/server/tenant/tenantPublicHttp.ts': { rules: ['{ writing: !reading }'], why: 'A public form.' },
  'packages/mistri/src/server/http/pageCommandRoutes.ts': {
    rules: ["{ writing: true, origin: 'always', sameSite: true }"],
    why: 'A public page’s command: from the page’s own origin, never a host an embed token vouches for, since the ticket is the page’s.',
  },
  'packages/mistri/src/server/tenant/tenantPublicReadHttp.ts': { rules: ['{ writing: !get }'], why: 'A visitor’s reads.' },
  'packages/mistri/src/server/tenant/tenantAssistant.ts': {
    rules: ["{ writing: req.method !== 'GET' }"],
    why: 'A HEAD is held as a write: the assistant answers none.',
  },
  'packages/mistri/src/server/tenant/tenantAdministrationHttp.ts': {
    rules: ["{ writing: !get && req.method === 'POST', origin: 'always', sameSite: true }"],
    why: 'An administrator’s reads are the Origin’s business too.',
  },
  'packages/mistri/src/server/tenant/tenantInvitationHttp.ts': {
    rules: ["{ writing: !get && req.method === 'POST', origin: 'always', sameSite: true }"],
    why: 'As administration.',
  },
  'packages/mistri/src/server/console/host.ts': { rules: ['{ writing: writes(req) }'], why: 'The suite console.' },
  'packages/mistri/src/server/auth/suiteIdentity.ts': {
    rules: ['{ writing: false }', '{ writing: false }', '{ writing: false }'],
    why: 'GET-only entry and gate; the routes below hold their writes’ lines (Better Auth, preferences, grants).',
  },
  'packages/mistri/src/server/auth/suiteGrantHttp.ts': { rules: ['{ writing: true }'], why: 'POST only.' },
  'packages/mistri/src/server/auth/suiteLinkHttp.ts': { rules: ['{ writing: true }'], why: 'POST only.' },
  'packages/mistri/src/server/auth/suitePreferencesHttp.ts': {
    rules: ["{ writing: req.method === 'POST', origin: 'always' }"],
    why: 'The account’s own preferences, read or written. A body that is not JSON is answered 400.',
  },
  'packages/mistri/src/server/api/apiHttpAdmission.ts': {
    rules: ["{ writing: writes(req), origin: 'always', json: false }"],
    why: 'The App API and its MCP: the bearer is the credential, and the API’s own reader refuses a body’s type in its own shape.',
  },
  'packages/mistri/src/server/flags/http.ts': { rules: ["{ writing, origin: 'always' }"], why: 'An operator’s flag controls.' },
  'packages/mistri/src/server/flags/valuesHttp.ts': {
    rules: ["{ writing: false, origin: 'always' }"],
    why: 'GET only, read as the visitor.',
  },
  'packages/mistri/src/server/experiments/http.ts': { rules: ["{ writing, origin: 'always' }"], why: 'As flags.' },
  'packages/mistri/src/server/experiments/exposureHttp.ts': { rules: ['{ writing: true, sameSite: true }'], why: 'A beacon-shaped POST.' },
  'packages/mistri/src/server/experiments/visitorHttp.ts': { rules: ['{ writing: true, sameSite: true }'], why: 'POST only.' },
  'packages/mistri/src/server/analytics/beaconHttp.ts': { rules: ['{ writing: true, sameSite: true }'], why: 'POST only, same page.' },
};

/**
 * What answers HTTP and does not ask the door, and why. Each is a decision,
 * not an oversight; a new one is added here with its reason.
 */
const EXEMPT: Record<string, string> = {
  'packages/engine/src/server/http/probes.ts':
    'An orchestrator’s /healthz and /readyz carry nothing but their word, and a probe arrives addressed to the pod, not to a name the operator listed.',
  'packages/mistri/src/server/embed/boot.ts':
    'The bare embed boot is the protocol and version alone, read cross-origin before any session; the boot with data in it goes through the gate.',
  'packages/mistri/src/server/observe/http.ts':
    'The dev observer answers this machine only, peer and Host (loopbackRequest): stricter than the door.',
  'packages/mistri/src/server/themeBench/bench.ts': 'Loopback only, as the observer.',
};

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}
const modules = new Map(
  inPackages('src')
    .flatMap((dir) => sources(join(ROOT, dir)))
    .map((path) => [relative(ROOT, path), readFileSync(path, 'utf8')]),
);

describe('the census', () => {
  test("no surface asks the door's parts on its own", () => {
    const strays = [...modules].flatMap(([path, text]) =>
      path !== 'packages/engine/src/server/http/trust.ts' && /\b(hostRefusal|originRefusal|crossOriginRefusal)\s*\(/.test(text)
        ? [path]
        : [],
    );
    assert.deepEqual(strays, []);
  });

  test('every module that asks the door is a row here, and asks with the rules its row says', () => {
    const asking = [...modules].filter(
      ([path, text]) => path !== 'packages/engine/src/server/http/trust.ts' && text.includes('doorRefusal('),
    );
    assert.deepEqual(asking.map(([path]) => path).sort(), Object.keys(SURFACES).sort());
    for (const [path, text] of asking) {
      const rules = [...text.matchAll(/doorRefusal\([^,()]+(?:\(\))?,\s*[\w.]+(?:\(\))?,\s*(\{[^{}]*\}|\w+)\s*\)/g)].map((m) => m[1]);
      assert.deepEqual(rules, SURFACES[path].rules, path);
    }
  });

  test('each exemption is a module that still exists, and the loopback ones still say so', () => {
    for (const path of Object.keys(EXEMPT)) assert.ok(modules.has(path), path);
    assert.match(modules.get('packages/mistri/src/server/observe/http.ts')!, /if \(!loopbackRequest\(req\)\)/);
    assert.match(modules.get('packages/mistri/src/server/themeBench/bench.ts')!, /loopbackRequest/);
  });
});

/* --------------------------------------------------------------------------------------------- the surfaces */

type Answer = { status: number; body: string };

function ask(port: number, path: string, headers: Record<string, string>, method = 'GET', body?: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { ...headers, connection: 'close' } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function listening(server: Server): Promise<number> {
  if (!server.listening) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  }
  return (server.address() as { port: number }).port;
}

/** A surface's handler on a port of its own, its `Bound` filled in once the port is known. */
async function standalone(
  make: (bound: Bound) => (req: IncomingMessage, res: ServerResponse) => unknown,
): Promise<{ port: number; close: () => Promise<void> }> {
  const where: Bound = { host: '127.0.0.1', port: 0 };
  let handler: ((req: IncomingMessage, res: ServerResponse) => unknown) | undefined;
  const server = createServer(async (req, res) => {
    try {
      if ((await handler!(req, res)) === false && !res.headersSent) res.writeHead(404).end();
    } catch (error) {
      if (!res.headersSent) res.writeHead(500).end(String(error));
    }
  });
  const port = await listening(server);
  where.port = port;
  handler = make(where);
  return { port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/**
 * A row: how to stand the surface up, a read and a write it answers, and the
 * statuses its refusals are. A row with no write is a GET-only surface.
 */
interface Row {
  name: string;
  start(): Promise<{ port: number; close: () => Promise<void> }>;
  read?: { path: string; method?: string; headers?: Record<string, string> };
  write?: { path: string; method?: string; body?: string; headers?: Record<string, string> };
  refused?: number[];
  /** A provider's delivery: the Host is asked, the Origin and body are not, so another page's write is answered. */
  deliveries?: true;
  /** The dispatchers (http/router.ts `DISPATCHERS`) this row's requests are held by. */
  dispatchers?: readonly string[];
}

const stub = {} as never;
const scratch = mkdtempSync(join(tmpdir(), 'tablewalk-door-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

async function workbench(): Promise<{ port: number; close: () => Promise<void> }> {
  const where: Bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry: new Registry(), bound: where });
  where.port = await listening(server);
  return { port: where.port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** An App with no sign-in over one writable SQLite table, served as the App framework's start serves it. */
async function appServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const directory = mkdtempSync(join(scratch, 'app-'));
  const data = join(directory, 'app.db');
  const db = new DatabaseSync(data);
  db.exec('CREATE TABLE item(id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  db.close();
  const app = join(directory, 'app');
  mkdirSync(app);
  writeFileSync(
    join(app, 'app.json'),
    JSON.stringify({
      name: 'Door',
      resources: { item: { access: 'write' } },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
      nav: ['items'],
    }),
  );
  const registry = new Registry();
  registry.add({ name: 'rw', url: data, writable: true, source: 'config' });
  registry.setActive('rw');
  await registry.open('rw');
  const where: Bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, apps: [{ app: await loadApp(app), pages: [] }], bound: where });
  where.port = await listening(server);
  return {
    port: where.port,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await registry.closeAll();
    },
  };
}

/**
 * An App server's inbound endpoints (an integration's webhooks among them), answered before the gate by a stub that takes
 * anything it is handed: a signed delivery proves itself, so neither its Origin nor its body's type is asked,
 * but the Host is this deployment's, as the tenant server holds it.
 */
async function delivering(): Promise<{ port: number; close: () => Promise<void> }> {
  const where: Bound = { host: '127.0.0.1', port: 0 };
  const handle = async (_req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (!url.pathname.startsWith('/api/inbound/')) return false;
    res.writeHead(202).end();
    return true;
  };
  const server = createApp({ registry: new Registry(), bound: where, inbound: { handle } });
  where.port = await listening(server);
  return { port: where.port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** An App mounted in somebody else's server at /crm (embed/handler.ts), as embed-handler.test.ts mounts Tick. */
async function embedded(): Promise<{ port: number; close: () => Promise<void> }> {
  const directory = mkdtempSync(join(scratch, 'embed-'));
  process.env.XDG_CONFIG_HOME = join(directory, 'xdg');
  mkdirSync(join(directory, 'node_modules'));
  mkdirSync(join(directory, 'node_modules', '@mistriwork'), { recursive: true });
  symlinkSync(join(ROOT, 'packages', 'mistri'), join(directory, 'node_modules', '@mistriwork', 'mistri'), 'dir');
  const db = join(directory, 'tick.db');
  assert.equal(spawnSync(process.execPath, [join(ROOT, 'examples/databases/tick/seed.mjs'), db]).status, 0);
  const app = join(directory, 'tick-app');
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), '{ "type": "module" }\n');
  writeFileSync(
    join(app, 'app.mjs'),
    "import { defineApp } from '@mistriwork/mistri/app';\nexport default defineApp({ id: 'tick', name: 'Tick', connection: 'tick', resources: { task: { access: 'write' } }, views: { tasks: { kind: 'list', from: 'task' } }, home: 'tasks', nav: ['tasks'] });\n",
  );
  const tw = createHandler({ config: `${db}.json`, app, basePath: '/crm', publicOrigin: 'https://shop.test' });
  await tw.ready;
  const host = createServer((req, res) => (req.url?.startsWith('/crm') ? tw.node(req, res) : res.end('host page')));
  const port = await listening(host);
  return {
    port,
    close: async () => {
      host.closeAllConnections();
      await new Promise<void>((resolve) => host.close(() => resolve()));
      await tw.close();
    },
  };
}

/** A tenant App's browser host over SQLite, as tenant-browser-host.test.ts stands one up. */
async function tenantHost(): Promise<{ port: number; close: () => Promise<void> }> {
  const appId = 'door-proof';
  const directory = mkdtempSync(join(scratch, 'tenant-'));
  const business = join(directory, 'business.db'),
    store = join(directory, 'auth.db');
  const db = new DatabaseSync(business);
  db.exec('CREATE TABLE physical_item(id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL)');
  db.close();
  const source = { id: 'business', connection: 'fixture-business' };
  provisionSqliteTenantStore(business, { appId, source, storeId: 'fixture-store' });
  const probe = createServer();
  const port = await listening(probe);
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const loaded: LoadedApp = {
    path: join(directory, 'app.ts'),
    pages: [],
    sources: {},
    app: parseAppConfig(
      {
        id: appId,
        name: 'Door proof',
        auth: { store, signUp: 'open', rows: 'tenant', roles: { member: { read: true } } },
        sources: { business: { connection: source.connection } },
        resources: { item: { physical: 'physical_item', owner: 'tenant' } },
        views: { items: { kind: 'list', from: 'item' } },
        home: 'items',
        nav: ['items'],
      },
      'door fixture',
    ),
  };
  const auth: AppAuthRuntime = await createAppAuth(loaded, {
    baseURL: origin,
    trustedOrigins: [origin],
    environment: { BETTER_AUTH_SECRET: 'synthetic-door-secret-at-least-thirty-two-characters-long' },
  });
  const owner = await createTenantAuthenticatedHttpServer({
    loaded,
    auth,
    browser: true,
    bound: { host: '127.0.0.1', port },
    enrollment: {
      policy: defineAppTenantPolicy({
        kind: 'tenant',
        appId,
        storeId: 'fixture-store',
        ownership: { item: { kind: 'tenant', column: 'tenant_id' } },
        resolveMembershipRows: () => ({ item: true }),
        resolveRows: () => ({ item: true }),
      }),
      source: { ...source, existingPath: business },
      deployment: 'door-generation',
      roles: ['member'],
      maxLifetimeMs: 60000,
    },
  });
  owner.server.listen(port, '127.0.0.1');
  await once(owner.server, 'listening');
  return {
    port,
    close: async () => {
      owner.server.closeAllConnections();
      await owner.retire();
      auth.close();
    },
  };
}

const ROWS: Row[] = [
  {
    name: 'http/browserHandler.ts, the database browser (the Workbench)',
    start: workbench,
    dispatchers: ['packages/tablewalk/src/server/http/browserHandler.ts'],
    read: { path: '/api/connections' },
    write: { path: '/api/query', body: '{}' },
  },
  {
    name: 'http/handler.ts, through the gate (an App)',
    start: appServer,
    dispatchers: ['packages/mistri/src/server/http/handler.ts'],
    read: { path: '/api/whoami' },
    write: { path: '/api/insert', body: JSON.stringify({ table: 'item', values: { name: 'door' } }) },
  },
  {
    name: 'http/server.ts, an inbound endpoint, before the gate',
    start: delivering,
    write: { path: '/api/inbound/paid', body: '{}' },
    deliveries: true,
  },
  {
    name: 'http/server.ts, an integration’s webhook (an inbound endpoint), before the gate',
    start: delivering,
    write: { path: '/api/inbound/stripe', body: '{}' },
    deliveries: true,
  },
  {
    name: 'embed/handler.ts, an App mounted in a host’s server',
    start: embedded,
    dispatchers: ['packages/mistri/src/server/embed/handler.ts'],
    read: { path: '/crm/api/app', headers: { 'x-mistri-connection': 'tick' } },
    write: { path: '/crm/api/insert', body: '{}', headers: { 'x-mistri-connection': 'tick' } },
  },
  {
    name: 'http/suite.ts, an App inside a suite',
    dispatchers: ['packages/mistri/src/server/http/suite.ts'],
    async start() {
      const inner: Bound = { host: '127.0.0.1', port: 0 };
      const suite = await createSuite(
        [
          {
            id: 'wb',
            open: async () => ({
              server: createApp({ registry: new Registry(), bound: inner }),
              stop: async () => {},
              close: async () => {},
            }),
          },
        ],
        {
          mounts: { wb: '/' },
        },
      );
      inner.port = await listening(suite.server);
      await suite.start();
      return { port: inner.port, close: () => suite.close() };
    },
    read: { path: '/api/connections' },
    write: { path: '/api/query', body: '{}' },
  },
  {
    name: 'tenant/tenantAuthenticatedHttp.ts and the data server inside it (tenantHttp.ts)',
    start: tenantHost,
    dispatchers: ['packages/mistri/src/server/tenant/tenantAuthenticatedHttp.ts', 'packages/mistri/src/server/tenant/tenantHttp.ts'],
    read: { path: '/api/whoami?app=door-proof' },
    write: { path: '/api/query', body: '{}' },
  },
  {
    name: 'tenant/tenantAuthenticatedHttp.ts, native auth',
    start: tenantHost,
    read: { path: '/api/auth/get-session' },
    write: {
      path: '/api/auth/sign-up/email',
      body: JSON.stringify({ email: 'a@example.test', password: 'synthetic-password-1', name: 'A' }),
    },
  },
  {
    name: 'analytics/beaconHttp.ts',
    start: () => standalone((where) => createAnalyticsBeaconHttp({ mount: '', bound: where, ingest: stub, resolveUnit: () => null })),
    write: { path: ANALYTICS_BEACON_PATH, body: '{}' },
  },
  {
    name: 'flags/http.ts',
    start: () => standalone((where) => createFlagHttp({ target: stub, bound: where })),
    read: { path: '/api/flags' },
    write: { path: '/api/flags/beta/changes', body: '{}' },
  },
  {
    name: 'flags/valuesHttp.ts (GET only)',
    start: () =>
      standalone((where) =>
        createFlagValuesHttp({ appId: 'door', environment: 'production', bound: where, withCapture: async () => assert.fail('admitted') }),
      ),
    read: { path: APP_FLAG_VALUES_PATH },
  },
  {
    name: 'experiments/http.ts',
    start: () => standalone((where) => createExperimentHttp({ target: stub, bound: where })),
    read: { path: '/api/experiments/beta/results' },
    write: { path: '/api/experiments/beta/decisions', body: '{}' },
  },
  {
    name: 'experiments/exposureHttp.ts',
    start: () =>
      standalone((where) =>
        createExperimentExposureHttp({
          appId: 'door',
          environment: 'production',
          bound: where,
          receipts: stub,
          store: stub,
          withOwner: async () => assert.fail('admitted'),
        }),
      ),
    write: { path: `${EXPERIMENT_EXPOSURES_PATH}?app=door`, body: '[]' },
  },
  {
    name: 'experiments/visitorHttp.ts',
    start: () =>
      standalone((where) =>
        createExperimentVisitorHttp({
          appId: 'door',
          mount: '',
          bound: where,
          identity: stub,
          withPublic: async () => assert.fail('admitted'),
        }),
      ),
    write: { path: EXPERIMENT_VISITOR_PATH, body: '{}', headers: { 'x-mistri-visitor': 'establish' } },
  },
  {
    name: 'auth/suiteGrantHttp.ts',
    start: () =>
      standalone(
        (where) => (req, res) =>
          suiteGrantHttp(req, res, {
            native: stub,
            grants: stub,
            deployments: [],
            bound: where,
            basePath: '',
            action: 'grant',
            current: () => true,
          }),
      ),
    write: { path: '/api/suite/grants', body: '{}' },
  },
  {
    name: 'auth/suiteLinkHttp.ts',
    start: () =>
      standalone(
        (where) => (req, res) =>
          suiteLinkHttp(req, res, { native: stub, catalog: stub, hosts: new Map(), bound: where, current: () => true }),
      ),
    write: { path: '/api/suite/link', body: '{}' },
  },
  {
    name: 'auth/suitePreferencesHttp.ts',
    start: () =>
      standalone(
        (where) => (req, res) =>
          suitePreferencesHttp(req, res, {
            native: stub,
            preferences: stub,
            bound: where,
            basePath: '',
            current: () => true,
            allowedApps: () => [],
          }),
      ),
    read: { path: '/api/suite/preferences' },
    write: { path: '/api/suite/preferences', body: '{}' },
  },
  {
    name: 'api/apiHttpAdmission.ts (the App API, its MCP and commands)',
    start: () =>
      standalone((where) => {
        const admission = apiAdmission(60);
        return (req, res) => {
          const admitted = admitApiRequest(req, where, admission);
          res.writeHead(admitted.ok ? 200 : admitted.status).end();
        };
      }),
    read: { path: '/api/v1/items' },
    write: { path: '/api/v1/commands/x', body: '{}' },
  },
  {
    name: 'tenant/tenantAdministrationHttp.ts',
    start: () => standalone((where) => createTenantAdministrationHttp({ appId: 'door', bound: where, assertActive: () => {} })),
    read: { path: `${ADMINISTRATION_HTTP_ROOT}/tenants` },
    write: { path: `${ADMINISTRATION_HTTP_ROOT}/execute`, body: '{}' },
  },
  {
    name: 'tenant/tenantInvitationHttp.ts',
    start: () => standalone((where) => createTenantInvitationHttp({ appId: 'door', bound: where, assertActive: () => {} })),
    read: { path: `${INVITATION_HTTP_ROOT}/list` },
    write: { path: `${INVITATION_HTTP_ROOT}/execute`, body: '{}' },
  },
];

describe('the surfaces', () => {
  for (const row of ROWS) {
    test(row.name, async () => {
      const surface = await row.start();
      try {
        const refused = row.refused ?? [403];
        const home = `127.0.0.1:${surface.port}`;
        const write = row.write;
        const read = row.read;
        if (read) {
          const foreign = await ask(surface.port, read.path, { ...read.headers, host: FOREIGN }, read.method);
          assert.ok(refused.includes(foreign.status), `a foreign Host on a read: ${foreign.status} ${foreign.body}`);
        }
        if (write) {
          const send = (headers: Record<string, string>) =>
            ask(surface.port, write.path, { ...write.headers, ...headers }, write.method ?? 'POST', write.body);
          const foreign = await send({ host: FOREIGN, ...json });
          assert.ok(refused.includes(foreign.status), `a foreign Host on a write: ${foreign.status} ${foreign.body}`);
          const stranger = await send({ host: home, origin: STRANGER, ...json });
          if (row.deliveries) {
            assert.equal(stranger.status, 202, 'a provider posts from no page of ours, and is answered');
            return;
          }
          assert.ok(refused.includes(stranger.status), `a write from another page: ${stranger.status} ${stranger.body}`);
          const ownPage = await send({ host: home, origin: `http://${home}`, ...json });
          // Its own page is past the door, whatever the surface answers it next with stubs behind it.
          assert.notDeepEqual(ownPage, stranger, `its own page is answered as the stranger was: ${ownPage.status} ${ownPage.body}`);
        }
      } finally {
        await surface.close();
      }
    });
  }
});

/* --------------------------------------------------------------------------------------------- the dispatchers */

/**
 * The refusals every dispatcher must make the same way, whatever product it
 * serves: the same table sent to each one http/router.ts names. A foreign
 * Host is answered as a foreign Host however much else is wrong with the
 * request, because the Host is asked first.
 */
type Asking = { headers: (home: string) => Record<string, string>; writing: boolean; admitted: boolean };
const DISPATCHER_CASES: Record<string, Asking> = {
  'a foreign Host, read': { headers: () => ({ host: FOREIGN }), writing: false, admitted: false },
  'a foreign Host, write': { headers: () => ({ host: FOREIGN, ...json }), writing: true, admitted: false },
  'a write from another page': { headers: (home) => ({ host: home, origin: STRANGER, ...json }), writing: true, admitted: false },
  'a form-encoded write from its own page': {
    headers: (home) => ({ host: home, origin: `http://${home}`, 'content-type': 'application/x-www-form-urlencoded' }),
    writing: true,
    admitted: false,
  },
  'a write from its own page': { headers: (home) => ({ host: home, origin: `http://${home}`, ...json }), writing: true, admitted: true },
  'a read from its own page': { headers: (home) => ({ host: home }), writing: false, admitted: true },
};

describe('the dispatchers', () => {
  const rows = ROWS.filter((row) => row.dispatchers);

  test('each the router names is stood up by a row here', () => {
    const named = DISPATCHERS.map((each) => each.module).sort();
    assert.deepEqual([...new Set(rows.flatMap((row) => row.dispatchers!))].sort(), named);
    for (const module of named) assert.ok(modules.has(module), module);
  });

  for (const row of rows) {
    test(`${row.dispatchers!.join(' and ')}: the door's refusals, in the door's order`, async () => {
      const surface = await row.start();
      try {
        const home = `127.0.0.1:${surface.port}`;
        const sent = (asking: Asking, extra: Record<string, string> = {}) => {
          const target = asking.writing ? row.write! : row.read!;
          return ask(
            surface.port,
            target.path,
            { ...target.headers, ...asking.headers(home), ...extra },
            asking.writing ? (target.method ?? 'POST') : target.method,
            asking.writing ? (target as { body?: string }).body : undefined,
          );
        };
        const refused = await sent(DISPATCHER_CASES['a write from another page']);
        for (const [name, asking] of Object.entries(DISPATCHER_CASES)) {
          const answer = await sent(asking);
          if (asking.admitted) {
            assert.ok(answer.status !== 403 || !/Refused/.test(answer.body), `${name}: ${answer.status} ${answer.body}`);
            assert.notDeepEqual(answer, refused, `${name} is answered as a refusal: ${answer.status} ${answer.body}`);
          } else assert.ok((row.refused ?? [403]).includes(answer.status), `${name}: ${answer.status} ${answer.body}`);
        }
        const foreign = await sent(DISPATCHER_CASES['a foreign Host, write']);
        const everythingWrong = await sent(DISPATCHER_CASES['a foreign Host, write'], {
          origin: STRANGER,
          'sec-fetch-site': 'cross-site',
          'content-type': 'text/plain',
        });
        assert.deepEqual(everythingWrong, foreign, 'the Host is asked before the Origin, the fetch site and the body');
      } finally {
        await surface.close();
      }
    });
  }
});

/* --------------------------------------------------------------------------------------------- an App's own sign-in */

/**
 * Better Auth's routes behind an App's gate (http/gate.ts) are held to the
 * door a tenant's native auth holds them to: the fetch site and the Origin on
 * a write, never a JSON body, and not the Origin where a route holds its own
 * proof (auth.ts `authHoldsOwnProof`).
 */
describe("an App's own sign-in", () => {
  let port = 0;
  let close: () => Promise<void> = async () => {};
  const credentials = JSON.stringify({ email: 'door@example.test', password: 'synthetic-password-1', name: 'Door' });

  before(async () => {
    const directory = mkdtempSync(join(scratch, 'sign-in-'));
    const data = join(directory, 'app.db');
    const db = new DatabaseSync(data);
    db.exec('CREATE TABLE item(id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    db.close();
    const app = join(directory, 'app');
    mkdirSync(app);
    writeFileSync(
      join(app, 'app.json'),
      JSON.stringify({
        name: 'Door',
        resources: { item: { access: 'write' } },
        auth: { store: join(directory, 'auth.db'), providers: ['email'], signUp: 'open', roles: { user: { read: true } } },
        views: { items: { kind: 'list', from: 'item' } },
        home: 'items',
        nav: ['items'],
      }),
    );
    const loaded = await loadApp(app);
    const registry = new Registry();
    registry.add({ name: 'rw', url: data, writable: true, source: 'config' });
    registry.setActive('rw');
    await registry.open('rw');
    const host: AppHost = { app: loaded, pages: [] };
    const where: Bound = { host: '127.0.0.1', port: 0 };
    const server = createApp({ registry, apps: [host], bound: where });
    port = where.port = await listening(server);
    const origin = `http://127.0.0.1:${port}`;
    host.auth = await createAppAuth(loaded, {
      baseURL: origin,
      trustedOrigins: [origin],
      environment: { BETTER_AUTH_SECRET: 'synthetic-door-secret-at-least-thirty-two-characters-long' },
    });
    close = async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      host.auth?.close();
      await registry.closeAll();
    };
  });
  after(() => close());

  const home = () => `127.0.0.1:${port}`;
  const post = (path: string, headers: Record<string, string>, body = credentials) =>
    ask(port, path, { host: home(), ...headers }, 'POST', body);
  const theDoor = /Refused: /;

  test('a sign-up and a sign-in from its own page are answered by Better Auth', async () => {
    const page = { origin: `http://${home()}`, 'sec-fetch-site': 'same-origin', ...json };
    const up = await post('/api/auth/sign-up/email', page);
    assert.equal(up.status, 200, up.body);
    const signIn = await post('/api/auth/sign-in/email', page);
    assert.equal(signIn.status, 200, signIn.body);
  });

  test("another page's sign-in is refused at the door, and so is another site's with no Origin", async () => {
    const stranger = await post('/api/auth/sign-in/email', { origin: STRANGER, ...json });
    assert.equal(stranger.status, 403);
    assert.match(stranger.body, /tried to make this request/);
    const site = await post('/api/auth/sign-in/email', { 'sec-fetch-site': 'cross-site', ...json });
    assert.equal(site.status, 403);
    assert.match(site.body, /another site made this request/);
  });

  test('a foreign Host is refused before Better Auth reads anything, read or write', async () => {
    const read = await ask(port, '/api/auth/get-session', { host: FOREIGN });
    assert.equal(read.status, 403);
    assert.match(read.body, /only answers on/);
    const write = await ask(port, '/api/auth/sign-in/email', { host: FOREIGN, origin: STRANGER, ...json }, 'POST', credentials);
    assert.match(write.body, /only answers on/);
  });

  test('a read from another page, and a bodyless sign-out from its own, are not the door’s to refuse', async () => {
    const read = await ask(port, '/api/auth/get-session', { host: home(), origin: STRANGER });
    assert.equal(read.status, 200, read.body);
    const out = await ask(port, '/api/auth/sign-out', { host: home(), origin: `http://${home()}` }, 'POST');
    assert.doesNotMatch(out.body, theDoor);
  });

  test("a provider's cross-site form POST to a callback, and a SAML response, hold their own proof and pass the door", async () => {
    const provider = { origin: 'https://idp.example', 'sec-fetch-site': 'cross-site', 'content-type': 'application/x-www-form-urlencoded' };
    for (const path of ['/api/auth/callback/workforce', '/api/auth/sso/saml2/sp/acs/workforce']) {
      const answer = await post(path, provider, 'code=x&state=y');
      assert.doesNotMatch(answer.body, theDoor, `${path}: ${answer.status} ${answer.body}`);
    }
  });

  test('a directory’s SCIM request, server to server with a bearer and no Origin, passes the door', async () => {
    const answer = await post(
      '/api/auth/scim/v2/Users',
      { authorization: 'Bearer synthetic', 'content-type': 'application/scim+json' },
      '{}',
    );
    assert.doesNotMatch(answer.body, theDoor, `${answer.status} ${answer.body}`);
  });
});
