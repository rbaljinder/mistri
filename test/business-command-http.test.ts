import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { migrateSqliteCommandJournal, COMMAND_JOURNAL_TABLES } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { parseCommandInput } from '../packages/mistri/src/shared/commandInputParse.js';
import { refuse } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import {
  bindHttpBusinessCommands,
  loadBusinessCommands,
  validateBusinessCommandStartup,
} from '../packages/mistri/src/server/commands/businessCommandLoader.js';
import { parseTestApp } from './support/commandCatalog.js';
import { VALIDATE, validating } from './support/validation.js';

const account: Identity = { id: 'account-a', who: 'manager@example.test', role: 'manager' };
/* Declared once: the action's reference and the registration read the same list. */
const assignInput = {
  reviewer: { label: 'Reviewer', type: 'reference', from: 'reviewer', by: 'id', labelColumn: 'name', optional: true },
} as const;
const request = (extra: Record<string, unknown> = {}) => ({
  command: 'assign',
  commandVersion: 1,
  key: { id: 1 },
  expectedVersion: 0,
  idempotencyKey: 'assignment-request-0001',
  input: { reviewer: 1 },
  ...extra,
});

async function fixture(
  run: (f: {
    base: string;
    db: DatabaseSync;
    registry: Registry;
    host: AppHost;
    commands: ReturnType<typeof defineCommands>;
    control: {
      current: Identity | null;
      sessions: number;
      calls: number;
      started?: () => void;
      wait?: Promise<void>;
      fail?: boolean | string;
    };
  }) => Promise<void>,
  migrated = true,
  availability?: () => readonly boolean[],
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-command-http-'));
  const file = join(directory, 'commands.db');
  const db = new DatabaseSync(file);
  const registry = new Registry();
  db.exec(`CREATE TABLE loan(id INTEGER PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0, reviewer INTEGER);
    CREATE TABLE reviewer(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE hidden(id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO loan VALUES (1,0,NULL); INSERT INTO reviewer VALUES (1,'Ada');`);
  if (migrated) migrateSqliteCommandJournal(file);
  registry.add({ id: 'private-db', name: 'Private', url: file, writable: true, source: 'config' });
  const app = parseTestApp(
    {
      id: 'loans',
      name: 'Loans',
      track: 'receipts',
      sources: { lending: { connection: 'private-db' } },
      resources: {
        loan: {
          access: 'write',
          actions: {
            assign: {
              label: 'Assign',
              command: {
                id: 'assign',
                version: 1,
                target: 'loan',
                input: assignInput,
              },
            },
          },
        },
        reviewer: {},
        hidden: {},
      },
      auth: {
        roles: {
          manager: { read: true, commands: ['assign'] },
          viewer: { read: ['loan'] },
          incomplete: { read: ['loan'], commands: ['assign'] },
        },
      },
      views: { loan: { kind: 'list', from: 'loan' } },
      home: 'loan',
      nav: ['loan'],
    },
    'command HTTP fixture',
  );
  const control = {
    current: account as Identity | null,
    sessions: 0,
    calls: 0,
    started: undefined as (() => void) | undefined,
    wait: undefined as Promise<void> | undefined,
    fail: false as boolean | string,
  };
  const commands = defineCommands({
    assign: defineCommand({
      source: 'lending',
      target: 'loan',
      ...(availability ? { availability } : {}),
      read: ['reviewer'],
      input: assignInput,
      // The declaration takes a key's text or a whole number; this command takes a whole number.
      validate(input): { reviewer: number } {
        if (!Number.isSafeInteger(input.reviewer)) throw new Error('Private input details');
        return { reviewer: input.reviewer as number };
      },
      output: {
        parse(value: unknown) {
          return { version: (value as { version: number }).version };
        },
      },
      async handle({ db, record }, input) {
        control.calls++;
        control.started?.();
        await control.wait;
        if (typeof control.fail === 'string') refuse(control.fail);
        if (control.fail) refuse('reviewer_unavailable');
        const { version } = await db.loan.update(record, { reviewer: input.reviewer });
        return { version: Number(version), sql: 'PRIVATE SQL MUST BE PROJECTED' };
      },
    }),
  });
  const host: AppHost = {
    app: { app, path: '/private/app.ts', pages: [], sources: {} },
    pages: [],
    auth: {
      spec: app.auth!,
      store: '/private/auth.db',
      close() {},
      handler: async () => {},
      session: async () => {
        control.sessions++;
        return control.current;
      },
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], commands: { appId: 'loans', registry: commands } });
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    bound.port = address.port;
    await run({ base: `http://${bound.host}:${bound.port}`, db, registry, host, commands, control });
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}/api/commands/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mistri-account': account.id, ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3_000),
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

