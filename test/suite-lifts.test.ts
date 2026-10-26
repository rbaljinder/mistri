/**
 * A suite runs any App that `tablewalk serve` runs, the same way. Each test
 * here starts a real suite with something it once refused, and the refusals
 * that remain are the conflicts only a suite creates: shared identity, shared
 * mounts and one process-wide store.
 */
import assert from 'node:assert/strict';
import { createHmac, hkdfSync } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { provisionSqliteInbox } from '../packages/mistri/src/adapters/inbox/sqliteInbox.js';
import { INBOX_TABLES } from '../packages/mistri/src/adapters/inbox/inbox.js';
import { startConfiguredSuite } from '../packages/mistri/src/server/cli/suiteCommand.js';
import { provisionStores } from '../packages/mistri/src/server/maintenance.js';
import { resetPublicFormLimits } from '../packages/engine/src/server/http/rateLimit.js';
import { resetStatusLockouts } from '../packages/mistri/src/server/forms/statusCheck.js';
import { provisionSqliteTenantStore, TENANT_TABLES } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { startFakeValkey } from './support/fakeValkey.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { loadBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandLoader.js';
import { provisionSqliteApiTokenStore } from '../packages/mistri/src/server/auth/provisionSqliteApiTokenStore.js';
import { issueSqliteApiCommandToken } from '../packages/mistri/src/server/auth/sqliteApiTokenMaintenance.js';
import { captureAuthStoreExclusion } from '../packages/mistri/src/server/auth/authStoreSeparation.js';
import { LEDGER_ROW, LEDGER_TABLE, SESSION_SECRET, writeLedgerApp } from './appApiCli.js';

const COMMANDS = JSON.stringify(new URL('../packages/mistri/src/server/commands.ts', import.meta.url).href);

async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return port;
}

