/**
 * A store upgrade as an operator meets it: a database holding the committed v1 fixture, `upgradeStores` (what
 * `mistri migrate stores up` calls) taking it to v2 — and a process killed in the middle of the step.
 *
 * Every store mistri ships is at layout version 1, so there is no v2 to run: the rehearsal gives record-history one
 * (test/support/storeUpgradeRehearsal.ts) and proves what the framework promises of any step, on a real database
 * and a real kill. SIGKILL ends the process with the step's transaction open, so the database must come back at v1
 * with the data as it was, and running the upgrade again must finish it, once.
 *
 * SQLite always; PostgreSQL when TABLEWALK_TEST_PG names a server where the role may create databases.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { liveSkip } from './live.js';
import { openMigrationDb, type MigrationDb } from '../packages/engine/src/server/migrate/database.js';
import { storeIsCurrent, storeStatuses } from '../packages/mistri/src/server/storeLayouts.js';
import { ENGINES, LIVE, applyFixture, fixtureFiles, scratch, type Engine } from './support/storeLayouts.js';
import { historyV2 } from './support/storeUpgradeRehearsal.js';

const CHILD = fileURLToPath(new URL('./support/storeUpgradeChild.ts', import.meta.url));
const ROWS = 3;

const run = (url: string, ...extra: string[]) => {
  const child = spawnSync(process.execPath, ['--import', 'tsx', CHILD, url, ...extra], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout.trim().split('\n').pop()!) as {
    applied: Array<{ id: string; from: number; to: number }>;
    failed: unknown[];
    refused: unknown[];
  };
};

async function withDb<T>(url: string, work: (db: MigrationDb) => Promise<T>): Promise<T> {
  const db = await openMigrationDb(url, [], false);
  try {
    return await work(db);
  } finally {
    await db.close();
  }
}

const names = (engine: Engine) =>
  engine === 'sqlite'
    ? { change: '"__mistri_history_change"', meta: '"__mistri_history_meta"' }
    : { change: 'mistri.history_change', meta: 'mistri.history_meta' };

async function seed(db: MigrationDb, engine: Engine): Promise<void> {
  const { change } = names(engine);
  for (const [index, via] of ['app', 'api', 'form'].entries())
    await db.run(
      `INSERT INTO ${change} (write_id, at, resource, key_json, kind, changes_json, actor, actor_name, via, action)
       VALUES (?, ?, 'ticket', ?, 'insert', '{}', 'a1', 'Ada', ?, 'create')`,
      [`w${index}`, '2026-01-01T00:00:00Z', `[${index}]`, via],
    );
}

/** The data table as the test reads it: how many rows, and whether `source` exists to read. */
async function reading(db: MigrationDb, engine: Engine) {
  const { change, meta } = names(engine);
  const hasSource =
    engine === 'sqlite'
      ? (await db.all<{ name: string }>(`PRAGMA table_info(${change})`)).some((column) => column.name === 'source')
      : (
          await db.all(
            `SELECT 1 FROM information_schema.columns WHERE table_schema = 'mistri' AND table_name = 'history_change' AND column_name = 'source'`,
          )
        ).length > 0;
  const rows = await db.all<{ write_id: string; via: string; source?: string }>(
    `SELECT write_id, via${hasSource ? ', source' : ''} FROM ${change} ORDER BY id`,
  );
  const versions = (await db.all<{ version: number }>(`SELECT version FROM ${meta}`)).map((row) => Number(row.version));
  return { hasSource, rows, versions };
}

for (const engine of ENGINES) {
  test(
    `${engine}: the committed v1 store upgrades to v2, a kill inside the step leaves v1 whole, and running again finishes it once`,
    { skip: engine === 'postgres' ? liveSkip('postgres', LIVE) : false },
    async () => {
      const where = await scratch(engine, 'rehearsal');
      const directory = mkdtempSync(join(tmpdir(), 'tablewalk-rehearsal-'));
      const pauseFile = join(directory, 'paused');
      try {
        const fixture = fixtureFiles('record-history', engine).find((file) => file.version === 1)!;
        await applyFixture(engine, where.url, readFileSync(fixture.path, 'utf8'));
        await withDb(where.url, (db) => seed(db, engine));
        const v2 = historyV2();

        await withDb(where.url, async (db) => {
          const [status] = await storeStatuses(db, [v2]);
          assert.equal(status.found, 1);
          assert.deepEqual(status.pending, [1], 'v1 is behind this build by one step');
        });

        // The step runs, changes the data, and is killed before it moves the marker.
        const child = spawn(process.execPath, ['--import', 'tsx', CHILD, where.url, pauseFile], { stdio: 'ignore' });
        const exited = new Promise<string | null>((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
        for (let waited = 0; !existsSync(pauseFile); waited += 50) {
          assert.ok(waited < 45_000, 'the step never reached its pause');
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        child.kill('SIGKILL');
        assert.equal(await exited, 'SIGKILL');

        await withDb(where.url, async (db) => {
          const after = await reading(db, engine);
          assert.deepEqual(after.versions, [1], 'the marker never moved');
          assert.equal(after.hasSource, false, 'the half-done step was rolled back');
          assert.deepEqual(
            after.rows.map((row) => row.write_id),
            ['w0', 'w1', 'w2'],
            'no row lost',
          );
          assert.equal((await storeStatuses(db, [v2]))[0].found, 1);
        });

        // Running it again completes the upgrade.
        const done = run(where.url);
        assert.deepEqual(done.failed, []);
        assert.deepEqual(
          done.applied.map((each) => [each.id, each.from, each.to]),
          [['record-history', 1, 2]],
        );
        await withDb(where.url, async (db) => {
          const after = await reading(db, engine);
          assert.deepEqual(after.versions, [2], 'the version is recorded once');
          assert.equal(after.hasSource, true);
          assert.equal(after.rows.length, ROWS);
          assert.deepEqual(
            after.rows.map((row) => [row.via, row.source]),
            [
              ['app', 'app'],
              ['api', 'api'],
              ['form', 'form'],
            ],
            'the backfill ran over every existing row',
          );
          assert.ok(storeIsCurrent((await storeStatuses(db, [v2]))[0]));
        });

        // And a third run has nothing left to do.
        assert.deepEqual(run(where.url).applied, []);
        await withDb(where.url, async (db) => assert.deepEqual((await reading(db, engine)).versions, [2]));
      } finally {
        rmSync(directory, { recursive: true, force: true });
        await where.drop();
      }
    },
  );
}
