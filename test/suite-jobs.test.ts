/** Real scheduled workers keep App grants, stores and shutdown ownership. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { openSqliteJobStore } from '../packages/mistri/src/adapters/jobs/jobStore.js';
import { provisionStores } from '../packages/mistri/src/server/maintenance.js';
import { jobDeployment } from '../packages/mistri/src/server/jobs/jobLoader.js';
import { capturedJobModule } from '../packages/mistri/src/server/jobs/jobModule.js';
import { startConfiguredSuite } from '../packages/mistri/src/server/cli/suiteCommand.js';

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, 'worker did not reach the expected state');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test(
  'suite scheduled jobs reject foreign App provenance and drain cancelled handlers before closing stores',
  { timeout: 15_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-suite-jobs-'));
    let active: Awaited<ReturnType<typeof startConfiguredSuite>> | undefined;
    const stores: ReturnType<typeof openSqliteJobStore>[] = [];
    const releases: (() => void)[] = [];
    t.after(async () => {
      releases.forEach((release) => release());
      await active?.close();
      await Promise.all(stores.map((store) => store.close()));
      rmSync(directory, { recursive: true, force: true });
    });
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const definitions = [],
      fixtures = [];
    const environment: NodeJS.ProcessEnv = { SECRET: 'test-only-suite-jobs-secret-longer-than-thirty-two-characters' };
    for (const id of ['alpha', 'beta']) {
      const home = join(directory, id);
      mkdirSync(home);
      const database = join(home, 'business.db');
      const db = new DatabaseSync(database);
      db.exec('CREATE TABLE tick(id INTEGER PRIMARY KEY, owner TEXT NOT NULL)');
      db.close();
      migrateSqliteCommandJournal(database);
      writeFileSync(
        join(home, 'app.json'),
        JSON.stringify({
          id,
          name: id,
          sources: { data: { connection: 'data', default: true } },
          resources: { tick: { access: 'write' } },
          auth: { store: join(home, 'auth.db'), providers: ['email'], roles: { automation: { read: true, commands: ['stamp'] } } },
          views: { ticks: { kind: 'list', from: 'tick' } },
          home: 'ticks',
        }),
      );
      writeFileSync(
        join(home, 'commands.mjs'),
        `import {defineCommand,defineCommands} from ${JSON.stringify(new URL('../packages/mistri/src/server/commands.ts', import.meta.url).href)};
      export const control = {};
      export default defineCommands({stamp:defineCommand({source:'data',target:'tick',targets:'none',
        async handle({db,signal}) { if(control.wait) {control.signal=signal;control.entered=true;await control.wait;return;}
          await db.tick.insert({owner:${JSON.stringify(id)}}); }
      })});`,
      );
      writeFileSync(
        join(home, 'jobs.mjs'),
        `import {defineJob,defineJobs} from ${JSON.stringify(new URL('../packages/mistri/src/server/jobs.ts', import.meta.url).href)};
      export default defineJobs({minutely:defineJob({every:'* * * * *',runAs:'clock',command:'stamp'})},
        {principals:{clock:{roles:['automation']}},store:{namespace:${JSON.stringify(id)}}});`,
      );
      const commands = await import(pathToFileURL(join(home, 'commands.mjs')).href);
      const jobs = (await import(pathToFileURL(join(home, 'jobs.mjs')).href)).default;
      await provisionStores({ sqlite: database }, { app: { id: id, commands: commands.default }, jobs });
      const store = openSqliteJobStore(database, jobDeployment(capturedJobModule(jobs), { appId: id, commands: commands.default }).store);
      stores.push(store);
      const foreign = await store.enqueue(
        {
          job: 'minutely',
          version: 1,
          idempotencyKey: 'foreign-app-attempt-0001',
          input: { key: {}, input: {} },
          provenance: {
            appId: id === 'alpha' ? 'beta' : 'alpha',
            actorId: 'service:clock',
            correlationId: 'foreign',
            causationId: 'foreign',
          },
        },
        Date.now(),
      );
      fixtures.push({ id, database, store, foreign, control: commands.control });
      environment[id.toUpperCase()] = database;
      writeFileSync(
        join(home, 'connections.json'),
        JSON.stringify({ connections: [{ name: 'data', url: '${DATABASE_URL}', writable: true }] }),
      );
      definitions.push({
        id,
        directory: `./${id}`,
        config: `./${id}/connections.json`,
        jobs: `./${id}/jobs.mjs`,
        mount: id === 'alpha' ? '/' : '/beta',
        environment: { BETTER_AUTH_SECRET: 'SECRET', DATABASE_URL: id.toUpperCase() },
      });
    }
    const file = join(directory, 'suite.json');
    writeFileSync(file, JSON.stringify({ port, apps: definitions }));
    active = await startConfiguredSuite(file, environment);
    for (const fixture of fixtures) {
      await until(async () => (await fixture.store.inspect()).some((row) => row.state === 'succeeded'));
      await until(async () => (await fixture.store.attempts(fixture.foreign.id)).length > 0);
      assert.equal((await fixture.store.attempts(fixture.foreign.id))[0].code, 'not_authorized');
      const db = new DatabaseSync(fixture.database, { readOnly: true });
      try {
        assert.deepEqual(
          [
            ...new Set(
              db
                .prepare('SELECT owner FROM tick')
                .all()
                .map((row) => row.owner),
            ),
          ],
          [fixture.id],
        );
      } finally {
        db.close();
      }
    }
    const held = fixtures[0];
    held.control.wait = new Promise<void>((resolve) => releases.push(resolve));
    await held.store.enqueue(
      {
        job: 'minutely',
        version: 1,
        idempotencyKey: 'held-app-attempt-0001',
        input: { key: {}, input: {} },
        provenance: { appId: held.id, actorId: 'service:clock', correlationId: 'held', causationId: 'held' },
      },
      Date.now(),
    );
    await until(() => held.control.entered === true);
    let closed = false;
    const closing = active.close().then(() => {
      closed = true;
    });
    await until(() => held.control.signal.aborted);
    assert.equal(closed, false, 'shutdown must wait for accepted handlers');
    releases.forEach((release) => release());
    await closing;
  },
);
