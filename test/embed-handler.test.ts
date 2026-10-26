/**
 * `createHandler` (packages/mistri/src/server/embed/handler.ts): an App mounted
 * under a path of somebody else's server, reached three ways — as a Node
 * listener in a bare `http.createServer`, as Express-style middleware (no
 * Express: its `(req, res, next)` and `originalUrl` are emulated), and as a
 * Fetch handler, the way a Next route handler or a Hono app calls it. The
 * fetch bridge is held on its own first: streaming both ways, several
 * Set-Cookie headers, bodiless answers, a client that leaves, and a peer
 * that is never loopback.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { bridgeFetch, EMBEDDED_PEER } from '../packages/mistri/src/server/embed/fetchBridge.js';
import { provisionSqliteLiveChange } from '../packages/mistri/src/adapters/live/sqliteLiveChange.js';
import { createHandler, type Handler } from '../packages/mistri/src/server/handler.js';
import { withHostPaths } from '../packages/mistri/src/server/http/componentRoutes.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { DEPOT_ROWS, DEPOT_STORE, DEPOT_TABLE, ROOT, SESSION_SECRET, writeDepotApp } from './appApiCli.js';

process.env.BETTER_AUTH_SECRET = SESSION_SECRET;
process.env.MISTRI_OPEN = '0';

const work = mkdtempSync(join(tmpdir(), 'mistri-embed-'));
process.env.XDG_CONFIG_HOME = join(work, 'xdg');
// An App's `@mistriwork/mistri/app` import resolves to this checkout, as an installed package would.
mkdirSync(join(work, 'node_modules'));
mkdirSync(join(work, 'node_modules', '@mistriwork'), { recursive: true });
symlinkSync(join(ROOT, 'packages', 'mistri'), join(work, 'node_modules', '@mistriwork', 'mistri'), 'dir');
after(() => rmSync(work, { recursive: true, force: true }));

const text = async (response: Response) => ({ status: response.status, body: await response.text(), headers: response.headers });

describe('the fetch bridge', () => {
  test('streams the answer as it is written, and keeps every Set-Cookie', async () => {
    let second!: () => void;
    const response = await bridgeFetch(new Request('https://host.test/stream'), (_req, res) => {
      res.setHeader('set-cookie', ['a=1; Path=/crm', 'b=2; Path=/crm; HttpOnly']);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      second = () => res.end('data: two\n\n');
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    assert.deepEqual(response.headers.getSetCookie(), ['a=1; Path=/crm', 'b=2; Path=/crm; HttpOnly']);
    assert.equal(response.headers.get('connection'), null, 'framing stays inside the bridge');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    // The first event is readable before the second is written: nothing waits for the end.
    assert.equal(decoder.decode((await reader.read()).value), 'data: one\n\n');
    second();
    let rest = '';
    for (let read = await reader.read(); !read.done; read = await reader.read()) rest += decoder.decode(read.value);
    assert.equal(rest, 'data: two\n\n');
  });

  test("streams the request's body to the listener, with the host's address and never loopback", async () => {
    const echo = (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            method: req.method,
            url: req.url,
            host: req.headers.host,
            cookie: req.headers.cookie,
            peer: req.socket.remoteAddress,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      });
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"a":'));
        controller.enqueue(new TextEncoder().encode('1}'));
        controller.close();
      },
    });
    const sent = await bridgeFetch(
      new Request('https://host.test/crm/api/x?y=1', { method: 'POST', body, duplex: 'half', headers: { cookie: 's=1' } } as RequestInit),
      echo,
      { clientAddress: '127.0.0.1' },
    );
    assert.deepEqual(await sent.json(), {
      method: 'POST',
      url: '/crm/api/x?y=1',
      host: 'host.test',
      cookie: 's=1',
      peer: EMBEDDED_PEER,
      body: '{"a":1}',
    });
    const vouched = await bridgeFetch(new Request('https://host.test/'), echo, { clientAddress: '203.0.113.9' });
    assert.equal(((await vouched.json()) as { peer: string }).peer, '203.0.113.9');
  });

  test('a HEAD, a 204 and a 304 have no body, as a Response may not', async () => {
    const head = await bridgeFetch(new Request('https://host.test/', { method: 'HEAD' }), (_req, res) => {
      res.writeHead(200, { 'content-length': '5' }).end('hello');
    });
    assert.equal(head.status, 200);
    assert.equal(head.body, null);
    for (const status of [204, 304]) {
      const empty = await bridgeFetch(new Request('https://host.test/'), (_req, res) => res.writeHead(status).end());
      assert.equal(empty.status, status);
      assert.equal(empty.body, null);
    }
  });

  test('the client leaving is the request going, as a dropped connection is', async () => {
    const left = new AbortController();
    let closed!: () => void;
    const seen = new Promise<void>((resolve) => (closed = resolve));
    const response = await bridgeFetch(new Request('https://host.test/', { signal: left.signal }), (req, res) => {
      req.once('aborted', closed);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: open\n\n');
    });
    await response.body!.getReader().read();
    left.abort();
    await seen;
  });
});

test("a served component's host imports are paths under the base, whatever quotes the compiler chose", () => {
  const files = {
    'a.js':
      'import{jsx as e}from"react/jsx-runtime";import * as R from \'react\';import "@mistriwork/mistri/ui";const m=import("react-dom");',
  };
  assert.equal(
    withHostPaths(files, 'a.js', '/crm'),
    'import{jsx as e}from"/crm/_mistri/sdk/react-jsx-runtime.js";import * as R from \'/crm/_mistri/sdk/react.js\';' +
      'import "/crm/_mistri/sdk/ui.js";const m=import("/crm/_mistri/sdk/react-dom.js");',
  );
  assert.match(withHostPaths(files, 'a.js', ''), /from"\/_mistri\/sdk\/react-jsx-runtime\.js"/);
  assert.equal(withHostPaths({ 'b.js': 'const s = "react";' }, 'b.js', '/crm'), 'const s = "react";', 'a string is not an import');
});

describe('construction refuses what cannot be served', () => {
  test('a base path, an origin and a config are named, at once', () => {
    const config = join(work, 'empty.json');
    writeFileSync(config, '{"connections":[]}');
    assert.throws(
      () => createHandler({ config: join(work, 'missing.json'), basePath: '/crm', publicOrigin: 'https://a.test' }),
      /no config file/,
    );
    assert.throws(() => createHandler({ config, basePath: '/c r m', publicOrigin: 'https://a.test' }), /basePath.*must be a path/);
    assert.throws(() => createHandler({ config, basePath: '/crm', publicOrigin: 'https://a.test/crm' }), /origin alone/);
    assert.throws(() => createHandler({ config, basePath: '/crm', publicOrigin: 'a.test' }), /not a URL/);
    assert.throws(
      () => createHandler({ config, basePath: '/crm', publicOrigin: 'https://a.test', jobs: join(work, 'jobs.mjs') }),
      /jobs run the commands of one App/,
    );
  });

  test('a config that serves no App: the database browser is never mounted', async () => {
    const db = join(work, 'browser.db');
    new DatabaseSync(db).close();
    const config = join(work, 'browser.json');
    writeFileSync(config, JSON.stringify({ connections: [{ name: 'b', url: db }] }));
    const tw = createHandler({ config, basePath: '/db', publicOrigin: 'https://a.test' });
    await assert.rejects(tw.ready, /never mounted/);
    const answer = await text(await tw.fetch(new Request('https://a.test/db/api/connections')));
    assert.equal(answer.status, 503);
    assert.match(answer.body, /could not start.*never mounted/);
    await tw.close();
  });
});

describe('an App mounted at /crm', () => {
  const db = join(work, 'tick.db');
  let tw: Handler;
  let host: Server;
  let origin = '';
  const hostSeen: string[] = [];
  let componentHref = '';
  const appHeaders = { 'x-mistri-connection': 'tick' };

  before(async () => {
    assert.equal(spawnSync(process.execPath, [join(ROOT, 'examples/databases/tick/seed.mjs'), db]).status, 0);
    provisionSqliteLiveChange(db);
    const app = join(work, 'tick-app');
    mkdirSync(join(app, 'widgets'), { recursive: true });
    writeFileSync(join(app, 'package.json'), '{ "type": "module" }\n');
    writeFileSync(
      join(app, 'widgets/Hello.jsx'),
      "import { Value } from '@mistriwork/mistri/ui';\nexport default function Hello({ rows }) { return <ul>{rows.tasks.map((t) => <li key={t.id}><Value value={t.name} /></li>)}</ul>; }\n",
    );
    writeFileSync(
      join(app, 'app.mjs'),
      [
        "import { component, custom, dashboard, defineApp } from '@mistriwork/mistri/app';",
        "const hello = component('hello', { module: './widgets/Hello.jsx' });",
        "export default defineApp({ id: 'tick', name: 'Tick', connection: 'tick', live: true, resources: { task: { access: 'write' } },",
        "  views: { tasks: { kind: 'list', from: 'task' }, home: dashboard('Home', [custom('Hello', hello, { rows: { tasks: { from: 'task', show: ['id', 'name'] } } })]) },",
        "  home: 'home', nav: ['home', 'tasks'] });",
      ].join('\n'),
    );
    tw = createHandler({ config: `${db}.json`, app, basePath: '/crm', publicOrigin: 'https://shop.test' });
    await tw.ready;
    // The host's own server: its pages, and /crm handed over.
    host = createServer((req, res) => {
      if (req.url?.startsWith('/crm')) return tw.node(req, res);
      // Express-style, mounted at /crm: the mount taken off req.url, the whole of it kept in originalUrl.
      if (req.url?.startsWith('/express/')) {
        const full = req.url.slice('/express'.length);
        Object.assign(req, { originalUrl: full, url: full.slice('/crm'.length) || '/' });
        return tw.node(req, res, () => res.end('next'));
      }
      // Express-style, mounted with no path: anything outside the base path is the host's.
      if (req.url?.startsWith('/any/')) {
        req.url = req.url.slice('/any'.length);
        const before = req.url;
        return tw.node(req, res, () => {
          hostSeen.push(req.url ?? '');
          assert.equal(req.url, before, 'the host gets the request back as it gave it');
          res.end('host page');
        });
      }
      // A body parser ahead of the handler.
      if (req.url?.startsWith('/parsed/')) {
        req.url = req.url.slice('/parsed'.length);
        req.resume();
        req.once('end', () => {
          Object.assign(req, { _body: true, body: {} });
          tw.node(req, res);
        });
        return;
      }
      res.end('host page');
    });
    await new Promise<void>((done) => host.listen(0, '127.0.0.1', done));
    origin = `http://127.0.0.1:${(host.address() as { port: number }).port}`;
  });
  after(async () => {
    host?.closeAllConnections();
    host?.close();
    await tw?.close();
  });

  test('as a Node listener: the API, the host modules and a component, all under the base', async () => {
    const payload = (await (await fetch(`${origin}/crm/api/app`, { headers: appHeaders })).json()) as {
      app?: { id: string; components?: Record<string, { href: string }> };
    };
    assert.equal(payload.app?.id, 'tick');
    componentHref = payload.app!.components!.hello.href;
    // The payload says the inside address; one App is the base path's root (shared/mount.ts).
    const js = await fetch(`${origin}/crm${componentHref.slice('/tick'.length)}`);
    assert.equal(js.status, 200);
    const code = await js.text();
    assert.match(code, /["']\/crm\/_mistri\/sdk\/ui\.js["']/, 'its host imports are said under the base');
    assert.doesNotMatch(code, /from\s*["']@mistriwork\/mistri\/ui["']/);
    const sdk = await fetch(`${origin}/crm/_mistri/sdk/react.js`);
    assert.equal(sdk.status, 200);
    assert.match(await sdk.text(), /__mistri/);
    // The server's own paths at the host's root are the host's, not tablewalk's.
    assert.equal(await (await fetch(`${origin}/api/app`)).text(), 'host page');
    assert.equal((await fetch(`${origin}/crm/healthz`)).status, 200);
  });

  test('live sync is served under the base, through the same door', async () => {
    const controller = new AbortController();
    const stream = await fetch(`${origin}/crm/api/live?app=tick`, { headers: appHeaders, signal: controller.signal });
    assert.equal(stream.status, 200);
    assert.equal(stream.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const until = async (pattern: RegExp) => {
      while (!pattern.test(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      assert.match(text, pattern);
    };
    try {
      await until(/event: hello/);
      const [task] = (
        (await (
          await fetch(`${origin}/crm/api/query`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...appHeaders },
            body: JSON.stringify({ table: 'task', limit: 1, offset: 0 }),
          })
        ).json()) as { rows: Array<{ id: number }> }
      ).rows;
      const saved = await fetch(`${origin}/crm/api/update`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...appHeaders },
        body: JSON.stringify({ table: 'task', key: { id: task.id }, values: { name: 'Told live' } }),
      });
      assert.equal(saved.status, 200, await saved.text());
      await until(/event: change\ndata: .*"task":\{"keys":\[\{"id":/);
    } finally {
      controller.abort();
      await reader.cancel().catch(() => {});
    }
  });

  test('as Express middleware, mounted at the base or at the root', async () => {
    const mounted = await fetch(`${origin}/express/crm/api/app`, { headers: appHeaders });
    assert.equal(mounted.status, 200, 'the whole address read from originalUrl');
    assert.equal(((await mounted.json()) as { app: { id: string } }).app.id, 'tick');
    assert.equal(await (await fetch(`${origin}/any/elsewhere?x=1`)).text(), 'host page');
    assert.deepEqual(hostSeen, ['/elsewhere?x=1']);
    const served = await fetch(`${origin}/any/crm/api/app`, { headers: appHeaders });
    assert.equal(served.status, 200);
  });

  test('behind a body parser, a write is refused with the parser named', async () => {
    const refused = await fetch(`${origin}/parsed/crm/api/rows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...appHeaders },
      body: '{}',
    });
    assert.equal(refused.status, 500);
    assert.match(await refused.text(), /body parser.*Mount mistri before it/);
  });

  test('as a Fetch handler: the same answers, and the Host check reads the public origin', async () => {
    const answer = await tw.fetch(new Request('https://shop.test/crm/api/app', { headers: appHeaders }));
    assert.equal(answer.status, 200);
    assert.equal(((await answer.json()) as { app: { id: string } }).app.id, 'tick');
    // A name the deployment does not answer to is a rebinding attempt, refused at the door.
    const rebound = await tw.fetch(new Request('https://evil.test/crm/api/app', { headers: appHeaders }));
    assert.equal(rebound.status, 403);
    // Outside the base path names nothing; there is no next() to hand it to.
    assert.equal((await tw.fetch(new Request('https://shop.test/elsewhere'))).status, 404);
    const sdk = await tw.fetch(new Request(`https://shop.test/crm${componentHref.slice('/tick'.length)}`));
    assert.match(await sdk.text(), /\/crm\/_mistri\/sdk\/ui\.js/);
  });
});

describe('an App that signs people in, mounted at /crm', () => {
  let tw: Handler;
  const publicOrigin = 'https://crm.example.test';
  before(async () => {
    const dir = join(work, 'signed');
    const db = join(work, 'signed.db');
    const data = new DatabaseSync(db);
    data.exec("CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO note (body) VALUES ('first');");
    data.close();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'app.json'),
      JSON.stringify({
        id: 'notes',
        name: 'Notes',
        connection: 'notes',
        auth: { providers: ['email'], store: join(work, 'signed-auth.db'), roles: { admin: { read: true } } },
        resources: { note: {} },
        views: { notes: { kind: 'list', from: 'note' } },
        home: 'notes',
        nav: ['notes'],
      }),
    );
    const config = join(work, 'signed.json');
    writeFileSync(config, JSON.stringify({ connections: [{ name: 'notes', url: db }] }));
    process.env.MISTRI_AUTH_ADMIN_EMAIL = 'admin@example.test';
    process.env.MISTRI_AUTH_ADMIN_PASSWORD = 'admin-password-1';
    tw = createHandler({ config, app: dir, basePath: '/crm', publicOrigin });
    await tw.ready;
  });
  after(async () => {
    await tw?.close();
    delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
    delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
  });

  test('signing in sets the session cookie on the base path, and the session reads back through the handler', async () => {
    const signedIn = await tw.fetch(
      new Request(`${publicOrigin}/crm/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { origin: publicOrigin, 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'admin@example.test', password: 'admin-password-1' }),
      }),
    );
    assert.equal(signedIn.status, 200, await signedIn.clone().text());
    const cookies = signedIn.headers.getSetCookie();
    assert.ok(cookies.length >= 1);
    for (const cookie of cookies) assert.match(cookie, /;\s*Path=\/crm(;|$)/i, `${cookie} is scoped to the base path`);
    const session = cookies.map((cookie) => cookie.split(';')[0]).join('; ');
    const who = (await (await tw.fetch(new Request(`${publicOrigin}/crm/api/whoami`, { headers: { cookie: session } }))).json()) as {
      email?: string;
      signedIn?: unknown;
    };
    assert.match(JSON.stringify(who), /admin@example\.test/);
    // A page of another origin may not write through the cookie: the CSRF line holds.
    const forged = await tw.fetch(
      new Request(`${publicOrigin}/crm/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { origin: 'https://evil.test', 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'admin@example.test', password: 'admin-password-1' }),
      }),
    );
    assert.ok(forged.status >= 400, `a cross-origin write is refused (${forged.status})`);
  });
});

describe('two handlers in one process, behind different front ends', () => {
  const publicOrigin = 'https://crm.example.test';
  const handlers: Handler[] = [];
  /** A Notes App that signs people in, of its own: its directory, database and account store. */
  const notes = (name: string) => {
    const dir = join(work, `${name}-app`);
    const db = join(work, `${name}.db`);
    const data = new DatabaseSync(db);
    data.exec("CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO note (body) VALUES ('first');");
    data.close();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'app.json'),
      JSON.stringify({
        id: 'notes',
        name: 'Notes',
        connection: 'notes',
        auth: { providers: ['email'], store: join(work, `${name}-auth.db`), roles: { admin: { read: true } } },
        resources: { note: {} },
        views: { notes: { kind: 'list', from: 'note' } },
        home: 'notes',
        nav: ['notes'],
      }),
    );
    const config = join(work, `${name}.json`);
    writeFileSync(config, JSON.stringify({ connections: [{ name: 'notes', url: db }] }));
    return { config, app: dir };
  };
  before(async () => {
    process.env.MISTRI_AUTH_ADMIN_EMAIL = 'admin@example.test';
    process.env.MISTRI_AUTH_ADMIN_PASSWORD = 'admin-password-1';
    // The first is told its front end appends one hop; the second, started after it, is told nothing.
    process.env.MISTRI_TRUST_PROXY_HOPS = '1';
    try {
      handlers.push(createHandler({ ...notes('hops'), basePath: '/crm', publicOrigin }));
      await handlers[0].ready;
    } finally {
      delete process.env.MISTRI_TRUST_PROXY_HOPS;
    }
    handlers.push(createHandler({ ...notes('direct'), basePath: '/crm', publicOrigin }));
    await handlers[1].ready;
  });
  after(async () => {
    await Promise.all(handlers.map((tw) => tw.close()));
    delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
    delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
  });

  test('each keys its visitors by its own proxy trust: the client its session records', async () => {
    /** The address a sign-in through `tw` is recorded from: the one its limits key by (trust.ts forwardedClient). */
    const recorded = async (tw: Handler) => {
      const context = { clientAddress: '10.0.0.1' };
      const signedIn = await tw.fetch(
        new Request(`${publicOrigin}/crm/api/auth/sign-in/email`, {
          method: 'POST',
          headers: { origin: publicOrigin, 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
          body: JSON.stringify({ email: 'admin@example.test', password: 'admin-password-1' }),
        }),
        context,
      );
      assert.equal(signedIn.status, 200, await signedIn.clone().text());
      const cookie = signedIn.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      const session = await tw.fetch(new Request(`${publicOrigin}/crm/api/auth/get-session`, { headers: { cookie } }), context);
      return ((await session.json()) as { session?: { ipAddress?: string } }).session?.ipAddress;
    };
    // Both asked after both started: the second's start used to set the policy the first's requests read.
    assert.equal(await recorded(handlers[0]), '203.0.113.7', 'one hop: the address the front end appended');
    assert.equal(await recorded(handlers[1]), '10.0.0.1', 'no hops: the peer, whatever the header says');
  });
});