test('availability HTTP returns only aligned booleans for granted visible targets, not handlers or revisions', async () => {
  await fixture(async ({ base, control }) => {
    const body = { checks: [{ command: 'assign', commandVersion: 1, keys: [{ id: 1 }, { id: 999 }] }] };
    const result = await post(base, 'availability', body);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { checks: [{ command: 'assign', commandVersion: 1, available: [true, false] }] });
    assert.equal(control.calls, 0);
    control.current = { ...account, role: 'viewer' };
    assert.deepEqual((await post(base, 'availability', body)).body, {
      checks: [{ command: 'assign', commandVersion: 1, available: [false, false] }],
    });
    assert.equal(control.calls, 0);
    assert.equal((await post(base, 'availability', { ...body, actor: account })).status, 400);
  });
});

test('availability HTTP never exposes hook refusal fields, keys or business reason', async () => {
  await fixture(
    async ({ base, control }) => {
      const result = await post(base, 'availability', { checks: [{ command: 'assign', commandVersion: 1, keys: [{ id: 1 }] }] });
      assert.equal(result.status, 503);
      assert.equal(result.body.code, 'temporarily_unavailable');
      assert.doesNotMatch(JSON.stringify(result.body), /private_column|private-key|stale_record/);
      assert.equal(control.calls, 0);
    },
    true,
    () => refuse('stale_record', { field: 'private_column', key: { secret: 'private-key' } }),
  );
});

test('HTTP prepare, execute and exact status use safe versioned DTOs and persisted receipts', { timeout: 8000 }, async () => {
  await fixture(async (f) => {
    const prepare = await post(f.base, 'prepare', { command: 'assign', commandVersion: 1, key: { id: 1 } });
    assert.equal(prepare.status, 200);
    assert.deepEqual(prepare.body, { expectedVersion: 0 });
    assert.equal(prepare.headers.get('x-mistri-app'), 'loans');
    assert.equal(prepare.headers.get('x-mistri-account'), account.id);
    const missing = await post(f.base, 'status', request());
    assert.deepEqual(missing.body, { status: 'not_found', outcome: 'unknown' });
    assert.equal(f.control.calls, 0);
    const applied = await post(f.base, 'execute', request());
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.equal(applied.body.commandVersion, 1);
    assert.deepEqual(applied.body.result, { version: 1 });
    assert.doesNotMatch(JSON.stringify(applied.body), /PRIVATE|private|sql|undo/);
    assert.equal(applied.headers.get('cache-control'), 'no-store');
    const status = await post(f.base, 'status', request());
    assert.deepEqual(status.body, { ...applied.body, replayed: true });
    assert.equal(f.control.calls, 1);
    assert.equal(f.control.sessions, 4);
  });
});

test('HTTP command authentication and stale-account guards precede data work and reject forged identities', { timeout: 8000 }, async () => {
  await fixture(async (f) => {
    let opens = 0;
    const original = f.registry.open.bind(f.registry);
    f.registry.open = async (id) => {
      opens++;
      return original(id);
    };
    f.control.current = null;
    const signedOut = await post(f.base, 'execute', request({ actor: account }));
    assert.equal(signedOut.status, 401);
    assert.equal(signedOut.body.code, 'unauthenticated');
    assert.equal(signedOut.body.outcome, 'not_applied');
    f.control.current = { ...account, id: 'account-b' };
    const stale = await post(f.base, 'execute', request());
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'stale_account');
    assert.equal(opens, 0);
    f.control.current = { ...account, role: 'viewer' };
    const forbidden = await post(f.base, 'execute', request(), { 'x-role': 'manager', 'x-forwarded-user': 'manager' });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.code, 'forbidden');
    assert.equal(forbidden.body.error, forbidden.body.message);
    assert.equal(f.control.calls, 0);
  });
});

