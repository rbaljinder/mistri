import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scratch } from './support/scratch.js';
import { VALIDATE, validating } from './support/validation.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'packages/mistri/src/server/index.ts');
const appId = 'policy-cli';
const deadline = 15_000;
/** mistri's refusal of a start that is the database browser's. */
const BROWSERS = /is the database browser's, a command of its own: npx tablewalk/;

function fixture(t: TestContext) {
  const { directory, stopping } = scratch(t, 'tablewalk-policy-cli-');
  const app = join(directory, 'app');
  mkdirSync(app);
  const config = join(directory, 'mistri.json');
  const authStore = join(directory, 'sessions.db');
  const module = join(directory, 'private-policy.mjs');
  const loaded = join(directory, 'module-loaded');
  const invoked = join(directory, 'resolver-invoked');
  const commandsLoaded = join(directory, 'commands-loaded');
  const commands = join(directory, 'commands.mjs');
  const data = join(directory, 'ops.db');
  const stock = join(directory, 'stock.db');
  for (const [file, table] of [
    [data, 'ticket'],
    [stock, 'asset'],
  ]) {
    const db = new DatabaseSync(file);
    try {
      db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO ${table} VALUES (1, 'fixture-only');`);
    } finally {
      db.close();
    }
  }
  const connections = [
    { name: 'ops', url: data },
    { name: 'stock', url: stock },
    { name: 'unrelated', url: join(directory, 'unavailable-unrelated.db') },
    // Open sign-up needs something to prove an address with (open-sign-up-unproven); development mail is enough.
    { name: 'mail', kind: 'email', url: 'log:', from: 'Policy <no-reply@example.test>' },
  ];
  const manifest = {
    id: appId,
    name: 'Policy CLI',
    auth: { store: authStore, signUp: 'open', defaultRole: 'user', rows: 'policy', roles: { user: { read: true } } } as Record<
      string,
      unknown
    >,
    sources: { operations: { connection: 'ops', default: true }, inventory: { connection: 'stock' } },
    resources: { ticket: {}, 'inventory.asset': {} } as Record<string, Record<string, unknown>>,
    views: { ticket: { kind: 'list', from: 'ticket' }, asset: { kind: 'list', from: 'inventory.asset' } },
    home: 'ticket',
    nav: ['ticket', 'asset'],
  };
  const save = (value: unknown = manifest) => writeFileSync(join(app, 'app.json'), JSON.stringify(value));
  save();
  writeFileSync(config, JSON.stringify({ connections }));
  const policy = (resolver = `return { ticket: true, 'inventory.asset': true };`) => `
    import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(loaded)}, 'loaded');
    export default { appId: ${JSON.stringify(appId)}, resolveRows(principal) {
      writeFileSync(${JSON.stringify(invoked)}, JSON.stringify(principal));
      ${resolver}
    } };
  `;
  writeFileSync(module, policy());
  writeFileSync(
    commands,
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(commandsLoaded)}, 'loaded'); throw new Error('command module must not run');`,
  );
  const env = {
    ...process.env,
    DATABASE_URL: '',
    MISTRI_OPEN: '0',
    MISTRI_PUBLIC_URL: '',
    BETTER_AUTH_SECRET: '',
    MISTRI_AUTH_ADMIN_EMAIL: '',
    MISTRI_AUTH_ADMIN_PASSWORD: '',
    MISTRI_DIAGNOSTICS: '',
    XDG_CONFIG_HOME: join(directory, 'xdg'),
  };
  return {
    directory,
    stopping,
    app,
    config,
    authStore,
    module,
    loaded,
    invoked,
    commandsLoaded,
    commands,
    data,
    stock,
    connections,
    manifest,
    save,
    policy,
    env,
  };
}
type Fixture = ReturnType<typeof fixture>;

function cli(f: Fixture, args: string[], explicitApp = true) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((done, reject) => {
    const run = validating(args, f.env);
    execFile(
      process.execPath,
      ['--import', 'tsx', entry, '--config', f.config, ...(explicitApp ? ['--app', f.app] : []), ...run.args],
      {
        cwd: root,
        env: run.env,
        timeout: deadline,
        killSignal: 'SIGKILL',
      },
      (error, stdout, stderr) => {
        if (error?.killed) {
          reject(new Error(`CLI timed out: ${args.join(' ')}\n${stdout}\n${stderr}`));
          return;
        }
        done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
      },
    );
  });
}

