/**
 * `mistri jobs run <name>` (OP9) and a job at times on a fresh store, through the real CLI, on SQLite and, when
 * TABLEWALK_TEST_PG names a server, on a PostgreSQL database this run owns. A fresh job store runs no missed slot on
 * its first start; an operator's run now is a manual run in the same store, run by the server's runner and journaled
 * beside the slots; an unknown name is refused with the names there are; and a store that holds a run catches up the
 * latest slot it missed after a stop. That the manual run never overlaps the schedule's is the store's rule, held on
 * both engines by job-store-contract.test.ts.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';
import { JOB_TABLES } from '../packages/mistri/src/adapters/jobs/jobStoreSchema.js';
import { ROOT, childEnv, runCli, serveCli } from './appApiCli.js';
import { LIVE_PG, ownedPostgresDatabase, pgControl } from './support/jobStoreEngines.js';

const src = (path: string) => JSON.stringify(pathToFileURL(join(ROOT, path)).href);
type Row = { key: string; state: string };

interface Engine {
  name: string;
  skip: string | false;
  /** The database's url, with an empty tick table. */
  database(directory: string): Promise<string>;
  /** The job store's rows of a job, and the ticks the command wrote. */
  read(url: string): Promise<{ rows: Row[]; ticks: number }>;
}

const engines: Engine[] = [
  {
    name: 'SQLite',
    skip: false,
    async database(directory) {
      const file = join(directory, 'desk.db');
      const db = new DatabaseSync(file);
      db.exec('CREATE TABLE tick (id INTEGER PRIMARY KEY, at TEXT NOT NULL)');
      db.close();
      return file;
    },
    async read(file) {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        db.exec('PRAGMA busy_timeout = 5000');
        const rows = db
          .prepare(`SELECT idempotency_key AS key, state FROM "${JOB_TABLES.job}" WHERE job = 'yearly' ORDER BY seq`)
          .all() as Row[];
        const ticks = Number((db.prepare('SELECT count(*) AS n FROM tick').get() as { n: number }).n);
        return { rows, ticks };
      } finally {
        db.close();
      }
    },
  },
  {
    name: 'PostgreSQL',
    skip: LIVE_PG ? false : 'TABLEWALK_TEST_PG names no PostgreSQL server',
    async database() {
      const url = await ownedPostgresDatabase();
      const control = await pgControl(url);
      try {
        await control.query('DROP TABLE IF EXISTS tick');
        await control.query('DROP SCHEMA IF EXISTS mistri CASCADE');
        await control.query(`DROP SCHEMA IF EXISTS public CASCADE`);
        await control.query('CREATE SCHEMA public');
        await control.query('CREATE TABLE tick (id serial PRIMARY KEY, at text NOT NULL)');
      } finally {
        await control.end();
      }
      return url;
    },
    async read(url) {
      const control = await pgControl(url);
      try {
        const rows = (
          await control.query(
            `SELECT idempotency_key AS key, state FROM ${runtimeTable('postgres', JOB_TABLES.job)} WHERE job = 'yearly' ORDER BY seq`,
          )
        ).rows as Row[];
        const ticks = Number(((await control.query('SELECT count(*)::int AS n FROM tick')).rows[0] as { n: number }).n);
        return { rows, ticks };
      } finally {
        await control.end();
      }
    },
  },
];