test('HTTP payloads refuse forged app/source fields, partial keys and unpinned versions', { timeout: 8000 }, async () => {
  await fixture(async (f) => {
    for (const input of [
      request({ commandVersion: undefined }),
      request({ actor: account }),
      request({ app: 'loans' }),
      request({ source: 'lending' }),
      request({ key: { id: 1, extra: 2 } }),
    ]) {
      const result = await post(f.base, 'execute', input);
      assert.equal(result.status, 400);
      assert.equal(result.body.outcome, 'not_applied');
    }
    for (const key of [{}, { id: 1, extra: 2 }]) {
      assert.equal((await post(f.base, 'prepare', { command: 'assign', commandVersion: 1, key })).status, 400);
    }
    const changed = await post(f.base, 'execute', request({ commandVersion: 2 }));
    assert.equal(changed.status, 409);
    assert.equal(changed.body.code, 'command_version_mismatch');
    assert.equal(changed.body.outcome, 'unknown');
    assert.equal((await post(f.base, 'execute?app=other', request())).status, 403);
    assert.equal((await post(f.base, 'execute?conn=private-db', request())).status, 403);
    assert.equal(f.control.calls, 0);
  });
});

test('HTTP prepare returns safe missing and invalid stored-version errors', { timeout: 8000 }, async () => {
  await fixture(async (f) => {
    assert.equal((await post(f.base, 'prepare', { command: 'assign', commandVersion: 1, key: { id: 99 } })).body.code, 'not_found');
    for (const version of [-1, 1.5, 'private']) {
      f.db.prepare('UPDATE loan SET version = ?').run(version);
      const result = await post(f.base, 'prepare', { command: 'assign', commandVersion: 1, key: { id: 1 } });
      assert.equal(result.body.code, 'invalid_result');
      assert.doesNotMatch(JSON.stringify(result.body), /private/);
    }
  });
});

test('HTTP current grants protect receipt lookup and hide actions without removing the owning list', { timeout: 8000 }, async () => {
  await fixture(async (f) => {
    await post(f.base, 'execute', request());
    const visible = await fetch(`${f.base}/api/app`, { signal: AbortSignal.timeout(3000) });
    assert.deepEqual((await visible.json()).app.grantedCommands, ['assign']);
    for (const role of ['viewer', 'incomplete']) {
      f.control.current = { ...account, role };
      const status = await post(f.base, 'status', request());
      assert.equal(status.status, 403);
      assert.equal(status.body.outcome, 'unknown');
      const response = await fetch(`${f.base}/api/app`, { signal: AbortSignal.timeout(3000) });
      const manifest = await response.json();
      assert.equal(Object.keys(manifest.app.views).length, 1);
      assert.equal(manifest.app.resources.loan?.actions, undefined);
      assert.deepEqual(manifest.app.grantedCommands, []);
    }
    assert.equal(f.control.calls, 1);
  });
});

test('HTTP business failures have fixed public messages and confirmed rollback', { timeout: 8000 }, async () => {
  await fixture(async (f) => {
    f.control.fail = true;
    const result = await post(f.base, 'execute', request());
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'reviewer_unavailable');
    assert.equal(result.body.message, 'The selected reviewer is unavailable.');
    assert.equal(result.body.outcome, 'not_applied');
    assert.equal(f.db.prepare('SELECT version FROM loan').get()!.version, 0);
    assert.equal(f.db.prepare(`SELECT count(*) AS n FROM "${COMMAND_JOURNAL_TABLES.receipt}"`).get()!.n, 0);
  });
});

