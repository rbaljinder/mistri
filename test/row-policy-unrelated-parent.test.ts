/**
 * Under a row policy a write may point a row only at a parent the principal
 * reads — and only the references the write makes are its to vouch for. The
 * Keystone customer App's borrower could not change their city because their
 * profile's applicant_id points at a table the App never declares, and the
 * dealer App's contact command failed because the dealer row's relationship
 * manager lies outside the dealer's rows. Neither write touched the reference.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { loadHttpAppPolicy, type HttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import { parseTestApp } from './support/commandCatalog.js';

const appId = 'borrower-desk';
const who: Identity = { id: 'account-ada', who: 'ada@example.test', role: 'borrower' };

async function serve(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-unrelated-parent-'));
  const file = join(directory, 'data.db');
  const db = new DatabaseSync(file);
  const registry = new Registry();
  let server: Server | undefined, policy: HttpAppPolicy | undefined;
  t.after(async () => {
    try {
      if (server) {
        const closed = new Promise<void>((resolve) => server!.close(() => resolve()));
        server.closeAllConnections();
        await closed;
      }
      await policy?.retire();
      await registry.closeAll();
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  db.exec(`CREATE TABLE applicant (id INTEGER PRIMARY KEY, ssn TEXT);
    CREATE TABLE staff (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE dealer (id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, phone TEXT, manager_id INTEGER REFERENCES staff(id), version INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE profile (id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, city TEXT, applicant_id INTEGER REFERENCES applicant(id));
    INSERT INTO applicant VALUES (1, 'PRIVATE'), (2, 'PRIVATE');
    INSERT INTO staff VALUES (1, 'Relationship manager');
    INSERT INTO dealer VALUES (1, 'account-ada', '555-0100', 1, 0);
    INSERT INTO profile VALUES (1, 'account-ada', 'Harrisburg', 1);`);
  migrateSqliteCommandJournal(file);
  registry.add({ id: 'data', name: 'Data', url: file, writable: true, source: 'config' });
  const app = parseTestApp(
    {
      id: appId,
      name: 'Borrower desk',
      sources: { main: { connection: 'data', default: true } },
      resources: {
        profile: { access: 'write' },
        dealer: {
          access: 'write',
          actions: {
            updateContact: {
              label: 'Update contact',
              command: { id: 'updateContact', version: 1, target: 'dealer', input: { phone: { label: 'Phone', type: 'text' } } },
            },
          },
        },
        staff: {},
      },
      auth: {
        rows: 'policy',
        roles: {
          borrower: {
            read: ['profile', 'dealer'],
            write: ['profile', 'dealer'],
            commands: ['updateContact'],
            fields: { dealer: { read: ['id', 'account_id', 'phone', 'manager_id', 'version'], write: ['phone'] } },
          },
        },
      },
      views: { profiles: { kind: 'list', from: 'profile' } },
      home: 'profiles',
      nav: ['profiles'],
    },
    'unrelated parent fixture',
  );
  const commands = defineCommands({
    updateContact: defineCommand({
      source: 'main',
      target: 'dealer',
      input: { phone: { label: 'Phone', type: 'text' } },
      output: { parse: (value: unknown) => value as { message: string } },
      async handle({ db: tables, record }, input) {
        await tables.dealer.update(record, { phone: input.phone });
        return { message: 'Updated.' };
      },
    }),
  });
  const module = join(directory, 'policy.mjs');
  // The borrower's own rows; staff is never theirs.
  writeFileSync(
    module,
    `export default { appId: ${JSON.stringify(appId)},
    resultReferences: { updateContact: () => [] },
    resolveRows(principal) {
      const mine = { groups: [[{ column: 'account_id', op: '=', value: principal.id }]] };
      return { profile: mine, dealer: mine, staff: false };
    } };`,
  );
  policy = await loadHttpAppPolicy({ app, registry, commands, file: module, verifySession: async () => who });
  const host: AppHost = {
    app: { app, path: join(directory, 'app.ts'), pages: [], sources: {} },
    pages: [],
    auth: {
      spec: app.auth!,
      store: join(directory, 'auth.db'),
      close() {},
      handler: async () => {},
      session: async () => who,
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  server = createApp({ registry, bound, apps: [host], policy });
  server.listen(0, bound.host);
  await once(server, 'listening');
  bound.port = (server.address() as { port: number }).port;
  const base = `http://${bound.host}:${bound.port}`;
  const call = async (path: string, body: Record<string, unknown>) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(5_000),
      headers: { 'content-type': 'application/json', origin: base, 'x-mistri-account': who.id },
      body: JSON.stringify(path.startsWith('/api/commands/') ? body : { app: appId, ...body }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { call, db };
}

test('an edit that leaves a reference alone is not refused over the parent it points at', { timeout: 20_000 }, async (t) => {
  const { call, db } = await serve(t);
  // The applicant table is not the App's; the profile's city is the borrower's.
  const city = await call('/api/update', { table: 'profile', key: { id: 1 }, values: { city: 'Scranton' } });
  assert.equal(city.status, 200, JSON.stringify(city.body));
  // Setting the reference still needs a parent the borrower reads.
  const pointed = await call('/api/update', { table: 'profile', key: { id: 1 }, values: { applicant_id: 2 } });
  assert.equal(pointed.status, 403, JSON.stringify(pointed.body));
  // A command on a dealer whose relationship manager is outside the borrower's rows.
  const contact = await call('/api/commands/execute', {
    command: 'updateContact',
    commandVersion: 1,
    key: { id: 1 },
    expectedVersion: 0,
    idempotencyKey: 'update-contact-000001',
    input: { phone: '555-0199' },
  });
  assert.equal(contact.status, 200, JSON.stringify(contact.body));
  assert.deepEqual({ ...db.prepare('SELECT city, applicant_id FROM profile WHERE id = 1').get() }, { city: 'Scranton', applicant_id: 1 });
  assert.equal(db.prepare('SELECT phone FROM dealer WHERE id = 1').get()!.phone, '555-0199');
});
