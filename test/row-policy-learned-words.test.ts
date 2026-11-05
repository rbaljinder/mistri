/**
 * Words a value component's `label` gave its column are learned after the App
 * loads (server/app/valueLabels.ts), in place on the definition. They are
 * display data, not authority: a row-policy App compares its live definition
 * with the one its policy was loaded under on every request, and the learned
 * words must not make the two differ (every signed-in request answered 503
 * "Application policy is unavailable" once they were learned).
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Registry } from '../packages/engine/src/server/connections.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { loadApp, type AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { learnValueLabels } from '../packages/mistri/src/server/app/valueLabels.js';
import { loadHttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import { createApp } from './support/createApp.js';

const schema: DatabaseSchema = {
  label: 'Loans',
  dialect: 'sqlite',
  readAt: '',
  foreignKeys: [],
  tables: [
    {
      id: 'loan',
      name: 'loan',
      schema: '',
      isView: false,
      columns: [
        { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
        { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
        { name: 'status', type: 'TEXT', nullable: false, primaryKey: false, allowed: ['APP_PENDING', 'APP_DONE'] },
      ],
    },
  ],
};

async function serve(policyApp: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-learned-words-'));
  mkdirSync(join(directory, 'node_modules', '@mistriwork'), { recursive: true });
  symlinkSync(join(resolve('.'), 'packages', 'mistri'), join(directory, 'node_modules', '@mistriwork', 'mistri'), 'dir');
  const appDir = join(directory, 'app');
  mkdirSync(join(appDir, 'widgets'), { recursive: true });
  writeFileSync(join(appDir, 'package.json'), '{ "type": "module" }\n');
  writeFileSync(
    join(appDir, 'widgets', 'Status.jsx'),
    [
      "const WORDS = { APP_PENDING: 'Pending review', APP_DONE: 'Funded' };",
      'export const label = (value) => WORDS[value] ?? value;',
      'export default function Status({ value }) { return <b>{value}</b>; }',
    ].join('\n'),
  );
  writeFileSync(
    join(appDir, 'app.mjs'),
    [
      "import { component, defineApp } from '@mistriwork/mistri/app';",
      "const status = component('status', { module: './widgets/Status.jsx', kind: 'value' });",
      "export default defineApp({ id: 'loans', name: 'Loans', connection: 'loans', resources: { loan: { display: { status } } },",
      policyApp ? "  auth: { rows: 'policy', roles: { reader: { read: ['loan'], export: ['loan'] } } }," : '',
      "  views: { loans: { kind: 'list', from: 'loan' } }, home: 'loans', nav: ['loans'] });",
    ].join('\n'),
  );
  const path = join(directory, 'loans.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE loan (id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('APP_PENDING', 'APP_DONE')));
    INSERT INTO loan VALUES (1, 'First', 'APP_PENDING'), (2, 'Second', 'APP_DONE');
  `);
  db.close();
  const registry = new Registry();
  registry.add({ id: 'loans', name: 'Loans', url: path, source: 'config', writable: false });
  const loaded = await loadApp(appDir);
  const account: Identity = { id: 'reader-one', who: 'reader@example.test', role: 'reader' };
  const verifySession = async (_request: IncomingMessage) => account;
  const policyFile = join(directory, 'policy.mjs');
  writeFileSync(
    policyFile,
    "export default { appId: 'loans', resolveRows: () => ({ loan: { groups: [[{ column: 'id', op: '>', value: 0 }]] } }) };\n",
  );
  const policy = policyApp ? await loadHttpAppPolicy({ app: loaded.app, registry, file: policyFile, verifySession }) : undefined;
  const host: AppHost = {
    app: loaded,
    pages: loaded.pages,
    ...(policyApp
      ? {
          auth: {
            spec: loaded.app.auth!,
            store: join(directory, 'sessions.db'),
            close: async () => {},
            session: async () => account,
            handler: async (_req, res) => {
              res.writeHead(204);
              res.end();
            },
          },
        }
      : {}),
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages: loaded.pages, ...(policy ? { policy } : {}) });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://${bound.host}:${address.port}`;
  return {
    base,
    loaded,
    policy,
    async close() {
      const closed = new Promise<void>((done) => server.close(() => done()));
      server.closeAllConnections();
      await closed;
      await policy?.retire();
      await registry.closeAll();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

for (const policyApp of [true, false])
  test(
    `learned value words do not break serving ${policyApp ? 'a row-policy App' : 'an App without a policy'}`,
    { timeout: 60_000 },
    async () => {
      const s = await serve(policyApp);
      try {
        // The learning a startup or a request does, awaited so the request below always follows it.
        await learnValueLabels(s.loaded, schema);
        assert.equal(s.loaded.app.valueLabels?.['loan.status']?.APP_DONE, 'Funded');
        if (s.policy) assert.equal(s.policy.matches(s.loaded.app), true, 'learned words are not a change to the declared App');
        const served = await fetch(`${s.base}/api/app?app=loans`);
        assert.equal(served.status, 200, await served.clone().text());
        const { app } = (await served.json()) as {
          app: { resources: { loan: { display: { status: { values?: Record<string, string> } } } } };
        };
        assert.equal(app.resources.loan.display.status.values?.APP_PENDING, 'Pending review');
        // The CSV says the learned words, read through the policy where the App has one.
        const exported = await fetch(`${s.base}/api/export?app=loans`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ app: 'loans', q: 'loan', format: 'csv' }),
        });
        assert.equal(exported.status, 200);
        const csv = await exported.text();
        assert.match(csv, /First,Pending review/);
        assert.match(csv, /Second,Funded/);
      } finally {
        await s.close();
      }
    },
  );
