/**
 * The test kit's `act` (testing/appRequests.ts) runs a record's action on a record it applies to (AG1): a command's
 * own `when` is asked of the server first (/api/commands/availability), so a step never picks a record the button
 * would not be offered on — a repair that still owes money — however many such records come first; and a handler's
 * refusal of one record, a field named or not, moves on to the next, since another record may be the one it takes.
 */
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
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { refuse } from '../packages/mistri/src/server/commands/commandErrors.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { appRequests } from '../packages/mistri/src/server/testing/appRequests.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { catalogOf } from './support/commandCatalog.js';

const desk: Identity = { id: 'account-desk', who: 'desk@example.test', role: 'desk' };
const COMMANDS = ['handOver', 'fit'];

test('act runs a command on a record its when admits and its handler takes, past those that come first', { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-kit-act-'));
  const file = join(directory, 'shop.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE repair (id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ready',
    balance NUMERIC NOT NULL DEFAULT 0, parts_in INTEGER NOT NULL DEFAULT 1);`);
  // A list reads newest first: eleven repairs that still owe money come before the one that is paid, and the
  // newest two have no parts in.
  const insert = db.prepare('INSERT INTO repair (id, title, balance, parts_in) VALUES (?, ?, ?, ?)');
  for (let id = 1; id <= 12; id++) insert.run(id, `Repair ${id}`, id === 1 ? 0 : 50, id >= 11 ? 0 : 1);
  migrateSqliteCommandJournal(file);
  clearJournal('kit-act-db');
  const registry = new Registry();
  registry.add({ id: 'kit-act-db', name: 'Shop', url: file, writable: true, source: 'config' });
  const app = parseAppConfig(
    {
      id: 'shop',
      name: 'Shop',
      sources: { shop: { connection: 'kit-act-db', default: true } },
      resources: {
        repair: {
          access: 'write',
          actions: Object.fromEntries(COMMANDS.map((id) => [id, { label: id, command: id }])),
        },
      },
      auth: { providers: ['email'], roles: { desk: { read: true, commands: COMMANDS } } },
      views: { repairs: { kind: 'list', from: 'repair' } },
      home: 'repairs',
      nav: ['repairs'],
    },
    'shop',
    { commands: catalogOf(Object.fromEntries(COMMANDS.map((id) => [id, { target: 'repair' }]))) },
  );
  const pages = parsePagesConfig({ pages: [] }, 'shop pages');
  const host: AppHost = {
    app: { app, path: join(directory, 'app.ts'), pages, sources: {} },
    pages,
    auth: { spec: app.auth!, store: join(directory, 'auth.db'), close() {}, handler: async () => {}, session: async () => desk },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({
    registry,
    bound,
    apps: [host],
    pages,
    commands: {
      appId: 'shop',
      registry: defineCommands({
        // Handed over only once it is paid: the button is offered where the balance is settled.
        handOver: defineCommand({
          source: 'shop',
          target: 'repair',
          when: 'balance <= 0 and status = ready',
          async handle({ db, record }) {
            await db.repair.update(record, { status: 'collected' });
          },
        } as Parameters<typeof defineCommand>[0]),
        // Fitted only once its parts are in: the handler refuses the others, naming the field it reads.
        fit: defineCommand({
          source: 'shop',
          target: 'repair',
          async handle({ db, record }) {
            if (Number(record.parts_in) === 0) refuse('Its parts are not in yet.', { field: 'parts_in' });
            await db.repair.update(record, { status: 'fitted' });
          },
        } as Parameters<typeof defineCommand>[0]),
      }),
    },
  });
  server.listen(0, bound.host);
  await once(server, 'listening');
  bound.port = (server.address() as { port: number }).port;
  const person = appRequests(
    (path, init) =>
      fetch(`http://${bound.host}:${bound.port}${path}`, {
        method: init.method ?? (init.json === undefined ? 'GET' : 'POST'),
        signal: AbortSignal.timeout(10_000),
        headers: {
          ...(init.json === undefined ? {} : { 'content-type': 'application/json' }),
          'x-mistri-account': desk.id,
          ...init.headers,
        },
        ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
      }),
    { app: 'shop' },
  );
  const status = (id: number) => (db.prepare('SELECT status FROM repair WHERE id = ?').get(id) as { status: string }).status;
  try {
    const handed = await person.act('repair', 'handOver');
    assert.ok(handed.ok, JSON.stringify(handed));
    assert.deepEqual(handed.value.key, { id: 1 });
    assert.equal(status(1), 'collected');
    // None left that is paid: no record to run it on, said rather than refused.
    const none = await person.act('repair', 'handOver');
    assert.ok(!none.ok && none.code === 'no_record', JSON.stringify(none));

    const fitted = await person.act('repair', 'fit');
    assert.ok(fitted.ok, JSON.stringify(fitted));
    assert.deepEqual(fitted.value.key, { id: 10 });
    assert.equal(status(12), 'ready');
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    db.close();
    await registry.closeAll();
    clearJournal();
    rmSync(directory, { recursive: true, force: true });
  }
});