test(
  "HTTP business refusals with a handler's own reason say it verbatim, with the fixed code and confirmed rollback",
  { timeout: 8000 },
  async () => {
    await fixture(async (f) => {
      f.control.fail = 'Quinn Davis has 0 h of Personal left, and this request is 8 h.';
      const result = await post(f.base, 'execute', request());
      assert.equal(result.status, 409);
      assert.equal(result.body.code, 'ineligible_state');
      assert.equal(result.body.message, 'Quinn Davis has 0 h of Personal left, and this request is 8 h.');
      assert.equal(result.body.error, result.body.message);
      assert.equal(result.body.outcome, 'not_applied');
      assert.equal(f.db.prepare('SELECT version FROM loan').get()!.version, 0);
      assert.equal(f.db.prepare(`SELECT count(*) AS n FROM "${COMMAND_JOURNAL_TABLES.receipt}"`).get()!.n, 0);
    });
  },
);

test('HTTP socket loss keeps the operation lease until the handler rolls back', { timeout: 8000 }, async () => {
  await fixture(async (f) => {
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: () => void;
    f.control.wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.control.started = started;
    let leased = 0;
    const lease = f.registry.lease.bind(f.registry);
    f.registry.lease = (id) => {
      leased++;
      const release = lease(id);
      return () => {
        leased--;
        release();
      };
    };
    const controller = new AbortController();
    const pending = fetch(`${f.base}/api/commands/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request()),
      signal: controller.signal,
    }).catch(() => undefined);
    await began;
    controller.abort();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(leased, 1, 'response close must not release an executing command');
    finish();
    for (let i = 0; i < 30 && leased; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(leased, 0);
    assert.equal(f.db.prepare('SELECT version FROM loan').get()!.version, 0);
    assert.deepEqual((await post(f.base, 'status', request())).body, { status: 'not_found', outcome: 'unknown' });
  });
});

test('startup validates registry metadata and the durable command capability without migrating', { timeout: 8000 }, async () => {
  await fixture(async (f) => {
    const resources = await loadAppRuntimeResources(f.registry, f.host.app.app, 'private-db');
    const validate = () => validateBusinessCommandStartup(f.host.app.app, f.commands, resources, () => true);
    await validate();
    const reference = f.host.app.app.resources!.loan.actions![0].command!;
    reference.version = 2;
    await assert.rejects(validate(), /resolved at version 2.*registration is at 1/);
    reference.version = 1;
    // The App's input is the registration's: a reference that says something else is refused before anything reads it.
    const declared = reference.input;
    reference.input = [{ name: 'hidden', label: 'Hidden', type: 'reference', from: 'hidden', by: 'id', labelColumn: 'name' }];
    await assert.rejects(validate(), /unresolved reference resource or label column/);
    reference.input = declared;
    // Both sides naming it, a reference over a resource outside the command's read footprint is still refused.
    const hiddenInput = {
      hidden: { label: 'Hidden', type: 'reference', from: 'hidden', by: 'id', labelColumn: 'name', optional: true },
    } as const;
    reference.input = parseCommandInput(hiddenInput, 'hidden reference');
    const hiddenCommands = defineCommands({
      assign: defineCommand({
        source: 'lending',
        target: 'loan',
        read: ['loan', 'reviewer'],
        write: ['loan'],
        input: hiddenInput,
        output: { parse: (value) => value },
        handle: () => ({ version: 1 }),
      }),
    });
    await assert.rejects(
      validateBusinessCommandStartup(f.host.app.app, hiddenCommands, resources, () => true),
      /unresolved reference/,
    );
    reference.input = declared;
    resources.forConnection('private-db').commandTransaction = undefined;
    // forConnection can produce a facade on each call, so replace the accessor itself.
    const source = { ...resources.forConnection('private-db'), dialect: 'postgres' as const, commandTransaction: undefined };
    resources.forConnection = () => source;
    assert.throws(() => bindHttpBusinessCommands(f.host.app.app, f.commands, resources, () => true), /SQLite and PostgreSQL provide it/);
  });
  await fixture(async (f) => {
    const resources = await loadAppRuntimeResources(f.registry, f.host.app.app, 'private-db');
    await assert.rejects(
      validateBusinessCommandStartup(f.host.app.app, f.commands, resources, () => true),
      /command journal on connection "private-db" is unavailable: it is provisioned once, never on startup\. Run `mistri migrate stores up --app <the App's directory>` with the server stopped \(or migrateSqliteCommandJournal\(path\) from @mistriwork\/mistri\/commands\)/,
    );
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE '__mistri_command_%'").get()!.n, 0);
  }, false);
});

