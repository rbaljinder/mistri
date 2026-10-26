import { namedCommands } from './support/commandCatalog.js';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { COMMAND_JOURNAL_TABLES, migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { sqliteAuditRows } from './support/commandTargets.js';
import { scratch } from './support/scratch.js';
import { VALIDATE, validating } from './support/validation.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'packages/mistri/src/server/index.ts');
const appId = 'scoped-command-cli';
const deadline = 15_000;
/* A test here starts the CLI from source under tsx several times; alone the longest takes about 15 s, and the full
   gate's parallel lane has doubled that. */
const SLOW = 60_000;
const sourceUrl = (file: string) => JSON.stringify(pathToFileURL(join(root, file)).href);

function fixture(t: TestContext, migrated = true) {
  const { directory, stopping } = scratch(t, 'tablewalk-scoped-command-cli-');
  const app = join(directory, 'app');
  mkdirSync(app);
  const config = join(directory, 'mistri.json');
  const authStore = join(directory, 'sessions.db');
  const policyFile = join(directory, 'policy.mjs');
  const commandsFile = join(directory, 'commands.mjs');
  const data = join(directory, 'operations.db');
  const events = join(directory, 'events');
  const db = new DatabaseSync(data);
  try {
    db.exec(`CREATE TABLE physical_ticket (id INTEGER PRIMARY KEY, desk INTEGER NOT NULL,
      version INTEGER NOT NULL, name TEXT NOT NULL);
      CREATE TABLE physical_note (id INTEGER PRIMARY KEY, body TEXT);
      INSERT INTO physical_ticket VALUES (1, 1, 0, 'Visible'), (2, 2, 0, 'Hidden');
      INSERT INTO physical_note VALUES (1, 'Fixture only');`);
  } finally {
    db.close();
  }
  if (migrated) migrateSqliteCommandJournal(data);
  const connections = [
    { name: 'ops', url: data, writable: true },
    // Open sign-up needs something to prove an address with (open-sign-up-unproven); development mail is enough.
    { name: 'mail', kind: 'email', url: 'log:', from: 'Policy <no-reply@example.test>' },
  ];
  writeFileSync(config, JSON.stringify({ connections }));
  const manifest = {
    id: appId,
    name: 'Scoped Commands CLI',
    track: 'receipts',
    auth: {
      store: authStore,
      signUp: 'open',
      defaultRole: 'user',
      rows: 'policy',
      roles: { user: { read: true, commands: ['rename'] } } as Record<string, unknown>,
    },
    sources: { operations: { connection: 'ops' } },
    resources: {
      ticket: {
        physical: 'physical_ticket',
        access: 'write',
        actions: {
          rename: {
            label: 'Rename',
            command: {
              id: 'rename',
              version: 1,
              target: 'ticket',
              input: { name: { label: 'Name', type: 'text' } },
            },
          },
        },
      } as Record<string, unknown> & { actions: Record<string, { label: string; command: Record<string, unknown> }> },
      note: { physical: 'physical_note', access: 'write' },
    },
    views: { ticket: { kind: 'list', from: 'ticket' }, note: { kind: 'list', from: 'note' } },
    home: 'ticket',
    nav: ['ticket', 'note'],
  };
  const save = (value: unknown = manifest) => writeFileSync(join(app, 'app.json'), JSON.stringify(namedCommands(value).app));
  save();
  const record = `import { appendFileSync } from 'node:fs';
    const record = event => appendFileSync(${JSON.stringify(events)}, event + '\\n');`;
  const policy = (references = 'resultReferences: { rename: result => { record("extractor"); return []; } },', id = appId) => `${record}
    record('policy.loaded');
    export default { appId: ${JSON.stringify(id)}, ${references}
      resolveRows(principal) {
        record('resolver');
        if (principal.appId !== ${JSON.stringify(appId)} || !principal.id) throw new Error('unverified principal');
        return { ticket: { groups: [[{ column: 'desk', op: '=', value: 1 }]] }, note: true };
      }
    };`;
  const commands = (patch = '') => `${record}
    import { defineCommand, defineCommands } from ${sourceUrl('packages/mistri/src/server/commands/businessCommands.ts')};
    import { SqliteAdapter } from ${sourceUrl('packages/engine/src/adapters/sqlite.ts')};
    import { nativeCommandsOf } from ${sourceUrl('packages/mistri/src/server/stores/commandStores.ts')};
    record('commands.loaded');
    // Fail if enrolled startup or HTTP dispatch attempts the ordinary journal path.
    SqliteAdapter.prototype.commandTransaction = async function () {
      record('ordinary.journal'); throw new Error('ordinary journal must never run');
    };
    // A member on the class answers in place of the adapter's journal (commandsOf), which this one then asks.
    SqliteAdapter.prototype.scopeCommandTransaction = function (scope, run) {
      record(Object.values(scope).every(rule => rule === false) ? 'scoped.preflight' : 'scoped.request');
      return nativeCommandsOf(this).scopeCommandTransaction(scope, run);
    };
    ${patch}
    export default defineCommands({ rename: defineCommand({ source: 'operations', target: 'ticket', read: ['ticket'], write: ['ticket'],
      // The manifest's input, declared again here only because this module is written as text.
      input: { name: { type: 'text' } },
      validate(value) { record('input'); return { name: value.name }; },
      output: { parse(value) { record('output'); return { version: value.version }; } },
      async handle(context, input) {
        record('handler');
        const ticket = context.record;
        await context.tx.update({ table: 'ticket', key: { id: ticket.id },
          expected: { version: ticket.version, name: ticket.name },
          values: { name: input.name, version: ticket.version + 1 } });
        return { version: ticket.version + 1, secret: 'private-command-output' };
      }
    }) });`;
  writeFileSync(policyFile, policy());
  writeFileSync(commandsFile, commands());
  const trace = () => (existsSync(events) ? readFileSync(events, 'utf8').trim().split('\n') : []);
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
    policyFile,
    commandsFile,
    data,
    connections,
    manifest,
    save,
    policy,
    commands,
    trace,
    env,
  };
}
type Fixture = ReturnType<typeof fixture>;