function noExecution(f: Fixture) {
  assert.equal(existsSync(f.authStore), false, 'validation must not create/migrate an auth store');
  assert.equal(existsSync(f.invoked), false, 'startup must not resolve a principal or execute policy logic');
  assert.equal(existsSync(f.commandsLoaded), false, 'startup must not import commands');
}

for (const [name, args] of [
  ['HTTP', []],
  ['check', [VALIDATE]],
  ['lint', ['--lint', 'json']],
  ['diff', ['--diff', 'stock']],
  ['MCP', ['--mcp']],
] as const) {
  test(`policy CLI: enrollment without --policy fails before ${name}`, { timeout: 20_000 }, async (t) => {
    const f = fixture(t);
    const result = await cli(f, [...args]);
    // Lint, diff and MCP are the database browser's: mistri names that command before it reads the App.
    const browsers = name === 'lint' || name === 'diff' || name === 'MCP';
    assert.equal(result.code, browsers ? 2 : 1, result.stderr);
    assert.match(result.stderr, browsers ? BROWSERS : /Policy startup error:.*--policy.*explicit.*--app/);
    if (name !== 'HTTP') assert.equal(result.stdout, '', 'no schema, lint, diff, check or MCP payload may escape');
    assert.doesNotMatch(result.stdout + result.stderr, /Listening on|speaking MCP|Policy CLI: ok/);
    assert.equal(existsSync(f.loaded), false);
    noExecution(f);
  });
}

test('policy CLI: types export opens only declared App schemas, without private runtime modules', { timeout: 20_000 }, async (t) => {
  const f = fixture(t);
  const before = { data: readFileSync(f.data), stock: readFileSync(f.stock) };
  const result = await cli(f, ['--export', 'types']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /ticket: "id" \| "name"/);
  assert.match(result.stdout, /"inventory\.asset": "id" \| "name"/);
  assert.doesNotMatch(result.stdout, /fixture-only/);
  assert.equal(existsSync(f.loaded), false, 'type generation must not import the private policy');
  assert.equal(existsSync(join(f.directory, 'unavailable-unrelated.db')), false, 'only App-declared sources may be opened');
  assert.deepEqual(readFileSync(f.data), before.data);
  assert.deepEqual(readFileSync(f.stock), before.stock);
  noExecution(f);
});

test('policy CLI: offline types need exactly one explicit App', { timeout: 20_000 }, async (t) => {
  const f = fixture(t);
  writeFileSync(f.config, JSON.stringify({ connections: f.connections, apps: [f.app] }));
  const configured = await cli(f, ['--export', 'types'], false);
  assert.equal(configured.code, 1, configured.stderr);
  assert.match(configured.stderr, /Policy startup error:.*exactly one explicit.*--app/);
  assert.equal(configured.stdout, '');
  noExecution(f);

  writeFileSync(f.config, JSON.stringify({ connections: [...f.connections, { name: 'other', url: f.stock }] }));
  const other = join(f.directory, 'other', 'app.json');
  mkdirSync(dirname(other), { recursive: true });
  writeFileSync(
    other,
    JSON.stringify({
      id: 'other',
      name: 'Other',
      connection: 'other',
      resources: { asset: {} },
      views: { asset: { kind: 'list', from: 'asset' } },
      home: 'asset',
    }),
  );
  const multiple = await cli(f, ['--export', 'types', '--app', other]);
  assert.equal(multiple.code, 1, multiple.stderr);
  assert.match(multiple.stderr, /Policy startup error:.*exactly one explicit.*--app/);
  assert.equal(multiple.stdout, '');
  noExecution(f);
});

test('policy CLI: missing/duplicate values and unsupported modes fail before importing modules', { timeout: 30_000 }, async (t) => {
  const f = fixture(t);
  for (const args of [
    ['--policy'],
    ['--policy', VALIDATE],
    ['--policy', f.module, '--policy', f.module],
    ...[['--export', 'types'], ['--lint'], ['--diff', 'stock'], ['--mcp']].map((mode) => ['--policy', f.module, ...mode]),
  ]) {
    const result = await cli(f, args);
    const browsers = args.some((arg) => arg === '--lint' || arg === '--diff' || arg === '--mcp');
    assert.equal(result.code, browsers ? 2 : 1, `${args.join(' ')}\n${result.stderr}`);
    assert.match(result.stderr, browsers ? BROWSERS : /--policy/);
    assert.equal(result.stdout, '');
    assert.equal(existsSync(f.loaded), false);
    noExecution(f);
  }
});

