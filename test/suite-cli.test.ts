import assert from 'node:assert/strict';
import { provisionSqliteRecordHistory } from '../packages/mistri/src/adapters/history/sqliteRecordHistory.js';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migratePostgresAuthStore } from '../packages/mistri/src/adapters/auth/postgresAuthStore.js';
import { readSuiteConfiguration } from '../packages/mistri/src/server/cli/suiteConfig.js';
import { startConfiguredSuite } from '../packages/mistri/src/server/cli/suiteCommand.js';
import { liveSkip } from './live.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';

const LIVE = process.env.TABLEWALK_TEST_PG;

test('suite experiments require a dedicated assignment key before loading Apps or opening stores', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-suite-experiments-refusal-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'suite.json');
  const environment = { SUITE_SECRET: 'test-only-suite-secret-at-least-thirty-two-characters' };
  const input = {
    identity: { id: 'suite', store: './identity.db', grants: './grants.db', environment: { BETTER_AUTH_SECRET: 'SUITE_SECRET' } },
    flags: { store: 'postgresql://control:private-secret@127.0.0.1/flags', environment: 'production', deploymentId: 'flags' },
    console: { enabled: true },
    experiments: { store: 'postgresql://control:private-secret@127.0.0.1/evidence', deploymentId: 'evidence' },
    apps: [{ id: 'main', directory: './main', config: './connections.json', mount: '/' }],
  };
  writeFileSync(file, JSON.stringify(input));
  writeFileSync(
    join(directory, 'connections.json'),
    JSON.stringify({ connections: [{ name: 'data', url: join(directory, 'business.db') }] }),
  );
  const message = 'Experiment analytics requires an explicit dedicated assignmentKeyEnv key.';
  for (const malformed of [false, true]) {
    if (malformed) {
      mkdirSync(join(directory, 'main'));
      writeFileSync(join(directory, 'main', 'app.json'), 'malformed App must not be read');
    }
    const before = readdirSync(directory, { recursive: true }).sort();
    assert.deepEqual(
      (await readSuiteConfiguration(file, environment)).experiments,
      input.experiments,
      'foundation parsing stays available',
    );
    await assert.rejects(startConfiguredSuite(file, environment), { message });
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        fileURLToPath(new URL('../packages/mistri/src/server/index.ts', import.meta.url)),
        'suite',
        file,
      ],
      {
        cwd: directory,
        env: { ...process.env, ...environment },
        encoding: 'utf8',
        timeout: 20_000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), `mistri: ${message}`);
    assert.deepEqual(readdirSync(directory, { recursive: true }).sort(), before, 'no App, identity or grant store opens');
  }
});

test('suite config resolves paths and captures environment aliases while refusing ambiguous or unsupported declarations', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-suite-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'suite.json');
  const app = {
    id: 'main',
    directory: './main',
    config: './connections.json',
    mount: '/',
    environment: { BETTER_AUTH_SECRET: 'MAIN_SECRET' },
  };
  const write = (value: unknown) => writeFileSync(file, JSON.stringify(value));
  write({ apps: [{ ...app, jobs: './jobs.mjs' }] });
  const config = await readSuiteConfiguration(file, { MAIN_SECRET: 'captured-value' });
  assert.equal(config.apps[0].environment.BETTER_AUTH_SECRET, 'captured-value');
  assert.equal(config.apps[0].directory, join(directory, 'main'));
  assert.equal(config.apps[0].mount, '');
  assert.equal(config.apps[0].jobs, join(directory, 'jobs.mjs'));
  for (const value of [
    { apps: [app], jobs: 'ignored.ts' },
    { apps: [{ ...app, policyTypo: './policy.ts' }] },
    { apps: [app, { ...app, id: 'other' }] },
    { apps: [app, app] },
    { port: 0, apps: [app] },
    { apps: [{ ...app, environment: null }] },
  ]) {
    write(value);
    await assert.rejects(readSuiteConfiguration(file, { MAIN_SECRET: 'captured-value' }));
  }
  write({ apps: [app] });
  await assert.rejects(readSuiteConfiguration(file, {}), /MAIN_SECRET is not set/);
});

