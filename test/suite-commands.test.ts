/** Registered commands remain owned by the mounted App and its row policy. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { startConfiguredSuite } from '../packages/mistri/src/server/cli/suiteCommand.js';
import { buildApp } from '../packages/mistri/src/server/build/build.js';

test('same-name suite commands retain authentication, policy, transaction and receipt ownership', { timeout: 15_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-suite-commands-'));
  let active: Awaited<ReturnType<typeof startConfiguredSuite>> | undefined;
  t.after(async () => {
    await active?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const definitions = [];
  for (const id of ['lender', 'dealer']) {
    const home = join(directory, id);
    mkdirSync(home);
    const database = join(home, 'business.db');
    const db = new DatabaseSync(database);
    db.exec(
      "CREATE TABLE ticket(id INTEGER PRIMARY KEY, version INTEGER NOT NULL, name TEXT); INSERT INTO ticket VALUES(1,0,'Visible'), (2,0,'Hidden')",
    );
    db.close();
    migrateSqliteCommandJournal(database);
    writeFileSync(
      join(home, 'app.json'),
      JSON.stringify({
        name: id,
        track: 'receipts',
        sources: { data: { connection: 'data', default: true } },
        auth: {
          store: join(home, 'auth.db'),
          signUp: 'open',
          ...(id === 'dealer' ? { rows: 'policy' } : {}),
          roles: { user: { read: true, commands: ['rename'] } },
        },
        resources: { ticket: { access: 'write', actions: { rename: { label: 'Rename', command: 'rename' } } } },
        views: { tickets: { kind: 'list', from: 'ticket' } },
        home: 'tickets',
        nav: ['tickets'],
      }),
    );
    writeFileSync(
      join(home, 'commands.mjs'),
      `import { defineCommand, defineCommands } from ${JSON.stringify(new URL('../packages/mistri/src/server/commands/businessCommands.ts', import.meta.url).href)};
      export const control = {};
      export default defineCommands({ rename: defineCommand({ source: 'data', target: 'ticket', read: ['ticket'], write: ['ticket'],
        input: { name: { type: 'text' } }, validate(value) { return { name: value.name }; }, output: { parse(value) { return { name: value.name }; } },
        async handle({ db, record }, input) {
          if (control.wait) { control.entered(); await control.wait; }
          const name = ${JSON.stringify(id)} + ':' + input.name;
          await db.ticket.update(record, { name });
          return { name };
        }
      }) });`,
    );
    writeFileSync(join(home, 'connections.json'), JSON.stringify({ connections: [{ name: 'data', url: database, writable: true }] }));
    if (id === 'dealer')
      writeFileSync(
        join(home, 'policy.mjs'),
        `export default { appId: 'dealer', resultReferences: { rename: () => [] },
      resolveRows(principal) { if (principal.appId !== 'dealer' || !principal.id) throw Error('Wrong principal');
        return { ticket: { groups: [[{ column: 'id', op: '=', value: 1 }]] } }; } };`,
      );
    definitions.push({
      id,
      directory: `./${id}`,
      config: `./${id}/connections.json`,
      mount: id === 'lender' ? '/' : '/dealer',
      ...(id === 'dealer' ? { policy: './dealer/policy.mjs' } : {}),
      environment: { BETTER_AUTH_SECRET: 'SUITE_SECRET' },
    });
  }
  const file = join(directory, 'suite.json');
  writeFileSync(file, JSON.stringify({ port, apps: definitions }));
  const suite = await startConfiguredSuite(file, { SUITE_SECRET: 'test-only-suite-command-secret-longer-than-thirty-two-characters' });
  active = suite;
  const accounts: Record<string, string> = {};
  const call = async (path: string, cookie: string, body: unknown) => {
    const response = await fetch(`${suite.publicURL}${path}`, {
      method: 'POST',
      headers: {
        origin: suite.publicURL,
        cookie,
        'content-type': 'application/json',
        ...(accounts[path.startsWith('/dealer/') ? 'dealer' : 'lender']
          ? { 'x-mistri-account': accounts[path.startsWith('/dealer/') ? 'dealer' : 'lender'] }
          : {}),
      },
      body: JSON.stringify(body),
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
  const signup = { name: 'Operator', email: 'operator@example.test', password: 'test-only-command-password' };
  const lender = await call('/api/auth/sign-up/email', '', signup);
  assert.equal(lender.status, 200, lender.text);
  accounts.lender = lender.body.user.id;
  const prepare = { command: 'rename', commandVersion: 1, key: { id: 1 } };
  assert.equal((await call('/dealer/api/commands/prepare', lender.cookie, prepare)).status, 401);
  const dealer = await call('/dealer/api/auth/sign-up/email', '', signup);
  assert.equal(dealer.status, 200, dealer.text);
  accounts.dealer = dealer.body.user.id;
  const both = `${lender.cookie}; ${dealer.cookie}`;
  for (const id of ['lender', 'dealer']) {
    const path = `${id === 'lender' ? '' : '/dealer'}/api/commands`;
    const prepared = await call(`${path}/prepare`, both, prepare);
    assert.equal(prepared.status, 200, prepared.text);
    const request = {
      ...prepare,
      expectedVersion: prepared.body.expectedVersion,
      idempotencyKey: 'shared-attempt-key-0001',
      input: { name: 'Changed' },
    };
    const result = await call(`${path}/execute`, both, request);
    assert.equal(result.status, 200, `${id}: ${result.text}`);
    assert.deepEqual(result.body.result, { name: `${id}:Changed` });
    const replay = await call(`${path}/status`, both, request);
    assert.equal(replay.status, 200, replay.text);
    assert.deepEqual(replay.body.result, result.body.result);
    assert.equal(replay.body.replayed, true);
  }
  const hidden = await call('/dealer/api/commands/prepare', both, { ...prepare, key: { id: 2 } });
  assert.notEqual(hidden.status, 200);
  assert.equal((await call('/dealer/api/commands/prepare?app=lender', both, prepare)).status, 403);
  for (const id of ['lender', 'dealer']) {
    const db = new DatabaseSync(join(directory, id, 'business.db'), { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT name FROM ticket WHERE id=1').get()?.name, `${id}:Changed`);
      assert.equal(db.prepare('SELECT name FROM ticket WHERE id=2').get()?.name, 'Hidden');
    } finally {
      db.close();
    }
  }
  const module = await import(pathToFileURL(join(directory, 'lender', 'commands.mjs')).href);
  let entered!: () => void, release!: () => void;
  const accepted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  module.control.entered = entered;
  module.control.wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = await call('/api/commands/prepare', both, prepare);
  const pending = call('/api/commands/execute', both, {
    ...prepare,
    expectedVersion: next.body.expectedVersion,
    idempotencyKey: 'held-at-shutdown-0001',
    input: { name: 'Held' },
  });
  await accepted;
  let closed = false;
  const closing = suite.close().then(() => {
    closed = true;
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closed, false, 'the suite retains command resources while an accepted command runs');
  } finally {
    release();
  }
  assert.equal((await pending).status, 200);
  await closing;
});

test('a suite serves a mistri build with its own bundled commands, as serve --commands does', { timeout: 20_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-suite-built-'));
  let active: Awaited<ReturnType<typeof startConfiguredSuite>> | undefined;
  t.after(async () => {
    await active?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const source = join(directory, 'source');
  mkdirSync(source);
  const database = join(directory, 'business.db');
  const db = new DatabaseSync(database);
  db.exec("CREATE TABLE ticket(id INTEGER PRIMARY KEY, version INTEGER NOT NULL, name TEXT); INSERT INTO ticket VALUES(1,0,'Old')");
  db.close();
  migrateSqliteCommandJournal(database);
  writeFileSync(
    join(source, 'app.json'),
    JSON.stringify({
      id: 'desk',
      name: 'Desk',
      track: 'receipts',
      sources: { data: { connection: 'data', default: true } },
      auth: { store: join(directory, 'auth.db'), signUp: 'open', roles: { user: { read: true, commands: ['rename'] } } },
      resources: { ticket: { access: 'write', actions: { rename: { label: 'Rename', command: 'rename' } } } },
      views: { tickets: { kind: 'list', from: 'ticket' } },
      home: 'tickets',
      nav: ['tickets'],
    }),
  );
  writeFileSync(
    join(source, 'commands.mjs'),
    `import { defineCommand, defineCommands } from ${JSON.stringify(new URL('../packages/mistri/src/server/commands/businessCommands.ts', import.meta.url).href)};
    export default defineCommands({ rename: defineCommand({ source: 'data', target: 'ticket', read: ['ticket'], write: ['ticket'],
      input: { name: { type: 'text' } }, validate(value) { return { name: value.name }; }, output: { parse(value) { return { name: value.name }; } },
      async handle({ db, record }, input) { const name = 'built:' + input.name; await db.ticket.update(record, { name }); return { name }; }
    }) });`,
  );
  const out = join(directory, 'build');
  await buildApp({ app: source, out, commands: join(source, 'commands.mjs') }, { bundler: async () => undefined, typecheck: false });
  writeFileSync(join(directory, 'connections.json'), JSON.stringify({ connections: [{ name: 'data', url: database, writable: true }] }));
  const file = join(directory, 'suite.json');
  const entry = {
    id: 'desk',
    directory: './build',
    config: './connections.json',
    mount: '/',
    environment: { BETTER_AUTH_SECRET: 'SUITE_SECRET' },
  };
  const environment = { SUITE_SECRET: 'test-only-suite-build-secret-longer-than-thirty-two-characters' };
  // The source's module beside a build is refused, as serve refuses it: a build runs the code it hashed.
  writeFileSync(file, JSON.stringify({ port, apps: [{ ...entry, commands: './source/commands.mjs' }] }));
  await assert.rejects(startConfiguredSuite(file, environment), /Suite App "desk": .*is a build: --commands must be its own/);
  writeFileSync(file, JSON.stringify({ port, apps: [{ ...entry, commands: './build/server/commands.mjs' }] }));
  const suite = await startConfiguredSuite(file, environment);
  active = suite;
  const call = async (path: string, cookie: string, body: unknown) => {
    const response = await fetch(`${suite.publicURL}${path}`, {
      method: 'POST',
      headers: { origin: suite.publicURL, cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    const cookies = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    return { status: response.status, body: JSON.parse(text), text, cookie: cookies };
  };
  const signed = await call('/api/auth/sign-up/email', '', {
    name: 'Operator',
    email: 'operator@example.test',
    password: 'test-only-build-password',
  });
  assert.equal(signed.status, 200, signed.text);
  const prepare = { command: 'rename', commandVersion: 1, key: { id: 1 } };
  const prepared = await call('/api/commands/prepare', signed.cookie, prepare);
  assert.equal(prepared.status, 200, prepared.text);
  const result = await call('/api/commands/execute', signed.cookie, {
    ...prepare,
    expectedVersion: prepared.body.expectedVersion,
    idempotencyKey: 'built-attempt-key-0001',
    input: { name: 'New' },
  });
  assert.equal(result.status, 200, result.text);
  assert.deepEqual(result.body.result, { name: 'built:New' });
});