test('policy CLI: exactly one explicit App is required, including when config declares Apps', { timeout: 30_000 }, async (t) => {
  const f = fixture(t);
  const args = ['--policy', f.module, VALIDATE];
  for (const apps of [[], [f.app]]) {
    writeFileSync(f.config, JSON.stringify({ connections: f.connections, apps }));
    const result = await cli(f, args, false);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /exactly one explicit.*--app/);
  }
  writeFileSync(f.config, JSON.stringify({ connections: f.connections }));
  const other = join(f.directory, 'other', 'app.json');
  mkdirSync(dirname(other), { recursive: true });
  writeFileSync(
    other,
    JSON.stringify({
      id: 'other',
      name: 'Other',
      connection: 'unrelated',
      resources: { ticket: {} },
      views: { ticket: { kind: 'list', from: 'ticket' } },
      home: 'ticket',
    }),
  );
  const multiple = await cli(f, [...args, '--app', other]);
  assert.equal(multiple.code, 1, multiple.stderr);
  assert.match(multiple.stderr, /exactly one explicit.*--app/);
  assert.equal(existsSync(f.loaded), false);
  noExecution(f);
});

test('policy CLI: public startup rejects unenrolled Apps and commands without a registry', { timeout: 30_000 }, async (t) => {
  const f = fixture(t);
  for (const auth of [
    { ...f.manifest.auth, rows: undefined },
    { ...f.manifest.auth, roles: { user: { read: true, commands: ['assign'] } } },
  ]) {
    f.save({ ...f.manifest, auth });
    const result = await cli(f, ['--policy', f.module, VALIDATE]);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /Policy startup error/);
    assert.equal(existsSync(f.loaded), false);
    noExecution(f);
  }
});

test('policy CLI: generic write grants reach source validation and refuse read-only connections', { timeout: 20_000 }, async (t) => {
  const f = fixture(t);
  f.save({
    ...f.manifest,
    resources: { ...f.manifest.resources, ticket: { access: 'write' } },
    auth: { ...f.manifest.auth, roles: { user: { read: true, write: true } } },
  });
  const before = readFileSync(f.data);
  const result = await cli(f, ['--policy', f.module, VALIDATE]);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /App error: /);
  assert.equal(existsSync(f.loaded), true, 'generic grants must reach policy/source validation');
  assert.deepEqual(readFileSync(f.data), before);
  noExecution(f);
});

for (const existingStore of [false, true]) {
  test(
    `policy CLI: mistri check loads policy and all sources without auth migration (${existingStore ? 'existing' : 'absent'} store)`,
    { timeout: 20_000 },
    async (t) => {
      const f = fixture(t);
      if (existingStore) {
        const db = new DatabaseSync(f.authStore);
        try {
          db.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('unchanged');");
        } finally {
          db.close();
        }
      }
      const before = existingStore ? readFileSync(f.authStore) : undefined;
      // Check mode must acquire the App sources independently of the active connection.
      writeFileSync(f.config, JSON.stringify({ connections: [f.connections[2], ...f.connections.slice(0, 2), f.connections[3]] }));
      writeFileSync(f.module, f.policy(`throw new Error('resolver must not execute during check');`));
      const result = await cli(f, ['--policy', f.module, VALIDATE]);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /Policy CLI: ok/);
      assert.equal(existsSync(f.loaded), true, 'the trusted module was actually loaded');
      assert.equal(existsSync(f.invoked), false);
      assert.equal(existsSync(f.commandsLoaded), false);
      assert.doesNotMatch(result.stdout + result.stderr, /Listening on|signs people in|created the admin/);
      if (before) assert.deepEqual(readFileSync(f.authStore), before, 'existing auth SQLite must remain byte-for-byte unchanged');
      else noExecution(f);
    },
  );
}