const flags = (f: Fixture) => ['--policy', f.policyFile, '--commands', f.commandsFile];
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
  assert.equal(existsSync(f.authStore), false, 'validation must not create an auth store');
  assert.deepEqual(
    f.trace().filter((event) => ['resolver', 'handler', 'input', 'output', 'extractor', 'ordinary.journal'].includes(event)),
    [],
    'startup must not run application hooks or ordinary journal validation',
  );
}
function refused(result: Awaited<ReturnType<typeof cli>>, policyDiagnostic = false) {
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /(?:Policy|Command|App) (?:startup )?error:/);
  assert.doesNotMatch(result.stdout + result.stderr, /Scoped Commands CLI: ok|Listening on|private-command-output/);
  if (!policyDiagnostic) assert.doesNotMatch(result.stdout + result.stderr, /private-module-secret|SyntaxError|ERR_MODULE_NOT_FOUND/);
}

for (const existingStore of [false, true]) {
  test(
    `scoped command CLI: mistri check validates both modules without mutations (${existingStore ? 'existing' : 'absent'} auth)`,
    { timeout: 20_000 },
    async (t) => {
      const f = fixture(t);
      // Source acquisition must follow the App, even with an unavailable active connection.
      writeFileSync(
        f.config,
        JSON.stringify({ connections: [{ name: 'unrelated', url: join(f.directory, 'missing-unrelated.db') }, ...f.connections] }),
      );
      if (existingStore) {
        const db = new DatabaseSync(f.authStore);
        try {
          db.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('unchanged');");
        } finally {
          db.close();
        }
      }
      const beforeAuth = existingStore ? readFileSync(f.authStore) : undefined;
      const beforeData = readFileSync(f.data);
      const result = await cli(f, [...flags(f), VALIDATE]);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /Scoped Commands CLI: ok/);
      assert.deepEqual(f.trace(), ['commands.loaded', 'policy.loaded', 'scoped.preflight']);
      assert.deepEqual(readFileSync(f.data), beforeData, 'check must not mutate records or journal schema/content');
      assert.doesNotMatch(result.stdout + result.stderr, /Listening on|signs people in|created the admin/);
      if (beforeAuth) assert.deepEqual(readFileSync(f.authStore), beforeAuth, 'check must not migrate an existing auth store');
      else noExecution(f);
    },
  );
}

