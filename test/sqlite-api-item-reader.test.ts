import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer, request } from 'node:http';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { authorityReport } from '../packages/mistri/src/shared/appAuthority.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { provisionSqliteApiTokenStore } from '../packages/mistri/src/server/auth/provisionSqliteApiTokenStore.js';
import { SQLITE_API_TOKEN_TABLES } from '../packages/mistri/src/adapters/auth/sqliteApiTokenLayout.js';
import { issueSqliteApiToken, revokeSqliteApiToken } from '../packages/mistri/src/server/auth/sqliteApiTokenMaintenance.js';
import { createSqliteApiReadOwner } from '../packages/mistri/src/server/api/sqliteApiReadOwner.js';
import { createSqliteApiReadHost } from '../packages/mistri/src/server/api/sqliteApiReadHost.js';
import { createSqliteApiReadHttp } from '../packages/mistri/src/server/api/sqliteApiReadHttp.js';
import { createApp, apiReadLifetimes } from './support/createApp.js';
import { cancellation, withCancellation } from '../packages/engine/src/adapters/statementControl.js';
import { HttpAdapter } from '../packages/engine/src/adapters/http/httpAdapter.js';
import { DEFAULT_POLICY } from '../packages/engine/src/adapters/http/egress.js';
import { draftDescription, readDescription } from '../packages/engine/src/adapters/http/httpDescription.js';
import { readOpenApi } from '../packages/engine/src/adapters/http/openapi.js';

test('cancelled read skips queued work and a buffered handle cannot escape cancellation', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  const run = t.mock.method(f.physical, 'runView', f.physical.runView.bind(f.physical));
  await assert.rejects(f.reader.readItem(f.token.token, 'item:person', '1', controller.signal));
  assert.equal(run.mock.callCount(), 0);
  const later = new AbortController();
  const handle = await f.reader.readItem(f.token.token, 'item:person', '1', later.signal);
  later.abort();
  assert.throws(() => f.reader.consumeResult(handle));
  assert.throws(() => f.reader.consumeResult(handle));
  assert.equal(f.reader.consumeResult(await f.reader.readItem(f.token.token, 'item:person', '1')).status, 200);
});

test('SQLite cancellation drains pending work and skips count without retiring siblings', async (t) => {
  const f = await fixture(t, true);
  const controller = new AbortController();
  let leases = 0;
  const lease = f.registry.lease.bind(f.registry);
  t.mock.method(f.registry, 'lease', (...args: Parameters<typeof lease>) => {
    const close = lease(...args);
    leases++;
    return () => {
      leases--;
      close();
    };
  });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = f.physical.runView.bind(f.physical);
  t.mock.method(f.physical, 'runView', async (...args: Parameters<typeof original>) => {
    if (cancellation() === controller.signal) {
      // This models an outstanding driver operation, NOT interruption of a
      // synchronous SQLite statement. Completion must still be drained.
      const result = await original(...args);
      entered();
      await gate;
      return result;
    }
    return original(...args);
  });
  assert.ok(f.physical.countView);
  const count = t.mock.method(f.physical, 'countView', f.physical.countView.bind(f.physical));
  let settled = false;
  const pending = f.reader.readList(f.token.token, 'list:person', 'count=true', controller.signal);
  const refusal = assert.rejects(pending);
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await started;
  try {
    controller.abort();
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(leases, 1);
    assert.equal(f.reader.consumeResult(await f.reader.readItem(f.token.token, 'item:person', '1')).status, 200);
    assert.equal(leases, 1);
  } finally {
    release();
  }
  await refusal;
  assert.equal(leases, 0);
  assert.equal(count.mock.callCount(), 0);
});

test('aborting the first host request does not poison shared owner acquisition', async (t) => {
  const f = await fixture(t);
  const host = createSqliteApiReadHost(f.registry, f.host, 'decimal-string');
  t.after(() => host.retire());
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const open = f.registry.open.bind(f.registry);
  let first = true;
  t.mock.method(f.registry, 'open', async (...args: Parameters<typeof open>) => {
    assert.equal(cancellation(), undefined);
    if (first) {
      first = false;
      entered();
      await gate;
    }
    return open(...args);
  });
  const controller = new AbortController();
  const abandoned = assert.rejects(
    withCancellation(controller.signal, () => host.readItem(f.token.token, 'item:person', '1', controller.signal)),
  );
  await started;
  controller.abort();
  const sibling = host.readItem(f.token.token, 'item:person', '1');
  release();
  await abandoned;
  assert.equal(host.consumeResult(await sibling).status, 200);
});