test('policy CLI: mistri check refuses missing, malformed and mismatched policy modules', { timeout: 30_000 }, async (t) => {
  const f = fixture(t);
  const missing = await cli(f, ['--policy', join(f.directory, 'missing.mjs'), VALIDATE]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Policy startup error/);
  for (const source of [
    `throw new Error('private-module-secret');`,
    'export default ???',
    `export default { appId: 'wrong-app', resolveRows: () => ({}) };`,
    `export default { appId: '${appId}', resolveRows: true };`,
  ]) {
    writeFileSync(f.module, source);
    const result = await cli(f, ['--policy', f.module, VALIDATE]);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /Policy startup error/);
    assert.doesNotMatch(result.stdout + result.stderr, /Policy CLI: ok/);
    noExecution(f);
  }
});

test('policy CLI: mistri check validates secondary source acquisition and resource grants', { timeout: 25_000 }, async (t) => {
  const f = fixture(t);
  writeFileSync(
    f.config,
    JSON.stringify({
      connections: f.connections.map((connection) =>
        connection.name === 'stock' ? { ...connection, url: join(f.directory, 'missing-stock.db') } : connection,
      ),
    }),
  );
  const unavailable = await cli(f, ['--policy', f.module, VALIDATE]);
  assert.equal(unavailable.code, 1, unavailable.stdout + unavailable.stderr);
  assert.match(unavailable.stderr, /App error: /);
  assert.equal(existsSync(f.loaded), true);
  writeFileSync(f.config, JSON.stringify({ connections: f.connections }));
  f.save({ ...f.manifest, resources: { ...f.manifest.resources, 'inventory.missing': {} } });
  const invalid = await cli(f, ['--policy', f.module, VALIDATE]);
  assert.equal(invalid.code, 1, invalid.stdout + invalid.stderr);
  assert.match(invalid.stderr, /App error: /);
  noExecution(f);
});

async function eventually(check: () => boolean | Promise<boolean>, message: string, timeout = 5000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return;
    await delay(40);
  }
  assert.fail(message);
}

