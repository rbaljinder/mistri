import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { defineCommand, defineCommands, type BusinessCommandActor } from '../packages/mistri/src/server/commands/businessCommands.js';
import { createBusinessCommandAuthorizer } from '../packages/mistri/src/server/commands/businessCommandAuthorization.js';
import { sessionActorWords } from '../packages/mistri/src/server/app/appStamps.js';
import { parseTestApp } from './support/commandCatalog.js';

/**
 * Who is acting, in words: a command's actor carries the verified session's
 * email and display name, so a ledger can say who moved stock and a row a
 * command writes can be the person `me` means. Only the session says it — a
 * body naming an actor is refused before any work, and the authorizer
 * rebuilds the actor from its own copy, so a forged email reaches nothing.
 */
const account: Identity = { id: 'account-a', who: 'maya@example.test', role: 'clerk', name: 'Maya Chen' };

async function fixture(
  run: (f: { base: string; db: DatabaseSync; seen: BusinessCommandActor[]; control: { current: Identity | null } }) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-command-actor-'));
  const file = join(directory, 'actor.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE bin(id INTEGER PRIMARY KEY, qty INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE movement(id INTEGER PRIMARY KEY, bin_id INTEGER NOT NULL REFERENCES bin(id), qty INTEGER NOT NULL, moved_by TEXT, moved_by_name TEXT);
    INSERT INTO bin VALUES (1, 10, 0);`);
  migrateSqliteCommandJournal(file);
  const registry = new Registry();
  registry.add({ id: 'actor-db', name: 'Actor', url: file, writable: true, source: 'config' });
  const app = parseTestApp(
    {
      id: 'stock',
      name: 'Stock',
      sources: { stock: { connection: 'actor-db' } },
      resources: {
        bin: {
          access: 'write',
          actions: {
            move: {
              label: 'Move',
              command: { id: 'move', version: 1, target: 'bin', input: { qty: { label: 'Quantity', type: 'number' } } },
            },
          },
        },
        // A command writes its ledger line; no role edits one.
        movement: { access: 'write' },
      },
      auth: { roles: { clerk: { read: true, commands: ['move'] } } },
      views: { bins: { kind: 'list', from: 'bin' } },
      home: 'bins',
      nav: ['bins'],
    },
    'actor fixture',
  );
  const seen: BusinessCommandActor[] = [];
  const commands = defineCommands({
    move: defineCommand({
      source: 'stock',
      target: 'bin',
      write: ['movement'],
      input: { qty: { label: 'Quantity', type: 'number' } },
      output: { parse: (value: unknown) => value as { moved: number } },
      async handle({ db: tables, record, actor }, input) {
        seen.push(actor);
        await tables.movement.insert({
          bin_id: record.id,
          qty: input.qty,
          moved_by: actor.email ?? null,
          moved_by_name: actor.name ?? null,
        });
        await tables.bin.update(record, { qty: Number(record.qty) + Number(input.qty) });
        return { moved: Number(input.qty) };
      },
    }),
  });
  const control = { current: account as Identity | null };
  const host: AppHost = {
    app: { app, path: '/private/app.ts', pages: [], sources: {} },
    pages: [],
    auth: {
      spec: app.auth!,
      store: '/private/auth.db',
      close() {},
      handler: async () => {},
      session: async () => control.current,
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], commands: { appId: 'stock', registry: commands } });
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    bound.port = address.port;
    await run({ base: `http://${bound.host}:${bound.port}`, db, seen, control });
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

let requestNumber = 0;
async function move(base: string, extra: Record<string, unknown> = {}, input: Record<string, unknown> = { qty: 2 }) {
  const version = extra.expectedVersion ?? 0;
  const response = await fetch(`${base}/api/commands/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mistri-account': account.id },
    body: JSON.stringify({
      command: 'move',
      commandVersion: 1,
      key: { id: 1 },
      expectedVersion: version,
      idempotencyKey: `actor-request-${String(++requestNumber).padStart(4, '0')}`,
      input,
      ...extra,
    }),
    signal: AbortSignal.timeout(5_000),
  });
  return { status: response.status, body: await response.json() };
}

test("a handler's actor carries the verified session's email and name, and writes them where the App says", async () =>
  fixture(async ({ base, db, seen }) => {
    const moved = await move(base);
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].email, 'maya@example.test');
    assert.equal(seen[0].name, 'Maya Chen');
    assert.equal(seen[0].id, 'account-a');
    assert.ok(Object.isFrozen(seen[0]));
    assert.deepEqual(
      db
        .prepare('SELECT moved_by, moved_by_name FROM movement')
        .all()
        .map((row) => ({ ...row })),
      [{ moved_by: 'maya@example.test', moved_by_name: 'Maya Chen' }],
    );
  }));

test('a body that names an actor, an email or a name is refused before the handler runs', async () =>
  fixture(async ({ base, db, seen }) => {
    for (const forged of [
      { actor: { id: 'account-a', email: 'boss@example.test' } },
      { email: 'boss@example.test' },
      { name: 'The Boss' },
    ]) {
      const refused = await move(base, forged);
      assert.equal(refused.status, 400, JSON.stringify(refused.body));
      assert.equal(refused.body.outcome, 'not_applied');
    }
    // Input is parsed against the command's own fields: an extra field is no way in either.
    const smuggled = await move(base, {}, { qty: 1, email: 'boss@example.test' });
    assert.ok(smuggled.status >= 400, JSON.stringify(smuggled.body));
    assert.equal(seen.length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM movement').get()!.n, 0);
  }));

test('an account whose session names no display name acts under its email alone', async () =>
  fixture(async ({ base, seen, control }) => {
    control.current = { id: 'account-a', who: 'maya@example.test', role: 'clerk' };
    assert.equal((await move(base)).status, 200);
    assert.equal(seen[0].email, 'maya@example.test');
    assert.equal(Object.hasOwn(seen[0], 'name'), false);
  }));

test("the session's words are bounded and never cut into another address", () => {
  assert.deepEqual(sessionActorWords({ id: 'a', who: ' ann@example.test ', name: '  Ann  ' }), { email: 'ann@example.test', name: 'Ann' });
  assert.deepEqual(sessionActorWords({ id: 'a', who: `${'x'.repeat(320)}@example.test` }), {});
  assert.deepEqual(sessionActorWords({ who: 'ann@example.test' }), {}, 'no account, no words');
  assert.deepEqual(sessionActorWords({ id: 'a', who: 'ann@example.test', name: 'n'.repeat(500) }).name?.length, 200);
});

test('the authorizer rebuilds the actor: a public or service principal carrying an email is refused, and a bad email too', () => {
  const app = parseTestApp(
    {
      id: 'stock',
      name: 'Stock',
      sources: { main: { connection: 'x', default: true } },
      resources: {
        bin: { access: 'write', actions: { move: { label: 'Move', command: { id: 'move', version: 1, target: 'bin', input: {} } } } },
      },
      auth: { roles: { clerk: { read: true, commands: ['move'] }, robot: { read: ['bin'], commands: ['move'] } } },
      views: { bins: { kind: 'list', from: 'bin' } },
      home: 'bins',
      nav: ['bins'],
    },
    'authorizer fixture',
  );
  const schema = {
    dialect: 'sqlite',
    tables: [
      {
        id: 'bin',
        schema: 'main',
        name: 'bin',
        isView: false,
        rowCount: 0,
        foreignKeys: [],
        columns: [
          { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
          { name: 'version', type: 'INTEGER', nullable: false, primaryKey: false },
        ],
      },
    ],
  };
  const registry = defineCommands({
    move: defineCommand({
      source: 'main',
      target: 'bin',
      input: {},
      output: { parse: (value: unknown) => value },
      async handle() {
        return {};
      },
    }),
  });
  const authorizer = createBusinessCommandAuthorizer({
    app,
    registry,
    schema: schema as never,
    connectionFor: () => 'x',
    writableConnection: () => true,
    transactionalConnection: () => true,
  });
  const base = { id: 'account-a', appId: 'stock', roles: ['clerk'] };
  const extra = { ...base, email: 'ann@example.test', name: 'Ann', smuggled: 'ignored' } as BusinessCommandActor;
  const rebuilt = authorizer.authorize('move', extra).actor;
  assert.deepEqual({ ...rebuilt }, { ...base, roles: ['clerk'], email: 'ann@example.test', name: 'Ann' });
  // The same service principal without an email is authorized: the email is what refuses it.
  assert.equal(
    authorizer.authorize('move', { id: 'service:robot', appId: 'stock', roles: ['robot'], kind: 'service' }).actor.kind,
    'service',
  );
  for (const bad of [
    { ...base, email: '' },
    { ...base, email: 42 },
    { ...base, name: 'x'.repeat(201) },
    { ...base, email: 'a\0b' },
    { id: 'service:robot', appId: 'stock', roles: ['robot'], kind: 'service', email: 'robot@example.test' },
  ]) {
    assert.throws(() => authorizer.authorize('move', bad as unknown as BusinessCommandActor), `refused: ${JSON.stringify(bad)}`);
  }
});