test('command loader refuses unregistered module defaults and suppresses private import errors', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-command-loader-'));
  try {
    const bad = join(directory, 'bad.mjs');
    writeFileSync(bad, "throw new Error('PRIVATE IDENTITY MAPPING');");
    await assert.rejects(loadBusinessCommands(bad), (error) => {
      assert.doesNotMatch((error as Error).message, /PRIVATE|MAPPING/);
      return true;
    });
    const invalid = join(directory, 'invalid.mjs');
    writeFileSync(invalid, 'export default { assign: {} };');
    await assert.rejects(loadBusinessCommands(invalid), /must be created with defineCommand/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI commands startup requires one explicit app, matching references and an existing journal', { timeout: 12000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-command-cli-'));
  try {
    const database = join(directory, 'loans.db');
    const db = new DatabaseSync(database);
    db.exec('CREATE TABLE loan(id INTEGER PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0);');
    db.close();
    const config = join(directory, 'server.json');
    writeFileSync(config, JSON.stringify({ connections: [{ name: 'loans', url: database, writable: true }] }));
    const appFile = join(directory, 'app.json');
    const app = {
      id: 'loans',
      name: 'Loans',
      sources: { lending: { connection: 'loans' } },
      resources: { loan: { access: 'write', actions: { assign: { label: 'Assign', command: 'assign' } } } },
      auth: { roles: { manager: { read: true, commands: ['assign'] } } },
      views: { loan: { kind: 'list', from: 'loan' } },
      home: 'loan',
      nav: ['loan'],
    };
    writeFileSync(appFile, JSON.stringify(app));
    const module = join(directory, 'commands.mjs');
    const helpers = pathToFileURL(
      fileURLToPath(new URL('../packages/mistri/src/server/commands/businessCommands.ts', import.meta.url)),
    ).href;
    writeFileSync(
      module,
      `import { defineCommand, defineCommands } from ${JSON.stringify(helpers)};
      export default defineCommands({ assign: defineCommand({ source: 'lending', target: 'loan', 
        read: ['loan'], write: ['loan'], input: {}, output: { parse: value => value }, handle: () => ({ version: 1 }) }) });`,
    );
    const cli = fileURLToPath(new URL('../packages/mistri/src/server/index.ts', import.meta.url));
    const run = (args: string[]) => {
      const child = validating(args, { ...process.env, DATABASE_URL: '', MISTRI_OPEN: '0' });
      return spawnSync(process.execPath, ['--import', 'tsx', cli, '--config', config, ...child.args], {
        encoding: 'utf8',
        // A guard against a start that serves instead of exiting, not a speed budget: under the full gate's load a
        // tsx start of mistri took longer than the 4 s this once allowed, and the test failed with no status.
        timeout: 15_000,
        env: child.env,
      });
    };
    const missing = run(['--app', directory, '--commands', module, VALIDATE]);
    assert.equal(missing.status, 1);
    assert.match(
      missing.stderr,
      /Run `mistri migrate stores up --app <the App's directory>` with the server stopped \(or migrateSqliteCommandJournal\(path\) from @mistriwork\/mistri\/commands\)/,
    );
    migrateSqliteCommandJournal(database);
    const ready = run(['--app', directory, '--commands', module, VALIDATE]);
    assert.equal(ready.status, 0, ready.stderr);
    assert.match(ready.stdout, /Loans: ok/);
    renameSync(module, join(directory, 'commands-disabled.mjs'));
    const noModule = run(['--app', directory, VALIDATE]);
    renameSync(join(directory, 'commands-disabled.mjs'), module);
    assert.equal(noModule.status, 1);
    assert.match(noModule.stderr, /--commands/);
    const noApp = run(['--commands', module, VALIDATE]);
    assert.equal(noApp.status, 1);
    assert.match(noApp.stderr, /exactly one explicit --app/);
    app.resources.loan.actions.assign.command = 'unregistered';
    writeFileSync(appFile, JSON.stringify(app));
    const mismatch = run(['--app', directory, '--commands', module, VALIDATE]);
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /unregistered/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