test('scoped command CLI: a changed locked contract inspects retention with no record authority', async (t) => {
  const f = fixture(t);
  const written = await cli(f, [...flags(f), VALIDATE, '--write-authority']);
  assert.equal(written.code, 0, written.stdout + written.stderr);
  const lock = join(f.app, 'authority.lock');
  const original = readFileSync(lock, 'utf8');
  assert.match(original, /^contract rename v1 [0-9a-f]{12}$/m);
  writeFileSync(lock, original.replace(/^contract rename v1 [0-9a-f]{12}$/m, 'contract rename v1 000000000000'));
  const before = f.trace().filter((event) => event === 'scoped.preflight').length;
  const checked = await cli(f, [...flags(f), VALIDATE]);
  assert.equal(checked.code, 0, checked.stdout + checked.stderr);
  assert.equal(
    f.trace().filter((event) => event === 'scoped.preflight').length - before,
    2,
    'startup preflight and the changed-contract retention probe each deny all records',
  );
  noExecution(f);
});

test('scoped command CLI: missing flags fail before policy execution in check and HTTP modes', { timeout: SLOW }, async (t) => {
  const f = fixture(t);
  for (const mode of [[], [VALIDATE]]) {
    for (const args of [[], ['--commands', f.commandsFile], ['--policy', f.policyFile]]) {
      const result = await cli(f, [...args, ...mode]);
      refused(result);
      assert.match(result.stderr, args.includes('--commands') ? /--policy/ : /--commands/);
      assert.ok(
        f.trace().every((event) => event === 'commands.loaded'),
        'only command definitions may load while resolving the manifest',
      );
      noExecution(f);
    }
  }
});

test('scoped command CLI: one explicit App is required even with a configured App', { timeout: SLOW }, async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.app, 'commands.mjs'), f.commands());
  for (const apps of [[], [f.app]]) {
    writeFileSync(f.config, JSON.stringify({ connections: f.connections, apps }));
    const result = await cli(f, [...flags(f), VALIDATE], false);
    refused(result);
    assert.match(result.stderr, /exactly one explicit.*--app/);
  }
  writeFileSync(f.config, JSON.stringify({ connections: f.connections }));
  const other = join(f.directory, 'other.json');
  writeFileSync(
    other,
    JSON.stringify({
      id: 'other',
      name: 'Other',
      connection: 'other-source',
      views: { ticket: { kind: 'list', from: 'ticket' } },
      home: 'ticket',
    }),
  );
  refused(await cli(f, [...flags(f), '--app', other, VALIDATE]));
  assert.ok(f.trace().every((event) => event === 'commands.loaded'));
  noExecution(f);
});

test('scoped command CLI: enrollment, auth and named sources are mandatory', { timeout: SLOW }, async (t) => {
  const f = fixture(t);
  for (const manifest of [
    { ...f.manifest, auth: { ...f.manifest.auth, rows: undefined } },
    { ...f.manifest, auth: undefined },
    { ...f.manifest, sources: undefined, connection: 'ops-db' },
  ]) {
    f.save(manifest);
    refused(await cli(f, [...flags(f), VALIDATE]));
    assert.ok(f.trace().every((event) => event === 'commands.loaded'));
    noExecution(f);
  }
});

test('scoped command CLI: generic grants overlapping command writes refuse for active and inactive roles', { timeout: SLOW }, async (t) => {
  const f = fixture(t);
  for (const write of [true, ['ticket']]) {
    for (const role of ['user', 'inactive']) {
      f.save({
        ...f.manifest,
        auth: {
          ...f.manifest.auth,
          roles: {
            ...f.manifest.auth.roles,
            [role]: { read: true, commands: ['rename'], write },
          },
        },
      });
      const before = f.trace().length;
      refused(await cli(f, [...flags(f), VALIDATE]));
      assert.deepEqual(
        f.trace().slice(before),
        ['commands.loaded', 'policy.loaded'],
        'the command binder must reject overlap after enrollment and module loading',
      );
      noExecution(f);
    }
  }
});

