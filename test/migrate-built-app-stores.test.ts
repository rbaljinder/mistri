/**
 * `migrate stores up --app <build>` provisions what it does for the App's source (G8, OP4): a build carries its
 * commands and jobs as bundled entries, not as a commands.ts beside the manifest, so the command read the build's
 * definition, found no commands, and provisioned nothing a command, an event or a job needs — the deployment it is
 * for. The build's own entries are the ones read; a --jobs or --commands that is not the build's is refused, as a
 * start refuses it. `status --app <build>` reads the same database.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { runMigrate } from '../packages/engine/src/server/migrate/cli.js';
import { MIGRATE_APPS } from '../packages/mistri/src/server/cli/appTargets.js';
import { buildApp } from '../packages/mistri/src/server/build/build.js';

test('migrate stores up --app <build> provisions every store the built App uses, from its own entries', { timeout: 180_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-built-app-stores-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'desk.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE item (id INTEGER PRIMARY KEY, title TEXT NOT NULL, owner TEXT, status TEXT NOT NULL DEFAULT 'open',
    version INTEGER NOT NULL DEFAULT 0);`);
  db.close();
  const config = join(directory, 'mistri.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'desk', url: './desk.db', writable: true }] }));
  const app = join(directory, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), '{ "type": "module" }\n');
  writeFileSync(
    join(app, 'app.json'),
    JSON.stringify({
      id: 'desk',
      name: 'Desk',
      connection: 'desk',
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
  writeFileSync(
    join(app, 'jobs.mjs'),
    `import { defineJob, defineJobs } from '@mistriwork/mistri/jobs';
import { closed } from './events.mjs';
export default defineJobs({
  archiveClosed: defineJob({ on: { event: closed, command: 'close' }, runAs: 'clock', command: 'archive', schedule: (event) => ({ key: { id: event.id } }) }),
}, { principals: { clock: { roles: ['clock'] } } });
`,
  );
  // The build beside the App, as a deployment makes it.
  const { out } = await buildApp(
    { app, out: join(directory, 'app-build'), commands: join(app, 'commands.ts'), jobs: join(app, 'jobs.mjs') },
    { typecheck: false },
  );
  const run = async (...args: string[]) => {
    const lines: string[] = [];
    const errors: string[] = [];
    const error = console.error;
    console.error = (line: string) => errors.push(line);
    try {
      const code = await runMigrate(
        ['stores', ...args, '--app', out, '--config', config],
        (line) => lines.push(line),
        undefined,
        MIGRATE_APPS,
      );
      return { code, text: [...lines, ...errors].join('\n') };
    } finally {
      console.error = error;
    }
  };
  const first = await run('up');
  assert.equal(first.code, 0, first.text);
  for (const store of [
    /desk: notification store v\d+ provisioned/,
    /desk: record history v\d+ provisioned/,
    /desk: command journal v\d+ provisioned/,
    /desk: event store for App "desk" v\d+ provisioned/,
    /desk: jobs: job store provisioned, 1 delivery destination\(s\), 1 added/,
  ])
    assert.match(first.text, store);
  const again = await run('up');
  assert.equal(again.code, 0, again.text);
  assert.doesNotMatch(again.text, /provisioned|[1-9] added/, again.text);
  assert.match(again.text, /desk: jobs: 1 delivery destination\(s\), 0 added/);

  const status = await run('status');
  assert.equal(status.code, 0, status.text);
  assert.match(status.text, /^Stores in desk \(sqlite, .*desk\.db\)$/m);
  assert.match(status.text, /^ {2}command-journal +v\d+/m);

  // Named, the build's own entry is the same one; another module is refused, as a start refuses it.
  const named = await run('up', '--jobs', join(out, 'server', 'jobs.mjs'));
  assert.equal(named.code, 0, named.text);
  assert.match(named.text, /desk: jobs: 1 delivery destination\(s\), 0 added/);
  const other = await run('up', '--jobs', join(app, 'jobs.mjs'));
  assert.equal(other.code, 1, other.text);
  assert.match(other.text, /is a build: --jobs must be its own/);
});
