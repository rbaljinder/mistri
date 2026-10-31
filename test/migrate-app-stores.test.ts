/**
 * `migrate stores up --app` makes every store the App uses (OP4): the
 * notification store beside the resources that notify, the record history a
 * dashboard's activity feed reads, the assistant's conversations when the App
 * declares one, the command journal and event store, and,
 * with `--jobs`, the job store and the deliveries its jobs listen on. Run
 * twice, everything is present and nothing is made again.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { runMigrate } from '../packages/engine/src/server/migrate/cli.js';
import { MIGRATE_APPS } from '../packages/mistri/src/server/cli/appTargets.js';
import { installTablewalk } from './support/installedTablewalk.js';

test('migrate stores up --app provisions every store the App uses, once', { timeout: 120_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-app-stores-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // An App's modules import the package, as one beside an installed tablewalk does.
  mkdirSync(join(directory, 'node_modules'));
  installTablewalk(join(directory, 'node_modules'));
  const file = join(directory, 'desk.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE item (id INTEGER PRIMARY KEY, title TEXT NOT NULL, owner TEXT, status TEXT NOT NULL DEFAULT 'open',
    version INTEGER NOT NULL DEFAULT 0);`);
  db.close();
  const config = join(directory, 'mistri.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'desk', url: file, writable: true }] }));
  const app = join(directory, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), '{ "type": "module" }\n');
  writeFileSync(
    join(app, 'app.json'),
    JSON.stringify({
      id: 'desk',
      name: 'Desk',
      connection: 'desk',
      assistant: {},
      resources: { item: { access: 'write', notify: [{ on: 'insert', to: 'owner', title: 'New item' }] } },
      auth: { roles: { agent: { read: true, write: true, commands: ['close'] }, clock: { read: true, commands: ['archive'] } } },
      views: {
        items: { kind: 'list', from: 'item' },
        overview: { kind: 'dashboard', label: 'Overview', sections: [{ kind: 'activity', resources: { item: {} } }] },
      },
      home: 'items',
      nav: ['items', 'overview'],
    }),
  );
  writeFileSync(
    join(app, 'events.mjs'),
    `import { defineEvent, int, shape } from '@mistriwork/mistri/commands';
export const closed = defineEvent('item.closed', shape({ id: int() }));
`,
  );
  writeFileSync(
    join(app, 'commands.ts'),
    `import { defineCommand, defineCommands, defineEventProjection, int, shape } from '@mistriwork/mistri/commands';
import { closed } from './events.mjs';
export default defineCommands({
  close: defineCommand({ source: 'desk', target: 'item', read: ['item'], write: ['item'], output: shape({ id: int() }),
    events: { closed: defineEventProjection(closed, ({ id }) => ({ id })) },
    async handle({ db, record }) { await db.item.update(record, { status: 'closed' }); return { id: Number(record.id) }; } }),
  archive: defineCommand({ source: 'desk', target: 'item', read: ['item'], write: ['item'],
    async handle({ db, record }) { await db.item.update(record, { status: 'archived' }); } }),
});
`,
  );
  const jobs = join(app, 'jobs.mjs');
  writeFileSync(
    jobs,
    `import { defineJob, defineJobs } from '@mistriwork/mistri/jobs';
import { closed } from './events.mjs';
export default defineJobs({
  archiveClosed: defineJob({ on: { event: closed, command: 'close' }, runAs: 'clock', command: 'archive', schedule: (event) => ({ key: { id: event.id } }) }),
}, { principals: { clock: { roles: ['clock'] } } });
`,
  );
  const run = async () => {
    const lines: string[] = [];
    const code = await runMigrate(
      ['stores', 'up', '--app', app, '--jobs', jobs, '--config', config],
      (line) => lines.push(line),
      undefined,
      MIGRATE_APPS,
    );
    return { code, text: lines.join('\n') };
  };
  const first = await run();
  assert.equal(first.code, 0, first.text);
  for (const store of [
    /desk: notification store v\d+ provisioned/,
    /desk: record history v\d+ provisioned/,
    /desk: assistant store v\d+ provisioned/,
    /desk: command journal v\d+ provisioned/,
    /desk: event store for App "desk" v\d+ provisioned/,
    /desk: jobs: job store provisioned, 1 delivery destination\(s\), 1 added/,
  ])
    assert.match(first.text, store);
  const again = await run();
  assert.equal(again.code, 0, again.text);
  assert.doesNotMatch(again.text, /provisioned|[1-9] added/, again.text);
  assert.match(again.text, /desk: assistant store v\d+ present/);
  // The layout is listed beside its peers, now held at its version.
  const lines: string[] = [];
  assert.equal(await runMigrate(['stores', 'status', '--config', config], (line) => lines.push(line), undefined, MIGRATE_APPS), 0);
  assert.match(lines.join('\n'), /assistant.*v1/);
  assert.match(again.text, /desk: jobs: 1 delivery destination\(s\), 0 added/);
});

test('migrate stores up --app --commands reads the commands module it names, as a start does', { timeout: 120_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-app-stores-commands-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'node_modules'));
  installTablewalk(join(directory, 'node_modules'));
  const file = join(directory, 'desk.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE item (id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
    version INTEGER NOT NULL DEFAULT 0);`);
  db.close();
  const config = join(directory, 'mistri.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'desk', url: file, writable: true }] }));
  const app = join(directory, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), '{ "type": "module" }\n');
  writeFileSync(
    join(app, 'app.json'),
    JSON.stringify({
      id: 'desk',
      name: 'Desk',
      connection: 'desk',
      resources: { item: { access: 'write' } },
      auth: { roles: { agent: { read: true, write: true, commands: ['close'] } } },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
    }),
  );
  // Not commands.ts: only the flag finds it.
  const module = join(app, 'desk-commands.ts');
  writeFileSync(
    module,
    `import { defineCommand, defineCommands } from '@mistriwork/mistri/commands';
export default defineCommands({
  close: defineCommand({ source: 'desk', target: 'item', read: ['item'], write: ['item'],
    async handle({ db, record }) { await db.item.update(record, { status: 'closed' }); } }),
});
`,
  );
  const lines: string[] = [];
  const code = await runMigrate(
    ['stores', 'up', '--app', app, '--commands', module, '--config', config],
    (line) => lines.push(line),
    undefined,
    MIGRATE_APPS,
  );
  assert.equal(code, 0, lines.join('\n'));
  assert.match(lines.join('\n'), /desk: command journal v\d+ provisioned/);
});