test('the suite CLI serves two independent authenticated Apps and exits cleanly on SIGTERM', { timeout: 20_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-suite-cli-'));
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const apps = [];
  for (const id of ['main', 'child']) {
    const home = join(directory, id);
    mkdirSync(home);
    const database = join(home, 'business.db');
    const db = new DatabaseSync(database);
    db.exec('CREATE TABLE note(id INTEGER PRIMARY KEY, body TEXT)');
    db.close();
    writeFileSync(
      join(home, 'app.json'),
      JSON.stringify({
        name: id,
        resources: { note: {} },
        auth: { store: join(home, 'auth.db'), providers: ['email'], roles: { user: { read: true } } },
        views: { notes: { kind: 'list', from: 'note' } },
        home: 'notes',
        nav: ['notes'],
      }),
    );
    writeFileSync(join(home, 'connections.json'), JSON.stringify({ connections: [{ name: 'data', url: database }] }));
    apps.push({
      id,
      directory: `./${id}`,
      config: `./${id}/connections.json`,
      mount: id === 'main' ? '/' : '/child',
      environment: { BETTER_AUTH_SECRET: 'SUITE_TEST_SECRET' },
    });
  }
  const file = join(directory, 'suite.json');
  writeFileSync(file, JSON.stringify({ port, apps }));
  const child = spawn(process.execPath, ['--import', 'tsx', 'packages/mistri/src/server/index.ts', 'suite', file], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, SUITE_TEST_SECRET: 'a-test-only-suite-secret-longer-than-thirty-two-characters' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    rmSync(directory, { recursive: true, force: true });
  });
  let output = '';
  child.stderr.on('data', (bytes) => {
    output += bytes.toString();
  });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Suite exited ${code}: ${output}`)));
    child.stdout.on('data', (bytes) => {
      output += bytes.toString();
      if (output.includes('Suite listening on')) resolve();
    });
  });
  for (const [path, id] of [
    ['/api/whoami', 'main'],
    ['/child/api/whoami', 'child'],
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    assert.equal(response.status, 200, output);
    const identity = await response.json();
    assert.equal(identity.appId, id);
    assert.equal(identity.signedIn, false);
  }
  const alias = await fetch(`http://127.0.0.1:${port}/child/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { origin: `http://localhost:${port}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'absent@example.test', password: 'a-test-only-password' }),
  });
  /* Better Auth trusts both loopback names, but a page on one posting to the other is another origin, and
     the door refuses it as it refuses every other write from another page; from its own page it is asked. */
  assert.equal(alias.status, 403, 'a page on localhost posting to 127.0.0.1 is another origin');
  assert.match(await alias.text(), /tried to make this request/);
  const own = await fetch(`http://127.0.0.1:${port}/child/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'absent@example.test', password: 'a-test-only-password' }),
  });
  assert.equal(own.status, 401, 'its own page reaches the authentication check');
  await own.text();
  child.kill('SIGTERM');
  assert.deepEqual(await exited, [0, null], output);
  const mainFile = join(directory, 'main', 'app.json');
  const main = JSON.parse(readFileSync(mainFile, 'utf8'));
  main.views.notes.path = 'child';
  writeFileSync(mainFile, JSON.stringify(main));
  await assert.rejects(
    startConfiguredSuite(file, { SUITE_TEST_SECRET: 'a-test-only-suite-secret-longer-than-thirty-two-characters' }),
    /where the App "child" is mounted/,
    'a root App cannot silently lose a route to a child mount',
  );
});

test('suite preflight refuses unsupported forms and mismatched policy owners before opening stores', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-suite-refusals-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const app = join(directory, 'main');
  mkdirSync(app);
  const config = join(directory, 'connections.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'data', url: join(directory, 'never-created.db'), writable: true }] }));
  writeFileSync(
    join(app, 'commands.mjs'),
    `import { defineCommand, defineCommands, shape, text } from ${JSON.stringify(new URL('../packages/mistri/src/server/commands.ts', import.meta.url).href)};
    export default defineCommands({
      submit: defineCommand({ source: 'data', target: 'note', targets: 'none', input: { body: { type: 'text' } }, validate(value) { return value }, handle() {} }),
      enrol: defineCommand({ source: 'data', target: 'note', targets: 'none', public: true, input: { body: { type: 'text' } }, validate(value) { return value }, output: shape({ reference: text() }), handle() { return { reference: 'NOTE-1' } } }),
      saveStep: defineCommand({ source: 'data', target: 'note', targets: 'none', public: true, input: { stepValue: { type: 'text' } }, validate(value) { return value }, output: shape({ reference: text() }), handle() { return { reference: 'NOTE-1' } } }),
      'enrol-keyed': defineCommand({ source: 'data', target: 'note', targets: 'none', public: true, input: { ssn: { type: 'text', sensitive: { keep: 'hash' } } }, validate(value) { return value }, output: shape({ reference: text() }), handle() { return { reference: 'NOTE-1' } } })
    });`,
  );
  const manifest = {
    name: 'main',
    sources: { data: { connection: 'data', default: true } },
    resources: { note: { access: 'write' } },
    auth: { store: join(directory, 'never-auth.db'), roles: { user: { read: true, commands: ['submit'] } } },
    views: { notes: { kind: 'list', from: 'note' } },
    home: 'notes',
    nav: ['notes'],
  };
  const deployment = {
    id: 'main',
    directory: './main',
    config: './connections.json',
    mount: '/',
    environment: { BETTER_AUTH_SECRET: 'SECRET' },
  };
  const file = join(directory, 'suite.json');
  const cases = [
    { app: { ...manifest, auth: { ...manifest.auth, rows: 'policy' } }, deployment, error: /requires a policy file/ },
    { app: manifest, deployment: { ...deployment, policy: './missing-policy.mjs' }, error: /requires a policy file/ },
  ];
  for (const item of cases) {
    writeFileSync(join(app, 'app.json'), JSON.stringify(item.app));
    writeFileSync(file, JSON.stringify({ apps: [item.deployment] }));
    await assert.rejects(startConfiguredSuite(file, { SECRET: 'test-only-secret-at-least-thirty-two-characters' }), item.error);
  }
  assert.equal(existsSync(join(directory, 'never-created.db')), false);
  assert.equal(existsSync(join(directory, 'never-auth.db')), false);
});

test('suite preflight refuses an ordinary App whose record history page has no provisioned store', { timeout: 20_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-suite-history-refusal-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const app = join(directory, 'main');
  mkdirSync(app);
  const database = join(app, 'business.db');
  const db = new DatabaseSync(database);
  db.exec('CREATE TABLE note(id INTEGER PRIMARY KEY, body TEXT)');
  db.close();
  writeFileSync(
    join(app, 'app.json'),
    JSON.stringify({
      name: 'main',
      resources: { note: {} },
      auth: { store: join(directory, 'auth.db'), roles: { user: { read: true } } },
      views: { notes: { kind: 'list', from: 'note' } },
      pages: { note: { base: 'note', sections: [{ kind: 'history' }] } },
      home: 'notes',
      nav: ['notes'],
    }),
  );
  writeFileSync(join(directory, 'connections.json'), JSON.stringify({ connections: [{ name: 'data', url: database }] }));
  const deployment = {
    id: 'main',
    directory: './main',
    config: './connections.json',
    mount: '/',
    environment: { BETTER_AUTH_SECRET: 'SECRET' },
  };
  const file = join(directory, 'suite.json');
  writeFileSync(file, JSON.stringify({ apps: [deployment] }));
  await assert.rejects(startConfiguredSuite(file, { SECRET: 'test-only-secret-at-least-thirty-two-characters' }), /record history/);
});

test('suite serves independent Apps with provisioned record history stores', { timeout: 20_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-suite-history-startup-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const apps = [];
  for (const id of ['alpha', 'beta']) {
    const home = join(directory, id);
    mkdirSync(home);
    const database = join(home, 'business.db');
    const db = new DatabaseSync(database);
    db.exec(`CREATE TABLE note(id INTEGER PRIMARY KEY, body TEXT);
      INSERT INTO note(id, body) VALUES(1, '${id}-initial')`);
    db.close();
    provisionSqliteRecordHistory(database);
    writeFileSync(
      join(home, 'app.json'),
      JSON.stringify({
        name: id,
        resources: { note: { access: 'write' } },
        auth: { store: join(home, 'auth.db'), providers: ['email'], signUp: 'open', roles: { user: { read: true, write: ['note'] } } },
        views: { notes: { kind: 'list', from: 'note' } },
        pages: { note: { base: 'note', sections: [{ kind: 'history' }] } },
        home: 'notes',
        nav: ['notes'],
      }),
    );
    writeFileSync(join(home, 'connections.json'), JSON.stringify({ connections: [{ name: 'data', url: database, writable: true }] }));
    apps.push({
      id,
      directory: `./${id}`,
      config: `./${id}/connections.json`,
      mount: id === 'alpha' ? '/' : '/beta',
      environment: { BETTER_AUTH_SECRET: 'SUITE_TEST_SECRET' },
    });
  }
  const file = join(directory, 'suite.json');
  writeFileSync(file, JSON.stringify({ port, apps }));
  const suite = await startConfiguredSuite(file, { SUITE_TEST_SECRET: 'a-test-only-suite-secret-longer-than-thirty-two-characters' });
  t.after(async () => {
    await suite.close();
  });
  for (const [path, id] of [
    ['/api/whoami', 'alpha'],
    ['/beta/api/whoami', 'beta'],
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    assert.equal(response.status, 200);
    const identity = await response.json();
    assert.equal(identity.appId, id);
    assert.equal(identity.signedIn, false);
  }
  const origin = `http://127.0.0.1:${port}`;
  const session = async (path: string) => {
    const response = await fetch(`${origin}${path}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'History Reader', email: 'reader@example.test', password: 'test-password-long-enough' }),
    });
    assert.equal(response.status, 200, await response.text());
    return response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(';')[0])
      .join('; ');
  };
  const alphaCookie = await session('');
  const betaCookie = await session('/beta');
  for (const [path, cookie, id] of [
    ['', alphaCookie, 'alpha'],
    ['/beta', betaCookie, 'beta'],
  ]) {
    const updated = await fetch(`${origin}${path}/api/update`, {
      method: 'POST',
      headers: { origin, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ table: 'note', key: { id: 1 }, values: { body: `${id}-changed` } }),
    });
    assert.equal(updated.status, 200, await updated.text());
    const history = await fetch(`${origin}${path}/api/record-history`, {
      method: 'POST',
      headers: { origin, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ table: 'note', key: { id: 1 } }),
    });
    assert.equal(history.status, 200, await history.clone().text());
    const result = await history.json();
    assert.match(JSON.stringify(result), new RegExp(`${id}-changed`));
    assert.doesNotMatch(JSON.stringify(result), new RegExp(`${id === 'alpha' ? 'beta' : 'alpha'}-changed`));
  }
  const crossed = await fetch(`${origin}/beta/api/record-history`, {
    method: 'POST',
    headers: { origin, cookie: alphaCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ table: 'note', key: { id: 1 } }),
  });
  assert.equal(crossed.status, 401, 'root account alone cannot read a child App record history');
});

test(
  'suite serves two independent ordinary Apps on PostgreSQL with owned business and auth databases',
  { skip: liveSkip('postgres', LIVE), timeout: 120_000 },
  async (t) => {
    const socket = createServer();
    await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
    const port = (socket.address() as { port: number }).port;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-suite-pg-'));
    const owned: Array<{ url: string; drop: () => Promise<void> }> = [];
    const controls: Array<{ end(): Promise<void> }> = [];
    let suite: Awaited<ReturnType<typeof startConfiguredSuite>> | undefined;
    t.after(async () => {
      const errors: unknown[] = [];
      try {
        await suite?.close();
      } catch (error) {
        errors.push(error);
      }
      for (const control of controls) {
        try {
          await control.end();
        } catch (error) {
          errors.push(error);
        }
      }
      for (const { drop } of owned.reverse()) {
        try {
          await drop();
        } catch (error) {
          errors.push(error);
        }
      }
      rmSync(directory, { recursive: true, force: true });
      if (errors.length) throw new AggregateError(errors, 'Could not clean up suite PostgreSQL fixtures');
    });
    const apps = [];
    for (const id of ['main', 'child']) {
      const home = join(directory, id);
      mkdirSync(home);
      const business = await uuidPostgresDatabase('tablewalk_suite_biz');
      owned.push(business);
      const auth = await uuidPostgresDatabase('tablewalk_suite_auth');
      owned.push(auth);
      const businessControl = await pgClient(business.url);
      controls.push(businessControl);
      await businessControl.query('CREATE TABLE note(id INTEGER PRIMARY KEY, body TEXT)');
      await migratePostgresAuthStore(auth.url);
      writeFileSync(
        join(home, 'app.json'),
        JSON.stringify({
          name: id,
          resources: { note: {} },
          auth: { store: auth.url, providers: ['email'], roles: { user: { read: true } } },
          views: { notes: { kind: 'list', from: 'note' } },
          home: 'notes',
          nav: ['notes'],
        }),
      );
      writeFileSync(join(home, 'connections.json'), JSON.stringify({ connections: [{ name: 'data', url: business.url }] }));
      apps.push({
        id,
        directory: `./${id}`,
        config: `./${id}/connections.json`,
        mount: id === 'main' ? '/' : '/child',
        environment: { BETTER_AUTH_SECRET: 'SUITE_TEST_SECRET' },
      });
    }
    const file = join(directory, 'suite.json');
    writeFileSync(file, JSON.stringify({ port, apps }));
    suite = await startConfiguredSuite(file, { SUITE_TEST_SECRET: 'a-test-only-suite-secret-longer-than-thirty-two-characters' });
    for (const [path, id] of [
      ['/api/whoami', 'main'],
      ['/child/api/whoami', 'child'],
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(response.status, 200);
      const identity = await response.json();
      assert.equal(identity.appId, id);
      assert.equal(identity.signedIn, false);
    }
  },
);