async function live(f: Fixture, options: { signIn?: boolean; withoutPolicy?: boolean } = {}) {
  // Reserve an OS-assigned port briefly; never use a shared preview port.
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((done, reject) => reservation.close((error) => (error ? reject(error) : done())));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      entry,
      '--config',
      f.config,
      '--app',
      f.app,
      ...(options.withoutPolicy ? [] : ['--policy', f.module]),
      '--port',
      String(port),
    ],
    {
      cwd: root,
      env: { ...f.env, BETTER_AUTH_SECRET: 'policy-cli-fixture-secret-at-least-32-characters', MISTRI_PUBLIC_URL: origin },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => done({ code, signal }));
  });
  let stopping = false;
  const terminate = () => {
    if (!stopping && child.exitCode === null && child.signalCode === null) {
      stopping = true;
      child.kill('SIGTERM');
    }
  };
  const stop = async () => {
    terminate();
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      return await exited;
    } finally {
      clearTimeout(force);
    }
  };
  // A case that fails before its own stop still stops the child before the directory goes.
  f.stopping(stop);
  const call = async (path: string, cookie = '', body?: object) => {
    const response = await fetch(origin + path, {
      method: body ? 'POST' : 'GET',
      signal: AbortSignal.timeout(8000),
      headers: { origin, cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: response.status,
      text: await response.text(),
      cookie: response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; '),
    };
  };
  try {
    await eventually(
      () => {
        assert.equal(child.exitCode, null, output);
        assert.equal(child.signalCode, null, output);
        return output.includes('Listening on');
      },
      'CLI never listened',
      deadline,
    );
    assert.equal(existsSync(f.authStore), true, 'live auth must use the fresh explicit store');
    if (!options.signIn) assert.equal(existsSync(f.invoked), false, 'live startup must not run a resolver');
    const signup = await call(options.signIn ? '/api/auth/sign-in/email' : '/api/auth/sign-up/email', '', {
      name: 'Policy reader',
      email: 'reader@example.org',
      password: 'fixture-password-123',
    });
    assert.equal(signup.status, 200, signup.text + output);
    assert.match(signup.cookie, /mistri-[A-Za-z0-9_-]+\.session_token=/);
    return { child, exited, terminate, stop, call, cookie: signup.cookie, output: () => output };
  } catch (error) {
    await stop();
    throw error;
  }
}

/* A row-policy App used to refuse its data after any save until the server
   restarted, and the page said it "could not connect to its database". It
   reloads like any App now: refused from the save until its policy has
   started again for the new App, never the old policy beside the new App. */
for (const change of ['valid manifest', 'invalid manifest'] as const) {
  test(`policy CLI: a ${change} save reloads the App and starts its row policy again`, { timeout: 30_000 }, async (t) => {
    const f = fixture(t);
    const server = await live(f);
    try {
      assert.equal((await server.call(`/api/schema?app=${appId}`, server.cookie)).status, 200);
      const reloaded = () => server.output().includes('its row policy started again');
      // Saving again covers the platform's asynchronous fs.watch subscription.
      for (let attempt = 0; attempt < 3 && !reloaded() && !server.output().includes('did not load'); attempt++) {
        if (change === 'valid manifest') f.save({ ...f.manifest, name: 'Changed policy App' });
        else writeFileSync(join(f.app, 'app.json'), '{ invalid edited file');
        await delay(350);
      }
      if (change === 'invalid manifest') {
        await eventually(() => server.output().includes('Its data is refused until the next good save'), server.output());
        const refused = await server.call('/api/schema', server.cookie);
        assert.equal(refused.status, 503, refused.text);
        assert.match(refused.text, /The App changed, and the change did not load/);
        assert.doesNotMatch(refused.text, /app\.json|invalid edited/);
        f.save();
      }
      await eventually(reloaded, server.output(), 10_000);
      await eventually(async () => (await server.call('/api/schema', server.cookie)).status === 200, server.output());
      const app = await server.call('/api/app', server.cookie);
      assert.equal(app.status, 200, app.text);
      if (change === 'valid manifest') assert.match(app.text, /Changed policy App/);
      assert.doesNotMatch(server.output(), /until the server restarts|could not connect/);
    } finally {
      assert.deepEqual(await server.stop(), { code: 0, signal: null }, server.output());
    }
  });
}

/* Any save in the App folder once reloaded the App and restarted its policy, so a log redirected into the folder
   reloaded it in a loop. A file the App never read is not a change to it now: the policy keeps running, the data
   keeps answering, and nothing is said. */
test('policy CLI: a save to a file the App never read leaves the App and its row policy running', { timeout: 30_000 }, async (t) => {
  const f = fixture(t);
  const server = await live(f);
  try {
    assert.equal((await server.call(`/api/schema?app=${appId}`, server.cookie)).status, 200);
    // Saving several times over a second covers the platform's asynchronous fs.watch subscription and the debounce.
    for (let attempt = 0; attempt < 3; attempt++) {
      writeFileSync(join(f.app, 'unrelated.txt'), `{ invalid edited file ${attempt}`);
      await delay(350);
    }
    await delay(500);
    assert.doesNotMatch(server.output(), /its row policy started again|did not load|Its data is refused/);
    assert.equal((await server.call('/api/schema', server.cookie)).status, 200, server.output());
  } finally {
    assert.deepEqual(await server.stop(), { code: 0, signal: null }, server.output());
  }
});

/* Node imports a module once: the policy's own code cannot reload, so a save
   to it is refused plainly, in the terminal and to the page, until a restart. */
test(
  'policy CLI: a save to the row policy module itself asks for a restart, in the terminal and on the page',
  { timeout: 30_000 },
  async (t) => {
    const f = fixture(t);
    const inside = join(f.app, 'policy.mjs');
    writeFileSync(inside, f.policy());
    f.module = inside;
    const server = await live(f);
    try {
      assert.equal((await server.call('/api/schema', server.cookie)).status, 200);
      for (let attempt = 0; attempt < 3 && !server.output().includes('read once, at startup'); attempt++) {
        writeFileSync(inside, f.policy(`return { ticket: true, 'inventory.asset': false };`) + `\n// edit ${attempt}`);
        await delay(350);
      }
      await eventually(
        () => server.output().includes('policy.mjs changed. A row policy and its commands are read once, at startup: restart the server'),
        server.output(),
      );
      const refused = await server.call('/api/schema', server.cookie);
      assert.equal(refused.status, 503);
      assert.match(refused.text, /read once, at startup: restart the server to apply the change/);
    } finally {
      assert.deepEqual(await server.stop(), { code: 0, signal: null }, server.output());
    }
  },
);

/* A row-policy App answered 503 after any save until a restart (Keystone
   customer and dealer), with the reason only in the log. A save to the App's
   own definition reloads it under the policy already running; only a save to
   the policy or commands module asks for a restart. */
test(
  'policy CLI: a save to the App definition reloads it under its row policy, and the data keeps answering',
  { timeout: 30_000 },
  async (t) => {
    const f = fixture(t);
    const server = await live(f);
    try {
      assert.equal((await server.call('/api/schema', server.cookie)).status, 200);
      const renamed = { ...f.manifest, name: 'Policy CLI renamed' };
      const reloaded = async () => (await server.call('/api/app', server.cookie)).text.includes('Policy CLI renamed');
      for (let attempt = 0; attempt < 3 && !(await reloaded()); attempt++) {
        f.save(renamed);
        await delay(350);
      }
      await eventually(reloaded, server.output());
      for (const path of ['/api/schema', '/api/app', '/api/runtime']) {
        const response = await server.call(path, server.cookie);
        assert.equal(response.status, 200, `${path}: ${response.text}\n${server.output()}`);
      }
      const rows = await server.call('/api/query', server.cookie, { table: 'ticket', limit: 5, offset: 0 });
      assert.equal(rows.status, 200, rows.text);
      assert.match(rows.text, /fixture-only/);
      assert.doesNotMatch(server.output(), /restart the server|refused until/);
    } finally {
      assert.deepEqual(await server.stop(), { code: 0, signal: null }, server.output());
    }
  },
);

test('policy CLI: policy module outside the App directory is only reloaded on restart', { timeout: 30_000 }, async (t) => {
  const f = fixture(t);
  const server = await live(f);
  try {
    assert.equal((await server.call('/api/schema', server.cookie)).status, 200);
    writeFileSync(f.module, `throw new Error('replacement-policy-secret');`);
    await delay(600);
    assert.equal((await server.call('/api/schema', server.cookie)).status, 200);
    assert.doesNotMatch(server.output(), /until the server restarts|replacement-policy-secret/);
  } finally {
    assert.deepEqual(await server.stop(), { code: 0, signal: null }, server.output());
  }
  const restarted = await cli(f, ['--policy', f.module, VALIDATE]);
  assert.equal(restarted.code, 1);
  assert.match(restarted.stderr, /Policy startup error/);
  assert.match(restarted.stderr, /replacement-policy-secret/);
});

test(
  "policy CLI: a refused startup says why on the operator's console, including a module's own diagnostic",
  { timeout: 30_000 },
  async (t) => {
    /* "could not be loaded or is invalid" was the whole of it: a policy for
     another App, an unknown field, a module that threw — the same sentence,
     and the author read the source to find which. */
    const f = fixture(t);
    const cases: Array<[string, RegExp]> = [
      [
        `export default { appId: 'someone-else', resolveRows() { return {}; } };`,
        /(?:Cause|because): The row policy is for App "someone-else", and this App is "policy-cli"\./,
      ],
      [
        `export default { appId: ${JSON.stringify(appId)}, resolveRows() { return {}; }, rowz: 1 };`,
        /(?:Cause|because): The row policy names "rowz", which is not one of appId, resolveRows/,
      ],
      [`export default { appId: ${JSON.stringify(appId)} };`, /(?:Cause|because): The row policy has no resolveRows function\./],
      [
        `throw new Error('replacement-policy-secret');`,
        /(?:Cause|because): The policy module "private-policy\.mjs" did not load: replacement-policy-secret/,
      ],
    ];
    for (const [source, reason] of cases) {
      writeFileSync(f.module, source);
      const result = await cli(f, ['--policy', f.module, VALIDATE]);
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, /Policy startup error: The App row policy definition could not be loaded or is invalid\./);
      assert.match(result.stderr, reason);
      // The headline's cause is said once: the same reason again on a `because:` line read as a second one.
      const cause = /Policy startup error: .* Cause: (.*)\n/.exec(result.stderr)?.[1];
      assert.ok(cause && !result.stderr.includes(`because: ${cause}\n`), result.stderr);
    }
  },
);