function scratch(t: TestContext, name: string): string {
  const directory = mkdtempSync(join(tmpdir(), `tablewalk-suite-lifts-${name}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const post = (origin: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

/** What formKey.ts stores for a keyed value under a given secret: the same derivation serve uses. */
const keyedUnder = (secret: string, name: string, value: string) =>
  `keyed:${createHmac('sha256', Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), 'mistri.form-key', 'keyed-input.v1', 32)))
    .update(JSON.stringify(['mistri.keyed-input.v1', name, value]))
    .digest('hex')}`;

test(
  'a suite serves private forms, keyed inputs and saved forms on ordinary Apps, each hashed under its own form key',
  { timeout: 30_000 },
  async (t) => {
    resetPublicFormLimits();
    t.after(() => resetPublicFormLimits());
    const directory = scratch(t, 'forms');
    const port = await freePort();
    const environment: NodeJS.ProcessEnv = {
      SECRET: 'test-only-suite-forms-secret-longer-than-thirty-two',
      ALPHA_FORM_KEY: 'alpha-form-key-a-test-only-secret-of-at-least-32-bytes',
      BETA_FORM_KEY: 'beta-form-key-a-test-only-secret-of-at-least-32-bytes!',
    };
    const apps = [],
      databases: Record<string, string> = {};
    for (const id of ['alpha', 'beta']) {
      const home = join(directory, id);
      mkdirSync(home);
      const database = (databases[id] = join(home, 'business.db'));
      const db = new DatabaseSync(database);
      db.exec(`CREATE TABLE application(id INTEGER PRIMARY KEY, ssn TEXT, body TEXT, status TEXT NOT NULL DEFAULT 'submitted',
      resume_token TEXT, resume_expires TEXT, resume_progress TEXT, step_value TEXT)`);
      db.close();
      migrateSqliteCommandJournal(database);
      writeFileSync(
        join(home, 'commands.mjs'),
        `import { defineCommand, defineCommands, shape, text } from ${COMMANDS};
      export default defineCommands({
        apply: defineCommand({ source: 'data', target: 'application', targets: 'none', public: true,
          input: { ssn: { type: 'text', sensitive: { keep: 'hash' } } }, output: shape({ reference: text() }),
          async handle(context, value) { context.tx.insert({ table: 'application', values: { ssn: value.ssn } }); return { reference: 'APP-1' }; } }),
        note: defineCommand({ source: 'data', target: 'application', targets: 'none',
          input: { body: { type: 'text' } }, async handle(context, value) { context.tx.insert({ table: 'application', values: { body: value.body } }); } }),
        ${
          id === 'beta'
            ? `enrol: defineCommand({ source: 'data', target: 'application', targets: 'none', public: true, input: { body: { type: 'text' } },
          output: shape({ reference: text() }), handle() { return { reference: 'ENROL-1' } } }),
        saveStep: defineCommand({ source: 'data', target: 'application', targets: 'none', public: true, input: { stepValue: { type: 'text' } },
          handle() {} }),`
            : ''
        }
      });`,
      );
      writeFileSync(
        join(home, 'app.json'),
        JSON.stringify({
          name: id,
          sources: { data: { connection: 'data', default: true } },
          resources: { application: { access: 'write' } },
          auth: { store: join(home, 'auth.db'), providers: ['email'], roles: { clerk: { read: true, commands: ['note'] } } },
          views: {
            applications: { kind: 'list', from: 'application' },
            apply: { kind: 'form', public: true, label: 'Apply', command: 'apply' },
            note: { kind: 'form', label: 'Note', command: 'note' },
            ...(id === 'beta'
              ? {
                  enrol: {
                    kind: 'form',
                    public: true,
                    label: 'Enrol',
                    command: 'enrol',
                    steps: [{ id: 'about', label: 'About you', command: 'saveStep' }],
                    resume: { token: 'resume_token', expires: 'resume_expires', progress: 'resume_progress', after: '14 days' },
                    draft: { status: 'in_progress' },
                  },
                }
              : {}),
          },
          home: 'applications',
          nav: ['applications', 'note'],
        }),
      );
      writeFileSync(join(home, 'connections.json'), JSON.stringify({ connections: [{ name: 'data', url: database, writable: true }] }));
      apps.push({
        id,
        directory: `./${id}`,
        config: `./${id}/connections.json`,
        mount: id === 'alpha' ? '/' : '/beta',
        environment: { BETTER_AUTH_SECRET: 'SECRET', MISTRI_FORM_KEY: `${id.toUpperCase()}_FORM_KEY` },
      });
    }
    const file = join(directory, 'suite.json');
    writeFileSync(file, JSON.stringify({ port, apps }));
    const suite = await startConfiguredSuite(file, environment);
    let closed = false;
    t.after(async () => {
      if (!closed) await suite.close();
    });
    const origin = suite.publicURL;
    for (const [path, id] of [
      ['', 'alpha'],
      ['/beta', 'beta'],
    ]) {
      const submitted = await post(origin, `${path}/api/forms/apply`, {
        input: { ssn: ' 1234 ' },
        submission: `keyed-${id}-submission-0001`,
      });
      assert.equal(submitted.status, 200, await submitted.clone().text());
      const db = new DatabaseSync(databases[id], { readOnly: true });
      try {
        const stored = db.prepare('SELECT ssn FROM application WHERE ssn IS NOT NULL').get()!.ssn;
        assert.equal(stored, keyedUnder(environment[`${id.toUpperCase()}_FORM_KEY`]!, 'ssn', '1234'), `${id} hashes under its own key`);
      } finally {
        db.close();
      }
    }
    // The signed-in form is a room of the App, not a public form; the saved form answers on its mount.
    assert.deepEqual(
      (await (await fetch(`${origin}/api/forms`)).json()).forms.map((form: { id: string }) => form.id),
      ['apply'],
    );
    assert.equal((await fetch(`${origin}/beta/api/forms/enrol`)).status, 200);
    await suite.close();
    closed = true;

    // An App whose environment maps no key starts on nobody else's: not the process's, not another App's.
    const saved = process.env.MISTRI_FORM_KEY;
    process.env.MISTRI_FORM_KEY = 'a-process-form-key-that-a-suite-app-must-never-read';
    t.after(() => {
      if (saved === undefined) delete process.env.MISTRI_FORM_KEY;
      else process.env.MISTRI_FORM_KEY = saved;
    });
    writeFileSync(file, JSON.stringify({ port, apps: [apps[0], { ...apps[1], environment: { BETTER_AUTH_SECRET: 'SECRET' } }] }));
    await assert.rejects(startConfiguredSuite(file, environment), /beta.*MISTRI_FORM_KEY/s);
  },
);

test(
  'a suite App keeps notifications, posts command effects from its events, and counts public forms in the one named cache',
  { timeout: 30_000 },
  async (t) => {
    resetPublicFormLimits();
    resetStatusLockouts();
    t.after(() => {
      resetPublicFormLimits();
      resetStatusLockouts();
    });
    const directory = scratch(t, 'services');
    const port = await freePort();
    const valkey = await startFakeValkey();
    t.after(() => valkey.close());
    const received: unknown[] = [];
    const hook = createServer((request: IncomingMessage, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        response.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve) => hook.close(() => resolve())));
    const hookPort = (hook.address() as { port: number }).port;

    const home = join(directory, 'desk');
    mkdirSync(home);
    const database = join(home, 'business.db');
    const db = new DatabaseSync(database);
    db.exec(`CREATE TABLE person(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT);
    INSERT INTO person VALUES (1, 'Ann', 'ann@example.test');
    CREATE TABLE task(id INTEGER PRIMARY KEY, title TEXT NOT NULL, assignee TEXT, status TEXT NOT NULL DEFAULT 'open')`);
    db.close();
    migrateSqliteCommandJournal(database);
    provisionSqliteInbox(database);
    writeFileSync(
      join(home, 'commands.mjs'),
      `import { defineCommand, defineCommands, shape, text } from ${COMMANDS};
    import { post } from ${JSON.stringify(new URL('../packages/mistri/src/server/commands/commandEffects.ts', import.meta.url).href)};
    export default defineCommands({ request: defineCommand({ source: 'data', target: 'task', targets: 'none', public: true,
      input: { title: { type: 'text' } }, output: shape({ reference: text() }),
      effects: { tell: post('hooks', result => ({ reference: result.reference })) },
      async handle(context, value) {
        context.tx.insert({ table: 'task', values: { title: value.title, assignee: 'ann@example.test' } });
        return { reference: 'TASK-1' };
      } }) });`,
    );
    const commands = (await import(pathToFileURL(join(home, 'commands.mjs')).href)).default;
    await provisionStores({ sqlite: database }, { app: { id: 'desk', commands } });
    writeFileSync(
      join(home, 'app.json'),
      JSON.stringify({
        name: 'desk',
        sources: { data: { connection: 'data', default: true } },
        resources: {
          person: {},
          task: { access: 'write', notify: [{ on: 'insert', to: 'assignee', title: 'Assigned to you: {title}', email: true }] },
        },
        auth: {
          store: join(home, 'auth.db'),
          providers: ['email'],
          me: { from: 'person', column: 'email' },
          roles: { member: { read: true } },
        },
        views: { tasks: { kind: 'list', from: 'task' }, request: { kind: 'form', public: true, label: 'Request', command: 'request' } },
        home: 'tasks',
        nav: ['tasks'],
      }),
    );
    writeFileSync(
      join(home, 'connections.json'),
      JSON.stringify({
        connections: [
          { name: 'data', url: database, writable: true },
          { name: 'mail', kind: 'email', url: 'log:mail.log', from: 'Desk <no-reply@example.test>' },
          { name: 'cache', kind: 'cache', url: valkey.url, insecure: true },
          { name: 'hooks', kind: 'webhook', url: `http://127.0.0.1:${hookPort}/hook` },
        ],
      }),
    );
    const deployment = {
      id: 'desk',
      directory: './desk',
      config: './desk/connections.json',
      mount: '/',
      environment: { BETTER_AUTH_SECRET: 'SECRET' },
    };
    const file = join(directory, 'suite.json');
    writeFileSync(file, JSON.stringify({ port, apps: [deployment] }));
    const environment = { SECRET: 'test-only-suite-services-secret-longer-than-thirty-two' };
    const suite = await startConfiguredSuite(file, environment);
    let closed = false;
    t.after(async () => {
      if (!closed) await suite.close();
    });
    const submitted = await post(suite.publicURL, '/api/forms/request', {
      input: { title: 'Order flux' },
      submission: 'services-submission-0001',
    });
    assert.equal(submitted.status, 200, await submitted.clone().text());
    // The notify rule wrote its notice with the write, in the App's own inbox store.
    const check = new DatabaseSync(database, { readOnly: true });
    try {
      const notices = check.prepare(`SELECT * FROM "${INBOX_TABLES.notice}"`).all();
      assert.equal(notices.length, 1);
    } finally {
      check.close();
    }
    // The effect left with the event, after the commit, from the App's own event and delivery stores.
    const deadline = Date.now() + 10_000;
    while (!received.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(received.length, 1, 'the effect was posted once');
    assert.match(JSON.stringify(received[0]), /TASK-1/);
    // The public form's budget was counted in the cache the App named, under the suite's namespace.
    assert.ok(
      valkey.commands.some((command) => command.some((part) => part.startsWith('tw:suite:desk:form:'))),
      JSON.stringify(valkey.commands.slice(0, 5)),
    );
    await suite.close();
    closed = true;

    // Two Apps naming two caches would split one budget: that is the suite's conflict, refused.
    const other = join(directory, 'other');
    mkdirSync(other);
    const otherDb = join(other, 'business.db');
    const created = new DatabaseSync(otherDb);
    created.exec('CREATE TABLE note(id INTEGER PRIMARY KEY)');
    created.close();
    writeFileSync(
      join(other, 'app.json'),
      JSON.stringify({
        name: 'other',
        resources: { note: {} },
        auth: { store: join(other, 'auth.db'), providers: ['email'], roles: { user: { read: true } } },
        views: { notes: { kind: 'list', from: 'note' } },
        home: 'notes',
      }),
    );
    writeFileSync(
      join(other, 'connections.json'),
      JSON.stringify({
        connections: [
          { name: 'data', url: otherDb },
          { name: 'cache', kind: 'cache', url: valkey.url.replace(`:${valkey.port}`, `:${valkey.port + 1}`), insecure: true },
        ],
      }),
    );
    writeFileSync(
      file,
      JSON.stringify({
        port,
        apps: [
          deployment,
          {
            id: 'other',
            directory: './other',
            config: './other/connections.json',
            mount: '/other',
            environment: { BETTER_AUTH_SECRET: 'SECRET' },
          },
        ],
      }),
    );
    await assert.rejects(startConfiguredSuite(file, environment), /different cache services/);
    assert.equal(existsSync(join(other, 'auth.db')), false, 'refused before any store opens');
    // A config file's own analytics beside the suite's is one store bound twice: refused.
    writeFileSync(
      join(other, 'connections.json'),
      JSON.stringify({
        connections: [{ name: 'data', url: otherDb }],
        analytics: { store: join(other, 'analytics.db'), deploymentId: 'other' },
      }),
    );
    writeFileSync(
      file,
      JSON.stringify({
        port,
        analytics: { app: 'desk', store: join(directory, 'analytics.db'), deploymentId: 'suite' },
        apps: [
          deployment,
          {
            id: 'other',
            directory: './other',
            config: './other/connections.json',
            mount: '/other',
            environment: { BETTER_AUTH_SECRET: 'SECRET' },
          },
        ],
      }),
    );
    await assert.rejects(startConfiguredSuite(file, environment), /binds "analytics" and so does the suite/);
  },
);

