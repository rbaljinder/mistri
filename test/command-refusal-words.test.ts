/**
 * A refused command says why, in words (field report G6). A role the command is not granted to is told which command;
 * and a declarative `when` that fails says which part and what the record holds, in the App's own words for
 * the column (its caption, an amount kept in cents as money) — `Balance owed is $108.99; needs ≤ $0.00` — instead
 * of "This record is not eligible for this command". It names a value only to a person whose grants read the
 * column; for anyone else, and for a part no sentence about one value can say, the generic sentence stays.
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
import { whenRefusalSentence } from '../packages/mistri/src/server/commands/commandSaying.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { catalogOf } from './support/commandCatalog.js';

const COMMANDS = ['collect', 'close', 'ship'];
const LABELS: Record<string, string> = { collect: 'Collect payment', close: 'Close invoice', ship: 'Ship' };
const GENERIC = 'This record is not eligible for this command.';

const command = (when: string) =>
  defineCommand({
    source: 'shop',
    target: 'invoice',
    when,
    async handle({ db, record }) {
      await db.invoice.update(record, { status: 'closed' });
    },
  } as Parameters<typeof defineCommand>[0]);

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-when-words-'));
  const file = join(directory, 'shop.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE invoice (id INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'open', balance_cents INTEGER NOT NULL DEFAULT 0, note TEXT);
    INSERT INTO invoice (id, status, balance_cents) VALUES (1, 'open', 10899), (2, 'open', 0), (3, 'closed', 0);`);
  migrateSqliteCommandJournal(file);
  clearJournal('shop-db');
  const connections = new Registry();
  connections.add({ id: 'shop-db', name: 'Shop', url: file, writable: true, source: 'config' });
  const manifest = parseAppConfig(
    {
      id: 'shop',
      name: 'Shop',
      sources: { shop: { connection: 'shop-db', default: true } },
      resources: {
        invoice: {
          access: 'write',
          labels: { balance_cents: 'Balance owed' },
          display: { balance_cents: { format: 'money', minor: true } },
          actions: Object.fromEntries(COMMANDS.map((id) => [id, { label: LABELS[id], command: id }])),
        },
      },
      auth: {
        providers: ['email'],
        roles: {
          agent: { read: true, commands: COMMANDS },
          viewer: { read: true },
        },
      },
      views: { invoices: { kind: 'list', from: 'invoice' } },
      home: 'invoices',
      nav: ['invoices'],
    },
    'when words',
    { commands: catalogOf(Object.fromEntries(COMMANDS.map((id) => [id, { target: 'invoice' }]))) },
  );
  const control = { identity: { id: 'account-agent', who: 'agent@example.test', role: 'agent' } as Identity };
  const pages = parsePagesConfig({ pages: [] }, 'when words pages');
  const host: AppHost = {
    app: { app: manifest, path: '/private/shop/app.ts', pages, sources: {} },
    pages,
    auth: {
      spec: manifest.auth!,
      store: '/private/shop/auth.db',
      close() {},
      handler: async () => {},
      session: async () => control.identity,
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({
    registry: connections,
    bound,
    apps: [host],
    pages,
    commands: {
      appId: 'shop',
      registry: defineCommands({
        collect: command('balance_cents <= 0'),
        close: command('status = open and balance_cents <= 0'),
        ship: command('note contains rush'),
      }),
    },
  });
  server.listen(0, bound.host);
  await once(server, 'listening');
  bound.port = (server.address() as { port: number }).port;
  let requests = 0;
  const run = async (name: string, id: number) => {
    const post = async (path: string, body: object) => {
      const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
        headers: { 'content-type': 'application/json', 'x-mistri-account': control.identity.id },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    };
    const prepared = await post('/api/commands/prepare', { command: name, commandVersion: 1, key: { id } });
    // Prepare may itself refuse an ineligible record (its words are the generic sentence); the run is what names the part.
    return post('/api/commands/execute', {
      command: name,
      commandVersion: 1,
      key: { id },
      expectedVersion: prepared.body.expectedVersion ?? 1,
      idempotencyKey: `when-words-request-${String(++requests).padStart(4, '0')}`,
      input: {},
    });
  };
  const close = async () => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    db.close();
    await connections.closeAll();
    clearJournal();
    rmSync(directory, { recursive: true, force: true });
  };
  return { run, control, close };
}

test("a failing when says the part it failed and the record's value as the App shows it", async () => {
  const { run, close } = await fixture();
  try {
    const refused = await run('collect', 1);
    assert.equal(refused.body.code, 'ineligible_state', JSON.stringify(refused.body));
    assert.equal(refused.status, 409);
    assert.equal(refused.body.message, 'Balance owed is $108.99; needs ≤ $0.00', JSON.stringify(refused.body));
    // A compound when names the first part that fails: invoice 3 is closed, its balance is nothing.
    const compound = await run('close', 3);
    assert.equal(compound.body.message, 'status is closed; needs = open', JSON.stringify(compound.body));
    // The same refusal on the first part of a compound.
    const balance = await run('close', 1);
    assert.equal(balance.body.message, 'Balance owed is $108.99; needs ≤ $0.00', JSON.stringify(balance.body));
    // A part no sentence about one value can say keeps the generic sentence.
    const unsaid = await run('ship', 2);
    assert.equal(unsaid.body.code, 'ineligible_state');
    assert.equal(unsaid.body.message, GENERIC);
  } finally {
    await close();
  }
});

test('a role the command is not granted to is told which command, by the label the App shows', async () => {
  const { run, control, close } = await fixture();
  try {
    control.identity = { id: 'account-viewer', who: 'viewer@example.test', role: 'viewer' } as Identity;
    const refused = await run('collect', 1);
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'forbidden');
    assert.equal(refused.body.message, 'Your role has no grant for "Collect payment".');
    // A command the App does not have is not confirmed by its label.
    const unknown = await run('nothing', 1);
    assert.equal(unknown.body.message, 'This command is not available to this account.', JSON.stringify(unknown.body));
  } finally {
    await close();
  }
});

test('a value is named only to a person who reads the column, and a part no sentence can say is left to the generic words', () => {
  const saying = { label: (column: string) => column, value: (_column: string, value: unknown) => String(value) };
  const condition = { column: 'balance_cents', op: '<=', value: 0 } as const;
  const row = { balance_cents: 10899 };
  // The platform already refuses to grant a command to a role that cannot read a column its `when` judges at startup;
  // this is the sentence's own guard, should a grant narrow after.
  assert.equal(
    whenRefusalSentence(saying, condition, row, () => false),
    undefined,
  );
  assert.equal(
    whenRefusalSentence(saying, condition, row, () => true),
    'balance_cents is 10899; needs ≤ 0',
  );
  assert.equal(
    whenRefusalSentence(saying, { column: 'note', op: 'contains', value: 'rush' }, row, () => true),
    undefined,
  );
  assert.equal(
    whenRefusalSentence(saying, { column: 'balance_cents', op: 'isNull' }, row, () => true),
    'balance_cents is 10899; needs to be empty',
  );
  assert.equal(
    whenRefusalSentence(undefined, condition, row, () => true),
    undefined,
  );
});