test(
  'policy CLI: adding enrollment to a non-policy App latches APIs unavailable after rollback and restoration',
  { timeout: 30_000 },
  async (t) => {
    const f = fixture(t);
    const ordinary = { ...f.manifest, auth: { ...f.manifest.auth, rows: undefined } };
    f.save(ordinary);
    const server = await live(f, { withoutPolicy: true });
    try {
      assert.equal((await server.call('/api/schema', server.cookie)).status, 200);
      // Starting to scope rows by policy is an authority change: the App's requests stop until a restart, and the log says what moved.
      const latched = () => /stop the server and restart[^]*\+ auth rows policy/i.test(server.output());
      for (let attempt = 0; attempt < 3 && !latched(); attempt++) {
        f.save();
        await delay(350);
      }
      await eventually(latched, server.output());
      assert.equal((await server.call('/api/schema', server.cookie)).status, 503);
      f.save(ordinary);
      await delay(350);
      for (const path of ['/api/schema', '/api/app', '/api/runtime']) {
        const response = await server.call(path, server.cookie);
        assert.equal(response.status, 503, `${path}: ${response.text}`);
      }
    } finally {
      assert.deepEqual(await server.stop(), { code: 0, signal: null }, server.output());
    }
    const restarted = await live(f, { withoutPolicy: true, signIn: true });
    try {
      assert.equal((await restarted.call('/api/schema', restarted.cookie)).status, 200);
    } finally {
      assert.deepEqual(await restarted.stop(), { code: 0, signal: null }, restarted.output());
    }
  },
);