const storeId = '21a53156-f274-4622-8a68-3f0b82c2c45a';
const unavailable = { message: 'The API item read is unavailable.' };
async function fixture(t: TestContext, pagination = false) {
  const directory = mkdtempSync(join(tmpdir(), 'tw-api-item-reader-'));
  const path = join(directory, 'auth.db'),
    business = join(directory, 'business.db');
  const db = new DatabaseSync(business);
  db.exec("CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT NOT NULL,secret TEXT); INSERT INTO people VALUES(1,'Visible','hidden');");
  if (pagination) db.exec("INSERT INTO people VALUES(2,'Second','hidden'),(3,'Third','hidden'),(4,'Fourth','hidden')");
  db.close();
  const app = parseAppConfig(
    {
      id: 'app',
      name: 'App',
      connection: 'data',
      resources: { person: { physical: 'people' } },
      views: { people: { kind: 'list', from: 'person', ...(pagination ? { query: 'id > 1' } : {}) } },
      home: 'people',
      auth: { store: path, roles: { reader: { read: true } } },
      api: {
        version: 1,
        roles: ['reader'],
        views: ['people'],
        resources: { person: { fields: ['id', 'name'], filters: ['id'], sorts: ['id', 'name'] } },
      },
    },
    'item reader fixture',
  );
  const loaded = { app, path: join(directory, 'app.json'), dir: directory, pages: [], sources: {} };
  const names = ['BETTER_AUTH_SECRET', 'MISTRI_AUTH_ADMIN_EMAIL', 'MISTRI_AUTH_ADMIN_PASSWORD'] as const;
  const saved = names.map((name) => [name, process.env[name]] as const);
  process.env.BETTER_AUTH_SECRET = 'synthetic-item-reader-secret-at-least-thirty-two-characters';
  delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
  delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
  let runtime;
  try {
    runtime = await createAppAuth(loaded, { baseURL: 'http://127.0.0.1:1', trustedOrigins: ['http://127.0.0.1:1'] });
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  const registry = new Registry();
  registry.add({ id: 'data', name: 'data', url: business, source: 'config' });
  const host: AppHost = { app: loaded, auth: runtime, pages: [] };
  let reader: Awaited<ReturnType<typeof createSqliteApiReadOwner>> | undefined;
  t.after(async () => {
    await reader?.retire();
    await registry.closeAll();
    runtime.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const authDb = new DatabaseSync(path);
  authDb
    .prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt,role,banned) VALUES (?,?,?,1,?,?,?,0)')
    .run('account', 'Account', 'account@example.test', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'reader');
  authDb.close();
  provisionSqliteApiTokenStore(path, { appId: 'app', storeId, exclusions: [] });
  const resources = await loadAppRuntimeResources(registry, app, 'data');
  const issue = (operations?: string[]) =>
    issueSqliteApiToken(
      path,
      app,
      resources.schema,
      {
        storeId,
        exclusions: [],
        subjectId: 'account',
        actorId: 'account',
        roles: ['reader'],
        label: 'Read',
        expiresAt: Date.now() + 60000,
        ...(operations === undefined ? {} : { operations }),
      },
      Date.now(),
    );
  const token = issue();
  reader = await createSqliteApiReadOwner(registry, host, 'decimal-string');
  const editAccount = (sql: string) => {
    const authDb = new DatabaseSync(path);
    try {
      authDb.exec(sql);
    } finally {
      authDb.close();
    }
  };
  const physical = (await registry.open('data')).adapter;
  assert.ok(physical.runView);
  assert.ok(physical.countView);
  return {
    reader,
    registry,
    host,
    runtime,
    app,
    path,
    token,
    issue,
    editAccount,
    physical: physical as typeof physical & {
      runView: NonNullable<typeof physical.runView>;
      countView: NonNullable<typeof physical.countView>;
    },
  };
}

test('read host readiness acquires the eventual serving owner once and retirement stays final', async (t) => {
  const f = await fixture(t);
  const host = createSqliteApiReadHost(f.registry, f.host, 'decimal-string');
  t.after(() => host.retire());
  const open = f.registry.open.bind(f.registry);
  let opens = 0;
  t.mock.method(f.registry, 'open', async (...args: Parameters<typeof open>) => {
    opens++;
    return open(...args);
  });
  await host.prepare();
  const preparedOpens = opens;
  assert.ok(preparedOpens > 0);
  await host.prepare();
  assert.equal(opens, preparedOpens);
  assert.equal(host.consumeResult(await host.readItem(f.token.token, 'item:person', '1')).status, 200);
  await host.retire();
  await assert.rejects(host.prepare());
});

test('HTTP readiness refuses missing token layout without provisioning it', async (t) => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.path);
  try {
    for (const name of [SQLITE_API_TOKEN_TABLES.token, SQLITE_API_TOKEN_TABLES.meta]) db.exec(`DROP TABLE "${name}"`);
  } finally {
    db.close();
  }
  const transport = createSqliteApiReadHttp(f.registry, f.host, {
    bound: { host: '127.0.0.1', port: 4111 },
    integers: 'decimal-string',
    requestsPerMinute: 100,
  });
  t.after(() => transport.retire());
  await assert.rejects(transport.prepare());
  const check = new DatabaseSync(f.path);
  try {
    assert.equal(
      check
        .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN (?,?)")
        .get(SQLITE_API_TOKEN_TABLES.token, SQLITE_API_TOKEN_TABLES.meta)!.n,
      0,
    );
  } finally {
    check.close();
  }
  await assert.rejects(transport.prepare());
});

async function cliFixture(t: TestContext, integers: 'decimal-string' | 'number', missingLayout = false, busyPort = false) {
  const f = await fixture(t);
  const manifest = {
    id: 'app',
    name: 'App',
    connection: 'data',
    home: 'people',
    resources: { person: { physical: 'people' } },
    views: { people: { kind: 'list', from: 'person' } },
    auth: { store: f.path, roles: { reader: { read: true } } },
    api: {
      version: 1,
      roles: ['reader'],
      views: ['people'],
      resources: {
        person: { fields: ['id', 'name'], filters: ['id'], sorts: ['id', 'name'] },
      },
    },
  };
  writeFileSync(f.host.app.path, JSON.stringify(manifest));
  writeFileSync(join(f.host.app.dir!, 'authority.lock'), authorityReport(parseAppConfig(manifest, 'CLI fixture')));
  const config = join(f.host.app.dir!, 'server.json');
  writeFileSync(config, JSON.stringify({ connections: [{ id: 'data', name: 'data', url: f.registry.configOf('data')!.url }] }));
  if (missingLayout) {
    const db = new DatabaseSync(f.path);
    try {
      for (const name of [SQLITE_API_TOKEN_TABLES.token, SQLITE_API_TOKEN_TABLES.meta]) db.exec(`DROP TABLE "${name}"`);
    } finally {
      db.close();
    }
  }
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const address = reservation.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  if (busyPort) t.after(() => new Promise<void>((resolve) => reservation.close(() => resolve())));
  else await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('TABLEWALK_') && !key.startsWith('BETTER_AUTH_')),
  );
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      'packages/mistri/src/server/index.ts',
      '--config',
      config,
      '--app',
      f.host.app.path,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--api-reads',
      '--api-integers',
      integers,
      '--api-requests-per-minute',
      '100',
    ],
    {
      cwd: process.cwd(),
      env: { ...env, MISTRI_OPEN: '0', BETTER_AUTH_SECRET: 'synthetic-item-reader-secret-at-least-thirty-two-characters' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  const closed = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    try {
      await closed;
    } finally {
      clearTimeout(timer);
    }
  });
  const started = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CLI readiness timeout: ${output}`)), 20000);
    const inspect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-16000);
      if (output.includes('Listening on http://')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', () => {
      clearTimeout(timer);
      reject(new Error(`CLI closed before listening: ${output}`));
    });
  });
  return { ...f, child, closed, started, output: () => output, base: `http://127.0.0.1:${port}` };
}