for (const role of ['user', 'inactive']) {
  test(`scoped command CLI: unrelated generic grants validate for ${role} roles`, { timeout: 20_000 }, async (t) => {
    const f = fixture(t);
    f.save({
      ...f.manifest,
      auth: {
        ...f.manifest.auth,
        roles: {
          ...f.manifest.auth.roles,
          [role]: { read: true, commands: ['rename'], write: ['note'] },
        },
      },
    });
    const before = readFileSync(f.data);
    const result = await cli(f, [...flags(f), VALIDATE]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Scoped Commands CLI: ok/);
    assert.deepEqual(f.trace(), ['commands.loaded', 'policy.loaded', 'scoped.preflight']);
    assert.deepEqual(readFileSync(f.data), before);
    noExecution(f);
  });
}

test(
  'scoped command CLI: a server-owned revision and root field ceilings validate without exposing handler data',
  { timeout: SLOW },
  async (t) => {
    const f = fixture(t);
    // The server can prepare a command without exposing its revision column.
    f.save({
      ...f.manifest,
      auth: {
        ...f.manifest.auth,
        roles: { ...f.manifest.auth.roles, user: { read: true, commands: ['rename'], fields: { ticket: { read: ['id'] } } } },
      },
    });
    const privateRevision = await cli(f, [...flags(f), VALIDATE]);
    assert.equal(privateRevision.code, 0, privateRevision.stdout + privateRevision.stderr);
    assert.ok(f.trace().includes('policy.loaded'));
    noExecution(f);
    // A column ceiling narrows generic reads and never the handler.
    f.save({
      ...f.manifest,
      resources: { ...f.manifest.resources, ticket: { ...f.manifest.resources.ticket, fields: { read: ['id', 'version'] } } },
    });
    const checked = await cli(f, [...flags(f), VALIDATE]);
    assert.equal(checked.code, 0, checked.stdout + checked.stderr);
    noExecution(f);
  },
);

test('scoped command CLI: an unregistered command name refuses before execution', { timeout: SLOW }, async (t) => {
  const f = fixture(t);
  f.save({
    ...f.manifest,
    resources: {
      ...f.manifest.resources,
      ticket: { ...f.manifest.resources.ticket, actions: { rename: { label: 'Rename', command: 'unregistered' } } },
    },
  });
  refused(await cli(f, [...flags(f), VALIDATE]));
  noExecution(f);
});

test('scoped command CLI: policy requires exact per-command resultReferences and matching App identity', { timeout: SLOW }, async (t) => {
  const f = fixture(t);
  for (const references of [
    '',
    'resultReferences: {},',
    'resultReferences: { other: () => [] },',
    'resultReferences: { rename: () => [], extra: () => [] },',
    'resultReferences: { rename: true },',
    'resultReferences: [],',
    'resultReferences: { get rename() { record("extractor"); throw new Error("private-module-secret"); } },',
  ]) {
    writeFileSync(f.policyFile, f.policy(references));
    refused(await cli(f, [...flags(f), VALIDATE]));
    noExecution(f);
  }
  writeFileSync(f.policyFile, f.policy(undefined, 'another-app'));
  refused(await cli(f, [...flags(f), VALIDATE]));
  noExecution(f);
});

test(
  'scoped command CLI: missing and malformed modules fail closed, with their diagnostics only in the operator console',
  { timeout: SLOW },
  async (t) => {
    const f = fixture(t);
    /* The operator's console is where a module's own failure is said (businessCommandLoader.ts, as a row policy's
       is): the fixed sentence alone sent authors to bisect a module the loader had read. A page never sees it. */
    const said = (result: Awaited<ReturnType<typeof cli>>, file: string) => {
      refused(result, true);
      if (file === f.commandsFile) assert.match(result.stderr, /Cause: The commands module "[^"]+" did not load: /);
    };
    for (const file of [f.policyFile, f.commandsFile]) {
      const original = readFileSync(file, 'utf8');
      for (const source of ['export default ???', 'export default {};', "throw new Error('private-module-secret');"]) {
        writeFileSync(file, source);
        const result = await cli(f, [...flags(f), VALIDATE]);
        if (source === 'export default {};') refused(result, file === f.policyFile);
        else said(result, file);
        noExecution(f);
      }
      writeFileSync(file, original);
      const args = flags(f).map((value) => (value === file ? join(f.directory, 'missing.mjs') : value));
      said(await cli(f, [...args, VALIDATE]), file);
      noExecution(f);
    }
  },
);