describe('a tenant App mounted at /crm', () => {
  let tw: Handler;
  before(async () => {
    const directory = join(work, 'tenant');
    mkdirSync(directory);
    const business = join(directory, 'business.db'),
      authStore = join(directory, 'auth.db'),
      physical = 'physical_item';
    const db = new DatabaseSync(business);
    db.exec(`${DEPOT_TABLE(physical)}; ${DEPOT_ROWS(physical)}`);
    db.close();
    migrateSqliteCommandJournal(business);
    provisionSqliteTenantStore(business, { appId: 'depot', source: { id: 'business', connection: 'data' }, storeId: DEPOT_STORE });
    const written = writeDepotApp(directory, { business, authStore, physical });
    writeFileSync(join(written.appDir, 'authority.lock'), (await loadApp(written.appDir, { lock: 'report' })).authority!.report);
    (await createAppAuth(await loadApp(written.appDir), { baseURL: 'http://127.0.0.1:1', trustedOrigins: ['http://127.0.0.1:1'] })).close();
    tw = createHandler({
      config: written.config,
      app: written.appDir,
      policy: written.policy,
      basePath: '/crm',
      publicOrigin: 'https://tenants.example.test',
    });
    await tw.ready;
  });
  after(() => tw?.close());

  test('is served by the tenant host under the base, signed out until a member signs in', async () => {
    const who = await tw.fetch(new Request('https://tenants.example.test/crm/api/whoami?app=depot'));
    assert.equal(who.status, 200, await who.clone().text());
    const said = (await who.json()) as { signedIn: boolean; tenant: boolean; appId: string };
    assert.deepEqual([said.signedIn, said.tenant, said.appId], [false, true, 'depot']);
    // The tenant host's data needs a membership: nothing is read signed out.
    const rows = await tw.fetch(new Request('https://tenants.example.test/crm/api/rows?app=depot'));
    assert.ok(rows.status >= 400, `a signed-out read is refused (${rows.status})`);
    assert.equal((await tw.fetch(new Request('https://tenants.example.test/crm/_mistri/sdk/react.js'))).status, 200);
    assert.equal((await tw.fetch(new Request('https://evil.test/crm/api/whoami?app=depot'))).status, 403);
  });
});