test(
  'a tenant App serves at the root of a suite without shared identity, and is refused there beside shared identity',
  { timeout: 30_000 },
  async (t) => {
    const directory = scratch(t, 'tenant-root');
    const port = await freePort();
    const home = join(directory, 'alpha');
    mkdirSync(home);
    const database = join(home, 'business.db');
    const db = new DatabaseSync(database);
    db.exec(`CREATE TABLE item(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL);
    INSERT INTO item VALUES('same', 'north', 'alpha');`);
    db.close();
    provisionSqliteTenantStore(database, { appId: 'alpha', source: { id: 'data', connection: 'data' }, storeId: 'store' });
    const seed = new DatabaseSync(database);
    seed.exec(`INSERT INTO "${TENANT_TABLES.tenant}" VALUES('north','active','1','tenant')`);
    seed.close();
    writeFileSync(
      join(home, 'app.json'),
      JSON.stringify({
        id: 'alpha',
        name: 'alpha',
        sources: { data: { connection: 'data' } },
        auth: { store: join(home, 'auth.db'), rows: 'tenant', signUp: 'open', roles: { member: { read: true } } },
        resources: { item: { owner: 'tenant', fields: { read: ['id', 'name'] } } },
        views: { items: { kind: 'list', from: 'item' } },
        home: 'items',
      }),
    );
    writeFileSync(
      join(home, 'policy.mjs'),
      `export default {kind:'tenant',appId:'alpha',storeId:'store',
    ownership:{item:{kind:'tenant',column:'tenant_id'}},resolveMembershipRows:()=>({item:true}),resolveRows:()=>({item:true})};`,
    );
    writeFileSync(join(home, 'connections.json'), JSON.stringify({ connections: [{ name: 'data', url: database }] }));
    const deployment = {
      id: 'alpha',
      directory: './alpha',
      mount: '/',
      config: './alpha/connections.json',
      policy: './alpha/policy.mjs',
      environment: { BETTER_AUTH_SECRET: 'SECRET' },
    };
    const environment = { SECRET: 'suite-tenant-root-test-secret-longer-than-thirty-two' };
    const file = join(directory, 'suite.json');
    writeFileSync(file, JSON.stringify({ port, apps: [deployment] }));
    const suite = await startConfiguredSuite(file, environment);
    let closed = false;
    t.after(async () => {
      if (!closed) await suite.close();
    });
    const call = async (path: string, headers: Record<string, string> = {}, body?: unknown) => {
      const response = await fetch(suite.publicURL + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { origin: suite.publicURL, 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return {
        status: response.status,
        body: JSON.parse(text),
        text,
        cookie: response.headers
          .getSetCookie()
          .map((value) => value.split(';')[0])
          .join('; '),
      };
    };
    const account = await call(
      '/api/auth/sign-up/email',
      {},
      { name: 'Reader', email: 'reader@example.test', password: 'test-only-tenant-password' },
    );
    assert.equal(account.status, 200, account.text);
    const membership = new DatabaseSync(database);
    membership
      .prepare(
        `INSERT INTO "${TENANT_TABLES.membership}" VALUES(?, 'north', ?, 'active', '1', '["member"]', ?, 'member', NULL, NULL, NULL)`,
      )
      .run('membership', account.body.user.id, Date.now() + 120000);
    membership.close();
    const headers = { cookie: account.cookie, 'x-mistri-account': account.body.user.id };
    const open = await call('/api/tenant/context/open?app=alpha&tenant=north', headers, {});
    assert.equal(open.status, 200, open.text);
    const rows = await call(
      '/api/query?app=alpha&tenant=north',
      {
        ...headers,
        'x-mistri-tab': open.body.tabId,
        'x-mistri-context': open.body.context,
        'x-mistri-lease-revision': String(open.body.revision),
      },
      { table: 'item' },
    );
    assert.equal(rows.status, 200, rows.text);
    assert.deepEqual(rows.body.rows, [{ id: 'same', name: 'alpha' }]);
    await suite.close();
    closed = true;
    writeFileSync(
      file,
      JSON.stringify({
        port,
        apps: [deployment],
        identity: { id: 'keystone', store: './identity.db', grants: './grants.db', environment: { BETTER_AUTH_SECRET: 'SECRET' } },
      }),
    );
    await assert.rejects(startConfiguredSuite(file, environment), /tenant App at the root of a suite with shared identity/);
  },
);

test(
  "a suite serves an App's declared API under its own deployment, and refuses it beside shared identity or a public origin",
  { timeout: 60_000 },
  async (t) => {
    const directory = scratch(t, 'api');
    const port = await freePort();
    const business = join(directory, 'business.db'),
      authPath = join(directory, 'auth.db');
    const db = new DatabaseSync(business);
    try {
      db.exec(`${LEDGER_TABLE}; ${LEDGER_ROW}`);
    } finally {
      db.close();
    }
    migrateSqliteCommandJournal(business);
    const { appDir, commands } = writeLedgerApp(directory, { business, authStore: authPath });
    const loaded = await loadApp(appDir);
    writeFileSync(join(appDir, 'authority.lock'), loaded.authority!.report);
    const saved = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = SESSION_SECRET;
    try {
      (await createAppAuth(loaded, { baseURL: 'http://127.0.0.1:1', trustedOrigins: ['http://127.0.0.1:1'] })).close();
    } finally {
      if (saved === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = saved;
    }
    const accounts = new DatabaseSync(authPath);
    try {
      accounts
        .prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt,role,banned) VALUES (?,?,?,1,?,?,?,0)')
        .run('operator', 'Operator', 'operator@example.test', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'operator');
    } finally {
      accounts.close();
    }
    const storeId = '6c2f0c52-7c1e-4c55-9e0a-4a7f3f0c2d12',
      exclusions = [captureAuthStoreExclusion(business)];
    provisionSqliteApiTokenStore(authPath, { appId: 'ledger', storeId, exclusions });
    const registry = new Registry();
    registry.add({ id: 'data', name: 'data', url: business, writable: true, source: 'config' });
    let token: string;
    try {
      const resources = await loadAppRuntimeResources(registry, loaded.app, 'data');
      token = issueSqliteApiCommandToken(
        authPath,
        loaded.app,
        resources.schema,
        await loadBusinessCommands(commands),
        { connectionFor: resources.connectionFor, writableConnection: () => true, transactionalConnection: () => true },
        {
          storeId,
          exclusions,
          subjectId: 'operator',
          actorId: 'operator',
          roles: ['operator'],
          label: 'Suite test',
          expiresAt: Date.now() + 600_000,
        },
        Date.now(),
      ).token;
    } finally {
      await registry.closeAll();
    }
    const deployment = {
      id: 'ledger',
      directory: './app',
      config: './mistri.json',
      mount: '/ledger',
      environment: { BETTER_AUTH_SECRET: 'SECRET' },
      api: { integers: 'decimal-string', requestsPerMinute: 600 },
    };
    const file = join(directory, 'suite.json');
    writeFileSync(file, JSON.stringify({ port, apps: [deployment] }));
    const environment = { SECRET: SESSION_SECRET };
    const suite = await startConfiguredSuite(file, environment);
    let closed = false;
    t.after(async () => {
      if (!closed) await suite.close();
    });
    const base = `${suite.publicURL}/ledger/api/apps/ledger/v1`;
    const bearer = { authorization: `Bearer ${token}` };
    const item = await fetch(`${base}/item/1`, { headers: bearer });
    assert.equal(item.status, 200, await item.clone().text());
    assert.deepEqual(await item.json(), { id: '1', version: '0', name: 'One' });
    assert.equal((await fetch(`${base}/item/1`)).status, 401, 'no token, no read');
    const applied = await fetch(`${base}/item/1/commands/change/v1`, {
      method: 'POST',
      headers: { ...bearer, 'if-match': '"0"', 'idempotency-key': 'suite-attempt-0000000001', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(applied.status, 200, await applied.clone().text());
    await suite.close();
    closed = true;
    // Without "api" the declaration is inert, as serve without --api-reads leaves it.
    const { api: _api, ...inert } = deployment;
    writeFileSync(file, JSON.stringify({ port, apps: [inert] }));
    const quiet = await startConfiguredSuite(file, environment);
    try {
      assert.notEqual((await fetch(`${base}/item/1`, { headers: bearer })).status, 200, 'a bearer token reads nothing');
    } finally {
      await quiet.close();
    }
    // Tokens live in the App's own sign-in store, which shared identity replaces; the API answers on loopback alone.
    writeFileSync(
      file,
      JSON.stringify({
        port,
        apps: [deployment],
        identity: { id: 'suite', store: './identity.db', grants: './grants.db', environment: { BETTER_AUTH_SECRET: 'SECRET' } },
      }),
    );
    await assert.rejects(startConfiguredSuite(file, environment), /API tokens belong to the App's own sign-in store/);
    writeFileSync(file, JSON.stringify({ port, publicOrigin: 'https://suite.example.test', apps: [deployment] }));
    await assert.rejects(startConfiguredSuite(file, environment), /answers only on loopback/);
  },
);

test("a suite runs a machine timer through the App's own jobs, as serve does", { timeout: 30_000 }, async (t) => {
  const directory = scratch(t, 'timers');
  const port = await freePort();
  const home = join(directory, 'tix');
  mkdirSync(home);
  const database = join(home, 'business.db');
  const db = new DatabaseSync(database);
  db.exec(`CREATE TABLE ticket(id INTEGER PRIMARY KEY, status TEXT NOT NULL, changed_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);
    INSERT INTO ticket VALUES (1, 'open', '2020-01-01 00:00:00', 0)`);
  db.close();
  migrateSqliteCommandJournal(database);
  writeFileSync(
    join(home, 'commands.mjs'),
    `import { defineCommand, defineCommands } from ${COMMANDS};
    export default defineCommands({ expire: defineCommand({ source: 'data', target: 'ticket', input: {},
      async handle({ db, record }) { await db.ticket.update(record, { status: 'expired' }); } }),
      yearly: defineCommand({ source: 'data', target: 'ticket', targets: 'none', input: {}, handle() {} }) });`,
  );
  writeFileSync(
    join(home, 'jobs.mjs'),
    `import { defineJobs } from ${JSON.stringify(new URL('../packages/mistri/src/server/jobs.ts', import.meta.url).href)};
    import { defineJob } from ${JSON.stringify(new URL('../packages/mistri/src/server/jobs.ts', import.meta.url).href)};
    export default defineJobs({ yearly: defineJob({ every: '0 0 1 1 *', runAs: 'clock', command: 'yearly' }) }, { principals: { clock: { roles: ['automation'] } }, store: { namespace: 'tix' } });`,
  );
  writeFileSync(
    join(home, 'app.json'),
    JSON.stringify({
      id: 'tix',
      name: 'tix',
      sources: { data: { connection: 'data', default: true } },
      resources: {
        ticket: {
          access: 'write',
          machine: {
            column: 'status',
            since: 'changed_at',
            states: { open: { after: { '2 hours': 'expire' }, on: { expire: 'expired' } }, expired: { final: true } },
          },
        },
      },
      auth: { store: join(home, 'auth.db'), providers: ['email'], roles: { automation: { read: true, commands: ['expire', 'yearly'] } } },
      views: { tickets: { kind: 'list', from: 'ticket' } },
      home: 'tickets',
    }),
  );
  writeFileSync(join(home, 'connections.json'), JSON.stringify({ connections: [{ name: 'data', url: database, writable: true }] }));
  const { provisionStores } = await import('../packages/mistri/src/server/maintenance.js');
  await provisionStores(
    { sqlite: database },
    {
      app: { id: 'tix', commands: (await import(pathToFileURL(join(home, 'commands.mjs')).href)).default },
      jobs: (await import(pathToFileURL(join(home, 'jobs.mjs')).href)).default,
    },
  );
  const file = join(directory, 'suite.json');
  writeFileSync(
    file,
    JSON.stringify({
      port,
      apps: [
        {
          id: 'tix',
          directory: './tix',
          config: './tix/connections.json',
          jobs: './tix/jobs.mjs',
          mount: '/',
          environment: { BETTER_AUTH_SECRET: 'SECRET' },
        },
      ],
    }),
  );
  const suite = await startConfiguredSuite(file, { SECRET: 'test-only-suite-timers-secret-longer-than-thirty-two' });
  t.after(() => suite.close());
  const deadline = Date.now() + 15_000;
  const status = () => {
    const read = new DatabaseSync(database, { readOnly: true });
    try {
      return read.prepare('SELECT status FROM ticket WHERE id = 1').get()!.status;
    } finally {
      read.close();
    }
  };
  while (status() !== 'expired' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(status(), 'expired', "the timer's command ran from the App's own job store");
});

test(
  "an App's timer at an instant a minute past runs within its first sweep, once, while its when holds (G127)",
  { timeout: 30_000 },
  async (t) => {
    const directory = scratch(t, 'at-timers');
    const home = join(directory, 'desk');
    mkdirSync(home);
    const database = join(home, 'business.db');
    const db = new DatabaseSync(database);
    const minuteAgo = new Date(Date.now() - 60_000).toISOString().replace('T', ' ').slice(0, 19);
    // An open ticket a minute past due, a resolved one as late, and an open one not yet due.
    db.exec(`CREATE TABLE ticket(id INTEGER PRIMARY KEY, status TEXT NOT NULL, due_at TIMESTAMP, warned INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 0);
    INSERT INTO ticket (id, status, due_at) VALUES (1, 'open', '${minuteAgo}'), (2, 'resolved', '${minuteAgo}'), (3, 'open', '2999-01-01 09:00:00')`);
    db.close();
    migrateSqliteCommandJournal(database);
    writeFileSync(
      join(home, 'commands.mjs'),
      `import { defineCommand, defineCommands } from ${COMMANDS};
    export default defineCommands({ warn: defineCommand({ source: 'data', target: 'ticket', input: {},
      async handle({ db, record }) { await db.ticket.update(record, { warned: Number(record.warned) + 1 }); } }),
      yearly: defineCommand({ source: 'data', target: 'ticket', targets: 'none', input: {}, handle() {} }) });`,
    );
    const jobsModule = JSON.stringify(new URL('../packages/mistri/src/server/jobs.ts', import.meta.url).href);
    writeFileSync(
      join(home, 'jobs.mjs'),
      `import { defineJob, defineJobs } from ${jobsModule};
    export default defineJobs({ yearly: defineJob({ every: '0 0 1 1 *', runAs: 'clock', command: 'yearly' }) }, { principals: { clock: { roles: ['automation'] } }, store: { namespace: 'desk' } });`,
    );
    writeFileSync(
      join(home, 'app.json'),
      JSON.stringify({
        id: 'desk',
        name: 'desk',
        sources: { data: { connection: 'data', default: true } },
        // No machine: what the timer waits on is the record's own conditions.
        resources: { ticket: { access: 'write', at: { due_at: { command: 'warn', when: "status = 'open'" } } } },
        auth: { store: join(home, 'auth.db'), providers: ['email'], roles: { automation: { read: true, commands: ['warn', 'yearly'] } } },
        views: { tickets: { kind: 'list', from: 'ticket' } },
        home: 'tickets',
      }),
    );
    writeFileSync(join(home, 'connections.json'), JSON.stringify({ connections: [{ name: 'data', url: database, writable: true }] }));
    const { provisionStores } = await import('../packages/mistri/src/server/maintenance.js');
    await provisionStores(
      { sqlite: database },
      {
        app: { id: 'desk', commands: (await import(pathToFileURL(join(home, 'commands.mjs')).href)).default },
        jobs: (await import(pathToFileURL(join(home, 'jobs.mjs')).href)).default,
      },
    );
    const file = join(directory, 'suite.json');
    const serve = async () => {
      writeFileSync(
        file,
        JSON.stringify({
          port: await freePort(),
          apps: [
            {
              id: 'desk',
              directory: './desk',
              config: './desk/connections.json',
              jobs: './desk/jobs.mjs',
              mount: '/',
              environment: { BETTER_AUTH_SECRET: 'SECRET' },
            },
          ],
        }),
      );
      return startConfiguredSuite(file, { SECRET: 'test-only-suite-timers-secret-longer-than-thirty-two' });
    };
    const read = <T>(sql: string) => {
      const handle = new DatabaseSync(database, { readOnly: true });
      try {
        return handle.prepare(sql).all() as T[];
      } finally {
        handle.close();
      }
    };
    const warned = () =>
      read<{ id: number; warned: number }>('SELECT id, warned FROM ticket ORDER BY id').map((row) => [row.id, row.warned]);
    const settled = async (done: () => boolean) => {
      const deadline = Date.now() + 10_000;
      while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    };
    const first = await serve();
    await settled(() => warned()[0][1] === 1);
    // A beat more, for anything enqueued twice to run.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await first.close();
    assert.deepEqual(
      warned(),
      [
        [1, 1],
        [2, 0],
        [3, 0],
      ],
      'the open, past-due ticket ran once, in the first sweep; the others did not',
    );
    // The third ticket falls due. A new host sweeps at once: it runs that one, and finds the fired ticket still past due and open, its instant run already.
    const write = new DatabaseSync(database);
    write.prepare('UPDATE ticket SET due_at = ? WHERE id = 3').run(minuteAgo);
    write.close();
    const second = await serve();
    t.after(() => second.close());
    await settled(() => warned()[2][1] === 1);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(
      warned(),
      [
        [1, 1],
        [2, 0],
        [3, 1],
      ],
      'a later sweep runs the same instant no more',
    );
  },
);
