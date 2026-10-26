/**
 * A value component's `label` reaches the served App and the CSV: the rule
 * the browser is given carries the words, a CSV says them, and JSON keeps the
 * stored value for the programs that read it.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { loadApp, type AppHost } from '../packages/mistri/src/server/app/apps.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';

test('the words a label gave are served with the rule and written in a CSV, and JSON keeps the stored value', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-value-label-served-'));
  mkdirSync(join(directory, 'node_modules'));
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
  registry.add({
    id: 'loans',
    name: 'Loans',
    url: path,
    source: 'config',
    writable: false,
  });
  const loaded = await loadApp(appDir);
  const host: AppHost = { app: loaded, pages: loaded.pages };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({
    registry,
    bound,
    apps: [host],
    pages: loaded.pages,
  });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://${bound.host}:${address.port}`;
  try {
    const { app } = (await (await fetch(`${base}/api/app`)).json()) as {
      app: {
        resources: {
          loan: { display: { status: { values?: Record<string, string> } } };
        };
      };
    };
    assert.equal(app.resources.loan.display.status.values?.APP_PENDING, 'Pending review');
    assert.equal(app.resources.loan.display.status.values?.APP_DONE, 'Funded');
    const exported = async (format: string) =>
      (
        await fetch(`${base}/api/export`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ app: 'loans', q: 'loan', format }),
        }).then((response) => response.text())
      ).trim();
    const csv = await exported('csv');
    assert.match(csv, /First,Pending review/);
    assert.match(csv, /Second,Funded/);
    assert.doesNotMatch(csv, /APP_PENDING/);
    assert.match(await exported('ndjson'), /"status":"APP_PENDING"/);
  } finally {
    const closed = new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  }
});