for (const fault of ['missing journal', 'corrupt journal', 'missing scoped capability', 'read-only connection'] as const) {
  test(`scoped command CLI: ${fault} refuses without fallback or migration`, { timeout: 20_000 }, async (t) => {
    const f = fixture(t, fault !== 'missing journal');
    if (fault === 'corrupt journal') {
      const db = new DatabaseSync(f.data);
      try {
        db.exec(`ALTER TABLE ${COMMAND_JOURNAL_TABLES.receipt} ADD COLUMN unexpected TEXT`);
      } finally {
        db.close();
      }
    }
    if (fault === 'missing scoped capability')
      writeFileSync(f.commandsFile, f.commands('SqliteAdapter.prototype.scopeCommandTransaction = undefined;'));
    if (fault === 'read-only connection')
      writeFileSync(f.config, JSON.stringify({ connections: [{ ...f.connections[0], writable: false }, ...f.connections.slice(1)] }));
    const before = readFileSync(f.data);
    refused(await cli(f, [...flags(f), VALIDATE]));
    assert.deepEqual(readFileSync(f.data), before, 'failed attestation must not repair or migrate the database');
    noExecution(f);
  });
}

async function eventually(check: () => boolean, message: () => string, timeout = deadline) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (check()) return;
    await delay(40);
  }
  assert.fail(message());
}