test(
  'policy CLI: shutdown stops listening, retires and drains a pending resolver before auth and registry close',
  { timeout: 30_000 },
  async (t) => {
    const f = fixture(t);
    const events = join(f.directory, 'events');
    const release = join(f.directory, 'release');
    // Instrument only this disposable child process; production modules are untouched.
    writeFileSync(
      f.module,
      `
    import { appendFileSync, existsSync, realpathSync } from 'node:fs';
    import { Server, ServerResponse } from 'node:http';
    import { DatabaseSync } from 'node:sqlite';
    import { Registry } from ${JSON.stringify(pathToFileURL(join(root, 'packages/engine/src/server/connections.ts')).href)};
    const record = event => appendFileSync(${JSON.stringify(events)}, event + '\\n');
    let shuttingDown = false;
    const closeServer = Server.prototype.close;
    Server.prototype.close = function (...args) { shuttingDown = true; record('server.close'); return closeServer.apply(this, args); };
    const endResponse = ServerResponse.prototype.end;
    ServerResponse.prototype.end = function (...args) {
      if (shuttingDown) record('response.end');
      return endResponse.apply(this, args);
    };
    const closeDatabase = DatabaseSync.prototype.close;
    DatabaseSync.prototype.close = function (...args) {
      const file = this.prepare('PRAGMA database_list').all().find(db => db.name === 'main')?.file;
      if (file && realpathSync(file) === realpathSync(${JSON.stringify(f.authStore)})) record('auth.close');
      return closeDatabase.apply(this, args);
    };
    const closeRegistry = Registry.prototype.closeAll;
    Registry.prototype.closeAll = function (...args) { record('registry.close'); return closeRegistry.apply(this, args); };
    export default { appId: '${appId}', async resolveRows() {
      record('resolver.start');
      while (!existsSync(${JSON.stringify(release)})) await new Promise(done => setTimeout(done, 20));
      record('resolver.end');
      return { ticket: true, 'inventory.asset': true };
    } };
  `,
    );
    const trace = () => (existsSync(events) ? readFileSync(events, 'utf8').trim().split('\n') : []);
    const server = await live(f);
    try {
      const pending = server.call('/api/schema', server.cookie);
      // Attach rejection handling immediately, including if a broken shutdown drops the socket.
      const settled = pending.then(
        (response) => ({ response }),
        (error) => ({ error }),
      );
      await eventually(() => trace().includes('resolver.start'), 'request never entered the resolver');
      server.terminate();
      await eventually(() => trace().includes('server.close'), 'shutdown never stopped the HTTP listener');
      await delay(150);
      assert.equal(server.child.exitCode, null, server.output());
      assert.deepEqual(trace(), ['resolver.start', 'server.close'], 'auth and sources must stay open while a request is pending');
      writeFileSync(release, 'continue');
      const result = await settled;
      assert.ok('response' in result, 'shutdown dropped the accepted HTTP request');
      assert.equal(result.response.status, 403, result.response.text);
      assert.deepEqual(await server.stop(), { code: 0, signal: null }, server.output());
      assert.deepEqual(trace(), ['resolver.start', 'server.close', 'resolver.end', 'response.end', 'auth.close', 'registry.close']);
    } finally {
      writeFileSync(release, 'continue');
      await server.stop();
    }
  },
);

