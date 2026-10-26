import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import {
  createTestWorkspace,
  createTestClient,
  assertAuthorizationMatrix,
  createTestClock,
  startTestApp,
  assertPermissions,
} from '../packages/mistri/src/server/testing/index.js';

test('workspaces isolate data, reject escapes and clean up in reverse order after failures', async () => {
  const a = await createTestWorkspace(),
    b = await createTestWorkspace();
  const calls: string[] = [];
  try {
    assert.notEqual(a.directory, b.directory);
    assert.throws(() => a.path('../escape'), /inside/);
    await a.database('data.db', (db) => db.exec('CREATE TABLE note(id INTEGER PRIMARY KEY, body TEXT)'));
    a.own(() => {
      calls.push('first');
    });
    a.own(() => {
      calls.push('second');
      throw new Error('cleanup fault');
    });
    await assert.rejects(a.close(), /cleanup failed/);
    assert.deepEqual(calls, ['second', 'first']);
    assert.equal(existsSync(a.directory), false);
    await a.close();
  } finally {
    await b.close();
  }
});

test('independent session clients and authorization matrix detect an intentionally broken policy', async (t) => {
  const server = createServer((request, response) => {
    if (request.url === '/login') {
      response.setHeader('set-cookie', 'session=alice; Path=/');
      response.end('{}');
    } else {
      response.writeHead(request.headers.cookie?.includes('session=alice') ? 200 : 403);
      response.end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const alice = createTestClient(url),
    anonymous = createTestClient(url);
  await alice.request('/login');
  await assertAuthorizationMatrix([
    { name: 'signed in', client: alice, path: '/private', status: 200 },
    { name: 'anonymous forbidden', client: anonymous, path: '/private', status: 403 },
  ]);
  await assert.rejects(
    assertAuthorizationMatrix([{ name: 'broken policy', client: anonymous, path: '/private', status: 200 }]),
    /broken policy/,
  );
  await assert.rejects(alice.request('https://example.com/'), /another origin/);
});

test('fixture clock resets deterministically', () => {
  const clock = createTestClock(1000);
  assert.equal(clock.advance(250), 1250);
  clock.reset();
  assert.equal(clock.now(), 1000);
  assert.throws(() => clock.advance(-1));
});

test('public App host serves disposable SQLite and stops with its workspace', async (t) => {
  const workspace = await createTestWorkspace();
  t.after(() => workspace.close());
  const database = await workspace.database('business.db', (db) =>
    db.exec("CREATE TABLE note(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO note VALUES(1, 'test-owned');"),
  );
  await workspace.write('app/app.json', {
    id: 'test-notes',
    name: 'Test notes',
    resources: { note: {} },
    views: { notes: { kind: 'list', from: 'note' } },
    home: 'notes',
    nav: ['notes'],
  });
  const host = await startTestApp({ workspace, directory: workspace.path('app'), database });
  const response = await host.client().request('/readyz');
  assert.equal(response.status, 200, await response.text());
  await workspace.close();
  await assert.rejects(fetch(`${host.url}/readyz`));
});

/* An App bound to "shop" over a database file named shop.db: the host named the connection after the file, and the
   App had no database. Named after the App's connection, its list reads its rows. */
test("an App host names the database after the App's connection, not the file", async (t) => {
  const workspace = await createTestWorkspace();
  t.after(() => workspace.close());
  const database = await workspace.database('shop.db', (db) =>
    db.exec("CREATE TABLE note(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO note VALUES(1, 'in the shop');"),
  );
  await workspace.write('app/app.json', {
    id: 'shop-notes',
    name: 'Shop notes',
    connection: 'shop',
    resources: { note: {} },
    views: { notes: { kind: 'list', from: 'note' } },
    home: 'notes',
    nav: ['notes'],
  });
  const host = await startTestApp({ workspace, directory: workspace.path('app'), database });
  assert.match(host.logs(), /mistri: shop \(sqlite\)/);
  assert.doesNotMatch(host.logs(), /which this server does not have/);
});

/* An App that writes, over a database given without a config: it was served read-only, and a writing App refused to
   start ("requires a writable source"). It is writable now, over a copy, so the file a test was handed is untouched;
   an App that writes nothing stays read-only. */
test('an App host serves a supplied database writable when the App writes, over a copy', async (t) => {
  const outside = await createTestWorkspace();
  t.after(() => outside.close());
  const original = await outside.database('shop.db', (db) =>
    db.exec("CREATE TABLE note(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO note VALUES(1, 'as made');"),
  );
  const start = async (id: string, access: 'write' | undefined) => {
    const workspace = await createTestWorkspace();
    t.after(() => workspace.close());
    await workspace.write('app/app.json', {
      id,
      name: id,
      connection: 'shop',
      resources: { note: access ? { access } : {} },
      views: { notes: { kind: 'list', from: 'note' } },
      home: 'notes',
      nav: ['notes'],
    });
    return startTestApp({ workspace, directory: workspace.path('app'), database: original });
  };

  const writer = (await start('shop-writes', 'write')).client();
  const saved = await writer.update('note', { id: 1 }, { body: 'edited' });
  assert.ok(saved.ok, JSON.stringify(saved));
  const read = await writer.rows('note', { where: 'id = 1' });
  assert.ok(read.ok && read.value[0].body === 'edited', JSON.stringify(read));
  const file = new DatabaseSync(original, { readOnly: true });
  try {
    assert.equal(file.prepare('SELECT body FROM note WHERE id = 1').get()?.body, 'as made');
  } finally {
    file.close();
  }

  const reader = (await start('shop-reads', undefined)).client();
  const refused = await reader.update('note', { id: 1 }, { body: 'edited' });
  assert.equal(refused.ok, false, JSON.stringify(refused));
});

test('public suite fixture shares login while independent App grants remain enforced', async (t) => {
  const { startTestSuite } = await import('@mistriwork/mistri/testing');
  const workspace = await createTestWorkspace();
  t.after(() => workspace.close());
  const apps = [];
  for (const id of ['desk', 'review']) {
    const database = await workspace.database(`${id}/business.db`, (db) =>
      db.exec('CREATE TABLE note(id TEXT PRIMARY KEY, body TEXT NOT NULL)'),
    );
    await workspace.write(`${id}/app.json`, {
      id,
      name: id,
      auth: { store: workspace.path(`${id}/auth.db`), providers: ['email'], signUp: 'open', roles: { reader: { read: ['note'] } } },
      resources: { note: {} },
      views: {
        notes: { kind: 'list', from: 'note' },
        ...(id === 'desk'
          ? {
              link: {
                kind: 'dashboard',
                label: 'Review desk',
                sections: [{ kind: 'note', text: 'Review', action: { label: 'Review', to: { app: 'review', kind: 'home' } } }],
              },
            }
          : {}),
      },
      home: 'notes',
      nav: ['notes', ...(id === 'desk' ? ['link'] : [])],
    });
    const config = await workspace.write(`${id}/connections.json`, { connections: [{ name: 'data', url: database }] });
    apps.push({ id, directory: workspace.path(id), config, mount: `/${id}`, environment: { BETTER_AUTH_SECRET: 'TEST_SECRET' } });
  }
  const host = await startTestSuite({
    workspace,
    environment: { TEST_SECRET: 'test-suite-secret-longer-than-thirty-two-characters' },
    configuration: {
      apps,
      identity: { id: 'test-suite', store: './identity.db', grants: './grants.db', environment: { BETTER_AUTH_SECRET: 'TEST_SECRET' } },
    },
  });
  const alice = host.client();
  const signup = await alice.signUp({ name: 'Alice', email: 'alice@example.test', password: 'a-long-test-password' });
  const account = (await signup.json()) as { user: { id: string } };
  const path = '/api/suite/links/resolve';
  const request = {
    method: 'POST',
    headers: { 'x-mistri-account': account.user.id },
    json: { sourceApp: 'desk', target: { app: 'review', kind: 'home' } },
  };
  await assertAuthorizationMatrix([{ name: 'no implicit cross-App access', client: alice, path, request, status: 404 }]);
  await host.grant({ appId: 'desk', subjectId: account.user.id, roles: ['reader'], expectedRevision: 0 });
  await host.grant({ appId: 'review', subjectId: account.user.id, roles: ['reader'], expectedRevision: 0 });
  await assertAuthorizationMatrix([{ name: 'explicit target grant', client: alice, path, request, status: 200 }]);
  await host.grant({ appId: 'review', subjectId: account.user.id, roles: [], expectedRevision: 1 });
  await assertAuthorizationMatrix([{ name: 'revocation takes effect', client: alice, path, request, status: 404 }]);
});

test('isolated child TCP guard records a caught external call for teardown', async (t) => {
  const workspace = await createTestWorkspace();
  t.after(() => workspace.close());
  const { spawn } = await import('node:child_process');
  const guard = new URL('../packages/mistri/src/server/testing/networkGuard.ts', import.meta.url);
  const child = spawn(
    process.execPath,
    [
      '--import',
      guard.href,
      '--input-type=module',
      '-e',
      "import net from 'node:net'; import https from 'node:https'; try { net.connect(443, 'example.invalid'); } catch {} await new Promise(resolve => { try { https.get('https://example.invalid').on('error', resolve); } catch { resolve(); } }); try { await fetch('https://example.invalid'); } catch {}",
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  await once(child, 'exit');
  assert.match(output, /mistri-test-network-denied/);
  assert.match(output, /example.invalid/);
  assert.equal(output.split('[mistri-test-network-denied]').length - 1, 3, 'net, https and fetch are guarded');
});

test('network denial remains fatal after later output exceeds the log buffer', async (t) => {
  const workspace = await createTestWorkspace();
  t.after(() => workspace.close());
  const database = await workspace.database('business.db', (db) => db.exec('CREATE TABLE note(id INTEGER PRIMARY KEY, body TEXT)'));
  await workspace.write('app/app.json', {
    id: 'denied-network',
    name: 'Network test',
    resources: { note: {} },
    views: { notes: { kind: 'list', from: 'note' } },
    home: 'notes',
    nav: ['notes'],
  });
  await workspace.write(
    'app/commands.mjs',
    "import net from 'node:net'; try { net.connect(443, 'example.invalid'); } catch {} process.stderr.write('x'.repeat(70000)); export default {};\n",
  );
  await assert.rejects(
    startTestApp({ workspace, directory: workspace.path('app'), database }),
    /Isolated App attempted an unexpected outbound connection/,
  );
});

test('validation maintenance also rejects caught outbound calls', async (t) => {
  const { validateTestApp } = await import('@mistriwork/mistri/testing');
  const workspace = await createTestWorkspace();
  t.after(() => workspace.close());
  await workspace.write('app/app.json', {
    id: 'validation-network',
    name: 'Validation',
    resources: { note: {} },
    views: { notes: { kind: 'list', from: 'note' } },
    home: 'notes',
    nav: ['notes'],
  });
  await workspace.write(
    'app/commands.mjs',
    "import net from 'node:net'; try { net.connect(443, 'example.invalid'); } catch {} export default {};\n",
  );
  await assert.rejects(validateTestApp(workspace.path('app')), /Test maintenance attempted an unexpected outbound connection/);
});

/* Arranging rows went through the HTTP API, under a role's grants, or through raw SQL beside the server. `seed` is
   the test's setup: inserted in one transaction, returned as stored with their ids, and refused to anyone but the
   test host that started the server. */
test('a test host seeds rows as setup, returned with their ids, and no one else can', async (t) => {
  const workspace = await createTestWorkspace();
  t.after(() => workspace.close());
  const database = await workspace.database('business.db', (db) =>
    db.exec("CREATE TABLE note(id INTEGER PRIMARY KEY, body TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'plain')"),
  );
  await workspace.write('app/app.json', {
    id: 'seeded-notes',
    name: 'Seeded notes',
    resources: { note: {} },
    views: { notes: { kind: 'list', from: 'note' } },
    home: 'notes',
    nav: ['notes'],
  });
  const host = await startTestApp({ workspace, directory: workspace.path('app'), database });

  const one = await host.seed('note', { body: 'first' });
  assert.deepEqual(one, { id: 1, body: 'first', kind: 'plain' });
  const many = await host.seed('note', [{ body: 'second' }, { body: 'third', kind: 'pinned' }]);
  assert.deepEqual(
    many.map((row) => [row.id, row.kind]),
    [
      [2, 'plain'],
      [3, 'pinned'],
    ],
  );
  const read = await host.client().rows('note', { limit: 10 });
  assert.ok(read.ok && read.value.length === 3, JSON.stringify(read));

  // Whole or not at all: a row the database refuses leaves the rows before it out too.
  await assert.rejects(host.seed('note', [{ body: 'fourth' }, { body: null }]), /NOT NULL|null/i);
  await assert.rejects(host.seed('nowhere', { body: 'x' }), /No table called "nowhere"/);
  const kept = await host.client().rows('note', { limit: 10 });
  assert.ok(kept.ok && kept.value.length === 3, JSON.stringify(kept));

  // The route is the test host's alone: without its token it is no route at all.
  const stranger = await fetch(`${host.url}/api/test/seed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mistri-test-control': 'f'.repeat(64) },
    body: JSON.stringify({ table: 'note', rows: [{ body: 'smuggled' }] }),
  });
  assert.notEqual(stranger.status, 200);
  const after = await host.client().rows('note', { where: "body = 'smuggled'" });
  assert.ok(after.ok && after.value.length === 0);
});

/* `args: ['--commands', 'commands.mjs']` was read from the workspace the process runs in, not the App beside it. */
test("a relative module path in args is the App directory's", async (t) => {
  const workspace = await createTestWorkspace();
  t.after(() => workspace.close());
  const database = await workspace.database('business.db', (db) => db.exec('CREATE TABLE note(id INTEGER PRIMARY KEY, body TEXT)'));
  await workspace.write('app/app.json', {
    id: 'relative-args',
    name: 'Relative args',
    resources: { note: {} },
    views: { notes: { kind: 'list', from: 'note' } },
    home: 'notes',
    nav: ['notes'],
  });
  // Found and run: the module says so as it loads, where one never found would be a missing file.
  await workspace.write('app/server/commands.mjs', "process.stderr.write('read from beside app.json\\n');\nexport default {};\n");
  await assert.rejects(
    startTestApp({ workspace, directory: workspace.path('app'), database, args: ['--commands', 'server/commands.mjs'] }),
    /read from beside app\.json/,
  );
});

/* A --commands, --jobs or --policy module that did not load was "Test host failed to become ready" over a page of
   log, and the commands module's own line said only "could not be loaded": the test now says the module's error first. */
test("a test host that cannot load the App's module says the module's own error first", async (t) => {
  const app = (rows?: 'policy') => ({
    id: 'modules',
    name: 'Modules',
    sources: { main: { connection: 'main', default: true } },
    auth: { ...(rows ? { rows } : {}), roles: { staff: { read: true } } },
    resources: { note: {} },
    views: { notes: { kind: 'list', from: 'note' } },
    home: 'notes',
    nav: ['notes'],
  });
  const cases = [
    { flag: '--commands', file: "import './helper-never-written.mjs';\nexport default {};\n", said: /helper-never-written\.mjs/ },
    { flag: '--jobs', file: "throw new Error('JOBS_KEY is not set');\n", said: /JOBS_KEY is not set \(module\.mjs:1\)/, commands: true },
    {
      flag: '--policy',
      file: "throw new Error('POLICY_KEY is not set');\n",
      said: /POLICY_KEY is not set \(module\.mjs:1\)/,
      rows: 'policy' as const,
    },
  ];
  for (const { flag, file, said, commands, rows } of cases) {
    const workspace = await createTestWorkspace();
    t.after(() => workspace.close());
    const database = await workspace.database('main.db', (db) => db.exec('CREATE TABLE note(id INTEGER PRIMARY KEY, body TEXT)'));
    await workspace.write('app/app.json', app(rows));
    await workspace.write('app/module.mjs', file);
    if (commands) await workspace.write('app/commands.mjs', 'export default {};\n');
    const kind = flag.slice(2);
    await assert.rejects(
      startTestApp({
        workspace,
        directory: workspace.path('app'),
        database,
        args: [...(commands ? ['--commands', 'commands.mjs'] : []), flag, 'module.mjs'],
      }),
      (error: Error) => {
        const [first] = error.message.split('\n');
        assert.match(first, new RegExp(`^The App did not start: The ${kind} module "module\\.mjs" did not load: `));
        assert.match(first, said);
        return true;
      },
    );
  }
});

/* The in-App assistant had no model in a test but the network's. A script replays its turns: text and tool calls. */
test('a test host scripts the assistant model', async (t) => {
  const { provisionSqliteAssistant } = await import('../packages/mistri/src/adapters/assistant/sqliteAssistant.js');
  const workspace = await createTestWorkspace();
  t.after(() => workspace.close());
  const database = await workspace.database('business.db', (db) =>
    db.exec("CREATE TABLE lead(id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO lead VALUES (1, 'Acme'), (2, 'Globex');"),
  );
  provisionSqliteAssistant(database);
  await workspace.write('app/app.json', {
    id: 'scripted-assistant',
    name: 'Scripted assistant',
    resources: { lead: {} },
    auth: { roles: { rep: { read: true } } },
    views: { leads: { kind: 'list', from: 'lead' } },
    home: 'leads',
    nav: ['leads'],
    assistant: {},
  });
  const host = await startTestApp({
    workspace,
    directory: workspace.path('app'),
    database,
    assistant: {
      turns: [
        {
          when: 'how many leads',
          steps: [{ tools: [{ name: 'query', input: { q: 'lead' } }] }, { text: 'You have two leads.' }],
        },
      ],
    },
  });
  const rep = await host.as('rep');
  const answer = await rep.request('/api/assistant/turn', { method: 'POST', json: { app: 'scripted-assistant', text: 'How many leads?' } });
  const stream = await answer.text();
  assert.equal(answer.status, 200, stream);
  // The scripted tool call ran as the person's read, and the scripted words came after it.
  assert.match(stream, /event: step\ndata: .*"Read lead: 2 rows"/);
  const said = [...stream.matchAll(/event: text\ndata: (.*)/g)].map((match) => (JSON.parse(match[1]) as { delta: string }).delta).join('');
  assert.equal(said, 'You have two leads.');
});

/* A table a role may not read is not in its catalog: a query naming it is answered as one naming no table (200,
   "No table called …"), which says nothing of whether it is there. The matrix expected 403 and failed every refused
   read; it reads the refusal as the server gives it, and a wrong row still fails. */
test('a permissions matrix reads a refused read as a table the role cannot see', async (t) => {
  const workspace = await createTestWorkspace();
  t.after(() => workspace.close());
  const database = await workspace.database('business.db', (db) =>
    db.exec(
      "CREATE TABLE note(id INTEGER PRIMARY KEY, body TEXT); CREATE TABLE salary(id INTEGER PRIMARY KEY, amount INTEGER); INSERT INTO note VALUES (1, 'n'); INSERT INTO salary VALUES (1, 100);",
    ),
  );
  await workspace.write('app/app.json', {
    id: 'hidden-tables',
    name: 'Hidden tables',
    resources: { note: { access: 'write' }, salary: { access: 'write' } },
    auth: { roles: { clerk: { read: ['note'] }, auditor: { read: ['note', 'salary'] } } },
    views: { notes: { kind: 'list', from: 'note' } },
    home: 'notes',
    nav: ['notes'],
  });
  const host = await startTestApp({ workspace, directory: workspace.path('app'), database });
  // The refusal is the one a table that does not exist gets: nothing tells the clerk salary is there.
  const clerk = await host.as('clerk');
  const [hidden, missing] = [await clerk.rows('salary'), await clerk.rows('nowhere')];
  assert.ok(!hidden.ok && !missing.ok);
  assert.equal(hidden.message.replace('salary', 'nowhere'), missing.message);

  await assertPermissions(host, [
    { role: 'clerk', read: 'note', allowed: true },
    { role: 'clerk', read: 'salary', allowed: false },
    { role: 'clerk', write: 'salary', allowed: false },
    { role: null, read: 'salary', allowed: false },
  ]);
  /* With a role that reads salary, the refused write is tried on its record: a column the clerk is not shown. */
  await assertPermissions(host, [
    { role: 'auditor', read: 'salary', allowed: true },
    { role: 'clerk', write: 'salary', allowed: false },
  ]);
  await assert.rejects(assertPermissions(host, [{ role: 'clerk', read: 'salary', allowed: true }]), /clerk may read salary: refused/);
});
