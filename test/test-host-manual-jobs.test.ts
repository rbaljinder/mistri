/**
 * `startTestApp({ jobs: 'manual' })`, through the real CLI over SQLite: the App's jobs at times and its timers never
 * run on their own, so none fires in the middle of a test, and `host.runJob` runs one. Without it the schedule runs
 * as a deployment's does. A store that holds a run catches up the slot it missed at its next start, so the starts
 * below differ at once rather than at the next minute. (The tenant host's is tenant-jobs-under-test.test.ts.)
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createTestWorkspace, startTestApp } from '../packages/mistri/src/server/testing.js';
import { ROOT, childEnv, runCli } from './appApiCli.js';

const src = (path: string) => JSON.stringify(pathToFileURL(join(ROOT, path)).href);

test("jobs: 'manual' holds a job at times and a timer until runJob runs one", { timeout: 120_000 }, async (t) => {
  const workspace = await createTestWorkspace();
  t.after(() => workspace.close());
  const database = await workspace.database('desk.db', (db) =>
    db.exec(`CREATE TABLE tick (id INTEGER PRIMARY KEY, at TEXT NOT NULL);
      CREATE TABLE chore (id INTEGER PRIMARY KEY, due_at TIMESTAMP NOT NULL, state TEXT NOT NULL DEFAULT 'waiting');
      INSERT INTO chore (due_at) VALUES ('2020-01-01T00:00:00Z');`),
  );
  await workspace.write('app/app.json', {
    id: 'desk',
    name: 'Desk',
    sources: { desk: { connection: 'desk' } },
    resources: {
      tick: { access: 'write' },
      chore: { access: 'write', at: { due_at: { command: 'doChore', when: "state = 'waiting'" } } },
    },
    auth: {
      providers: ['email'],
      store: workspace.path('auth.db'),
      roles: { automation: { read: true, service: true, commands: ['stamp', 'doChore'] } },
    },
    views: { ticks: { kind: 'list', from: 'tick' } },
    home: 'ticks',
  });
  writeFileSync(
    workspace.path('app/commands.mjs'),
    `import { defineCommand, defineCommands } from ${src('packages/mistri/src/server/commands.ts')};
export default defineCommands({
  stamp: defineCommand({ source: 'desk', target: 'tick', targets: 'none', input: {},
    async handle({ db }) { await db.tick.insert({ at: new Date().toISOString() }); } }),
  doChore: defineCommand({ source: 'desk', target: 'chore', input: {},
    async handle({ db, record }) { await db.chore.update(record, { state: 'done' }); } }),
});
`,
  );
  const jobs = workspace.path('app/jobs.mjs');
  writeFileSync(
    jobs,
    `import { defineJob, defineJobs } from ${src('packages/mistri/src/server/jobs.ts')};
export default defineJobs({ minutely: defineJob({ every: '* * * * *', runAs: 'clock', command: 'stamp' }) },
  { principals: { clock: { roles: ['automation'] } } });
`,
  );
  const config = workspace.path('mistri.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'desk', url: database, writable: true }] }));
  const env = childEnv({ XDG_CONFIG_HOME: workspace.path('config') });
  const up = await runCli(['migrate', 'stores', 'up', '--app', workspace.path('app'), '--jobs', jobs, '--config', config], env);
  assert.equal(up.code, 0, up.out + up.err);
  const read = () => {
    const db = new DatabaseSync(database, { readOnly: true, timeout: 10_000 });
    try {
      return {
        ticks: Number(db.prepare('SELECT count(*) AS n FROM tick').get()!.n),
        chore: String(db.prepare('SELECT state FROM chore').get()!.state),
      };
    } finally {
      db.close();
    }
  };
  const serve = (manual: boolean) =>
    startTestApp({
      workspace,
      directory: workspace.path('app'),
      config,
      args: ['--commands', workspace.path('app/commands.mjs'), '--jobs', jobs],
      environment: { XDG_CONFIG_HOME: workspace.path('config') },
      ...(manual ? { jobs: 'manual' as const } : {}),
    });

  const held = await serve(true);
  // The timer's record was due long ago, and a timer sweeps when its host starts: held, it waits.
  await delay(2500);
  assert.deepEqual(read(), { ticks: 0, chore: 'waiting' }, held.logs());
  assert.equal((await held.runJob('minutely')).state, 'succeeded', held.logs());
  const swept = await held.runJob('at-chore-due_at');
  assert.deepEqual([swept.state, swept.ran], ['succeeded', 1], held.logs());
  assert.deepEqual(read(), { ticks: 1, chore: 'done' });
  // The store now holds a run, so a host would catch up the slot it missed at once: a held one does not.
  await held.close();
  const again = await serve(true);
  await delay(2500);
  await again.close();
  assert.equal(read().ticks, 1, 'nothing ran on its own while held');

  // The same start without it runs the missed slot: what the waits above would have seen.
  const serving = await serve(false);
  for (let waited = 0; read().ticks === 1 && waited < 15_000; waited += 250) await delay(250);
  await serving.close();
  assert.ok(read().ticks > 1, 'an unheld host runs its job at times');
});