test('policy CLI: authenticated port zero refuses before creating its native auth store', async (t) => {
  const f = fixture(t);
  const result = await cli(f, ['--policy', f.module, '--port', '0']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /stable nonzero --port/);
  assert.doesNotMatch(result.stdout, /Listening on/);
  assert.equal(existsSync(f.authStore), false);
});

test('policy CLI: cleanup failure remains nonzero across repeated shutdown signals', { timeout: 30000 }, async (t) => {
  const f = fixture(t);
  writeFileSync(
    f.module,
    `
    import { Registry } from ${JSON.stringify(pathToFileURL(join(root, 'packages/engine/src/server/connections.ts')).href)};
    const close = Registry.prototype.closeAll;
    Registry.prototype.closeAll = async function (...args) {
      await close.apply(this, args);
      process.emit('SIGINT');
      throw new Error('synthetic cleanup failure');
    };
    export default { appId: '${appId}', resolveRows: () => ({ ticket: true, 'inventory.asset': true }) };
  `,
  );
  const server = await live(f);
  assert.deepEqual(await server.stop(), { code: 1, signal: null });
  assert.match(server.output(), /resources could not be closed cleanly/);
  assert.doesNotMatch(server.output(), /synthetic cleanup failure/);
});

test('policy CLI: signal during policy acquisition drains its late result before native stores close', async (t) => {
  const f = fixture(t),
    events = join(f.directory, 'startup-events');
  f.env.BETTER_AUTH_SECRET = 'synthetic-startup-secret-at-least-thirty-two-characters';
  writeFileSync(
    f.module,
    `
    import { appendFileSync, realpathSync } from 'node:fs';
    import { DatabaseSync } from 'node:sqlite';
    import { Registry } from ${JSON.stringify(pathToFileURL(join(root, 'packages/engine/src/server/connections.ts')).href)};
    const record = value => appendFileSync(${JSON.stringify(events)}, value + '\\n');
    const closeDatabase = DatabaseSync.prototype.close;
    DatabaseSync.prototype.close = function (...args) {
      const file = this.prepare('PRAGMA database_list').all().find(db => db.name === 'main')?.file;
      if (file && realpathSync(file) === realpathSync(${JSON.stringify(f.authStore)})) record('auth.close');
      return closeDatabase.apply(this, args);
    };
    const closeRegistry = Registry.prototype.closeAll;
    Registry.prototype.closeAll = function (...args) { record('registry.close'); return closeRegistry.apply(this, args); };
    record('policy.start'); process.emit('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 100));
    record('policy.finished');
    export default { appId: '${appId}', resolveRows: () => ({ ticket: true, 'inventory.asset': true }) };
  `,
  );
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const result = await cli(f, ['--policy', f.module, '--port', String(port)]);
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Listening on/);
  assert.deepEqual(readFileSync(events, 'utf8').trim().split('\n'), ['policy.start', 'policy.finished', 'auth.close', 'registry.close']);
});

test('policy CLI: acquisition failure after a shutdown signal cannot downgrade failure to success', async (t) => {
  const f = fixture(t);
  f.env.BETTER_AUTH_SECRET = 'synthetic-startup-secret-at-least-thirty-two-characters';
  writeFileSync(
    f.module,
    `
    process.emit('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 20));
    throw new Error('synthetic private startup failure');
  `,
  );
  const result = await cli(f, ['--policy', f.module, '--port', '1']);
  assert.equal(result.code, 1);
  assert.doesNotMatch(result.stdout, /Listening on/);
  assert.match(result.stderr, /synthetic private startup failure/);
});