test('actual CLI explicit read opt-in serves both integer modes and shuts down cleanly', async (t) => {
  for (const integers of ['decimal-string', 'number'] as const) {
    const f = await cliFixture(t, integers);
    await f.started;
    const response = await fetch(`${f.base}/api/apps/app/v1/person/1`, { headers: { authorization: `Bearer ${f.token.token}` } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: integers === 'number' ? 1 : '1', name: 'Visible' });
    assert.equal((await fetch(`${f.base}/api/apps/app/v1/person/1`)).status, 401);
    f.child.kill('SIGTERM');
    assert.equal(await f.closed, 0);
  }
});

test('source CLI SIGTERM exits with an active Vite HMR WebSocket', async (t) => {
  const f = await cliFixture(t, 'decimal-string');
  await f.started;
  const response = await fetch(`${f.base}/@vite/client`);
  assert.equal(response.status, 200);
  const source = await response.text();
  const token = source.match(/const wsToken = ("[^"]+");/);
  assert.ok(token, 'Vite client publishes the synthetic HMR connection token');
  const url = new URL(f.base);
  url.protocol = 'ws:';
  url.searchParams.set('token', JSON.parse(token[1]));
  const socket = new WebSocket(url, 'vite-hmr');
  t.after(() => socket.close());
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('HMR connection timed out')), 5000);
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timeout);
        reject(Error('HMR connection failed'));
      },
      { once: true },
    );
  });
  assert.equal(socket.readyState, WebSocket.OPEN);
  f.child.kill('SIGTERM');
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const exit = await Promise.race([
      f.closed,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(Error(`CLI shutdown stalled with HMR connected; the CLI said:\n${f.output()}`)), 5000);
      }),
    ]);
    assert.equal(exit, 0, f.output());
  } finally {
    clearTimeout(timeout);
  }
});