test('close() stops what the handler started: a host process exits on its own once it has closed', async () => {
  const db = join(work, 'exit.db');
  assert.equal(spawnSync(process.execPath, [join(ROOT, 'examples/databases/tick/seed.mjs'), db]).status, 0);
  const app = join(work, 'exit-app');
  mkdirSync(app);
  writeFileSync(
    join(app, 'app.json'),
    JSON.stringify({
      id: 'tick',
      name: 'Tick',
      connection: 'tick',
      resources: { task: {} },
      views: { tasks: { kind: 'list', from: 'task' } },
      home: 'tasks',
      nav: ['tasks'],
    }),
  );
  const script = join(work, 'host.mts');
  writeFileSync(
    script,
    [
      `import { createHandler } from ${JSON.stringify(pathToFileURL(join(ROOT, 'packages/mistri/src/server/handler.ts')).href)};`,
      `const tw = createHandler({ config: ${JSON.stringify(`${db}.json`)}, app: ${JSON.stringify(app)}, basePath: '/crm', publicOrigin: 'https://a.test' });`,
      'await tw.ready;',
      "const answer = await tw.fetch(new Request('https://a.test/crm/api/app', { headers: { 'x-mistri-connection': 'tick' } }));",
      "console.log('status', answer.status, (await answer.json()).app.id);",
      'await tw.close();',
      "const late = await tw.fetch(new Request('https://a.test/crm/api/app'));",
      "console.log('after close', late.status);",
      // No process.exit: a pool, a watcher or a timer left open keeps the process alive and fails the test.
    ].join('\n'),
  );
  const child = spawn(process.execPath, ['--import', 'tsx', script], {
    cwd: ROOT,
    env: { ...process.env, MISTRI_OPEN: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += String(chunk)));
  child.stderr.on('data', (chunk) => (output += String(chunk)));
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  const [code] = (await once(child, 'close')) as [number | null];
  clearTimeout(timer);
  assert.equal(code, 0, output);
  assert.match(output, /status 200 tick/);
  assert.match(output, /after close 503/);
});

describe('the handler refuses a mount it could not keep apart', () => {
  const config = join(work, 'refusals.json');
  before(() => writeFileSync(config, '{"connections":[]}'));
  const handler = (over: Record<string, unknown>) => () =>
    createHandler({ config, basePath: '/crm', publicOrigin: 'https://a.test', ...over } as never);

  test('a base path that says one of the server’s own segments', () => {
    for (const basePath of ['/api', '/assets/tw', '/tw/api', '/healthz', '/readyz', '/crm/assets']) {
      assert.throws(handler({ basePath }), /one of the paths mistri answers itself/, basePath);
    }
    // Under the host's own API is a place of the host's: /api/tw is not /api.
    assert.doesNotThrow(() => {
      const tw = handler({ basePath: '/api/tw' })();
      tw.ready.catch(() => {});
      void tw.close();
    });
  });

  test('embed origins that are not origins, and a jobs option that is not a module', () => {
    assert.throws(handler({ embed: { origins: ['*'] } }), /origin/);
    assert.throws(handler({ embed: { origins: ['https://host.test/page'] } }), /origin/);
    assert.throws(handler({ embed: { origins: ['http://host.test'] } }), /origin/);
    assert.throws(handler({ embed: { origins: ['https://host.test', 'https://host.test'] } }), /twice|more than once|duplicate/i);
    assert.throws(handler({ embed: { origins: 'https://host.test' } }), /origins/);
    assert.throws(handler({ embed: { allow: true } }), /origins/);
    assert.throws(handler({ jobs: true }), /path of a defineJobs module/);
  });
});

describe('a mounted App answers its embed origins, and no others', () => {
  let tw: Handler;
  const publicOrigin = 'https://crm.example.test';
  const PORTAL = 'https://portal.example';
  const WIDGETS = 'https://widgets.example';
  const STRANGER = 'https://stranger.example';
  const SECRET = 'portal-embed-secret-at-least-thirty-two-characters';
  const at = (path: string, init: RequestInit = {}) => tw.fetch(new Request(`${publicOrigin}/crm${path}`, init));
  let bearer = '';

  before(async () => {
    const dir = join(work, 'origins');
    const db = join(work, 'origins.db');
    const data = new DatabaseSync(db);
    data.exec("CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO note (body) VALUES ('first');");
    data.close();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'app.json'),
      JSON.stringify({
        id: 'notes',
        name: 'Notes',
        connection: 'notes',
        auth: { providers: ['email'], defaultRole: 'reader', store: join(work, 'origins-auth.db'), roles: { reader: { read: true } } },
        resources: { note: {} },
        views: { notes: { kind: 'list', from: 'note' } },
        home: 'notes',
        nav: ['notes'],
      }),
    );
    const config = join(work, 'origins.json');
    writeFileSync(
      config,
      JSON.stringify({
        connections: [
          { name: 'notes', url: db },
          { name: 'portal', kind: 'embed', issuer: PORTAL, secret: '${PORTAL_EMBED_SECRET}', origins: [PORTAL] },
        ],
      }),
    );
    process.env.PORTAL_EMBED_SECRET = SECRET;
    tw = createHandler({ config, app: dir, basePath: '/crm', publicOrigin, embed: { origins: [WIDGETS] } });
    await tw.ready;
  });
  after(async () => {
    await tw?.close();
    delete process.env.PORTAL_EMBED_SECRET;
  });

  const preflight = (origin: string, method = 'GET', headers = 'authorization') =>
    at('/api/embed/boot', {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': method, 'access-control-request-headers': headers },
    });

  test('a preflight from a listed origin is answered for that origin alone, without credentials', async () => {
    for (const origin of [PORTAL, WIDGETS]) {
      const answer = await preflight(origin);
      assert.equal(answer.status, 204, origin);
      assert.equal(answer.headers.get('access-control-allow-origin'), origin);
      assert.match(answer.headers.get('vary') ?? '', /Origin/);
      assert.equal(answer.headers.get('access-control-allow-credentials'), null, 'the bearer is the credential, never a cookie');
      assert.match(answer.headers.get('access-control-allow-methods') ?? '', /POST/);
    }
    const stranger = await preflight(STRANGER);
    assert.equal(stranger.headers.get('access-control-allow-origin'), null);
    // A listed origin asking to send a header no browser route reads is refused.
    assert.equal((await preflight(PORTAL, 'GET', 'x-anything')).status, 403);
  });

  test('the bare boot is readable from a listed origin before any session, and from no other', async () => {
    const listed = await at('/api/embed/boot', { headers: { origin: WIDGETS } });
    assert.equal(listed.status, 200);
    assert.equal(listed.headers.get('access-control-allow-origin'), WIDGETS);
    assert.equal(listed.headers.get('access-control-allow-credentials'), null);
    assert.equal(typeof ((await listed.json()) as { protocol?: unknown }).protocol, 'number');
    const stranger = await at('/api/embed/boot', { headers: { origin: STRANGER } });
    assert.equal(stranger.headers.get('access-control-allow-origin'), null);
  });

  test('an exchanged bearer boots the embed in one read: signed in, with the first room’s answers', async () => {
    const { mintEmbedAssertion } = await import('../packages/mistri/src/server/embed/mint.js');
    const assertion = await mintEmbedAssertion({
      issuer: PORTAL,
      key: SECRET,
      app: 'notes',
      origin: PORTAL,
      subject: 'rita',
      email: 'rita@portal.example',
    });
    const exchanged = await at('/api/auth/embed/exchange', {
      method: 'POST',
      headers: { origin: PORTAL, 'content-type': 'application/json' },
      body: JSON.stringify({ assertion }),
    });
    assert.equal(exchanged.status, 200, await exchanged.clone().text());
    assert.equal(exchanged.headers.get('access-control-allow-origin'), PORTAL);
    assert.equal(exchanged.headers.getSetCookie().length, 0, 'a cross-origin exchange sets no cookie');
    bearer = ((await exchanged.json()) as { token: string }).token;

    const boot = await at('/api/embed/boot?app=notes&path=%2Fnotes&search=', {
      headers: { origin: PORTAL, authorization: `Bearer ${bearer}` },
    });
    assert.equal(boot.status, 200, await boot.clone().text());
    assert.equal(boot.headers.get('access-control-allow-origin'), PORTAL);
    assert.match(boot.headers.get('cache-control') ?? '', /private/);
    assert.match(boot.headers.get('vary') ?? '', /Origin/);
    const said = (await boot.json()) as { protocol: number; version: string; signedIn: boolean; data?: { reads: Record<string, unknown> } };
    assert.equal(said.signedIn, true);
    assert.equal(typeof said.version, 'string');
    const reads = Object.keys(said.data?.reads ?? {});
    assert.ok(
      reads.some((key) => key.startsWith('GET /api/whoami')),
      reads.join(' | '),
    );
    assert.ok(
      reads.some((key) => key.startsWith('GET /api/app')),
      reads.join(' | '),
    );

    // Signed out, the same read says so, and carries no session.
    const signedOut = await at('/api/embed/boot?app=notes&path=%2Fnotes', { headers: { origin: WIDGETS } });
    assert.equal(signedOut.status, 200);
    assert.equal(((await signedOut.json()) as { signedIn: boolean }).signedIn, false);
    // An address that is not the App's is refused rather than planned.
    assert.equal((await at('/api/embed/boot?app=notes&path=%2Fother', { headers: { origin: PORTAL } })).status, 400);
  });

  test('a write passes from a listed origin on its bearer, never on a cookie, and never from a stranger', async () => {
    assert.ok(bearer, 'the exchange ran first');
    const write = (origin: string, headers: Record<string, string>) =>
      at('/api/auth/embed/sign-out', { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: '{}' });
    const rows = (origin: string, headers: Record<string, string>) =>
      at('/api/rows', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json', 'x-mistri-connection': 'notes', ...headers },
        body: JSON.stringify({ table: 'note' }),
      });
    const vouched = await rows(PORTAL, { authorization: `Bearer ${bearer}` });
    assert.notEqual(vouched.status, 403, await vouched.clone().text());
    assert.equal(vouched.headers.get('access-control-allow-origin'), PORTAL);
    // A listed origin with no bearer reads as a stranger's page: its cookies are dropped and its write refused.
    const cookieOnly = await rows(WIDGETS, { cookie: 'better-auth.session_token=forged' });
    assert.ok([401, 403].includes(cookieOnly.status), `${cookieOnly.status}`);
    const stranger = await rows(STRANGER, { authorization: `Bearer ${bearer}` });
    // A stranger's page holding a bearer gets nothing for it: it is read signed out, and refused.
    assert.ok([401, 403].includes(stranger.status), `${stranger.status}`);
    assert.equal(stranger.headers.get('access-control-allow-origin'), null);
    assert.equal((await write(PORTAL, { authorization: `Bearer ${bearer}` })).status < 300, true);
  });

  test('?embed=frame lets the listed origins frame the page; without it, only the App itself', async () => {
    const framed = await at('/?embed=frame', { headers: { accept: 'text/html' } });
    const policy = framed.headers.get('content-security-policy') ?? '';
    assert.match(policy, /frame-ancestors 'self' https:\/\/portal\.example https:\/\/widgets\.example/, policy);
    const plain = await at('/', { headers: { accept: 'text/html' } });
    assert.match(plain.headers.get('content-security-policy') ?? '', /frame-ancestors 'self'(;|$)/);
    assert.doesNotMatch(plain.headers.get('content-security-policy') ?? '', /portal\.example/);
  });
});