/** The App: one command that writes a tick, and two jobs at times whose latest slot is long past. */
async function desk(t: TestContext, engine: Engine) {
  const directory = mkdtempSync(join(tmpdir(), 'tw-jobs-run-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const url = await engine.database(directory);
  const app = join(directory, 'desk');
  mkdirSync(app);
  writeFileSync(
    join(app, 'app.json'),
    JSON.stringify({
      id: 'desk',
      name: 'Desk',
      sources: { desk: { connection: 'desk', default: true } },
      resources: { tick: { access: 'write' } },
      auth: { providers: ['email'], store: join(directory, 'auth.db'), roles: { automation: { read: true, commands: ['stamp'] } } },
      views: { ticks: { kind: 'list', from: 'tick' } },
      home: 'ticks',
    }),
  );
  const commands = join(app, 'commands.mjs');
  writeFileSync(
    commands,
    `import { defineCommand, defineCommands } from ${src('packages/mistri/src/server/commands.ts')};
export default defineCommands({ stamp: defineCommand({ source: 'desk', target: 'tick', targets: 'none',
  async handle({ db, now }) { await db.tick.insert({ at: now().toISOString() }); } }) });
`,
  );
  const jobs = join(app, 'jobs.mjs');
  writeFileSync(
    jobs,
    `import { defineJob, defineJobs } from ${src('packages/mistri/src/server/jobs.ts')};
export default defineJobs({
  yearly: defineJob({ every: '0 0 1 1 *', runAs: 'clock', command: 'stamp' }),
  quarterly: defineJob({ every: '0 0 1 1,4,7,10 *', runAs: 'clock', command: 'stamp' }),
}, { principals: { clock: { roles: ['automation'] } } });
`,
  );
  const config = join(directory, 'mistri.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'desk', url, writable: true }] }));
  const env = childEnv({ XDG_CONFIG_HOME: join(directory, 'config') });
  const up = await runCli(['migrate', 'stores', 'up', '--app', app, '--jobs', jobs, '--config', config], env);
  assert.equal(up.code, 0, up.out + up.err);
  const flags = ['--app', app, '--jobs', jobs, '--config', config];
  return { url, flags, env, read: () => engine.read(url) };
}

const settle = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await settle(250);
  }
}

for (const engine of engines)
  describe(`mistri jobs run on ${engine.name}`, { skip: engine.skip }, () => {
    test('an unknown name is refused with the names there are, and nothing is enqueued', { timeout: 120_000 }, async (t) => {
      const f = await desk(t, engine);
      const refused = await runCli(['jobs', 'run', 'nightly', ...f.flags], f.env);
      assert.equal(refused.code, 1, refused.out + refused.err);
      assert.match(refused.err, /"nightly" is not one of this App's jobs at times \("yearly", "quarterly"\)/);
      assert.deepEqual((await f.read()).rows, []);
    });

    test('a fresh store runs no missed slot, and a run now is a manual run the server runs', { timeout: 300_000 }, async (t) => {
      const f = await desk(t, engine);
      // A first start: the latest slot (1 January) is long past, and a store with no run of the job runs none of it.
      await serveCli(t, f.flags, { XDG_CONFIG_HOME: f.env.XDG_CONFIG_HOME! });
      await settle(4_000);
      assert.deepEqual(await f.read(), { rows: [], ticks: 0 }, 'no surprise run on a first start');

      // Run now: enqueued manual, run by the serving process's runner, waited for.
      const ran = await runCli(['jobs', 'run', 'yearly', ...f.flags, '--wait', '90'], f.env);
      assert.equal(ran.code, 0, ran.out + ran.err);
      assert.match(ran.out, /yearly: a manual run enqueued in desk's job store\.\nyearly: succeeded\./);
      const after = await f.read();
      assert.equal(after.ticks, 1);
      assert.equal(after.rows.length, 1);
      assert.match(after.rows[0].key, /^manual-\d{16}-/);
      assert.equal(after.rows[0].state, 'succeeded');
    });

    test('a store that holds a run of the job catches up its latest missed slot on start', { timeout: 300_000 }, async (t) => {
      const f = await desk(t, engine);
      // No server: the run waits in the store (exit 2), and the store now holds a run of the job.
      const queued = await runCli(['jobs', 'run', 'yearly', ...f.flags, '--wait', '1'], f.env);
      assert.equal(queued.code, 2, queued.out + queued.err);
      assert.match(queued.out, /still waiting after 1s/);
      await serveCli(t, f.flags, { XDG_CONFIG_HOME: f.env.XDG_CONFIG_HOME! });
      const read = await eventually(f.read, (value) => value.rows.filter((row) => row.state === 'succeeded').length === 2);
      const january = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1)).getTime();
      assert.deepEqual(
        read.rows.map((row) => row.key.replace(/^manual-.*/, 'manual')).sort(),
        [`every-${String(january).padStart(16, '0')}`, 'manual'].sort(),
        JSON.stringify(read),
      );
      assert.equal(read.ticks, 2);
    });
  });