test('actual CLI refuses absent token extension before listening and does not provision it', async (t) => {
  const f = await cliFixture(t, 'decimal-string', true);
  await assert.rejects(f.started, /before listening/);
  assert.equal(await f.closed, 1);
  assert.doesNotMatch(f.output(), /Listening on http:\/\//);
  assert.match(f.output(), /signs people in/);
  assert.match(f.output(), /startup error/i);
  const db = new DatabaseSync(f.path);
  try {
    assert.equal(
      db
        .prepare('SELECT count(*) AS n FROM sqlite_master WHERE name IN (?,?)')
        .get(SQLITE_API_TOKEN_TABLES.token, SQLITE_API_TOKEN_TABLES.meta)!.n,
      0,
    );
  } finally {
    db.close();
  }
});

test('actual CLI cleans up prepared API owners when the explicit port is occupied', async (t) => {
  const f = await cliFixture(t, 'decimal-string', false, true);
  await assert.rejects(f.started, /before listening/);
  assert.equal(await f.closed, 1);
  assert.match(f.output(), /already in use/);
  assert.doesNotMatch(f.output(), /Listening on http:\/\//);
});

test('actual CLI App reload retires API reads until restart', async (t) => {
  const f = await cliFixture(t, 'decimal-string');
  await f.started;
  const endpoint = `${f.base}/api/apps/app/v1/person/1`;
  const options = { headers: { authorization: `Bearer ${f.token.token}` } };
  const before = await fetch(endpoint, options);
  assert.equal(before.status, 200);
  await before.text();
  const manifest = JSON.parse(readFileSync(f.host.app.path, 'utf8'));
  manifest.name = 'Presentation change';
  writeFileSync(f.host.app.path, JSON.stringify(manifest));
  const until = Date.now() + 5000;
  let status = 200;
  while (status === 200 && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const response = await fetch(endpoint, options);
    status = response.status;
    await response.text();
  }
  assert.equal(status, 503);
  f.child.kill('SIGTERM');
  assert.equal(await f.closed, 0);
});

test('genuine item reader respects exposure and native scope; copied auth cannot acquire it', async (t) => {
  const f = await fixture(t);
  const found = f.reader.consumeResult(await f.reader.readItem(f.token.token, 'item:person', '1'));
  assert.equal(found.status, 200);
  assert.deepEqual(JSON.parse(found.body), { id: '1', name: 'Visible' });
  const missing = f.reader.consumeResult(await f.reader.readItem(f.token.token, 'item:person', '99'));
  assert.equal(missing.status, 404);
  assert.deepEqual(JSON.parse(missing.body), {
    error: { code: 'not_found', message: 'The API request could not be completed.' },
  });
  await assert.rejects(f.reader.readItem('bad secret', 'item:person', '1'), unavailable);
  await assert.rejects(f.reader.readItem(f.token.token, 'item:people', '1'), unavailable);
  await assert.rejects(f.reader.readItem(f.issue([]).token, 'item:person', '1'), unavailable);
  await assert.rejects(createSqliteApiReadOwner(f.registry, { ...f.host, auth: { ...f.runtime } }, 'decimal-string'), unavailable);
  f.editAccount('UPDATE user SET role=NULL');
  await assert.rejects(f.reader.readItem(f.token.token, 'item:person', '1'), unavailable);
});

for (const mutation of ['revoke', 'demote', 'reload', 'unavailable', 'definition', 'config', 'schema', 'retire'] as const) {
  test(`buffered item result is discarded after ${mutation} while genuine business execution awaits`, async (t) => {
    const f = await fixture(t);
    let resume!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const run = f.physical.runView!.bind(f.physical);
    t.mock.method(f.physical, 'runView', async (...args: Parameters<typeof run>) => {
      const result = await run(...args);
      entered();
      await gate;
      return result;
    });
    const pending = f.reader.readItem(f.token.token, 'item:person', '1');
    const rejected = assert.rejects(pending, unavailable);
    await started;
    let retirement: Promise<void> | undefined;
    if (mutation === 'revoke')
      revokeSqliteApiToken(
        f.path,
        { appId: 'app', storeId, exclusions: [], tokenId: f.token.tokenId, expectedVersion: '1', actorId: 'account' },
        Date.now(),
      );
    if (mutation === 'demote') f.editAccount('UPDATE user SET role=NULL');
    if (mutation === 'reload') f.host.app = { ...f.host.app };
    if (mutation === 'unavailable') f.host.unavailable = 'reload blocked';
    if (mutation === 'definition') f.app.name = 'Changed';
    if (mutation === 'config') f.registry.configOf('data')!.name = 'Changed';
    if (mutation === 'schema') {
      const db = new DatabaseSync(f.registry.configOf('data')!.url);
      try {
        db.exec('ALTER TABLE people ADD COLUMN newly_hidden TEXT');
      } finally {
        db.close();
      }
    }
    if (mutation === 'retire') {
      let settled = false;
      retirement = f.reader.retire().then(() => {
        settled = true;
      });
      await Promise.resolve();
      assert.equal(settled, false, 'retire drains the pending driver result');
      await assert.rejects(f.reader.readItem(f.token.token, 'item:person', '1'), unavailable);
    }
    resume();
    await rejected;
    await retirement;
  });
}

test('item read holds the Registry lease until driver completion and refuses a replaced adapter', async (t) => {
  const f = await fixture(t);
  let resume!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const run = f.physical.runView!.bind(f.physical);
  t.mock.method(f.physical, 'runView', async (...args: Parameters<typeof run>) => {
    const result = await run(...args);
    entered();
    await gate;
    return result;
  });
  const pending = f.reader.readItem(f.token.token, 'item:person', '1');
  const rejected = assert.rejects(pending, unavailable);
  await started;
  let refreshed = false;
  const refresh = f.registry.refresh('data').then(() => {
    refreshed = true;
  });
  await Promise.resolve();
  assert.equal(refreshed, false);
  resume();
  await rejected;
  await refresh;
  await assert.rejects(f.reader.readItem(f.token.token, 'item:person', '1'), unavailable);
});

for (const invalidation of ['refresh', 'close'] as const) {
  test(`buffered handoff refuses Registry ${invalidation} before consumption`, async (t) => {
    const f = await fixture(t);
    const handle = await f.reader.readItem(f.token.token, 'item:person', '1');
    if (invalidation === 'refresh') await f.registry.refresh('data');
    else await f.registry.closeAll();
    assert.throws(() => f.reader.consumeResult(handle), unavailable);
  });
}

test('result handoffs are opaque, owner-bound and one-shot', async (t) => {
  const f = await fixture(t),
    foreign = await fixture(t);
  const handle = await f.reader.readItem(f.token.token, 'item:person', '1');
  assert.deepEqual(Object.keys(handle), []);
  assert.ok(Object.isFrozen(handle));
  assert.throws(() => f.reader.consumeResult({ ...handle }), unavailable);
  assert.throws(() => foreign.reader.consumeResult(handle), unavailable);
  assert.equal(f.reader.consumeResult(handle).status, 200);
  assert.throws(() => f.reader.consumeResult(handle), unavailable);
});

for (const change of ['revoke', 'expiry'] as const) {
  test(`resolved handoff is discarded on ${change} before consumption`, async (t) => {
    const f = await fixture(t);
    const handle = await f.reader.readItem(f.token.token, 'item:person', '1');
    if (change === 'revoke')
      revokeSqliteApiToken(
        f.path,
        { appId: 'app', storeId, exclusions: [], tokenId: f.token.tokenId, expectedVersion: '1', actorId: 'account' },
        Date.now(),
      );
    else {
      const expired = Date.now() + 120000;
      t.mock.method(Date, 'now', () => expired);
    }
    assert.throws(() => f.reader.consumeResult(handle), unavailable);
    assert.throws(() => f.reader.consumeResult(handle), unavailable, 'failed consumption also burns its handle');
  });
}

test('abandoned handoffs are bounded, consumption frees capacity and retirement clears them', async (t) => {
  const f = await fixture(t),
    handles: object[] = [];
  for (let i = 0; i < 16; i++) handles.push(await f.reader.readItem(f.token.token, 'item:person', '1'));
  await assert.rejects(f.reader.readItem(f.token.token, 'item:person', '1'), unavailable);
  f.reader.discardResult(handles[0]);
  assert.throws(() => f.reader.consumeResult(handles[0]), unavailable);
  assert.doesNotThrow(() => f.reader.discardResult({}));
  assert.doesNotThrow(() => f.reader.discardResult(new Proxy({}, {})));
  const replacement = await f.reader.readItem(f.token.token, 'item:person', '1');
  await f.reader.retire();
  assert.throws(() => f.reader.consumeResult(replacement), unavailable);
  assert.throws(() => f.reader.consumeResult(handles[1]), unavailable);
});

test('expiry crossed during materialization discards an already-observed native item', async (t) => {
  const f = await fixture(t);
  const clock = Date.now();
  let now = clock,
    crossed = false;
  const stackLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 32;
  t.after(() => {
    Error.stackTraceLimit = stackLimit;
  });
  t.mock.method(Date, 'now', () => now);
  const byteLength = Buffer.byteLength;
  t.mock.method(Buffer, 'byteLength', (value: Parameters<typeof byteLength>[0], encoding?: BufferEncoding) => {
    // Instrument the existing serializer only in the materialization phase.
    // Earlier adapter remapping/account reads must still see an unexpired token.
    if (value === '"Visible"' && new Error().stack?.includes('materializeApiReadResult')) {
      crossed = true;
      now = clock + 120000;
    }
    return byteLength(value, encoding);
  });
  await assert.rejects(f.reader.readItem(f.token.token, 'item:person', '1'), unavailable);
  assert.equal(crossed, true, 'expiry advanced inside actual result materialization');
});

test('lazy item host acquires only on first read and closes future admissions on retirement', async (t) => {
  const f = await fixture(t);
  const open = t.mock.method(f.registry, 'open');
  const host = createSqliteApiReadHost(f.registry, f.host, 'decimal-string');
  t.after(() => host.retire());
  assert.equal(open.mock.callCount(), 0);
  assert.throws(() => host.consumeResult({}));
  const handle = await host.readItem(f.token.token, 'item:person', '1');
  assert.ok(open.mock.callCount() > 0);
  assert.equal(host.consumeResult(handle).status, 200);
  const discarded = await host.readItem(f.token.token, 'item:person', '1');
  host.discardResult(discarded);
  assert.throws(() => host.consumeResult(discarded));
  await host.retire();
  await assert.rejects(host.readItem(f.token.token, 'item:person', '1'), { message: 'The API item host is unavailable.' });
  assert.throws(() => host.consumeResult(handle));
});

test('retiring an unused item host never acquires a reader', async (t) => {
  const f = await fixture(t),
    open = t.mock.method(f.registry, 'open');
  const host = createSqliteApiReadHost(f.registry, f.host, 'decimal-string');
  await host.retire();
  await assert.rejects(host.readItem(f.token.token, 'item:person', '1'));
  assert.equal(open.mock.callCount(), 0);
});

test('lazy read host forwards genuine list pagination and result consumption', async (t) => {
  const f = await fixture(t, true);
  const host = createSqliteApiReadHost(f.registry, f.host, 'decimal-string');
  try {
    const first = JSON.parse(host.consumeResult(await host.readList(f.token.token, 'list:person', 'sort=id&limit=2')).body);
    assert.deepEqual(
      first.items.map((item: { id: string }) => item.id),
      ['1', '2'],
    );
    assert.equal(typeof first.next, 'string');
    const second = JSON.parse(
      host.consumeResult(await host.readList(f.token.token, 'list:person', `sort=id&limit=2&cursor=${encodeURIComponent(first.next)}`))
        .body,
    );
    assert.deepEqual(
      second.items.map((item: { id: string }) => item.id),
      ['3', '4'],
    );
    assert.equal(second.next, null);
  } finally {
    await host.retire();
  }
});

test('item host retirement drains a genuine pending registry acquisition', async (t) => {
  const f = await fixture(t),
    open = f.registry.open.bind(f.registry);
  let resume!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let first = true;
  t.mock.method(f.registry, 'open', async (id: string) => {
    const actual = await open(id);
    if (first) {
      first = false;
      entered();
      await gate;
    }
    return actual;
  });
  const host = createSqliteApiReadHost(f.registry, f.host, 'decimal-string');
  const pending = host.readItem(f.token.token, 'item:person', '1');
  const rejected = assert.rejects(pending);
  await started;
  let retired = false;
  const closing = host.retire().then(() => {
    retired = true;
  });
  await Promise.resolve();
  assert.equal(retired, false);
  resume();
  await rejected;
  await closing;
  await assert.rejects(host.readItem(f.token.token, 'item:person', '1'));
});

test('failed item host acquisition is not retried after the registry recovers', async (t) => {
  const f = await fixture(t),
    open = f.registry.open.bind(f.registry);
  let attempts = 0;
  t.mock.method(f.registry, 'open', async (id: string) => {
    const actual = await open(id);
    if (++attempts === 1) throw new Error('temporary acquisition failure');
    return actual;
  });
  const host = createSqliteApiReadHost(f.registry, f.host, 'decimal-string');
  await assert.rejects(host.readItem(f.token.token, 'item:person', '1'));
  await assert.rejects(host.readItem(f.token.token, 'item:person', '1'));
  assert.equal(attempts, 1);
  await host.retire();
});

test('native list and standing-view cursors retain projection and uncontinued counts across pages', async (t) => {
  const f = await fixture(t, true);
  for (const [operation, expected, total] of [
    ['list:person', ['1', '2', '3', '4'], 4],
    ['view:people', ['2', '3', '4'], 3],
  ] as const) {
    let cursor: string | null = null;
    const seen: string[] = [];
    for (let page = 0; page < 4; page++) {
      const query = 'fields=id&sort=id&limit=2&count=true' + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      const response = f.reader.consumeResult(await f.reader.readList(f.token.token, operation, query));
      assert.equal(response.status, 200);
      const body = JSON.parse(response.body);
      assert.deepEqual(body.count, { value: total, exact: true, capped: false });
      for (const row of body.items) {
        assert.deepEqual(Object.keys(row), ['id']);
        seen.push(row.id);
      }
      cursor = body.next;
      if (cursor === null) break;
      assert.equal(typeof cursor, 'string');
    }
    assert.deepEqual(seen, expected);
    assert.equal(cursor, null, 'bounded traversal terminates');
  }
  await assert.rejects(f.reader.readList(f.issue([]).token, 'list:person', ''), unavailable);
  await assert.rejects(f.reader.readList(f.token.token, 'list:person', 'fields=secret'), unavailable);
  // A declared text sort orders by bytes (COLLATE BINARY), so it reads rather than refusing.
  const byName = JSON.parse(f.reader.consumeResult(await f.reader.readList(f.token.token, 'list:person', 'fields=id,name&sort=name')).body);
  const names = byName.items.map((row: { name: string }) => row.name);
  assert.ok(names.length > 1);
  assert.deepEqual(names, [...names].sort());
});

test('native list cursor rejects tampering, query/operation/scope and owner rebinding', async (t) => {
  const f = await fixture(t, true),
    foreign = await fixture(t, true);
  const first = JSON.parse(f.reader.consumeResult(await f.reader.readList(f.token.token, 'list:person', 'limit=1')).body);
  assert.equal(typeof first.next, 'string');
  const query = `limit=1&cursor=${encodeURIComponent(first.next)}`;
  const tampered = first.next.slice(0, -1) + (first.next.endsWith('A') ? 'B' : 'A');
  await assert.rejects(f.reader.readList(f.token.token, 'list:person', `limit=1&cursor=${encodeURIComponent(tampered)}`), unavailable);
  await assert.rejects(f.reader.readList(f.token.token, 'list:person', query + '&id=2'), unavailable);
  await assert.rejects(f.reader.readList(f.token.token, 'view:people', query), unavailable);
  await assert.rejects(f.reader.readList(f.issue().token, 'list:person', query), unavailable);
  await assert.rejects(foreign.reader.readList(foreign.token.token, 'list:person', query), unavailable);
});

test('native requested count caps at ten thousand independently of list limit', async (t) => {
  const f = await fixture(t, true);
  const db = new DatabaseSync(f.registry.configOf('data')!.url);
  try {
    db.exec(
      "WITH RECURSIVE ids(n) AS (SELECT 5 UNION ALL SELECT n+1 FROM ids WHERE n<10002) INSERT INTO people SELECT n,'More','hidden' FROM ids",
    );
  } finally {
    db.close();
  }
  const body = JSON.parse(f.reader.consumeResult(await f.reader.readList(f.token.token, 'list:person', 'limit=1&count=true')).body);
  assert.equal(body.items.length, 1);
  assert.deepEqual(body.count, { value: 10000, exact: true, capped: true });
  assert.equal(typeof body.next, 'string');
});

test('native DDL invalidates buffered results and previously issued cursors', async (t) => {
  const f = await fixture(t, true);
  const page = JSON.parse(f.reader.consumeResult(await f.reader.readList(f.token.token, 'list:person', 'limit=1')).body);
  assert.equal(typeof page.next, 'string');
  const buffered = await f.reader.readItem(f.token.token, 'item:person', '1');
  const db = new DatabaseSync(f.registry.configOf('data')!.url);
  try {
    db.exec('ALTER TABLE people ADD COLUMN newly_hidden TEXT');
  } finally {
    db.close();
  }
  assert.throws(() => f.reader.consumeResult(buffered), unavailable);
  await assert.rejects(f.reader.readList(f.token.token, 'list:person', `limit=1&cursor=${encodeURIComponent(page.next)}`), unavailable);
});

async function httpFixture(t: TestContext, requestsPerMinute = 100, integers: 'number' | 'decimal-string' = 'decimal-string') {
  const f = await fixture(t, true);
  let transport: ReturnType<typeof createSqliteApiReadHttp>;
  const server = createServer((req, res) => {
    void transport.handle(req, res).then(
      (handled) => {
        if (!handled) {
          res.statusCode = 418;
          res.end('unhandled');
        }
      },
      () => {
        res.statusCode = 500;
        res.end('unexpected transport rejection');
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  transport = createSqliteApiReadHttp(f.registry, f.host, {
    bound: { host: '127.0.0.1', port: address.port },
    integers,
    requestsPerMinute,
  });
  t.after(async () => {
    await transport.retire();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const get = (path: string, headers: string[] = ['Authorization', `Bearer ${f.token.token}`], method = 'GET') =>
    new Promise<{ status: number; body: string; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: address.port,
          path,
          method,
          headers: [
            ...(headers.some((value, index) => index % 2 === 0 && value.toLowerCase() === 'host')
              ? []
              : ['Host', `127.0.0.1:${address.port}`]),
            ...headers,
          ],
          agent: false,
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  return { ...f, transport, get, port: address.port };
}

test('exported bearer API imports and executes CSV filters across signed cursor pages', async (t) => {
  for (const integers of ['number', 'decimal-string'] as const) {
    const f = await httpFixture(t, 100, integers);
    const spec = await f.get('/api/apps/app/v1/$openapi');
    assert.equal(spec.status, 200);
    const catalog = readOpenApi(JSON.parse(spec.body));
    const description = readDescription(draftDescription(catalog), 'native exported API');
    assert.equal(description.resources.length, 1);
    assert.equal(description.resources[0].filters.id.serialization, 'csv');
    const adapter = new HttpAdapter({
      base: new URL(`http://127.0.0.1:${f.port}/api/apps/app/v1/`),
      description,
      label: 'Native API',
      auth: { header: 'authorization', value: `Bearer ${f.token.token}` },
      policy: { ...DEFAULT_POLICY, insecure: true },
    });
    const filter = { groups: [[{ column: 'id', op: 'in' as const, value: ['1', '2', '3', '4'] }]] };
    const orderBy = [{ column: 'id', direction: 'asc' as const }];
    const first = await adapter.query({ table: 'person', limit: 2, offset: 0, filter, orderBy });
    const second = await adapter.query({ table: 'person', limit: 2, offset: 2, filter, orderBy });
    assert.deepEqual(
      first.rows.map((row) => row.id),
      integers === 'number' ? [1, 2] : ['1', '2'],
    );
    assert.deepEqual(
      second.rows.map((row) => row.id),
      integers === 'number' ? [3, 4] : ['3', '4'],
    );
    assert.match(first.sql.text, /id=1%2C2%2C3%2C4/);
    assert.match(second.sql.text, /cursor=/);
    assert.equal(
      first.rows.some((row) => Object.hasOwn(row, 'secret')),
      false,
    );
    const explorer = await adapter.operation('person', 'list', { id: '2,4', limit: '2', sort: 'id' });
    assert.equal(explorer.status, 200);
    assert.deepEqual(
      (explorer.json as { items: Array<{ id: unknown }> }).items.map((row) => row.id),
      integers === 'number' ? [2, 4] : ['2', '4'],
    );
    revokeSqliteApiToken(
      f.path,
      { appId: 'app', storeId, exclusions: [], tokenId: f.token.tokenId, expectedVersion: '1', actorId: 'account' },
      Date.now(),
    );
    await assert.rejects(adapter.query({ table: 'person', limit: 2, offset: 2, filter, orderBy }), /401/);
  }
});

test('actual HTTP disconnect cancels only its read and drains before releasing the lease', async (t) => {
  const f = await httpFixture(t);
  let enter!: () => void, release!: () => void, cancelled!: () => void, drained!: () => void;
  const started = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    drained = resolve;
  });
  const lease = f.registry.lease.bind(f.registry);
  let leases = 0,
    watching = false;
  t.mock.method(f.registry, 'lease', (...args: Parameters<typeof lease>) => {
    const close = lease(...args);
    leases++;
    return () => {
      close();
      if (--leases === 0 && watching) drained();
    };
  });
  const original = f.physical.runView.bind(f.physical);
  let first = true;
  t.mock.method(f.physical, 'runView', async (...args: Parameters<typeof original>) => {
    const result = await original(...args);
    if (first) {
      first = false;
      const signal = cancellation();
      assert.ok(signal);
      signal.addEventListener('abort', cancelled, { once: true });
      watching = true;
      enter();
      await gate;
    }
    return result;
  });
  const count = t.mock.method(f.physical, 'countView', f.physical.countView.bind(f.physical));
  let received = false;
  const client = request(
    {
      host: '127.0.0.1',
      port: f.port,
      path: '/api/apps/app/v1/person?count=true',
      agent: false,
      headers: { Authorization: `Bearer ${f.token.token}` },
    },
    (response) => {
      received = true;
      response.resume();
    },
  );
  client.on('error', () => {});
  client.end();
  try {
    await started;
    client.destroy();
    await aborted;
    assert.equal(leases, 1, 'aborted socket does not release outstanding driver work');
    assert.equal((await f.get('/api/apps/app/v1/person/1')).status, 200);
    assert.equal(leases, 1, 'another request remains usable independently');
  } finally {
    client.destroy();
    release();
  }
  await finished;
  assert.equal(count.mock.callCount(), 0);
  assert.equal(received, false);
});

test('private ephemeral HTTP serves genuine item/list reads without cookie fallback or browser access', async (t) => {
  const f = await httpFixture(t);
  const item = await f.get('/api/apps/app/v1/person/1');
  assert.equal(item.status, 200);
  assert.deepEqual(JSON.parse(item.body), { id: '1', name: 'Visible' });
  assert.equal(item.headers['cache-control'], 'no-store');
  const list = await f.get('/api/apps/app/v1/person?fields=id&limit=2');
  assert.equal(list.status, 200);
  const body = JSON.parse(list.body);
  assert.equal(body.items.length, 2);
  assert.deepEqual(Object.keys(body.items[0]), ['id']);
  assert.equal(typeof body.next, 'string');
  const missing = await f.get('/api/apps/app/v1/person/99');
  assert.equal(missing.status, 404);
  assert.deepEqual(JSON.parse(missing.body), { error: { code: 'not_found', message: 'The API request could not be completed.' } });
  const wrongApp = await f.get('/api/apps/other/v1/person/99');
  assert.equal(wrongApp.status, 404);
  assert.equal(wrongApp.body, missing.body, 'owner and transport use the same sanitized error envelope');
  const cookie = await f.get('/api/apps/app/v1/person/1', ['Cookie', 'better-auth.session_token=pretend']);
  assert.equal(cookie.status, 401);
  assert.equal(cookie.headers['www-authenticate'], 'Bearer');
  assert.equal((await f.get('/api/run')).status, 418);
  assert.equal((await f.get('/api/apps/app/v1/person?fields=secret')).status, 400);
  assert.equal((await f.get('/api/apps/app/v1/person/%2e')).status, 400);
  assert.equal((await f.get('/api/apps/app/v1/person/1', undefined, 'POST')).status, 405);
  assert.equal(
    (await f.get('/api/apps/app/v1/person/1', ['Authorization', `Bearer ${f.token.token}`, 'authorization', `Bearer ${f.token.token}`]))
      .status,
    401,
    'raw duplicate authorization cannot disappear during header normalization',
  );
  assert.equal(
    (await f.get('/api/apps/app/v1/person/1', ['Authorization', `Bearer ${f.token.token}`, 'Host', 'evil.example'])).status,
    403,
  );
  assert.equal(
    (await f.get('/api/apps/app/v1/person/1', ['Authorization', `Bearer ${f.token.token}`, 'Origin', 'https://evil.example'])).status,
    403,
  );
  assert.equal(
    (await f.get('/api/apps/app/v1/person/1', ['Authorization', `Bearer ${f.token.token}`, 'Host', 'localhost', 'Host', 'evil.example']))
      .status,
    400,
  );
  assert.equal(
    (
      await f.get('/api/apps/app/v1/person/1', [
        'Authorization',
        `Bearer ${f.token.token}`,
        'Origin',
        'http://localhost',
        'Origin',
        'https://evil.example',
      ])
    ).status,
    400,
  );
  assert.equal((await f.get('/api/apps')).status, 400);
  assert.equal((await f.get('http://localhost/api/apps/app/v1/person/1')).status, 400);
  revokeSqliteApiToken(
    f.path,
    { appId: 'app', storeId, exclusions: [], tokenId: f.token.tokenId, expectedVersion: '1', actorId: 'account' },
    Date.now(),
  );
  assert.equal((await f.get('/api/apps/app/v1/person/1')).status, 401);
  await f.transport.retire();
  assert.equal((await f.get('/api/apps/app/v1/person/1')).status, 503);
});

test('native spec handoffs preserve independent operation scope and reauthorize consumption', async (t) => {
  const f = await fixture(t, true);
  for (const [scope, paths] of [
    [[], []],
    [['item:person'], ['/person/{id}']],
    [['list:person'], ['/person']],
    [['view:people'], ['/views/people']],
  ] as Array<[string[], string[]]>) {
    const token = f.issue(scope);
    const result = f.reader.consumeResult(await f.reader.readSpec(token.token));
    assert.equal(result.status, 200);
    const document = JSON.parse(result.body);
    assert.deepEqual(Object.keys(document.paths), paths);
    assert.doesNotMatch(result.body, /eligible-roles|standing-contract|id > 1/);
    assert.ok(!result.body.includes(token.token));
    if (!scope.length) assert.deepEqual(document.components.schemas, {});
  }
  const pending = await f.reader.readSpec(f.token.token);
  f.editAccount('UPDATE "user" SET banned=1');
  assert.throws(() => f.reader.consumeResult(pending), unavailable);
  assert.throws(() => f.reader.consumeResult(pending), unavailable);
});

test('HTTP discovery is bearer-only, scoped, and rejects metadata-route aliases', async (t) => {
  const f = await httpFixture(t);
  const token = f.issue(['item:person']);
  const headers = ['Authorization', `Bearer ${token.token}`];
  const response = await f.get('/api/apps/app/v1/$openapi', headers);
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(Object.keys(JSON.parse(response.body).paths), ['/person/{id}']);
  const cookie = await f.get('/api/apps/app/v1/$openapi', ['Cookie', 'better-auth.session_token=pretend']);
  assert.equal(cookie.status, 401);
  for (const path of [
    '/api/apps/app/v1/$openapi?',
    '/api/apps/app/v1/$openapi?roles=reader',
    '/api/apps/app/v1/$openapi/extra',
    '/api/apps/app/v1/%24openapi',
  ]) {
    assert.equal((await f.get(path, headers)).status, 400, path);
  }
  const buffered = await f.reader.readSpec(f.token.token);
  await f.registry.refresh(f.registry.configOf('data')!.id);
  assert.throws(() => f.reader.consumeResult(buffered), unavailable);
  assert.equal((await f.get('/api/apps/app/v1/$openapi', headers)).status, 503);
});

test('private ephemeral HTTP applies its explicit process-local rate budget', async (t) => {
  const f = await httpFixture(t, 1);
  assert.equal((await f.get('/api/apps/app/v1/person/1')).status, 200);
  const response = await f.get('/api/apps/app/v1/person/1');
  assert.equal(response.status, 429);
  assert.ok(response.headers['retry-after']);
});

test('HTTP original-host capture refuses a swap before its first lazy acquisition', async (t) => {
  const f = await httpFixture(t);
  f.host.app = { ...f.host.app };
  const response = await f.get('/api/apps/app/v1/person/1');
  assert.equal(response.status, 503);
});

async function serverFixture(t: TestContext, enabled: boolean) {
  const f = await fixture(t, true),
    bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({
    registry: f.registry,
    apps: [f.host],
    bound,
    ...(enabled ? { apiReads: { integers: 'decimal-string' as const, requestsPerMinute: 100 } } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  bound.port = address.port;
  t.after(async () => {
    await apiReadLifetimes.get(server)?.retire();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const get = (path: string, bearer = true) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: bound.port, path, agent: false, headers: bearer ? { Authorization: `Bearer ${f.token.token}` } : {} },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode!, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  return { ...f, server, get };
}

test('createApp explicit API opt-in precedes cookie gate but never authorizes browser namespace', async (t) => {
  const f = await serverFixture(t, true);
  assert.ok(apiReadLifetimes.has(f.server));
  const response = await f.get('/api/apps/app/v1/person/1');
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { id: '1', name: 'Visible' });
  assert.equal((await f.get('/api/apps/app/v1/person/1', false)).status, 401);
  assert.equal((await f.get('/api/run')).status, 401, 'bearer does not authenticate internal browser API');
  await apiReadLifetimes.get(f.server)!.retire();
  assert.equal((await f.get('/api/apps/app/v1/person/1')).status, 503);
});

test('createApp defaults do not activate bearer routes', async (t) => {
  const f = await serverFixture(t, false);
  assert.equal(apiReadLifetimes.has(f.server), false);
  assert.equal((await f.get('/api/apps/app/v1/person/1')).status, 401);
});

test('createApp API opt-in refuses nonloopback or invalid host compositions', async (t) => {
  const f = await fixture(t);
  const options = {
    registry: f.registry,
    apps: [f.host],
    bound: { host: '127.0.0.1', port: 0 },
    apiReads: { integers: 'decimal-string' as const, requestsPerMinute: 100 },
  };
  assert.throws(() => createApp({ ...options, bound: { host: '0.0.0.0', port: 0 } }));
  assert.throws(() => createApp({ ...options, apps: [] }));
  assert.throws(() => createApp({ ...options, apps: [f.host, f.host] }));
  assert.throws(() => createApp({ ...options, apps: [{ ...f.host, auth: undefined }] }));
});