async function live(f: Fixture) {
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((done, reject) => reservation.close((error) => (error ? reject(error) : done())));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', entry, '--config', f.config, '--app', f.app, ...flags(f), '--port', String(port)],
    {
      cwd: root,
      env: { ...f.env, BETTER_AUTH_SECRET: 'scoped-command-cli-fixture-secret-at-least-32-characters', MISTRI_PUBLIC_URL: origin },
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
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      return await exited;
    } finally {
      clearTimeout(force);
    }
  };
  // A case that fails before its own stop still stops the child before the directory goes.
  f.stopping(stop);
  const call = async (path: string, cookie = '', body?: object, account?: string) => {
    const response = await fetch(origin + path, {
      method: body ? 'POST' : 'GET',
      signal: AbortSignal.timeout(8000),
      headers: {
        origin,
        cookie,
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(account ? { 'x-mistri-account': account } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: response.status,
      body: await response.json(),
      headers: response.headers,
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
      () => `CLI never listened\n${output}`,
    );
    assert.deepEqual(f.trace(), ['commands.loaded', 'policy.loaded', 'scoped.preflight']);
    const signup = await call('/api/auth/sign-up/email', '', {
      name: 'Scoped operator',
      email: 'operator@example.org',
      password: 'fixture-password-123',
    });
    assert.equal(signup.status, 200, JSON.stringify(signup.body) + output);
    assert.match(signup.cookie, /mistri-[A-Za-z0-9_-]+\.session_token=/);
    assert.equal(typeof signup.body.user.id, 'string');
    return { stop, call, cookie: signup.cookie, account: signup.body.user.id as string, output: () => output };
  } catch (error) {
    await stop();
    throw error;
  }
}

test(
  'scoped command CLI: real auth, scoped prepare/execute/status and durable receipts keep generic CRUD disabled',
  { timeout: SLOW },
  async (t) => {
    const f = fixture(t);
    const server = await live(f);
    const request = {
      command: 'rename',
      commandVersion: 1,
      key: { id: 1 },
      expectedVersion: 0,
      idempotencyKey: 'scoped-cli-rename-0001',
      input: { name: 'Renamed' },
    };
    const post = (path: string, body: object) => server.call(`/api/commands/${path}?app=${appId}`, server.cookie, body, server.account);
    try {
      const anonymous = await server.call('/api/commands/prepare', '', { command: 'rename', commandVersion: 1, key: { id: 1 } });
      assert.equal(anonymous.status, 401);
      const prepared = await post('prepare', { command: 'rename', commandVersion: 1, key: { id: 1 } });
      assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
      assert.deepEqual(prepared.body, { expectedVersion: 0 });
      const hidden = await post('prepare', { command: 'rename', commandVersion: 1, key: { id: 2 } });
      assert.equal(hidden.status, 404, JSON.stringify(hidden.body));
      assert.equal(hidden.body.code, 'not_found');
      assert.equal(hidden.body.outcome, 'not_applied');
      const missing = await post('status', request);
      assert.equal(missing.status, 200, JSON.stringify(missing.body));
      assert.deepEqual(missing.body, { status: 'not_found', outcome: 'unknown' });
      const applied = await post('execute', request);
      assert.equal(applied.status, 200, JSON.stringify(applied.body));
      assert.deepEqual(applied.body.result, { version: 1 });
      assert.equal(applied.body.commandVersion, 1);
      assert.equal(applied.headers.get('x-mistri-app'), appId);
      assert.equal(applied.headers.get('x-mistri-account'), server.account);
      assert.equal(applied.headers.get('cache-control'), 'no-store');
      assert.doesNotMatch(JSON.stringify(applied.body), /private-command-output|physical_ticket|secret|undo/);
      for (const path of ['execute', 'status']) {
        const replay = await post(path, request);
        assert.equal(replay.status, 200, JSON.stringify(replay.body));
        assert.deepEqual(replay.body, { ...applied.body, replayed: true });
      }
      for (const path of ['/api/update', '/api/insert', '/api/delete', '/api/undo']) {
        const denied = await server.call(
          path,
          server.cookie,
          { table: 'ticket', key: { id: 1 }, values: { name: 'Bypass' } },
          server.account,
        );
        assert.equal(denied.status, 403, `${path}: ${JSON.stringify(denied.body)}`);
      }
      const app = await server.call('/api/app', server.cookie);
      assert.equal(app.status, 200, JSON.stringify(app.body));
      assert.deepEqual(app.body.app.grantedCommands, ['rename']);
      assert.deepEqual(app.body.app.writableTables, []);
      assert.equal(app.body.app.resources.ticket.actions[0].command.id, 'rename');
      assert.equal(f.trace().filter((event) => event === 'handler').length, 1, 'replay and status must not rerun the handler');
      assert.equal(f.trace().includes('ordinary.journal'), false, 'HTTP must use scoped execution too');
    } finally {
      assert.deepEqual(await server.stop(), { code: 0, signal: null }, server.output());
    }
    const db = new DatabaseSync(f.data, { readOnly: true });
    try {
      assert.deepEqual(
        db
          .prepare('SELECT id, version, name FROM physical_ticket ORDER BY id')
          .all()
          .map((row) => ({ ...row })),
        [
          { id: 1, version: 1, name: 'Renamed' },
          { id: 2, version: 0, name: 'Hidden' },
        ],
      );
      for (const table of [COMMAND_JOURNAL_TABLES.receipt, sqliteAuditRows]) {
        assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table.startsWith('(') ? `${table} a` : table}`).get()!.n, 1);
      }
    } finally {
      db.close();
    }
    const beforeData = readFileSync(f.data);
    const beforeAuth = readFileSync(f.authStore);
    const beforeEvents = f.trace().length;
    const checked = await cli(f, [...flags(f), VALIDATE]);
    assert.equal(checked.code, 0, checked.stdout + checked.stderr);
    assert.deepEqual(f.trace().slice(beforeEvents), ['commands.loaded', 'policy.loaded', 'scoped.preflight']);
    assert.deepEqual(readFileSync(f.data), beforeData, 'check must preserve populated receipts and audits');
    assert.deepEqual(readFileSync(f.authStore), beforeAuth, 'check must preserve real auth sessions');
  },
);
